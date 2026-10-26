/**
 * createGame — the public game entry point (FOUNDATION-PLAN.md §6).
 *
 * The game is renderer-agnostic where possible: gameplay logic runs on a
 * fixed-timestep simulation over a World hydrated from a scene. The renderer,
 * audio, and effects are wired separately by the host (browser) through the
 * returned api; in a headless test the sim can be stepped with game.step(dt)
 * and no canvas/audio is touched.
 *
 * createGame never throws synchronously on scene problems — errors are
 * collected and exposed via game.errors and a "crashed" state, per the crash
 * boundary contract.
 */
import { GameLoop } from './game-loop.js'
import { World } from './ecs.js'
import { SceneBuilder, validateScene, migrateScene, resolveLayers, resolveTags } from '../scene/scene.js'
import { normalizeAnimOptions } from '../render/animation.js'
import { normalizeLayers } from '../physics/layers.js'
import { ScriptRegistry, runScripts, createScriptsApi } from './scripts.js'
import { SystemRegistry, runSystems, createSystemsApi } from './systems.js'
import { MaterialRegistry, createMaterialsApi } from '../render/materials.js'
import { ShaderRegistry, createShadersApi } from '../render/shaders.js'
import { UI_WIDGET_TYPES } from '../render/ui-schema.js'
import { createController } from './controller.js'
import { ComponentRegistry, createComponentsApi, BUILTIN_COMPONENTS } from '../components/index.js'
import { BUILTIN_SCRIPTS, resetActiveRig, resetEmitterState, resetUnknownModeWarnings, resetNavAgentState } from '../scripts/builtins.js'
import { resetFlockState } from '../scripts/flock.js'
import { BUILTIN_FLOCK_SYSTEMS } from '../systems/flock.js'
import { BUILTIN_CLOUD_SYSTEMS } from '../systems/volumetric-cloud.js'
import { BUILTIN_NAV_AGENT_SYSTEMS } from '../systems/nav-agent.js'
import { PHYSICS_BUILTIN_SCRIPTS } from '../physics/system.js'
import { createPhysicsApi } from '../physics/system.js'
import { createNav } from '../nav/nav.js'
import { groundAnchorLocalY, placeY, shapeTopAtY } from '../physics/placement.js'
import { frameProfiler } from '../telemetry/frame-profiler.js'

