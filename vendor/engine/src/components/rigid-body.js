/**
 * Engine built-in component: `rigid-body`.
 *
 * Mass/inertia metadata for a physics-driven entity. Pairs with a `collider`
 * (which carries the shape) — the resolution math lives in the physics system,
 * not here; this component is pure data.
 *
 * `mass` is the explicit mass in kg — `0` (the default) means "derive it from
 * `density` × the collider volume". `density` is the fallback path
 * (default 1): a nonzero density with mass 0 gives the body its mass from the
 * collider shape.
 *
 * `restitution` (0..1) is bounciness on contact; `friction` (0..1) is surface
 * grip. `linearDamping` bleeds velocity each step (0 = none), `gravityScale`
 * multiplies the world gravity applied to this body (1 = normal, 0 = none).
 *
 * `isKinematic` marks a body moved by animation/script rather than forces —
 * it participates in contacts but is not pushed by them, so it must not also
 * declare an explicit mass > 0 (validateRigidBody flags that combination).
 *
 * `lockFlags` freezes axes: an array of axis strings — position `'posX'`,
 * `'posY'`, `'posZ'` and rotation `'rotX'`, `'rotY'`, `'rotZ'` (rotation locks
 * are ACTIVE since P2: a locked rot axis never spins — ω is held at zero and
 * contact impulses cannot spin it).
 *
 * `angularVelocity` ([x, y, z] rad/s) is the AUTHORED angular state (a
 * kinematic body carries it verbatim; a dynamic body's live ω diverges from
 * it once the pipeline integrates). `angularDamping` bleeds ω each step
 * (default 0.05; 0 = spin is conserved in free flight).
 */
export const name = 'rigid-body'

export const label = 'Rigid Body'

export const description = 'Mass/inertia for a physics body: mass (0 = derive from density × collider volume), density, restitution (0..1), friction (0..1), linearDamping, gravityScale, isKinematic, lockFlags (rotation axes rotX/rotY/rotZ active), velocity [x,y,z] (authored spawn velocity), angularVelocity [x,y,z], angularDamping.'

export const params = {
  mass: { type: 'number', default: 0 },
  density: { type: 'number', default: 1 },
  restitution: { type: 'number', default: 0.1 },
  friction: { type: 'number', default: 0.5 },
  linearDamping: { type: 'number', default: 0 },
  gravityScale: { type: 'number', default: 1 },
  isKinematic: { type: 'boolean', default: false },
  ccd: { type: 'boolean', default: false, description: 'Continuous collision detection: per-step displacement is swept against collider candidates BEFORE the transform moves (anti-tunneling for fast bodies). The P1 tunneling-clamp substeps remain the fallback for ccd:false bodies.' },
  lockFlags: { type: 'array', default: [] },
  velocity: { type: 'array', default: [0, 0, 0], description: 'Authored spawn velocity [vx,vy,vz] units/s' },
  angularVelocity: { type: 'array', default: [0, 0, 0] },
  angularDamping: { type: 'number', default: 0.05 },
}

/**
 * Field-level validation for a `rigid-body` in a components bag.
 * @param {object} components the entity's components bag ({ 'rigid-body': {...}, collider: {...} })
 * @returns {string[]} error strings (empty = valid)
 */
export function validateRigidBody(components = {}) {
  const errors = []
  const rb = components['rigid-body'] || {}
  if (!('collider' in components)) {
    errors.push('rigid-body requires a collider component')
  }
  const mass = typeof rb.mass === 'number' && Number.isFinite(rb.mass) && rb.mass >= 0 ? rb.mass : 0
  const density = typeof rb.density === 'number' && Number.isFinite(rb.density) && rb.density >= 0 ? rb.density : 1
  if (typeof rb.mass === 'number' && !(Number.isFinite(rb.mass) && rb.mass >= 0)) {
    errors.push('mass must be a finite number >= 0')
  }
  if (typeof rb.density === 'number' && !(Number.isFinite(rb.density) && rb.density >= 0)) {
    errors.push('density must be a finite number >= 0')
  }
  if (mass <= 0 && density <= 0) {
    errors.push('rigid-body needs mass > 0 or density > 0')
  }
  if (rb.isKinematic === true && mass > 0) {
    errors.push('rigid-body isKinematic conflicts with mass > 0 (use density-derived mass or drop isKinematic)')
  }
  if (typeof rb.restitution === 'number' && !(rb.restitution >= 0 && rb.restitution <= 1)) {
    errors.push('restitution must be within 0..1')
  }
  if (typeof rb.friction === 'number' && !(rb.friction >= 0 && rb.friction <= 1)) {
    errors.push('friction must be within 0..1')
  }
  if (typeof rb.linearDamping === 'number' && !Number.isFinite(rb.linearDamping)) {
    errors.push('linearDamping must be a finite number')
  }
  if (typeof rb.linearDamping === 'number' && rb.linearDamping < 0) {
    errors.push('linearDamping must be >= 0')
  }
  if (Array.isArray(rb.lockFlags)) {
    const axes = ['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ']
    if (!rb.lockFlags.every((flag) => axes.includes(flag))) {
      errors.push('lockFlags entries must be one of posX, posY, posZ, rotX, rotY, rotZ')
    }
  }
  if (rb.angularVelocity !== undefined) {
    const w = rb.angularVelocity
    const ok = Array.isArray(w) && w.length === 3 &&
      w.every((c) => typeof c === 'number' && Number.isFinite(c))
    if (!ok) errors.push('angularVelocity must be a finite [x, y, z] array')
  }
  if (rb.velocity !== undefined) {
    const v = rb.velocity
    const ok = Array.isArray(v) && v.length === 3 &&
      v.every((c) => typeof c === 'number' && Number.isFinite(c))
    if (!ok) errors.push('velocity must be a finite [x, y, z] array')
  }
  if (typeof rb.angularDamping === 'number' && !Number.isFinite(rb.angularDamping)) {
    errors.push('angularDamping must be a finite number')
  }
  if (typeof rb.angularDamping === 'number' && rb.angularDamping < 0) {
    errors.push('angularDamping must be >= 0')
  }
  if (rb.gravityScale !== undefined && !Number.isFinite(rb.gravityScale)) {
    errors.push('gravityScale must be a finite number')
  }
  if (rb.ccd !== undefined && typeof rb.ccd !== 'boolean') {
    errors.push('ccd must be a boolean')
  }
  return errors
}

export default { name, label, description, params }
