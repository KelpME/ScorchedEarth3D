// Forward cone carve — the Riot Charge / Riot Blast turret-local primitive.
// A CONE whose APEX sits at the barrel (the turret spawn point) and opens
// FORWARD along the aim bearing (bearing 0 = +Z, the engine forwardFromYaw
// convention). The OG riot mechanic carved a SPHERE at the turret; the user
// directive (2026-10-21) replaces that sphere with a cone out of the barrel —
// the Charge carves a SMALLER cone than the Blast (catalog data).
//
// GEOMETRY (cell space, continuous): the cell-center vector from the apex is
// decomposed into a FORWARD component d along the (unit, horizontal) bearing
// axis and a PERPENDICULAR component (lateral + vertical). A cell is carved
// iff 0 <= d <= coneLength AND |perp| <= d * tan(halfAngle) — the cone flares
// linearly from a point at the apex to its base radius at the mouth. Hardness
// scaling mirrors blast(): the perp deltas are multiplied by the cell's own
// hardness floor (eff = max(hardness, 1/BLAST_SOFT_MAX_RADIUS)) so rock
// (eff 1.0) stays BYTE-IDENTICAL to an unscaled test and softer materials
// carve a bounded fatter cross-section (the same round-hole floor blast.js
// applies). The FORWARD distance d is NOT scaled — the cone's reach is fixed.
//
// DIRTY-CHUNK SPAN (blast.js doctrine, verbatim): a changed cell flips face
// decisions for its 6 neighbors, so for each touched column we mark chunkKeys
// over x-1..x+1 / z-1..z+1 (clamped) crossed with the y-buckets over
// [floor((lo-1)/CH) .. floor(min(H-1, hi+1)/CH)] of the removed-plus-compacted
// y-span. The y-bucket START is floor((lo-1)/CH), NOT floor(lo/CH): the cone's
// FLOOR is the +Y face of the cell just BELOW the lowest removed cell (lo-1),
// which lands in bucket lo/CH-1 when lo sits on a chunk line — one below
// floor(lo/CH). Marking from lo alone would leave the cone floor chunk
// un-rebuilt and the carve hollow (see test/unit/blast-crater-floor.test.js).
// This is a small superset of the chunks whose geometry could change, never a
// miss — the SAME resulting Set blast() produces.
//
// Return shape is EXACTLY blast()'s { removed, byMaterial, touchedColumns,
// dirtyChunks } so the instant-riot path (heavy.js instantRiotCone) is a
// drop-in swap of the old instantRiotBlast sphere carve.

import { W, H, Z, V, X_MIN, Z_MIN, CH, EMPTY, MATERIALS, chunkKey, FLOOR_CELLS } from './constants.js';
import { get, set, columnCompact3D } from './field.js';
import { BLAST_SOFT_MAX_RADIUS } from './blast.js';

const DEG = Math.PI / 180; // math constant (voxel3d layer — no gameplay import)