export class Game {
  /**
   * @param {object} opts
   * @param {object} opts.scene       the scene JSON (already validated/migrated by caller or here)
   * @param {Function} [opts.onStep]  (dt, api) => void — gameplay update per fixed step
   * @param {Function} [opts.onFrame] (api, loop) => void — render/frame hook (browser)
   * @param {object} [opts.archetypes]  map for SceneBuilder.resolveArchetype
   * @param {object} [opts.scripts]   map of named gameplay scripts (see ScriptRegistry.register)
   * @param {object} [opts.systems]   map of named global systems (see SystemRegistry.register)
   * @param {object} [opts.components] map/array of game-local component METAS
   *                                   ({ name, label?, description?, params? }) to register
   *                                   so they surface in the editor (pure metadata, no behavior)
   * @param {object} [opts.camera]    optional camera handle: { setPreset, setFocus, setActive }
   *                                  (exposed as api.camera; drives camera-rig built-in)
   * @param {object} [opts.audio]     optional audio handle: { has, play, playLoop, stopLoop,
   *                                  stopAllLoops, setEnabled } (exposed as api.audio;
   *                                  drives audio-emitter built-in)
   * @param {Array<Function>} [opts.migrations]  applied to scene before hydration
   * @param {number} [opts.fixedDt=1/60]
   */
  constructor({
    scene,
    onStep,
    onFrame,
    archetypes = {},
    scripts = {},
    systems = {},
    materials,
    shaders,
    components,
    camera,
    audio,
    nav,
    migrations = [],
    fixedDt = 1 / 60,
  } = {}) {
    if (scene === undefined) throw new TypeError('createGame requires a scene')
    this.fixedDt = fixedDt
    this._onStep = onStep
    this._onFrame = onFrame
    this._archetypes = archetypes
    this._camera = camera
    this._audio = audio

    // Gameplay script registry + per-entity dispatch lifecycle state. Engine
    // built-in tools (camera-rig, audio-emitter, dynamic-body) are auto-registered;
    // the host may override them by name.
    this._scriptRegistry = new ScriptRegistry()
    const allScripts = { ...BUILTIN_SCRIPTS, ...PHYSICS_BUILTIN_SCRIPTS, ...(scripts || {}) }
    for (const [name, def] of Object.entries(allScripts)) {
      this._scriptRegistry.register(name, def)
    }
    this._scriptAttached = new Map()

    // Global system registry (scene-level behaviors, mirror of the script
    // registry). The scene's `systems` list drives per-frame dispatch. The
    // engine's built-in `flock` system is auto-registered so any game can use
    // it with no copied files; the host may override it by name.
    this._systemRegistry = new SystemRegistry()
    try { this._systemRegistry.register('flock', BUILTIN_FLOCK_SYSTEMS.flock) } catch { /* ignore */ }
    try { this._systemRegistry.register('nav-agent', BUILTIN_NAV_AGENT_SYSTEMS['nav-agent']) } catch { /* ignore */ }
    try { this._systemRegistry.register('volumetric-cloud', BUILTIN_CLOUD_SYSTEMS['volumetric-cloud']) } catch { /* ignore */ }
    for (const [name, def] of Object.entries(systems || {})) {
      try { this._systemRegistry.register(name, def) } catch { /* skip a duplicate/invalid system */ }
    }
    this._systemAttached = new Map()

    // Component-metadata registry (mirror of ScriptRegistry, pure metadata —
    // no behavior). Seeded with the engine built-ins so api.components
    // reflects the full attachable surface; the host may register game-local
    // component metas ({ name, label?, description?, params? }) so they surface
    // in the editor without becoming engine built-ins.
    this._componentRegistry = new ComponentRegistry({ metas: BUILTIN_COMPONENTS })
    if (components) {
      const list = Array.isArray(components) ? components : Object.values(components)
      for (const meta of list) {
        if (meta && typeof meta.name === 'string') {
          try { this._componentRegistry.register(meta.name, meta) }
          catch { /* skip a duplicate/invalid meta */ }
        }
      }
    }

    // Apply migrations, then hydrate through the same path the runtime uses.
    const { scene: migrated } = migrateScene(scene, migrations)
    this.scene = migrated

    // Registry-seeding failures (an invalid material/shader def) are reported
    // here and merged into game.errors below — NEVER a silent skip (the old
    // `catch { /* skip invalid def */ }` hid exactly the data errors the
    // never-silent doctrine exists to surface; game.errors is the report path
    // the PLAY CONSOLE reads via `__boot.errors`).
    const seedErrors = []

    // Shader registry (custom shaders, RENDERING-PIPELINE.md §R3). Accepts a
    // prebuilt ShaderRegistry (the editor shares one) or a plain { name: def }
    // map. Custom materials reference shaders by name via this registry.
    this._shaderRegistry = shaders instanceof ShaderRegistry
      ? shaders
      : new ShaderRegistry()
    if (shaders && !(shaders instanceof ShaderRegistry) && typeof shaders === 'object') {
      for (const [name, def] of Object.entries(shaders)) {
        try { this._shaderRegistry.register(name, def) }
        catch (err) { seedErrors.push(`shader "${name}": invalid def — ${String((err && err.message) || err)}`) }
      }
    }

    // Material registry (data-driven materials, RENDERING-PIPELINE.md §R1).
    // Accepts a prebuilt MaterialRegistry (the editor shares its registry with
    // the renderer), a plain { name: def } map, or nothing. The scene's
    // `materials` map is ALWAYS seeded (data-driven) and overrides any defaults
    // the host pre-seeded by name. Exposed as api.materials (mirror of
    // api.scripts/api.systems). Custom (shader) materials resolve their
    // `shader` via the shader registry above.
    this._materialRegistry = materials instanceof MaterialRegistry
      ? materials
      : new MaterialRegistry({ shaders: this._shaderRegistry })
    if (materials && !(materials instanceof MaterialRegistry) && typeof materials === 'object') {
      for (const [name, def] of Object.entries(materials)) {
        try { this._materialRegistry.register(name, def) }
        catch (err) { seedErrors.push(`material "${name}": invalid def — ${String((err && err.message) || err)}`) }
      }
    }
    if (migrated.materials && typeof migrated.materials === 'object' && !Array.isArray(migrated.materials)) {
      for (const [name, def] of Object.entries(migrated.materials)) {
        try { this._materialRegistry.register(name, def) }
        catch (err) { seedErrors.push(`material "${name}": invalid def — ${String((err && err.message) || err)}`) }
      }
    }

    const builder = new SceneBuilder({ resolveArchetype: (id) => archetypes[id] })
    const { entities, errors } = builder.hydrate(migrated)

    this.world = new World()
    this.world.setLayers(migrated.layers)
    this.errors = [...validateScene(migrated), ...errors, ...seedErrors]
    for (const e of entities) {
      try {
        this.world.spawn({ id: e.id, name: e.id, parent: e.parent, layer: e.layer, tags: e.tags, components: e.components })
      } catch (err) {
        this.errors.push(String(err && err.message || err))
      }
    }

    // World physics surface: settings live in scene.physics (only when the
    // scene declares one); otherwise a private defaults object. Exposed as
    // api.physics + driving dynamic-body. We do NOT inject scene.physics here —
    // that would mark a clean scene dirty on load.
    const physicsSettings = (migrated.physics && typeof migrated.physics === 'object' && !Array.isArray(migrated.physics))
      ? migrated.physics
      : {}
    this._physicsApi = createPhysicsApi({ world: this.world, settings: physicsSettings })
    // The object api.physics mutates (its `settings`); the editor tool adopts it
    // into scene.physics on write so edits persist.
    this._physicsSettings = physicsSettings

    // P2-N1 nav handle (grid + A* over nav-obstacle colliders). Requested via
    // createGame({ nav: true | config }); scene.nav is the authoring truth and
    // the option merges over it. Rebuild is MANUAL (api.nav.rebuild()); a
    // loadScene scene swap rebinds the handle to the new world (see loadScene).
    this._navOverride = nav
    this._nav = nav ? createNav({ world: this.world, scene: migrated, nav }) : null

    this._crashed = false
    this._lastError = null
    this._state = {}
    // Animation events (AN1): handlers registered via api.onAnimEvent, plus a
    // per-entity pending queue the Renderer pushes crossings into each frame
    // and the `anim-events` built-in script drains (declarative audio).
    this._animEventHandlers = new Set()
    this._animEventQueue = new Map()
    // Blend-tree params (BT2): entity id -> Map(name -> finite number), the
    // per-frame gameplay state api.setAnimParam writes and the renderer's
    // tree path reads each step (velX/velY/speed — runtime state, NOT scene
    // data). Cleared on scene load and per entity on renderer disposal.
    this._animParams = new Map()
    this._loop = new GameLoop({ fixedDt, update: (dt) => this._step(dt) })
    this._controller = createController({ game: this })
    this._runReset = null
    this._director = null
  }

