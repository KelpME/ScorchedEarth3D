/**
 * Engine built-in component: `character-controller` (P4b).
 *
 * Kinematic locomotion data for a player/NPC entity. The entity ALSO carries:
 * a `collider` (usually a `pill`) and the `controller` built-in script (which
 * reads per-step input intent and moves the entity by SWEEPS — never impulses).
 *
 * The controller is KINEMATIC: it is never pushed by contacts, never resolves
 * against the impulse solver, and pushes DYNAMIC bodies out of its way (P4b-3).
 *
 * Fields (all optional; defaults below):
 *  - `moveSpeed` — planar speed at intent magnitude 1 (units/s).
 *  - `slopeLimitDeg` — the steepest ground slope the controller climbs.
 *  - `stepHeight` — the tallest ledge the controller auto-steps onto.
 *  - `snapDist` — max distance to snap down onto ground (absent → the world
 *    `scene.physics.snapDist`).
 *  - `platformCarry` — inherit the ground platform's velocity while grounded.
 *
 * The locomotion-velocity design law (plans/RESEARCH-IK-FOOTLOCK.md): the
 * controller's world planar speed is exposed via `api.controllerSpeed(id)`
 * so an animation layer can match a locomotion clip's authored speed
 * (drive playbackRate from it). Feet are an ANIMATION-layer concern — never
 * solver friction.
 */
export const name = 'character-controller'

export const label = 'Character Controller'

export const description = 'Kinematic locomotion: moveSpeed, slopeLimitDeg, stepHeight, snapDist, platformCarry. Pairs with a pill collider + the controller script.'

export const params = {
  moveSpeed: { type: 'number', default: 4 },
  slopeLimitDeg: { type: 'number', default: 45 },
  stepHeight: { type: 'number', default: 0.3 },
  snapDist: { type: 'number', default: 0 },
  platformCarry: { type: 'boolean', default: true },
}

export default { name, label, description, params }