// Hardness floor cap reused from blast.js (the soft-ground round-hole bound);
// the cone's perp radius grows to SOFT_MAX * d*tan(half) for soft materials,
// so the AABB must span that much laterally + the forward length.
export function coneCarve(f, apex, bearingRad, halfAngleDeg, lengthWorld) {
  const halfRad = halfAngleDeg * DEG;
  const tanHalf = Math.tan(halfRad);
  const coneLengthCells = lengthWorld / V;
  const baseRCells = coneLengthCells * tanHalf; // mouth radius in cell units
  const soft = BLAST_SOFT_MAX_RADIUS;
  // Continuous cell-space apex (mirrors blast.js center derivation).
  const cX = (apex.x - X_MIN) / V;
  const cY = apex.y / V + FLOOR_CELLS; // world y=0 is cell FLOOR_CELLS
  const cZ = (apex.z - Z_MIN) / V;
  // Unit bearing axis in cell space (x/z share the V scale; horizontal, y=0).
  // bearingRad 0 = +Z (forwardFromYaw): forward = (sin b, cos b).
  const axisX = Math.sin(bearingRad);
  const axisZ = Math.cos(bearingRad);
  // Bounding box: the cone reaches `coneLengthCells` forward and flares to
  // baseRCells*soft laterally + vertically; a symmetric span about the apex is
  // a small superset (the per-cell test rejects the excess, like blast).
  const span = Math.max(coneLengthCells, baseRCells * soft) + 2;
  const xMin = Math.max(0, Math.floor(cX - span));
  const xMax = Math.min(W - 1, Math.ceil(cX + span));
  const zMin = Math.max(0, Math.floor(cZ - span));
  const zMax = Math.min(Z - 1, Math.ceil(cZ + span));
  const ySpan = baseRCells * soft + 2;
  const yMin = Math.max(0, Math.floor(cY - ySpan));
  const yMax = Math.min(H - 1, Math.ceil(cY + ySpan));

  const byMaterial = Object.fromEntries(MATERIALS.slice(1).map((mt) => [mt.id, 0]));
  const touchedColumns = [];
  const dirtyChunks = new Set();
  const changed = new Set(); // reusable per-column scratch
  let removed = 0;
  let dxLo = Infinity, dxHi = -1, dyLo = Infinity, dyHi = -1, dzLo = Infinity, dzHi = -1;

  for (let x = xMin; x <= xMax; x++) {
    for (let z = zMin; z <= zMax; z++) {
      let colRemoved = 0;
      let lo = Infinity, hi = -1; // y-span of removed cells in this column
      for (let y = yMin; y <= yMax; y++) {
        const m = get(f, x, y, z);
        if (m === EMPTY) continue;
        // Cell-center continuous cell-space offset from the apex.
        const px = (x + 0.5) - cX;
        const py = (y + 0.5) - cY;
        const pz = (z + 0.5) - cZ;
        // Forward distance along the bearing axis (unscaled — the cone's reach).
        const d = px * axisX + pz * axisZ;
        if (d < 0 || d > coneLengthCells) continue; // behind the apex or past the mouth
        // Perpendicular component (lateral + vertical) from the axis.
        const perpX = px - d * axisX;
        const perpZ = pz - d * axisZ;
        const perpY = py;
        // Hardness floor (blast.js): soft materials carve a bounded fatter
        // cross-section; rock (eff 1.0) is unchanged.
        const hardness = MATERIALS[m].hardness;
        const eff = Math.max(hardness, 1 / soft);
        const hpx = perpX * eff, hpy = perpY * eff, hpz = perpZ * eff;
        const maxR = d * tanHalf; // cone radius at this forward distance (cell units)
        if (hpx * hpx + hpy * hpy + hpz * hpz <= maxR * maxR) {
          set(f, x, y, z, EMPTY);
          byMaterial[MATERIALS[m].id] = (byMaterial[MATERIALS[m].id] ?? 0) + 1;
          colRemoved++;
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
      }
      if (colRemoved === 0) continue;
      touchedColumns.push([x, z]);
      removed += colRemoved;

      // Gravity: drop everything above the carve; collect net value changes.
      changed.clear();
      columnCompact3D(f, x, z, changed);
      for (const y of changed) {
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      // Dirty span in cell space: neighbor columns x-1..x+1 / z-1..z+1
      // (clamped) and y [lo .. min(H-1, hi+1)] — a changed cell flips face
      // decisions for its 6 neighbors; the y+1 covers the bucket-boundary
      // face above hi (belongs to the cell above too).
      if (x - 1 < dxLo) dxLo = x - 1;
      if (x + 1 > dxHi) dxHi = x + 1;
      if (z - 1 < dzLo) dzLo = z - 1;
      if (z + 1 > dzHi) dzHi = z + 1;
      if (lo < dyLo) dyLo = lo;
      const yTop = Math.min(H - 1, hi + 1);
      if (yTop > dyHi) dyHi = yTop;
    }
  }

  // Emit the dirty bucket rect once (blast.js doctrine). Bucket index is
  // monotone in cell coords (CH power of two), so the rect over the clamped
  // dirty bounds covers every chunkKey the per-column x±1 / z±1 / y[lo..hi+1]
  // rule would mark. The y-bucket START is floor((dyLo-1)/CH) — the cone's
  // FLOOR is the +Y face of the cell just below the lowest removed cell (lo-1),
  // which lands in bucket lo/CH-1 on a chunk line (see blast.js header +
  // test/unit/blast-crater-floor.test.js).
  if (dxHi >= dxLo) {
    if (dxLo < 0) dxLo = 0;
    if (dxHi > W - 1) dxHi = W - 1;
    if (dzLo < 0) dzLo = 0;
    if (dzHi > Z - 1) dzHi = Z - 1;
    const yByLo = Math.floor((dyLo - 1) / CH);
    for (let bx = Math.floor(dxLo / CH); bx <= Math.floor(dxHi / CH); bx++) {
      for (let by = yByLo; by <= Math.floor(dyHi / CH); by++) {
        for (let bz = Math.floor(dzLo / CH); bz <= Math.floor(dzHi / CH); bz++) {
          dirtyChunks.add(chunkKey(bx * CH, by * CH, bz * CH));
        }
      }
    }
  }

  return { removed, byMaterial, touchedColumns, dirtyChunks };
}