  /** First-class deterministic test/scrub seam (backlog K). See controller.js. */
  get controller() {
    return this._controller
  }

  /**
   * Runtime archetype instantiation (see api.spawnArchetype). Hydrates ONE
   * instance through SceneBuilder — the same merge/children/placement path
   * scene load takes — then spawns every hydrated record into the world. The
   * root entity carries `archetypeId`; its placement override is the caller's
   * `transform` (world values, replace-over-defaults per the placement
   * doctrine). Returns the root id, or null when the archetype is unknown or
   * failed to hydrate (spawn stays silent; gameplay degrades gracefully).
   * @param {string} archetypeId
   * @param {{ id?: string, parent?: string, transform?: object }} [opts]
   * @returns {string|null} the root entity id.
   */
  spawnArchetypeInstance(archetypeId, { id, parent, transform } = {}) {
    if (!this._archetypes || typeof archetypeId !== 'string' || archetypeId === '') return null
    if (!this._archetypes[archetypeId]) return null
    // An explicit root id is REQUIRED (children hydrate as `<id>_<childName>`,
    // so an anonymous root cannot be instantiated).
    if (typeof id !== 'string' || id === '') return null
    const inst = { id, archetypeId }
    if (typeof parent === 'string' && parent !== '') inst.parent = parent
    if (transform && typeof transform === 'object') {
      inst.overrides = { components: { transform: { ...transform } } }
    }
    const builder = new SceneBuilder({ resolveArchetype: (a) => this._archetypes?.[a] })
    let out
    try {
      out = builder.instantiate(inst)
    } catch {
      return null
    }
    if (!out || out.errors.length > 0 || out.entities.length === 0) return null
    for (const e of out.entities) {
      this.world.spawn({
        id: e.id,
        name: e.name || e.id,
        parent: e.parent,
        tags: e.tags,
        components: e.components,
        ...(e === out.entities[0] ? { archetypeId } : {}),
      })
    }
    return out.entities[0].id
  }


