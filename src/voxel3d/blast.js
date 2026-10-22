// Spherical blast with per-material hardness scaling + gravity re-stack.
// A solid cell is removed iff the hardness-scaled distance to the center
// <= rCells, where ALL THREE axis deltas are multiplied by the cell's own
// hardness (isotropic 3D version of the old 2.5D springy crater: soft
// ground excavates further in every direction; hard rock resists).
//
// HARDNESS FLOOR (blast.js — round holes + bound soft-ground voxels): the
// intended carve radius is r/hardness, but an unscaled AABB would clip the
// bigger soft-ground sphere into a SQUARE footprint (grass/dirt hardness
// 0.4/0.6 carved a literal square hole, ~2.18x the voxels of the round rock
// crater). The floor raises hardness below 1/BLAST_SOFT_MAX_RADIUS so the
// effective radius is r * clamp(1/hardness, 1, SOFT_MAX) — rock (hardness
// 1.0) stays BYTE-IDENTICAL (Math.max(1.0, 1/1.25)=1.0), softer materials
// carve a bounded ROUND hole capped at SOFT_MAX*r. The AABB loop bounds grow
// by the same SOFT_MAX (more cells TEST, fewer CARVE — net perf win: the
// per-frame settle cost tracks carved voxels, and blast() runs once per
// impact, not per frame). SOFT_MAX is DATA (physics-presets .blast), fail
// loud at module load — no JS literal, no silent default.
//
// dirtyChunks rule (documented per contract): a changed cell changes FACE
// DECISIONS for its 6 neighbors — a removal at chunk-cell 31 also exposes
// geometry in the chunk on the other side of the border. So for each touched
// column we mark chunkKeys over x-1..x+1 and z-1..z+1 (clamped to the field;
// no out-of-field marks) crossed with the y-buckets covering
// [floor((lo-1)/CH) .. floor(min(H-1, hi+1)/CH)], where [lo..hi] is the y-span
// of removed cells plus the net-diff y-positions from compaction
// (collected by columnCompact3D). The ±1 on BOTH ends: faces live BETWEEN
// cells — the bucket-boundary face at y%CH==0 belongs to the cell below AND
// above. The y+1 covers the face of the cell ABOVE hi (newly exposed when a
// removal opens the top of the span); the y-1 covers the CRATER FLOOR — the
// +Y face of the cell just BELOW lo, which becomes the visible crater bottom
// when lo lands exactly on a chunk boundary (lo%CH==0): that floor cell lives
// in bucket lo/CH-1, one below floor(lo/CH), so a carve that stops on a chunk
// line would otherwise leave its floor chunk un-rebuilt and the crater hollow
// (see test/unit/blast-crater-floor.test.js). This is a small superset of the
// chunks whose geometry could change, never a miss.

import { W, H, Z, V, X_MIN, Z_MIN, CH, EMPTY, MATERIALS, chunkKey, FLOOR_CELLS } from './constants.js';
import { get, set, columnCompact3D } from './field.js';
import ppData from '../../data/physics-presets.json' with { type: 'json' };

// HARDNESS FLOOR cap (blast.js): the intended carve radius is r/hardness; a
// material softer than 1/BLAST_SOFT_MAX_RADIUS would blow past SOFT_MAX*r and
// the unscaled AABB would clip that bigger sphere into a SQUARE hole. This
// DATA scalar (physics-presets .blast.softGroundMaxRadiusFrac) bounds the
// soft-ground radius at SOFT_MAX*r — round holes, bounded voxel count. Fail
// loud at module load (the settle3d.js remeshPerStep precedent): no JS literal,
// no silent default.
const rawBlast = ppData?.blast;
const rawSoftMax = rawBlast?.softGroundMaxRadiusFrac?.default;
if (typeof rawSoftMax !== 'number' || !Number.isFinite(rawSoftMax) || rawSoftMax <= 0) {
  throw new Error(`[se/voxel3d] data/physics-presets.json: blast.softGroundMaxRadiusFrac must be a positive finite number (got ${JSON.stringify(rawSoftMax)}) — fix the data file`);
}
export const BLAST_SOFT_MAX_RADIUS = rawSoftMax;

