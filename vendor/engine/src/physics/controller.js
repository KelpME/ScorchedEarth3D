/**
 * P4b-2 — the kinematic character controller script (`controller` built-in).
 *
 * Movement model: SWEEP-BASED, never translate-and-correct. Each fixed step:
 *   1. Read intent { moveX, moveZ } (the input layer writes
 *      `api.controllerIntent.<id>` or the params) → desired planar velocity
 *      (moveSpeed · intent, normalized).
 *   2. Vertical: gravity accumulates a fall velocity; grounded snaps down via
 *      a downward sweep (≤ snapDist) and zeroes the fall velocity.
 *   3. Horizontal: sweep the collider along the per-step displacement — a hit
 *      PROJECTS the velocity onto the hit plane (wall slide) and stops at the
 *      face; remaining distance re-sweeps (slide along the second axis).
 *      A hit face whose normal tilts beyond slopeLimitDeg is NOT climbed
 *      (slope rejection); a LEDGE whose top is within stepHeight is stepped
 *      onto (teleport-free: the sweep continues at the raised height).
 *   4. Push (P4b-3): a sweep that ends overlapping a DYNAMIC body applies the
 *      controller's contact-relative velocity to it as an impulse (players
 *      shove crates) — the controller itself never slows.
 *   5. Carry (P4b-4): grounded on a KINEMATIC platform (isKinematic
 *      rigid-body with velocity) and `platformCarry` → inherit the platform's
 *      planar velocity that step.
 *
 * Grounded state reports through `api.physics.setGrounded(id, v)` (the same
 * channel `dynamic-body` uses; read via `api.physics.isOnFloor(id)`).
 * Planar speed is exposed via `api.controllerSpeed(id)` for the locomotion-
 * clip law (plans/RESEARCH-IK-FOOTLOCK.md): the character stays kinematic;
 * feet are an animation-layer concern. Locomotion is NEVER solved with
 * solver friction.
 *
 * The script is pure w.r.t. the engine: all physics decisions go through
 * `api.physics` handles (sweepShape, shapeFor, setGrounded) — no internals.
 */

import { sweepShape } from './sweeps.js'

const GRAVITY = 9.81

/** Per-controller live state (fall velocity, carry velocity, last speed).
 * Exported: the physics api reads it for `controllerSpeed` (locomotion law). */
export const controllerState = new Map() // id -> { fallV, carryX, carryZ, speed }
/** The script's own alias. */
const state = controllerState

/** Reset per-entity controller state on scene load (no leaks). */
export function resetControllerState() {
  state.clear()
}

/** The max |normal.y| a surface may have and still count as walkable ground
 * vs a wall: cos(slopeLimitDeg). Enforced from the component's slopeLimitDeg
 * (default 45° → 0.7071). Clamped to [0°, 89°]. Exported for tests. */
export function slopeNyLimitFor(cfg) {
  const deg = Math.min(89, Math.max(0, cfg?.slopeLimitDeg ?? 45))
  return Math.cos((deg * Math.PI) / 180)
}
const slopeNyLimit = slopeNyLimitFor

