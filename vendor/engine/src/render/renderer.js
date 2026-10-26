/**
 * Browser-bound renderer wrapper (FOUNDATION-PLAN.md §6, "renderer wrapper").
 *
 * This module is the only place the engine touches THREE.WebGLRenderer. It is
 * browser-bound: it imports from 'three' and needs a <canvas>, so it cannot
 * run under Node/vitest (Node has no DOM or WebGL) — that is expected.
 *
 * Responsibilities:
 *  - Own the WebGLRenderer, Scene, PerspectiveCamera, and lights.
 *  - Place the camera using the pure math in `camera.js`.
 *  - Turn ECS render components into THREE.InstancedMesh batches via
 *    `batching.js` groupBatches (skinned entities render individually).
 *
 * Pragmatic notes: meshes/materials are referenced by name through optional
 * `meshes`/`materials` resolver maps passed to the constructor. Unknown names
 * fall back to a shared box + standard material so a scene still renders
 * without a full asset pipeline wired up yet.
 */
import * as THREE from 'three'
import { groupBatches, resolveShadow } from './batching.js'
import { computeCameraPosition } from './camera.js'
import { resolveClip, DEFAULT_FADE, fadeOutComplete, clampAnimRange, crossedEvents, wrapInRange } from './animation.js'
import { resolveWorldTransforms } from '../scene/scene.js'
import { bootTelemetryOverlay } from '../telemetry/overlay.js'
import { frameProfiler } from '../telemetry/frame-profiler.js'
import { evaluateBlendSpace } from './blendTree.js'
import { createPostFX } from './postfx.js'
import { buildLights, normalizeShadowConfig, shadowMapType } from './lights.js'
import { createUiOverlay, renderUiElements, destroyUiOverlay } from './ui.js'
import { UI_WIDGET_TYPES, resolveAnchorRect } from './ui-schema.js'
import { buildWorldCanvasMesh } from './world-canvas.js'
import { createCloudMesh, syncCloudUniforms } from './volumetric-cloud.js'
import { cloudRegionParams } from '../scripts/volumetric-cloud.js'
import { buildTerrainMesh } from './terrain.js'
import { normalizeTerrain } from './terrain-math.js'
import { visualDelta } from './visual-clock.js'

/** Smallest InstancedMesh capacity we allocate (grows by doubling). */
const MIN_CAPACITY = 1024

export class Renderer {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas     the canvas to render into.
   * @param {Record<string, THREE.BufferGeometry>} [opts.meshes]  name -> geometry.
   * @param {Record<string, THREE.Material>} [opts.materials]    name -> material.
   * @param {Record<string, THREE.Object3D>} [opts.models]       entityId -> loaded model (Object3D with `.animations`).
   * @param {(d: { level: 'error'|'warn'|'info', message: string }) => void} [opts.onDiagnostic]
   *        called once per distinct resolution failure (e.g. a named material
   *        that isn't defined) so the host can surface it in the editor console.
   *        Defaults to console.error/console.warn. NEVER silent.
   */
  constructor({ canvas, meshes, materials, models, postPasses, onDiagnostic } = {}) {
    if (!canvas) throw new TypeError('Renderer requires a canvas')
    this.canvas = canvas
    this._meshes = meshes || {}
    this._materials = materials || {}
    // LATE-BIND SEAM: true once a material resolver is bound explicitly (ctor
    // `materials`, or setMaterials). While false, the first render(api) adopts
    // api.materials — a shipped game builds its Renderer BEFORE createGame
    // seeds the MaterialRegistry, so this is the zero-game-code path that gets
    // named materials to the renderer (editor viewport binds at construction
    // and is never auto-rewired).
    this._materialsBound = !!materials
    this._models = models || {}
    // MODEL-IMPORT: ONE shared decoded model per ASSET PATH (not per entity).
    // Node-scoped entities (`render.node`) resolve their subtree against the
    // registered asset model instead of each holding a decoded copy — the
    // "decode once, render many" contract. Never added to the scene itself.
    this._assetModels = new Map()
    // Per node-scoped entity id -> { proxy, source, model } (see _updateNodeScopes).
    this._nodeProxies = new Map()
    // pack scale, which transform.scale multiplies on top of (never replaces).
    this._modelBaseScale = new Map()
    // EDITOR TRANSFORM PREVIEW: per entity id -> { quat, pos } (quat is a
    // THREE.Quaternion in WORLD space, pos a THREE.Vector3 in world space or
    // null). While an entry exists, every per-frame sync path below applies
    // the preview transform DIRECTLY to the rendered Object3D / instance
    // matrix instead of recomposing from the serialized transform component —
    // the rotate gizmo's preview-on-object drag mode relies on this so the
    // engine's own sync cannot clobber the in-flight preview (the serialized
    // scene record is intentionally NOT written until mouse-up).
    this._transformPreviews = new Map()
    this._webglError = null
    this.webglAvailable = false
    this.onDiagnostic = typeof onDiagnostic === 'function' ? onDiagnostic : null
    this._missingMaterials = new Set()

    // Fallback handling: if WebGL is unavailable (headless, blocked, driver
    // error) we degrade gracefully — renderer is null and render() no-ops.
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
      this.webglAvailable = true
      this.renderer.setPixelRatio((typeof window !== 'undefined' && window.devicePixelRatio) || 1)
      // Enable soft shadows (cast by models/collectibles, received by the
      // ground/platforms) via the single directional light.
      this.renderer.shadowMap.enabled = true
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    } catch (err) {
      this.renderer = null
      this._webglError = err
    }

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.01, 1000)
    // R4 data-driven lights. `this._lights` holds the current THREE lights.
    this._lights = []
    this._lightSource = 'legacy' // 'entity' when a light component drives them
    this._lightSig = ''
    this._legacyLightConfig = null
    this._shadowConfig = null
    this._applyLights() // defaults (ambient + directional) until setLights/entities

    // Post-processing chain (R2): null unless a `render.post` scene block is
    // applied via setPostFX. When present, render() composites through it
    // (scene drawn in ONE pass, then post passes) instead of directly.
    // `postPasses` (custom full-screen post-FX scripts, R2-custom) lets a scene
    // pass reference a folder post-FX script by name as an extra pass type.
    this._postfx = null
    this._postPasses = postPasses || {}
    // Editor viewport background (solid Color or gradient CanvasTexture).
    this._backgroundTex = null
    if (this.webglAvailable) {
      this._postfx = createPostFX({ renderer: this.renderer, scene: this.scene, camera: this.camera, customPasses: this._postPasses })
    }

    // UI canvas rendering (WS3). EVERY canvas entity (screen AND world) renders
    // a textured world surface (world-canvas.js) registered as the entity's
    // model — the editor orbits/selects it like any scene object. The DOM
    // overlay (`renderUiElements`, ui.js) is the RUNTIME/Play path for screen
    // canvases only: drawn when NOT authoring. `_uiHost` is created lazily on
    // the canvas's parent; `_uiSig` caches the last-rendered widget set so we
    // only touch the DOM when it changes (and on resize).
    this._uiHost = null
    this._uiSig = ''
    // Authoring mode (editor) now means ONLY "don't draw the DOM overlay" —
    // the textured world surface renders for every canvas either way. Play/
    // built games leave this off and screen canvases get the real overlay.
    this._authoring = false

    // Terrain (WS6). Per-entity id -> the built terrain mesh (registered as the
    // entity's model so it renders + the mesh path exposes its triangles) and a
    // signature cache so we only rebuild when the heightfield data changes.
    this._terrainMeshes = new Map()
    this._terrainSig = new Map()

    // Volumetric clouds: per-entity id -> the mounted raymarched box
    // ({ mesh, uniforms, material, geometry, base }). The mesh is ENGINE-mounted
    // from the script params (the region stays a pure container) — see
    // _syncClouds. Disposed on detach / scene swap (ids gone from the new world).
    this._cloudMeshes = new Map()

    // World canvases (WS3-Pro). Per-entity id -> { mesh, redraw, sig }. The
    // plane is registered as the entity's model (so its transform positions it)
    // and the texture is re-painted in place when the widget set changes.
    this._worldCanvases = new Map()

    // Logical texture id -> THREE.Texture: a LIVE hook the world-canvas image
    // widget resolves its string `src` through (WS3-Pro). Hosts pass a
    // `textures` map (or a MaterialRegistry carrying `_textures`) in the ctor
    // options; api.materials.setTexture mutates that same map, so the resolver
    // sees registrations without any re-wiring.
    this._materialTextures = materials && materials._textures ? materials._textures : {}

    // name -> shared THREE geometry/material fallbacks.
    this._geometryCache = new Map()
    this._materialCache = new Map()
    this._defaultMaterial = null

    // InstancedMesh per batch key; individual Mesh per skinned entity.
    this._batches = new Map()
    this._skinned = new Map()

    // Shared model-instance batching: modelName -> InstancedMesh for repeated
    // NON-SKINNED decorative models (trees, rocks, buildings). This is the
    // ECS-aware materialization — instead of loading N full model clones for N
    // entities that share a model (which OOMs the editor at thousands of
    // trees), one InstancedMesh holds all their matrices against a single
    // geometry+materials set. `_modelBatchCapacities` tracks the allocated
    // InstancedMesh capacity per modelName so it can grow by doubling, mirroring
    // the box-batch pattern in _getBatch. Skinned/animated models are never
    // batched (they need a per-entity AnimationMixer) and render individually.
    this._modelBatches = new Map()
    this._modelBatchCapacities = new Map()

    // name -> the model object registered for a per-id entity (a single non-
    // instanced instance). Lets `modelMesh(name)`/`modelBounds(name)` resolve a
    // model by its logical name even when only one entity renders it (instanced
    // models are found via `_modelBatches.source`). Populated by the editor's
    // `_syncModels` via `setModelSource`.
    this._modelsByName = new Map()

    // modelName -> full LOCAL size {x,y,z} of the registered model (measured
    // from its geometry, including its own scales). The "Match render mesh"
    // collider shape and the editor wireframe use this so a model's collider
    // matches the REAL mesh — not transform.scale (which is an extra multiplier
    // on top of the model's authored size, e.g. a shelter at scale 1.6).
    this._modelBounds = new Map()
    // Model bounding-box CENTER (the offset of the mesh's center from its
    // origin) keyed by the same stripped model name. Grounded models have
    // their origin at the base, so their center sits ~half its height above
    // the origin — the selection outline must center on THIS, not the origin.
    this._modelCenters = new Map()

    // AnimationMixer per animated entity id -> { mixer, lastClip, action,
    // prevActions } where `prevActions` holds in-flight actions that are
    // fading OUT during a true crossfade (old clip ramping down).
    this._mixers = new Map()

    // Blend trees (BT2): entity id -> the BT1 blend-tree descriptor
    // ({ params, points, default, states? }) attached by the host right after
    // the character assembly registers the model. A tree entity plays ALL of
    // the tree's clips simultaneously with per-step normalized weights (see
    // `_updateTreeAnimation`); a missing entry means the single-clip path.
    this._blendTrees = new Map()

    // Current camera placement + optional focus entity id.
    this._preset = { name: 'top-down', args: {} }
    this._focusId = null

