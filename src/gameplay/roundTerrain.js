// T-G5 — round-terrain reseeding helpers (PURE: constants + field readers only,
// no DOM/window). Two jobs:
//   advanceSeed(seed): walk the exact LCG recurrence src/voxel3d/generator.js
//     uses (multiplier 1664525, increment 1013904223, >>>0) so each round's
//     terrain is a fresh, deterministic run of the same generator.
//   pickSpawns(field, n): one spawn per cage side, EXACTLY on the voxel
//     surface — y = (columnTop+1)*V, the same formula boot grounding
//     (voxelSurfaceWorld in main.js) uses. Deterministic per field: a fixed
//     deterministic scan, no RNG (the terrain itself is the entropy).
// Doctrine: a fully-carved side means NO ground to stand on — fail noisy
// naming the side (console.error + throw), never return a silent hover spawn.
import {
  V, cellX, cellZ, cellTopWorldY, CAGE_X_MIN, CAGE_X_MAX, CAGE_Z_MIN, CAGE_Z_MAX,
} from '../voxel3d/constants.js';
import { columnTop } from '../voxel3d/field.js';

// W1.5 zone-roll LCG — same recurrence as advanceSeed/generator (deterministic,
// no Math.random anywhere). Seeded per (roundSeed, slot index).
const LCG_A = 1664525;
const LCG_C = 1013904223;
function zoneRng(seed) {
  let s = (seed >>> 0) || 1; // 0 would fixpoint on LCG_C; 1 keeps determinism
  return () => {
    s = (Math.imul(s, LCG_A) + LCG_C) >>> 0;
    return s / 2 ** 32;
  };
}

export function advanceSeed(seed) {
  return ((seed >>> 0) * 1664525 + 1013904223) >>> 0;
}

// Surface world-y exactly as boot grounding computes it. Private mirror:
// main.js's voxelSurfaceWorld clamps out-of-field reads to edge columns; here
// a carved column (top -1) is a HARD failure instead (no ground to spawn on).
function surfaceY(field, x, z) {
  const cx = cellX(x); // SE-EXPANSION-1012 A1: live extents, never -120/-30 literals
  const cz = cellZ(z);
  const top = columnTop(field, cx, cz);
  if (top < 0) return null; // fully carved column — caller fails noisy
  return cellTopWorldY(top);
}

/**
 * W1.5 — the N edge ANCHORS without zone jitter (the historical pickSpawns
 * result, byte-identical). Exported so tests (and the zone roll) can prove
 * zone containment and non-crossing against the anchors themselves.
 * Deterministic spawn scan. LEFT third takes the first (lowest x) solid
 * column stepping inward; RIGHT third the first solid column stepping inward
 * from the right edge, kept >= 60 world units away from the left spawn.
 * SE-NPLAYER-1012: N = 2..4 (the setup player-count picker's data range).
 * n = 2 keeps the HISTORICAL two spawns byte-identical. n = 3 adds the BACK
 * edge slot (x mid, z scanning inward from CAGE_Z_MIN); n = 4 adds the FRONT
 * edge slot (x mid, z scanning inward from CAGE_Z_MAX-STEP — strictly inside
 * the cage, so never in the carved z >= CAGE_Z_MAX aquarium trench). Every
 * slot probes surfaceY, so a carved column is skipped; a fully unusable slot
 * fails noisy naming it (never a silent hover spawn).
 * @param {{ cells: Uint8Array }} field
 * @param {number} n spawn count (2..4 — the data picker's range)
 * @returns {Array<{x:number,y:number,z:number}>}
 */
export function spawnAnchors(field, n = 2) {
  if (!(Number.isInteger(n) && n >= 2 && n <= 4)) {
    console.error(`[roundTerrain] spawnAnchors supports 2..4 spawns (the play-options player-count range), got n=${n}`);
    throw new RangeError(`[roundTerrain] spawnAnchors supports 2..4 spawns (one per edge slot), got n=${n}`);
  }
  const third = (CAGE_X_MAX - CAGE_X_MIN) / 3;
  const z = (CAGE_Z_MIN + CAGE_Z_MAX) / 2; // cage mid — always within the cage
  const STEP = 2; // world units between probe columns

  const scan = (side) => {
    const inward = side === 'left';
    const lo = inward ? CAGE_X_MIN : CAGE_X_MAX - third;
    const hi = inward ? CAGE_X_MIN + third : CAGE_X_MAX;
    for (let x = inward ? lo + STEP : hi - STEP; x >= lo && x <= hi; x += inward ? STEP : -STEP) {
      const y = surfaceY(field, x, z);
      if (y !== null) return { x, y, z };
    }
    return null;
  };

  const left = scan('left');
  if (!left) {
    console.error(`[roundTerrain] LEFT third of the cage (x in [${CAGE_X_MIN},${CAGE_X_MIN + third}]) is FULLY CARVED — no ground to spawn tank1 on (reseed refused)`);
    throw new Error(`[roundTerrain] cannot spawn: fully carved LEFT cage side (x in [${CAGE_X_MIN},${CAGE_X_MIN + third}])`);
  }
  const GAP = 60;
  let right = null;
  for (let x = CAGE_X_MAX - STEP; x >= CAGE_X_MAX - third; x -= STEP) {
    if (x - left.x < GAP) break;
    const y = surfaceY(field, x, z);
    if (y !== null) { right = { x, y, z }; break; }
  }
  if (!right) {
    console.error(`[roundTerrain] RIGHT third of the cage (x in [${CAGE_X_MAX - third},${CAGE_X_MAX}]) is FULLY CARVED (or <60u from the left spawn) — no ground to spawn tank2 on (reseed refused)`);
    throw new Error(`[roundTerrain] cannot spawn: fully carved RIGHT cage side (x in [${CAGE_X_MAX - third},${CAGE_X_MAX}])`);
  }
  if (n === 2) return [left, right];

  // SE-NPLAYER-1012 — BACK / FRONT edge slots: x = cage mid, z scanning
  // inward from the respective cage edge (front stops BEFORE CAGE_Z_MAX, so
  // the carved aquarium trench is never probed). Same fail-noisy contract.
  const xMid = (CAGE_X_MIN + CAGE_X_MAX) / 2;
  const scanZ = (edge) => {
    const fromBack = edge === 'back';
    const lo = fromBack ? CAGE_Z_MIN : CAGE_Z_MAX - STEP;
    const hi = fromBack ? CAGE_Z_MAX - STEP : CAGE_Z_MIN;
    for (let zz = lo; fromBack ? zz <= hi : zz >= hi; zz += fromBack ? STEP : -STEP) {
      const y = surfaceY(field, xMid, zz);
      if (y !== null) return { x: xMid, y, z: zz };
    }
    return null;
  };
  const back = scanZ('back');
  if (!back) {
    console.error(`[roundTerrain] BACK edge (z in [${CAGE_Z_MIN},${CAGE_Z_MAX - STEP}] at x=${xMid}) is FULLY CARVED — no ground to spawn tank3 on (reseed refused)`);
    throw new Error(`[roundTerrain] cannot spawn: fully carved BACK cage edge at x=${xMid}`);
  }
  if (n === 3) return [left, right, back];
  const front = scanZ('front');
  if (!front) {
    console.error(`[roundTerrain] FRONT edge (z in [${CAGE_Z_MIN},${CAGE_Z_MAX - STEP}] at x=${xMid}) is FULLY CARVED — no ground to spawn tank4 on (reseed refused)`);
    throw new Error(`[roundTerrain] cannot spawn: fully carved FRONT cage edge at x=${xMid}`);
  }
  return [left, right, back, front];
}