  /** Structured crash info, or null if healthy. */
  get crashed() {
    return this._crashed ? { error: this._lastError, sceneVersion: this.scene?.version, lastInputFrames: [] } : null
  }

  /** True if the scene hydrated without errors. */
  get valid() {
    return this.errors.length === 0
  }

  /** The public facade: gameplay logic reads/writes through api. */
  get api() {
    return {
      world: this.world,
      // Model measurement for gameplay scripts (ONE math source with the
      // renderer): the host renderer wires `_modelBoundsResolver` (see
      // Renderer.render), and scripts read the measured model bbox by logical
      // name — e.g. the flock script derives each fish's collider from it.
      // Null until the renderer has measured the model.
      modelBounds: (name) => (typeof this._modelBoundsResolver === 'function' ? this._modelBoundsResolver(name) : null),
      setModelBoundsResolver: (fn) => {
        this._modelBoundsResolver = typeof fn === 'function' ? fn : null
      },
      spawn: (id, opts) => this.world.spawn(opts ? { id, ...opts } : { id }),
      // ARCHETYPE-FIRST spawning: instantiate an authored archetype at runtime
      // through the SAME hydration path scene load uses (SceneBuilder) — the
      // spawned root is an archetype INSTANCE (entity record carries
      // `archetypeId`), hydration supplies the declared components (render
      // scale + authored collider included), and the caller's `transform`
      // override is the placement. Returns the root entity id, or null when
      // the archetype is unknown / fails to hydrate (never a crash).
      spawnArchetype: (archetypeId, opts) => this.spawnArchetypeInstance(archetypeId, opts),
      entity: (id) => this.world.entity(id),
      query: (q) => this.world.query(q),
      addComponent: (id, type, data) => this.world.setComponent(id, type, data),
      removeComponent: (id, type) => this.world.removeComponent(id, type),
      getParent: (id) => this.world.getParent(id),
      setParent: (id, parent) => this.world.setParent(id, parent),
      getLayer: (id) => this.world.getLayer(id),
      setLayer: (id, layer) => this.world.setLayer(id, layer),
      getTags: (id) => this.world.getTags(id),
      setTags: (id, tags) => this.world.setTags(id, tags),
      addTag: (id, tag) => this.world.addTag(id, tag),
      removeTag: (id, tag) => this.world.removeTag(id, tag),
      hasTag: (id, tag) => this.world.hasTag(id, tag),
      // O1 read-seam: fixed-step loop stats (pure read).
      getLoopStats: () => this._loop.stats(),
      getLayers: () => resolveLayers(this.scene),
      setLayers: (layers) => {
        if (Array.isArray(layers) && layers.length > 0) this.scene.layers = layers
        else delete this.scene.layers
        return this.world.setLayers(this.scene.layers)
      },
      getPhysicsLayers: () => (this.scene.physics && this.scene.physics.layers) || null,
      setPhysicsLayers: (block) => {
        if (block === undefined || block === null) {
          if (this.scene.physics) delete this.scene.physics.layers
          return null
        }
        const norm = normalizeLayers(block)
        if (!this.scene.physics) this.scene.physics = {}
        this.scene.physics.layers = norm
        return this.scene.physics.layers
      },
      getSceneTags: () => resolveTags(this.scene),
      setSceneTags: (tags) => {
        if (Array.isArray(tags) && tags.length > 0) this.scene.tags = tags
        else delete this.scene.tags
      },
      scripts: createScriptsApi(this._scriptRegistry, () => this.api),
      systems: createSystemsApi(this._systemRegistry),
      materials: createMaterialsApi(this._materialRegistry),
      shaders: createShadersApi(this._shaderRegistry),
      components: createComponentsApi(this._componentRegistry),
      camera: this._camera,
      audio: this._audio,
      nav: this._nav,
      physics: this._physicsApi,
      // Rigid-body velocity verbs, hoisted onto the top-level api for
      // ergonomics (the AI recipe reads `api.getVelocity(...)` — they
      // delegate to the physics handle).
      applyForce: (id, f) => this._physicsApi.applyForce(id, f),
      applyImpulse: (id, j) => this._physicsApi.applyImpulse(id, j),
      setVelocity: (id, v) => this._physicsApi.setVelocity(id, v),
      getVelocity: (id) => this._physicsApi.getVelocity(id),
      addVelocity: (id, d) => this._physicsApi.addVelocity(id, d),
      // P2 angular verbs, hoisted like the velocity verbs above.
      applyTorque: (id, t) => this._physicsApi.applyTorque(id, t),
      applyTorqueImpulse: (id, l) => this._physicsApi.applyTorqueImpulse(id, l),
      setAngularVelocity: (id, w) => this._physicsApi.setAngularVelocity(id, w),
      getAngularVelocity: (id) => this._physicsApi.getAngularVelocity(id),
      /**
       * Place `id` so its GROUND point rests on a surface — the AI/author-facing
       * verb. The AI never does offset math.
       *   place(id, { x, z })                        -> rests groundY on world y=0
       *   place(id, { x, z, surfaceY: 3 })           -> rests on a world Y
       *   place(id, { x, z, on: floorEntityId })     -> rests on that entity's top
       * x/z are LOCAL transform coords. groundY declared on the `placement`
       * component wins; else a primitive collider self-grounds (geometry); else
       * the origin rests on the surface. Sets transform.x/y/z. Returns a result.
       */
      place: (id, opts = {}) => this._place(id, opts),
      // UI runtime (WS3-Pro): update a WIDGET entity live. `id` is the widget
      // entity id. The patch is merged into the entity's widget component (a
      // `text`/`bar`/`shape`/... field like `string`/`value`/`color`); rect
      // fields (x/y/w/h/anchorX/anchorY) are routed into the `rect` component.
      // The Renderer's per-frame reconcile picks the change up. Returns true if
      // the entity is a widget.
      hud: {
        set: (id, patch) => {
          const rec = this.world.entity(id)
          if (!rec || !rec.components) return false
          const comps = rec.components
          const wtype = UI_WIDGET_TYPES.find((t) => comps[t])
          if (!wtype) return false
          const RECT_FIELDS = ['x', 'y', 'w', 'h', 'anchorX', 'anchorY']
          const widgetPatch = {}
          const rectPatch = {}
          for (const [k, v] of Object.entries(patch || {})) {
            if (RECT_FIELDS.includes(k)) rectPatch[k] = v
            else widgetPatch[k] = v
          }
          if (Object.keys(widgetPatch).length > 0) {
            this.world.setComponent(id, wtype, { ...comps[wtype], ...widgetPatch })
          }
          if (Object.keys(rectPatch).length > 0) {
            this.world.setComponent(id, 'rect', { ...(comps.rect || {}), ...rectPatch })
          }
          return true
        },
        get: (id) => {
          const rec = this.world.entity(id)
          if (!rec || !rec.components) return null
          const comps = rec.components
          const wtype = UI_WIDGET_TYPES.find((t) => comps[t])
          if (!wtype) return null
          return { ...comps[wtype], ...(comps.rect || {}), id, type: wtype }
        },
      },
      playAnimation: (entityId, clipName, opts = {}) => {
        const { loop, playbackRate, fadeDuration } = normalizeAnimOptions(opts)
        const existing = this.world.entity(entityId)?.components?.playback || {}
        this.world.setComponent(entityId, 'playback', {
          ...existing,
          clip: clipName,
          loop,
          playbackRate,
          fade: fadeDuration,
          playing: true,
        })
      },
      stopAnimation: (entityId) => {
        const existing = this.world.entity(entityId)?.components?.playback
        if (existing) {
          this.world.setComponent(entityId, 'playback', { ...existing, playing: false })
        }
      },
      /**
       * Blend-tree param write (BT2): the driver verb. Stores a per-entity
       * RUNTIME param (e.g. 'velX'/'velY'/'speed') that the renderer's
       * tree path reads each step to evaluate the blend space — pure
       * per-frame gameplay state (ECS-adjacent), NOT scene data. Non-finite
       * values warn + are ignored (never crash, never poison the blend).
       * Returns true when the value was stored.
       */
      setAnimParam: (entityId, name, value) => {
        if (typeof name !== 'string' || !name) {
          console.warn(`[anim-params] setAnimParam: param name must be a non-empty string for entity "${entityId}" — ignored`)
          return false
        }
        // Strict: only real finite numbers (a numeric string would mask a
        // script bug upstream — make the caller coerce deliberately).
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          console.warn(`[anim-params] setAnimParam: value for "${name}" on entity "${entityId}" is not a finite number — ignored`)
          return false
        }
        let m = this._animParams.get(entityId)
        if (!m) {
          m = new Map()
          this._animParams.set(entityId, m)
        }
        m.set(name, value)
        return true
      },
      /** Read one blend-tree param (BT2): undefined when never set. */
      getAnimParam: (entityId, name) => {
        const m = this._animParams.get(entityId)
        return m && m.has(name) ? m.get(name) : undefined
      },
      /**
       * Scrub preview (AN2): pose the entity's model at clip time `t` without
       * advancing playback or firing animation events — the renderer-side
       * `previewAnimationTime` (see Renderer). Editor-only authoring surface:
       * the Animation panel's time scrub drives it per input; the paused pose
       * never crosses an event and never advances the playhead. No model or no
       * resolvable clip → warn + no-op (never throws).
       */
      previewAnimTime: (entityId, t) => {
        if (this._renderer && typeof this._renderer.previewAnimationTime === 'function') {
          this._renderer.previewAnimationTime(entityId, t)
        }
      },
      /**
       * Register an animation-event handler (AN1). The Renderer dispatches
       * `{ entityId, name, t }` per crossing each sim step: `entityId` is the
       * animated entity, `name` the event's authored name, `t` its clip time.
       * Returns an unregister closure. Handler errors are caught + warned,
       * never crash the frame. Note: the anim-events built-in script consumes
       * the same crossings declaratively via `params.map`; handlers fire for
       * EVERY entity regardless of which scripts it carries.
       */
      onAnimEvent: (fn) => {
        if (typeof fn !== 'function') return () => {}
        this._animEventHandlers.add(fn)
        return () => this._animEventHandlers.delete(fn)
      },
      /**
       * Animation-event plumbing (AN1). The Renderer emits crossings per
       * entity per sim step into the pending queue; the `anim-events`
       * built-in script drains it. `emit` also notifies api.onAnimEvent
       * handlers (one source, two consumers). `take(id)` drains + clears.
       */
      animEvents: {
        emit: (id, events) => {
          if (!Array.isArray(events) || events.length === 0) return
          const list = this._animEventQueue.get(id) || []
          for (const ev of events) {
            if (ev && typeof ev.name === 'string' && Number.isFinite(ev.t)) list.push({ name: ev.name, t: ev.t })
          }
          if (list.length > 0) this._animEventQueue.set(id, list)
          for (const fn of this._animEventHandlers) {
            for (const ev of events) {
              if (!ev || typeof ev.name !== 'string' || !Number.isFinite(ev.t)) continue
              try { fn({ entityId: id, name: ev.name, t: ev.t }) }
              catch (err) { console.warn(`[anim-events] handler error: ${err && err.message || err}`) }
            }
          }
        },
        take: (id) => {
          const list = this._animEventQueue.get(id)
          if (!list || list.length === 0) return []
          this._animEventQueue.delete(id)
          return list
        },
        /** Drop one entity's pending crossings (renderer disposal path). */
        clear: (id) => { this._animEventQueue.delete(id) },
      },
      /**
       * Blend-tree param plumbing (BT2). The renderer's tree path reads the
       * entity's name -> value map per step via `get(id)`; `clear(id)` drops
       * one entity's params (renderer disposal path — symmetric to
       * animEvents.clear). Values are written via api.setAnimParam.
       */
      animParams: {
        get: (id) => this._animParams.get(id) || null,
        clear: (id) => { this._animParams.delete(id) },
      },
      state: {
        get: () => this._state,
        set: (next) => { this._state = next },
      },
      controller: this._controller,
      loadScene: (scene, opts) => this.loadScene(scene, opts),
    }
  }

  /** World-space {x,y,z} contributed by id's PARENT chain only (self excluded). */
  _chainWorld(id) {
    let x = 0, y = 0, z = 0
    const seen = new Set()
    let cur = typeof this.world.getParent === 'function' ? this.world.getParent(id) : undefined
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const rec = this.world.entity(cur)
      const t = rec && rec.components && rec.components.transform
      x += t && t.x ? t.x : 0
      y += t && t.y ? t.y : 0
      z += t && t.z ? t.z : 0
      const parent = typeof this.world.getParent === 'function' ? this.world.getParent(cur) : undefined
      if (parent === undefined || parent === null || parent === cur) break
      cur = parent
    }
    return { x, y, z }
  }

  /** Implementation of api.place(id, opts). See the verb doc for semantics. */
  _place(id, opts = {}) {
    const rec = this.world.entity(id)
    if (!rec || !rec.components) return { ok: false, reason: 'no-entity' }
    const t = rec.components.transform
    if (!t) return { ok: false, reason: 'no-transform' }
    const { x, z, surfaceY, on } = opts
    const fx = typeof x === 'number' ? x : 0
    const fz = typeof z === 'number' ? z : 0
    // World position target (parent chain of id, excluding self).
    const base = this._chainWorld(id)
    const worldX = base.x + fx
    const worldZ = base.z + fz

    // 1. Resolve the anchor (declared groundY -> geometry fallback -> null).
    const anchor = groundAnchorLocalY(rec.components)

    // 2. Resolve the surface world Y: explicit surfaceY > on-entity top > 0.
    let sy = surfaceY
    if (sy === undefined) {
      if (on !== undefined && on !== null) {
        if (on === id) return { ok: false, reason: 'self-on' }
        const sshape = this._physicsApi && this._physicsApi.shape ? this._physicsApi.shape(on) : null
        sy = sshape ? shapeTopAtY(sshape, worldX, worldZ) : null
        if (sy === null) return { ok: false, reason: 'surface-unsupported-or-miss' }
      } else {
        sy = 0
      }
    }
    sy = Number(sy)
    if (!Number.isFinite(sy)) return { ok: false, reason: 'bad-surfaceY' }

    // 3. Compute the local transform.y and write transform.
    const y = anchor !== null
      ? placeY({ anchor, surfaceTopY: sy, parentWorldY: base.y })
      : sy - base.y   // no declared ground & no primitive geometry: origin rests on surface
    t.x = fx
    t.y = y
    t.z = fz
    return { ok: true, id, x: fx, y, z: fz, anchor, surfaceTopY: sy }
  }

  /**
   * Advance the simulation by a wall-clock delta (runs 0..N fixed steps).
   * Also opens the profiler's frame window (frame.total ends at frame()) —
   * a no-op while profiling is off.
   * @returns {{ steps: number, alpha: number, crashed: boolean }}
   */
  step(dt) {
    frameProfiler.frameBegin()
    const r = this._loop.update(dt)
    return { ...r, crashed: this._crashed }
  }

  _step(dt) {
    // P1 frame-budget instrumentation: sim.step accumulates across catch-up
    // steps within one frame; sub-buckets (sim.onStep / sim.system.<name> /
    // sim.script.<name> / sim.physics) nest inside it. All begin/end calls are
    // no-ops while the profiler is disabled (frame-profiler.js cost model).
    frameProfiler.begin('sim.step')
    try {
      if (this._onStep) {
        frameProfiler.begin('sim.onStep')
        try { this._onStep(dt, this.api) } finally { frameProfiler.end('sim.onStep') }
      }
    } catch (err) {
      this._crashed = true
      this._lastError = String(err && err.stack || err)
    }
    // P2-N4a dynamic nav: feed sim time to the nav handle ONLY when the scene
    // config DECLARED `autoRebuild` — zero per-step cost otherwise (the P2-N1
    // no-auto-rebuild guard stands for everything else).
    try {
      if (this._nav && this._nav.autoRebuildEnabled()) this._nav.autoTick(dt)
    } catch (err) {
      this._crashed = true
      this._lastError = String(err && err.stack || err)
    }
    // Dispatch global systems (the scene's `systems` list, in declared order)
    // BEFORE per-entity scripts so a system can write state the scripts read
    // the same frame. System errors never crash the game.
    try {
      runSystems(this._systemRegistry, this.api, dt, this.scene.systems, this._systemAttached, frameProfiler)
    } catch (err) {
      this._crashed = true
      this._lastError = String(err && err.stack || err)
    }
    // Dispatch per-entity gameplay scripts after systems so scripts see the
    // frame's updated state. Script errors never crash the game.
    try {
      runScripts(this._scriptRegistry, this.api, dt, this._scriptAttached, frameProfiler)
    } catch (err) {
      this._crashed = true
      this._lastError = String(err && err.stack || err)
    }
    // Physics pipeline (P1): ONE authoritative rigid-body integration per
    // fixed step, after gameplay had its say (forces applied this step are
    // consumed here). Own crash boundary — physics errors never kill the game.
    try {
      if (this._physicsApi && typeof this._physicsApi.step === 'function') {
        frameProfiler.begin('sim.physics')
        try { this._physicsApi.step(dt) } finally { frameProfiler.end('sim.physics') }
      }
    } catch (err) {
      this._crashed = true
      this._lastError = String(err && err.stack || err)
    }
    frameProfiler.end('sim.step')
  }

  /** Render/frame hook for the host (browser). Calls onFrame if set. */
  frame() {
    // Closes the profiler frame window opened by step() — frame.total spans
    // the host's whole step()+frame() tick (sim + render CPU).
    try {
      if (this._onFrame) this._onFrame(this.api, this._loop)
    } finally {
      frameProfiler.frameEnd()
    }
  }

  /**
   * Load a new scene (hot reload). Replaces the world. With { hot: true } the
   * engine stays alive and entity ids are stable; without it this is a fresh
   * build. Returns the new World.
   * @param {object} scene  scene JSON
   * @param {{ hot?: boolean }} [opts]
   * @returns {World}
   */
  loadScene(scene, { hot = false } = {}) {
    const builder = new SceneBuilder({ resolveArchetype: (id) => this._archetypes?.[id] })
    const { entities, errors } = builder.hydrate(scene)
    this.errors = [...validateScene(scene), ...errors]
    this.scene = scene
    // The incoming scene's `materials` map seeds/overrides the registry (same
    // rule as the constructor): scene data wins over previously-registered
    // defaults, so a hot scene swap re-points materials exactly like a fresh
    // boot would. Without this, entities referencing the NEW scene's materials
    // resolve to the default white (registry only knew the OLD scene's names).
    if (scene.materials && typeof scene.materials === 'object' && !Array.isArray(scene.materials)) {
      for (const [name, def] of Object.entries(scene.materials)) {
        // NEVER silent: a rejected def is reported like any scene error (this.errors
        // was just rebuilt above) instead of vanishing into a bare catch.
        try { this._materialRegistry.register(name, def) }
        catch (err) { this.errors.push(`material "${name}": invalid def — ${String((err && err.message) || err)}`) }
      }
    }
    const w = new World()
    w.setLayers(scene.layers)
    for (const e of entities) {
      try { w.spawn({ id: e.id, name: e.id, parent: e.parent, layer: e.layer, tags: e.tags, components: e.components }) } catch (err) { /* dup handled by validate */ }
    }
    this.world = w
    // Physics surface follows the new world + the loaded scene's settings (if
    // declared); otherwise a private defaults object (never injected into the
    // scene, so a clean scene stays clean).
    const physicsSettings = (scene.physics && typeof scene.physics === 'object' && !Array.isArray(scene.physics))
      ? scene.physics
      : {}
    // P4a T2: stale trigger listeners from the previous scene must never
    // fire against the new world — clear them before the api is replaced.
    const prevApi = this._physicsApi
    if (prevApi && typeof prevApi.clearListeners === 'function') prevApi.clearListeners()
    this._physicsApi = createPhysicsApi({ world: w, settings: physicsSettings })
    this._physicsSettings = physicsSettings
    // P2-N1 live-world binding: api.nav must serve the CURRENT world + the
    // newly loaded scene's nav config — rebind (cache cleared) right where the
    // physics surface is rebound.
    if (this._nav) this._nav.rebind({ world: w, scene, nav: this._navOverride })
    this._crashed = false
    this._lastError = null
    // Script lifecycle is per-world; drop attachments on scene load.
    this._scriptAttached.clear()
    // System lifecycle is per-world too; drop init state on scene load.
    this._systemAttached.clear()
    // Drop any stale camera-rig selection + emitter playback so a new scene
    // re-selects its own rig and starts emitters fresh.
    resetActiveRig()
    resetEmitterState()
    // Scene load skips onDetach, so the warn-dedup map must be cleared here or
    // the first unknown-mode warn in the new scene is silently suppressed.
    resetUnknownModeWarnings()
    resetFlockState()
    // P2-N2: the nav-agent separation registry is scene state too — stale
    // positions would ghost-push new-scene agents (also clears path state).
    resetNavAgentState()
    // Pending animation-event crossings belong to the old world's playhead —
    // drop them so a stale event never fires into the new scene.
    this._animEventQueue.clear()
    // Blend-tree params are runtime gameplay state for the OLD world's
    // entities — clear them so a new scene starts unblended (defaults only).
    this._animParams.clear()
    if (!hot) this._loop.reset()
    return w
  }
}

/**
 * Create a game.
 * @param {object} opts  see Game constructor
 * @returns {Game}
 */
export function createGame(opts) {
  return new Game(opts)
}
