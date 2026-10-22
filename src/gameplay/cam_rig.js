/**
 * cam_rig — PURE camera-rig math for the SE 3D view (X3a, plan SE-VOXEL-3D
 * "Camera rig (DEC-F)"). No DOM, no three import: everything is plain numbers
 * so the numeric pins live in test/unit/cam_rig.test.js.
 *
 * Azimuth convention (game-side, frozen): degrees, 0 → camera at focus +X,
 * 90 → camera at focus +Z (the classic play side), 180 → focus −X. The arc is
 * 180°, NOT a full dial: clampAzimuth clamps, it never wraps.
 *
 * Field bounds (panFocus clamp) come from src/voxel3d/constants.js.
 *
 * Renderer note: the engine's `orbit` preset (engine/src/render/camera.js)
 * already puts the camera at +z for theta=+pi/2 (z = r·sin(phi)·sin(theta)),
 * so NO mirroring of theta is needed (verified live). It does measure phi from
 * the +Y axis while our phi is elevation from horizontal — main.js maps
 * engine_phi = PI/2 − phi.
 */

import { FIELD_X_MIN, FIELD_X_MAX, FIELD_Z_MIN, FIELD_Z_MAX } from '../voxel3d/constants.js'

/** Clamp azimuth into the [0,180] arc (no wrap — it is an arc, not a dial). */
export function clampAzimuth(deg) {
  if (deg < 0) return 0
  if (deg > 180) return 180
  return deg
}

/**
 * Orbit pose around a focus point.
 * @param {object} o { focusX, focusY, focusZ, azimuthDeg, radius, phi }
 *   phi = elevation angle from HORIZONTAL (radians), default 0.35.
 * @returns {{x:number,y:number,z:number}} camera position (azimuth 90 → +z).
 */
export function orbitPose({ focusX = 0, focusY = 0, focusZ = 0, azimuthDeg = 90, radius = 42, phi = 0.35, yawOffsetDeg = 0 }) {
  // T-CAM-1: the mouse-drag orbit offset is ADDED to the base azimuth BEFORE
  // the arc clamp — the offset itself accumulates unclamped, but the effective
  // azimuth never leaves the 0..180 arc (no wrap; drag past an end parks there).
  const az = (clampAzimuth(azimuthDeg + yawOffsetDeg) * Math.PI) / 180
  return {
    x: focusX + radius * Math.cos(phi) * Math.cos(az),
    y: focusY + radius * Math.sin(phi),
    z: focusZ + radius * Math.cos(phi) * Math.sin(az),
  }
}

/** T-CAM-1: tilt (phi, elevation from horizontal, radians) clamp for the drag UI. */
export const TILT_MIN = 0.08
export const TILT_MAX = 1.45
export function clampTilt(phi) {
  if (phi < TILT_MIN) return TILT_MIN
  if (phi > TILT_MAX) return TILT_MAX
  return phi
}

/**
 * T-CAM-1: screen-relative focus pan (pure). The camera looks along the
 * ground-projected forward (fwdX, fwdZ) — NOT normalized, normalized here —
 * so `dist` > 0 always moves the focus AWAY from the camera ("ArrowUp"),
 * and `strafe` > 0 moves it to the camera's screen-RIGHT
 * (right = (-fwdZ, fwdX) — the right-handed cross(forward, up) on the xz
 * plane). Both amounts are WORLD UNITS. The result is a NEW focus, clamped
 * into the voxel field bounds; y passes through untouched.
 * @returns {{x:number,y:number,z:number}}
 */
export function panFocus(focus, fwdX, fwdZ, strafe, dist) {
  const len = Math.hypot(fwdX, fwdZ) || 1
  const fx = fwdX / len, fz = fwdZ / len
  const rx = -fz, rz = fx // screen-right on the xz plane
  return {
    x: Math.min(FIELD_X_MAX, Math.max(FIELD_X_MIN, focus.x + fx * dist + rx * strafe)),
    y: focus.y,
    z: Math.min(FIELD_Z_MAX, Math.max(FIELD_Z_MIN, focus.z + fz * dist + rz * strafe)),
  }
}

/**
 * Behind-tank follow pose. The tank's forward is dir = (sin(bearingRad), 0,
 * cos(bearingRad)) — the engine forwardFromYaw convention (bearing 0 = +Z),
 * matching drive.js bearingVec; the camera sits backDist behind the tank and looks at a
 * point slightly above it.
 * INVARIANT (test-pinned): dot(camPos − tankPos, dir) < 0 — strictly behind.
 * @param {object} o { x, y, z, bearingRad, backDist=9, height=4.5 }
 * @returns {{x:number,y:number,z:number,lookAt:{x:number,y:number,z:number}}}
 */
export function followPose({ x = 0, y = 0, z = 0, bearingRad = 0, backDist = 9, height = 4.5 }) {
  const dir = { x: Math.sin(bearingRad), z: Math.cos(bearingRad) }
  return {
    x: x - dir.x * backDist,
    y: y + height,
    z: z - dir.z * backDist,
    lookAt: { x, y: y + 1.2, z },
  }
}

/**
 * T-CAM-1 follow-ORBIT pose: the camera orbits the SUBJECT tank. offsetDeg
 * rotates the camera around the tank (accumulates freely — no wrap, no clamp;
 * the ground radius stays backDist at EVERY offset, unit-pinned). offsetDeg 0
 * with the default phi is EXACTLY followPose (unit-pinned: same x/y/z/lookAt).
 * phi (tilt, elevation from horizontal, radians) defaults to
 * atan2(height, backDist) so the default y lift is exactly `height`; lookAt
 * keeps the tank framed (the followPose convention: tank + 1.2 up).
 * @param {object} o { x, y, z, bearingRad, offsetDeg=0, phi, backDist=9, height=4.5 }
 * @returns {{x:number,y:number,z:number,lookAt:{x:number,y:number,z:number}}}
 */
export function followOrbitPose({ x = 0, y = 0, z = 0, bearingRad = 0, offsetDeg = 0, phi, backDist = 9, height = 4.5 }) {
  const p = clampTilt(phi ?? Math.atan2(height, backDist))
  const a = bearingRad + (offsetDeg * Math.PI) / 180
  return {
    x: x - Math.sin(a) * backDist,
    y: y + backDist * Math.tan(p),
    z: z - Math.cos(a) * backDist,
    lookAt: { x, y: y + 1.2, z },
  }
}

/**
 * SE-FIXUP-1012 W3 (contract C3): ONE shared freecam zoom-out cap. Every
 * camera-radius writer (wheel, boot init from rig params, engine-rig preset
 * pass-through, turn-focus target) funnels through this — the bounds are
 * DATA (data/camera.json zoom.minRadius/maxRadius), never a literal.
 * @param {number} r raw radius
 * @param {number} min minimum radius (zoom-in cap)
 * @param {number} max maximum radius (zoom-out cap)
 * @returns {number} clamped radius
 */
export function clampRadius(r, min, max) {
  const v = Number(r)
  if (Number.isNaN(v)) return min
  return Math.min(max, Math.max(min, v))
}
