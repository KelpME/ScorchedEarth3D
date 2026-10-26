/**
 * Engine physics system (plans/PHYSICS.md, Option 2).
 *
 * A thin, world-facing physics surface that makes gravity + floor resolution
 * accessible and data-driven, so the editor can show/toggle/tune "all the
 * physics" and any game can reuse it — without a heavy rigid-body engine.
 *
 * Design:
 *  - World settings live in `scene.physics` = { gravity, snapDist, enabled }.
 *    `api.physics.settings` IS that object, so editing settings (via the editor
 *    tool) mutates the serialized scene and ships with the game.
 *  - Static bodies are entities with a `collider` AND the `floor` tag (the
 *    tag switch: floors are now queryable by tag, not a `solid` component).
 *    The tag that marks a floor is configurable via `settings.floorTag`
 *    (default `"floor"`) so a game can choose its own ground discriminator.
 *  - Dynamic bodies are entities with a `dynamic-body` built-in script, which
 *    applies gravity + floor snapping each fixed step and reports grounded
 *    state back through api.physics.isOnFloor(id).
 *  - `enabled:false` zeroes gravity (bodies stop falling) — the editor toggle.
 *  - SHAPES: a collider carries a `shape` (box / sphere / cylinder / pill).
 *    Box and sphere are exact; pill is a real vertical capsule; cylinder maps
 *    to its bounding AABB (documented approximation). `shapeFor(id)` returns
 *    the entity's real shape, and floor/gravity/raycast/overlap all honor it —
 *    a sphere rests on its radius and a pill on its capsule bottom (bottom =
 *    y - (coreHalf + radius)) - not a box half-extent.
 *
 * Pure helpers (AABB, Sphere, Capsule, shapeFromCollider, applyGravity,
 * snapToGround, raycastShape, shapesOverlap, resolveFloor) stay in physics.js;
 * this module composes them against the live world.
 */
import {
  AABB, applyGravity, snapToGround, raycastShape, shapeFromCollider,
  translateShape, colliderCenter, shapeBottomY, shapeXZ, shapesOverlap,
  resolveBodyVsMesh, readRotation, rotateOffset, readScale,
} from './physics.js'
import {
  contactPair, resolveManifold, combineFriction, combineRestitution,
  substepsNeeded, sortPairs, inertiaTensor, worldInvInertia,
  SOLVER_SLOP, SOLVER_PERCENT, solveManifoldVelocity, solveManifoldPosition,
} from './solver.js'
import { contactManifold } from './manifold.js'
import { worldPositionOf as resolveWorldPosition } from '../nav/world-position.js'
import { createContactCache } from './contact-cache.js'
import { createBroadphase } from './broadphase.js'
import { createSleepManager } from './sleep.js'
import { createWarmStart } from './warmstart.js'
import { normalizeLayers, resolveLayerIndex, maskFrom, layerFilter, effectiveMask } from './layers.js'
import { collectOverlaps, readVec3Arg } from './queries.js'
import { sweepShape } from './sweeps.js'
import { characterControllerScript, resetControllerState, controllerState } from './controller.js'
import { createTriggerTracker, diffTriggerSets } from './triggers.js'
import {
  buildFixedJointConstraint, buildPointJointConstraint, buildDistanceJointConstraint,
  buildSpringJointConstraint, buildHingeJointConstraint, buildPrismaticJointConstraint,
  solveJointConstraint, solveJointPosition,
} from './joints-solver.js'

/** World-default physics settings (used when a scene has no `physics` block). */
export const PHYSICS_DEFAULTS = { gravity: 9.81, snapDist: 0.15, enabled: true, floorTag: 'floor' }

// Solver position-correction constants are IMPORTED from solver.js (single
// source of truth, drift-guarded by a test) — see SOLVER_SLOP/SOLVER_PERCENT.
// P3.5 W3: the v1 floor-path friction (μ·g·dt tangential decay) and the
// GROUND_OMEGA_DAMP ω decay are DELETED — contact friction is owned by the
// 3b manifold solver (solveContactConstraint's Coulomb cone). REST_SLOP_FACTOR
// survives only for the grounded-rest velocity cascade.
const REST_SLOP_FACTOR = 0.5
// Broadphase query padding (u) — a hair of forgiveness around the exact AABB.
const BROADPHASE_PAD = 1e-6

/**
 * Build the `api.physics` handle for a live World.
 *
 * @param {object} opts
 * @param {object} opts.world    the live ECS World (query/entity).
 * @param {object} [opts.settings]  the scene.physics object (mutated in place so
 *                                  edits persist to the scene). Defaults merged.
 * @param {(modelName: string) => ({x,y,z}|null)} [opts.modelBounds]  optional
 *   resolver that returns a model's measured full LOCAL size by name (from the
 *   renderer). Used by the collider's `'render'` shape so a model's collider
 *   matches the REAL mesh, not transform.scale. Settable later via
 *   `setModelBounds` (the renderer isn't ready when the game is constructed).
 * @param {(modelName: string) => (object[]|null)} [opts.modelMesh]  optional
 *   resolver that returns a model's LOCAL-frame triangle list by name (from the
 *   renderer). When available, a `'render'` collider on a model render becomes a
 *   REAL mesh collider (the actual geometry), enabling solid-body collision.
 *   Settable later via `setModelMesh`.
 * @param {(meshName: string) => object[]} [primitiveMesh] primitive-triangles
 *   resolver (mesh name -> the renderer's unit primitive triangles) for the
 *   'match render mesh' one-math-source contract. Settable later via
 *   `setPrimitiveMesh` (renderer.render() wires it automatically).
 * @returns {object} the api.physics surface.
 */
