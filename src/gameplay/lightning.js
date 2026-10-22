// W2-Cb (plan SE-COMPLETE-1012) — lightning PURE core + the general
// damage->maxPower law. No DOM, no engine imports, no Math.random, no clock:
// every strike decision is a seeded function of (battle seed, turn index) so
// the same seed+turn always produce the same strikes (determinism pin).
//
// ONE DAMAGE PATH DOCTRINE: a strike is applied through the SAME pipeline tank
// shots use — battleLoop.onBlast -> damage.js applyBlast. The strike lands at
// a DATA-DERIVED STANDOFF distance from the target so the damage.js linear
// falloff (MAX_BLAST_DAMAGE at the core, linear to 0 at the edge) yields
// exactly `damage` hull points at the tank's position — no second damage
// formula exists anywhere.
//
// Damage->maxPower law (data/physics-presets.json .damagePower): every damage
// event drains maxPower by reductionPerHullFraction * (damage / maxHull),
// clamped at floor. Effective shot power = min(aim.power, maxPower).
// maxPower <= floor (half the 1.0 original) = the barrel break point.

import { SE_PX_TO_WORLD, MAX_BLAST_DAMAGE } from './damage.js';
import { shellWorldOrigin, effectivePower } from './aim.js';
export { effectivePower }; // the ONE maxPower seam (aim.js W2-Cb) — re-exported for the unit pins

/** Deterministic PRNG (mulberry32) — same seed, same stream. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 32-bit hash of (seed, turnIndex) — the per-turn RNG seed. */
export function hash2(seed, turnIndex) {
  let h = (seed | 0) ^ Math.imul(turnIndex | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h ^= h >>> 13
  return h >>> 0
}

/**
 * Standoff strike point: the blast center at distance d from the target such
 * that applyBlast's linear falloff yields exactly params.damage at distance d.
 *   damage(d) = MAX * (edge - d) / (edge - core)   for core < d < edge
 *   edge = blastRpx * SE_PX_TO_WORLD, core = edge * 0.2 (damage.js brief pins)
 * Offset along +x (world). PURE.
 */
export function strikePoint(target, params) {
  if (!params || typeof params.blastRpx !== 'number' || typeof params.damage !== 'number') {
    throw new TypeError(`strikePoint: params.damage + params.blastRpx required (data), got ${JSON.stringify(params)}`)
  }
  const edge = params.blastRpx * SE_PX_TO_WORLD
  const core = edge * 0.2
  const frac = Math.min(1, Math.max(0, params.damage / MAX_BLAST_DAMAGE))
  const d = edge - frac * (edge - core)
  return { x: (target.x ?? 0) + d, y: target.y ?? 0, z: target.z ?? 0 }
}

/**
 * Resolve one turn's strikes. Deterministic per (seed, turnIndex, sky, tanks).
 * Non-hostile (or unknown) skies strike NOTHING. Targets: any alive tank.
 * @returns Array<{tankId, x, y, z}> — positions ARE the blast centers
 *          (standoff points; the TARGET's own position is what the caller
 *          uses for VFX — carry it as tankPos).
 */
export function rollTurnStrikes({ seed, turnIndex, sky, params, tanks }) {
  const skyP = params?.hostileSkies?.[sky]
  if (!skyP) return [] // non-hostile sky: no strikes (data-driven extension point)
  const alive = (tanks || []).filter((t) => t && t.id && !t.dead)
  if (alive.length === 0) return []
  const rng = mulberry32(hash2(seed, turnIndex))
  if (!(rng() < skyP.strikeChance)) return []
  const target = alive[Math.floor(rng() * alive.length) % alive.length]
  const p = strikePoint(target, skyP)
  return [{ tankId: target.id, tankPos: { x: target.x ?? 0, y: target.y ?? 0, z: target.z ?? 0 }, ...p }]
}

// ---- Damage->maxPower law (data/physics-presets.json .damagePower) ----------

/** Drain ONE damage event: maxPower -= reductionPerHullFraction * damage/maxHull, floored. Returns the new maxPower. PURE (mutates player). */
export function applyMaxPowerDrain(player, damage, rule) {
  if (!rule || typeof rule.reductionPerHullFraction !== 'number' || typeof rule.floor !== 'number') {
    throw new TypeError(`applyMaxPowerDrain: rule.reductionPerHullFraction + rule.floor required (data/physics-presets .damagePower), got ${JSON.stringify(rule)}`)
  }
  const maxHull = rule.maxHull ?? 100
  if (!(typeof damage === 'number' && Number.isFinite(damage) && damage > 0)) return player.maxPower ?? rule.maxPower
  const base = typeof player.maxPower === 'number' ? player.maxPower : rule.maxPower
  const next = base - rule.reductionPerHullFraction * (damage / maxHull)
  // fp-noise cleanup ONLY (same doctrine as damage.js): exact-fraction drains
  // land at ±1e-15; snap to 9 decimals so 1 - 40/100 reads exactly 0.6.
  const snapped = Math.round(next * 1e9) / 1e9
  player.maxPower = Math.max(rule.floor, Math.abs(snapped - next) < 1e-6 ? snapped : next)
  return player.maxPower
}

/** Effective shot power: min(aim.power, maxPower) — the fire-path clamp lives
 * in aim.js (the ONE maxPower seam, W2-Cb). */

/** Barrel break: maxPower at/below the floor (half the original). */
export function isBarrelBreak(maxPower, rule) {
  const mp = typeof maxPower === 'number' ? maxPower : rule?.maxPower ?? 1
  return mp <= (rule?.floor ?? 0.5) + 1e-9
}

/**
 * World-transform snapshot of the front barrel segment before detach.
 * Reuses aim.js shellWorldOrigin (the ONE hull-local -> world derivation) with
 * the Barrel001's own local offset (0,0,0 in the shipped tankV3 rig — the
 * segment pivots exactly at the Barrel node). rotX = the barrel's live pitch.
 * PURE.
 */
export function barrelWorldSnapshot(tank, barrel, barrel001) {
  const w = shellWorldOrigin(tank ?? {}, barrel ?? {}, barrel001 ?? { x: 0, y: 0, z: 0 })
  return { x: w.x, y: w.y, z: w.z, rotX: barrel?.rot?.x ?? 0 }
}