/**
 * W1.5 (plan SE-COMPLETE-1012) — LOCALIZED per-player spawn zones.
 * Each player owns the edge ANCHOR (spawnAnchors) plus a randomization RADIUS
 * (opts.radius, from data play-options.json players.spawnRadius); the tank
 * spawns at a deterministic-per-seed point WITHIN its zone:
 *   - effective radius = min(dataRadius, half the min anchor separation) —
 *     zones can never cross (the anchor-separation proof is by construction);
 *   - candidate = anchor + LCG jitter (same recurrence as advanceSeed), seeded
 *     by (opts.seed, slot index) — same seed = same spawn set, no Math.random;
 *   - clamped into the slot's third (left/right) or the cage minus the carved
 *     front trench (back/front), on SOLID ground (surfaceY probe);
 *   - min distance from already-placed tanks: 60 world units for the
 *     historical left/right pair, 10 for the rest — violated candidates fall
 *     back toward the anchor (the anchors were already validated usable).
 * opts.radius <= 0 (default) returns the anchors byte-identically — the
 * pre-W1.5 behavior, so every historical pin holds untouched.
 * @param {{ cells: Uint8Array }} field
 * @param {number} n spawn count (2..4)
 * @param {{ radius?: number, seed?: number }} [opts] zone radius + round seed
 * @returns {Array<{x:number,y:number,z:number}>}
 */
export function pickSpawns(field, n = 2, opts = {}) {
  const anchors = spawnAnchors(field, n);
  const radius = typeof opts.radius === 'number' && Number.isFinite(opts.radius) ? opts.radius : 0;
  if (radius <= 0) return anchors;
  const seed = (opts.seed ?? 0) >>> 0;
  const STEP = 2;
  const third = (CAGE_X_MAX - CAGE_X_MIN) / 3;
  // slot clamp boxes: left/right stay inside their historical third (the
  // reseed/nplayer pins); back/front stay inside the cage, out of the trench.
  const box = (i) => (i < 2
    ? { xMin: i === 0 ? CAGE_X_MIN + STEP : CAGE_X_MAX - third, xMax: i === 0 ? CAGE_X_MIN + third : CAGE_X_MAX - STEP, zMin: CAGE_Z_MIN, zMax: CAGE_Z_MAX }
    : { xMin: CAGE_X_MIN, xMax: CAGE_X_MAX, zMin: CAGE_Z_MIN + STEP, zMax: CAGE_Z_MAX - STEP });
  const eff = anchors.map((a, i) => {
    const seps = anchors.filter((_, j) => j !== i).map((b) => Math.hypot(a.x - b.x, a.z - b.z));
    return Math.min(radius, Math.min(...seps) / 2);
  });
  const placed = [];
  for (let i = 0; i < n; i++) {
    const minDist = i < 2 ? 60 : 10; // historical left/right GAP 60; edge slots 10
    const bx = box(i);
    const rand = zoneRng((seed ^ Math.imul(i + 1, 2654435761)) >>> 0);
    let chosen = null;
    for (let attempt = 0; attempt < 6 && !chosen; attempt++) {
      const dx = (rand() * 2 - 1) * eff[i];
      const dz = (rand() * 2 - 1) * eff[i];
      const x = Math.min(bx.xMax, Math.max(bx.xMin, anchors[i].x + dx));
      const z = Math.min(bx.zMax, Math.max(bx.zMin, anchors[i].z + dz));
      const y = surfaceY(field, x, z);
      if (y === null) continue; // carved column — never a hover spawn
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < minDist)) continue;
      chosen = { x, y, z };
    }
    if (!chosen) chosen = anchors[i]; // anchor fallback: validated usable, separated from the anchors
    placed.push(chosen);
  }
  return placed;
}
