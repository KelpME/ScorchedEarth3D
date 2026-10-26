/**
 * Engine built-in component: `joint` (P4c).
 *
 * Constrains this entity's rigid body to ANOTHER entity's rigid body. Pure
 * data — the constraint solving lands in the physics solver task; the island
 * graph ALREADY treats a joint edge as a connection (P4c Task 1): bodies
 * joined by a joint wake, simulate, and sleep together even when they never
 * touch.
 *
 * Fields:
 *  - `type` — the production set: 'fixed' (weld), 'point' (ball/socket),
 *    'hinge' (+ limits/motor later), 'prismatic' (slide), 'distance'
 *    (min/max rope), 'spring' (soft distance).
 *  - `other` — the entity id this joint constrains against (REQUIRED;
 *    self-reference and dangling ids are validateScene errors).
 *  - `breakForce` — the impulse magnitude beyond which the joint breaks.
 *    0 (default) = unbreakable.
 *  - `collideConnected` — if true, the joined bodies still collide with
 *    each other (chain links); default false.
 *  - `anchorA` / `anchorB` — OPTIONAL [x,y,z] local offsets into each body.
 *    Absent = auto-derived (midpoint between the bodies) at solve time.
 *  - `axis` — OPTIONAL [x,y,z] joint axis. Absent = the body-to-body
 *    direction.
 *  P4c-3 (hinge/prismatic only):
 *  - `jointLimitMin` / `jointLimitMax` — OPTIONAL limits (radians for hinge,
 *    u along the axis for prismatic; measured from the initial config).
 *  - `motorSpeed` — OPTIONAL drive rate (rad/s or u/s). 0/absent = no drive.
 *  - `maxMotorForce` — OPTIONAL motor strength; 0/absent = no motor.
 */
export const name = 'joint'

export const label = 'Joint'

export const description = 'Constrains this rigid body to another entity: fixed/point/hinge/prismatic/distance/spring, with breakForce and collideConnected. Anchors/axis are optional — sane defaults are derived.'

export const JOINT_TYPES = ['fixed', 'point', 'hinge', 'prismatic', 'distance', 'spring']

export const params = {
  type: { type: 'string', default: 'fixed', enum: JOINT_TYPES },
  other: { type: 'string', required: true },
  breakForce: { type: 'number', default: 0 },
  collideConnected: { type: 'boolean', default: false },
  anchorA: { type: 'array' },
  anchorB: { type: 'array' },
  axis: { type: 'array' },
  jointLimitMin: { type: 'number' },
  jointLimitMax: { type: 'number' },
  motorSpeed: { type: 'number', default: 0 },
  maxMotorForce: { type: 'number', default: 0 },
}

export default { name, label, description, params }
