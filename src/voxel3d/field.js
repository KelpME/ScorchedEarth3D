// 3D field storage + column (x,z) helpers for the voxel3d terrain.
// Doctrine: after every mutation a column must be heights-only (solid cells
// occupy [0, top] contiguously). A FULLY CARVED column (top = -1) is LEGAL —
// the ground collider is a separate game object; never throw here.

import { W, H, Z, V, X_MIN, Z_MIN, EMPTY, idx, inField, FLOOR_CELLS, MAX_FIELD_BYTES } from './constants.js';

export function makeField() {
  // SE-EXPANSION-1012 A1: the field object carries its LIVE dims — specs and
  // consumers read __se.field.W/H/Z instead of re-hardcoding 960/240 (doctrine:
  // map size is data; readers re-derive from the live extents).
  // DEEPEN-1015 R6: Y_MIN — world y of cell 0 (-FLOOR_CELLS*V); the mesher
  // places chunk geometry from it, so the deep floor cells render BELOW the
  // playable floor plane (world y=0). Fail-noisy budget: W*H*Z beyond
  // MAX_FIELD_BYTES throws a NAMED RangeError (map sizes that exceed the
  // cells-allocation budget) instead of a cryptic ArrayBuffer RangeError.
  const bytes = W * H * Z; // Uint8Array: one byte per cell
  if (bytes > MAX_FIELD_BYTES) {
    throw new RangeError(`[se/voxel3d] makeField: cells array would be ${bytes} bytes (W=${W} x H=${H} x Z=${Z}) — exceeds the data budget MAX_FIELD_BYTES=${MAX_FIELD_BYTES} (data/voxel-terrain.json .floorExtension) for mapSize with these extents. DEEPEN-1015 R6 depth extension exceeds the array budget for this map size — reduce the map size or raise the budget.`);
  }
  return { W, H, Z, X_MIN, Z_MIN, Y_MIN: -FLOOR_CELLS * V, cells: new Uint8Array(bytes) };
}

// Hot path: NO bounds check. Caller guarantees in-field coords.
export function get(f, x, y, z) {
  return f.cells[idx(x, y, z)];
}

export function set(f, x, y, z, v) {
  if (!inField(x, y, z)) {
    throw new RangeError(`set out of field: x=${x} y=${y} z=${z}`);
  }
  f.cells[idx(x, y, z)] = v;
}

// Bounds-checked read mirroring set's throw.
export function getChecked(f, x, y, z) {
  if (!inField(x, y, z)) {
    throw new RangeError(`get out of field: x=${x} y=${y} z=${z}`);
  }
  return f.cells[idx(x, y, z)];
}

// In-field and non-EMPTY. OUT-OF-FIELD IS FALSE — the mesher decides its own
// edge policy (skirt faces vs. assume-solid) rather than a global default.
export function solidAt(f, x, y, z) {
  return inField(x, y, z) && f.cells[idx(x, y, z)] !== EMPTY;
}

// Highest solid y in column (x,z), or -1 if the column is fully empty.
// A fully carved column (blasted to y=0) is LEGAL; never throws.
export function columnTop(f, x, z) {
  const row = W * Z;
  for (let y = H - 1; y >= 0; y--) {
    if (f.cells[x + z * W + y * row] !== EMPTY) return y;
  }
  return -1;
}

// Count of non-EMPTY cells in column (x,z).
export function columnSolidCount(f, x, z) {
  const row = W * Z;
  let n = 0;
  for (let y = 0; y < H; y++) {
    if (f.cells[x + z * W + y * row] !== EMPTY) n++;
  }
  return n;
}

// Drop every solid cell in column (x,z) straight down until the column is a
// solid stack again, preserving BOTTOM-UP order (lowest solid stays lowest).
// Materials travel with their cells; everything above is written EMPTY.
// Returns number of cells that moved. If `changed` (a Set) is given, every y
// whose VALUE changed is added to it (includes cells moved INTO and vacated)
// — this is the diff feed blast.js uses for dirty-chunk bookkeeping.
// No-op (returns 0) on an already-solid column.
export function columnCompact3D(f, x, z, changed) {
  const row = W * Z;
  const base = x + z * W;
  // Find the current top first, then only touch [0..top] (a fresh surface
  // scrape is a no-op below the hole).
  let top = -1;
  for (let y = H - 1; y >= 0; y--) {
    if (f.cells[base + y * row] !== EMPTY) { top = y; break; }
  }
  if (top < 0) return 0;
  const write = new Uint8Array(top + 1);
  let n = 0, moved = 0, firstGap = -1;
  for (let y = 0; y <= top; y++) {
    const v = f.cells[base + y * row];
    if (v !== EMPTY) {
      if (firstGap < 0 && y !== n) firstGap = n;
      write[n++] = v;
      if (y !== n - 1) moved++;
    }
  }
  if (n === top + 1) return 0; // already heights-only
  for (let y = firstGap; y <= top; y++) {
    const nv = y < n ? write[y] : EMPTY;
    const p = base + y * row;
    if (changed && f.cells[p] !== nv) changed.add(y);
    f.cells[p] = nv;
  }
  return moved;
}
