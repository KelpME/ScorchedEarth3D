/**
 * COMPUTER OPPONENTS — decision core (plan SE-COMPLETE-1012). PURE: no DOM,
 * no engine imports, no Math.random — every random draw comes from the
 * seeded mulberry32 stream, so same seed => bit-identical plans.
 *
 * planShot(state, personality, seed) -> { weapon, angleDeg, power,
 * bearingDeg, driveTicks, taunt }.
 *
 * Ballistics mirror the LIVE flight model exactly (systems/projectiles3d.js):
 *   speed = 12 + power * 28  (src/gameplay/aim.js launchVelocity3, T-G1 law)
 *   gravity, wind (horizontal ACCELERATION u/s^2), voxel surface via
 *   state.surfaceAt(x, z). simulateShot integrates with 1/120 substeps
 *   (semi-implicit Euler: v then x — the ballistics3d doctrine) until the
 *   shell dips under the surface, goes out of the tracked span, or times out.
 *
 * Solve: iterative refinement, no recursion — for each candidate elevation
 * angle a bisection on power (monotone range) finds the power whose landing
 * horizontal distance is nearest the target; the angle with the smallest miss
 * wins (lobs preferred among near-ties). Personality aim error is then applied
 * as SEEDED noise within the data bounds (ai-personalities.json .ai).
 *
 * Weapon choice: affordable (inventory count > 0) + arms-level legal
 * (w.armsLevel <= state.armsLevel) + personality prefs (heavy closer inside
 * ai.heavyRange, lobber at range), falling back missile -> baby_missile.
 * Taunt is data-shaped, returned but never spoken here (talk.js owns speech;
 * the shared fire path already plays the 'attack' taunt).
 */

// Deterministic RNG (mulberry32) + a small integer hash for seed mixing.
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function hashSeed(...nums) {
  let h = 2166136261 >>> 0
  for (const n of nums) {
    let v = Math.round(Number(n) * 1000) | 0
    h ^= v + 0x9E3779B9 + (h << 6) + (h >>> 2)
    h >>>= 0
  }
  return h
}

import { FIELD_X_MIN, FIELD_X_MAX, FIELD_Z_MIN, FIELD_Z_MAX } from '../voxel3d/constants.js'

const DEG = Math.PI / 180
const SPEED_OF = (power) => 12 + power * 28 // launchVelocity3 law (aim.js)

/**
 * simulateShot(state, angleDeg, power, bearingDeg) -> { x, y, z, hit }
 * One ballistic trajectory from the shooter muzzle (tank + 1.4 up — the
 * legacy origin fireActiveTurn falls back to; ShellSpawn offsets are a few
 * tenths, well inside the aim-error budget). Mutates nothing.
 */
export function simulateShot(state, angleDeg, power, bearingDeg) {
  const dt = 1 / 120
  const g = state.gravity ?? 9.8
  const wx = state.wind?.x ?? 0
  const wz = state.wind?.z ?? 0
  const speed = SPEED_OF(power)
  const a = angleDeg * DEG
  const b = bearingDeg * DEG
  let x = state.shooter.x
  let y = (state.shooter.y ?? 0) + 1.4
  let z = state.shooter.z ?? 0
  let vx = Math.cos(a) * Math.sin(b) * speed
  let vy = Math.sin(a) * speed
  let vz = Math.cos(a) * Math.cos(b) * speed
  const surface = state.surfaceAt
  for (let i = 0; i < 120 * 30; i++) { // 30 s hard stop
    vy -= g * dt
    vx += wx * dt
    vz += wz * dt
    const px = x, py = y, pz = z
    x += vx * dt; y += vy * dt; z += vz * dt
    if (y < surface(x, z)) return { x: px, y: py, z: pz, hit: 'terrain' }
    // Out of the LIVE field span = the real world's kill bound (projectiles3d
    // stepBallistic oob) — the sim must die where the real shell dies, or the
    // solver would pick wind-blowback trajectories the arena deletes mid-flight.
    if (x < FIELD_X_MIN || x > FIELD_X_MAX || z < FIELD_Z_MIN || z > FIELD_Z_MAX || y < -10) {
      return { x, y, z, hit: 'oob' }
    }
  }
  return { x, y, z, hit: 'timeout' }
}

// Candidate elevations (deg): lobs first — near-ties prefer the higher arc.
// 85 covers steep drops; strong wind (max ±40 u/s^2 after the 0.2 anchor,
// settingsApply rollWind) can demand near-vertical shots.
const ANGLES = [85, 75, 65, 55, 45, 35, 25]

function landDist(state, angleDeg, power, bearingDeg, tx, tz) {
  const imp = simulateShot(state, angleDeg, power, bearingDeg)
  return Math.hypot(imp.x - tx, imp.z - tz)
}

/**
 * solveArc(state, target) -> { angleDeg, power, miss }
 * Iterative refinement (loop, never recursion): per angle, a coarse POWER
 * GRID finds the best band (wind makes range non-monotone in power — a plain
 * bisection diverges under strong wind), then a bisection refines inside the
 * winning band; the angle with the smallest miss wins.
 */