export function blast(f, center, rWorld) {
  const rCells = rWorld / V;
  const r2 = rCells * rCells;
  const cX = (center.x - X_MIN) / V; // continuous cell-space center
  // DEEPEN-1015 R6: world y=0 is cell FLOOR_CELLS — shift the continuous
  // cell-space center into the offset field grid.
  const cY = center.y / V + FLOOR_CELLS;
  const cZ = (center.z - Z_MIN) / V;

  // AABB clipped to the field — corner blasts just carve less, never throw.
  // Bounded by BLAST_SOFT_MAX_RADIUS: the effective carve radius is r *
  // clamp(1/hardness, 1, SOFT_MAX), so the loop must visit up to SOFT_MAX*r
  // cells in each axis to TEST the softer-than-rock materials (the carve test
  // below carves fewer than the AABB spans — net perf win, see file header).
  const xMin = Math.max(0, Math.floor(cX - rCells * BLAST_SOFT_MAX_RADIUS - 1));
  const xMax = Math.min(W - 1, Math.ceil(cX + rCells * BLAST_SOFT_MAX_RADIUS + 1));
  const yMin = Math.max(0, Math.floor(cY - rCells * BLAST_SOFT_MAX_RADIUS - 1));
  const yMax = Math.min(H - 1, Math.ceil(cY + rCells * BLAST_SOFT_MAX_RADIUS + 1));
  const zMin = Math.max(0, Math.floor(cZ - rCells * BLAST_SOFT_MAX_RADIUS - 1));
  const zMax = Math.min(Z - 1, Math.ceil(cZ + rCells * BLAST_SOFT_MAX_RADIUS + 1));

  const byMaterial = Object.fromEntries(MATERIALS.slice(1).map((mt) => [mt.id, 0]));
  const touchedColumns = [];
  const dirtyChunks = new Set();
  const changed = new Set(); // reusable per-column scratch
  let removed = 0;
  // Dirty-area bounds in CELL space (x/z clamped to the field). Bucket
  // indices are monotone in cell coords, so the union of the per-column
  // marks below is exactly the bucket rect over these bounds — we track
  // cheap integer min/max in the hot loop and generate the chunkKey strings
  // once after it (same resulting Set, ~9x fewer string allocations).
  let dxLo = Infinity, dxHi = -1, dyLo = Infinity, dyHi = -1, dzLo = Infinity, dzHi = -1;

  for (let x = xMin; x <= xMax; x++) {
    for (let z = zMin; z <= zMax; z++) {
      let colRemoved = 0;
      let lo = Infinity, hi = -1; // y-span of removed cells in this column
      for (let y = yMin; y <= yMax; y++) {
        const m = get(f, x, y, z);
        if (m === EMPTY) continue;
        const hardness = MATERIALS[m].hardness;
        // Hardness floor (blast.js): raise sub-1/SOFT_MAX hardness to the floor
        // so the effective radius is r * clamp(1/hardness, 1, SOFT_MAX) — rock
        // (hardness 1.0) is unchanged (Math.max(1.0, 1/1.25)=1.0) and softer
        // materials carve a bounded ROUND hole instead of an AABB-clipped square.
        const effHardness = Math.max(hardness, 1 / BLAST_SOFT_MAX_RADIUS);
        const dx = (x + 0.5 - cX) * effHardness;
        const dy = (y + 0.5 - cY) * effHardness;
        const dz = (z + 0.5 - cZ) * effHardness;
        if (dx * dx + dy * dy + dz * dz <= r2) {
          set(f, x, y, z, EMPTY);
          // byMaterial keyed dynamically on MATERIALS ids; the hardness read
          // above is the FIRST MATERIALS[m] access, so an unknown material
          // value already threw noisily before this line is reached.
          byMaterial[MATERIALS[m].id] = (byMaterial[MATERIALS[m].id] ?? 0) + 1;
          colRemoved++;
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
      }
      if (colRemoved === 0) continue;
      touchedColumns.push([x, z]);
      removed += colRemoved;

      // Gravity: drop everything above the hole; collect net value changes.
      changed.clear();
      columnCompact3D(f, x, z, changed);
      for (const y of changed) {
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      // Dirty span in cell space: neighbor columns x-1..x+1 / z-1..z+1
      // (clamped to the field) and y [lo .. min(H-1, hi+1)] — a changed
      // cell flips face decisions for its 6 neighbors, and the y+1 covers
      // the bucket-boundary face above hi (it belongs to the cell above too).
      if (x - 1 < dxLo) dxLo = x - 1;
      if (x + 1 > dxHi) dxHi = x + 1;
      if (z - 1 < dzLo) dzLo = z - 1;
      if (z + 1 > dzHi) dzHi = z + 1;
      if (lo < dyLo) dyLo = lo;
      const yTop = Math.min(H - 1, hi + 1);
      if (yTop > dyHi) dyHi = yTop;
    }
  }

  // Emit the dirty bucket rect once (see bounds comment above). Bucket index
  // is monotone in cell coords (CH power of two), so the bucket rect over the
  // clamped dirty bounds covers every chunkKey the per-column x±1 / z±1 /
  // y[lo..hi+1] rule would mark, and no chunk outside it is dirty — a small
  // superset at worst when touched columns don't fill their AABB. The y-bucket
  // START is floor((dyLo-1)/CH), not floor(dyLo/CH): the CRATER FLOOR is the
  // +Y face of the cell just BELOW the lowest removed cell (lo-1), which lands
  // in bucket lo/CH-1 when lo sits exactly on a chunk line (lo%CH==0) — one
  // below floor(lo/CH). Marking from lo alone left that floor chunk un-rebuilt
  // and the crater hollow (see test/unit/blast-crater-floor.test.js).
  if (dxHi >= dxLo) {
    if (dxLo < 0) dxLo = 0;
    if (dxHi > W - 1) dxHi = W - 1;
    if (dzLo < 0) dzLo = 0;
    if (dzHi > Z - 1) dzHi = Z - 1;
    const yByLo = Math.floor((dyLo - 1) / CH); // floor cell below the lowest removed cell
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

// S3c — symmetric counterpart to blast(): ADD terrain. Sets EMPTY -> material
// cells inside the sphere (material default 'dirt'; opts.materialId selects
// by MATERIALS id, unknown id throws noisily — doctrine). NO compaction:
// adding cannot destabilize a heights-only column — fill only flips
// EMPTY->solid, so every column's solid count and top are monotone non-
// decreasing (test-pinned in test/unit/earth-add.test.js); a hemisphere
// sitting on a contiguous column just extends it contiguously, there is no
// gap to drop cells into. Unlike blast (hardness-scaled removal), fill is
// a plain symmetric sphere: dirt deposits as dirt regardless of what it
// lands on.
//
// opts.maxYWorld (ridge flattening): cells whose CENTER is above this
// world-y are skipped — used by the liquid_dirt/dirt_charge low-wide ridge
// (impact.y + r*0.5, brief-pinned).
//
// dirtyChunks: EXACTLY the blast() rule (see file header) — for each touched
// column, x±1 / z±1 (clamped to the field) crossed with the y-buckets over
// [floor((lo-1)/CH) .. floor(min(H-1, hi+1)/CH)] of the net-changed span,
// emitted as the bucket rect over tracked integer min/max bounds. The lo-1
// start matches blast(): adding a cell at lo buries the +Y face of the cell
// just below it (lo-1), whose bucket is lo/CH-1 when lo lands on a chunk line.
// Returns {added, dirtyChunks}.
export function fillSphere(f, center, rWorld, opts = {}) {
  const materialId = opts.materialId ?? 'dirt';
  const matIndex = MATERIALS.findIndex((m) => m && m.id === materialId);
  if (matIndex < 0) throw new Error(`fillSphere: unknown material "${materialId}"`);
  const rCells = rWorld / V;
  const r2 = rCells * rCells;
  const cX = (center.x - X_MIN) / V; // continuous cell-space center
  // DEEPEN-1015 R6: world y=0 is cell FLOOR_CELLS — shift the continuous
  // cell-space center (and the world-y ridge cap) into the offset grid.
  const cY = center.y / V + FLOOR_CELLS;
  const cZ = (center.z - Z_MIN) / V;
  // Cap in cell-center space: fill cell y iff (y - FLOOR_CELLS + 0.5) * V <= maxYWorld.
  const capCells = opts.maxYWorld === undefined ? Infinity : opts.maxYWorld / V - 0.5 + FLOOR_CELLS;

  // AABB clipped to the field — corner deposits just add less, never throw.
  const xMin = Math.max(0, Math.floor(cX - rCells - 1));
  const xMax = Math.min(W - 1, Math.ceil(cX + rCells + 1));
  const yMin = Math.max(0, Math.floor(cY - rCells - 1));
  const yMax = Math.min(H - 1, Math.ceil(cY + rCells + 1));
  const zMin = Math.max(0, Math.floor(cZ - rCells - 1));
  const zMax = Math.min(Z - 1, Math.ceil(cZ + rCells + 1));

  const dirtyChunks = new Set();
  let added = 0;
  // Dirty-area bounds in CELL space, tracked as cheap integer min/max in the
  // hot loop, chunkKey strings generated once after it — same tail emission
  // as blast() above.
  let dxLo = Infinity, dxHi = -1, dyLo = Infinity, dyHi = -1, dzLo = Infinity, dzHi = -1;

  for (let x = xMin; x <= xMax; x++) {
    for (let z = zMin; z <= zMax; z++) {
      let colAdded = 0;
      let lo = Infinity, hi = -1; // y-span of added cells in this column
      for (let y = yMin; y <= yMax; y++) {
        if (y > capCells) continue; // ridge cap: keep the deposit low and wide
        if (get(f, x, y, z) !== EMPTY) continue; // add-only: solid stays solid
        const dx = x + 0.5 - cX;
        const dy = y + 0.5 - cY;
        const dz = z + 0.5 - cZ;
        if (dx * dx + dy * dy + dz * dz <= r2) {
          set(f, x, y, z, matIndex);
          added++;
          colAdded++;
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
      }
      if (colAdded === 0) continue;
      // Changed cells flip face decisions for their 6 neighbors; the y+1
      // covers the bucket-boundary face above hi (blast.js doctrine).
      if (x - 1 < dxLo) dxLo = x - 1;
      if (x + 1 > dxHi) dxHi = x + 1;
      if (z - 1 < dzLo) dzLo = z - 1;
      if (z + 1 > dzHi) dzHi = z + 1;
      if (lo < dyLo) dyLo = lo;
      const yTop = Math.min(H - 1, hi + 1);
      if (yTop > dyHi) dyHi = yTop;
    }
  }

  if (dxHi >= dxLo) {
    if (dxLo < 0) dxLo = 0;
    if (dxHi > W - 1) dxHi = W - 1;
    if (dzLo < 0) dzLo = 0;
    if (dzHi > Z - 1) dzHi = Z - 1;
    const yByLo = Math.floor((dyLo - 1) / CH); // floor cell below the lowest added cell
    for (let bx = Math.floor(dxLo / CH); bx <= Math.floor(dxHi / CH); bx++) {
      for (let by = yByLo; by <= Math.floor(dyHi / CH); by++) {
        for (let bz = Math.floor(dzLo / CH); bz <= Math.floor(dzHi / CH); bz++) {
          dirtyChunks.add(chunkKey(bx * CH, by * CH, bz * CH));
        }
      }
    }
  }

  return { added, dirtyChunks };
}