export const characterControllerScript = {
  params: {
    enabled: { type: 'boolean', default: true },
  },

  update(dt, api, id, p) {
    if (!api || !api.physics) return
    if (p.enabled === false) return
    const rec = api.entity ? api.entity(id) : null
    const comps = rec && rec.components
    if (!comps || !comps['character-controller'] || !comps.collider) return
    if (comps['rigid-body'] && !comps['rigid-body'].isKinematic) return // controllers are kinematic; a dynamic body with the component is a config error we ignore
    const physics = api.physics
    const cfg = comps['character-controller']
    const t = comps.transform
    if (!t) return

    const st = state.get(id) || { fallV: 0, carryX: 0, carryZ: 0, speed: 0 }
    state.set(id, st)

    // ---- intent: api.controllerIntent.<id> { moveX, moveZ } (input layer);
    // a flat { moveX, moveZ } (no per-id map) is also accepted.
    const map = api.controllerIntent || {}
    const intent = map[id] || map || {}
    let ix = intent.moveX || 0
    let iz = intent.moveZ || 0
    const ilen = Math.sqrt(ix * ix + iz * iz)
    if (ilen > 1) { ix /= ilen; iz /= ilen } // normalize sticks past 1
    const speed = cfg.moveSpeed ?? 4

    // ---- shapes
    const shape = physics.shape(id)
    if (!shape) return

    // ---- 2. vertical: gravity + ground snap via downward sweep
    let grounded = false
    let groundHit = null // the sweep hit that grounded us (down OR snap)
    const down = [0, -Math.max(st.fallV * dt, 0.0001), 0]
    const candidates = sweepCandidates(physics, id)
    const downHit = sweepShape(shape, down, candidates)
    const snapDist = cfg.snapDist > 0 ? cfg.snapDist : (physics.snapDist ? physics.snapDist() : 0.15)
    if (downHit && downHit.t <= 1) {
      groundHit = downHit
      // Land on the surface: move by the fall distance AND lift out of any
      // penetration. The first update of a scene can sink the controller
      // slightly (no candidates yet → gravity integrated unswept); the
      // grounded branch must RESTORE surface contact, not merely stop the
      // fall — otherwise the body stays penetrated and every horizontal
      // sweep reads ground-graze (walking through walls).
      const drop = (st.fallV * dt) * downHit.t
      t.y -= drop
      st.fallV = 0
      grounded = true
      if (downHit.ny > slopeNyLimit(cfg) && downHit.t === 0) {
        // Touching/penetrating the ground: lift the bottom back ONTO the
        // surface. Direct geometry: groundTop - shapeBottom = the lift that
        // restores exact contact (0 when merely touching).
        const gShape = (() => { const s = physics.shape(downHit.id); return s })()
        if (gShape) {
          const gTop = gShape.kind === 'box' ? gShape.box.maxY
            : gShape.kind === 'sphere' ? gShape.sphere.y + gShape.sphere.radius
            : gShape.kind === 'pill' ? gShape.capsule.y + gShape.capsule.height / 2
            : gShape.kind === 'mesh' ? gShape.maxY : null
          const myShape = physics.shape(id)
          const myBottom = myShape.kind === 'box' ? myShape.box.minY
            : myShape.kind === 'sphere' ? myShape.sphere.y - myShape.sphere.radius
            : myShape.kind === 'pill' ? myShape.capsule.y - myShape.capsule.height / 2
            : myShape.kind === 'mesh' ? myShape.minY : null
          if (gTop !== null && myBottom !== null && gTop > myBottom) t.y += gTop - myBottom
        }
      }
    } else {
      // No ground within the fall distance → fall (with snap catch).
      st.fallV += GRAVITY * dt
      const fallDelta = st.fallV * dt
      const snapHit = sweepShape(shape, [0, -fallDelta - snapDist, 0], candidates)
      if (snapHit && snapHit.t <= 1) {
        groundHit = snapHit
        t.y -= fallDelta * snapHit.t
        st.fallV = 0
        grounded = true
      } else {
        t.y -= fallDelta
      }
    }

    // ---- 5. platform carry (before horizontal move — the platform's motion
    // this step carries the controller with it).
    let carryX = 0, carryZ = 0
    if (grounded && cfg.platformCarry !== false && groundHit) {
      const groundId = groundHit.id
      const gRec = api.entity ? api.entity(groundId) : null
      const gRb = gRec && gRec.components && gRec.components['rigid-body']
      if (gRb && gRb.isKinematic && gRb.velocity) {
        carryX = gRb.velocity[0] || 0
        carryZ = gRb.velocity[2] || 0
      }
    }

    // ---- 3. horizontal: sweep + slide (+ step-up)
    let vx = (ix * speed) + carryX
    let vz = (iz * speed) + carryZ
    let dx = vx * dt
    let dz = vz * dt

    if (dx !== 0 || dz !== 0) {
      const moveShape = physics.shape(id)
      let px = dx, pz = dz
      for (let iter = 0; iter < 3 && (px !== 0 || pz !== 0); iter++) {
        const hit = sweepShape(moveShape, [px, 0, pz], candidates)
        if (!hit || hit.t >= 1) {
          // Clear path: move the FULL remaining delta this iteration.
          t.x += px
          t.z += pz
          px = 0; pz = 0
          break
        }
        if (hit.t > 0) {
          // Move to the face.
          t.x += px * hit.t
          t.z += pz * hit.t
        }
        // A mostly-VERTICAL hit normal during a horizontal sweep is ground
        // contact (a floor graze from slight sinking), not a wall — the
        // full remaining motion continues (ground separation is the vertical
        // system's job). Only surfaces STEEPER than slopeLimitDeg block/slide;
        // walkable slopes are climbed via the sweep's slide.
        if (Math.abs(hit.ny) > slopeNyLimit(cfg)) {
          t.x += px
          t.z += pz
          px = 0; pz = 0
          break
        }
        // Step-up: a low ledge (its top within stepHeight above the feet)
        // is climbed instead of blocking. After raising, CONTINUE the loop
        // — the remaining px/pz re-sweeps from the raised position.
        if (tryStepUp(api, physics, id, t, comps, cfg, hit, candidates)) {
          continue
        }
        // P4b-3: the hit entity is a DYNAMIC body → SHOVE it (contact-relative
        // velocity as an impulse) and do NOT slide — re-sweep; the crate has
        // been given velocity and moves out of the way. The controller keeps
        // its speed (kinematic). Statics/kinematics still block+slide.
        {
          const hitRec = api.entity ? api.entity(hit.id) : null
          const hitRb = hitRec && hitRec.components && hitRec.components['rigid-body']
          if (hitRb && !hitRb.isKinematic) {
            if (physics.applyImpulse) {
              // Δv = J/m with J scaled to transfer ~controller speed.
              const mass = hitRb.mass > 0 ? hitRb.mass : 1
              const jx = (vx - 0) * mass // relative planar velocity → impulse
              const jz = (vz - 0) * mass
              physics.applyImpulse(hit.id, [jx, 0, jz])
            }
            // Wait one step for the crate to move out of the way.
            px = 0; pz = 0
            break
          }
        }
        // Project the remaining motion onto the hit plane (wall slide).
        const n = [hit.nx, hit.ny, hit.nz]
        const dot = px * n[0] + pz * n[2]
        px = (px - dot * n[0]) * (1 - hit.t)
        pz = (pz - dot * n[2]) * (1 - hit.t)
        // Kill sub-pixel residue.
        if (Math.abs(px) < 1e-9) px = 0
        if (Math.abs(pz) < 1e-9) pz = 0
      }
    }

    // ---- 4. push dynamics out of the way
    pushDynamics(api, physics, id, vx, vz)

    // ---- grounded + speed report
    if (physics.setGrounded) physics.setGrounded(id, grounded)
    else if (!grounded && physics.setGrounded) physics.setGrounded(id, false)
    st.speed = Math.sqrt(vx * vx + vz * vz)
    st.carryX = carryX
    st.carryZ = carryZ
  },
}

