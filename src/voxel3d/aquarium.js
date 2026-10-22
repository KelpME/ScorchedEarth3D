// T-G4 — the aquarium front trench. The cage (CAGE_*) is the play area; the
// ring out to the field extents is exterior terrain. Emptying every cell
// with world z >= CAGE_Z_MAX (the front buffer ring, camera side — front is
// +Z) over the FULL y range means the T-G2 boundary-face mesher emits a real
// cut-strata wall at the trench face: the user's "someone dug a big hole in
// front of the front pane to see the cut section".
import {
  W, H, Z, V, Z_MIN, EMPTY,
  CAGE_X_MIN, CAGE_X_MAX, CAGE_Z_MIN, CAGE_Z_MAX,
  FIELD_X_MIN, FIELD_X_MAX, FIELD_Z_MIN, FIELD_Z_MAX,
} from './constants.js';
import terrainData from '../../data/voxel-terrain.json' with { type: 'json' };

/**
 * DEEPEN-1015 L3b: the trench's carve depth beyond the trench wall is DATA
 * (data/voxel-terrain.json .trench.trenchWorldDepth) — the carve is BOUNDED
 * so the cut-strata face keeps a back face and the real-field front corridor
 * beyond it stays FILLED (the flyover's falling terrain). Fail-noisy: a
 * missing/malformed value throws naming the file — no silent default.
 */
export function trenchWorldDepth() {
  const t = terrainData?.trench?.trenchWorldDepth;
  if (typeof t !== 'number' || !Number.isFinite(t) || !(t > 0)) {
    throw new TypeError(`[aquarium] data/voxel-terrain.json .trench.trenchWorldDepth missing/non-numeric/non-positive: ${JSON.stringify(t)} — fix the data file, no JS fallback exists`);
  }
  if (CAGE_Z_MAX + t > FIELD_Z_MAX) {
    throw new RangeError(`[aquarium] data/voxel-terrain.json .trench.trenchWorldDepth=${t} puts the trench back face past the field front edge (CAGE_Z_MAX=${CAGE_Z_MAX} + ${t} > FIELD_Z_MAX=${FIELD_Z_MAX}) — the corridor would be carved away entirely`);
  }
  return t;
}

/**
 * Pure: the BOUNDED trench extent — the world-z band the carve empties.
 * Default (data-declared): { zMin: FIELD_Z_MIN, zMax: CAGE_Z_MAX + trenchWorldDepth() }.
 */
export function trenchExtent() {
  return { zMin: FIELD_Z_MIN, zMax: CAGE_Z_MAX + trenchWorldDepth() };
}

/**
 * Carve the front buffer ring: every cell with world z >= cage.zMax, all y.
 * Layout is y-rows of W*Z cells (idx = x + z*W + y*W*Z), so one (y, z) row is
 * a single contiguous fill(EMPTY) of W cells.
 *
 * @param {{ cells: Uint8Array }} field
 * @param {{ xMin, xMax, zMin, zMax }} [cage]   defaults: the CAGE_* constants
 * @param {{ xMin, xMax, zMin, zMax }} [extent] defaults: the FIELD_* constants
 * @param {{ zMin, zMax }} [trench] defaults: trenchExtent() — the BOUNDED
 *   world-z band to empty (zMin informational; the carve starts at the
 *   trench wall cage.zMax and stops at trench.zMax, L3b)
 * @returns {{ carvedCells: number, cellZStart: number, cellZEnd: number }} for boot logging
 */
export function carveFrontTrench(
  field,
  cage = { xMin: CAGE_X_MIN, xMax: CAGE_X_MAX, zMin: CAGE_Z_MIN, zMax: CAGE_Z_MAX },
  extent = { xMin: FIELD_X_MIN, xMax: FIELD_X_MAX, zMin: FIELD_Z_MIN, zMax: FIELD_Z_MAX },
  trench = trenchExtent(),
) {
  // Fail-noisy doctrine: refuse to carve bounds that make no geometric sense,
  // naming exactly which constant is wrong — never silently carve nothing.
  if (!(extent.xMin < extent.xMax) || !(extent.zMin < extent.zMax)) {
    throw new RangeError(`[aquarium] field extents inverted: FIELD_X_MIN=${extent.xMin} FIELD_X_MAX=${extent.xMax} FIELD_Z_MIN=${extent.zMin} FIELD_Z_MAX=${extent.zMax}`);
  }
  if (!(cage.xMin < cage.xMax) || !(cage.zMin < cage.zMax)) {
    throw new RangeError(`[aquarium] cage bounds inverted: CAGE_X_MIN=${cage.xMin} CAGE_X_MAX=${cage.xMax} CAGE_Z_MIN=${cage.zMin} CAGE_Z_MAX=${cage.zMax}`);
  }
  if (cage.xMin <= extent.xMin) throw new RangeError(`[aquarium] CAGE_X_MIN=${cage.xMin} is not strictly inside FIELD_X_MIN=${extent.xMin}`);
  if (cage.xMax >= extent.xMax) throw new RangeError(`[aquarium] CAGE_X_MAX=${cage.xMax} is not strictly inside FIELD_X_MAX=${extent.xMax}`);
  if (cage.zMin <= extent.zMin) throw new RangeError(`[aquarium] CAGE_Z_MIN=${cage.zMin} is not strictly inside FIELD_Z_MIN=${extent.zMin}`);
  if (cage.zMax >= extent.zMax) throw new RangeError(`[aquarium] CAGE_Z_MAX=${cage.zMax} is not strictly inside FIELD_Z_MAX=${extent.zMax}`);

  // world z -> cell: cellZ = floor((wz - Z_MIN) / V). First carved cell is the
  // one whose lower edge sits at/above cage.zMax; epsilon guards the exact-fit
  // float boundary (cage.zMax=20, Z_MIN=-30, V=0.25 -> exactly 200).
  const z0 = Math.ceil((cage.zMax - Z_MIN) / V - 1e-9);
  if (!(z0 > 0 && z0 <= Z)) {
    throw new RangeError(`[aquarium] trench start cellZ=${z0} outside field (0, ${Z}] — check cage.zMax=${cage.zMax} vs Z_MIN=${Z_MIN}/V=${V}`);
  }
  // L3b: the carve is BOUNDED — it stops at the trench's back face (world z
  // = trench.zMax, cellZ below), so the real-field corridor beyond it stays
  // FILLED (the flyover's falling terrain). Fail-noisy on an unbounded or
  // degenerate extent — never silently carve the whole corridor.
  if (!(trench.zMin < trench.zMax)) {
    throw new RangeError(`[aquarium] trench extent inverted: trench.zMin=${trench.zMin} trench.zMax=${trench.zMax} — data/voxel-terrain.json .trench`);
  }
  const zEnd = Math.ceil((trench.zMax - Z_MIN) / V - 1e-9);
  if (!(zEnd > z0 && zEnd < Z)) {
    throw new RangeError(`[aquarium] trench end cellZ=${zEnd} is not a bounded back face inside the field (must be > start ${z0} and < Z=${Z}) — check trench.zMax=${trench.zMax} vs Z_MIN=${Z_MIN}/V=${V} (the corridor beyond it must stay FILLED)`);
  }

  let carvedCells = 0;
  for (let y = 0; y < H; y++) {
    for (let z = z0; z < zEnd; z++) {
      const base = z * W + y * W * Z;
      field.cells.fill(EMPTY, base, base + W);
      carvedCells += W;
    }
  }
  return { carvedCells, cellZStart: z0, cellZEnd: zEnd };
}
