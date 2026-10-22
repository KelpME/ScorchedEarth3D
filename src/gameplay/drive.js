/**
 * X3b — pure drive/locomotion model (no engine, no DOM).
 *
 * A tank has a bearing (degrees; 0 = +Z, 90 = +x — the engine forwardFromYaw
 * convention, forward = (sin yaw, cos yaw)) and a per-turn distance
 * budget. tryDrive advances it along the bearing by |drive|*MAX_SPEED*dt,
 * clamped to the remaining budget, gated by the slope of the ground ahead.
 * The input tank object is never mutated.
 */

import driveData from '../../data/drive.json' with { type: 'json' };

// W5 purge (plan SE-COMPLETE-1012 §4): the old MAX_SPEED/TURN_BUDGET/
// MAX_SLOPE_DEG/SLOPE_LOOKAHEAD JS literals are GONE — drive mechanics are
// DATA (data/drive.json; the manual publishes no drive numbers, so the file
// carries the documented build pins as editor-editable _placeholder data).
// A malformed descriptor fails LOUD naming the file — no JS fallback exists.
function driveNum(key) {
  const v = driveData ? driveData[key] : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`[se/drive] data/drive.json .${key} missing/non-numeric — fix the data file, no JS fallback exists`);
  }
  return v;
}
export const MAX_SPEED = driveNum('maxSpeed');        // world units / second at |drive| = 1
export const TURN_BUDGET = driveNum('turnBudget');    // world units per turn
export const MAX_SLOPE_DEG = driveNum('maxSlopeDeg'); // steeper rises block the step
export const SLOPE_LOOKAHEAD = driveNum('slopeLookahead'); // grade sample distance: at least a voxel rise fits inside

const DEG = Math.PI / 180;

/** Normalize any angle to [0, 360). Pins: 359+2 -> 1, -1 -> 359, 720 -> 0. */
export function wrapBearing(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Unit heading vector: bearing 0 = +Z, the engine forwardFromYaw convention. */
export function bearingVec(deg) {
  return { x: Math.sin(deg * DEG), z: Math.cos(deg * DEG) };
}

/**
 * One drive attempt.
 * @param {{x:number,z:number,bearingDeg:number,drive:number,budget:number}} tank NOT mutated
 * @param {number} dt seconds
 * @param {(x:number,z:number)=>number} groundAt top surface world-y at (x,z)
 * @param {{maxSpeed?:number,maxSlopeDeg?:number}} [opts]
 * @returns {{x:number,z:number,y:number,moved:number,blocked:string|null}}
 */
export function tryDrive(tank, dt, groundAt, opts = {}) {
  const maxSpeed = opts.maxSpeed ?? MAX_SPEED;
  const maxSlopeDeg = opts.maxSlopeDeg ?? MAX_SLOPE_DEG;
  const { x, z, bearingDeg, drive, budget } = tank;
  if (drive === 0 || budget <= 0) {
    return { x, z, y: groundAt(x, z), moved: 0, blocked: budget <= 0 && drive !== 0 ? 'fuel' : null };
  }
  const step = Math.min(Math.abs(drive) * maxSpeed * dt, budget);
  const v = bearingVec(bearingDeg);
  const sign = drive > 0 ? 1 : -1;
  const nx = x + v.x * step * sign;
  const nz = z + v.z * step * sign;
  // Grade sampled over a FIXED lookahead of at least a voxel: the per-frame
  // step quantizes cell rises into false 45+ degree readings (the
  // uphill-impossible bug — one 0.25 voxel over a ~0.1 step read ~68°).
  const lx = x + v.x * sign * SLOPE_LOOKAHEAD;
  const lz = z + v.z * sign * SLOPE_LOOKAHEAD;
  const slopeDeg = Math.atan2(groundAt(lx, lz) - groundAt(x, z), SLOPE_LOOKAHEAD) / DEG;
  if (slopeDeg > maxSlopeDeg) {
    return { x, z, y: groundAt(x, z), moved: 0, blocked: 'slope' };
  }
  return { x: nx, z: nz, y: groundAt(nx, nz), moved: step, blocked: null };
}