    this.resize()
  }

  /**
   * Register a loaded model (THREE.Object3D, optionally with `.animations`)
   * for an entity id so the renderer displays it for that entity instead of a
   * shared primitive. Used by the editor to add an object dropped from the
   * file browser into the live scene: `_collect` treats any id present in
   * `_models` as a model-rendered entity, and `_updateModelInstances` attaches
   * it next frame. Re-registering an id replaces the previous model.
   * @param {string} id  entity id
   * @param {THREE.Object3D} model
   */
  registerModel(id, model) {
    // A re-register fully REPLACES the previous model: detach any model
    // currently attached to the scene for this id so the replacement is added
    // fresh next frame. Without this, _updateModelInstances sees
    // `_sceneModels.has(id)` and keeps the OLD model attached while the new
    // `_models[id]` is never added to the scene — an inspector mesh swap
    // (render.modelName edit) would not change the viewport.
    if (this._sceneModels && this._sceneModels.has(id)) {
      this.scene.remove(this._sceneModels.get(id))
      this._sceneModels.delete(id)
    }
    this._models[id] = model
    // Capture the model's BASE scale at registration (its baked pack scale —
    // e.g. fish-hatchery's 6/1345 pack normalized in place by placeRigOnGround /
    // placeModelOnGround). `transform.scale` is a per-entity MULTIPLIER on top
    // of this, never a replacement — mirroring the instanced-model path
    // (baseScale × per-entity override). Some models carry their pack scale at
    // the top level (a rig placed by placeRigOnGround), others wrap it in an
    // inner node (placeModelOnGround's group). Capturing the registered model's
    // own top-level scale here means we never clobber either convention.
    this._modelBaseScale.set(id, { x: model.scale.x, y: model.scale.y, z: model.scale.z })
    // UNCONDITIONAL bounds capture: measure the model object at registration so
    // every registration path records a size/center (callers who know the
    // logical modelName may refine with setModelBounds(name, ...), but a
    // registerModel that skips it — the editor's legacy player path — no longer
    // leaves the model bounds-less). Keyed by the entity id: the per-id model
    // path resolves by id, and `modelBounds(modelName)` lookups for these
    // models fall back to the selection overlay's Box3 floor.
    this.setModelBounds(id, this.measureModelBounds(model), this.measureModelCenter(model))
    return this
  }

  /**
   * MODEL-IMPORT expected-pending: declare that `assetPath` is about to be
   * loaded and registered (editor boot / scene switch / autosave recovery).
   * While a path is pending, the `_updateNodeScopes` missing-model diagnostic
   * is SUPPRESSED for it — the editor knows the decode is in flight, so the
   * per-frame "no shared model registered" warn would be noise. The pending
   * entry is cleared when the path registers (`registerModelAsset`) or is
   * dropped (`unregisterModelAsset`). SEMANTICS: a pending entry that never
   * arrives (load failure — the editor always swallows these with `.catch`
   * and simply leaves the path unregistered) stays suppressed for that path
   * until it either registers or is unregistered; this is deliberate, so an
   * abandoned expectation never turns into an unbounded warn stream either.
   * @param {string} assetPath  the render.model value expected to register.
   */
  expectModelAsset(assetPath) {
    if (!assetPath) return this
    if (!this._expectedModelAssets) this._expectedModelAssets = new Set()
    this._expectedModelAssets.add(String(assetPath))
    return this
  }

  /**
   * Register the ONE shared decoded model for an asset path (MODEL-IMPORT).
   * Node-scoped entities (`render.model` = assetPath + `render.node`) resolve
   * their subtree against this model — the file is decoded once per asset and
   * never again per child. The model itself is not added to the scene here;
   * the root entity still renders the whole model through `registerModel`,
   * and node entities render lightweight subtree proxies (shared
   * geometry/material) positioned per entity.
   * @param {string} assetPath  the render.model value on node entities.
   * @param {THREE.Object3D} model  the decoded model root.
   */
  registerModelAsset(assetPath, model) {
    if (!assetPath || !model) return this
    this._assetModels.set(String(assetPath), model)
    // The path is no longer missing — clear its dedupe entry so if it is
    // unregistered/removed later, the first frame it is missing again
    // re-warns once (a fresh missing-epoch).
    if (this._missingAssetWarned) this._missingAssetWarned.delete(String(assetPath))
    // The expected decode landed — stop suppressing the missing-model
    // diagnostic for this path so a LATER genuine absence warns again.
    if (this._expectedModelAssets) this._expectedModelAssets.delete(String(assetPath))
    return this
  }

  /** Drop a previously-registered shared asset model (asset unloaded). */
  unregisterModelAsset(assetPath) {
    this._assetModels.delete(String(assetPath))
    // An unregistration also ends any pending expectation for the path —
    // its decode clearly will not arrive through the normal register path.
    if (this._expectedModelAssets) this._expectedModelAssets.delete(String(assetPath))
    return this
  }

  /** Drop a previously-registered model (entity no longer renders a model). */
  unregisterModel(id) {
    delete this._models[id]
    this._modelBaseScale.delete(id)
    // The blend tree rides with the assembled model — drop it too so the
    // entity never keeps a tree whose clips no longer exist.
    if (this._blendTrees) this._blendTrees.delete(id)
    return this
  }

  /**
   * Register (or clear) the BT1 blend-tree descriptor for an entity (BT2).
   * The assembled character carries the descriptor (buildAnimator's
   * `locomotion.tree`); hosts attach it right after `registerModel`. A
   * tree-driven entity plays ALL of the tree's clips simultaneously with
   * per-step normalized weights from `evaluateBlendSpace` over the entity's
   * `api.setAnimParam` state — see `_updateTreeAnimation`. Passing
   * null/undefined (or a descriptor without usable points) clears the tree
   * and the entity falls back to the single-clip playback path.
   *
   * `tree.states` (BT3) is the hard-select layer ABOVE the blend space: the
   * same `api.setAnimParam` values feed both, and when any state's param is
   * TRUTHY (boolean true, or a non-zero finite number — checked in list
   * order, first match wins) that state's clip is hard-selected at weight 1
   * (every other clip — the whole blend space included — drops to 0). A
   * falsy/absent param leaves the blend space in full control.
   *
   * @param {string} id  entity id
   * @param {object|null} tree  { params, points, default, states? } | null
   */
  setBlendTree(id, tree) {
    if (!tree || !Array.isArray(tree.points) || tree.points.length === 0) {
      this._blendTrees.delete(id)
    } else {
      this._blendTrees.set(id, tree)
    }
    // Swapping/clearing a tree must not leave stale actions playing on the
    // mixer (the clip set may have changed) — reset the whole entry surface
    // so the next step rebuilds cleanly on the new path.
    const entry = this._mixers.get(id)
    if (entry) {
      entry.mixer.stopAllAction()
      entry.action = null
      entry.lastClip = null
      entry.prevActions = []
      entry.syncedActions = new Map()
      entry.treeWeights = null
      entry.treeDominant = null
    }
    return this
  }

  /**
   * Register a shared, instanced model for repeated entities of one model
   * type. `modelName` is the logical model id (e.g. 'pine1'); `model` is ONE
   * loaded THREE.Object3D (the first instance). Every entity whose
   * `render.modelName` === `modelName` then renders through a single
   * InstancedMesh built from `model`'s geometry/materials — one allocation for
   * thousands of trees instead of N clones. Only NON-SKINNED models may be
   * instanced (skinned/animated rigs need a per-entity mixer and stay on the
   * per-id `_models` path). This is the engine's ECS-aware materialization for
   * the "one archetype spawned N times" case.
   * @param {string} modelName
   * @param {THREE.Object3D} model
   */
  registerInstancedModel(modelName, model) {
    if (!modelName || !model) return this
    const firstMesh = this._findFirstMesh(model)
    if (!firstMesh) return this
    // A skinned first mesh means this model is an animated rig — never instance it.
    if (firstMesh.isSkinnedMesh) return this
    // Lazily build InstancedMeshes on first use (we need a capacity); store
    // the source geometry/materials to clone into them. One base model -> one
    // or more InstancedMeshes SPLIT BY SHADOW FLAGS: per-instance cast/receive
    // is not expressible on a single InstancedMesh (three's flags are
    // per-Object3D), so entities that turned shadows off get their own batch —
    // the same break-out-by-flag pattern as the box batch (batching.js).
    if (!this._modelBatches.has(modelName)) {
      this._modelBatches.set(modelName, { source: model, baseScale: null, byShadow: new Map() })
    }
    // Record the model's real local size so "Match render mesh" colliders size
    // to the actual mesh (cached under the stripped base name).
    this.setModelBounds(modelName, this.measureModelBounds(model), this.measureModelCenter(model))
    return this
  }

  /** Full LOCAL size {x,y,z} of a loaded model, measured from its geometry and
   * including its own object scales (the rendered extent before the entity's
   * transform.scale is applied). Never throws — unusable geometry -> {1,1,1}. */
  measureModelBounds(model) {
    if (!model) return { x: 1, y: 1, z: 1 }
    try {
      const box = new THREE.Box3().setFromObject(model)
      const size = box.getSize(new THREE.Vector3())
      return { x: size.x || 1, y: size.y || 1, z: size.z || 1 }
    } catch (err) {
      return { x: 1, y: 1, z: 1 }
    }
  }

  /** The model's LOCAL bounding-box CENTER offset from its origin, in the same
   * units as measureModelBounds (before transform.scale). A grounded model
   * whose origin sits at its base returns ~{0, height/2, 0}. Never throws. */
  measureModelCenter(model) {
    if (!model) return { x: 0, y: 0, z: 0 }
    try {
      const box = new THREE.Box3().setFromObject(model)
      return box.getCenter(new THREE.Vector3())
    } catch (err) {
      return { x: 0, y: 0, z: 0 }
    }
  }

  /** Record a model's full LOCAL size (and center) by (stripped) name. */
  setModelBounds(modelName, size, center) {
    if (!modelName || !size) return this
    const key = String(modelName).replace(/^model\//, '')
    this._modelBounds.set(key, size)
    if (center) this._modelCenters.set(key, center)
    return this
  }

  /** Record the model OBJECT for a (stripped) name — used for single per-id
   * instances so `modelMesh`/`modelBounds` can resolve them by logical name. */
  setModelSource(modelName, model) {
    if (!modelName || !model) return this
    this._modelsByName.set(String(modelName).replace(/^model\//, ''), model)
    return this
  }

  /** The registered full LOCAL size of a model by name, or null if unknown. */
  modelBounds(modelName) {
    if (!modelName) return null
    return this._modelBounds.get(String(modelName).replace(/^model\//, '')) || null
  }

  /** The registered LOCAL bounding-box CENTER offset of a model by name (or
   * {0,0,0} when unknown / not a centered model). */
  modelCenter(modelName) {
    if (!modelName) return { x: 0, y: 0, z: 0 }
    return this._modelCenters.get(String(modelName).replace(/^model\//, '')) || { x: 0, y: 0, z: 0 }
  }

  /**
   * The model's LOCAL-frame triangle list by (stripped) name, or null. Each
   * triangle is `{ ax,ay,az, bx,by,bz, cx,cy,cz }` in the model's own frame
   * (which already includes importModel's baked pack scale, but NOT the entity's
   * `transform.scale` — the physics 'render' collider scales them itself). This
   * is what lets a model's collider carry the REAL mesh geometry instead of a
   * bounding shape. Cached on first call.
   */
  modelMesh(modelName) {
    if (!modelName) return null
    const base = String(modelName).replace(/^model\//, '')
    if (this._modelMeshes && this._modelMeshes.has(base)) return this._modelMeshes.get(base)
    const batch = this._modelBatches.get(base)
    const model = (batch && batch.source) || this._modelsByName.get(base)
    if (!model) return null
    const tris = extractModelTriangles(model)
    if (!this._modelMeshes) this._modelMeshes = new Map()
    this._modelMeshes.set(base, tris)
    return tris
  }

  /**
   * A render PRIMITIVE's unit triangles by mesh name (box/cylinder/sphere/
   * plane), extracted from the SAME shared geometry the renderer draws via
   * `_geometry()` — the 'match render mesh' one-math-source contract: the
   * collider's triangles ARE the render's triangles (physics applies the
   * per-axis transform scale itself, as it does for models). Returns null
   * for unknown names (the caller falls back). Cached per name.
   */
  primitiveMesh(name) {
    const key = name || 'box'
    if (!this._primitiveMeshes) this._primitiveMeshes = new Map()
    if (this._primitiveMeshes.has(key)) return this._primitiveMeshes.get(key)
    const g = this._geometry(key)
    if (!g) return null
    const tris = extractGeometryTriangles(g)
    this._primitiveMeshes.set(key, tris)
    return tris
  }

  /** Find the first renderable mesh in a loaded model (for instancing). */
  _findFirstMesh(root) {
    if (!root) return null
    let found = null
    root.traverse((o) => { if (!found && o.isMesh) found = o })
    return found
  }
  /**
   * Ensure the InstancedMesh for `base` + `shadowKey` exists and has capacity
   * for at least `need` instances. Built from the registered source model's
   * first mesh (geometry + materials cloned), with the shadow flags set from
   * the shadowKey. @returns {THREE.InstancedMesh|null}
   */
  _getModelBatchMesh(base, need, shadowKey) {
    const batch = this._modelBatches.get(base)
    if (!batch) return null
    let sub = batch.byShadow.get(shadowKey)
    if (!sub || !sub.mesh || sub.capacity < need) {
      const firstMesh = this._findFirstMesh(batch.source)
      if (!firstMesh) return null
      const capacity = Math.max(MIN_CAPACITY, nextPow2(need))
      const geometry = firstMesh.geometry
      const material = Array.isArray(firstMesh.material)
        ? firstMesh.material.map((m) => m.clone())
        : firstMesh.material.clone()
      const next = new THREE.InstancedMesh(geometry, material, capacity)
      next.castShadow = shadowKey[0] === '1'
      next.receiveShadow = shadowKey[1] === '1'
      // Never frustum-cull instanced batches. three.js caches the batch's
      // boundingSphere on the FIRST frustum test and never recomputes it, but
      // instance matrices are rewritten EVERY frame (entities move). Once the
      // cached sphere no longer matches where the instances actually are, the
      // frustum test lies — whole batches vanish when the camera zooms in
      // (tight frustum) even though instances are plainly in view. Proven with
      // a three r185 headless probe (2026-09-27): batch cached at x=200,
      // instances moved to origin in front of a zoomed-in camera -> culled.
      // One draw call per batch, so skipping the per-batch cull test is cheap.
      next.frustumCulled = false
      if (sub && sub.mesh) this.scene.remove(sub.mesh)
      this.scene.add(next)
      sub = { mesh: next, capacity, ids: new Set() }
      batch.byShadow.set(shadowKey, sub)
      // The source model's pack scale (importModel's uniform scale, e.g.
      // PACK_SCALE) is applied to the inner model, which placeModelOnGround
      // wraps in a Group whose own `.scale` is 1,1,1. So the effective base
      // scale is the first mesh's accumulated ancestor scale, not the source
      // root's. Compute it by walking from the mesh up to the source root and
      // multiplying each `.scale`. This bakes the normalized size into every
      // instance matrix so trees render at ~2.4 units, not the raw FBX size.
      // Computed once and cached on the base batch (independent of shadow key).
      if (!batch.baseScale) {
        let baseX = 1, baseY = 1, baseZ = 1
        for (let node = firstMesh; node && node !== batch.source.parent; node = node.parent) {
          if (node.scale) { baseX *= node.scale.x ?? 1; baseY *= node.scale.y ?? 1; baseZ *= node.scale.z ?? 1 }
        }
        batch.baseScale = { x: baseX, y: baseY, z: baseZ }
      }
    }
    return sub.mesh
  }

  _applyLights(configs, shadowConfig) {
    // Dispose + remove current lights, build the new set from scene data.
    for (const l of this._lights) {
      this.scene.remove(l)
      if (typeof l.dispose === 'function') l.dispose()
    }
    this._lights = []
    const { lights } = buildLights(configs)
    for (const light of lights) {
      this.scene.add(light)
      this._lights.push(light)
    }
    // Set the global shadow-map type (scene.render.shadows, default PCFSoft).
    if (this.renderer && this.renderer.shadowMap) {
      this.renderer.shadowMap.type = shadowMapType(normalizeShadowConfig(shadowConfig).type)
    }
    // Backward-compat handles: the pre-R4 defaults exposed `ambientLight` /
    // `directionalLight` so games could tune them; keep them for the default set.
    this.ambientLight = lights.find((l) => l.isAmbientLight) || null
    this.directionalLight = lights.find((l) => l.isDirectionalLight) || null
  }

  /**
   * Apply (or reset) the scene's data-driven lights from a `lights` array
   * (legacy standalone model). Pass `null`/undefined to fall back to the
   * defaults (ambient + directional). This is superseded by the `light`
   * COMPONENT on gameobjects — when entities carry a `light` component, the
   * renderer builds from those instead. The global shadow-map type comes from
   * `shadowConfig` (scene.render.shadows).
   * @param {Array<object>|null} [config]  the scene `lights` array.
   * @param {object} [shadowConfig]        the scene `render.shadows` block.
   */
  setLights(config, shadowConfig) {
    this._legacyLightConfig = config || null
    if (shadowConfig) this._shadowConfig = shadowConfig
    if (!this._hasEntityLights()) this._applyLights(this._legacyLightConfig, this._shadowConfig)
    return this
  }

  /**
   * Editor viewport background (the editor's OWN appearance preference — never
   * scene data, never serialized). `bottom` + `top` accept CSS color strings.
   * Equal colors → a flat THREE.Color background; different colors → a
   * vertical gradient (top color at the horizon, bottom at the ground) drawn
   * into a CanvasTexture mapped to `scene.background`. null/null resets to the
   * engine default (unset background = the WebGL clear color).
   * @param {string|null} bottom  CSS color for the lower half of the sky.
   * @param {string|null} top     CSS color for the upper half of the sky.
   */
  setBackground(bottom, top) {
    if (!this.scene) return
    if (!bottom && !top) {
      this.scene.background = null
      return
    }
    if (!top || top === bottom) {
      this._disposeBackgroundTexture()
      this.scene.background = new THREE.Color(bottom)
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 512
    const ctx = canvas.getContext('2d')
    const grad = ctx.createLinearGradient(0, 0, 0, 512)
    grad.addColorStop(0, top)
    grad.addColorStop(1, bottom)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 2, 512)
    this._disposeBackgroundTexture()
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    this._backgroundTex = tex
    this.scene.background = tex
  }

  /** Dispose the gradient background texture (if any). */
  _disposeBackgroundTexture() {
    if (this._backgroundTex) {
      this._backgroundTex.dispose()
      this._backgroundTex = null
    }
  }

  /** True if the last sync applied entity (`light` component) lights. */
  _hasEntityLights() {
    return this._lightSource === 'entity'
  }

  /**
   * Collect light configs from every entity carrying a `light` component,
   * positioned at the entity's WORLD transform. Returns [] when none.
   * @param {object} api  the game facade (query/entity).
   */
  _collectEntityLights(api) {
    const ids = typeof api.query === 'function' ? api.query({ has: 'light' }) : []
    if (!ids || ids.length === 0) return []
    const configs = []
    for (const id of ids) {
      const rec = api.entity(id)
      const l = rec && rec.components && rec.components.light
      if (!l) continue
      // Effective visibility (self + ancestors): a light on a hidden gameobject
      // is OFF in the viewport — same gate the render-mesh path uses.
      if (!this._isEffectivelyVisible(api, id)) continue
      // Position = the gameobject's world transform (resolved this frame).
      const w = this._worldTransforms && this._worldTransforms.get(id)
      const pos = w ? [w.x, w.y, w.z] : [0, 0, 0]
      const cfg = {
        type: l.type || 'point',
        color: l.color,
        intensity: l.intensity,
        position: pos,
        castShadow: l.castShadow === true,
      }
      if (l.type === 'point' || l.type === 'spot') { cfg.distance = l.distance; cfg.decay = l.decay }
      if (l.type === 'spot') {
        cfg.angle = l.angle; cfg.penumbra = l.penumbra
        if (Array.isArray(l.target) && l.target.length >= 3) cfg.target = l.target
      }
      if (l.type === 'directional' && Array.isArray(l.direction) && l.direction.length >= 3) {
        cfg.direction = l.direction
      }
      if (l.castShadow === true) cfg.shadow = { mapSize: l.shadowMapSize || 1024 }
      configs.push(cfg)
    }
    return configs
  }

  /**
   * Sync lights from the `light` COMPONENT entities (primary), falling back to
   * the legacy `scene.lights` array / defaults when no entity carries a light.
   * Rebuilds only when the light set changes (cheap signature), so per-frame
   * cost is negligible. Called each render.
   * @param {object} api  the game facade.
   */
  _syncLights(api) {
    const configs = this._collectEntityLights(api)
    if (configs.length > 0) {
      const sig = JSON.stringify(configs)
      if (this._lightSig !== sig) {
        this._lightSig = sig
        this._lightSource = 'entity'
        this._applyLights(configs, this._shadowConfig)
      }
      return
    }
    // No VISIBLE entity lights. If the scene still HAS light entities (they're
    // all hidden via render.visible), stay in entity mode with an empty light
    // set — falling back to the legacy defaults here would silently re-light
    // the scene when the user hides its only light.
    const hasLightEntities = typeof api.query === 'function' &&
      (api.query({ has: 'light' }) || []).length > 0
    if (hasLightEntities) {
      if (this._lightSource !== 'entity' || this._lightSig !== '') {
        this._lightSource = 'entity'
        this._lightSig = ''
        this._applyLights([], this._shadowConfig)
      }
      return
    }
    // No entity lights — fall back to the legacy scene.lights array or defaults.
    if (this._lightSource !== 'legacy') {
      this._lightSource = 'legacy'
      this._lightSig = ''
      this._applyLights(this._legacyLightConfig, this._shadowConfig)
    }
  }

  /**
   * Toggle UI AUTHORING mode (editor). Now means ONLY "don't draw the DOM
   * overlay for screen canvases" — every canvas renders its textured world
   * surface either way. Built games / Play leave it false (real overlay).
   */
   setAuthoringMode(v) {
     this._authoring = !!v
     // Force an overlay rebuild on the next render.
     this._uiSig = ''
     return this
   }

  getAuthoringMode() {
    return this._authoring
  }

  /**
   * Sync UI canvases from every entity carrying a `canvas` component (WS3-Pro).
   * In AUTHORING mode: every canvas (screen AND world) renders a world-space
   * PROXY (screen frame + widget boxes at the entity's world position) so it is
   * editable as a scene object; no literal DOM HUD overlay appears in the
   * editor. In PLAY mode: screen canvases render a DOM overlay; world canvases
   * render a textured plane. Widget layout is resolved recursively (canvas →
   * panels) into absolute px rects; the DOM overlay is reconciled only when the
   * widget set changes (or after a resize) — per-frame cost is a cheap
   * signature compare. No canvas entities -> the overlay/proxy is torn down.
   * Called each render.
   * @param {object} api  the game facade.
   */
  _syncUi(api) {
    const ids = typeof api.query === 'function' ? api.query({ has: 'canvas' }) : []
    // EVERY canvas renders a textured world surface (bottom-left anchored at
    // its entity transform) — the editor orbit/select model. Screen vs world
    // no longer changes HOW a canvas renders here; it only decides whether the
    // RUNTIME DOM overlay is ALSO drawn (screen canvases only, non-authoring).
    const seen = new Set()
    let screenWidgets = null
    for (const id of ids) {
      const rec = api.entity(id)
      const canvasComp = rec && rec.components && rec.components.canvas
      if (!canvasComp) continue
      seen.add(id)
      this._syncWorldCanvas(api, id, canvasComp)
      if (!this._authoring && (canvasComp.renderMode || 'screen') !== 'world') {
        // Runtime/Play: also draw the literal DOM overlay for screen canvases.
        if (!screenWidgets) screenWidgets = []
        const size = {
          width: this.canvas.clientWidth || this.canvas.width || 800,
          height: this.canvas.clientHeight || this.canvas.height || 600,
        }
        const tree = this._resolveUiTree(api, id, { rect: { left: 0, top: 0, width: size.width, height: size.height } })
        for (const w of tree) screenWidgets.push(w)
      }
    }
    // Drop surfaces whose entity lost the canvas component.
    for (const id of [...this._worldCanvases.keys()]) {
      if (seen.has(id)) continue
      const entry = this._worldCanvases.get(id)
      this._worldCanvases.delete(id)
      if (entry && entry.dispose) entry.dispose()
      if (this._models[id]) this.unregisterModel(id)
      if (this._sceneModels && this._sceneModels.has(id)) this.scene.remove(this._sceneModels.get(id))
    }
    // Runtime screen overlay reconcile (authoring never draws it).
    const sig = JSON.stringify((screenWidgets || []).map((w) => [w.id, w.type, w.rect, w.data]))
    if (sig !== this._uiSig) {
      this._uiSig = sig
      if (!screenWidgets || screenWidgets.length === 0) {
        if (this._uiHost) { destroyUiOverlay(this._uiHost); this._uiHost = null }
      } else {
        const host = this._ensureUiHost()
        if (host) renderUiElements(host, screenWidgets, api)
      }
    }
  }

  /**
   * Build or update a WORLD canvas entity's textured plane. Cached by a widget
   * signature; re-painted in place (no mesh re-creation) when the set changes.
   * Registered as the entity's model so its `transform` positions it.
   */
  _syncWorldCanvas(api, id, canvasComp) {
    const widgets = this._resolveUiTree(api, id, { rect: { left: 0, top: 0, width: 1, height: 1 } })
    const sig = JSON.stringify([widgets.map((w) => [w.type, w.rect, w.data]), canvasComp.resolution, canvasComp.width, canvasComp.height])
    const resolution = Array.isArray(canvasComp.resolution) ? canvasComp.resolution : [512, 512]
    const width = typeof canvasComp.width === 'number' && canvasComp.width > 0 ? canvasComp.width : 8
    const height = typeof canvasComp.height === 'number' && canvasComp.height > 0 ? canvasComp.height : 4.5
    let entry = this._worldCanvases.get(id)
    if (entry && entry.sig === sig) {
      // The model can be UNREGISTERED behind our back while hidden: _collect's
      // canvas branch skips invisible canvases, and _updateModelInstances's
      // cleanup loop then unregisters `_models[id]` + detaches the plane. The
      // signature cache would otherwise keep returning early here forever (the
      // "toggle back on does nothing" bug). Re-register whenever the model is
      // missing — repaint only, the mesh/texture are still cached.
      if (this._models[id] !== entry.mesh) {
        this._models[id] = entry.mesh
        this._modelsByName.set(id, entry.mesh)
        this._modelBaseScale.set(id, { x: 1, y: 1, z: 1 })
      }
      return
    }
    if (!entry) {
      // Register the plane as the entity's model so _collect renders it.
      // `resolveImage` lets the paint path draw a string manifest-id texture —
      // resolved live from `this._materialTextures` (the logical-id map hosts/
      // the editor register via api.materials.setTexture).
      const built = buildWorldCanvasMesh(widgets, resolution, width, height, {
        resolveImage: (srcId) => this._materialTextures[srcId] || null,
      })
      entry = { mesh: built.mesh, redraw: built.redraw, dispose: built.dispose, sig }
      this._worldCanvases.set(id, entry)
      this._models[id] = built.mesh
      this._modelsByName.set(id, built.mesh)
      this._modelBaseScale.set(id, { x: 1, y: 1, z: 1 })
    } else {
      entry.redraw(widgets)
      entry.sig = sig
    }
  }

  /**
   * Resolve a canvas entity's widget tree into a flat list of render descriptors
   * `{ id, type, rect:{left,top,width,height}, data }` with ABSOLUTE rects in the
   * parent's coordinate space (the viewport for a screen canvas; a 0..1 canvas
   * for world). Panels recurse: their children resolve against the panel's rect.
   * @param {object} api
   * @param {string} canvasId
   * @param {{rect:object}} root  the canvas's own root rect (size basis).
   * @returns {Array<object>}
   */
  _resolveUiTree(api, canvasId, root) {
    const out = []
    const visit = (parentId, parentRect) => {
      const children = typeof api.query === 'function' ? api.query({ parent: parentId }) : []
      for (const wid of children) {
        const wrec = api.entity(wid)
        if (!wrec || !wrec.components) continue
        // A hidden widget (render.visible === false) — or one under a hidden
        // ancestor INSIDE the canvas tree — is not painted (nor are its
        // children). The editor visibility toggle writes the same flag the
        // 3D-object path uses, so this makes per-widget hide/show work.
        const wr = wrec.components.render
        if (wr && wr.visible === false) continue
        const wtype = UI_WIDGET_TYPES.find((t) => wrec.components[t])
        if (!wtype) continue
        const rectComp = wrec.components.rect || {}
        const res = resolveAnchorRect(rectComp, parentRect.width, parentRect.height)
        const abs = {
          left: parentRect.left + res.left,
          top: parentRect.top + res.top,
          width: res.width,
          height: res.height,
        }
        const data = { ...(wrec.components[wtype] || {}) }
        out.push({ id: wid, type: wtype, rect: abs, data })
        // ANY widget type can parent child widgets: rects compose down the
        // chain (each child resolves against its parent's absolute rect), so
        // a text/bar/image/shape child paints + lays out like a panel's does.
        visit(wid, abs)
      }
    }
    visit(canvasId, root.rect)
    return out
  }

  /** Lazily create the UI overlay host on the canvas's parent element. */
  _ensureUiHost() {
    if (this._uiHost) return this._uiHost
    const parent = this.canvas.parentElement
    if (!parent) return null
    this._uiHost = createUiOverlay(parent)
    return this._uiHost
  }

  /**
   * Project a WORLD point to screen-space canvas pixels (for placing the
   * authoring HUD handles over the world proxy). Uses the render camera.
   * @param {number} x @param {number} y @param {number} z
   * @returns {{x:number, y:number}} px in canvas client coords.
   */
  worldToScreen(x, y, z) {
    if (!this.camera || !this.canvas) return { x: 0, y: 0 }
    this.camera.updateMatrixWorld()
    const v = new THREE.Vector3(x, y, z).project(this.camera)
    const w = this.canvas.clientWidth || this.canvas.width || 800
    const h = this.canvas.clientHeight || this.canvas.height || 600
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h }
  }

  /**
   * Raycast a screen pixel onto the horizontal plane at world height `z`
   * (the +X/+Y plane the authoring proxy screen sits on), returning the world
   * point (x, y, z) or null when the ray is parallel to the plane.
   * @param {number} clientX @param {number} clientY  px in canvas client coords.
   * @param {number} z  the plane's world height (default 0).
   * @returns {{x:number,y:number,z:number}|null}
   */
  screenPointToWorldPlane(clientX, clientY, z = 0) {
    if (!this.camera || !this.canvas) return null
    const rect = this.canvas.getBoundingClientRect()
    const w = rect.width || this.canvas.clientWidth || 800
    const h = rect.height || this.canvas.clientHeight || 600
    if (w === 0 || h === 0) return null
    const ndcX = ((clientX - rect.left) / w) * 2 - 1
    const ndcY = -(((clientY - rect.top) / h) * 2 - 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z)
    const hit = new THREE.Vector3()
    if (ray.ray.intersectPlane(plane, hit)) {
      return { x: hit.x, y: hit.y, z: hit.z }
    }
    return null
  }

  /**
   * Build + register a terrain mesh for every entity carrying a `terrain`
   * component, so it renders (via the model path) and its triangles are
   * available to the real-mesh collider. Cached by a normalized-data signature
   * (rebuilt only when the heightfield changes); unregistered when the entity's
   * terrain is removed. Must run BEFORE `_collect` so `hasModel` sees it.
   * @param {object} api  the game facade.
   */
  _syncTerrain(api) {
    const ids = typeof api.query === 'function' ? api.query({ has: 'terrain' }) : []
    const seen = new Set()
    for (const id of ids) {
      const rec = api.entity(id)
      const t = rec && rec.components && rec.components.terrain
      if (!t) continue
      const norm = normalizeTerrain(t)
      const sig = JSON.stringify(norm)
      seen.add(id)
      if (this._models[id] && this._terrainSig.get(id) === sig) continue // unchanged
      this._terrainSig.set(id, sig)
      // Replace any previously-attached model for this entity cleanly.
      if (this._sceneModels && this._sceneModels.has(id)) {
        this.scene.remove(this._sceneModels.get(id))
        this._sceneModels.delete(id)
      }
      const mesh = buildTerrainMesh(norm)
      mesh.name = `terrain:${id}`
      this._models[id] = mesh
      this._modelsByName.set(id, mesh)
      this._modelBaseScale.set(id, { x: 1, y: 1, z: 1 })
    }
    // Drop terrains whose entity no longer carries the component.
    for (const id of [...this._terrainSig.keys()]) {
      if (seen.has(id)) continue
      this._terrainSig.delete(id)
      if (this._models[id]) this.unregisterModel(id)
      if (this._modelsByName && this._modelsByName.has(id)) this._modelsByName.delete(id)
    }
  }

  /**
   * Mount + live-sync the raymarched cloud mesh for every entity carrying a
   * `volumetric-cloud` script (the flock-members-get-meshes precedent, but the
   * mesh is ENGINE-mounted from the script params — the region stays a pure
   * container, no render component). Per frame:
   *   - mount once per id (createCloudMesh; base dims recorded for scale re-fit)
   *   - reconcile LIVE params into the mounted uniforms (no re-mount — material
   *     identity is stable so the program never recompiles)
   *   - apply the fixed-step system's drift offsets from the
   *     `api.seams.volumetricCloud` seam into uDrift
   *   - position the mesh at the entity's resolved world transform
   *   - `renderer:'none'` (declared script param) mounts/drops NOTHING — a
   *     game may decline builtin rendering and drive its own renderer
   *   - ids no longer present (detach / scene swap) are removed + disposed
   * Must run AFTER _resolveWorld so the world transform exists. Fail loud.
   * @param {object} api  the game facade.
   */
  _syncClouds(api) {
    // Regions are authored in TWO load-bearing forms (see cloudRegionParams in
    // scripts/volumetric-cloud.js): the literal component and the `scripts`
    // list entry (the editor's authoring form — this is what makes the clouds
    // visible in the viewport + scrub).
    const ids = new Set([
      ...(typeof api.query === 'function' ? api.query({ has: 'volumetric-cloud' }) : []),
      ...(typeof api.query === 'function' ? api.query({ has: 'scripts' }) : []),
    ])
    const seen = new Set()
    const seam = (api.seams && api.seams.volumetricCloud) ||
      (typeof globalThis !== 'undefined' ? globalThis.__clouds : null)
    for (const id of ids) {
      const rec = api.entity(id)
      // Resolver throws fail-loud on a params-less carry; null = not a region.
      const p = rec ? cloudRegionParams(rec.components) : null
      if (!p) continue
      if (p.renderer === 'none') { this._disposeCloud(id); continue }
      seen.add(id)
      let entry = this._cloudMeshes.get(id)
      if (!entry) {
        // Fail loud, with the region id, on any invalid param (buildUniforms).
        try {
          entry = createCloudMesh(p)
        } catch (err) {
          throw new Error(`volumetric-cloud: mount failed for region '${id}' — ${String((err && err.message) || err)}`)
        }
        entry.base = { x: p.sizeX, y: p.sizeY, z: p.sizeZ }
        entry.mesh.name = `volumetric-cloud:${id}`
        this.scene.add(entry.mesh)
        this._cloudMeshes.set(id, entry)
      } else {
        syncCloudUniforms(entry, p)
      }
      // World transform (resolved this frame) positions the mesh; the region is
      // position-only, but honor a resolved rotation when present.
      const w = this._worldTransforms && this._worldTransforms.get(id)
      if (w) {
        entry.mesh.position.set(w.x || 0, w.y || 0, w.z || 0)
        if (w.quat) entry.mesh.quaternion.set(w.quat.x, w.quat.y, w.quat.z, w.quat.w)
      }
      // Fixed-step drift: the authoritative offsets from the system's seam.
      const region = seam && Array.isArray(seam.regions) ? seam.regions.find((r) => r.id === id) : null
      if (region && region.offsets) entry.uniforms.uDrift.value.set(region.offsets.ox || 0, region.offsets.oz || 0)
    }
    // Detach / scene swap: any mounted region whose entity is gone is disposed.
    for (const id of [...this._cloudMeshes.keys()]) {
      if (seen.has(id)) continue
      this._disposeCloud(id)
    }
  }

  /** Remove + dispose one mounted cloud mesh (idempotent). */
  _disposeCloud(id) {
    const entry = this._cloudMeshes.get(id)
    if (!entry) return
    this.scene.remove(entry.mesh)
    if (entry.geometry) entry.geometry.dispose()
    if (entry.material) entry.material.dispose()
    this._cloudMeshes.delete(id)
  }

  /** Sync the camera aspect + renderer size to the canvas. */
  resize() {
    const w = this.canvas.clientWidth || this.canvas.width || 800
    const h = this.canvas.clientHeight || this.canvas.height || 600
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    // updateStyle=false: the canvas is laid out by CSS (.hf-viewport canvas
    // { width:100%; height:100% }), so don't let setSize bake an inline px
    // style that would override it and freeze the canvas at its original
    // size when the window/container grows (viewport grew but stays black).
    if (this.renderer) this.renderer.setSize(w, h, false)
    if (this._postfx) this._postfx.resize()
    // A canvas size change alters the normalized-coordinate basis for UI
    // positions, so force the overlay to reconcile next render.
    this._uiSig = ''
  }

  /**
   * Choose which entity the camera frames (used by follow/orbit/first-person).
   * @param {string|null} id
   */
  setFocus(id) {
    this._focusId = id
    return this
  }

  /**
   * Set the camera preset and (optionally) its args. Pure math from
   * `camera.js` computes the actual position/target on the next render.
   * @param {string} name  one of CAMERA_PRESETS.
   * @param {object} [args]
   */
  setCameraPreset(name, args = {}) {
    this._preset = { name, args }
    return this
  }

  /**
   * Render one frame: rebuild ECS renderable batches, update transforms, place
   * the camera, and draw.
   * @param {object} api   the game's public facade (has query/entity).
   * @param {object} loop  the GameLoop; `loop.time` drives the visual clock
   *                       (mixers, shader time) so visuals track SIM time, not
   *                       the render-frame count (refresh-rate independent;
   *                       paused sim = frozen visuals; scrub = one step).
   */
  render(api, loop) {
    // LATE-BIND SEAM (materials): adopt the booted game's material resolver on
    // the first render when construction got none. Games run
    // `onFrame: (api, loop) => renderer.render(api, loop)` — the SAME seam the
    // telemetry bootstrap below uses — so a shipped game's MaterialRegistry
    // (api.materials) reaches the renderer with zero game-side code. Explicit
    // binding (ctor `materials`, setMaterials) always wins; see setMaterials.
    if (!this._materialsBound && api && api.materials) this.setMaterials(api.materials)
    if (!this.webglAvailable || !this.renderer) return
    // P1 frame-budget instrumentation (frame-profiler.js): every named phase
    // below is timed into a `render.<phase>` bucket. All begin/end calls are
    // no-ops while the profiler is disabled (the editor viewport) — one
    // boolean check per phase, no allocations.
    frameProfiler.begin('render.total')
    this._api = api
    // Test Scene telemetry (backlog N) — zero-game-code auto-boot: the first
    // render call is where a booted game exposes BOTH its api and its renderer,
    // so this is the seam that constructs the overlay when the launch URL asks
    // for it (?scene=&telemetry=1 — the shape editor/src/play.js sends).
    // Once per renderer; no-op (null) on every other launch (full Play builds,
    // the editor viewport, Options toggle OFF).
    if (!this._telemetryChecked) {
      this._telemetryChecked = true
      this._telemetry = bootTelemetryOverlay({ api, renderer: this })
    }
    // Visual delta for this frame = sim time advanced since the last render
    // (0 while paused; fixedDt after a scrub step; legacy 1/60 with no loop).
    const vc = visualDelta(loop ? loop.time : undefined, this._lastSimTime)
    this._lastDt = vc.dt
    this._lastSimTime = vc.lastSimTime
    // Resolve world positions once per frame (local transform + parent chain),
    // then build/update all mesh instances from those world positions.
    frameProfiler.begin('render.syncTerrain')
    this._syncTerrain(api) // register terrain meshes BEFORE _collect so hasModel sees them
    frameProfiler.end('render.syncTerrain')
    frameProfiler.begin('render.resolveWorld')
    this._worldTransforms = this._resolveWorld(api)
    frameProfiler.end('render.resolveWorld')
    frameProfiler.begin('render.syncClouds')
    this._syncClouds(api) // mount + live-sync raymarched cloud regions (needs _worldTransforms)
    frameProfiler.end('render.syncClouds')
    // 'match render mesh' auto-wiring: hand physics the SAME triangles this
    // renderer draws — models via modelMesh(), primitives via primitiveMesh()
    // (the shared `_geometry` cache). Every host (editor + built games) gets
    // the one-math-source contract with zero host-side wiring. Idempotent:
    // the resolvers are this-renderer closures; assigning per frame is cheap.
    if (api && api.physics) {
      if (typeof api.physics.setModelMesh === 'function') api.physics.setModelMesh((name) => this.modelMesh(name))
      if (typeof api.physics.setPrimitiveMesh === 'function') api.physics.setPrimitiveMesh((name) => this.primitiveMesh(name))
    }
    // Gameplay-script model measurement (flock derives fish colliders from
    // the SAME registry — one math source, no tool-baked measured numbers).
    if (api && typeof api.setModelBoundsResolver === 'function') {
      api.setModelBoundsResolver((name) => this.modelBounds(name))
    }
    frameProfiler.begin('render.collect')
    const items = this._collect(api)
    frameProfiler.end('render.collect')
    frameProfiler.begin('render.syncLights')
    this._syncLights(api)
    frameProfiler.end('render.syncLights')
    frameProfiler.begin('render.updateModelInstances')
    this._updateModelInstances(items)
    frameProfiler.end('render.updateModelInstances')
    frameProfiler.begin('render.updateNodeScopes')
    this._updateNodeScopes(items)
    frameProfiler.end('render.updateNodeScopes')
    frameProfiler.begin('render.updateModelBatches')
    this._updateModelBatches(items)
    frameProfiler.end('render.updateModelBatches')
    frameProfiler.begin('render.updateBatches')
    this._updateBatches(items)
    frameProfiler.end('render.updateBatches')
    frameProfiler.begin('render.updateSkinned')
    this._updateSkinned(items)
    frameProfiler.end('render.updateSkinned')
    frameProfiler.begin('render.updateAnimations')
    this._updateAnimations(api, loop)
    frameProfiler.end('render.updateAnimations')
    frameProfiler.begin('render.applyCamera')
    this._applyCamera(api)
    frameProfiler.end('render.applyCamera')
    frameProfiler.begin('render.resize')
    this.resize()
    frameProfiler.end('render.resize')
    frameProfiler.begin('render.shaderTime')
    this._updateShaderTime()
    frameProfiler.end('render.shaderTime')
    frameProfiler.begin('render.syncUi')
    this._syncUi(api)
    frameProfiler.end('render.syncUi')
    // R2 post-processing: when a `render.post` chain is enabled, the scene is
    // drawn in ONE pass (batched exactly as the direct path) then composited
    // through the post passes. Batching is untouched — the draw-call count for
    // the scene itself is unchanged; only the composite happens after.
    frameProfiler.begin('render.draw')
    if (this._postfx && this._postfx.enabled) this._postfx.render()
    else if (this.renderer) this.renderer.render(this.scene, this.camera)
    frameProfiler.end('render.draw')
    frameProfiler.end('render.total')
  }

  /**
   * Advance a renderer clock and push it into any ShaderMaterial that declares a
   * `time` uniform, so ANIMATED custom shaders (waves, hologram, pulse …) run in
   * both the editor and shipped games. Cheap: only iterates materials that
   * declare `time` (tracked in `_timeMaterials`).
   */
  _updateShaderTime() {
    // _lastDt is the SIM-time delta for this frame (0 while paused — a 0 must
    // NOT fall back to 1/60, that would animate shaders through a pause).
    this._time = (this._time || 0) + (typeof this._lastDt === 'number' ? this._lastDt : 1 / 60)
    if (!this._timeMaterials || this._timeMaterials.size === 0) return
    for (const mat of this._timeMaterials) {
      if (mat && mat.uniforms && mat.uniforms.time) mat.uniforms.time.value = this._time
    }
  }

  /** Register a ShaderMaterial that wants per-frame `time`. */
  _trackTimeMaterial(mat) {
    if (!this._timeMaterials) this._timeMaterials = new Set()
    if (mat && mat.uniforms && mat.uniforms.time) this._timeMaterials.add(mat)
  }

  /**
   * Apply (or clear) the post-FX chain from a `render.post` scene block. Pass
   * `null`/`{enabled:false}` to disable. Rebuilding swaps the composer; the
   * next render() composites through it. Data-driven, authored as scene JSON.
   * @param {object|null} [config]  the `render.post` block.
   */
  setPostFX(config) {
    if (this._postfx) this._postfx.setChain(config || { enabled: false })
    return this
  }

  /**
   * Bind (or re-bind) the material resolver — the LATE-BIND SEAM. Accepts the
   * same shapes the constructor's `materials` option does: a MaterialRegistry,
   * its live `materials` Map, the `api.materials` facade, or a plain
   * `{ name: THREE.Material }` map. Explicit binding always wins over the
   * render()-time auto-wire (the editor viewport binds at construction; a
   * shipped game's registry is adopted automatically on first render).
   * Rebinding drops any materialParams override clones cached against the
   * previous resolver (they cloned the wrong base) and re-arms the
   * missing-material diagnostics so a name that failed before the bind
   * re-evaluates. NEVER silent: a still-missing name reports on next use.
   * @param {MaterialRegistry|Map|object} materials
   */
  setMaterials(materials) {
    this._materials = materials || {}
    this._materialsBound = !!materials
    // Texture hook parity with the ctor: a MaterialRegistry carries its live
    // `_textures` map (api.materials.setTexture mutates the same object).
    const tex = materials && typeof materials.get === 'function'
      ? (materials._textures || materials.textures)
      : null
    if (tex && typeof tex === 'object') this._materialTextures = tex
    if (this._materialOverrideCache) this._materialOverrideCache.clear()
    this._missingMaterials.clear()
    return this
  }

  /**
   * Compute every entity's world position for this frame from the ECS. Uses the
   * pure resolveWorldTransforms over scene-shaped records built from the live
   * api (id, parent, components), so parented entities land at parent.world +
   * local regardless of render/transform components.
   */
  _resolveWorld(api) {
    const records = []
    for (const id of api.query({})) {
      const rec = api.entity(id)
      if (!rec) continue
      records.push({ id, parent: api.getParent ? api.getParent(id) : undefined, components: rec.components })
    }
    const world = resolveWorldTransforms(records)
    // TRANSFORM PREVIEW PROPAGATION: while a gizmo preview is active for an
    // entity, its DESCENDANTS must compose against the previewed world
    // quat/pos too — otherwise children keep walking the parent chain from
    // the (deliberately stale) serialized eulers and lag/mix mid-drag. Build
    // an override per previewed entity and re-resolve once; the overrides are
    // applied inside resolveWorldTransforms' existing O(depth) chain walk.
    if (this._transformPreviews && this._transformPreviews.size) {
      const overrides = new Map()
      for (const [id] of this._transformPreviews) {
        const pv = this._previewFor(id)
        if (!pv) continue
        const w = world.get(id)
        const p = pv.pos || (w ? { x: w.x, y: w.y, z: w.z } : { x: 0, y: 0, z: 0 })
        overrides.set(id, { x: p.x, y: p.y, z: p.z, quat: { x: pv.quat.x, y: pv.quat.y, z: pv.quat.z, w: pv.quat.w } })
      }
      if (overrides.size) return resolveWorldTransforms(records, overrides)
    }
    return world
  }

  /**
   * AnimationMixer lifecycle (minimal animation system, B9.5 — no state
   * machines). For every entity that has a `playback` component and a loaded
   * model (a THREE.Object3D with `.animations`), create/reuse an
   * AnimationMixer, advance it by the loop's fixed dt, and play/stop the clip
   * named by `playback.clip` by resolving it against the model's clips.
   *
   * An explicit clip change performs a TRUE crossfade: the previous action
   * fades OUT (`fadeOut(fade)`, old clip ramps down) while the new one fades
   * IN (`reset().fadeIn(fade).play()`, new clip ramps up), both driven by the
   * mixer so poses interpolate between the two clips. Fading-out actions are
   * tracked in `entry.prevActions` and stopped once their weight reaches ~0.
   * `fade === 0` is a hard cut (old action stopped instantly).
   *
   * Missing clip names warn and no-op (never throw). Mixers are disposed when
   * their entity no longer qualifies (gone / playback removed) so hot reload does
   * not leak them. Pure three — no WebGL context needed — but it lives on the
   * browser-bound renderer since it consumes loaded models.
   * @param {object} api   the game's public facade.
   * @param {object} loop  the GameLoop (unused directly — the SIM-time visual
   *                       delta is computed once in render() as `_lastDt`).
   */
  _updateAnimations(api, loop) {
    // Advance mixers by the SIM-time delta computed in render() — refresh-rate
    // independent, frozen while paused, exactly one fixedDt per scrub step.
    const dt = typeof this._lastDt === 'number' ? this._lastDt : 1 / 60
    const seen = new Set()
    const ids = api.query({ has: 'playback' })
    for (const id of ids) {
      const record = api.entity(id)
      const playback = record && record.components && record.components.playback
      const model = this._models && this._models[id]
      if (!playback || !model || !Array.isArray(model.animations) || model.animations.length === 0) continue
      seen.add(id)

      const clipName = typeof playback.clip === 'string' ? playback.clip : null
      const playing = playback.playing !== false
      const loop = playback.loop !== undefined ? Boolean(playback.loop) : true
      const playbackRate = playback.playbackRate !== undefined ? Number(playback.playbackRate) : 1
      const fade = playback.fade !== undefined ? Number(playback.fade) : DEFAULT_FADE

      // Resolve the clip by name against what the model actually has.
      const available = model.animations.map((a) => (a && a.name) || '').filter(Boolean)
      const resolved = clipName ? resolveClip(clipName, available) : null

      let entry = this._mixers.get(id)
      if (!entry) {
        entry = { mixer: new THREE.AnimationMixer(model), lastClip: null, action: null, prevActions: [] }
        this._mixers.set(id, entry)
      }

      // BT2 tree path: an entity with a registered blend tree does NOT use
      // the single-clip scheduler below — all of the tree's clips play
      // simultaneously with per-step normalized weights (see
      // `_updateTreeAnimation`). Single-clip trim/events/crossfades are
      // single-clip authoring surfaces and intentionally do not run here.
      if (this._blendTrees && this._blendTrees.has(id)) {
        this._updateTreeAnimation(api, id, entry, playback, dt, model)
        continue
      }

      // Stopped: stop the current action plus any in-flight crossfade actions
      // and clear them, so nothing keeps playing.
      if (!playing) {
        if (entry.action && entry.action.isRunning()) entry.action.stop()
        entry.action = null
        for (const a of entry.prevActions) if (a.isRunning()) a.stop()
        entry.prevActions = []
        entry.lastClip = null
        entry.mixer.update(dt)
        continue
      }

      // Missing/unknown clip requested: warn + no-op (never throw), and never
      // disturb the action that may already be running. Still advance the
      // mixer so an in-progress crossfade can finish.
      if (clipName && !resolved) {
        console.warn(`[render] playback: clip "${clipName}" not found on model for entity "${id}" — no-op`)
        entry.mixer.update(dt)
        continue
      }

      // No clip requested (nothing resolvable): nothing to schedule; just keep
      // stepping the mixer so any in-flight crossfade completes.
      if (!resolved) {
        entry.mixer.update(dt)
        continue
      }

      // Start (or restart) the action when the clip changed or it isn't
      // running. A real clip change is a TRUE crossfade: the previous action
      // fades OUT (old clip ramps down) while the new one fades IN (new clip
      // ramps up), both kept on the mixer so poses interpolate between them.
      // We use `nextAction.crossFadeFrom(oldAction, fade)` — three's built-in
      // crossfade — because manually calling fadeIn/fadeOut on both actions
      // fights over the mixer's shared control-interpolant pool and the fade
      // never progresses.
      if (entry.lastClip !== resolved || !entry.action || !entry.action.isRunning()) {
        const clip = THREE.AnimationClip.findByName(model.animations, resolved)
        if (clip) {
          const oldAction = entry.action
          const nextAction = entry.mixer.clipAction(clip)
          nextAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
          nextAction.timeScale = playbackRate
          nextAction.reset()
          // Trim (AN1): an authored start restarts the action INSIDE the
          // sub-range instead of at the clip's head. Validated against the
          // clip duration (invalid -> full range, zero migration).
          const range = clampAnimRange(playback, clip.duration)
          nextAction.time = range.start
          if (oldAction && oldAction.isRunning()) {
            if (fade > 0) {
              // True crossfade: next ramps in while old ramps out, both live on
              // the mixer so their poses interpolate. old stays in-flight and
              // is pruned below once its effective weight reaches ~0.
              nextAction.crossFadeFrom(oldAction, fade)
              entry.prevActions.push(oldAction)
            } else {
              // Hard cut (fade === 0): stop the old clip instantly.
              oldAction.stop()
            }
          }
          nextAction.play()
          entry.action = nextAction
          entry.lastClip = resolved
        }
      }

      // Prune fading-out actions whose crossfade completed (effective weight
      // reached ~0): stop them so they don't linger on the mixer, and drop
      // them from the in-flight list. `_effectiveWeight` is the real blend
      // weight three's mixer uses (the public `.weight` stays at its fade-in
      // value, so we must not check it).
      if (entry.prevActions.length > 0) {
        entry.prevActions = entry.prevActions.filter((a) => {
          if (!fadeOutComplete(a._effectiveWeight)) return true
          if (a.isRunning()) a.stop()
          return false
        })
      }

      // Animation events (AN1): compute the validated trim range from the
      // CURRENT playback each frame (an editor edit re-points it live), then
      // advance the mixer and test crossings across the advance.
      const actionClip = entry.action && typeof entry.action.getClip === 'function' ? entry.action.getClip() : null
      const range = clampAnimRange(playback, actionClip ? actionClip.duration : 0)
      const prevTime = entry.action ? entry.action.time : 0
      entry.mixer.update(dt)

      // Trim enforcement (AN1): keep the playhead inside [range.start,
      // range.end). LoopRepeat: wrap back to the sub-range start (the clip's
      // own loop wrap is bypassed because three never reaches `end < duration`
      // naturally — we clamp BEFORE the mixer's wrap logic can overshoot).
      // LoopOnce: clamp at the range end so a one-shot completes at the trim.
      if (entry.action && range.end > range.start) {
        const action = entry.action
        if (loop) {
          if (action.time >= range.end || action.time < range.start) {
            // wrapInRange (not bare %): three's own full-clip wrap can fire
            // within one step (lag spike / rate×dt) and land BELOW start —
            // JS % keeps the sign, so the naive formula froze the playhead
            // outside the trim forever. The normalized wrap fixes every input.
            action.time = wrapInRange(action.time, range)
          }
        } else if (action.time >= range.end) {
          action.time = range.end
        }
      }

      // Crossings: forward progress prev -> now through the validated range;
      // `crossedEvents` returns [] when time didn't advance (paused/scrub).
      // One emit drives BOTH consumers: api.onAnimEvent handlers and the
      // `anim-events` built-in script's per-entity pending queue.
      if (entry.action && typeof api.animEvents?.emit === 'function') {
        const nowTime = entry.action.time
        if (nowTime !== prevTime) {
          const crossings = crossedEvents(playback.events, prevTime, nowTime, range, loop)
          if (crossings.length > 0) api.animEvents.emit(id, crossings)
        }
      }
    }

    // Dispose mixers whose entities no longer qualify (entity gone / playback
    // removed) — stop everything (current + any in-flight crossfade actions)
    // and release so hot reload never leaks. Their pending animation-event
    // crossings die with them (a removed entity never fires again).
    for (const [id, entry] of this._mixers) {
      if (!seen.has(id)) {
        if (entry.action) entry.action.stop()
        for (const a of entry.prevActions) if (a.isRunning()) a.stop()
        entry.prevActions = []
        if (entry.syncedActions) {
          for (const a of entry.syncedActions.values()) if (a.isRunning()) a.stop()
          entry.syncedActions = new Map()
        }
        entry.mixer.stopAllAction()
        this._mixers.delete(id)
        // The tree + the entity's runtime anim params die with the entry (a
        // removed entity never blends again; a re-attached tree re-registers).
        this._blendTrees.delete(id)
        if (typeof api.animEvents?.clear === 'function') api.animEvents.clear(id)
        if (api.animParams && typeof api.animParams.clear === 'function') api.animParams.clear(id)
      }
    }
  }

  /**
   * Read the entity's blend-tree param values from the runtime param state
   * (api.setAnimParam) and shape them for `evaluateBlendSpace`: a scalar for
   * a 1-param space, [x, y] for a 2-param space. Any missing/non-finite param
   * returns null — the caller falls back to the tree's default clip (BT2:
   * params are per-frame gameplay state, absent until a script sets them).
   * @returns {number|[number,number]|null}
   */
  _treeValues(params, tree) {
    if (!Array.isArray(tree.params) || tree.params.length === 0) return null
    const read = (name) => (params && typeof params.get === 'function' ? params.get(name) : undefined)
    if (tree.params.length === 1) {
      const v = read(tree.params[0])
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    }
    const values = []
    for (const name of tree.params.slice(0, 2)) {
      const v = read(name)
      if (typeof v !== 'number' || Number.isFinite(v) === false) return null
      values.push(v)
    }
    return values
  }

  /**
   * BT3 states override — read the entity's param state against the tree's
   * `states` hard-select list. A state MATCHES when its param value is
   * TRUTHY: boolean true, or a non-zero finite number (games feed flags as
   * 1/0 since api.setAnimParam stores numbers). Checked in list order —
   * first match wins. Absent/null/NaN/0/false all count as falsy.
   * @returns {string|null} the matching state's clip, or null (no override —
   *   the blend space decides).
   */
  _treeStateOverride(tree, params) {
    if (!Array.isArray(tree.states) || tree.states.length === 0) return null
    const read = (name) => (params && typeof params.get === 'function' ? params.get(name) : undefined)
    for (const st of tree.states) {
      if (!st || typeof st.name !== 'string' || !st.name) continue
      if (typeof st.clip !== 'string' || !st.clip) continue
      const v = read(st.name)
      if (v === true || (typeof v === 'number' && Number.isFinite(v) && v !== 0)) return st.clip
    }
    return null
  }

  /**
   * Evaluate the entity's blend tree against its current params (BT2).
   * Weights come from the BT1 pure evaluator `evaluateBlendSpace` (single
   * import — no local copy), then are normalized to sum exactly 1 per step.
   * A null evaluation (missing/NaN params, unusable points) or a zero-sum
   * guard falls back to the tree's `default` clip at weight 1 (first
   * point's clip when no default is authored). The DOMINANT clip (highest
   * weight; deterministic clip-name tiebreak) owns the shared clock.
   *
   * BT3: the `states` layer runs FIRST — a truthy state param hard-selects
   * that state's clip at weight 1 (all other clips 0, blend space ignored
   * for this step). See `_treeStateOverride`.
   *
   * @returns {{ weights: Map<string, number>, dominant: string|null }}
   */
  _treeWeights(id, tree, api) {
    const params = api && api.animParams && typeof api.animParams.get === 'function'
      ? api.animParams.get(id)
      : null
    // States override (BT3): a hard-select layer ABOVE the blend space.
    const overrideClip = this._treeStateOverride(tree, params)
    if (overrideClip) {
      return { weights: new Map([[overrideClip, 1]]), dominant: overrideClip }
    }
    const values = this._treeValues(params, tree)
    let result = evaluateBlendSpace(tree.points, values)
    const fallback = typeof tree.default === 'string' && tree.default ? tree.default : null
    if (!result && fallback) result = [{ clip: fallback, weight: 1 }]
    if (!result) return { weights: new Map(), dominant: null }
    // Accumulate per clip first: two points may share one clip (duplicates
    // collapse instead of the Map's last-wins hiding their summed weight).
    const raw = new Map()
    let sum = 0
    for (const r of result) {
      const w = r && typeof r.weight === 'number' ? r.weight : 0
      raw.set(r.clip, (raw.get(r.clip) || 0) + w)
      sum += w
    }
    if (!(sum > 1e-9)) {
      if (!fallback) return { weights: new Map(), dominant: null }
      raw.set(fallback, 1)
      sum = 1
    }
    const weights = new Map()
    let dominant = null
    for (const [clip, w] of raw) {
      const norm = w / sum
      weights.set(clip, norm)
      if (
        dominant === null ||
        norm > weights.get(dominant) + 1e-12 ||
        (Math.abs(norm - weights.get(dominant)) <= 1e-12 && clip < dominant)
      ) dominant = clip
    }
    return { weights, dominant }
  }

  /**
   * Ensure every distinct clip in the tree has a playing action on the
   * entity's mixer (created + played on first use, kept in
   * `entry.syncedActions` — the tree path's action set). Clip-name sorted for
   * deterministic iteration; clips missing from the model warn once per
   * creation attempt and are skipped (never throw).
   * @returns {Map<string, THREE.AnimationAction>} the synced action set.
   */
  _ensureTreeActions(id, entry, tree, model) {
    const names = new Set()
    for (const p of tree.points) {
      if (p && typeof p.clip === 'string' && p.clip) names.add(p.clip)
    }
    if (typeof tree.default === 'string' && tree.default) names.add(tree.default)
    // State clips may sit OUTSIDE the blend space (a pure override layer) —
    // their actions must exist for the hard-select step to actually play.
    if (Array.isArray(tree.states)) {
      for (const st of tree.states) {
        if (st && typeof st.clip === 'string' && st.clip) names.add(st.clip)
      }
    }
    if (!entry.syncedActions) entry.syncedActions = new Map()
    for (const name of [...names].sort()) {
      if (entry.syncedActions.has(name)) continue
      const clip = THREE.AnimationClip.findByName(model.animations, name)
      if (!clip) {
        console.warn(`[render] blend tree: clip "${name}" not found on model for entity "${id}" — skipped`)
        continue
      }
      const action = entry.mixer.clipAction(clip)
      action.setLoop(THREE.LoopRepeat, Infinity)
      action.play()
      entry.syncedActions.set(name, action)
    }
    return entry.syncedActions
  }

  /**
   * BT2 tree-driven playback for ONE entity: all of the tree's clips play
   * simultaneously, each action's effective weight re-set every step from
   * `_treeWeights` (pure function of the entity's params — no hidden
   * accumulators, scrub-friendly). The DOMINANT action owns the clock: every
   * other action mirrors its time each step (manual mirror — verified in the
   * boot spec; three's one-shot `syncWith` copy drifts across LoopRepeat
   * wraps of different-duration clips), so all clips stay phase-locked while
   * three wraps each at its own duration.
   *
   * Scope guard: single-clip playback semantics (playback.clip/fade/trim,
   * animation events, crossings) intentionally do NOT run on tree entities —
   * playback.playing is the run control (false stops every tree action) and
   * playbackRate the shared timeScale. Per-clip events on tree entities are a
   * later phase. Zero-delta (paused/scrub) steps apply NO weight change and
   * advance NO time; params edited while paused apply on the next unpaused
   * step. The `tree.states` hard-select layer (BT3) runs inside `_treeWeights`:
   * a truthy state param swaps the dominant clip at weight 1 on the next step.
   * @param {object} api      the game facade (param reads via api.animParams).
   * @param {string} id       entity id.
   * @param {object} entry    the mixer entry ({ mixer, action, ... }).
   * @param {object} playback the entity's playback component.
   * @param {number} dt       sim-time delta for this frame (0 when paused).
   * @param {object} model    the registered THREE model (has .animations).
   */
  _updateTreeAnimation(api, id, entry, playback, dt, model) {
    const tree = this._blendTrees.get(id)
    const playing = playback.playing !== false
    const requestedRate = playback.playbackRate !== undefined ? Number(playback.playbackRate) : 1
    const playbackRate = Number.isFinite(requestedRate) ? requestedRate : 1

    // A tree entity that previously ran the single-clip path: its legacy
    // action is not one of the synced actions — stop it (setBlendTree already
    // resets the entry; this guard covers direct _mixers manipulation).
    const existing = entry.syncedActions
    if (entry.action && (!existing || entry.action !== existing.get(entry.lastClip))) {
      if (entry.action.isRunning()) entry.action.stop()
      entry.action = null
      entry.lastClip = null
    }
    for (const a of entry.prevActions) if (a.isRunning()) a.stop()
    entry.prevActions = []

    // Run control (playing === false): stop ALL tree actions, like the
    // single-clip stopped path. Resume re-creates/re-plays them from time 0.
    if (!playing) {
      if (entry.syncedActions) {
        for (const a of entry.syncedActions.values()) if (a.isRunning()) a.stop()
      }
      entry.action = null
      entry.lastClip = null
      entry.mixer.update(dt)
      return
    }

    // Paused/scrub step (visualDelta 0): weights are pure functions of the
    // params, so they ARE applied on paused steps (an editor boots paused —
    // a tree entity must still assemble its actions + weights, or
    // playAnimation on it is a silent no-op until someone presses Play).
    // What a zero delta does NOT do: advance any time. mixer.update(dt)
    // below samples the pose at the current times without moving the clock.

    const { weights, dominant } = this._treeWeights(id, tree, api)
    if (weights.size === 0 || !dominant) {
      // No usable default clip either (warned once at action creation when a
      // clip is missing); nothing to schedule this step.
      entry.mixer.update(dt)
      return
    }
    const actions = this._ensureTreeActions(id, entry, tree, model)
    if (actions.size === 0) {
      entry.mixer.update(dt)
      return
    }
    // Re-play anything a playing:false step (or three's own stop) left dead.
    for (const action of actions.values()) {
      if (!action.isRunning()) action.play()
    }
    let dominantName = dominant
    if (!actions.has(dominantName)) {
      // Dominant clip missing from the model — deterministic fallback: the
      // first present action in clip-name order.
      dominantName = [...actions.keys()].sort()[0]
    }
    const dominantAction = actions.get(dominantName)

    for (const [name, action] of actions) {
      // Resume preview-paused actions ONLY on an unpaused step: a zero-delta
      // step must never lift a previewAnimationTime pause (the scrub contract).
      if (dt > 0) action.paused = false
      action.timeScale = playbackRate
      action.setEffectiveWeight(weights.get(name) || 0)
    }
    entry.action = dominantAction
    entry.lastClip = dominantName
    entry.treeWeights = weights
    entry.treeDominant = dominantName

    // SYNC (manual mirror): every non-dominant action follows the dominant's
    // clock — set to the dominant's time wrapped into the clip's own duration
    // (the exact sample three's LoopRepeat would take), then the shared
    // mixer.update(dt) advances every action by the SAME delta. Re-mirrored
    // each step, so different-duration clips stay phase-locked forever.
    for (const [name, action] of actions) {
      if (action === dominantAction) continue
      const dur = action.getClip().duration
      action.time = dur > 0 ? (dominantAction.time % dur) : 0
    }
    entry.mixer.update(dt)
  }

  /**
   * Scrub preview for a TREE entity (BT2): pause ALL tree actions and sample
   * the dominant clip at time `t` — the weighted pose renders immediately via
   * a zero-delta mixer.update(0). Also (re)applies the current evaluated
   * weights — a pure function of the params, so sampling never advances time
   * and never fires events (the tree path emits none). The BT4 pad scrubs
   * through this so the blend reacts live to param edits.
   * @param {string} id  entity id (no model / no tree / no resolvable clip → warn + no-op).
   * @param {number} t   clip time in seconds (clamped to the dominant clip's duration).
   */
  _previewTreeTime(id, t) {
    const model = this._models && this._models[id]
    const tree = this._blendTrees ? this._blendTrees.get(id) : null
    if (!model || !Array.isArray(model.animations) || model.animations.length === 0 || !tree) {
      console.warn(`[render] previewAnimationTime: no model or blend tree for entity "${id}" — no-op`)
      return
    }
    let entry = this._mixers.get(id)
    if (!entry) {
      entry = { mixer: new THREE.AnimationMixer(model), lastClip: null, action: null, prevActions: [] }
      this._mixers.set(id, entry)
    }
    const actions = this._ensureTreeActions(id, entry, tree, model)
    if (actions.size === 0) return
    const { weights, dominant } = this._treeWeights(id, tree, this._api)
    const name = actions.has(dominant) ? dominant : [...actions.keys()].sort()[0]
    const dominantAction = actions.get(name)
    const clip = dominantAction.getClip()
    const time = Math.max(0, Math.min(Number(t) || 0, clip.duration))
    for (const [clipName, action] of actions) {
      if (!action.isRunning()) action.play()
      action.paused = true
      action.setEffectiveWeight(weights.get(clipName) || 0)
      // Manual mirror into each clip's own range (same rule as the runtime
      // path): every clip samples the SAME phase modulo its duration.
      const dur = action.getClip().duration
      action.time = dur > 0 ? (time % dur) : 0
    }
    entry.action = dominantAction
    entry.lastClip = name
    entry.treeWeights = weights
    entry.treeDominant = name
    entry.mixer.update(0) // deltaTime 0: applies bindings (samples the pose), advances nothing
  }

  /**
   * Read live animation state for an entity — a pure read the inspector uses
   * to show "playback metrics" (current clip, playback time, clip duration) and
   * the list of clips actually mapped onto the entity's model. Never mutates
   * anything. Returns a stable shape even when the entity has no model or no
   * mixer yet, so callers can render without guarding.
   * @param {string} id  entity id.
   * @returns {{ clips: string[], currentClip: string|null, time: number,
   *             duration: number, weights?: Record<string, number> }}
   *   `weights` is present only when the entity is tree-driven (BT2) —
   *   clip name -> normalized weight (sums to 1) from the last blended step.
   */
  getAnimationInfo(id) {
    const model = this._models && this._models[id]
    const clips = model && Array.isArray(model.animations)
      ? model.animations.map((a) => (a && a.name) || '').filter(Boolean)
      : []
    const entry = this._mixers.get(id)
    const tree = this._blendTrees ? this._blendTrees.get(id) : null
    let time = 0
    let duration = 0
    let currentClip = null
    if (entry && entry.action) {
      currentClip = entry.lastClip || null
      if (tree) {
        // Tree-driven: time reads the DOMINANT action's own clock (not the
        // mixer's aggregate time), and the per-clip weight map rides along
        // for the BT4 pad/inspector.
        time = typeof entry.action.time === 'number' ? entry.action.time : 0
      } else {
        time = typeof entry.mixer.time === 'number' ? entry.mixer.time : 0
      }
      const clip = typeof entry.action.getClip === 'function' ? entry.action.getClip() : null
      if (clip && typeof clip.duration === 'number') duration = clip.duration
    }
    const info = { clips, currentClip, time, duration }
    if (tree && entry && entry.action && entry.treeWeights) {
      const weights = {}
      for (const [clip, w] of entry.treeWeights) weights[clip] = w
      info.weights = weights
    }
    return info
  }

  /**
   * Scrub preview (AN2): pose the entity's model at clip time `t` WITHOUT
   * advancing playback or firing events. Ensures the mixer entry + action
   * exist (created from the entity's `playback` component + registered model),
   * plays the action, then PAUSES it and sets its time — the pose samples
   * immediately via a zero-delta `mixer.update(0)`.
   *
   * Invariants: preview NEVER advances time (a paused action's timeScale is 0
   * in three's `_updateTimeScale`) and NEVER fires animation events (the AN1
   * crossings pass runs only on the playing path of `_updateAnimations`, which
   * also skips paused actions' time advance). The editor's Animation panel
   * scrub drives this per input; releasing the scrub restores normal playback.
   * @param {string} id  entity id (no model or no clip → warn + no-op).
   * @param {number} t   clip time in seconds (clamped to [0, clip duration]).
   */
  previewAnimationTime(id, t) {
    const model = this._models && this._models[id]
    const api = this._api
    const rec = api && typeof api.entity === 'function' ? api.entity(id) : null
    const playback = (rec && rec.components && rec.components.playback) || {}
    // Tree-driven entity (BT2): scrub the tree (pause all actions, sample the
    // dominant) instead of the single-clip path — playback.clip is not the
    // driver there and may not even resolve.
    if (this._blendTrees && this._blendTrees.has(id)) {
      this._previewTreeTime(id, t)
      return
    }
    const available = model && Array.isArray(model.animations)
      ? model.animations.map((a) => (a && a.name) || '').filter(Boolean)
      : []
    const clipName = resolveClip(playback.clip, available)
    if (!model || !clipName) {
      console.warn(`[render] previewAnimationTime: no model or resolvable clip for entity "${id}" — no-op`)
      return
    }
    let entry = this._mixers.get(id)
    if (!entry) {
      entry = { mixer: new THREE.AnimationMixer(model), lastClip: null, action: null, prevActions: [] }
      this._mixers.set(id, entry)
    }
    // Reuse the running action when it's the right clip; otherwise build one.
    let action = entry.action
    const actionClip = action && typeof action.getClip === 'function' ? action.getClip() : null
    if (!action || !actionClip || actionClip.name !== clipName) {
      if (action && action.isRunning()) action.stop()
      for (const a of entry.prevActions) if (a.isRunning()) a.stop()
      entry.prevActions = []
      action = entry.mixer.clipAction(THREE.AnimationClip.findByName(model.animations, clipName))
      action.setLoop(playback.loop !== false ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
      entry.action = action
      entry.lastClip = clipName
    }
    const clip = action.getClip()
    const time = Math.max(0, Math.min(Number(t) || 0, clip.duration))
    if (!action.isRunning()) action.play()
    action.paused = true
    action.time = time
    entry.mixer.update(0) // deltaTime 0: applies bindings (samples the pose), advances nothing
  }

  /**
   * Effective visibility: an entity is drawn only if ITS OWN `render.visible`
   * is not false AND every ancestor up the parent chain is also visible. This
   * makes a parent's visibility gate its whole subtree WITHOUT mutating the
   * children's own `visible` flags — hiding a flock region hides its fish, but
   * each fish keeps its own visibility so unhiding the region restores them.
   * @returns {boolean}
   */
  _isEffectivelyVisible(api, id) {
    let cur = id
    const seen = new Set()
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const rec = api.entity(cur)
      const r = rec && rec.components && rec.components.render
      if (r && r.visible === false) return false
      cur = typeof api.getParent === 'function' ? api.getParent(cur) : undefined
    }
    return true
  }

  /**
   * Collect renderable descriptors from the ECS.
   * Each entity with a `render` component becomes { id, mesh, material,
   * skinned?, tint?, transform } (transform from `transform` else `pos`).
   */
  /**
   * MODEL-IMPORT: entity ids that carry `render.model` (a whole-model draw)
   * but must NOT draw it this frame because at least one TRANSITIVE child
   * carries `render.node` referencing the SAME asset — the node-scoped
   * subtree proxies already render that geometry, so the root's own
   * full-model attach would draw every covered triangle a second time.
   *
   * Generic (no asset-specific logic): matches by identical `render.model`
   * path, or by both paths resolving to the ONE shared model object
   * registered via `registerModelAsset`. Recomputed every frame, so deleting
   * the node children immediately restores the root's full-model draw.
   * @param {object} api   the game's public facade (query/entity/getParent).
   * @returns {Set<string>} ids whose own full-model draw must be suppressed.
   */
  _coveredRoots(api) {
    const covered = new Set()
    if (!api || typeof api.query !== 'function' || typeof api.entity !== 'function') return covered
    // Children map (parent id -> child ids) + the node-scoped / root-model
    // entity splits, from ONE pass over the render entities.
    const childrenOf = new Map()
    const nodeScoped = []
    const rootModels = []
    for (const id of api.query({ has: 'render' })) {
      const rec = api.entity(id)
      const r = rec && rec.components && rec.components.render
      if (!r) continue
      const model = typeof r.model === 'string' && r.model ? r.model : null
      const hasNode = r.node != null && r.node !== ''
      if (hasNode && model) nodeScoped.push({ id, model })
      else if (model) rootModels.push({ id, model })
      const parent = typeof api.getParent === 'function' ? api.getParent(id) : undefined
      if (parent != null && parent !== '') {
        if (!childrenOf.has(parent)) childrenOf.set(parent, [])
        childrenOf.get(parent).push(id)
      }
    }
    if (!nodeScoped.length || !rootModels.length) return covered
    // Same asset: identical path, OR both paths resolve to the ONE registered
    // shared model object (registerModelAsset) — the editor canonicalizes
    // game-relative vs repo-relative forms, so path equality alone can miss.
    const sameAsset = (a, b) => {
      if (a === b) return true
      if (!this._assetModels) return false
      const ra = this._assetModels.get(String(a))
      return ra !== undefined && ra !== null && ra === this._assetModels.get(String(b))
    }
    for (const root of rootModels) {
      // Walk ALL transitive descendants of the root: any node-scoped child
      // referencing the SAME asset means the node proxies cover the whole
      // model — the root's own full-model draw is suppressed.
      const stack = [...(childrenOf.get(root.id) || [])]
      const visited = new Set()
      while (stack.length) {
        const id = stack.pop()
        if (visited.has(id)) continue
        visited.add(id)
        const rec = api.entity(id)
        const r = rec && rec.components && rec.components.render
        if (r && r.node != null && r.node !== '' && typeof r.model === 'string' && sameAsset(r.model, root.model)) {
          covered.add(root.id)
          break
        }
        for (const c of childrenOf.get(id) || []) stack.push(c)
      }
    }
    return covered
  }

  _collect(api) {
    // MODEL-IMPORT: roots whose node-scoped children cover their whole model —
    // their own full-model draw is suppressed this frame (see _coveredRoots).
    const coveredRoots = this._coveredRoots(api)
    // Layers: a layer with visible === false hides every entity assigned to it.
    // Entities without an explicit layer belong to the implicit 'default' layer,
    // so hiding 'default' hides all unassigned objects too.
    const hiddenLayers = new Set()
    if (typeof api.getLayers === 'function') {
      for (const l of api.getLayers()) {
        if (l && l.visible === false && typeof l.id === 'string') hiddenLayers.add(l.id)
      }
    }
    const items = []
    // Render-mesh entities, PLUS world-canvas entities (which register a model
    // plane as their render surface — see _syncWorldCanvas).
    const ids = api.query({ has: 'render' })
    for (const id of ids) {
      const record = api.entity(id)
      if (!record || !record.components || !record.components.render) continue
      const r = record.components.render
      // MODEL-IMPORT: a node-scoped entity renders via a lightweight subtree
      // proxy (see _updateNodeScopes) — its proxy Object3D is kept in the
      // scene and its `visible` flag is synced to the entity's effective
      // visibility EVERY frame there, so hiding/showing must NOT filter it
      // out here (filtering would destroy + re-attach the proxy per toggle).
      // Plain entities keep the skip: they simply leave the draw passes.
      const effVisible = this._isEffectivelyVisible(api, id)
      const isNodeScoped = r.node != null && r.node !== ''
      if (!effVisible && !isNodeScoped) continue // hidden (self or ancestor) — not drawn
      const layerId = typeof api.getLayer === 'function' ? api.getLayer(id) : undefined
      const layerHidden = hiddenLayers.has(layerId || 'default')
      if (layerHidden && !isNodeScoped) continue
      const transform = record.components.transform || record.components.pos || { x: 0, y: 0, z: 0 }
      // An entity that has a loaded model renders that model instead of a
      // shared box — the model (with its own mesh + AnimationMixer) is added
      // to the scene by _updateModelInstances, so it must be skipped by the
      // batching/skinned passes.
      const hasModel = !!(this._models && this._models[id]) ||
        // MODEL-IMPORT: a node-scoped entity (render.node set) renders a
        // subtree of the shared decoded model (see _updateNodeScopes) — it is
        // excluded from the primitive/batching/skinned passes exactly like an
        // entity that owns a whole model.
        (r.node != null && r.node !== '')
      // A model that's been registered as instanced (registerInstancedModel)
      // is rendered through a shared InstancedMesh (see _updateModelBatches),
      // NOT a per-entity model clone — so it is not `hasModel` for the
      // individual-model/batching passes.
      const modelName = r.modelName
      const isInstanced = typeof modelName === 'string' && this._modelBatches.has(modelName.replace(/^model\//, ''))
      // R3 custom shaders opt OUT of batching: a material that resolves to a
      // THREE.ShaderMaterial renders individually (the documented trade-off),
      // like skinned. Batched standard/material entities are unaffected.
      const resolvedMat = typeof r.material === 'string' ? this._resolveMaterial(r.material) : null
      const uniqueMaterial = !!(resolvedMat && resolvedMat.isShaderMaterial)
      // MODEL-IMPORT: the proxy subtree's `visible` flag — synced every frame
      // in _updateNodeScopes from this flag (entity effective visibility AND
      // its layer), so a hierarchy hide/show is a per-frame flag write on the
      // SAME proxy object (never a detach/re-attach cycle).
      items.push({ id, ...r, transform, hasModel, isInstanced, modelName, uniqueMaterial, proxyVisible: effVisible && !layerHidden, coveredByNodeScopes: coveredRoots.has(id) })
    }
    // Canvas entities (screen AND world) render a registered textured-plane
    // model even though they carry no `render` component (the surface model).
    const canvasIds = typeof api.query === 'function' ? api.query({ has: 'canvas' }) : []
    for (const id of canvasIds) {
      if (!(this._models && this._models[id])) continue
      const record = api.entity(id)
      const canvasComp = record && record.components && record.components.canvas
      if (!canvasComp) continue
      if (!this._isEffectivelyVisible(api, id)) continue
      const layerId = typeof api.getLayer === 'function' ? api.getLayer(id) : undefined
      if (hiddenLayers.has(layerId || 'default')) continue
      const transform = record.components.transform || { x: 0, y: 0, z: 0 }
      items.push({ id, ...(record.components.render || {}), transform, hasModel: true, isInstanced: false, modelName: undefined, uniqueMaterial: false })
    }
    return items
  }

  /**
   * Add/reposition every entity that has a loaded model in `_models`, so the
   * model is what actually renders (positioned at the entity transform). The
   * model's own AnimationMixer (driven by `_updateAnimations`) animates it in
   * place. Models are added to the scene once and reused; they are removed when
   * their entity no longer renders. `_sceneModelIds` tracks which entity ids
   * have their model currently attached to the scene.
   * @param {Array<object>} items  descriptors from _collect.
   */
  _updateModelInstances(items) {
    if (!this._sceneModels) this._sceneModels = new Map()
    const seen = new Set()
    for (const item of items) {
      if (!item.hasModel) continue
      seen.add(item.id)
      const model = this._models[item.id]
      // Node-scoped entities carry hasModel for pass-exclusion but resolve
      // their geometry in _updateNodeScopes, not here.
      if (!model) continue
      // MODEL-IMPORT: a covered root (render.model + transitive render.node
      // children on the same asset) draws NOTHING itself — the node proxies
      // render the whole model. Detach any currently-attached model but KEEP
      // `_models[id]` registered, so deleting the node children re-attaches
      // the root's model next frame (dynamic suppression, never permanent).
      if (item.coveredByNodeScopes) {
        if (this._sceneModels.has(item.id)) {
          this.scene.remove(this._sceneModels.get(item.id))
          this._sceneModels.delete(item.id)
        }
        continue
      }
      if (!this._sceneModels.has(item.id)) {
        this.scene.add(model)
        this._sceneModels.set(item.id, model)
      }
      // TAG FOR PICKING: a single non-batched model entity carries its own id
      // so raycastEntities can resolve a hit on the model subtree to the entity.
      if (!model.userData) model.userData = {}
      model.userData.hfEntityId = item.id
      // Per-entity shadow control on a loaded model: an individual model IS its
      // own Object3D, so castShadow/receiveShadow apply per entity directly.
      // Applied EVERY frame (not just on attach) so a live inspector toggle on a
      // model-rendered entity reflects immediately; the child meshes inherit the
      // flags from the model's own traverse.
      const cast = item.castShadow !== false
      const receive = item.receiveShadow !== false
      model.traverse((o) => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive } })
      // R1.5 (Option B): a model-rendered entity with a named material resolves
      // it through the registry and applies it to the model's meshes — so a
      // data-driven material (texture included) overrides the import-time baked
      // vertex-colors/texture. The registry mutates the material in place on
      // same-type edits, so the meshes update live with no re-traverse. No
      // named material (or unknown name) leaves the import-time resolution.
      //
      // BT4.5: `render.material` may ALSO be a PER-MESH MAP
      // ({ "MeshName": "materialName", ... }) for multi-material characters
      // (body + brows/eyes/mouth geos each carrying their own texture). Each
      // named mesh gets its resolved material; meshes NOT in the map keep
      // their import-time material. The signature guard caches the resolved
      // name->material pair set so same-type registry edits still update live.
      // MAT-6 NAMESPACE RULE (single rule, editor picker agrees): on the
      // WHOLE-MODEL path (no render.node) render.material is a REGISTRY name
      // (scene.materials / assets/materials). Only a NODE-SCOPED entity
      // (render.node set) resolves render.material in the EMBEDDED namespace
      // (see _applyNodeProxyOverride). See editor/src/ui/componentCards.js —
      // the picker switches on the same predicate.
      if (item.material && typeof item.material === 'string') {
        const resolved = this._resolveMaterial(item.material)
        if (resolved) {
          const prev = model.userData && model.userData.__hfMaterial
          if (prev !== resolved) {
            model.traverse((o) => { if (o.isMesh) o.material = resolved })
            if (!model.userData) model.userData = {}
            model.userData.__hfMaterial = resolved
          }
        } else {
          // Named material missing on a MODEL entity — LOUD (the model keeps
          // its import-time material, but the authored look is silently lost
          // unless we say so).
          this._reportMissingMaterial(item.material)
        }
      } else if (item.material && typeof item.material === 'object' && !Array.isArray(item.material)) {
        const entries = Object.entries(item.material)
        const resolvedPairs = entries
          .map(([meshName, matName]) => [meshName, matName, this._resolveMaterial(matName)])
        const sig = JSON.stringify(resolvedPairs.map(([n, , m]) => [n, m ? m.uuid : null]))
        if (model.userData.__hfMaterialMap !== sig) {
          for (const [meshName, matName, resolved] of resolvedPairs) {
            if (!resolved) {
              // Named material missing on a MODEL entity — LOUD.
              this._reportMissingMaterial(matName)
              continue
            }
            model.traverse((o) => {
              if (o.isMesh && o.name === meshName) o.material = resolved
            })
          }
          if (!model.userData) model.userData = {}
          model.userData.__hfMaterialMap = sig
        }
      }
      const p = this._position(item)
      model.position.set(p.x, p.y, p.z)
      // TRANSFORM PREVIEW: a previewed entity's rendered quaternion comes from
      // the preview (world space) — never recomposed from the serialized euler
      // mid-drag (see beginTransformPreview).
      const pv = this._previewFor(item.id)
      const wq = this._worldTransforms && this._worldTransforms.get(item.id)
      if (pv) {
        model.quaternion.copy(pv.quat)
        if (pv.pos) model.position.set(pv.pos.x, pv.pos.y, pv.pos.z)
      } else if (wq && wq.quat) {
        // World quaternion (ancestor preview propagation + parent chain), see
        // _updateBatches. Position already comes from _position (world).
        model.quaternion.set(wq.quat.x, wq.quat.y, wq.quat.z, wq.quat.w)
      } else {
        const e = this._rotation(item)
        model.rotation.set(e.x, e.y, e.z)
      }
      // Per-entity scale (transform.scale) MULTIPLIES the model's BASE scale
      // (captured at registerModel — the baked pack scale). transform.scale is
      // never a replacement: a model whose pack scale lives at the top level
      // (a rig placed by placeRigOnGround) or wrapped in an inner node both
      // keep their authored size, and the entity's transform.scale scales on
      // top of it — the same baseScale × per-entity-override contract as the
      // instanced-model path. Applied every frame so a live inspector/gizmo
      // scale edit reflects immediately.
      const base = this._modelBaseScale.get(item.id) || { x: 1, y: 1, z: 1 }
      const s = this._scale(item)
      model.scale.set((base.x ?? 1) * s.x, (base.y ?? 1) * s.y, (base.z ?? 1) * s.z)
    }
    // Detach models whose entity no longer has a render component (or was
    // DESTROYED — a deleted entity never appears in `seen`, so this is what
    // reclaims its skeleton/model/mixer). Unregister `_models[id]` too, or the
    // model object (skeleton + geometry) leaks in memory even though the entity
    // is gone from the world.
    for (const [id, model] of this._sceneModels) {
      if (!seen.has(id)) {
        this.scene.remove(model)
        this._sceneModels.delete(id)
        if (this._models && this._models[id]) this.unregisterModel(id)
      }
    }
  }

  /**
   * MODEL-IMPORT: node-scoped rendering. For every entity whose render
   * component carries `node` (a sub-model reference), resolve that named
   * node's subtree inside the ONE shared decoded model registered for the
   * asset path (`registerModelAsset`) and attach a LIGHTWEIGHT subtree proxy
   * to the scene: a clone of the subtree only (never the whole group, never a
   * second decode) whose meshes SHARE the source geometry and materials, so
   * memory per child is a handful of Object3D wrappers. The proxy is
   * positioned at the entity's (world-resolved) transform; the source node
   * inside any scene-attached copy of the shared model is hidden while its
   * proxy covers it, so a root entity (whole model) + node children never
   * double-draw. On detach the source visibility is restored.
   *
   * Resolution order (`_resolveModelNode`): nodePath (numeric index path from
   * the model root) is the tiebreaker — a unique name match wins on its own,
   * a duplicate/missing name falls back to nodePath.
   * @param {Array<object>} items  descriptors from _collect.
   */
  _updateNodeScopes(items) {
    if (!this._nodeProxies) this._nodeProxies = new Map()
    if (!this._assetModels) this._assetModels = new Map()
    const attachedRoots = this._sceneModels ? new Set(this._sceneModels.values()) : new Set()
    const seen = new Set()
    for (const item of items) {
      if (item.node == null || item.node === '') continue
      seen.add(item.id)
      const model = this._assetModels.get(String(item.model))
      if (!model) {
        // DIAGNOSTICS: dedupe per missing-epoch. During the async decode
        // window before registerModelAsset fires, node-scoped entities hit
        // this EVERY FRAME (~800 warns for ~2s of loading). Warn ONCE per
        // asset path; registerModelAsset clears the dedupe entry so a path
        // that registers and later goes missing again re-warns once.
        const key = String(item.model)
        // EXPECTED-PENDING: the editor announced this path via
        // expectModelAsset before kicking off its decode — do not warn while
        // the decode is in flight (registerModelAsset clears the pending
        // entry when the model lands).
        if (this._expectedModelAssets && this._expectedModelAssets.has(key)) continue
        if (!this._missingAssetWarned) this._missingAssetWarned = new Set()
        if (!this._missingAssetWarned.has(key)) {
          this._missingAssetWarned.add(key)
          this._emit('warn', `render.node '${item.node}' on '${item.id}': no shared model registered for '${item.model}' (registerModelAsset)`)
        }
        continue
      }
      const source = this._resolveModelNode(model, item.node, item.nodePath)
      if (!source) {
        this._emit('warn', `render.node '${item.node}' (nodePath ${item.nodePath || 'none'}) on '${item.id}': node not found in '${item.model}'`)
        continue
      }
      let entry = this._nodeProxies.get(item.id)
      if (!entry || entry.source !== source) {
        if (entry) this._detachNodeProxy(item.id, entry)
        const cloneBySrc = new Map()
        const proxy = this._cloneSubtree(source, true, cloneBySrc)
        this.scene.add(proxy)
        entry = { proxy, source, model, cloneBySrc }
        this._nodeProxies.set(item.id, entry)
      }
      // TAG FOR PICKING: the node proxy subtree carries its entity id so
      // raycastEntities resolves a hit to the entity (see raycastEntities).
      entry.proxy.userData.hfEntityId = item.id
      // No double-draw: while the shared model is attached to the scene (the
      // root entity renders the whole thing), the covered source subtree is
      // hidden. Track the authored visibility once so a detach restores it.
      if (source.userData.__hfVisible === undefined) source.userData.__hfVisible = source.visible
      source.visible = attachedRoots.has(model) ? false : source.userData.__hfVisible
      // Per-entity placement — MODEL-IMPORT (T2): the proxy consumes the
      // entity's WORLD-RESOLVED transform (resolveWorldTransforms: parent
      // chain composes position additively, rotation quaternion parent∘local,
      // scale parent×local) EXACTLY ONCE. Re-applying local values here would
      // double-apply ancestor scale/rotation on nested (hydrated) entities.
      // When no world map entry exists (unit harnesses), fall back to the
      // local transform contract.
      const w = this._worldTransforms && this._worldTransforms.has(item.id)
        ? this._worldTransforms.get(item.id)
        : null
      // TRANSFORM PREVIEW: compose the proxy's world matrix from the previewed
      // quaternion/position instead of the serialized chain (see
      // beginTransformPreview) so the engine's per-frame sync cannot clobber
      // the gizmo's in-flight preview.
      const pv = this._previewFor(item.id)
      if (pv) {
        const ps = this._scale(item)
        const pp = pv.pos || (w ? { x: w.x, y: w.y, z: w.z } : this._position(item))
        entry.proxy.matrixAutoUpdate = false
        entry.proxy.matrix.compose(
          new THREE.Vector3(pp.x, pp.y, pp.z),
          pv.quat,
          new THREE.Vector3(ps.x, ps.y, ps.z),
        )
        entry.proxy.matrixWorldNeedsUpdate = true
      } else if (w && w.matrix) {
        // EXACT world transform: the composed 4×4 from resolveWorldTransforms
        // (column-major). A non-uniform ancestor scale composed with a rotated
        // child shears — it does NOT decompose into TRS — so the matrix is the
        // authority. The proxy is a direct scene child (identity scene root),
        // so its local matrix IS its world matrix. The cloned subtree keeps
        // its authored local TRS below this root.
        entry.proxy.matrixAutoUpdate = false
        entry.proxy.matrix.fromArray(w.matrix)
        entry.proxy.matrixWorldNeedsUpdate = true
      } else if (w && w.quat && w.scale) {
        // TRS fallback (approximate for sheared chains, exact otherwise).
        entry.proxy.matrixAutoUpdate = true
        entry.proxy.position.set(w.x, w.y, w.z)
        entry.proxy.quaternion.set(w.quat.x, w.quat.y, w.quat.z, w.quat.w)
        entry.proxy.scale.set(w.scale.x, w.scale.y, w.scale.z)
      } else {
        entry.proxy.matrixAutoUpdate = true
        const p = this._position(item)
        entry.proxy.position.set(p.x, p.y, p.z)
        const e = this._rotation(item)
        entry.proxy.rotation.set(e.x, e.y, e.z)
        const s = this._scale(item)
        entry.proxy.scale.set(s.x, s.y, s.z)
      }
      // MODEL-IMPORT per-entity material override: render.material (name of one
      // of the model's OWN embedded materials) and/or render.tint (hex color
      // multiply). Applied WITHOUT mutating the shared decoded model — the
      // proxy's meshes get lazily cloned materials (see _applyNodeProxyOverride).
      // Field removal (or 'Default') restores the verbatim asset materials.
      this._applyNodeProxyOverride(entry, item)
      // Per-entity shadow flags, applied every frame like the model path.
      const cast = item.castShadow !== false
      const receive = item.receiveShadow !== false
      entry.proxy.traverse((o) => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive } })
      // MODEL-IMPORT visibility sync (T3): the proxy subtree's `visible` flag
      // follows the entity's EFFECTIVE visibility (own render.visible AND
      // ancestors AND layer) on EVERY sync — a hierarchy hide/show flips this
      // flag in place on the SAME proxy object. The proxy is never destroyed
      // or re-attached for a visibility change, so the object identity (and
      // the world transform computed above) is stable across toggles.
      entry.proxy.visible = item.proxyVisible !== false
    }
    // Detach proxies whose entity lost its render.node / was destroyed, and
    // restore the authored visibility of their source nodes.
    for (const [id, entry] of this._nodeProxies) {
      if (!seen.has(id)) this._detachNodeProxy(id, entry)
    }
    this._syncNestedProxyVisibility()
  }

  /**
   * MODEL-IMPORT: no overlapping draws between NESTED node scopes. A proxy
   * mirrors its whole source subtree, but a DEEPER node-scoped descendant on
   * the same model renders that region with its OWN separate proxy — without
   * this pass the shared geometry would draw once inside the ancestor proxy
   * and again in the descendant's proxy (per-geometry multiplicity grows with
   * nesting depth). Hide the covered regions inside each clone and mirror the
   * source's authored visibility everywhere else — recomputed EVERY frame, so
   * deleting the deeper entity restores the ancestor's copy immediately.
   * Runs AFTER the detach loop so a just-deleted deeper entity stops covering.
   */
  _syncNestedProxyVisibility() {
    if (!this._nodeProxies || !this._nodeProxies.size) return
    const coveredByModel = new Map()
    for (const entry of this._nodeProxies.values()) {
      if (!coveredByModel.has(entry.model)) coveredByModel.set(entry.model, new Set())
      coveredByModel.get(entry.model).add(entry.source)
    }
    for (const entry of this._nodeProxies.values()) {
      if (!entry.cloneBySrc) continue
      const covered = coveredByModel.get(entry.model)
      for (const [src, clone] of entry.cloneBySrc) {
        if (src === entry.source) continue // the proxy ROOT: entity-driven visibility
        // Mirror the AUTHORED visibility (not src.visible — the shared-model
        // attach may have temporarily hidden the source; see attachedRoots).
        const authored = src.userData && src.userData.__hfVisible !== undefined ? src.userData.__hfVisible : src.visible
        clone.visible = covered.has(src) ? false : authored
      }
    }
  }


  /** Remove a node proxy from the scene and un-hide its source subtree root. */
  _detachNodeProxy(id, entry) {
    this.scene.remove(entry.proxy)
    if (entry.source.userData && entry.source.userData.__hfVisible !== undefined) {
      entry.source.visible = entry.source.userData.__hfVisible
      delete entry.source.userData.__hfVisible
    }
    this._nodeProxies.delete(id)
  }

  /**
   * MODEL-IMPORT per-entity material override on a node-scoped proxy.
   *
   * render.material  — the NAME of one of the model's OWN embedded materials
   *                    (picker source: the distinct materials of the referenced
   *                    model, discovered live — never free text). Absent/'' =
   *                    verbatim asset material (LOSSLESS default).
   * render.tint      — '#rrggbb' hex, combined with the resolved material's
   *                    color per render.tintMode. Absent = no tint.
   * render.tintMode  — how `render.tint` combines with the material color:
   *                    'multiply' (DEFAULT — legacy behavior, material.color ×
   *                    tint; byte-identical when absent) | 'replace' (the tint
   *                    IS the color — hue = the tint verbatim, lighting/shading
   *                    preserved because only `color` is set on the clone).
   *                    Unknown values throw LOUDLY, naming the bad mode.
   *
   * The shared decoded model is NEVER mutated (LOSSLESS IMPORT doctrine):
   * overrides are written onto PER-ENTRY CLONES of the materials, created
   * lazily on first application and cached per original material object, so
   * meshes sharing one embedded material inside one proxy share one clone.
   * Changing or removing the override restores the original material REFERENCE
   * on every proxy mesh first (dynamic revert), then re-applies if requested.
   * An unknown material name warns ONCE per entry + renders verbatim.
   * @param {object} entry  a _nodeProxies entry ({ proxy, source, model }).
   * @param {object} item   the _collect descriptor (spread render record).
   */
  _applyNodeProxyOverride(entry, item) {
    const matName = typeof item.material === 'string' ? item.material : ''
    const tintMode = item.tintMode == null || item.tintMode === '' ? 'multiply' : item.tintMode
    if (tintMode !== 'multiply' && tintMode !== 'replace') {
      throw new Error(`render.tintMode: unknown mode '${item.tintMode}' — expected 'multiply' (default) or 'replace'`)
    }
    const tint = typeof item.tint === 'string' && item.tint ? item.tint : ''
    const key = `${matName}\u0000${tint}\u0000${tintMode}`
    if (entry.__overrideKey === key) return // per-frame no-op
    // Revert first: restore the verbatim material reference on every proxy mesh.
    if (entry.__savedMaterials) {
      for (const [mesh, orig] of entry.__savedMaterials) mesh.material = orig
      entry.__savedMaterials.clear()
    }
    entry.__materialClones = null
    entry.__overrideKey = key
    if (!matName && !tint) return // verbatim (Default)
    // Lazy state.
    if (!entry.__savedMaterials) entry.__savedMaterials = new Map()
    if (!entry.__materialClones) entry.__materialClones = new Map()
    if (!entry.__overrideWarned) entry.__overrideWarned = new Set()
    const tintMul = tint
      ? (() => { try { return new THREE.Color(tint) } catch { return null } })()
      : null
    let byName = null
    if (matName) {
      // Resolve by NAME from the shared model's own materials (discovered live).
      byName = new Map()
      entry.model.traverse((o) => {
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : [])
        for (const m of mats) if (m && !byName.has(m.name)) byName.set(m.name, m)
      })
      if (!byName.has(matName) && !entry.__overrideWarned.has(`name:${matName}`)) {
        entry.__overrideWarned.add(`name:${matName}`)
        this._emit('warn', `render.material override '${matName}': not an embedded material of '${item.model}' — rendering verbatim`)
      }
    }
    entry.proxy.traverse((o) => {
      if (!o.isMesh) return
      if (!entry.__savedMaterials.has(o)) entry.__savedMaterials.set(o, o.material)
      const srcMats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : [])
      if (!srcMats.length) return
      const next = srcMats.map((m) => {
        const resolved = (matName && byName.has(matName)) ? byName.get(matName) : m
        if (!resolved) return m
        // Verbatim case (own material, no tint): keep the original REFERENCE —
        // no clone, exactly the asset material.
        if (resolved === m && !tintMul) return m
        // Lazy clone per ORIGINAL material object — the shared asset material
        // itself is never touched.
        let clone = entry.__materialClones.get(resolved)
        if (!clone) {
          clone = resolved.clone()
          entry.__materialClones.set(resolved, clone)
        }
        if (tintMul && clone.color && typeof clone.color.multiply === 'function') {
          // Fresh clone each application (see revert above), so the combine is
          // applied exactly once — never compounding across frames. 'replace'
          // copies the tint OVER the color (hue = the tint, shading kept);
          // 'multiply' (default) is the legacy material.color × tint.
          if (tintMode === 'replace') clone.color.copy(tintMul)
          else clone.color.multiply(tintMul)
        }
        return clone
      })
      o.material = Array.isArray(o.material) ? next : next[0]
    })
  }

  /**
   * MODEL-IMPORT (T3): the live Object3D proxy subtree rendering the
   * node-scoped entity `id`, or null. The editor's selection volume reads the
   * proxy's WORLD matrix + world-space bounds from it so the selection outline
   * sits exactly on what is rendered (rotation + scale included). The proxy is
   * a direct scene child whose matrix is the composed world transform.
   * @param {string} id
   * @returns {THREE.Object3D|null}
   */
  getNodeProxy(id) {
    const entry = this._nodeProxies && this._nodeProxies.get(id)
    return entry ? entry.proxy : null
  }

  /**
   * EDITOR PICK (render-mesh-first): raycast the scene's RENDERABLE Object3Ds
   * and resolve the nearest hit to the ENTITY it belongs to. The batch tagging
   * (hfEntityIds on InstancedMeshes, hfEntityId on single models / node proxies)
   * is what makes this possible — a hit on an InstancedMesh carries an
   * instanceId that indexes hfEntityIds; a hit on a single model/proxy carries
   * its own hfEntityId.
   *
   * Batches are tested non-recursively (intersectObject(obj, false) — the
   * InstancedMesh itself, whose geometry IS the instance footprint). Single
   * models/proxies are tested recursively (intersectObject(obj, true) — a model
   * subtree may nest meshes). The nearest hit wins; an instanceId past the
   * batch's live count is ignored (raycaster already respects inst.count, but
   * the guard keeps the resolver honest).
   *
   * @param {THREE.Raycaster} raycaster  positioned by the caller (setFromCamera)
   * @returns {{ id:string, t:number, point:{x,y,z} }|null}
   */
  raycastEntities(raycaster) {
    const objs = []
    for (const obj of this.scene.children) {
      const u = obj.userData
      if (!u) continue
      if (u.hfEntityIds || u.hfEntityId) objs.push(obj)
    }
    if (!objs.length) return null
    // Per-object hits with the right recursion: BATCHES are non-recursive (the
    // InstancedMesh itself — hit.instanceId indexes hfEntityIds); single models
    // and node proxies are recursive (a model subtree may nest meshes under the
    // tagged root). Collect every hit, then return the nearest that resolves.
    const all = []
    for (const obj of objs) {
      const recursive = !obj.userData.hfEntityIds
      const hs = raycaster.intersectObject(obj, recursive)
      for (const h of hs) all.push({ obj: h.object, dist: h.distance, point: h.point, instanceId: h.instanceId })
    }
    all.sort((a, b) => a.dist - b.dist) // nearest first
    for (const h of all) {
      const u = h.obj.userData
      let id = null
      if (u && u.hfEntityIds) {
        // Batch InstancedMesh: the instanceId indexes the ordered id array. Guard
        // against a stale trailing id (batch count shrank below the array length).
        const idx = h.instanceId
        if (Number.isInteger(idx) && idx >= 0 && idx < u.hfEntityIds.length && idx < h.obj.count) {
          id = u.hfEntityIds[idx]
        }
      } else if (u && u.hfEntityId) {
        id = u.hfEntityId
      }
      if (id != null) {
        const p = h.point
        return { id, t: h.dist, point: { x: p.x, y: p.y, z: p.z } }
      }
    }
    return null
  }

  /** DIAGNOSTIC (tests): renderable-entity inventory + camera state. */
  _diagPicking() {
    const objs = []
    for (const obj of this.scene.children) {
      const u = obj.userData
      if (!u) continue
      if (u.hfEntityIds || u.hfEntityId) objs.push({ type: obj.type, ids: u.hfEntityIds, id: u.hfEntityId, count: obj.count, visible: obj.visible })
    }
    const cam = this.camera
    const camPos = cam ? { x: cam.position.x, y: cam.position.y, z: cam.position.z } : null
    const lookAt = cam ? { x: cam.getWorldDirection(new THREE.Vector3()).x, y: cam.getWorldDirection(new THREE.Vector3()).y, z: cam.getWorldDirection(new THREE.Vector3()).z } : null
    return { objs, camPos, lookAt }
  }

  /**
   * EDITOR TRANSFORM PREVIEW (rotate gizmo preview-on-object drag).
   *
   * While a preview is active for an entity, the renderer's per-frame sync
   * (_updateModelInstances / _updateNodeScopes / _updateModelBatches /
   * _updateBatches / _updateSkinned) applies the previewed WORLD quaternion
   * (and world position, when provided) DIRECTLY to the rendered Object3D or
   * instance matrix and SKIPS the rotation/position recomposition from the
   * serialized transform component. This is the mid-drag suppression
   * mechanism: without it the engine's own sync would overwrite the
   * gizmo's in-flight preview from the (deliberately stale) serialized data
   * every frame. The editor calls beginTransformPreview for each selected
   * entity at drag start, setTransformPreview per move, and
   * endTransformPreview at drag end — after which the next sync recomposes
   * from the serialized record the editor commits at mouse-up.
   */
  beginTransformPreview(id) {
    if (!this._transformPreviews) this._transformPreviews = new Map()
    if (!this._transformPreviews.has(id)) this._transformPreviews.set(id, null)
  }

  /** Set the preview transform for `id`: { quat: THREE.Quaternion (world),
   *  pos: THREE.Vector3|null (world; null keeps the serialized position). */
  setTransformPreview(id, preview) {
    if (!this._transformPreviews) this._transformPreviews = new Map()
    this._transformPreviews.set(id, {
      quat: preview && preview.quat ? preview.quat.clone() : new THREE.Quaternion(),
      pos: preview && preview.pos ? preview.pos.clone() : null,
    })
  }

  /** End the preview for `id` — the next sync recomposes from serialized data. */
  endTransformPreview(id) {
    if (this._transformPreviews) this._transformPreviews.delete(id)
  }

  /** Test/diagnostic readback: { quat: {x,y,z,w}, pos: {x,y,z}|null } or null. */
  getTransformPreview(id) {
    const p = this._transformPreviews && this._transformPreviews.get(id)
    if (!p) return null
    return {
      quat: { x: p.quat.x, y: p.quat.y, z: p.quat.z, w: p.quat.w },
      pos: p.pos ? { x: p.pos.x, y: p.pos.y, z: p.pos.z } : null,
    }
  }

  /** Internal: the active preview entry for `id`, or null. */
  _previewFor(id) {
    return (this._transformPreviews && this._transformPreviews.get(id)) || null
  }

  /**
   * Resolve a node inside a model: name first (unique match); when the name
   * is missing OR matches several nodes, `nodePath` ("i/j/k", numeric index
   * path from the model root) is the tiebreaker. A valid nodePath with a
   * missing name still resolves — the path is authoritative, the name is the
   * human-readable label.
   * @param {THREE.Object3D} model
   * @param {string} nodeName
   * @param {string} [nodePath]
   * @returns {THREE.Object3D|null}
   */
  _resolveModelNode(model, nodeName, nodePath) {
    if (!model) return null
    const byPath = this._nodeByPath(model, nodePath)
    if (typeof nodeName === 'string' && nodeName !== '') {
      const matches = []
      model.traverse((o) => { if (o.name === nodeName) matches.push(o) })
      if (matches.length === 1) return matches[0]
      if (matches.length > 1) {
        // Duplicate names: nodePath wins when it points at one of them.
        if (byPath && matches.includes(byPath)) return byPath
        return matches[0]
      }
    }
    return byPath
  }

  /** Walk a "i/j/k" numeric index path (first index = a model-root child); null if invalid. */
  _nodeByPath(model, nodePath) {
    if (nodePath == null || nodePath === '') return null
    const idx = String(nodePath).split('/').map((s) => parseInt(s, 10))
    if (idx.some((n) => !Number.isInteger(n) || n < 0)) return null
    let cur = model
    for (const i of idx) {
      if (!cur || !cur.children || i >= cur.children.length) return null
      cur = cur.children[i]
    }
    return cur || null
  }

  /**
   * Clone a node SUBTREE only (MODEL-IMPORT): plain Object3D wrappers whose
   * meshes share the source geometry and materials (zero geometry copies),
   * preserving local transforms, names and visibility. Never used to clone a
   * WHOLE model per child — that is the whole point of node scoping.
   */
  _cloneSubtree(src, isRoot = true, srcMap = null) {
    let out
    if (src.isMesh) {
      out = new THREE.Mesh(src.geometry, src.material)
    } else if (src.isBone) {
      out = new THREE.Bone()
    } else {
      out = new THREE.Object3D()
    }
    out.name = src.name
    if (srcMap) srcMap.set(src, out)
    if (isRoot) {
      // The proxy ROOT is positioned by _updateNodeScopes at the entity's
      // (world-resolved) transform — the node's own authored local transform
      // must NOT double-apply, so the root carries an identity transform.
    } else {
      // DESCENDANTS keep their authored local TRS — they are placed exactly
      // as the glTF authored them (lossless mirror); zeroing them collapses
      // the subtree onto the root.
      out.position.copy(src.position)
      out.quaternion.copy(src.quaternion)
      out.scale.copy(src.scale)
    }
    out.visible = src.visible
    for (const child of src.children) out.add(this._cloneSubtree(child, false, srcMap))
    return out
  }

  /**
   * ECS-aware materialization: for every model type registered via
   * `registerInstancedModel`, render ALL entities sharing that model through a
   * single InstancedMesh instead of N per-entity model clones. Entities whose
   * modelName is instanced are skipped by _updateModelInstances (they no longer
   * get their own `_models[id]` clone) and instead have a matrix written into
   * the shared batch each frame. This collapses thousands of decorative trees
   * into one draw call + one geometry/materials set.
   *
   * Entities that are skinned/animated (a per-entity rig) or that were
   * registered per-id via registerModel are never instanced — they keep their
   * individual model. `_collect` marks `hasModel` for those; here we only touch
   * entities whose modelName matches an instanced batch.
   * @param {Array<object>} items  descriptors from _collect.
   */
  _updateModelBatches(items) {
    if (this._modelBatches.size === 0) return
    const matrix = new THREE.Matrix4()
    const quat = new THREE.Quaternion()
    const vPos = new THREE.Vector3()
    const vScale = new THREE.Vector3()
    // Bucket items by (base modelName + shadow flags). Entities sharing a model
    // AND the same shadow flags share an InstancedMesh; a different flag set
    // breaks out into its own — the same shadow split as the box batch.
    const byModel = new Map() // `${base}\u0000${shadowKey}` -> { base, shadowKey, items }
    for (const item of items) {
      if (!item.modelName) continue
      const base = String(item.modelName).replace(/^model\//, '')
      if (!this._modelBatches.has(base)) continue
      const { castShadow, receiveShadow } = resolveShadow(item)
      const shadowKey = `${castShadow ? 1 : 0}${receiveShadow ? 1 : 0}`
      const key = `${base}\u0000${shadowKey}`
      if (!byModel.has(key)) byModel.set(key, { base, shadowKey, items: [] })
      byModel.get(key).items.push(item)
    }
    // Render each batch.
    const seen = new Set() // of `${base}\u0000${shadowKey}`
    for (const [key, { base, shadowKey, items }] of byModel) {
      const batch = this._modelBatches.get(base)
      const mesh = this._getModelBatchMesh(base, items.length, shadowKey)
      if (!mesh) continue
      seen.add(key)
      mesh.count = items.length
      const sub = batch.byShadow.get(shadowKey)
      sub.ids = new Set(items.map((it) => it.id))
      const baseScale = batch.baseScale || { x: 1, y: 1, z: 1 }
      items.forEach((item, i) => {
        const p = this._position(item)
        // Per-instance scale = the source model's base (pack) scale times the
        // per-entity override (a tree's scale array). The base scale is baked
        // into every instance so geometry normalized by importModel's uniform
        // pack scale renders at that size, not the raw FBX size.
        const s = this._scale(item)
        // TRANSFORM PREVIEW: previewed entities use the previewed WORLD
        // quaternion (and world position) instead of the serialized euler.
        // Non-previewed PARENTED entities compose the world quaternion from
        // _worldTransforms (ancestor preview propagation — see _updateBatches).
        const pv = this._previewFor(item.id)
        const wq = !pv && this._worldTransforms && this._worldTransforms.get(item.id)
        if (pv) {
          quat.copy(pv.quat)
          const pp = pv.pos || p
          vPos.set(pp.x, pp.y, pp.z)
        } else if (wq && wq.quat) {
          quat.set(wq.quat.x, wq.quat.y, wq.quat.z, wq.quat.w)
          vPos.set(p.x, p.y, p.z)
        } else {
          quat.setFromEuler(this._rotation(item))
          vPos.set(p.x, p.y, p.z)
        }
        vScale.set(s.x * (baseScale.x ?? 1), s.y * (baseScale.y ?? 1), s.z * (baseScale.z ?? 1))
        matrix.compose(vPos, quat, vScale)
        mesh.setMatrixAt(i, matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
      // TAG FOR PICKING: ordered entity-id array so a raycast hit's instanceId
      // resolves to the entity that instance belongs to (see raycastEntities).
      sub.mesh.userData.hfEntityIds = items.map((it) => it.id)
      sub.mesh.userData.hfBatch = true
    }
    // Drop batch MESHES (per shadow key) whose entities are gone, but keep the
    // base registration (source + baseScale) so the model persists across
    // frames — otherwise registerInstancedModel (guarded by instancedLoaded)
    // never re-registers and the instanced rendering silently stops.
    for (const [base, batch] of this._modelBatches) {
      for (const [shadowKey, sub] of batch.byShadow) {
        if (sub.mesh && !seen.has(`${base}\u0000${shadowKey}`)) {
          this.scene.remove(sub.mesh)
          batch.byShadow.delete(shadowKey)
        }
      }
    }
  }

  _updateBatches(items) {
    const batches = groupBatches(items.filter((it) => !it.hasModel && !it.isInstanced && !it.uniqueMaterial))
    const seen = new Set()
    for (const batch of batches) {
      seen.add(batch.key)
      const inst = this._getBatch(batch)
      inst.count = batch.ids.length
      const matrix = new THREE.Matrix4()
      const quat = new THREE.Quaternion()
      const vPos = new THREE.Vector3()
      const vScale = new THREE.Vector3()
      batch.ids.forEach((id, i) => {
        const item = items.find((it) => it.id === id)
        const p = this._position(item)
        // Per-instance scale so a box can match its collider size (ground,
        // platforms) instead of always rendering as a 1×1×1 unit cube.
        const s = this._scale(item)
        // TRANSFORM PREVIEW: previewed entities use the previewed WORLD
        // quaternion (and world position) instead of the serialized euler.
        // Non-previewed PARENTED entities compose the world quaternion from
        // _worldTransforms (which carries the ancestor's previewed world
        // quat/pos down the whole chain — rigid-body propagation), so a
        // descendant's rendered orientation AND position follow the dragged
        // ancestor's preview live. Parentless entities are identical either
        // way (world quat == local euler quat).
        const pv = this._previewFor(item.id)
        const wq = !pv && this._worldTransforms && this._worldTransforms.get(item.id)
        if (pv) {
          quat.copy(pv.quat)
          const pp = pv.pos || p
          vPos.set(pp.x, pp.y, pp.z)
        } else if (wq && wq.quat) {
          quat.set(wq.quat.x, wq.quat.y, wq.quat.z, wq.quat.w)
          vPos.set(p.x, p.y, p.z)
        } else {
          quat.setFromEuler(this._rotation(item))
          vPos.set(p.x, p.y, p.z)
        }
        vScale.set(s.x, s.y, s.z)
        matrix.compose(vPos, quat, vScale)
        inst.setMatrixAt(i, matrix)
        if (item.tint && typeof inst.setColorAt === 'function') {
          inst.setColorAt(i, new THREE.Color(item.tint[0], item.tint[1], item.tint[2]))
        }
      })
      inst.instanceMatrix.needsUpdate = true
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      // TAG FOR PICKING: ordered entity-id array so a raycast hit's instanceId
      // resolves to the entity that instance belongs to. Reused InstancedMesh
      // objects are re-tagged every frame; when count shrinks trailing ids may
      // exceed inst.count, but raycaster.intersectObject respects count so the
      // resolver only ever trusts instanceId < inst.count (see raycastEntities).
      inst.userData.hfEntityIds = batch.ids.slice()
      inst.userData.hfBatch = true
    }
    // Drop batches whose entities are gone.
    for (const [key, inst] of this._batches) {
      if (!seen.has(key)) {
        this.scene.remove(inst)
        this._batches.delete(key)
      }
    }
  }

  /** Get (or create, growing as needed) the InstancedMesh for a batch key. */
  _getBatch(batch) {
    const need = Math.max(batch.ids.length, 1)
    let inst = this._batches.get(batch.key)
    if (!inst || inst._capacity < need) {
      const capacity = Math.max(MIN_CAPACITY, nextPow2(need))
      const next = new THREE.InstancedMesh(this._geometry(batch.mesh), this._material(batch.material, batch.materialParams), capacity)
      // Never frustum-cull instanced batches — stale cached boundingSphere
      // (computed once at first frustum test, never recomputed while instance
      // matrices change every frame) makes the cull test lie and whole batches
      // vanish when zooming in. See the matching comment at the model-batch
      // creation site above for the full rationale + probe evidence.
      next.frustumCulled = false
      next._capacity = capacity
      // Shadow flags are per-batch (per-Object3D); entities that turned a flag
      // off carry their own batch key (batching.js), so this whole InstancedMesh
      // gets the right flags.
      next.castShadow = batch.castShadow !== false
      next.receiveShadow = batch.receiveShadow !== false
      if (inst) this.scene.remove(inst)
      this.scene.add(next)
      this._batches.set(batch.key, next)
      inst = next
    }
    return inst
  }

  _updateSkinned(items) {
    const seen = new Set()
    for (const item of items) {
      if ((item.skinned !== true && item.uniqueMaterial !== true) || item.hasModel || item.isInstanced) continue
      seen.add(item.id)
      let mesh = this._skinned.get(item.id)
      if (!mesh) {
        mesh = new THREE.Mesh(this._geometry(item.mesh), this._material(item.material, item.materialParams))
        this.scene.add(mesh)
        this._skinned.set(item.id, mesh)
      }
      // Per-entity shadow control: an individual mesh IS its own Object3D, so
      // castShadow/receiveShadow apply per entity directly. Re-applied each frame
      // so a live inspector toggle reflects immediately.
      mesh.castShadow = item.castShadow !== false
      mesh.receiveShadow = item.receiveShadow !== false
      // Re-resolve the material each frame for UNIQUE (custom-shader) materials
      // so a live shader edit (shared material mutated in place by the shader
      // registry) reflects immediately; the individual mesh re-points at the
      // current material. Skinned meshes keep their stable material.
      if (item.uniqueMaterial === true) {
        const mat = this._material(item.material, item.materialParams)
        if (mat && mat !== mesh.material) mesh.material = mat
        if (mat) this._trackTimeMaterial(mat)
      }
      const p = this._position(item)
      mesh.position.set(p.x, p.y, p.z)
      // TRANSFORM PREVIEW: previewed entities render the preview quaternion
      // (world space), never the recomposed serialized euler mid-drag.
      const pv = this._previewFor(item.id)
      const wq = this._worldTransforms && this._worldTransforms.get(item.id)
      if (pv) {
        mesh.quaternion.copy(pv.quat)
        if (pv.pos) mesh.position.set(pv.pos.x, pv.pos.y, pv.pos.z)
      } else if (wq && wq.quat) {
        // World quaternion (ancestor preview propagation + parent chain), see
        // _updateBatches. Position already comes from _position (world).
        mesh.quaternion.set(wq.quat.x, wq.quat.y, wq.quat.z, wq.quat.w)
      } else {
        const e = this._rotation(item)
        mesh.rotation.set(e.x, e.y, e.z)
      }
      const s = this._scale(item)
      mesh.scale.set(s.x, s.y, s.z)
    }
    for (const [id, mesh] of this._skinned) {
      if (!seen.has(id)) {
        this.scene.remove(mesh)
        this._skinned.delete(id)
      }
    }
  }

  _applyCamera(api) {
    const { name, args } = this._preset
    const focusId = args.focus || this._focusId
    // Prefer an explicit world target (the editor's focal point / orbit pivot)
    // when one is passed, then a focus entity, then the origin.
    let target = { x: 0, y: 0, z: 0, yaw: 0 }
    if (args.target && (args.target.x !== undefined || args.target.y !== undefined || args.target.z !== undefined)) {
      target = { x: args.target.x ?? 0, y: args.target.y ?? 0, z: args.target.z ?? 0, yaw: args.target.yaw ?? 0 }
    } else if (focusId) {
      const rec = api.entity(focusId)
      if (rec) {
        const t = rec.components.transform || rec.components.pos || {}
        target = { x: t.x ?? 0, y: t.y ?? 0, z: t.z ?? 0, yaw: t.yaw ?? 0 }
      }
    }
    const cam = computeCameraPosition(name, target, args)
    // Lateral pan offset (editor camera pan): the camera translates in the view
    // plane AND the look-at point moves by the same offset, so panning STRAfES
    // (keeps the view direction) rather than re-aiming at the focal point (which
    // would make pan behave like an orbit around the focal point). With pan
    // reset (F), the camera looks straight at the focal point again.
    const pan = args.pan || { x: 0, y: 0, z: 0 }
    this.camera.position.set(
      cam.position.x + (pan.x ?? 0),
      cam.position.y + (pan.y ?? 0),
      cam.position.z + (pan.z ?? 0),
    )
    this.camera.lookAt(
      cam.target.x + (pan.x ?? 0),
      cam.target.y + (pan.y ?? 0),
      cam.target.z + (pan.z ?? 0),
    )
  }

  _position(item) {
    // Prefer the resolved world transform (parent chain) when available so a
    // parented entity renders at parent.world + local. Fall back to the
    // entity's local transform component.
    if (this._worldTransforms && this._worldTransforms.has(item.id)) {
      const w = this._worldTransforms.get(item.id)
      return { x: w.x, y: w.y, z: w.z }
    }
    const t = item.transform || {}
    return { x: t.x ?? 0, y: t.y ?? 0, z: t.z ?? 0 }
  }

  /**
   * Resolve per-entity scale (full world-unit box size). Scale lives on the
   * TRANSFORM (the single TRS owner) as `transform.scale` — an array [sx,sy,sz]
   * or object {x,y,z}; a bare number is uniform. Defaults to unit so
   * scale-less entities render as 1×1×1 boxes.
   */
  _scale(item) {
    const t = item.transform || {}
    const s = t.scale
    if (Array.isArray(s)) return { x: s[0] ?? 1, y: s[1] ?? 1, z: s[2] ?? 1 }
    if (typeof s === 'number') return { x: s, y: s, z: s }
    if (s && typeof s === 'object') {
      // A numeric-keyed object {0:x,1:y,2:z} is a scale ARRAY that an old
      // `{...spread}` corrupted into an object. Read it as an array so a
      // saved scene with such data doesn't render at scale 1.
      if (s.x === undefined && (s[0] !== undefined || s[1] !== undefined || s[2] !== undefined)) {
        return { x: s[0] ?? 1, y: s[1] ?? 1, z: s[2] ?? 1 }
      }
      return { x: s.x ?? 1, y: s.y ?? 1, z: s.z ?? 1 }
    }
    return { x: 1, y: 1, z: 1 }
  }

  /**
   * Resolve the entity's transform rotation (radians) as a THREE.Euler. Reads
   * `rot` / `rotation` ({x,y,z}) or legacy `yaw`; defaults to identity so
   * rotation-less entities render unchanged.
   */
  _rotation(item) {
    const t = item.transform || {}
    if (t.rot && typeof t.rot === 'object') return new THREE.Euler(t.rot.x ?? 0, t.rot.y ?? 0, t.rot.z ?? 0)
    if (t.rotation && typeof t.rotation === 'object') return new THREE.Euler(t.rotation.x ?? 0, t.rotation.y ?? 0, t.rotation.z ?? 0)
    if (t.yaw !== undefined) return new THREE.Euler(0, t.yaw, 0)
    return new THREE.Euler(0, 0, 0)
  }

  /**
   * Resolve a material by name from `this._materials`, which may be a plain
   * object (legacy `{ name: THREE.Material }`) OR a Map (the MaterialRegistry's
   * built-material resolver). Map-awareness fixes boxes resolving to default
   * white instead of the registry material. Also consults the per-entity
   * override clone cache so a materialParams-derived clone is found.
   */
  _resolveMaterial(key) {
    const src = this._materials
    if (!src) return undefined
    const direct = (typeof src.get === 'function') ? src.get(key) : src[key]
    if (direct) return direct
    if (this._materialOverrideCache && typeof this._materialOverrideCache.get === 'function') {
      for (const [pkey, mat] of this._materialOverrideCache) {
        if (typeof pkey === 'string' && pkey.startsWith(`${key}\u0000`)) return mat
      }
    }
    return undefined
  }

  /**
   * Resolve a geometry by mesh name, falling back to a shared box. The render
   * primitives (box / cylinder / sphere / plane / pill) produce DISTINCT unit
   * geometry — a cylinder or sphere is not a box in disguise. Each is unit-sized
   * (full size 1 per axis) so `transform.scale` = the visual's full size on every
   * axis, exactly like the box (BoxGeometry(1,1,1) scaled by transform.scale).
   * A cylinder's caps are radius 0.5 and height 1 (diameter 1 in X/Z), a
   * sphere is radius 0.5 (diameter 1), and a plane is a flat 1×1 surface LAID
   * ON THE XZ PLANE (PlaneGeometry(1,1) rotated -90° about X — normal +Y):
   * scale X = width, scale Z = depth, scale Y is ignored (the plane has zero
   * height). Unknown mesh
   * names + the default fall back to a box. Geometry is shared per mesh name
   * (cached), so instanced batches stay cheap.
   */
  _geometry(name) {
    const key = name || '__default__'
    if (this._meshes[key]) return this._meshes[key]
    let g = this._geometryCache.get(key)
    if (!g) {
      if (name === 'cylinder') g = new THREE.CylinderGeometry(0.5, 0.5, 1, 24)
      else if (name === 'sphere') g = new THREE.SphereGeometry(0.5, 20, 14)
      else if (name === 'pill') {
        // UNIT RENDER PILL: CapsuleGeometry(radius, length) where `length` is
        // the mid-section (cylindrical core) length — total height = length +
        // 2×radius. (0.25, 0.5) → Ø0.5 × TOTAL height 1: a visible capsule
        // profile at unit scale. Unlike box/cylinder/sphere this primitive is
        // NOT full-size-1 per axis — scale.y = total height, rendered
        // diameter = 0.5 × scale.x. The catalog's pill entry documents the
        // same unit size; physics shapeFromRender derives the analytic
        // capsule from it (radius = 0.25 × scale.x, total height = scale.y).
        g = new THREE.CapsuleGeometry(0.25, 0.5, 8, 24)
      }
      else if (name === 'plane') {
        // The plane primitive lies flat on the X/Z plane (normal +Y) by
        // DEFAULT — a ground surface, not a standing wall. The rotation is
        // baked into the SHARED geometry (rotateX mutates it once), so every
        // plane entity renders flat and transform.scale.y is a no-op (zero
        // height) while scale.x / scale.z size width / depth.
        g = new THREE.PlaneGeometry(1, 1)
        g.rotateX(-Math.PI / 2)
      }
      else if (name === 'cone') g = new THREE.ConeGeometry(0.5, 1, 24)
      else if (name === 'torus') g = new THREE.TorusGeometry(0.5, 0.15, 16, 48)
      else if (name === 'torusKnot') g = new THREE.TorusKnotGeometry(0.4, 0.13, 100, 16)
      else if (name === 'icosahedron') g = new THREE.IcosahedronGeometry(0.5)
      else if (name === 'dodecahedron') g = new THREE.DodecahedronGeometry(0.5)
      else if (name === 'octahedron') g = new THREE.OctahedronGeometry(0.5)
      else if (name === 'tetrahedron') g = new THREE.TetrahedronGeometry(0.5)
      else if (name === 'ring') {
        g = new THREE.RingGeometry(0.3, 0.5, 32)
        g.rotateX(-Math.PI / 2)
      }
      else if (name === 'circle') {
        g = new THREE.CircleGeometry(0.5, 32)
        g.rotateX(-Math.PI / 2)
      }
      else if (name === 'lathe') {
        // UNIT RENDER LATHE: LatheGeometry spins a 2D profile around +Y, so it
        // stands UPRIGHT (unlike plane/circle/ring which lie flat — no
        // rotateX here). The DEFAULT profile is a gentle column/vase: widening
        // at the base, tapering up. Total height 1, max radius 0.4 (Ø0.8),
        // matching the other primitives' ~Ø1 footprint. 32 radial segments for
        // a smooth rotational silhouette.
        const profile = [
          new THREE.Vector2(0.35, 0),
          new THREE.Vector2(0.4, 0.2),
          new THREE.Vector2(0.3, 0.5),
          new THREE.Vector2(0.22, 0.75),
          new THREE.Vector2(0.18, 1),
        ]
        g = new THREE.LatheGeometry(profile, 32)
      }
      else g = new THREE.BoxGeometry(1, 1, 1) // box + unknown fallback
      this._geometryCache.set(key, g)
    }
    return g
  }

  /**
   * Emit a diagnostic (to onDiagnostic, else console) — NEVER silent. Deduped
   * per message so a per-frame resolution failure can't flood the console.
   */
  _emit(level, message) {
    if (this.onDiagnostic) { try { this.onDiagnostic({ level, message }) } catch { /* host hook must not break rendering */ } }
    else if (level === 'error') console.error(`[render] ${message}`)
    else console.warn(`[render] ${message}`)
  }

  /** Report (once per name) that a named material failed to resolve. */
  _reportMissingMaterial(name) {
    const key = name || '__default__'
    if (key === '__default__' || this._missingMaterials.has(key)) return
    this._missingMaterials.add(key)
    this._emit('error', `material "${name}" is referenced by an entity but is not defined (scene.materials / assets/materials). Rendering the default white material — this is a data error, not a look choice.`)
  }

  /**
   * Resolve a material by name, falling back to a shared standard material.
   * When `params` (a per-entity materialParams override) is present, returns a
   * clone of the named material with those params applied, cached by
   * name+params so identical overrides share one material (and one batch).
   */
  _material(name, params) {
    const key = name || '__default__'
    if (!params) {
      const found = this._resolveMaterial(key)
      if (found) return found
      // Named material missing -> LOUD (surface in the console), then fall
      // back only so a data typo can't blank the whole scene.
      if (name) this._reportMissingMaterial(name)
      if (!this._defaultMaterial) {
        this._defaultMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff })
      }
      return this._defaultMaterial
    }
    const pkey = `${key}\u0000${paramsKey(params)}`
    if (!this._materialOverrideCache) this._materialOverrideCache = new Map()
    const cached = this._materialOverrideCache.get(pkey)
    if (cached) return cached
    const base = this._material(name)
    const clone = base.clone()
    if (params.color !== undefined) clone.color = new THREE.Color(params.color)
    if (params.roughness !== undefined && clone.roughness !== undefined) clone.roughness = params.roughness
    if (params.metalness !== undefined && clone.metalness !== undefined) clone.metalness = params.metalness
    if (params.emissive !== undefined && clone.emissive) {
      clone.emissive = new THREE.Color(params.emissive)
      if (params.emissiveIntensity !== undefined) clone.emissiveIntensity = params.emissiveIntensity
    }
    clone.needsUpdate = true
    this._materialOverrideCache.set(pkey, clone)
    return clone
  }

  /**
   * Tear down any batched InstancedMesh whose material is `name`, so the next
   * render rebuilds it from the CURRENT resolver map (used after a material's
   * TYPE changes and the built material was replaced, not mutated). Editing
   * color/roughness/etc. within the same type mutates the material in place and
   * needs NO re-batch — the batch key (the name) is unchanged.
   * @param {string} name
   */
  rebuildMaterialBatches(name) {
    for (const [key, inst] of this._batches) {
      // Batch keys are `<mesh>|<material>` (optionally `|p:<params>` for
      // per-entity overrides). Rebuild only the plain-name batches; override
      // clones are re-derived lazily via _material.
      if (key.endsWith(`|${name}`)) {
        this.scene.remove(inst)
        this._batches.delete(key)
      }
    }
    return this
  }
}

/**
 * Deterministic key for a materialParams object (sorted keys) so identical
 * override objects share a cached material.
 */
function paramsKey(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return `[${obj.map(paramsKey).join(',')}]`
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${paramsKey(obj[k])}`).join(',')}}`
}

/** Smallest power of two >= n. */
function nextPow2(n) {
  let p = 1
  while (p < n) p *= 2
  return p
}

/**
 * Extract a model's LOCAL-frame triangle list. Traverses every mesh, reads its
 * position attribute (+ index), and transforms the vertices into the model
 * ROOT's frame (so the triangles are entity-local and independent of any parent
 * placement). Used by the physics collider's `'render'` shape to carry the real
 * mesh geometry. For skinned meshes this reads the bind pose (static collision
 * — animations are not deformable colliders). Returns `[]` if no meshes.
 */
function extractModelTriangles(model) {
  const out = []
  if (!model) return out
  try {
    model.updateWorldMatrix(true, false)
    const rootInv = new THREE.Matrix4().copy(model.matrixWorld).invert()
    const tmpM = new THREE.Matrix4()
    const v = new THREE.Vector3()
    model.traverse((o) => {
      if (!o.isMesh || !o.geometry) return
      const pos = o.geometry.getAttribute('position')
      if (!pos) return
      const index = o.geometry.getIndex()
      tmpM.multiplyMatrices(rootInv, o.matrixWorld)
      const vert = (i) => { v.fromBufferAttribute(pos, i).applyMatrix4(tmpM); return { x: v.x, y: v.y, z: v.z } }
      const push = (a, b, c) => out.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, cx: c.x, cy: c.y, cz: c.z })
      if (index) {
        for (let i = 0; i + 2 < index.count; i += 3) push(vert(index.getX(i)), vert(index.getX(i + 1)), vert(index.getX(i + 2)))
      } else {
        for (let i = 0; i + 2 < pos.count; i += 3) push(vert(i), vert(i + 1), vert(i + 2))
      }
    })
  } catch (err) { /* return whatever we gathered */ }
  return out
}

/**
 * Extract a BufferGeometry's triangle list (unit primitive geometry —
 * box/cylinder/sphere/plane — in its own frame, unindexed or indexed). Used
 * by `primitiveMesh()` so the physics 'render' collider derives from the
 * SAME geometry the renderer draws (the 'match render mesh' one-math-source
 * contract). Returns `[]` if the geometry has no position attribute.
 */
function extractGeometryTriangles(g) {
  const out = []
  if (!g || !g.getAttribute) return out
  const pos = g.getAttribute('position')
  if (!pos) return out
  const index = g.getIndex()
  // One FRESH vertex object per read — a shared scratch object would alias:
  // push(vert(i), vert(i+1), vert(i+2)) evaluates all three before the call
  // body runs, so a mutated shared object would make every corner the LAST
  // vertex (collapsed triangles, poles lost).
  const vert = (i) => ({ x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) })
  const push = (a, b, c) => out.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, cx: c.x, cy: c.y, cz: c.z })
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) push(vert(index.getX(i)), vert(index.getX(i + 1)), vert(index.getX(i + 2)))
  } else {
    for (let i = 0; i + 2 < pos.count; i += 3) push(vert(i), vert(i + 1), vert(i + 2))
  }
  return out
}