export function createPhysicsApi({ world, settings = {}, modelBounds, modelMesh, primitiveMesh } = {}) {
  if (!world) throw new TypeError('createPhysicsApi requires a world')

  // Per-entity grounded state set by the dynamic-body script.
  const grounded = new Map() // id -> true

  // Rigid-body runtime state (P1): accumulated forces + last-step contacts.
  // Keyed by entity id in plain objects sorted at use time — NO Map iteration
  // drives any ordering decision (determinism rule).
  const forces = new Map() // id -> [fx, fy, fz] (accumulated, consumed per step)
  const torques = new Map() // id -> [tx, ty, tz] (accumulated, consumed per step)
  const lastContacts = new Map() // id -> contact count from the last step
  let lastPairs = [] // sorted canonical pair keys from the last step
  // P4c-2: last step's collider-bearing ids (asc) — sweep/overlap candidate
  // enumeration for the character controller + gameplay queries between steps.
  let lastColliderIds = []
  // P4c-2: per-body transform signature from the previous step (the
  // phantom-motion quiet guard: a body whose transform did not move is
  // asleep-quiet regardless of stored bookkeeping velocity).
  const lastTransforms = new Map()
  // P4a T4: previous step's pair set for collision enter/exit diffing (same
  // content contract as lastPairs — POST-layer-filter solver pairs).
  let lastStepPairs = []
  // P3 per-body motion state (id -> { v, w }) — the authoritative live
  // velocity/ω store. The `velocity` component is AUTHORED-ONLY (seeded into
  // motion on first sight, never written at runtime); `angular-state` is gone.
  const motion = new Map()
  motionRef = motion
  // P4d: bind the module-scope refs EAGERLY (step() and the sweep verb both
  // seed motion through setVelocityOf/getVelocityOf — the verb is callable
  // before the first step).
  worldRef = world
  const broadphase = createBroadphase()
  // T7: per-entity shape cache (transform-signature keyed — see shapeFor).
  const shapeCache = new Map()
  // Sleep thresholds are constructor-only in sleep.js; settings mutate at
  // runtime, so the manager is recreated (cheap) when they change.
  let sleepManager = createSleepManager()
  let sleepCfgSeen = { lin: NaN, ang: NaN, time: NaN }
  const warmStart = createWarmStart()
  // P3.5 W3: persistent contact cache for the manifold pipeline — warm-start
  // impulses keyed by canonical pair, matched by contact-point id.
  const contactCache = createContactCache()
  // T7: per-entity AABB cache for the broadphase (sleeping/static bodies
  // reuse their frozen AABB; signature-checked for transform edits).
  const aabbCache = new Map()
  // Monotonic internal step counter — the cache's temporal clock (determinism
  // contract: same run → same step sequence; a fresh sim starts at 0).
  let stepIndex = 0
  let lastBodyCount = 0
  // Rebuild-on-change sync state: the collider set (id -> AABB) currently
  // mirrored in the broadphase. Compared per step; unchanged → zero work.
  let lastBroadphaseSync = null
  /** True when `desired` (id -> bb) is exactly what the broadphase holds. */
  const broadphaseInSync = (desired) => {
    if (!lastBroadphaseSync || lastBroadphaseSync.size !== desired.size) return false
    for (const [id, bb] of desired) {
      const prev = lastBroadphaseSync.get(id)
      if (!prev) return false
      if (prev.minX !== bb.minX || prev.minY !== bb.minY || prev.minZ !== bb.minZ ||
          prev.maxX !== bb.maxX || prev.maxY !== bb.maxY || prev.maxZ !== bb.maxZ) return false
    }
    return true
  }
  let lastStepStats = null
  // P3.5 island sleeping: per-body solver-correction load from the last step
  // (map id -> max accumulated normal impulse across its contacts).
  let lastStepCorrections = null

  // P4c-2: RUNTIME joint state — broken joints by canonical pair key
  // ('a|b', a < b). Runtime-only: never re-form once broken (even across
  // many steps on the same world); the authored `joint` component data is
  // untouched, so a fresh world simulates the joint again.
  const brokenJoints = new Set()
  // P4c-2: initial relative anchor offset per joint (weld/point position
  // repair target) — runtime state, keyed by canonical joint pair.
  const jointInitOffset = new Map()
  // P4c-3: per-joint state for the 1-axis types — { axis, angle, initOff }.
  // The hinge's accumulated angle and the prismatic's initial anchor offset
  // ride here (runtime-only, canonical pair key) so the frozen axis and the
  // measured limits/motors survive across steps deterministically.
  const jointJointState = new Map()

  // P4a T2: trigger overlap tracking — state across steps (prev key set) +
  // ordered listener maps keyed 'enter'/'stay'/'exit'. Notification-only:
  // listener errors are caught + warned, never break the step.
  const triggerTracker = createTriggerTracker()
  const triggerListeners = { triggerEnter: new Map(), triggerStay: new Map(), triggerExit: new Map() }
  // P4a T4: collision event listeners — 'collisionEnter' | 'collisionExit'.
  // Same listener mechanism as triggers; fires from the POST-layer-filter
  // solver pair set (lastPairs): present-this-step absent-last = enter,
  // absent-this-step present-last = exit. Trigger pairs never enter the
  // solver set — they fire trigger events only.
  const getListenerMap = (event) => (triggerListeners[event] ?? collisionListeners[event])
  const collisionListeners = { collisionEnter: new Map(), collisionExit: new Map() }

  // Model resolvers for the collider's `'render'` shape (see shapeFor).
  let resolveModelBounds = typeof modelBounds === 'function' ? modelBounds : null
  let resolveModelMesh = typeof modelMesh === 'function' ? modelMesh : null
  // Primitive-triangles resolver (mesh name -> the renderer's unit primitive
  // triangles) — the 'match render mesh' one-math-source contract for
  // primitives (non-uniform sphere ellipsoid, true cylinder surface).
  let resolvePrimitiveMesh = typeof primitiveMesh === 'function' ? primitiveMesh : null

  /** Resolve an entity's WORLD position by walking its parent chain — the
   * SHARED resolver (engine/src/nav/world-position.js, extracted P2.5 W5):
   * the same result the renderer computes to place meshes, so a collider sits
   * exactly where its render mesh does. */
  const worldPositionOf = (id) => resolveWorldPosition(world, id)

  /** Build a static-floor AABB for an entity from its WORLD position + collider
   * (unit fallback). Floors are always box-shaped, regardless of `shape`.
   * The collider's local `center` offset is applied, rotated into world space
   * by the entity rotation (matches a rotated floor's placement). */
  const aabbFor = (id) => {
    const rec = world.entity(id)
    const t = (rec && rec.components && rec.components.transform) || {}
    const c = (rec && rec.components && rec.components.collider) || {}
    const [cx, cy, cz] = colliderCenter(c)
    const rot = readRotation(t)
    const w = worldPositionOf(id)
    const off = rotateOffset(cx, cy, cz, rot)
    return new AABB(
      w.x + off.x, w.y + off.y, w.z + off.z,
      c.hx ?? 0.5, c.hy ?? 0.5, c.hz ?? 0.5,
    )
  }

  /** Build an entity's REAL collider shape (box/sphere/pill; cylinder→AABB),
   * positioned at its WORLD transform (parent chain resolved) PLUS its local
   * `center` offset, and honoring the entity rotation (a rotated 'render'
   * collider matches the rotated render mesh). Returns null if it has no
   * collider. */
  const shapeFor = (id) => {
    const rec = world.entity(id)
    if (!rec || !rec.components || !rec.components.collider) return null
    const t = rec.components.transform || {}
    const c = rec.components.collider
    const r = rec.components.render
    // T7 (2026-09-13): shape build (mesh tri rotation especially) dominates
    // the settle-phase profile (~17% + GC). Cache the built shape keyed by a
    // transform signature — a body whose TRS is unchanged reuses it. Physics
    // is the only transform writer during simulation (renderer reads), so a
    // stable signature means a stable shape; scene loads allocate a fresh
    // world/cache so staleness across loads is impossible.
    // Scale goes through readScale (the same normalizer shapeFromRender uses)
    // so array-form transform.scale ([2,1,4]) is keyed by its real values —
    // t.scale.x is undefined on an array, which keyed every array-scale body
    // as "1,1,1" and served stale shapes after a live scale edit.
    // The render identity (mesh + modelName) rides in the signature so a
    // mesh/model swap rebuilds the 'render' collider from the new geometry.
    // RECURRING BUG FIX (2026-10-20): a 'Match render mesh' collider derives its
    // triangles from the renderer's primitiveMesh/modelMesh resolvers, which the
    // renderer wires in render() (game.frame) — AFTER physics (game.step) runs.
    // On the first frame the collider resolves with NULL triangles -> a bounding
    // box, and the cache keyed only by the transform signature served that stale
    // box forever: the geometry NAME never changes, only whether its triangles
    // are wired yet. The wired state rides in the signature so the unwired->wired
    // transition rebuilds the REAL mesh collider exactly once, then caches it.
    const base = r && r.modelName ? String(r.modelName).replace(/^model\//, '') : null
    const primWired = !!(resolvePrimitiveMesh && r && r.mesh && resolvePrimitiveMesh(r.mesh))
    const modelWired = !!(base && resolveModelMesh && resolveModelMesh(base))
    const sig = `${t.x ?? 0}|${t.y ?? 0}|${t.z ?? 0}|${t.scale ? readScale(t.scale).join(',') : ''}|${t.rot ? (t.rot.x ?? 0) + ',' + (t.rot.y ?? 0) + ',' + (t.rot.z ?? 0) : (t.rotation ? (t.rotation.x ?? 0) + ',' + (t.rotation.y ?? 0) + ',' + (t.rotation.z ?? 0) : '')}|${r ? (r.mesh || '') + ':' + (r.modelName || '') : ''}|${primWired ? 'p' : '-'}|${modelWired ? 'm' : '-'}`
    const cachedShape = shapeCache.get(id)
    if (cachedShape && cachedShape.sig === sig) return cachedShape.shape
    const [cx, cy, cz] = colliderCenter(c)
    const rot = readRotation(t)
    const shape = shapeFromCollider(c, {
      render: r,
      scale: t.scale,
      rotation: rot,
      terrain: rec.components.terrain,
      modelBounds: (resolveModelBounds && base) ? resolveModelBounds(base) : null,
      modelTriangles: (resolveModelMesh && base) ? resolveModelMesh(base) : null,
      primitiveTriangles: (resolvePrimitiveMesh && r && r.mesh) ? resolvePrimitiveMesh(r.mesh) : null,
    })
    // The collider sits at the entity's resolved WORLD position (parent chain)
    // plus its local center offset — matching the render mesh, which the
    // renderer places at the resolved world transform. The center offset is a
    // local translation, rotated into world space by the entity rotation.
    const w = worldPositionOf(id)
    const off = rotateOffset(cx, cy, cz, rot)
    const positioned = translateShape(shape, w.x + off.x, w.y + off.y, w.z + off.z)
    shapeCache.set(id, { sig, shape: positioned })
    return positioned
  }

  /** P4d — shared projectile/CCD cast: sweep `moverShape` (the positioned
   * shape of `selfId`) along `delta` against every OTHER collider-bearing
   * body (statics + dynamics + kinematics; triggers excluded — non-solid),
   * layer/mask-aware via the P4a filter (the CASTER's mask gates which
   * candidates it can hit). Deterministic: sorted ids. Returns the nearest
   * first-contact `{ t, nx, ny, nz, id }` or null. Used BOTH by the
   * `sweepProjectile` verb and the `ccd: true` integration path (the CCD
   * stop must be the exact hit the verb reports). */
  const sweepProjectileOf = (selfId, moverShape, delta) => {
    const layerBlock = normalizeLayers(settings.layers)
    const layerNames = layerBlock.names
    const casterCol = world.entity(selfId)?.components?.collider || {}
    const casterBits = {
      layerIndex: resolveLayerIndex(layerNames, casterCol.layer),
      mask: effectiveMask(layerNames, layerBlock.matrix, casterCol.layer, casterCol.mask),
    }
    const ids = lastColliderIds && lastColliderIds.length
      ? lastColliderIds
      : world.query({ has: ['collider'] })
    const candidates = []
    for (const cid of [...ids].sort()) {
      if (cid === selfId) continue
      const ocol = world.entity(cid)?.components?.collider || {}
      // Triggers are non-solid: a projectile passes through them.
      if (ocol.isTrigger) continue
      const candBits = {
        layerIndex: resolveLayerIndex(layerNames, ocol.layer),
        mask: effectiveMask(layerNames, layerBlock.matrix, ocol.layer, ocol.mask),
      }
      if (!layerFilter(casterBits, candBits)) continue
      const s = shapeFor(cid)
      if (s) candidates.push({ id: cid, shape: s })
    }
    return sweepShape(moverShape, delta, candidates)
  }

  /** The entity's INVERSE inertia diagonal (solver's inertiaTensor over its
   * positioned shape + resolved mass). Null (infinite — never spins) when
   * massless or shapeless. */
  const angularInertiaOf = (id) => {
    const rec = world.entity(id)
    if (!rec || !rec.components || !rec.components['rigid-body']) return null
    const shape = shapeFor(id)
    if (!shape) return null
    const I = inertiaTensor(shape, resolveMass(id))
    return I ? { ix: I.ix, iy: I.iy, iz: I.iz } : null
  }

  /** P3.5 pre-work D2: the WORLD-frame inverse inertia for ROTATED bodies —
   * worldInvInertia folds the shape's `rot` Euler into R·diag·Rᵀ (null for
   * massless/shapeless or unrotated shapes — the diagonal path already
   * matches the identity-rotation world tensor exactly). */
  const worldTensorOf = (id) => {
    const rec = world.entity(id)
    if (!rec || !rec.components || !rec.components['rigid-body']) return null
    const shape = shapeFor(id)
    if (!shape || !shape.rot) return null
    return worldInvInertia(shape, resolveMass(id))
  }

  /** A positioned shape's world-space CENTER (center of mass for the angular
   * pipeline): box/sphere carry c[xyz] fields, capsule carries x/y/z. W3:
   * MESH shapes (rotated boxes / render colliders) carry BOUNDS — their
   * center is the bounds midpoint (translateShape keeps them consistent);
   * the old (0,0,0) answer wrecked the solver's lever arms (r = p − c) for
   * any body away from the origin. */
  const shapeCenterOf = (shape) => {
    if (!shape) return { x: 0, y: 0, z: 0 }
    const o = shape.kind === 'box' ? shape.box
      : shape.kind === 'sphere' ? shape.sphere
      : shape.kind === 'pill' ? shape.capsule : null
    if (o) return { x: o.cx ?? o.x ?? 0, y: o.cy ?? o.y ?? 0, z: o.cz ?? o.z ?? 0 }
    if (shape.kind === 'mesh' && shape.minX !== undefined) {
      return {
        x: (shape.minX + shape.maxX) / 2,
        y: (shape.minY + shape.maxY) / 2,
        z: (shape.minZ + shape.maxZ) / 2,
      }
    }
    return { x: 0, y: 0, z: 0 }
  }

  /** Solver angular fields for an entity: ω + center of mass + inverse inertia
   * (fresh objects — no live refs cross into the pure solver). Null invInertia
   * when the body never spins (massless/shapeless — infinite inertia). */
  const angularDesc = (id) => {
    const rec = world.entity(id)
    const rb = rec && rec.components ? rec.components['rigid-body'] : null
    const w = angularVelocityOf(id) || authoredAngularVelocity(rb || {})
    const c = shapeCenterOf(shapeFor(id))
    const I = angularInertiaOf(id)
    return { wx: w[0], wy: w[1], wz: w[2], cx: c.x, cy: c.y, cz: c.z, invInertia: I ? { ix: I.ix, iy: I.iy, iz: I.iz } : null }
  }

  return {
    /** The live settings object (=== scene.physics when present). */
    settings,
    gravity: () => {
      if (settings.enabled === false) return 0
      const g = settings.gravity
      // The gravity setting may be a scalar magnitude (legacy scenes) or a
      // {x,y,z} vector (P1 editor surface). Both consumers need a NUMBER:
      // the rigid pipeline applies the magnitude along −Y and the legacy
      // dynamic-body multiplies it — so the vector's Y component IS the
      // world magnitude (an axis-independent magnitude would break the
      // documented {x:0,y:v,z:0} shorthand; x/z components are P1-declared
      // data, read by api.inspect and honored from P2 angular work onward).
      if (g && typeof g === 'object') return Number(g.y) || 0
      return typeof g === 'number' ? g : PHYSICS_DEFAULTS.gravity
    },
    setGravity: (v) => { settings.gravity = v },
    snapDist: () => settings.snapDist ?? PHYSICS_DEFAULTS.snapDist,
    setSnapDist: (v) => { settings.snapDist = v },
    enabled: () => settings.enabled !== false,
    setEnabled: (v) => { settings.enabled = !!v },

    /**
     * The tag that marks a static floor body (default `"floor"`). Configurable
     * per scene via `settings.floorTag` so a game can pick its own ground
     * discriminator instead of relying on the hardcoded tag.
     */
    floorTag: () => settings.floorTag ?? PHYSICS_DEFAULTS.floorTag,
    setFloorTag: (v) => {
      if (typeof v === 'string' && v.trim() !== '') settings.floorTag = v.trim()
      else delete settings.floorTag
    },

    /**
     * Static bodies: entities with a `collider` AND the configured floor tag
     * (see `floorTag`). Tagging a floor is the data switch (was the `solid`
     * component); gameplay queries these by tag.
     * @returns {string[]} entity ids.
     */
    staticBodies() {
      return world.query({ tags: [this.floorTag()] }).filter((id) => {
        const rec = world.entity(id)
        if (!rec || !rec.components || !rec.components.collider) return false
        // A MESH floor (terrain / a model 'render' collider with real triangles)
        // is a SOLID body resolved by resolveSolid, NOT a box static floor —
        // excluding it keeps aabbFor (box-only) from mis-counting the surface.
        const s = shapeFor(id)
        if (s && s.kind === 'mesh') return false
        return true
      })
    },

    /**
     * Highest floor-top y under an entity's shape (or null). A floor qualifies
     * when it horizontally overlaps the entity's SHAPE and its top is within
     * snapDist of the entity's shape bottom (a sphere/pill rests on its
     * radius; a box on its half-height; a cylinder on height/2). The shape's
     * bottom is its absolute lowest Y — so a collider offset by its local
     * `center` (e.g. raised above the transform) still rests correctly.
     * TWO body classes qualify as floors: BOX static floors (floor-tagged
     * colliders, via `aabbFor`) AND solid-MESH bodies (terrain / model /
     * plane 'Match render mesh' surfaces — via `resolveBodyVsMesh`, the same
     * resolution `dynamic-body` uses). Including meshes here means a custom
     * gameplay script doing its own gravity (the legacy pattern before
     * `dynamic-body`) can rest on a plane or terrain surface through
     * `p.floorTop(id)` alone — no box-thickness floor needed.
     * @param {string} id
     * @returns {number|null}
     */
    floorTop(id) {
      const shape = shapeFor(id)
      if (!shape) return null
      const snap = this.snapDist()
      const bottom = shapeBottomY(shape)
      const xz = shapeXZ(shape)
      let top = null
      for (const sid of this.staticBodies()) {
        const sb = aabbFor(sid)
        const horiz = xz.minX <= sb.maxX && xz.maxX >= sb.minX &&
          xz.minZ <= sb.maxZ && xz.maxZ >= sb.minZ
        if (!horiz) continue
        if (sb.maxY <= bottom + snap && (top === null || sb.maxY > top)) top = sb.maxY
      }
      // Solid-MESH floors (terrain / model / plane surfaces): the same
      // resolveBodyVsMesh check `dynamic-body` performs via resolveSolid, so
      // p.floorTop(id) sees the plane's actual surface Y — not just box tops.
      // Skip sid === id: a dynamic MESH-shaped body (rotated box / render
      // collider) is itself a solid body — without the self-skip it resolves
      // against its own surface and freezes mid-air (P3.5 self-contact bug).
      for (const sid of this.solidBodies()) {
        if (sid === id) continue
        const mesh = shapeFor(sid)
        if (!mesh || mesh.kind !== 'mesh') continue
        const r = resolveBodyVsMesh(shape, mesh, snap)
        if (r.floorTop !== null && (top === null || r.floorTop > top)) top = r.floorTop
      }
      return top
    },

    /** The entity's real collider shape (from shapeFromCollider), positioned,
     * or null if it has no collider. Readable so games can do their own
     * shape-aware checks. */
    shape: shapeFor,

    /**
     * True if two entities' collider shapes overlap (box/sphere/pill mixed
     * supported; cylinder→AABB). Returns false if either lacks a collider.
     * @param {string} idA
     * @param {string} idB
     */
    overlaps(idA, idB) {
      const a = shapeFor(idA)
      const b = shapeFor(idB)
      if (!a || !b) return false
      return shapesOverlap(a, b)
    },

    /** True if the entity was reported grounded on the last step. */
    isOnFloor: (id) => grounded.get(id) === true,

    /** P4b: the character controller's last-step planar speed (u/s) — the
     * read an animation layer uses to match a locomotion clip's authored
     * speed (the locomotion-velocity law). 0 for non-controllers. */
    controllerSpeed: (id) => controllerState.get(id)?.speed ?? 0,

    /** P4b: every entity id carrying a collider (asc) — sweep/overlap
     * candidate enumeration for gameplay code. */
    colliderIds: () => lastColliderIds,

    /** Wire a model-bounds resolver (modelName -> {x,y,z} full LOCAL size) so
     * the collider's `'render'` shape matches the real mesh. Called once the
     * host's renderer has measured its models (it isn't ready at game build). */
    setModelBounds: (fn) => { resolveModelBounds = typeof fn === 'function' ? fn : null },

    /** Wire a model-triangles resolver (modelName -> local-frame triangle list)
     * so a `'render'` collider on a model render becomes a REAL mesh collider
     * (solid-body collision against the actual geometry). */
    setModelMesh: (fn) => { resolveModelMesh = typeof fn === 'function' ? fn : null },

    /** Wire a primitive-triangles resolver (mesh name -> the renderer's unit
     * primitive triangles, from the SAME geometry cache the renderer draws)
     * so a `'render'` collider matches the real primitive surface — the
     * non-uniform-sphere ellipsoid, the true cylinder shell — instead of a
     * hand-modeled approximation. Wired automatically by renderer.render(). */
    setPrimitiveMesh: (fn) => { resolvePrimitiveMesh = typeof fn === 'function' ? fn : null },

    /**
     * Solid mesh bodies: entities with a `collider` whose effective shape is a
     * `mesh` (a `'render'` collider on a model render with measured triangles).
     * These are solid obstacles — dynamic bodies resolve against them laterally
     * and can rest on them, not just floor-tagged static bodies.
     * @returns {string[]} entity ids.
     */
    solidBodies() {
      const out = []
      for (const id of world.query({ has: 'collider' })) {
        // SOLID bodies are mesh-shaped STATIC obstacles (terrain, render-mesh
        // props, untagged statics). DYNAMIC mesh-shaped bodies (a rigid body
        // whose rotated box / render collider resolves to a mesh) are NOT
        // solid here — they resolve against others through the 3b manifold
        // pair loop, which applies equal-and-opposite impulses. Listing them
        // made the v1 lateral push-out treat a crate as an immovable wall:
        // a body sinking through it got shoved sideways 2+ units with zero
        // reaction (and the 'solid' got launched by the same phantom push).
        // (W3 integration, 2026-09-13 — the upward-launch + sideways-drift
        // root cause.) Callers (floorTop / resolveSolid) skip the self id.
        if (world.entity(id).components['rigid-body']) continue
        if (this.shape(id) && this.shape(id).kind === 'mesh') out.push(id)
      }
      return out
    },

    /**
     * Resolve a dynamic body against every solid mesh body: returns the total
     * horizontal push-out (XZ) to clear all mesh surfaces the body penetrates,
     * plus the highest mesh floor-top it can rest on (or null).
     * @param {object} body the entity's positioned shape (from api.physics.shape).
     * @returns {{ pushX: number, pushZ: number, floorTop: number|null }}
     */
    resolveSolid(body, selfId = null) {
      let pushX = 0, pushZ = 0, floorTop = null
      const snap = this.snapDist()
      for (const id of this.solidBodies()) {
        if (selfId !== null && id === selfId) continue
        const mesh = this.shape(id)
        if (!mesh || mesh.kind !== 'mesh') continue
        const r = resolveBodyVsMesh(body, mesh, snap)
        pushX += r.pushX; pushZ += r.pushZ
        if (r.floorTop !== null && (floorTop === null || r.floorTop > floorTop)) floorTop = r.floorTop
      }
      return { pushX, pushZ, floorTop }
    },

    /** Report grounded state (set by the dynamic-body script). */
    setGrounded: (id, v) => { if (v) grounded.set(id, true); else grounded.delete(id) },

    /** Clear all grounded state (used on scene load). */
    resetGrounded: () => grounded.clear(),

    /** Reset per-entity character-controller state (scene load). */
    resetControllerState: () => resetControllerState(),

    // ------------------------------------------------------------------
    // P4a T2: trigger event listeners — 'triggerEnter' | 'triggerStay' |
    // 'triggerExit', each callback receives { a, b } (entity ids ascending).
    // Plain listeners: off() removes the exact callback registered; the
    // callback identity must match the on() one.
    // ------------------------------------------------------------------
    on(event, cb) {
      if (event !== 'triggerEnter' && event !== 'triggerStay' && event !== 'triggerExit' &&
          event !== 'collisionEnter' && event !== 'collisionExit') {
        throw new TypeError(`api.physics.on: unknown event "${event}" (triggerEnter | triggerStay | triggerExit | collisionEnter | collisionExit)`)
      }
      if (typeof cb !== 'function') throw new TypeError('api.physics.on: callback must be a function')
      getListenerMap(event).set(cb, true)
    },

    off(event, cb) {
      if (event !== 'triggerEnter' && event !== 'triggerStay' && event !== 'triggerExit' &&
          event !== 'collisionEnter' && event !== 'collisionExit') {
        throw new TypeError(`api.physics.off: unknown event "${event}" (triggerEnter | triggerStay | triggerExit | collisionEnter | collisionExit)`)
      }
      getListenerMap(event).delete(cb)
    },

    /** Clear every trigger listener — scene teardown (game.js calls it on
     * scene load). */
    clearListeners() {
      for (const k of Object.keys(triggerListeners)) triggerListeners[k].clear()
      for (const k of Object.keys(collisionListeners)) collisionListeners[k].clear()
    },

    // ------------------------------------------------------------------
    // Rigid-body pipeline (P1) — translational dynamics over the shape
    // system. `step(dt)` integrates every `rigid-body` entity once per
    // fixed step (the game loop calls it inside its crash boundary), then
    // resolves contacts: static box floors + solid meshes (the v1 paths)
    // and dynamic-vs-dynamic pairs through the sequential-impulse solver.
    // ------------------------------------------------------------------

    /** Accumulated force — consumed (and cleared) by the next step. */
    applyForce(id, f) {
      worldRef = world
      motionRef = motion
      assertFiniteVec(f)
      const cur = forces.get(id) || [0, 0, 0]
      forces.set(id, [cur[0] + f[0], cur[1] + f[1], cur[2] + f[2]])
      sleepManager.markAwake(id)
    },

    /** Instant velocity change Δv = J/m (no accumulation). */
    applyImpulse(id, j) {
      worldRef = world
      motionRef = motion
      assertFiniteVec(j)
      const rec = world.entity(id)
      if (!rec || !rec.components || !rec.components['rigid-body']) return
      const m = resolveMass(id)
      if (!(m > 0)) return
      const vel = getVelocityOf(id)
      const cur = vel ? vel.v : [0, 0, 0]
      setVelocityOf(id, add3(cur, scale3(j, 1 / m)))
      sleepManager.markAwake(id)
    },

    setVelocity(id, v) { worldRef = world; motionRef = motion; assertFiniteVec(v); setVelocityOf(id, [v[0], v[1], v[2]]); sleepManager.markAwake(id) },

    getVelocity(id) {
      worldRef = world
      motionRef = motion
      if (!world.entity(id)) return null
      const v = getVelocityOf(id)
      return v ? v.v : [0, 0, 0]
    },

    addVelocity(id, d) {
      worldRef = world
      motionRef = motion
      assertFiniteVec(d)
      const cur = getVelocityOf(id) ? getVelocityOf(id).v : [0, 0, 0]
      setVelocityOf(id, [cur[0] + d[0], cur[1] + d[1], cur[2] + d[2]])
      sleepManager.markAwake(id)
    },

    // ----------------------------------------------------------------
    // P2 angular verbs — the torque twins of applyForce/applyImpulse and
    // the ω twins of setVelocity/getVelocity.
    // ----------------------------------------------------------------

    /** Accumulated torque [tx, ty, tz] (N·m) — consumed (and cleared) by the
     * next step. Δω = I⁻¹·τ·dt per axis, rot-locked axes excluded.
     * Non-rigid/missing ids are no-ops (same guard as applyTorqueImpulse). */
    applyTorque(id, t) {
      worldRef = world
      motionRef = motion
      assertFiniteVec(t)
      const rec = world.entity(id)
      if (!rec || !rec.components || !rec.components['rigid-body']) return
      const cur = torques.get(id) || [0, 0, 0]
      torques.set(id, [cur[0] + t[0], cur[1] + t[1], cur[2] + t[2]])
      sleepManager.markAwake(id)
    },

    /** Instant angular-velocity change Δω = I⁻¹·L per axis (no accumulation).
     * Rot-locked axes stay zeroed; non-rigid/missing ids are no-ops. */
    applyTorqueImpulse(id, l) {
      worldRef = world
      motionRef = motion
      assertFiniteVec(l)
      const rec = world.entity(id)
      if (!rec || !rec.components || !rec.components['rigid-body']) return
      const rb = rec.components['rigid-body']
      if (rb.isKinematic) return
      const I = angularInertiaOf(id)
      if (!I) return
      const cur = angularVelocityOf(id) || [0, 0, 0]
      const lock = new Set(rb.lockFlags || [])
      setAngularVelocityOf(id, [
        lock.has('rotX') ? 0 : cur[0] + l[0] * I.ix,
        lock.has('rotY') ? 0 : cur[1] + l[1] * I.iy,
        lock.has('rotZ') ? 0 : cur[2] + l[2] * I.iz,
      ])
      sleepManager.markAwake(id)
    },

    setAngularVelocity(id, w) { worldRef = world; motionRef = motion; assertFiniteVec(w); setAngularVelocityOf(id, [w[0], w[1], w[2]]); sleepManager.markAwake(id) },

    /** Live ω, or null for a missing/non-rigid entity. */
    getAngularVelocity(id) {
      worldRef = world
      motionRef = motion
      const rec = world.entity(id)
      if (!rec || !rec.components || !rec.components['rigid-body']) return null
      return [...(angularVelocityOf(id) || [0, 0, 0])]
    },

    /** Sorted canonical contact-pair keys from the last step (debug/determinism). */
    get lastPairs() { return lastPairs },

    /** P3: wake a sleeping body (every force/impulse/torque/velocity verb
     * fires this implicitly). */
    wake(id) {
      worldRef = world
      motionRef = motion
      sleepManager.markAwake(id)
    },

    /** P3: is this body currently asleep? (false when sleeping is disabled) */
    isSleeping(id) {
      worldRef = world
      return settings.sleepingEnabled !== false && sleepManager.isSleeping(id)
    },

    /** P3: one-shot pipeline stats (editor/tests). */
    stats() {
      worldRef = world
      return {
        bodies: lastBodyCount,
        pairs: lastPairs.length,
        solveCalls: lastStepStats ? lastStepStats.solveCalls : 0,
        worldTensorContacts: lastStepStats ? lastStepStats.worldTensorContacts : 0,
        sleeping: settings.sleepingEnabled === false ? 0 : sleepManager.stats().sleeping,
        broadphaseCells: broadphase.stats().cells,
        broadphaseRebuilds: broadphase.stats().rebuilds,
      }
    },

    /**
     * One authoritative fixed step of the rigid-body pipeline.
     * Convention: gravity is applied along −Y (Y-up world; the v1 scalar
     * `settings.gravity` is a magnitude). A body falls with v[1] += −g·dt.
     * @param {number} dt fixed timestep (1/60)
     */
    step(dt) {
      worldRef = world
      motionRef = motion
      if (settings.enabled === false) return
      const gravity = this.gravity()
      const defFriction = settings.defaultFriction ?? 0.5
      const defRestitution = settings.defaultRestitution ?? 0.1
      const sleepingEnabled = settings.sleepingEnabled !== false
      // Sync sleep thresholds (sleep.js takes them constructor-only): recreate
      // the manager when the scene settings change — losing sleep state is
      // correct behavior for a retuned policy.
      const sleepLin = settings.sleepLinearThreshold ?? 0.05
      const sleepAng = settings.sleepAngularThreshold ?? 0.05
      const sleepTime = settings.sleepTimeUntilSleep ?? 0.5
      if (sleepLin !== sleepCfgSeen.lin || sleepAng !== sleepCfgSeen.ang || sleepTime !== sleepCfgSeen.time) {
        sleepManager = createSleepManager({ linearThreshold: sleepLin, angularThreshold: sleepAng, timeUntilSleep: sleepTime })
        sleepCfgSeen = { lin: sleepLin, ang: sleepAng, time: sleepTime }
      }

      // 1. Collect rigid bodies (deterministic: stable id sort — never Map
      //    iteration order). Kinematics integrate by their velocity only;
      //    dynamics get gravity + forces + contacts.
      const allBodies = world.query({ has: ['rigid-body', 'collider'] }).sort()
      const bodies = allBodies.filter((id) => !world.entity(id).components['rigid-body'].isKinematic)
      const kin = allBodies.filter((id) => world.entity(id).components['rigid-body'].isKinematic)
      lastBodyCount = allBodies.length
      // BROADPHASE — rebuild-on-change (broadphase pathology fix): the grid is
      // persistent across steps. Each step builds the DESIRED collider set
      // (id -> AABB, statics/asleep bodies from the frozen aabbCache) and
      // syncs it into the broadphase ONLY when the set or an AABB actually
      // changed (added/removed/moved). An unchanged collider set does zero
      // broadphase work per step — no clear, no re-insert, no rebuild.
      // P3.5 pre-work D3: EVERY collider entity syncs — a static pedestal
      // (collider, no rigid-body) must be findable by the pair broadphase,
      // not just the v1 floor path.
      const colliderIds = world.query({ has: ['collider'] }).sort()
      lastColliderIds = colliderIds
      // T7 (2026-09-13): shapeFor is the dominant per-body cost on settled
      // scenes (parent-chain walk + shape build × N bodies × every step).
      // A SLEEPING dynamic body's transform is frozen — cache its AABB and
      // reuse it until the body wakes. Statics (no rigid-body) are frozen by
      // definition and cache the same way. Cache invalidation: wake, or any
      // transform write (tracked via a dirty-check on the cached transform
      // reference values for statics).
      const desired = new Map()
      for (const id of colliderIds) {
        const rec = world.entity(id)
        const asleep = rec.components['rigid-body'] &&
          sleepingEnabled && !rec.components['rigid-body'].isKinematic &&
          sleepManager.isSleeping(id)
        const t = rec.components.transform || {}
        const sig = `${t.x ?? 0}|${t.y ?? 0}|${t.z ?? 0}|${t.rotation ? (t.rotation.x ?? 0) + ',' + (t.rotation.y ?? 0) + ',' + (t.rotation.z ?? 0) : ''}|${t.rot ? (t.rot.x ?? 0) + ',' + (t.rot.y ?? 0) + ',' + (t.rot.z ?? 0) : ''}`
        const cached = aabbCache.get(id)
        if (cached && cached.sig === sig && (asleep || !rec.components['rigid-body'])) {
          desired.set(id, cached.bb)
          continue
        }
        const bb = aabbOfShape(shapeFor(id))
        if (bb) {
          desired.set(id, bb)
          aabbCache.set(id, { bb, sig })
        }
      }
      // Sync only on change: same ids with bit-identical AABBs → skip the
      // broadphase entirely this step (statics never churn it 60×/sec).
      if (!broadphaseInSync(desired)) {
        broadphase.clear()
        for (const [id, bb] of desired) broadphase.insert(id, bb)
        // Single-pass build NOW (one median pass + one insert per body): the
        // sync is a complete unit — no lazily deferred work, no cascade.
        broadphase.rebuild()
        lastBroadphaseSync = desired
      }

      // 2. Integrate: gravity + forces − damping, semi-implicit Euler with
      //    the tunneling clamp (substeps). Kinematics: pure velocity drift.
      for (const id of allBodies) {
        const rb = world.entity(id).components['rigid-body']
        // Motion state seeds lazily on first sight (authored data or zeros).
        const velComp = getVelocityOf(id)
        // SLEEPING: an asleep dynamic body skips integration AND movement —
        // its state stays frozen until something wakes it.
        if (sleepingEnabled && !rb.isKinematic && sleepManager.isSleeping(id)) continue
        const v = velComp ? velComp.v : [0, 0, 0]
        const lock = new Set(rb.lockFlags || [])
        // Angular: kinematics carry their authored ω verbatim (never
        // integrated, never solver-spun); dynamics integrate ω += I⁻¹·τ·dt
        // − angularDamping·ω·dt (per axis), rot-locked axes frozen at 0.
        if (rb.isKinematic) {
          setAngularVelocityOf(id, authoredAngularVelocity(rb))
        } else {
          const I = angularInertiaOf(id)
          const w = angularVelocityOf(id) || [0, 0, 0]
          const tau = torques.get(id) || [0, 0, 0]
          const damp = rb.angularDamping ?? 0.05
          for (let i = 0; i < 3; i++) {
            const axis = 'XYZ'[i]
            if (lock.has(`rot${axis}`)) { w[i] = 0; continue }
            const inv = I ? I[`i${axis.toLowerCase()}`] : 0
            w[i] += (tau[i] * inv - damp * w[i]) * dt
          }
          setAngularVelocityOf(id, w)
        }
        if (!rb.isKinematic) {
          const m = resolveMass(id)
          const inv = m > 0 ? 1 / m : 0
          const f = forces.get(id) || [0, 0, 0]
          for (let i = 0; i < 3; i++) {
            const axis = 'XYZ'[i]
            if (lock.has(`pos${axis}`)) { v[i] = 0; continue }
            v[i] += (f[i] * inv - (rb.linearDamping ?? 0) * v[i]) * dt
            if (i === 1) v[i] -= gravity * (rb.gravityScale ?? 1) * dt
          }
          setVelocityOf(id, v)
        }
        // Displacement: P4d CCD path for ccd:true bodies — the per-step
        // delta is SWEPT against every other collider candidate BEFORE the
        // transform moves (layer/mask-aware; the same cast sweepProjectile
        // performs). A hit stops the body at the face (t fraction of the
        // delta applied) and zeroes the normal velocity component (project
        // onto the hit plane; restitution is left to the contact solver on
        // the resulting contact — a swept stop is a dead-stop, not a bounce).
        // ccd:false bodies keep the P1 tunneling-clamp substeps fallback
        // (substeps keep per-substep travel ≤ clamp — detect-after-move, NOT
        // CCD). The two paths coexist: ccd is the anti-tunneling OPT-IN for
        // fast bodies; the clamp remains the default safety net.
        const t = world.entity(id).components.transform
        const shape = shapeFor(id)
        const dx = v[0] * dt, dy = v[1] * dt, dz = v[2] * dt
        if (rb.ccd === true && shape) {
          const hit = sweepProjectileOf(id, shape, [dx, dy, dz])
          if (hit && hit.t < 1) {
            t.x = (t.x ?? 0) + dx * hit.t
            t.y = (t.y ?? 0) + dy * hit.t
            t.z = (t.z ?? 0) + dz * hit.t
            // Project v onto the hit plane: v' = v − (v·n)n (dead stop on
            // the contact normal; tangential motion preserved — slide).
            const vn = v[0] * hit.nx + v[1] * hit.ny + v[2] * hit.nz
            if (vn < 0) {
              setVelocityOf(id, [
                v[0] - vn * hit.nx,
                v[1] - vn * hit.ny,
                v[2] - vn * hit.nz,
              ])
            }
          } else {
            t.x = (t.x ?? 0) + dx
            t.y = (t.y ?? 0) + dy
            t.z = (t.z ?? 0) + dz
          }
        } else {
          const n = shape ? substepsNeeded(shape, dx, dy, dz) : 1
          for (let s = 0; s < n; s++) {
            t.x = (t.x ?? 0) + dx / n
            t.y = (t.y ?? 0) + dy / n
            t.z = (t.z ?? 0) + dz / n
          }
        }
        // Orientation: deterministic Euler accumulation (rotation += ω·dt per
        // axis); no gimbal handling; colliders remain orientation-blind (P3
        // candidate). Writes the transform.rotation Euler in readRotation's
        // {x, y, z} order. Kinematics included: their authored ω animates the
        // body (script-driven movers).
        const w = angularVelocityOf(id) || [0, 0, 0]
        const rx = w[0] * dt, ry = w[1] * dt, rz = w[2] * dt
        // W_OMIT_EPS: residual solver ω (~1e-9) must not accumulate into
        // transform.rotation — it poisons the authored-rotation readback
        // (deep-equal rot pins) and, below readRotation's ROT_EPS, silently
        // rots shapes. Snap: once accumulated |rot| drops under eps it would
        // never come back — so write only when the DELTA is significant, and
        // clamp accumulated components that decayed below eps to exact 0.
        const W_OMIT_EPS = 1e-9
        const snap = (v) => (Math.abs(v) < 1e-7 ? 0 : v)
        if (Math.abs(rx) > W_OMIT_EPS || Math.abs(ry) > W_OMIT_EPS || Math.abs(rz) > W_OMIT_EPS) {
          // P3.5 (2026-09-14): write the t.rot key — readRotation and the
          // renderer both PREFER t.rot over t.rotation, so writing t.rotation
          // was invisible (a stale authored t.rot shadowed the simulated
          // rotation every step — the 'rotation locked on rest' root cause).
          t.rot = {
            x: snap((t.rot?.x ?? 0) + rx),
            y: snap((t.rot?.y ?? 0) + ry),
            z: snap((t.rot?.z ?? 0) + rz),
          }
        }
      }

      // 3. Contacts.
      lastPairs = []
      lastContacts.clear()

      // 3-j. P4c-2 JOINT CONSTRAINTS — solved BEFORE the contact pairs
      // (insertion-point decision, frozen design): the joint pipeline runs
      // as its own accumulate-then-clamp stage on the gravity-loaded
      // velocity, so every contact pair then sees the jointed answer (a
      // weld transmits its partner's momentum before the floor pair reads
      // the velocity). Contact pair ORDER and its Gauss-Seidel sweeps are
      // untouched — the contacts stay bit-stable (a joint-free scene runs
      // the identical contact pipeline; jointed scenes are new behavior).
      // Break check fires inside the loop — a broken joint is removed from
      // the live set (brokenJoints, runtime-only) and never re-forms.
      const jointPairs = jointPairsOf(world, brokenJoints)
      if (jointPairs.length > 0) {
        const JOINT_SOLVER_ITERS = 8
        const JOINT_BIAS_PERCENT = 0.2
        // Break check: accumulated impulse magnitude per pair this step.
        const jointImpulse = new Map()
        for (const jp of jointPairs) {
          const ra = world.entity(jp.a), rb = world.entity(jp.b)
          const rba = ra?.components?.['rigid-body'] || null
          const rbb = rb?.components?.['rigid-body'] || null
          const ma = resolveMass(jp.a), mb = resolveMass(jp.b)
          const isKinA = !!(rba && rba.isKinematic), isKinB = !!(rbb && rbb.isKinematic)
          const descA = rba
            ? { ...velDesc(jp.a), ...(angularDesc(jp.a)), invMass: isKinA ? 0 : (ma > 0 ? 1 / ma : 0), lockFlags: rba.lockFlags }
            : { ...velDesc(jp.a), invMass: 0, lockFlags: [] }
          const descB = rbb
            ? { ...velDesc(jp.b), ...(angularDesc(jp.b)), invMass: isKinB ? 0 : (mb > 0 ? 1 / mb : 0), lockFlags: rbb.lockFlags }
            : { ...velDesc(jp.b), invMass: 0, lockFlags: [] }
          const joint = jp.joint
          const type = joint.type ?? 'fixed'
          // Auto-derived distance bounds: from the INITIAL configuration
          // when both are absent (initial anchor separation, snap-read).
          let jd = joint
          if (type === 'distance' && joint.minDist === undefined && joint.maxDist === undefined) {
            const s0 = shapeFor(jp.a), s1 = shapeFor(jp.b)
            const c0 = s0 ? shapeCenterOf(s0) : { x: 0, y: 0, z: 0 }
            const c1 = s1 ? shapeCenterOf(s1) : { x: 0, y: 0, z: 0 }
            const d0 = Math.hypot(c1.x - c0.x, c1.y - c0.y, c1.z - c0.z)
            jd = { ...joint, minDist: d0, maxDist: d0 }
          }
          const build = type === 'point' ? buildPointJointConstraint
            : type === 'distance' ? buildDistanceJointConstraint
            : type === 'spring' ? buildSpringJointConstraint
            : type === 'hinge' ? buildHingeJointConstraint
            : type === 'prismatic' ? buildPrismaticJointConstraint
            : buildFixedJointConstraint // fixed + (unknown types → weld)
          // P4c-3: frozen axis + accumulated angle / initial offset for the
          // 1-axis types — deterministic per-pair runtime state (created on
          // first sight of the pair; the authored axis wins when present).
          let jst = null
          if (type === 'hinge' || type === 'prismatic') {
            jst = jointJointState.get(jp.key)
            if (!jst) {
              jst = { axis: null, angle: 0, initOff: null }
              jointJointState.set(jp.key, jst)
            }
          }
          const c = build(descA, descB, jd, null, null, {
            dt,
            frozenAxis: jst ? jst.axis : undefined,
            angle: jst ? jst.angle : 0,
            initOff: jst ? jst.initOff : undefined,
          })
          // Weld/point position repair target: the INITIAL relative ANCHOR
          // offset — anchorB − anchorA at first build, persisted per joint
          // (runtime state). The repair err is anchor-based, so the init
          // offset MUST be anchor-based too (center-based init injected a
          // phantom error that drove the pendulum bob through the floor).
          // P4c-3: persist the 1-axis runtime state on first build — the
          // prismatic's initial anchor offset (limits measure from it) and
          // the hinge/prismatic FROZEN axis (the initial body-to-body or
          // authored direction, unit-normalized; never re-derived later).
          if (type === 'hinge' || type === 'prismatic') {
            if (jst.initOff === null) jst.initOff = (c.rB[0] + c.bodyB.cx - c.bodyA.cx - c.rA[0]) * c.u[0] + (c.rB[1] + c.bodyB.cy - c.bodyA.cy - c.rA[1]) * c.u[1] + (c.rB[2] + c.bodyB.cz - c.bodyA.cz - c.rA[2]) * c.u[2]
            if (!jst.axis) jst.axis = [c.u[0], c.u[1], c.u[2]]
          }
          if (type === 'fixed' || type === 'point') {
            let init = jointInitOffset.get(jp.key)
            if (!init) {
              init = [
                (c.bodyB.cx + c.rB[0]) - (c.bodyA.cx + c.rA[0]),
                (c.bodyB.cy + c.rB[1]) - (c.bodyA.cy + c.rA[1]),
                (c.bodyB.cz + c.rB[2]) - (c.bodyA.cz + c.rA[2]),
              ]
              jointInitOffset.set(jp.key, init)
            }
            c.initOffset = init
          }
          if (type === 'spring') {
            c.dt = dt
            // Spring = dt-scaled FORCE, applied ONCE (not per Gauss-Seidel
            // iteration — compounding an 8× force per step explodes it).
            // Bilateral, so the accumulated magnitude is |c.l| single-shot.
            solveJointConstraint(c)
          } else {
            for (let it = 0; it < JOINT_SOLVER_ITERS; it++) {
              solveJointConstraint(c)
            }
          }
          // P4c-3: integrate the hinge's ACCUMULATED angle from the solved
          // relative ω about the axis (ω_rel is post-solve — the limit/motor
          // impulses already applied). Runtime-only; clamped to the limits.
          if (type === 'hinge' && jst) {
            const wu = (descB.wx - descA.wx) * c.u[0] + (descB.wy - descA.wy) * c.u[1] + (descB.wz - descA.wz) * c.u[2]
            let ang = jst.angle + wu * dt
            if (c.hasLimit) ang = Math.min(Math.max(ang, c.limitMin), c.limitMax)
            jst.angle = ang
          }
          // P4c-3: hinge POSITION repair — same anchor-repair machinery as
          // weld/point (the anchors coincide; drift pulled to the init
          // offset). The prismatic is repaired only on its perpendicular
          // axes (axial slide is the joint's freedom), handled below.
          if (type === 'hinge' || type === 'prismatic') {
            const posIters = Math.max(1, settings.positionIterations ?? 3)
            const tA = ra?.components?.transform
            const tB = rb?.components?.transform
            for (let pi = 0; pi < posIters; pi++) {
              if (tA) { c.bodyA.cx = tA.x ?? 0; c.bodyA.cy = tA.y ?? 0; c.bodyA.cz = tA.z ?? 0 }
              if (tB) { c.bodyB.cx = tB.x ?? 0; c.bodyB.cy = tB.y ?? 0; c.bodyB.cz = tB.z ?? 0 }
              if (type === 'hinge') {
                // Hinge: repair only the ALONG-AXIS anchor error (the panel
                // must not slide off the pin's axis line). The perpendicular
                // displacement of a swung panel is legitimate rotation — a
                // full-vector repair would fight the swing (and the frozen
                // rB lever cannot track the rotated anchor point).
                const err = [
                  (c.bodyB.cx + c.rB[0]) - (c.bodyA.cx + c.rA[0]),
                  (c.bodyB.cy + c.rB[1]) - (c.bodyA.cy + c.rA[1]),
                  (c.bodyB.cz + c.rB[2]) - (c.bodyA.cz + c.rA[2]),
                ]
                const eu = err[0] * c.u[0] + err[1] * c.u[1] + err[2] * c.u[2]
                const iA = c.bodyA.invMass || 0, iB = c.bodyB.invMass || 0
                if (iA + iB <= 0) break
                const wA = iA / (iA + iB), wB = iB / (iA + iB)
                const lockA = new Set(c.bodyA.lockFlags || [])
                const lockB = new Set(c.bodyB.lockFlags || [])
                for (let k = 0; k < 3; k++) {
                  const axisK = 'xyz'[k]
                  const along = eu * c.u[k]
                  const corr = along * 0.5
                  if (iA > 0 && !lockA.has(`pos${axisK.toUpperCase()}`) && tA) tA[axisK] = (tA[axisK] ?? 0) + corr * wA
                  if (iB > 0 && !lockB.has(`pos${axisK.toUpperCase()}`) && tB) tB[axisK] = (tB[axisK] ?? 0) - corr * wB
                }
                if (tA) { c.bodyA.cx = tA.x ?? 0; c.bodyA.cy = tA.y ?? 0; c.bodyA.cz = tA.z ?? 0 }
                if (tB) { c.bodyB.cx = tB.x ?? 0; c.bodyB.cy = tB.y ?? 0; c.bodyB.cz = tB.z ?? 0 }
              } else {
                // Prismatic: zero the perpendicular anchor error components
                // only (e1/e2 basis) — the axial component is the freedom.
                const err = [
                  (c.bodyB.cx + c.rB[0]) - (c.bodyA.cx + c.rA[0]) - jst.initOff * c.u[0],
                  (c.bodyB.cy + c.rB[1]) - (c.bodyA.cy + c.rA[1]) - jst.initOff * c.u[1],
                  (c.bodyB.cz + c.rB[2]) - (c.bodyA.cz + c.rA[2]) - jst.initOff * c.u[2],
                ]
                const eu = err[0] * c.u[0] + err[1] * c.u[1] + err[2] * c.u[2]
                const iA = c.bodyA.invMass || 0, iB = c.bodyB.invMass || 0
                if (iA + iB <= 0) break
                const wA = iA / (iA + iB), wB = iB / (iA + iB)
                const lockA = new Set(c.bodyA.lockFlags || [])
                const lockB = new Set(c.bodyB.lockFlags || [])
                for (let k = 0; k < 3; k++) {
                  const axisK = 'xyz'[k]
                  const perp = err[k] - eu * c.u[k]
                  const corr = perp * 0.5
                  if (iA > 0 && !lockA.has(`pos${axisK.toUpperCase()}`) && tA) tA[axisK] = (tA[axisK] ?? 0) + corr * wA
                  if (iB > 0 && !lockB.has(`pos${axisK.toUpperCase()}`) && tB) tB[axisK] = (tB[axisK] ?? 0) - corr * wB
                }
                // Re-sync for the next repair pass.
                if (tA) { c.bodyA.cx = tA.x ?? 0; c.bodyA.cy = tA.y ?? 0; c.bodyA.cz = tA.z ?? 0 }
                if (tB) { c.bodyB.cx = tB.x ?? 0; c.bodyB.cy = tB.y ?? 0; c.bodyB.cz = tB.z ?? 0 }
              }
            }
          }
          // Break magnitude: springs carry their single-shot impulse in c.l;
          // fixed/point/distance accumulate per-axis (lx..lz) or along the
          // rope (l) across the Gauss-Seidel passes.
          const l2 = Math.hypot(c.lx || 0, c.ly || 0, c.lz || 0)
          let magnitude = Math.abs(c.l ?? 0) > 0 ? Math.abs(c.l) : l2
          // P4c-3: the 1-axis types accumulate anchor impulses into lx/ly/lz
          // (hinge's 3-dof anchor + prismatic's perpendicular axes) — include
          // the motor impulse in the break accounting.
          if (type === 'hinge' || type === 'prismatic') magnitude = Math.max(l2, Math.abs(c.motorL || 0))
          jointImpulse.set(jp.key, magnitude)
          // Positional repair: weld/point pull the anchors together,
          // invMass-weighted, positionIterations repeats (contacts' rate).
          // EACH pass recomputes the anchor error from the LIVE transforms —
          // the descriptors are build-time snapshots; editing tA/tB without
          // re-reading them made every pass re-apply the FULL original error
          // (positive feedback: the welded pair explodes apart, observed
          // a.y 0.99 → 3.2 → −15 in three steps).
          if (type === 'fixed' || type === 'point') {
            const posIters = Math.max(1, settings.positionIterations ?? 3)
            const tA = ra?.components?.transform
            const tB = rb?.components?.transform
            for (let pi = 0; pi < posIters; pi++) {
              // Re-sync descriptor centers from live transforms so the error
              // is recomputed fresh this pass.
              if (tA) { c.bodyA.cx = tA.x ?? 0; c.bodyA.cy = tA.y ?? 0; c.bodyA.cz = tA.z ?? 0 }
              if (tB) { c.bodyB.cx = tB.x ?? 0; c.bodyB.cy = tB.y ?? 0; c.bodyB.cz = tB.z ?? 0 }
              const d = solveJointPosition(c, 0.5)
              if (tA && (d.dax || d.day || d.daz)) {
                tA.x = (tA.x ?? 0) + d.dax
                tA.y = (tA.y ?? 0) + d.day
                tA.z = (tA.z ?? 0) + d.daz
              }
              if (tB && (d.dbx || d.dby || d.dbz)) {
                tB.x = (tB.x ?? 0) + d.dbx
                tB.y = (tB.y ?? 0) + d.dby
                tB.z = (tB.z ?? 0) + d.dbz
              }
            }
          }
          // NaN firewall (same contract as the contact pair loop).
          if (![descA.vx, descA.vy, descA.vz, descB.vx, descB.vy, descB.vz].every(Number.isFinite)) continue
          if (!isKinA) setVelocityOf(jp.a, [descA.vx, descA.vy, descA.vz])
          if (!isKinB) setVelocityOf(jp.b, [descB.vx, descB.vy, descB.vz])
          if ([descA.wx, descA.wy, descA.wz].every(Number.isFinite) && !isKinA) {
            setAngularVelocityOf(jp.a, [descA.wx, descA.wy, descA.wz])
          }
          if ([descB.wx, descB.wy, descB.wz].every(Number.isFinite) && !isKinB) {
            setAngularVelocityOf(jp.b, [descB.wx, descB.wy, descB.wz])
          }
        }
        // breakForce: the constraint's impulse magnitude beyond the limit
        // BREAKS the joint — removed from the live set (runtime state).
        for (const jp of jointPairs) {
          const bf = jp.joint.breakForce
          if (bf > 0 && (jointImpulse.get(jp.key) || 0) > bf) brokenJoints.add(jp.key)
        }
      }

      // 3b. Contact pairs — resolved BEFORE the static-floor pass (3a), which
      // then repairs any floor-resting body the pair response shoved into the
      // floor. BROADPHASE (uniform grid): every COLLIDER AABB is inserted each
      // step. P3.5 W3: component-less statics (collider, no rigid-body —
      // pedestals, walls, floor-tagged boxes) enter the pair loop as
      // invMass=0 participants (they never integrate; only pair participation
      // changed). Each DYNAMIC body queries its broadened AABB.
      const pairs = []
      const pairKeys = new Set()
      // P4a T2: this step's trigger-overlap keys (canonical 'a|b', a < b) —
      // gathered during the pair loop, diffed at the end of step().
      const triggerCurKeys = []
      // P4a T1: physics layers + masks. Resolve each collider's layer index +
      // 32-bit mask once per step (name-based authoring, int-based decisions —
      // no Map iteration / string compares on the pair path). Defaults:
      // single implicit 'default' layer, every body's mask = all bits, so a
      // scene with no layers block behaves exactly as before.
      const layerBlock = normalizeLayers(settings.layers)
      const layerNames = layerBlock.names
      const layerBits = new Map()
      for (const cid of colliderIds) {
        const col = world.entity(cid)?.components?.collider || {}
        layerBits.set(cid, {
          layerIndex: resolveLayerIndex(layerNames, col.layer),
          mask: effectiveMask(layerNames, layerBlock.matrix, col.layer, col.mask),
        })
      }
      for (const id of bodies) {
        const s = shapeFor(id)
        if (!s) continue
        // P3.5 pre-work D3: mesh shapes (rotated boxes / render colliders) join
        // the pair table — their AABB (mesh bounds) already spans the ROTATED
        // footprint (buildMeshShape bounds the rotated triangles), so the
        // broadphase query cannot miss a rotated-corner dip.
        const bb = aabbOfShape(s)
        if (!bb) continue
        const q = {
          minX: bb.minX - BROADPHASE_PAD, maxX: bb.maxX + BROADPHASE_PAD,
          minY: bb.minY - BROADPHASE_PAD, maxY: bb.maxY + BROADPHASE_PAD,
          minZ: bb.minZ - BROADPHASE_PAD, maxZ: bb.maxZ + BROADPHASE_PAD,
        }
        for (const other of broadphase.query(q)) {
          if (other === id) continue
          // W3: the other side may be a rigid body OR a component-less static
          // (collider only). Static-vs-static pairs never gather: the querying
          // side (`id`) is always a non-kinematic rigid body.
          const otherRec = world.entity(other)
          const otherRb = otherRec?.components?.['rigid-body'] || null
          // W3-continuation fix (2026-09-13): KINEMATICS must stay in the
          // pair loop (invMass=0 participants — moving platforms, edges a
        // dynamic box lands on). The old skip made kinematic bases ghosts:
        // a chip falling onto a kinematic edge fell straight through.
          // const skip-kinematic removed — statics-vs-static never gather
          // (query side is always a non-kinematic rigid body).
          const key = id < other ? `${id}|${other}` : `${other}|${id}`
          if (pairKeys.has(key)) continue
          // P4c-2: collideConnected=false (default) — a jointed A/B pair is
          // EXCLUDED from contact pair generation (like masked pairs).
          // Deterministic lookup (no Map iteration): this step's live joint
          // set collected at 3-j.
          if (!jointPairs.every((jp) => jp.key !== key || jp.joint.collideConnected === true)) continue
          // P4a T1: layer/mask gate — gather only if A's mask includes B's
          // layer AND B's mask includes A's layer (statics participate too).
          const la = layerBits.get(id)
          const lb = layerBits.get(other)
          if (la && lb && !layerFilter(la, lb)) continue
          pairKeys.add(key)
          const a = id < other ? id : other
          const b = id < other ? other : id
          // P4a T2: trigger-involved pairs (at least one collider isTrigger)
          // are DETECTED for events but EXCLUDED from the solver entirely —
          // no impulses, no position correction. Layer gate ran first.
          const colA = world.entity(a)?.components?.collider || {}
          const colB = world.entity(b)?.components?.collider || {}
          const isTriggerPair = !!(colA.isTrigger || colB.isTrigger)
          const sa = shapeFor(a), sb = shapeFor(b)
          if (!sa || !sb) continue
          if (isTriggerPair) {
            const manifold = contactManifold(sa, sb)
            if (manifold && manifold.points && manifold.points.length > 0) {
              triggerCurKeys.push(key)
            }
            continue
          }
          // P3.5 W3: contactManifold replaces contactPair+midpoint — per-POINT
          // contacts ({normal, points:[{px..pz, sep, id, ...}]}, points already
          // sorted by id). Null = no manifold (separated or unsupported pair).
          const manifold = contactManifold(sa, sb)
          if (manifold && manifold.points && manifold.points.length > 0) {
            pairs.push({ a, b, manifold, sa, sb, otherRb })
          }
        }
      }
      // P4a T2: static-vs-static trigger detection — the pair loop queries
      // only from non-kinematic rigid bodies, so two component-less statics
      // (a trigger zone + a pressure plate) never meet there. Detect
      // trigger-involved static pairs explicitly (sorted trigger ids —
      // determinism; layer gate honored).
      const staticTriggers = []
      for (const cid of colliderIds) {
        if (world.entity(cid)?.components?.['rigid-body']) continue
        if (world.entity(cid)?.components?.collider?.isTrigger) staticTriggers.push(cid)
      }
      staticTriggers.sort()
      for (const tid of staticTriggers) {
        const ts = shapeFor(tid)
        if (!ts) continue
        const bb = aabbOfShape(ts)
        if (!bb) continue
        const q = {
          minX: bb.minX - BROADPHASE_PAD, maxX: bb.maxX + BROADPHASE_PAD,
          minY: bb.minY - BROADPHASE_PAD, maxY: bb.maxY + BROADPHASE_PAD,
          minZ: bb.minZ - BROADPHASE_PAD, maxZ: bb.maxZ + BROADPHASE_PAD,
        }
        for (const other of broadphase.query(q)) {
          if (other === tid) continue
          // Rigid-body sides are already covered by the main pair loop.
          if (world.entity(other)?.components?.['rigid-body']) continue
          const la = layerBits.get(tid), lb = layerBits.get(other)
          if (la && lb && !layerFilter(la, lb)) continue
          const os = shapeFor(other)
          if (!os) continue
          const m = contactManifold(ts, os)
          if (m && m.points && m.points.length > 0) {
            triggerCurKeys.push(tid < other ? `${tid}|${other}` : `${other}|${tid}`)
          }
        }
      }
      // Resolve in sorted-id order (sortPairs on {a,b}; a key map carries the
      // manifolds through — no ordering decision ever rides Map iteration).
      const sorted = sortPairs(pairs.map((p) => ({ a: p.a, b: p.b })))
      const byKey = new Map(pairs.map((p) => [p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`, p]))
      const aliveKeys = []
      // Island supports: vertical contacts (|ny| > 0.5) recorded on the last
      // sweep — { upper, lower, e } — used to propagate grounded rest up a
      // stack (a crate standing on a grounded crate IS grounded).
      const supports = []
      // Per-step pinned restitution targets (pairKey -> restTarget), baked on
      // the first sweep-call and pinned into the later ones (see below).
      const restTargets = new Map()
      // Solver iteration counts (scene.physics): velocity iterations per pair
      // + position-correction repeats. Defaults 8 / 3.
      const solverIters = Math.max(1, settings.solverIterations ?? 8)
      // P3.5 pre-work D1: per-step solve-call telemetry (linear-in-pairs gate).
      const stepStats = { solveCalls: 0, worldTensorContacts: 0 }
      // P3.5 island sleeping: per-body solver-correction load this step —
      // the max accumulated normal impulse per pair the body participated
      // in (max, not sum: a body in several contacts carries each contact's
      // own load). Normalized by mass at evaluation time.
      const stepCorrections = new Map()
      lastStepCorrections = stepCorrections
      const recordCorrection = (id, ln) => {
        const cur = stepCorrections.get(id) || 0
        if (ln > cur) stepCorrections.set(id, ln)
      }
      lastStepStats = stepStats
      for (let sweep = 0; sweep < solverIters; sweep++) {
        // The LAST sweep carries the positional repair + bookkeeping; earlier
        // sweeps are velocity-only Gauss-Seidel passes (later pairs must see
        // earlier pairs' impulses — a single sweep leaves stacked bodies with
        // residual closing speed from the pair resolved above them).
        const lastSweep = sweep === solverIters - 1
        for (const p of sorted) {
        const key = p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`
        const { a, b, manifold, otherRb } = byKey.get(key)
        const sa = shapeFor(a), sb = shapeFor(b)
        if (!sa || !sb) continue
        // RIGID-BODY lookups: a component-less static (no rigid-body) is a
        // plain invMass=0 participant — world-default friction/restitution,
        // no angular fields, never asleep, never woken.
        const recA = world.entity(a), recB = world.entity(b)
        const rba = recA.components['rigid-body'] || null
        const rbb = otherRb && b === otherRb.id0 ? otherRb : recB.components['rigid-body'] || null
        if (!rba && !rbb) continue // unreachable (A is always a rigid body) — belt+braces
        // SLEEPING: two sleeping bodies resolve to nothing (skipped entirely);
        // a sleeping body hit by an AWAKE DYNAMIC body wakes BEFORE resolution.
        // A STATIC side provides support and never wakes anyone (statics
        // neither sleep nor wake).
        const asleepA = rba && sleepingEnabled && sleepManager.isSleeping(a)
        const asleepB = rbb && sleepingEnabled && sleepManager.isSleeping(b)
        if (asleepA && asleepB) {
          // P4a T4: both asleep → the pair is skipped this step, but it has
          // NOT separated (a sleeping pair cannot separate without waking).
          // Carry it forward from the previous step's set so collision
          // enter/exit see it as continuously present (no phantom exit at
          // sleep onset, no phantom re-enter on wake).
          if (lastStepPairs.includes(key)) lastPairs.push(key)
          continue
        }
        const isKinA = !!(rba && rba.isKinematic), isKinB = !!(rbb && rbb.isKinematic)
        const ma = resolveMass(a), mb = resolveMass(b)
        // W3 desc defaults: a component-less static is invMass 0, no angular
        // fields, no locks (nothing ever moves it anyway).
        const descA = rba
          ? { ...velDesc(a), invMass: isKinA ? 0 : (ma > 0 ? 1 / ma : 0), lockFlags: rba.lockFlags, ...angularDesc(a) }
          : { ...velDesc(a), invMass: 0, lockFlags: [] }
        const descB = rbb
          ? { ...velDesc(b), invMass: isKinB ? 0 : (mb > 0 ? 1 / mb : 0), lockFlags: rbb.lockFlags, ...angularDesc(b) }
          : { ...velDesc(b), invMass: 0, lockFlags: [] }
        // P3.5 pre-work D2: ROTATED bodies get the FULL world-frame tensor —
        // the diagonal invInertia is body-frame and unrotated, so a 45° box
        // would spin on the wrong axes. The solver's effInvTensor prefers
        // invInertia3x3 when present (back-compat: absent → diagonal path).
        const tA3 = rba ? worldTensorOf(a) : null
        const tB3 = rbb ? worldTensorOf(b) : null
        // W3-continuation (2026-09-13): wake a sleeping body only when the
        // contact has a real CLOSING speed along the manifold normal — the
        // geometric test of "this contact will transmit an impulse". A
        // resting stack's normal speed is ~0 (gravity cancels into the
        // constraint); waking on mere contact kept stacked bodies
        // ping-ponging sleep→wake forever. Static/kinematic partners never
        // wake anyone.
        // USER LIVE REPORT (2026-09-13): touched sleeping objects never
        // woke — a grab/push arrives as TANGENTIAL contact (vn ~0), so the
        // normal-speed gate missed it. Two-part semantic (Box2D-style):
        // (1) fast pre-gate: real closing speed wakes immediately;
        // (2) resolve mixed pairs NORMALLY (do NOT skip), then wake the
        // sleeper if the solver actually transmitted impulse into it
        // (checked after solveManifoldVelocity via accumulated λn).
        let mixedPair = (asleepA || asleepB)
        if (asleepA || asleepB) {
          // NO rvn pre-gate: a resting body's own gravity gives every support
          // contact a normal closing speed of g·dt each step — a speed gate
          // here wakes the body from its own weight. The transmitted-impulse
          // check after solveManifoldVelocity (below) is the sole wake path:
          // it fires only when the contact carries MORE than the body's
          // resting-gravity load.
          mixedPair = true
          if (sleepManager.isSleeping(a) && sleepManager.isSleeping(b)) {
            // P4a T4: both asleep → the pair is skipped this step, but it has
            // NOT separated (a sleeping pair cannot separate without waking).
            // Carry it forward from the previous step's set so collision
            // enter/exit see it as continuously present (no phantom exit at
            // sleep onset, no phantom re-enter on wake).
            if (lastStepPairs.includes(key)) lastPairs.push(key)
            continue
          }
        } else {
          mixedPair = false
        }
        if (tA3) descA.invInertia3x3 = tA3
        if (tB3) descB.invInertia3x3 = tB3
        if ((tA3 || tB3) && stepStats) stepStats.worldTensorContacts++
        // W3 friction/restitution combine — component-less statics use the
        // world defaults on their side.
        const fr = combineFriction(rba ? (rba.friction ?? defFriction) : defFriction, rbb ? (rbb.friction ?? defFriction) : defFriction)
        const re = combineRestitution(rba ? (rba.restitution ?? defRestitution) : defRestitution, rbb ? (rbb.restitution ?? defRestitution) : defRestitution)
        // P3.5 W3: the W2 accumulating per-point pipeline — ONE
        // solveManifoldVelocity call per pair per sweep handles all manifold
        // points (internal Gauss-Seidel sweeps inside), warm-started from the
        // persistent contact cache. solveCalls stays linear in pairs.
        // W3-continuation (2026-09-13): the restitution target is baked ONCE
        // per step (first sweep-call, from that call's pre-solve vn0) and
        // PINNED into every later sweep-call via restTargetOverride. Without
        // the pin, call 2+ re-derives restTarget from the post-impulse
        // velocity (sign flipped) and — warm-started with the accumulated ln
        // — cancels the bounce the first call injected (peak sat at rest).
        const opts = { sweeps: sweep === solverIters - 1 ? 1 : solverIters, friction: fr, restitution: re, dt }
        if (sweep === 0) {
          delete opts.restTargetOverride
        } else {
          opts.restTargetOverride = restTargets.get(key) ?? null
        }
        if (stepStats) stepStats.solveCalls++
        const out = solveManifoldVelocity(descA, descB, manifold, contactCache, key, stepIndex, opts)
        // P3.5 island sleeping: record each body's solver-correction load
        // (the max accumulated normal impulse across its contacts this step)
        // — the third quiet measure in island sleep candidacy ("is the
        // solver still fighting to hold/correct this body?"). Last sweep
        // only: the final constraint state is the settled demand.
        if (lastSweep) {
          for (const c of out.constraints) {
            recordCorrection(a, c.ln)
            recordCorrection(b, c.ln)
          }
        }
        // Mixed-pair wake (part 2 of the touched-sleeping fix): the sleeper
        // was resolved NORMALLY (its side got zero velocity response — it
        // stays frozen) but the solver still accumulated impulses on its
        // points. Wake only when the transmitted impulse EXCEEDS the body's
        // own resting-gravity load (m·g·dt — what a support contact carries
        // with zero external push); a grab/push impulse is orders above it.
        // ε accounts for the awake partner's mass contribution through the
        // shared constraint.
        if (mixedPair && (sweep === 0)) {
          // P3.5 (2026-09-14, replacing the λn-threshold wake): an AWAKE
          // DYNAMIC body resolving a contact against a sleeping body IS the
          // disturbance — wake the sleeper immediately, regardless of impulse
          // magnitude. The old λn > resting-load gate missed slow touches
          // (a gentle push transmits less λn per step than the body's own
          // weight — the user's live 'touched sleeping objects don't wake'
          // report). Stack stability is preserved by island sleeping: a
          // fully-sleeping island skips resolution entirely, so resting
          // neighbors never wake each other; only a genuinely AWAKE partner
          // (which is already moving) triggers this path.
          const awakeDynamic = (rb) => rb && !rb.isKinematic
          if (asleepA && awakeDynamic(rbb)) sleepManager.markAwake(a)
          if (asleepB && awakeDynamic(rba)) sleepManager.markAwake(b)
        }
        if (sweep === 0) {
          restTargets.set(key, out.constraints.length > 0 ? out.constraints[0].restTarget : 0)
        }
        // NaN firewall: a non-finite result would poison the whole sim. Skip
        // the write for that pair (log-free; deterministic — same inputs give
        // the same NaN, so both runs drop the same pair).
        if ([descA.vx, descA.vy, descA.vz, descB.vx, descB.vy, descB.vz].every(Number.isFinite)) {
          if (!isKinA) setVelocityOf(a, [descA.vx, descA.vy, descA.vz])
          if (!isKinB) setVelocityOf(b, [descB.vx, descB.vy, descB.vz])
          // Angular write-back: only for bodies the solver actually spun
          // (finite ω fields present — component-less statics never carry any).
          if ([descA.wx, descA.wy, descA.wz].every(Number.isFinite) && !isKinA) {
            setAngularVelocityOf(a, [descA.wx, descA.wy, descA.wz])
          }
          if ([descB.wx, descB.wy, descB.wz].every(Number.isFinite) && !isKinB) {
            setAngularVelocityOf(b, [descB.wx, descB.wy, descB.wz])
          }
          // Record the support edge (which body rests on which) for the
          // grounded-rest cascade below. A component-less static (rba/rbb
          // null) is always the LOWER side of any support it provides.
          // lowerStatic marks a STATIC support root: statics are never
          // grounded themselves (no rigid-body or mass 0 → they never enter
          // the 3a floor path), so the island cascade must treat them as
          // grounded-support roots or a body resting on a pedestal/wall
          // static is never grounded (W4 continuation, 2026-09-13).
          const ny = manifold.normal.y
          const lowerStatic = ny > 0.5 ? !rba : !rbb
          if (lastSweep && ny > 0.5) {
            supports.push({ upper: b, lower: a, e: re, lowerStatic })
          } else if (lastSweep && ny < -0.5) {
            supports.push({ upper: a, lower: b, e: re, lowerStatic })
          }
          // W3 position: last-sweep positional repair via solveManifoldPosition
          // per manifold (invMass-weighted, lock-honoring, pure deltas).
          // positionIterations repeats (P3's contract, default 3): a single
          // 20%-per-step repair loses the race against gravity's Baumgarte
          // bias — stacks settle at a penetration equilibrium ABOVE slop,
          // the bias then injects +0.15 vy every step, crates never go
          // quiet, never sleep. (W3 integration, 2026-09-13.)
          if (lastSweep) {
            const posIters = Math.max(1, settings.positionIterations ?? 3)
            for (let pi = 0; pi < posIters; pi++) {
            const d = solveManifoldPosition(manifold.points, descA, descB, manifold)
            const tA = recA.components.transform
            const tB = recB.components.transform
            if (tA && (d.dax || d.day || d.daz)) {
              tA.x = (tA.x ?? 0) + d.dax
              tA.y = (tA.y ?? 0) + d.day
              tA.z = (tA.z ?? 0) + d.daz
            }
            if (tB && (d.dbx || d.dby || d.dbz)) {
              tB.x = (tB.x ?? 0) + d.dbx
              tB.y = (tB.y ?? 0) + d.dby
              tB.z = (tB.z ?? 0) + d.dbz
            }
            // P3.5 angular position correction (XPBD per Müller et al.):
            // apply the ROTATION part of the repair as an Euler delta — this
            // lets a tipped/corner-penetrating body rotate about its contact
            // instead of only translating (the 45° rotation-lock fix).
            // Euler accumulation matches the ω·dt path (same convention).
            if (tA && (d.drax || d.dray || d.draz)) {
              // Merge into the EFFECTIVE rotation (t.rot preferred, else
              // t.rotation) and write back to THAT key — creating a fresh
              // zero-based t.rot would shadow the authored t.rotation.
              const base = tA.rot && typeof tA.rot === 'object' ? tA.rot : (tA.rotation && typeof tA.rotation === 'object' ? tA.rotation : { x: 0, y: 0, z: 0 })
              const key = tA.rot && typeof tA.rot === 'object' ? 'rot' : 'rotation'
              tA[key] = {
                x: (base.x ?? 0) + d.drax,
                y: (base.y ?? 0) + d.dray,
                z: (base.z ?? 0) + d.draz,
              }
            }
            if (tB && (d.drbx || d.drby || d.drbz)) {
              const base = tB.rot && typeof tB.rot === 'object' ? tB.rot : (tB.rotation && typeof tB.rotation === 'object' ? tB.rotation : { x: 0, y: 0, z: 0 })
              const key = tB.rot && typeof tB.rot === 'object' ? 'rot' : 'rotation'
              tB[key] = {
                x: (base.x ?? 0) + d.drbx,
                y: (base.y ?? 0) + d.drby,
                z: (base.z ?? 0) + d.drbz,
              }
            }
            }
          }
        }
        // Contact RAN: a geometric overlap that never yielded an impulse is
        // the zero-pair degenerate (coincident boxes) — it carries no physics
        // and must not report as grounded (which would pin a sinking stack
        // through the v1 floor path).
        if (lastSweep) {
          const fired = out.constraints.some((c) => c.ln > 0)
          if (fired) {
            lastContacts.set(a, (lastContacts.get(a) || 0) + 1)
            lastContacts.set(b, (lastContacts.get(b) || 0) + 1)
          }
          // their absence from lastPairs is handled by the carry-forward at
          // the both-asleep continue above (P4a T4) — nothing extra here.
          lastPairs.push(key); aliveKeys.push(key)
        }
      }
      }
      // Final canonical order for the lastPairs readback.
      lastPairs.sort()
      // Warm-start cache keeps only this step's live pairs.
      warmStart.prune(aliveKeys)
      // W3: the persistent contact cache's temporal prune (sorted-key order —
      // determinism contract) — entries older than maxAgeSteps fall off.
      contactCache.prune(stepIndex)
      stepIndex++

      // 3a. GAMEPLAY-SEMANTICS floor pass (W3-shrunk): a falling body has
      // vy < 0 and rests on top. DELETED from the v1 path (3b manifolds own
      // physics now): ground friction (μ·g·dt tangential decay), the
      // GROUND_OMEGA_DAMP ω decay, and restitution/bounce logic. KEPT: the
      // snap-to-ground POSITION repair, the grounded flag, and the mesh
      // lateral push-out. Runs only when NO manifold contact fired this step
      // for the body (lastContacts empty) — the manifold path handles response
      // whenever a contact fired; this pass is a position-repair aid only.
      for (const id of bodies) {
        const rb = world.entity(id).components['rigid-body']
        // SLEEPING: an asleep body rests frozen — skip the floor path but
        // keep reporting the standing contact that put it to sleep.
        if (sleepingEnabled && sleepManager.isSleeping(id)) {
          const still = grounded.get(id) === true
          if (still) lastContacts.set(id, (lastContacts.get(id) || 0) + 1)
          this.setGrounded(id, still)
          continue
        }
        const shape = shapeFor(id)
        if (!shape) continue
        // W3: manifold contacts fired this step → 3b owns this body's
        // RESPONSE; 3a still runs its landing-snap (a falling body the solver
        // hasn't stopped yet, vy<0, must not keep falling through the floor).
        // But when the body is already resting ON the floor (bottom within
        // snap of restTop) the snap is a no-op — and 3a does NOT zero vy (3b
        // owns velocities; the sleeping candidacy then sees the solver's
        // settled state).
        const snap = this.snapDist()
        const floorTop = this.floorTop(id)
        const solid = typeof this.resolveSolid === 'function' ? this.resolveSolid(shape, id) : null
        const restTop = (floorTop === null)
          ? (solid ? solid.floorTop : null)
          : (solid && solid.floorTop !== null && solid.floorTop > floorTop ? solid.floorTop : floorTop)
        const velComp = getVelocityOf(id)
        let vy = velComp ? velComp.v[1] : 0
        let groundedNow = false
        // W3: a MANIFOLD contact with a vertical-ish normal (|n.y| > 0.5)
        // against a static/floor IS grounded — regardless of the vy sign.
        if (lastContacts.has(id) && restTop !== null &&
            bottomWithinRest(shape, restTop, this.snapDist() * REST_SLOP_FACTOR)) {
          groundedNow = true
        }
        if (restTop !== null && vy <= 0) {
          const bottom = shapeBottomY(shape)
          const onOrAbove = snapToGround(bottom, restTop, snap)
          const overshot = bottom < restTop && bottom >= restTop - snap
          if (onOrAbove !== null || overshot) {
            const t = world.entity(id).components.transform
            t.y = restTop + ((t.y ?? 0) - bottom)
            if (vy < 0) {
              // W3-continuation (2026-09-13): the 3a snap owns landing
              // restitution after all. The manifold path NEVER sees a
              // high-vn landing — the snap fires first (the pre-snap bottom
              // is still up to snapDist above the floor, so the pair doesn't
              // exist yet) and zeroes vy; the pair then only ever re-solves
              // the slow gravity re-penetration (vn0 ≈ −g·dt), whose e-bounce
              // is microscopic. The defaultRestitution pin (bounce peak
              // ~1.2cm above rest off a 4.9m/s impact) requires the snap to
              // reflect: bounce = −e·vy with a rest slop so micro-bounces
              // settle.
              const e = combineRestitution(rb.restitution ?? defRestitution, defRestitution)
              const bounce = -vy * e
              vy = Math.abs(bounce) < this.snapDist() * REST_SLOP_FACTOR ? 0 : bounce
              velComp.v[1] = vy
            } else {
              velComp.v[1] = 0
            }
            groundedNow = velComp.v[1] === 0
            // W3: a body resting on a floor is grounded even when a manifold
            // contact fired this step (3b owns the response; 3a owns the flag).
            if (lastContacts.has(id)) groundedNow = true
            if (groundedNow) lastContacts.set(id, (lastContacts.get(id) || 0) + 1)
          }
        }
        // Mesh lateral push-out (walls), the v1 path. P3.5 pre-work D4: a
        // STATIC body (invMass 0 / all axes position-locked) never takes the
        // push — the mass-weighted rule (zero correction for zero invMass)
        // covers positional repair paths uniformly.
        const idRb = world.entity(id).components['rigid-body'] || {}
        const idLock = new Set(idRb.lockFlags || [])
        const idStatic = resolveMass(id) <= 0 ||
          (idLock.has('posX') && idLock.has('posY') && idLock.has('posZ'))
        if (solid && !idStatic && (solid.pushX || solid.pushZ)) {
          const t = world.entity(id).components.transform
          // W3 epsilon guard: a rotated mesh shape's tri bounds carry float
          // noise (~1e-9), which turns borderline "d < r" checks into
          // self-sustaining phantom pushes of the same order. Pushes below
          // this scale are geometry noise, not collision response.
          const push = Math.hypot(solid.pushX, solid.pushZ)
          if (push > 1e-7) {
            t.x = (t.x ?? 0) + solid.pushX
            t.z = (t.z ?? 0) + solid.pushZ
          }
        }
        this.setGrounded(id, groundedNow)
      }

      // 3a-islands: propagate grounded rest up vertical support chains. A
      // body standing on a GROUNDED body is grounded too — its residual
      // vertical velocity (the solver's Baumgarte kick accumulating down the
      // stack) rests exactly like the floor path rests a body on the ground.
      // Sorted-pair-order cascades to fixpoint (a stack is N bodies deep).
      if (supports.length > 0) {
        const snapRest = this.snapDist() * REST_SLOP_FACTOR
        for (let pass = 0; pass < bodies.length; pass++) {
          let changed = false
          for (const s of supports) {
            // A static support root is grounded by definition: it can never
            // enter the 3a floor path (no rigid-body / mass 0), so without
            // this clause the chain rooted at a static never propagates and
            // a body resting on a pedestal is never grounded (W4, 2026-09-13).
            if (!s.lowerStatic && grounded.get(s.lower) !== true) continue
            // Churn zeroing must run EVERY step for every supported body —
            // including already-grounded uppers (the `grounded.get(s.upper)`
            // continue below skips them, and the solver re-feeds contact
            // churn each step; skipping here is why ω never settled).
            // (W3 integration, 2026-09-13.)
            {
              const wvz = angularVelocityOf(s.upper)
              if (wvz) {
                const wob = Math.hypot(wvz[0], wvz[1], wvz[2])
                if (wob > 0 && wob < 0.15) {
                  wvz[0] = 0; wvz[1] = 0; wvz[2] = 0
                  setAngularVelocityOf(s.upper, wvz)
                }
              }
              const lvz = getVelocityOf(s.upper)
              if (lvz) {
                const lsp = Math.hypot(lvz.v[0], lvz.v[1], lvz.v[2])
                if (lsp > 0 && lsp < 0.15) {
                  lvz.v[0] = 0; lvz.v[1] = 0; lvz.v[2] = 0
                }
              }
            }
            if (grounded.get(s.upper)) continue
            const mv = getVelocityOf(s.upper)
            const vy = mv.v[1]
            // Float-noise tolerance: the settled solver leaves a residual
            // +1e-9..1e-7 vy (never exactly 0), which a strict `vy > 0`
            // gate would treat as "rising" — a body resting on a static
            // support never grounds. Anything below the rest slop is rest,
            // not ascent (W4, 2026-09-13).
            if (vy > snapRest) continue
            const bounce = -vy * s.e
            const restVy = Math.abs(bounce) < snapRest ? 0 : bounce
            if (restVy !== vy) {
              setVelocityOf(s.upper, [mv.v[0], restVy, mv.v[2]])
              changed = true
            }
            grounded.set(s.upper, true)
            lastContacts.set(s.upper, (lastContacts.get(s.upper) || 0) + 1)
            // Grounded state was already published by 3a (which ran before
            // this cascade) — re-publish so a body grounded via a STATIC
            // support root reads grounded this same step (W4, 2026-09-13).
            this.setGrounded(s.upper, true)
            // W3-continuation (2026-09-13): the v1 path damped resting spin
            // (GROUND_OMEGA_DAMP); the 3b manifold solver owns contact
            // response but carries NO resting-spin damping, and the deleted
            // v1 damping was what let stacked bodies go quiet enough to
            // sleep. Restore it here for chain-grounded bodies: the settled
            // solver leaves μ·λt lever-arm torque churn (±0.2 rad/s sustained
            // by the warm-started cone) that angularDamping alone decays far
            // too slowly. Clamp the churn below the sleep threshold.
            const wv = angularVelocityOf(s.upper)
            if (wv) {
              const wob = Math.hypot(wv[0], wv[1], wv[2])
              // Zero (not decay) the churn band: the warm-started tangent
              // cone re-feeds contact torque every step, so a decay factor
              // never reaches quiescence — ω oscillated 0.05–0.10 forever,
              // above the 0.05 sleep threshold. Churn below 0.15 rad/s is
              // settling noise (bodies spin only via real torque here);
              // zeroing it lets the sleep candidacy timer accumulate.
              // (W3 integration, 2026-09-13.)
              if (wob > 0 && wob < 0.15) {
                wv[0] = 0; wv[1] = 0; wv[2] = 0
                setAngularVelocityOf(s.upper, wv)
              }
            }
            // Linear settle: same churn class on the linear velocity of
            // chain-grounded bodies (μ·λt lever churn) — zero below 0.15.
            const lv = getVelocityOf(s.upper)
            if (lv) {
              const lsp = Math.hypot(lv.v[0], lv.v[1], lv.v[2])
              if (lsp > 0 && lsp < 0.15) {
                lv.v[0] = 0; lv.v[1] = 0; lv.v[2] = 0
              }
            }
          }
          if (!changed) break
        }
        // Stack settle: a grounded body's residual penetration is repaired in
        // ONE geometric shot (push the upper body back so its bottom sits at
        // the support surface + the solver slop). The repair quantity is pure
        // geometry — independent of solverIterations — so iteration counts
        // converge to the identical rest configuration.
        for (const s of supports) {
          if (grounded.get(s.upper) !== true) continue
          const rec = world.entity(s.upper)
          const t = rec && rec.components ? rec.components.transform : null
          const lower = world.entity(s.lower)
          const lowerT = lower && lower.components ? lower.components.transform : null
          if (!t || !lowerT) continue
          const upperShape = shapeFor(s.upper)
          const lowerShape = shapeFor(s.lower)
          if (!upperShape || !lowerShape) continue
          const gap = shapeBottomY(upperShape) - (lowerShape.kind === 'box' ? lowerShape.box.maxY : NaN)
          if (!Number.isFinite(gap) || gap >= 0) continue
          // Repair to the slop line (not zero) — matching where the floor
          // path's snap leaves a grounded body.
          if (gap < -SOLVER_SLOP) {
            t.y = (t.y ?? 0) + (-gap - SOLVER_SLOP)
          }
        }
      }

      // 3c. SLEEPING candidacy — ISLAND-LEVEL (P3.5, 2026-09-14): a body
      // never sleeps alone. Build contact islands from the support edges
      // (union-find over dynamic bodies joined by vertical contacts; a body
      // with no support edge is a solo island), then evaluate each island:
      // the timer advances only when EVERY member is quiet in speed, ω, AND
      // solver-correction load (the max accumulated λn the solver needed per
      // unit mass this step — "is the solver still fighting?"). Reaching
      // timeUntilSleep sleeps the ENTIRE island. Deterministic: islands are
      // keyed by their sorted-id canonical group key.
      if (sleepingEnabled) {
        // Per-body correction load: the solver's accumulated normal impulse
        // per unit mass this step (recorded per body during 3b resolution).
        // A resting 1kg body carries ~g·dt ≈ 0.16; the threshold
        // (correctionThreshold, default 0.5) sits well above resting load
        // but below any real push.
        const parent = new Map()
        const find = (id) => {
          let r = id
          while (parent.get(r) !== r) r = parent.get(r)
          let c = id
          while (parent.get(c) !== c) { const nx = parent.get(c); parent.set(c, r); c = nx }
          return r
        }
        const union = (x, y) => { const rx = find(x), ry = find(y); if (rx !== ry) parent.set(ry, rx) }
        for (const id of bodies) {
          if (!parent.has(id)) parent.set(id, id)
        }
        for (const s of supports) {
          if (parent.has(s.upper) && parent.has(s.lower)) union(s.upper, s.lower)
        }
        // P4c: joint edges extend the island graph — bodies joined by a
        // `joint` component are ONE island even when they never touch.
        // Deterministic (sorted ids); only unions existing dynamic bodies
        // (a joint to a static/kinematic/missing entity contributes nothing
        // here — validation flags dangling refs).
        for (const id of bodies) {
          const j = world.entity(id).components.joint
          if (!j || typeof j.other !== 'string') continue
          if (parent.has(id) && parent.has(j.other)) union(id, j.other)
        }
        // Group dynamic bodies by island root → canonical group key.
        const islands = new Map()
        for (const id of bodies) {
          if (sleepManager.isSleeping(id)) continue
          const root = find(id)
          let island = islands.get(root)
          if (!island) {
            const members = []
            for (const other of bodies) {
              if (find(other) === root) members.push(other)
            }
            members.sort()
            island = { key: members.join('+'), ids: members }
            islands.set(root, island)
          }
        }
        // Correction load per body: lastContacts tracks contact events; the
        // per-pair accumulated λn lives in the constraint outputs — sum it
        // per body from the step's resolved pairs (mixedPair-aware: the
        // constraint's λn is the contact's normal impulse this step).
        const correctionLoad = lastStepCorrections
        const islandList = []
        for (const island of islands.values()) {
          const members = island.ids.map((id) => {
            const mv = motion.get(id)
            const m = resolveMass(id)
            const corr = (correctionLoad.get(id) || 0) / (m > 0 ? m : 1)
            return {
              id,
              speed: Math.hypot(mv.v[0], mv.v[1], mv.v[2]),
              angSpeed: Math.hypot(mv.w[0], mv.w[1], mv.w[2]),
              correction: corr,
            }
          })
          // P4c-2: a WELDED island is rigid — one member's residual velocity
          // (e.g. a hanging body's gravity-loaded vy that the floor-clamped
          // anchor can't absorb) is weld-softness, not island motion. Two
          // guards: (1) the island's quietness is judged on the mass-weighted
          // MEAN motion; (2) a body whose TRANSFORM did not move this step is
          // quiet regardless of stored velocity (the position repair holds it
          // in place while bookkeeping velocity stays nonzero — phantom
          // motion).
          const totalMass = members.reduce((s, mm) => s + (resolveMass(mm.id) > 0 ? resolveMass(mm.id) : 0), 0)
          let mean = null
          if (totalMass > 0 && members.length > 1) {
            let mvx = 0, mvy = 0, mvz = 0
            for (const mm of members) {
              const m = resolveMass(mm.id) || 0
              const v = motion.get(mm.id).v
              mvx += v[0] * m; mvy += v[1] * m; mvz += v[2] * m
            }
            mean = [mvx / totalMass, mvy / totalMass, mvz / totalMass]
            for (const mm of members) {
              const v = motion.get(mm.id).v
              mm.speed = Math.hypot(v[0] - mean[0], v[1] - mean[1], v[2] - mean[2])
            }
          }
          for (const mm of members) {
            const t = world.entity(mm.id)?.components?.transform
            const key = `${t?.x ?? 0}|${t?.y ?? 0}|${t?.z ?? 0}`
            const last = lastTransforms.get(mm.id)
            lastTransforms.set(mm.id, key)
            if (last !== undefined && last === key) mm.speed = 0
          }
          islandList.push({
            key: island.key,
            bodies: members,
          })
        }
        islandList.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        sleepManager.markIslandCandidate(islandList, dt)
      }

      // 4. Clear consumed forces + torques. (The 3d velocity-component
      // readback is RETIRED — P3.5 velocity fold: live velocity is motion-map
      // state only; the `velocity` component is legacy authored data and is
      // no longer created or written at runtime. Read live velocity via
      // api.physics.getVelocity / inspect.)
      forces.clear()
      torques.clear()

      // 5. P4a T2: trigger event dispatch — END of step(), in event order
      // enter->stay->exit, each in sorted key order (deterministic; the
      // tracker sorts internally). Listeners are notification-style: an
      // error in one is caught + warned, never breaks the step. The tracker
      // updates EVERY step (even with no listeners) so a late on() never
      // replays stale enters.
      const { enter, stay, exit } = triggerTracker.update(triggerCurKeys)
      {
        const dispatch = (event, keys) => {
          const cbs = [...triggerListeners[event].keys()]
          for (const key of keys) {
            const [a, b] = key.split('|')
            for (const cb of cbs) {
              try { cb({ a, b }) } catch (err) { console.warn(`physics trigger listener error (${event} ${key}):`, err) }
            }
          }
        }
        dispatch('triggerEnter', enter)
        dispatch('triggerStay', stay)
        dispatch('triggerExit', exit)
      }

      // 5b. P4a T4: collision event dispatch — END of step, from the solver
      // pair set (lastPairs is already the POST-layer-filter set: masked-out
      // pairs never entered the pair loop). Reuses the trigger diff
      // machinery (diffTriggerSets — pure, sorted output). Enter/exit only
      // (no collisionStay, per plan). Same listener contract: sorted key
      // order, { a, b } ascending, listener errors caught + warned.
      const colDiff = diffTriggerSets(lastStepPairs, lastPairs)
      {
        const dispatchCol = (event, keys) => {
          const cbs = [...collisionListeners[event].keys()]
          for (const key of keys) {
            const [a, b] = key.split('|')
            for (const cb of cbs) {
              try { cb({ a, b }) } catch (err) { console.warn(`physics collision listener error (${event} ${key}):`, err) }
            }
          }
        }
        dispatchCol('collisionEnter', colDiff.enter)
        dispatchCol('collisionExit', colDiff.exit)
      }
      lastStepPairs = lastPairs
    },

    /**
     * One read verb for the AI feedback loop: what did I build?
     * @returns {{ shape, velocity, mass, grounded, contacts, sleeping } | null}
     */
    inspect(id) {
      worldRef = world
      motionRef = motion
      const rec = world.entity(id)
      if (!rec || !rec.components || !rec.components['rigid-body']) return null
      const rb = rec.components['rigid-body']
      const vel = getVelocityOf(id)
      const v = vel ? vel.v : [0, 0, 0]
      return {
        shape: shapeFor(id),
        velocity: [...v],
        mass: resolveMass(id),
        grounded: grounded.get(id) === true,
        contacts: lastContacts.get(id) || 0,
        sleeping: false, // P3
        isKinematic: !!rb.isKinematic,
        angularVelocity: [...(angularVelocityOf(id) || [0, 0, 0])],
        // P4c-2: this body's LIVE joint state (the constraint actually being
        // solved — the authored component data is one half of each pair).
        // The pair is live when its canonical key is not in brokenJoints.
        joints: world
          .query({ has: ['joint'] })
          .filter((jid) => {
            const j = world.entity(jid)?.components?.joint
            if (!j || typeof j.other !== 'string' || j.other === jid) return false
            const rec = world.entity(j.other)
            if (!rec || !rec.components || !rec.components['rigid-body']) return false
            const a = jid < j.other ? jid : j.other
            const b = jid < j.other ? j.other : jid
            return !brokenJoints.has(`${a}|${b}`)
          })
          .map((jid) => world.entity(jid).components.joint),
      }
    },

    /**
     * Nearest static-body hit along a ray (or null). Shape-aware: floors are
     * boxes (raycastAABB over every floor-tagged collider), and SOLID MESH
     * bodies (terrain / a model- or plane-render 'Match render mesh' collider
     * — their real triangle surfaces) are raycast too, so a raycast against a
     * ground plane or terrain hits the actual surface.
     * @param {{ox,oy,oz,dx,dy,dz}} ray
     * @param {number} [maxDist]
     * @returns {{ t: number, nx: number, ny: number, nz: number } | null}
     */
    raycast(ray, maxDist, opts) {
      // P4a T1: optional layer mask (array of layer names). No opts = all
      // layers (previous behavior). Pure-int decision via layerFilter.
      const layerNames = normalizeLayers(settings.layers).names
      const maskBits = (opts && opts.mask !== undefined) ? maskFrom(layerNames, opts.mask) : -1
      const pass = (id) => {
        if (maskBits === -1) return true
        const col = world.entity(id)?.components?.collider || {}
        return layerFilter(
          { layerIndex: 0, mask: maskBits },
          { layerIndex: resolveLayerIndex(layerNames, col.layer), mask: -1 },
        )
      }
      let best = null
      for (const id of this.staticBodies()) {
        if (!pass(id)) continue
        const hit = raycastShape(ray, shapeFor(id), maxDist)
        if (hit && (best === null || hit.t < best.t)) best = hit
      }
      for (const id of this.solidBodies()) {
        if (!pass(id)) continue
        const hit = raycastShape(ray, this.shape(id), maxDist)
        if (hit && (best === null || hit.t < best.t)) best = hit
      }
      return best
    },

    // ------------------------------------------------------------------
    // P4a T3: overlap queries — overlapSphere / overlapBox / overlapPoint.
    // The FULL collider surface: every entity with a `collider` component
    // (statics + dynamics + kinematics) is queryable — TRIGGERS INCLUDED,
    // they are colliders (unlike raycast, which sees statics + solids).
    // Geometry only: works with physics disabled (setEnabled(false)) — no
    // step-time state is consulted. Boxes are AXIS-ALIGNED: the engine's
    // collider world resolves rotated boxes to mesh shapes tested via their
    // world bounds, so a query box never needs a rotation. Results are
    // sorted by id ascending, [{ id }] — empty when nothing overlaps.
    // ------------------------------------------------------------------

    /**
     * All collider entities whose shape intersects the sphere.
     * @param {{x,y,z} | [x,y,z]} pos world position ({x,y,z} or array — both accepted)
     * @param {number} radius > 0
     * @param {{ mask?: string[], exclude?: string[] }} [opts]
     *   mask: layer NAMES (same semantics as raycast opts.mask — a candidate
     *   passes when its layer bit is in the mask); exclude: entity ids skipped.
     * @returns {{ id: string }[]} sorted by id ascending
     * @throws TypeError with field-level messages on invalid args.
     */
    overlapSphere(pos, radius, opts) {
      const c = readVec3Arg(pos, 'pos')
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
        throw new TypeError(`radius must be a finite number > 0 (got ${radius})`)
      }
      return this._overlap({ x: c.x, y: c.y, z: c.z }, 'sphere', { radius }, opts)
    },

    /**
     * All collider entities whose shape intersects the axis-aligned box.
     * @param {{x,y,z} | [x,y,z]} pos world position ({x,y,z} or array)
     * @param {{x,y,z} | [x,y,z]} halfExtents (all components >= 0)
     * @param {{ mask?: string[], exclude?: string[] }} [opts]
     * @returns {{ id: string }[]} sorted by id ascending
     * @throws TypeError with field-level messages on invalid args.
     */
    overlapBox(pos, halfExtents, opts) {
      const c = readVec3Arg(pos, 'pos')
      const h = readVec3Arg(halfExtents, 'halfExtents')
      if (h.x < 0 || h.y < 0 || h.z < 0) {
        throw new TypeError(`halfExtents components must be >= 0 (got ${JSON.stringify(h)})`)
      }
      return this._overlap({ x: c.x, y: c.y, z: c.z }, 'box', { halfExtents: h }, opts)
    },

    /**
     * The collider entities whose shapes CONTAIN the point (inclusive — a
     * point exactly on a face/edge/corner hits). Implemented as a degenerate
     * zero-extent box through the same overlap path.
     * @param {{x,y,z} | [x,y,z]} p world point ({x,y,z} or array)
     * @param {{ mask?: string[], exclude?: string[] }} [opts]
     * @returns {{ id: string }[]} sorted by id ascending
     * @throws TypeError with field-level messages on invalid args.
     */
    overlapPoint(p, opts) {
      const c = readVec3Arg(p, 'p')
      return this._overlap({ x: c.x, y: c.y, z: c.z }, 'point', {}, opts)
    },

    /** Shared overlap pipeline: resolve opts (mask via the T1 layer helpers,
     * exclude) then run the pure collectOverlaps core over every collider. */
    _overlap(center, type, params, opts) {
      const layerNames = normalizeLayers(settings.layers).names
      const maskBits = (opts && opts.mask !== undefined) ? maskFrom(layerNames, opts.mask) : -1
      const exclude = (opts && opts.exclude !== undefined) ? opts.exclude : null
      const exclSet = exclude ? new Set(exclude) : null
      const pass = (id) => {
        if (exclSet && exclSet.has(id)) return false
        if (maskBits === -1) return true
        const col = world.entity(id)?.components?.collider || {}
        return layerFilter(
          { layerIndex: 0, mask: maskBits },
          { layerIndex: resolveLayerIndex(layerNames, col.layer), mask: -1 },
        )
      }
      const candidates = world.query({ has: 'collider' })
      return collectOverlaps({ center, type, params, candidates, shapeFor, filter: pass })
    },

    /**
     * P4d — the projectile gameplay verb: cast the entity's collider shape
     * along `delta` ([dx,dy,dz]) against EVERY OTHER collider-bearing body
     * (statics + dynamics + kinematics; triggers excluded — they are
     * non-solid by definition), layer/mask-aware via the P4a filter (the
     * CASTER's mask gates which candidates it can hit). Returns the nearest
     * first-contact `{ t (0..1), nx, ny, nz, id }` or `null`. THIN wrapper
     * over `sweepShape` (the P4b primitive) via the shared
     * `sweepProjectileOf` — no new sweep math. Sorted-candidate
     * deterministic; this is the EXACT cast the `ccd: true` integration
     * path performs per step for swept rigid bodies.
     * @param {string} id the caster entity (needs collider + transform)
     * @param {number[]} delta [dx, dy, dz] displacement for the sweep
     * @returns {{ t: number, nx: number, ny: number, nz: number, id: string } | null}
     */
    sweepProjectile(id, delta) {
      const shape = shapeFor(id)
      if (!shape) return null
      return sweepProjectileOf(id, shape, delta)
    },
  }
}

/**
 * `dynamic-body` — makes an entity a falling rigid body. Reads the engine's
 * world gravity (via api.physics), applies it to a `velocity` component (vy,
 * down-positive), integrates the transform's y, and snaps to the floor. Reports
 * grounded through api.physics.setGrounded so behaviors can read isOnFloor.
 *
 * Gravity is off (bodies float) when api.physics is absent, physics is disabled,
 * or the entity's own `enabled:false`.
 */
export const dynamicBodyScript = {
  params: {
    gravityScale: { type: 'number', default: 1 },
    enabled: { type: 'boolean', default: true },
  },
  update(dt, api, id, p) {
    if (!api.physics) return // no physics handle wired -> no-op
    // P1 shim: an entity carrying `rigid-body` is driven by the rigid-body
    // pipeline (api.physics.step) — never integrate twice.
    const rec = api.entity(id)
    if (rec && rec.components && rec.components['rigid-body']) return
    if (!api.physics.enabled() || p.enabled === false) return
    if (!rec || !rec.components) return
    const tf = rec.components.transform
    if (!tf) return
    const col = rec.components.collider || {}

    // Vertical velocity lives in a `velocity` component (lazily created so the
    // object persists across steps; other behaviors can read/clear it). An
    // entity that carries an AUTHORED `velocity` component (the rigid
    // pipeline's authored-only data) is left untouched.
    let vel = rec.components.velocity
    if (!vel) vel = api.world.setComponent(id, 'velocity', { vy: 0 })
    let vy = vel.vy ?? 0

    // Gravity (world value * per-body scale).
    vy = applyGravity(vy, dt, api.physics.gravity() * (p.gravityScale ?? 1))

    // Integrate vertical position (down-positive vy decreases the entity's y).
    tf.y -= vy * dt

    // Resolve against the floor: snap if on/near the top, only when not rising.
    // The rest height honors the collider SHAPE (box half-extent vs sphere/pill
    // radius vs cylinder height/2), so a sphere rests on its radius. The shape's
    // bottom is its absolute lowest Y, so a collider offset by its local `center`
    // (e.g. raised above the origin) still rests on the floor correctly.
    const shape = api.physics.shape(id) || shapeFromCollider(col)
    // Distance from the entity transform origin down to the shape's lowest point.
    // == shapeBottom for a centered shape; shifted by a vertical `center` offset.
    const restOffset = (tf.y ?? 0) - shapeBottomY(shape)
    const snap = api.physics.snapDist()
    const floorTop = api.physics.floorTop(id)

    // Solid mesh collision: push the body laterally out of any static mesh body
    // it penetrates, and let it rest on a mesh surface (roof) too.
    const solid = typeof api.physics.resolveSolid === 'function' ? api.physics.resolveSolid(shape) : null
    if (solid && (solid.pushX || solid.pushZ)) {
      tf.x = (tf.x ?? 0) + solid.pushX
      tf.z = (tf.z ?? 0) + solid.pushZ
    }
    // Rest on the higher of the floor top and any mesh roof under the body.
    const restTop = (floorTop === null)
      ? (solid ? solid.floorTop : null)
      : (solid && solid.floorTop !== null && solid.floorTop > floorTop ? solid.floorTop : floorTop)

    let groundedNow = false
    if (restTop !== null && vy >= 0) {
      const bottom = shapeBottomY(shape)
      const onOrAbove = snapToGround(bottom, restTop, snap)
      const overshot = bottom < restTop && bottom >= restTop - snap
      if (onOrAbove !== null || overshot) {
        tf.y = restTop + restOffset
        vy = 0
        groundedNow = true
      }
    }
    vel.vy = vy
    api.physics.setGrounded(id, groundedNow)
  },
}

/** All physics built-in gameplay tools, keyed by script name. */
export const PHYSICS_BUILTIN_SCRIPTS = {
  'dynamic-body': dynamicBodyScript,
  controller: characterControllerScript,
}

// ---------------------------------------------------------------------------
// P1 rigid-body helpers (module scope). `worldRef` is the live World of the
// createPhysicsApi call that is currently stepping — set before the pipeline
// runs (the API is the only caller; single-threaded per game instance).
// ---------------------------------------------------------------------------

let worldRef = null
// P3: the live per-api motion Map (id -> { v, w }) — bound alongside worldRef
// (the API is the only caller; single-threaded per game instance).
let motionRef = null

/** Seed a body's internal motion state on first sight: v from the AUTHORED
 * `velocity` component (finite 3-array) else zeros; ω from the authored
 * `rigid-body.angularVelocity` (finite 3-array) else zeros. The `velocity`
 * component is authored-only — never created, never written at runtime. */
function seedMotion(id) {
  const m = { v: [0, 0, 0], w: [0, 0, 0] }
  const rec = worldRef.entity(id)
  if (rec && rec.components) {
    // P3.5 velocity fold: authored spawn velocity lives on `rigid-body`
    // (array [vx,vy,vz]). Precedence: rb.velocity seeds FIRST, then a legacy
    // `velocity` component OVERRIDES — in a merged archetype instance the component is
    // the per-instance override (more specific than the archetype's
    // rb.velocity), and normalizeScene migrates plain rigid entities so the
    // component only survives where it carries override data (or legacy
    // dynamic-body).
    const rb = rec.components['rigid-body']
    if (rb && Array.isArray(rb.velocity) && rb.velocity.length === 3 && rb.velocity.every(Number.isFinite)) {
      m.v = [rb.velocity[0], rb.velocity[1], rb.velocity[2]]
    }
    const vc = rec.components.velocity
    if (vc && Array.isArray(vc.v) && vc.v.length === 3 && vc.v.every(Number.isFinite)) {
      m.v = [vc.v[0], vc.v[1], vc.v[2]]
    }
    if (rb && Array.isArray(rb.angularVelocity) && rb.angularVelocity.length === 3 &&
        rb.angularVelocity.every(Number.isFinite)) {
      m.w = [rb.angularVelocity[0], rb.angularVelocity[1], rb.angularVelocity[2]]
    }
  }
  motionRef.set(id, m)
  return m
}

/** Internal motion entry ({ v, w }) — seeds lazily on first sight. */
function getVelocityOf(id) {
  let m = motionRef ? motionRef.get(id) : undefined
  if (!m) m = seedMotion(id)
  return m
}

/** Write a velocity array into the internal motion state. The motion map is
 * authoritative — live velocity is NEVER mirrored into a component (P3.5
 * velocity fold: the `velocity` component is legacy authored data only). */
function setVelocityOf(id, v) {
  const m = getVelocityOf(id)
  m.v = [v[0], v[1], v[2]]
}

/** {vx,vy,vz} descriptor for the solver (fresh object, no live refs). */
function velDesc(id) {
  const m = getVelocityOf(id)
  return { vx: m.v[0], vy: m.v[1], vz: m.v[2] }
}

/** Live angular velocity: the internal motion state's ω. Before first sight a
 * rigid body seeds from its AUTHORED ω — the round-trip contract (scene →
 * loadScene → getAngularVelocity); non-rigid or missing entities read null. */
function angularVelocityOf(id) {
  const rec = worldRef.entity(id)
  if (!rec || !rec.components || !rec.components['rigid-body']) return null
  const m = getVelocityOf(id)
  return m.w
}

/** Write an ω array into the internal motion state (no component writes). */
function setAngularVelocityOf(id, w) {
  const m = getVelocityOf(id)
  m.w = [w[0], w[1], w[2]]
}

/** Broadphase AABB (plain min/max object) from a positioned shape. A pill is
 * its capsule box approximation: center ± (radius, height/2, radius). */
function aabbOfShape(s) {
  if (!s) return null
  if (s.kind === 'box') {
    const b = s.box
    return { minX: b.cx - b.hx, maxX: b.cx + b.hx, minY: b.cy - b.hy, maxY: b.cy + b.hy, minZ: b.cz - b.hz, maxZ: b.cz + b.hz }
  }
  if (s.kind === 'sphere') {
    const c = s.sphere
    return { minX: c.x - c.radius, maxX: c.x + c.radius, minY: c.y - c.radius, maxY: c.y + c.radius, minZ: c.z - c.radius, maxZ: c.z + c.radius }
  }
  if (s.kind === 'pill') {
    const c = s.capsule
    return { minX: c.x - c.radius, maxX: c.x + c.radius, minY: c.y - c.height / 2, maxY: c.y + c.height / 2, minZ: c.z - c.radius, maxZ: c.z + c.radius }
  }
  if (s.kind === 'mesh') {
    return { minX: s.minX, maxX: s.maxX, minY: s.minY, maxY: s.maxY, minZ: s.minZ, maxZ: s.maxZ }
  }
  return null
}

/** The authored `rigid-body.angularVelocity` (default [0,0,0]; non-array
 * guarded) — kinematic bodies carry it verbatim, dynamics seed from it. */
function authoredAngularVelocity(rb) {
  const w = rb.angularVelocity
  return Array.isArray(w) && w.length === 3 ? [w[0], w[1], w[2]] : [0, 0, 0]
}

/** Add helper. */
function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }

