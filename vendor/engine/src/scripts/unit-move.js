/**
 * Engine built-in `unit-move` — THE movement primitive (Phase P2-N2).
 *
 * The roadmap rule is "never duplicate the movement primitive": every steering
 * / locomotion script (nav-agent, and anything that moves an entity toward a
 * point) COMPOSES `stepToward` from here instead of re-deriving step math.
 *
 * `stepToward` is a pure, deterministic XZ step with one hard rule: it NEVER
 * overshoots the arrive ring. The step length is
 * `min(speed·dt, max(0, distance − arriveDistance))`, so a fast mover stops
 * exactly on the ring instead of oscillating through the target. Y is never
 * touched — callers own vertical placement.
 *
 * Pure data + closure state; no DOM / no Three import — Node-vitestable.
 */

/**
 * Move `current` toward `target` in XZ without overshooting the arrive ring.
 *
 * @param {{x: number, z: number}} current  current XZ position
 * @param {{x: number, z: number}} target   target XZ position
 * @param {number} speed   units per second
 * @param {number} dt      step duration (seconds)
 * @param {number} arriveDistance  arrival ring radius (>= 0)
 * @returns {{ x: number, z: number, arrived: boolean }}
 *   `arrived` is true when the current distance is <= arriveDistance OR the
 *   step closes exactly to the ring; when arrived, the position is unchanged.
 */
export function stepToward(current, target, speed, dt, arriveDistance) {
  const arrive = Number.isFinite(arriveDistance) && arriveDistance > 0 ? arriveDistance : 0
  const dx = target.x - current.x
  const dz = target.z - current.z
  const dist = Math.hypot(dx, dz)
  if (dist <= arrive) return { x: current.x, z: current.z, arrived: true }
  const budget = Math.max(0, (Number.isFinite(speed) ? speed : 0) * (Number.isFinite(dt) ? dt : 0))
  const ringGap = dist - arrive
  const step = Math.min(budget, ringGap)
  if (step <= 0) return { x: current.x, z: current.z, arrived: false }
  return { x: current.x + (dx / dist) * step, z: current.z + (dz / dist) * step, arrived: step >= ringGap }
}

/** A valid world XZ point: an object with finite x and z. */
export function isPoint(v) {
  return v != null && typeof v === 'object' && Number.isFinite(v.x) && Number.isFinite(v.z)
}

/**
 * `unit-move` — minimal point-to-point movement. Attach to an entity and give
 * it a `target` world XZ point; each fixed step the entity's transform moves
 * toward it via `stepToward` and stops on the arrive ring. An absent or
 * non-finite target is a silent no-op (the camera-rig handle-absent pattern).
 */
export const unitMoveScript = {
  params: {
    target: { type: 'object', label: 'Target', description: 'World XZ point {x, z}, or null', nullable: true },
    speed: { type: 'number', default: 3 },
    arriveDistance: { type: 'number', default: 0.15 },
  },
  update(dt, api, id, p) {
    const P = p || {}
    if (!isPoint(P.target)) return // invalid/absent target -> no-op
    const rec = api && typeof api.entity === 'function' ? api.entity(id) : null
    const tf = rec && rec.components && rec.components.transform
    if (!tf) return
    const speed = Number.isFinite(Number(P.speed)) ? Number(P.speed) : 3
    const arrive = Number.isFinite(Number(P.arriveDistance)) ? Number(P.arriveDistance) : 0.15
    const r = stepToward(
      { x: Number.isFinite(tf.x) ? tf.x : 0, z: Number.isFinite(tf.z) ? tf.z : 0 },
      P.target,
      speed,
      dt,
      arrive,
    )
    tf.x = r.x
    tf.z = r.z
  },
}
