// Engine built-in component: `velocity` — LEGACY (P3.5 velocity fold).
// DEPRECATED for rigid entities: authored spawn velocity now lives on
// `rigid-body.velocity`, and live velocity is engine-internal motion-map
// state read via `api.physics.getVelocity(id)`. This component remains
// registered ONLY for legacy `dynamic-body` entities (no `rigid-body`),
// whose script still uses its `vy` field. normalizeScene migrates any
// rigid-entity `velocity` component into `rigid-body.velocity` on load.

export const name = 'velocity'

export const label = 'Velocity'

export const description = 'Linear velocity [vx, vy, vz] in units/second. Integrated into the transform by the physics system.'

export const params = {
  v: { type: 'array', default: [0, 0, 0] },
}

/**
 * Field-level validation for a `velocity` in a components bag.
 * @param {object} components the entity's components bag ({ velocity: {...} })
 * @returns {string[]} error strings (empty = valid)
 */
export function validateVelocity(components = {}) {
  const errors = []
  const vel = components.velocity || {}
  const v = vel.v
  if (v !== undefined && !(Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)))) {
    errors.push('velocity v must be three finite numbers [vx,vy,vz]')
  }
  return errors
}

export default { name, label, description, params }