export function solveArc(state, target) {
  const sx = state.shooter.x, sz = state.shooter.z ?? 0
  const bearingDeg = Math.atan2(target.x - sx, target.z - sz) / DEG
  let best = { angleDeg: 45, power: 0.55, miss: Infinity }
  for (const angleDeg of ANGLES) {
    // Coarse grid: 12 bands over [0.05, 1].
    const bands = 12
    let bl = 0.05, bBest = Infinity, bPower = 0.05
    for (let i = 0; i < bands; i++) {
      const p = 0.05 + (i + 0.5) * (0.95 / bands)
      const miss = landDist(state, angleDeg, p, bearingDeg, target.x, target.z)
      if (miss < bBest) { bBest = miss; bPower = p; bl = 0.05 + i * (0.95 / bands) }
    }
    // Refine: bisection inside the winning band (monotone locally).
    let lo = bl, hi = bl + 0.95 / bands
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2
      if (distAlong(state, angleDeg, mid, bearingDeg, sx, sz, target) > 0) hi = mid
      else lo = mid
    }
    for (const power of [bPower, lo, hi, (lo + hi) / 2]) {
      const miss = landDist(state, angleDeg, power, bearingDeg, target.x, target.z)
      if (miss < best.miss - 0.25 || (miss < best.miss + 0.25 && angleDeg > best.angleDeg)) {
        best = { angleDeg, power, miss }
      }
    }
  }
  return { ...best, bearingDeg }
}

// Signed range along the firing line: >0 = the shot flew PAST the target.
function distAlong(state, angleDeg, power, bearingDeg, sx, sz, target) {
  const imp = simulateShot(state, angleDeg, power, bearingDeg)
  const dx = target.x - sx, dz = target.z - sz
  const len = Math.hypot(dx, dz) || 1
  return ((imp.x - sx) * dx + (imp.z - sz) * dz) / len - len
}

// ---- target choice ---------------------------------------------------------
// Default: nearest alive enemy. Cyborg targetPriority (manual:L285-L286):
// weakened (lowest hull) first, then winning (highest hull), else nearest —
// the same order the data file pins, applied as successive sort keys.
export function chooseTarget(state, personality) {
  const enemies = (state.enemies || []).filter((e) => e.alive !== false)
  if (enemies.length === 0) return null
  const pri = personality?.targetPriority
  if (Array.isArray(pri) && pri.length) {
    const scored = [...enemies].sort((a, b) => {
      for (const key of pri) {
        const av = key === 'weakened' ? a.hull : key === 'winning' ? -a.hull : 0
        const bv = key === 'weakened' ? b.hull : key === 'winning' ? -b.hull : 0
        if (av !== bv) return av - bv
      }
      return dist2(state, a) - dist2(state, b)
    })
    return scored[0]
  }
  return [...enemies].sort((a, b) => dist2(state, a) - dist2(state, b))[0]
}
function dist2(state, e) {
  return (e.x - state.shooter.x) ** 2 + ((e.z ?? 0) - (state.shooter.z ?? 0)) ** 2
}

// ---- weapon choice ---------------------------------------------------------
function legalWeapons(state) {
  const out = []
  for (const w of state.weaponCatalog || []) {
    if ((state.inventory?.[w.id] ?? 0) <= 0) continue
    if (typeof w.armsLevel === 'number' && typeof state.armsLevel === 'number' && w.armsLevel > state.armsLevel) continue
    out.push(w)
  }
  return out
}

export function chooseWeapon(state, personality, distance) {
  const ai = personality?.ai || {}
  const legal = legalWeapons(state)
  const have = (id) => legal.find((w) => w.id === id)
  const prefs = distance <= (ai.heavyRange ?? 40)
    ? [ai.heavyCloserId, ai.farWeaponId, 'missile', 'baby_missile']
    : [ai.farWeaponId, 'missile', 'baby_missile']
  for (const id of prefs) {
    const w = id && have(id)
    if (w) return w.id
  }
  return have('baby_missile') ? 'baby_missile' : (legal[0]?.id ?? 'baby_missile')
}

// ---- the plan --------------------------------------------------------------
// AI personality fields (data/ai-personalities.json .ai, added with _source
// notes): angleErrorDeg, powerError, thinkDelayFrames, driveAffinity,
// heavyCloserId, heavyRange, farWeaponId. Missing .ai degrades to safe
// defaults (caller fail-noisy logs), never a throw.
export function planShot(state, personality, seed) {
  const rng = mulberry32(seed)
  const target = chooseTarget(state, personality)
  if (!target) return null
  const ai = personality?.ai || {}
  const distance = Math.hypot(target.x - state.shooter.x, (target.z ?? 0) - (state.shooter.z ?? 0))
  const weapon = chooseWeapon(state, personality, distance)
  const solved = solveArc(state, target)
  // Seeded aim error within DATA bounds — uniform on [-err, +err].
  const angleErr = Number(ai.angleErrorDeg ?? 0)
  const powerErr = Number(ai.powerError ?? 0)
  const angleDeg = Math.min(180, Math.max(0, solved.angleDeg + (rng() * 2 - 1) * angleErr))
  const power = Math.min(1, Math.max(0.05, solved.power + (rng() * 2 - 1) * powerErr))
  const driveTicks = Math.round((Number(ai.driveAffinity ?? 0) * 30))
  return {
    weapon,
    angleDeg,
    power,
    bearingDeg: solved.bearingDeg,
    driveTicks,
    taunt: null, // speech is talk.js's seam; the shared fire path already taunts
    _solve: { miss: solved.miss, targetId: target.id },
  }
}