/** Scale helper. */
function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s] }

/** Reject non-finite vectors (forces/impulses/velocities never carry NaN). */
function assertFiniteVec(v) {
  if (!Array.isArray(v) || v.length !== 3 ||
      !v.every((c) => typeof c === 'number' && Number.isFinite(c))) {
    throw new TypeError('expected a finite [x, y, z] vector')
  }
}

/** W3 helper: is a shape's bottom within `tol` of the rest top (i.e. the
 * body is resting on that surface)? Tolerant of the tiny sink-in the solver
 * leaves at rest (bottom can dip slightly BELOW restTop). */
function bottomWithinRest(shape, restTop, tol) {
  if (!shape) return false
  const bottom = shapeBottomY(shape)
  return Math.abs(bottom - restTop) <= tol
}

/**
 * Mass resolution: explicit mass wins; else density × collider volume.
 * Volumes: box 8hx·hy·hz; sphere (4/3)πr³; pill cylinder core + two caps;
 * cylinder → its bounding AABB (documented approximation).
 */
function resolveMass(id) {
  const rec = worldRef.entity(id)
  if (!rec || !rec.components) return 0
  const rb = rec.components['rigid-body'] || {}
  if (rb.mass > 0) return rb.mass
  const density = rb.density ?? 1
  if (!(density > 0)) return 0
  return density * colliderVolume(rec.components.collider)
}

