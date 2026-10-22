// W2-B (plan SE-COMPLETE-1012) — pure arena-wall model. NO DOM, no engine
// imports beyond the pure voxel3d constants (data, not code). The 8 modes are
// the manual's Effect of Walls list (docs/manuals/scorched-earth-1.5-manual.txt
// L1875-L1906):
//   CONCRETE  blocks shots from going off screen in any direction (white)
//   PADDED    reflects shots but absorbs some of their energy first (green)
//   RUBBER    projectiles bounce off (red)
//   SPRING    like RUBBER but gives the projectile a "kick" (pinball) (cyan)
//   WRAP      off one edge, on the opposite edge (yellow)
//   RANDOM    one of the above picked at the START of each round (seeded)
//   ERRATIC   one of the above picked BEFORE EACH SHOT (seeded, chaotic kick)
//   NONE      no effect (gray)
// Wall physics magnitudes and all visual params are DATA
// (data/physics-presets.json wallPhysics / wallVisuals) — no content literals
// in this module. Deterministic: RANDOM draws from an LCG keyed by the ROUND
// seed, ERRATIC from a hash of (round seed, shot seed); identical seed +
// inputs => bit-identical outcome (same LCG constants as settingsApply.js).

import { FIELD_X_MIN, FIELD_X_MAX, FIELD_Z_MIN, FIELD_Z_MAX } from '../voxel3d/constants.js';
import presetsData from '../../data/physics-presets.json' with { type: 'json' };

export const WALL_MODES = ['CONCRETE', 'PADDED', 'RUBBER', 'SPRING', 'WRAP', 'RANDOM', 'ERRATIC', 'NONE'];
// The five manual methods RANDOM/ERRATIC choose among ("one of the above
// methods" — L1893-L1895; NONE is not among them).
export const EFFECTIVE_MODES = ['CONCRETE', 'PADDED', 'RUBBER', 'SPRING', 'WRAP'];

// numericjs-style LCG constants — identical to settingsApply.js (one RNG
// doctrine across the sim; no Math.random anywhere).
const LCG_A = 1664525;
const LCG_C = 1013904223;
const LCG_M = 4294967296; // 2^32

function lcg(seed) {
  let s = (seed >>> 0) || 1; // 0 would fixpoint on LCG_C; 1 keeps determinism pinned
  return () => {
    s = (Math.imul(s, LCG_A) + LCG_C) >>> 0;
    return s / LCG_M;
  };
}

// Deterministic seed-mixing (same recipe as rollWindTurn): multiply-wrap hash.
export function hashSeeds(...parts) {
  let h = 2166136261 >>> 0;
  for (const part of parts) h = (Math.imul(h ^ (Number(part) >>> 0), 16777619) >>> 0);
  h = Math.imul(h, 2654435761) >>> 0;
  return h;
}

/** Wall physics params from DATA. Missing data fails loud (no literals). */
export function wallParams() {
  const w = presetsData.wallPhysics;
  if (!w || !w.padded || !w.spring || !w.erratic) {
    throw new Error('[walls] data/physics-presets.json wallPhysics missing — fail loud, no in-code defaults');
  }
  return w;
}

/** Per-mode visual params from DATA (color/opacity/height — editor-tunable). */
export function wallVisualParams(mode) {
  const v = presetsData.wallVisuals;
  if (!v || !v.modes || !v.modes[mode]) {
    throw new Error(`[walls] wallVisuals missing mode ${JSON.stringify(mode)} — fail loud, no in-code defaults`);
  }
  return v.modes[mode];
}

/** RANDOM: the round seed picks the effective mode, once per round. */
export function pickMode(roundSeed) {
  const rand = lcg(hashSeeds(roundSeed, 0x57a11)); // mix: small round seeds must spread across modes
  return EFFECTIVE_MODES[Math.floor(rand() * EFFECTIVE_MODES.length) % EFFECTIVE_MODES.length];
}

/** Resolve RANDOM (per round) / ERRATIC (per shot) onto a concrete method. */
export function effectiveMode({ mode, roundSeed = 0, shotSeed = 0 }) {
  if (mode === 'RANDOM') return pickMode(roundSeed);
  if (mode === 'ERRATIC') {
    const rand = lcg(hashSeeds(roundSeed, shotSeed));
    return EFFECTIVE_MODES[Math.floor(rand() * EFFECTIVE_MODES.length) % EFFECTIVE_MODES.length];
  }
  return mode;
}

