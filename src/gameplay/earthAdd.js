// S3c — earth deposition model (PURE: no DOM, no engine beyond voxel3d).
// The dirt class ("Earth Producing Weapons ... take some form of compacted
// earth that explodes into a much larger amount of dirt. These weapons can be
// used to build fortifications, or bury enemy tanks." — manual:L1125-L1128)
// ADDS terrain. Until S3d unifies the event pipeline, the deposit is applied
// HERE (via fillSphere) from inside the behavior, not by projectiles3d
// (FIX2-owned): the behavior emits {type:'earth_add', x, y, z, r, kind} AND
// applies the fill directly on ctx.field + remeshes through ctx.se.v3d so it
// works dispatched and standalone. The executor logs 'unknown behavior event
// type — skipped' for earth_add meanwhile (loud, benign; S3d unifies).
import { fillSphere } from '../voxel3d/blast.js';
import { cellX, cellY, cellZ } from '../voxel3d/constants.js';
import { columnTop } from '../voxel3d/field.js';
import weaponsData from '../../data/weapons.json' with { type: 'json' };

// W5 purge (plan SE-COMPLETE-1012 §4): the old MOUND_R/RIDGE JS literals are
// GONE — the dirt shapes are DATA (data/weapons.json .dirtShapes): mound
// radii (blastRadius scale law, manual:L988-L990 ratios), the clamping bounds
// for the scale-law fallback, and the low-wide ridge shape. A malformed block
// fails LOUD naming the file — no JS fallback exists (doctrine).
function dirtShape(doc, key, file) {
  const v = doc && doc.dirtShapes && doc.dirtShapes[key];
  if (v === undefined || v === null) {
    throw new TypeError(`[se/earthAdd] ${file} .dirtShapes.${key} missing — fix the data file, no JS fallback exists`);
  }
  return v;
}
const DS = weaponsData;
const MOUND_R_SRC = dirtShape(DS, 'mound', 'data/weapons.json');
export const MOUND_R = Object.freeze({ dirt_clod: MOUND_R_SRC.dirt_clod, dirt_ball: MOUND_R_SRC.dirt_ball, ton_of_dirt: MOUND_R_SRC.ton_of_dirt });
const BOUNDS = dirtShape(DS, 'moundBounds', 'data/weapons.json');
export const MOUND_R_MIN = BOUNDS.min, MOUND_R_MAX = BOUNDS.max;
export const RIDGE = dirtShape(DS, 'ridge', 'data/weapons.json');

/**
 * dirtDeposit(field, impactPoint, weapon) -> {dirtyChunks, topAfter, added, kind}
 * Applies the weapon's earth model at the impact point (world coords,
 * surface contact). kind: 'mound' | 'ridge'. Non-earth weapons fail loud
 * (console.error naming the weapon) and deposit nothing.
 */
export function dirtDeposit(field, impactPoint, weapon, opts = {}) {
  const none = { dirtyChunks: new Set(), topAfter: -1, added: 0, kind: null };
  let r, maxYWorld = undefined, kind;
  const dirtScale = typeof opts.scale === 'number' && opts.scale > 0 ? opts.scale : 1;
  if (weapon.behavior === 'liquid_dirt') {
    r = RIDGE.r * dirtScale;
    maxYWorld = impactPoint.y + r * RIDGE.flatFrac;
    kind = 'ridge';
  } else if (weapon.behavior === 'dirt') {
    if (MOUND_R[weapon.id] !== undefined) {
      r = MOUND_R[weapon.id];
    } else {
      // Unknown earth_produce id: scale-law fallback, LOUD (doctrine).
      const br = weapon.blastRadius;
      if (typeof br !== 'number') {
        console.error(`[se/earthAdd] weapon "${weapon.id}" is dirt-class with no pinned radius and no numeric blastRadius — skipping deposit`);
        return none;
      }
      r = Math.min(MOUND_R_MAX, Math.max(MOUND_R_MIN, br / 10)); // _placeholder scale law
      console.error(`[se/earthAdd] no mound radius pinned for "${weapon.id}" — using blastRadius/10 = ${r}`);
    }
    kind = 'mound';
  } else {
    console.error(`[se/earthAdd] weapon "${weapon.id}" (behavior "${weapon.behavior}") is not an earth-adding weapon — skipping deposit`);
    return none;
  }
  const res = fillSphere(field, impactPoint, r, { maxYWorld });
  const cx = cellX(impactPoint.x), cz = cellZ(impactPoint.z);
  // topAfter: the impact column's top AFTER the fill. fillSphere is add-only
  // so the column can only grow (heights-only is preserved by a hemisphere
  // sitting on a contiguous column — no compaction needed, see blast.js).
  const topAfter = columnTop(field, cx, cz);
  return { dirtyChunks: res.dirtyChunks, topAfter, added: res.added, kind, r };
}

/**
 * stamp(se, impactPoint, topCell, added) — settle-interaction seam.
 * The rim of a fresh mound can exceed the settle angle, and the merged
 * announce-stamp latch in settle3d picks up se.lastImpact when the director
 * enters 'settling'. projectiles3d owns that field for blast shots; for
 * dirt deposits (projectiles3d is FIX2-owned, untouchable here) we write the
 * SAME shape projectiles3d uses — {x, y, z, hit:'terrain', cell, added} —
 * with cell = the FILL-TOP cell of the impact column (topCellOfFill), so the
 * announced footprint covers the raised rim. Harmless overwrite if a blast
 * already stamped this frame (dirt weapons never blast).
 */
export function stamp(se, impactPoint, topCell, added, rWorld) {
  if (!se) return;
  if (typeof rWorld !== 'number') {
    console.error(`[se/earthAdd] stamp() called without rWorld (got ${String(rWorld)}) — settle announce would fall back noisily`);
  }
  se.lastImpact = {
    x: impactPoint.x, y: impactPoint.y, z: impactPoint.z,
    hit: 'terrain',
    cell: topCell ? { x: topCell.x, y: topCell.y, z: topCell.z } : undefined,
    // FIX2 seam (post-merge): monotone stamp (same se.impactN counter
    // projectiles3d uses) + the mound's world radius, so settle3d's
    // announceWatch latches on stamp CHANGE instead of hitting the
    // terrainCfg fallback with console.error.
    stamp: (se.impactN = (se.impactN || 0) + 1),
    rWorld: typeof rWorld === 'number' ? rWorld : undefined,
    added,
  };
}

// Helper for the behaviors: the fill-top cell of the impact column.
export function topCellOfFill(field, impactPoint) {
  const cx = cellX(impactPoint.x), cz = cellZ(impactPoint.z);
  const top = columnTop(field, cx, cz);
  return { x: cx, y: top, z: cz };
}