/** Sweep candidates: every OTHER collider-bearing entity (statics, dynamics,
 * kinematics — NOT the controller itself), ids ascending for determinism. */
function sweepCandidates(physics, selfId) {
  const out = []
  const ids = physics.colliderIds ? physics.colliderIds() : []
  for (const cid of ids) {
    if (cid === selfId) continue
    const s = physics.shape(cid)
    if (s) out.push({ id: cid, shape: s })
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

/** Step-up: after a horizontal sweep hit, if the obstacle's top is within
 * stepHeight above the controller's feet, raise the controller onto it and
 * continue the remaining motion. Returns true when a step was performed. */
function tryStepUp(api, physics, id, t, comps, cfg, hit, candidates) {
  const stepHeight = cfg.stepHeight ?? 0.3
  if (stepHeight <= 0) return false
  const obstacle = api.entity ? api.entity(hit.id) : null
  const oc = obstacle && obstacle.components && obstacle.components.collider
  if (!oc) return false
  const oShape = physics.shape(hit.id)
  if (!oShape) return false
  const top = oShape.kind === 'box' ? oShape.box.maxY
    : oShape.kind === 'sphere' ? oShape.sphere.y + oShape.sphere.radius
    : oShape.kind === 'pill' ? oShape.capsule.y + oShape.capsule.height / 2
    : oShape.kind === 'mesh' ? oShape.maxY : null
  if (top === null) return false
  const myShape = physics.shape(id)
  const myBottom = myShape.kind === 'box' ? myShape.box.minY
    : myShape.kind === 'sphere' ? myShape.sphere.y - myShape.sphere.radius
    : myShape.kind === 'pill' ? myShape.capsule.y - myShape.capsule.height / 2
    : myShape.kind === 'mesh' ? myShape.minY : null
  if (myBottom === null) return false
  const rise = top - myBottom
  if (rise <= 0 || rise > stepHeight) return false
  // Steep-face guard: the hit normal must be mostly horizontal (a wall, not
  // a walkable slope) — a slope within the limit is climbed by the sweep's
  // slide, not by stepping.
  if (Math.abs(hit.ny) > slopeNyLimit(cfg)) return false
  // Raise so the feet rest on the obstacle top (+ epsilon), then retry.
  t.y += rise + 1e-4
  return true
}

/** P4b-3: push DYNAMIC bodies the controller overlaps out of its way —
 * apply the controller's planar velocity as an impulse (Δv = J/m). The
 * controller never slows (kinematic). */
function pushDynamics(api, physics, selfId, vx, vz) {
  if (vx === 0 && vz === 0) return
  const ids = physics.colliderIds ? physics.colliderIds() : []
  const selfShape = physics.shape(selfId)
  if (!selfShape) return
  for (const cid of ids) {
    if (cid === selfId) continue
    const rec = api.entity ? api.entity(cid) : null
    const rb = rec && rec.components && rec.components['rigid-body']
    if (!rb || rb.isKinematic) continue // only DYNAMIC bodies get pushed
    const s = physics.shape(cid)
    if (!s) continue
    if (physics.overlapsSelf) { /* not available */ }
    // Cheap overlap via the sweep's zero-delta form.
    const hit = sweepShape(selfShape, [0, 0, 0], [{ id: cid, shape: s }])
    if (!hit) continue
    if (physics.applyImpulse) physics.applyImpulse(cid, [vx, 0, vz])
  }
}