/**
 * Pure outcome for a shell crossing a wall boundary. Inputs: side ('+x','-x',
 * '+z','-z'), position + velocity at the crossing, the (raw) wall mode, the
 * round/shot seeds and the DATA params (wallParams()). Output:
 *   { action:'pass' }                          NONE — shell flies out (oob)
 *   { action:'terminate', mode }               CONCRETE — solid wall absorbs
 *   { action:'reflect', x,y,z, vx,vy,vz, mode } bounced back inside
 *   { action:'wrap', x,y,z, vx,vy,vz, mode }    teleported, velocity preserved
 * The manual's wraparound is left/right (2D); on the 3D arena the same mirror
 * mapping applies to both horizontal axes (z edges included) — documented
 * adaptation, velocity never touched by wrap.
 */
export function resolveWall({ side, x, y, z, vx, vy, vz, mode, roundSeed = 0, shotSeed = 0, params = wallParams() }) {
  const resolved = effectiveMode({ mode, roundSeed, shotSeed });
  if (resolved === 'NONE') return { action: 'pass' };
  if (resolved === 'CONCRETE') return { action: 'terminate', mode: resolved };
  if (resolved === 'WRAP') {
    let nx = x, nz = z;
    if (side === '+x') nx = FIELD_X_MIN + (x - FIELD_X_MAX);
    else if (side === '-x') nx = FIELD_X_MAX - (FIELD_X_MIN - x);
    else if (side === '+z') nz = FIELD_Z_MIN + (z - FIELD_Z_MAX);
    else nz = FIELD_Z_MAX - (FIELD_Z_MIN - z);
    return { action: 'wrap', x: nx, y, z: nz, vx, vy, vz, mode: resolved };
  }
  // Reflective modes: flip the boundary-normal component, scale the whole
  // velocity by the mode's DATA multiplier. ERRATIC's chaotic kick (brief:
  // 0.5-2.0x, data-bounded) replaces the picked method's own multiplier.
  let mult;
  if (resolved === 'PADDED') mult = params.padded.energyRetain;
  else if (resolved === 'RUBBER') mult = 1; // clean bounce (manual: plain bounce)
  else if (resolved === 'SPRING') mult = params.spring.kick;
  else { // ERRATIC picked a reflective method: chaotic kick draw
    const rand = lcg(hashSeeds(roundSeed, shotSeed, 0x57a11));
    mult = params.erratic.speedMin + rand() * (params.erratic.speedMax - params.erratic.speedMin);
  }
  const nvx = side === '-x' ? -vx * mult : side === '+x' ? -vx * mult : vx * mult;
  const nvz = side === '-z' ? -vz * mult : side === '+z' ? -vz * mult : vz * mult;
  // Clamp the return position just inside the crossed boundary (integrator
  // overshoot back off the wall) — the tangential axes keep their position.
  const EPS = 1e-3;
  const nx = side === '+x' ? FIELD_X_MAX - EPS : side === '-x' ? FIELD_X_MIN + EPS : x;
  const nz = side === '+z' ? FIELD_Z_MAX - EPS : side === '-z' ? FIELD_Z_MIN + EPS : z;
  return { action: 'reflect', x: nx, y, z: nz, vx: nvx, vy: vy * mult, vz: nvz, mode: resolved };
}

/**
 * Settings seam: build the stepBallistic `walls` opts from the live sim state.
 * null when walls are NONE/unset — the ballistics oob contract stays untouched
 * (fail-noisy legacy path). Per-shot seed derives deterministically from the
 * shot seam fields (position + aim), so ERRATIC re-rolls per shot with no
 * extra state.
 */
export function wallsConfigFor(se, shot = {}) {
  const mode = se && se.settings ? se.settings.wallMode : undefined;
  if (!mode || mode === 'NONE') return null;
  if (!WALL_MODES.includes(mode)) throw new RangeError(`[walls] unknown wallMode ${JSON.stringify(mode)}`);
  const roundSeed = se.terrainSeed ? se.terrainSeed.value : 0;
  const shotSeed = hashSeeds(
    Math.round((shot.x ?? 0) * 1e3), Math.round((shot.y ?? 0) * 1e3), Math.round((shot.z ?? 0) * 1e3),
    Math.round((shot.angleDeg ?? 0) * 1e3), Math.round((shot.power ?? 0) * 1e6), Math.round((shot.bearingRad ?? 0) * 1e6),
  );
  return { mode, roundSeed, shotSeed, params: wallParams() };
}
