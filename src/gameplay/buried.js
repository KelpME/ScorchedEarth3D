/**
 * SETTLE-PACE-1015 (user directive, option 1) — BURIED TANKS. PURE: no DOM,
 * no engine imports, no Math.random, no clock.
 *
 * Doctrine: dirt on top of a tank BURIES it. A tank is buried when
 *   surf − tank.y >= minCoverU
 * (surf = the column surface world-y above the tank, minCoverU = DATA:
 * data/physics-presets.json `.buried` — 0.3u ≈ one 0.25u voxel + epsilon).
 * A buried tank cannot DRIVE but CAN aim/fire; its own blasts carve the
 * column and the tank falls free via the existing tanks-stage fall path
 * (fall damage per .impact when the carve over-deepens).
 *
 * A malformed data block fails LOUD naming the file — no JS fallback exists
 * (same precedent as impactParams).
 */

import ppData from '../../data/physics-presets.json' with { type: 'json' };

/**
 * buriedParams(doc?): validate + return the .buried block from
 * data/physics-presets.json (or an injected doc for tests). Fails loud
 * naming the file on a missing/non-numeric minCoverU.
 */
export function buriedParams(doc = ppData) {
  const b = doc && doc.buried;
  const bad = !b || typeof b.minCoverU !== 'number' || !Number.isFinite(b.minCoverU);
  if (bad) {
    throw new TypeError(
      `[se/buried] data/physics-presets.json .buried missing/non-numeric ` +
      `minCoverU — fix the data file, no JS fallback exists: ${JSON.stringify(b && Object.keys(b))}`,
    );
  }
  return { minCoverU: b.minCoverU };
}

/**
 * isBuried({ tankY, surf, minCoverU }) -> boolean. MISSING/JUNK ARGS THROW
 * naming the field (fail-loud: a silent false would let a buried tank drive
 * through solid dirt). Exactly minCoverU of cover => buried (>= comparison);
 * just under => not. tankY/surf may be any finite numbers (a tank ABOVE its
 * surface is never buried — surf − tankY < 0). PURE.
 */
export function isBuried({ tankY, surf, minCoverU } = {}) {
  if (typeof tankY !== 'number' || !Number.isFinite(tankY)) {
    throw new TypeError(`[se/buried] isBuried: tankY missing/non-numeric (got ${JSON.stringify(tankY)})`);
  }
  if (typeof surf !== 'number' || !Number.isFinite(surf)) {
    throw new TypeError(`[se/buried] isBuried: surf missing/non-numeric (got ${JSON.stringify(surf)})`);
  }
  if (typeof minCoverU !== 'number' || !Number.isFinite(minCoverU)) {
    throw new TypeError(`[se/buried] isBuried: minCoverU missing/non-numeric (got ${JSON.stringify(minCoverU)})`);
  }
  return surf - tankY >= minCoverU;
}

/**
 * buriedTanks(players, transforms, surfAt, minCoverU) -> Set of player ids
 * whose tank is buried. players: [{ id, alive, ... }]; transforms: Map or
 * object of id -> { y }; surfAt(id) -> column surface world-y. DEAD players
 * are skipped (a wreck cannot drive regardless). Malformed per-tank entries
 * are skipped, not thrown (a missing transform is a scene condition, not bad
 * data — the caller gates the movement, not this helper). PURE.
 */
export function buriedTanks(players, transforms, surfAt, minCoverU) {
  const out = new Set();
  if (!Array.isArray(players)) {
    throw new TypeError(`[se/buried] buriedTanks: players missing/not an array (got ${JSON.stringify(players && typeof players)})`);
  }
  if (typeof surfAt !== 'function') {
    throw new TypeError('[se/buried] buriedTanks: surfAt must be a function');
  }
  for (const p of players) {
    if (!p || !p.alive) continue;
    const tr = transforms instanceof Map ? transforms.get(p.id) : transforms?.[p.id];
    if (!tr || typeof tr.y !== 'number' || !Number.isFinite(tr.y)) continue;
    if (isBuried({ tankY: tr.y, surf: surfAt(p.id), minCoverU })) out.add(p.id);
  }
  return out;
}
