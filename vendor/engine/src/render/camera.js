/**
 * Camera preset math — PURE functions (FOUNDATION-PLAN.md §6, "camera presets").
 *
 * This module computes camera placement for the supported presets using only
 * plain numbers and { x, y, z } objects. There is no Three.js import and no
 * DOM/WebGL dependency, so every function here is unit-testable in Node.
 * The browser-bound renderer (`renderer.js`) consumes these results to place
 * a THREE.PerspectiveCamera.
 *
 * Coordinate convention: a positive yaw rotates toward +Z at yaw 0 (the
 * entity faces +Z by default); positive pitch looks up.
 */

/** The supported camera presets. */
export const CAMERA_PRESETS = [
  'third-person-follow',
  'top-down',
  'orbit',
  'first-person',
]

/**
 * A forward direction unit vector from a yaw (radians, + toward +Z at yaw 0).
 * @param {number} yaw  radians; 0 faces +Z, + rotates toward +X.
 * @returns {{ x: number, y: number, z: number }} unit vector (y is 0).
 */
export function forwardFromYaw(yaw) {
  return { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }
}

/**
 * Normalized direction vector from `from` to `to`.
 * @param {{ x: number, y: number, z: number }} from
 * @param {{ x: number, y: number, z: number }} to
 * @returns {{ x: number, y: number, z: number }} unit vector (from -> to).
 */
export function computeLookAt(from, to) {
  const dx = (to.x ?? 0) - (from.x ?? 0)
  const dy = (to.y ?? 0) - (from.y ?? 0)
  const dz = (to.z ?? 0) - (from.z ?? 0)
  const len = Math.hypot(dx, dy, dz)
  if (len === 0) return { x: 0, y: 0, z: 0 }
  return { x: dx / len, y: dy / len, z: dz / len }
}

/**
 * Compute the camera position + look-at target for a preset.
 *
 * @param {string} preset  one of CAMERA_PRESETS.
 * @param {{ x?: number, y?: number, z?: number, yaw?: number }} entityPos
 *   the entity (or focus point) being viewed. `yaw` only matters for the
 *   follow / first-person presets.
 * @param {object} [args]  per-preset options (see each preset below).
 * @returns {{ position: { x,y,z }, target: { x,y,z } }}
 *   camera eye position and the point it looks at. Fields are plain numbers.
 */
export function computeCameraPosition(preset, entityPos = {}, args = {}) {
  switch (preset) {
    case 'third-person-follow':
      return thirdPersonFollow(entityPos, args)
    case 'top-down':
      return topDown(entityPos, args)
    case 'orbit':
      return orbit(entityPos, args)
    case 'first-person':
      return firstPerson(entityPos, args)
    default:
      throw new Error(`unknown camera preset: ${preset}`)
  }
}

/**
 * `third-person-follow` — camera trails behind the entity along its facing.
 * @param {object} entityPos  { x, y, z, yaw? } (yaw defaults to 0 → +Z).
 * @param {object} [args]  { distance=4, height=2.2, yaw? } — `yaw` overrides
 *   the entity's facing when provided.
 */
function thirdPersonFollow(entityPos = {}, args = {}) {
  const yaw = args.yaw ?? entityPos.yaw ?? 0
  const distance = args.distance ?? 4
  const height = args.height ?? 2.2
  const fwd = forwardFromYaw(yaw)
  const p = {
    x: entityPos.x ?? 0,
    y: entityPos.y ?? 0,
    z: entityPos.z ?? 0,
  }
  return {
    position: {
      x: p.x - fwd.x * distance,
      y: p.y + height,
      z: p.z - fwd.z * distance,
    },
    target: { x: p.x, y: p.y, z: p.z },
  }
}

/**
 * `top-down` — camera directly above looking straight down.
 * @param {object} entityPos  { x, y, z }.
 * @param {object} [args]  { height=20 } — vertical distance above the target.
 */
function topDown(entityPos = {}, args = {}) {
  const height = args.height ?? 20
  const p = {
    x: entityPos.x ?? 0,
    y: entityPos.y ?? 0,
    z: entityPos.z ?? 0,
  }
  return {
    position: { x: p.x, y: p.y + height, z: p.z },
    target: { x: p.x, y: p.y, z: p.z },
  }
}

/**
 * `orbit` — camera circles the target at a radius along theta/phi angles.
 * @param {object} entityPos  { x, y, z }.
 * @param {object} [args]
 *   { radius=5, theta=0, phi=PI/2 } — theta rotates in the XZ plane, phi is
 *   the elevation from the Y axis (PI/2 = level, 0 = straight above).
 */
function orbit(entityPos = {}, args = {}) {
  const radius = args.radius ?? 5
  const theta = args.theta ?? 0
  const phi = args.phi ?? Math.PI / 2
  const p = {
    x: entityPos.x ?? 0,
    y: entityPos.y ?? 0,
    z: entityPos.z ?? 0,
  }
  return {
    position: {
      x: p.x + radius * Math.sin(phi) * Math.cos(theta),
      y: p.y + radius * Math.cos(phi),
      z: p.z + radius * Math.sin(phi) * Math.sin(theta),
    },
    target: { x: p.x, y: p.y, z: p.z },
  }
}

/**
 * `first-person` — camera at the entity's eye, looking along its facing
 * (optionally pitched).
 * @param {object} entityPos  { x, y, z, yaw? }.
 * @param {object} [args]  { eyeHeight=1.6, yaw?, pitch=0 } — `pitch` tilts the
 *   view up (+) or down (-) from level.
 */
function firstPerson(entityPos = {}, args = {}) {
  const yaw = args.yaw ?? entityPos.yaw ?? 0
  const eyeHeight = args.eyeHeight ?? 1.6
  const pitch = args.pitch ?? 0
  const p = {
    x: entityPos.x ?? 0,
    y: entityPos.y ?? 0,
    z: entityPos.z ?? 0,
  }
  const eye = { x: p.x, y: p.y + eyeHeight, z: p.z }
  // Forward rotated up/down by pitch around the X axis.
  const dir = {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  }
  return {
    position: eye,
    target: { x: eye.x + dir.x, y: eye.y + dir.y, z: eye.z + dir.z },
  }
}