/** Collider volume by shape (matches the test-pinned formulas).
 * A cylinder maps (shapeFromCollider) to a box AABB of hx=radius, hy=height/2,
 * hz=radius — the test-pinned volume is that AABB's 8·hx·hy·hz. */
function colliderVolume(c) {
  if (!c) return 0
  const shape = c.shape === undefined ? 'box' : c.shape
  if (shape === 'sphere') return (4 / 3) * Math.PI * (c.radius ?? 0.5) ** 3
  if (shape === 'pill') {
    // pill default = the unit render pill's radius; r0.5 @ h1 is a degenerate sphere
    const r = c.radius ?? 0.25
    const h = c.height ?? 1
    const coreHalf = Math.max(h / 2 - r, 0)
    return Math.PI * r * r * 2 * coreHalf + (4 / 3) * Math.PI * r ** 3
  }
  if (shape === 'cylinder') {
    const r = c.radius ?? 0.5
    const h = c.height ?? 1
    return 8 * r * (h / 2) * r // the mapped bounding AABB
  }
  // box (default)
  return 8 * (c.hx ?? 0.5) * (c.hy ?? 0.5) * (c.hz ?? 0.5)
}

/** P4c-2: one live `joint` component per canonical pair. A pair collected
 * from entity A (its `other` = B) shadows a mirrored B→A component — the
 * same constraint solved once. Deterministic: pair array sorted by
 * (pairKey, type) before any solve. */
function jointPairsOf(world, brokenJoints) {
  const out = []
  const seen = new Set()
  const ids = world.query({ has: ['joint'] })
  for (const id of ids) {
    const j = world.entity(id)?.components?.joint
    if (!j || typeof j.other !== 'string' || j.other === id) continue
    const rec = world.entity(j.other)
    if (!rec || !rec.components || !rec.components['rigid-body']) continue
    const a = id < j.other ? id : j.other
    const b = id < j.other ? j.other : id
    const key = `${a}|${b}`
    if (seen.has(key) || brokenJoints.has(key)) continue
    seen.add(key)
    out.push({ a, b, key, joint: j, ownerId: id })
  }
  out.sort((x, y) => {
    if (x.key !== y.key) return x.key < y.key ? -1 : 1
    const tx = x.joint.type ?? '', ty = y.joint.type ?? ''
    return tx < ty ? -1 : tx > ty ? 1 : 0
  })
  return out
}


export const PHYSICS_BUILTIN_SCRIPT_METAS = [
  {
    name: 'dynamic-body',
    label: 'Dynamic body',
    description: 'A falling body: applies the world gravity + floor snapping each step. Pair with a collider.',
    params: dynamicBodyScript.params,
  },
]
