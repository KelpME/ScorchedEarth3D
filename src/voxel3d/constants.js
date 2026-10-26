// voxel3d core constants — full-3D voxel terrain (X0 of SE-VOXEL-3D).
// Field is W x H x Z cells, y=0 at the bottom. Layout: idx = x + z*W + y*W*Z
// so y-rows are contiguous blocks of W*Z cells (gravity/compaction rows are
// memcpy-shaped, and column scans stride by W*Z).

// SE-EXPANSION-1012 A1 — map sizes are DATA, not literals. The extents below
// are exported LETS reassigned by setMapSize(mapSize): ES module live bindings
// push the new values into every importer at its next read. Consumers must
// READ the bindings at use time (never destructure into a local const at
// module top). Factors: default x1 (the historical 960x240 exactly), medium
// x2.5, large x5 — BOTH world axes scale (W and Z cell counts, X_MIN/Z_MIN,
// cage, chunk counts); voxel DEPTH H and cell size V never change.

// T-G1: 4x arena (linear) at a 40cm voxel. Default field world extents:
// x = X_MIN .. X_MIN + W*V = -120 .. 120, z = Z_MIN .. Z_MIN + Z*V = -30 .. 30.
//
// 2026-10-14 (USER DIRECTIVE — field depth x2, then x2 again, then DEEPEN-1015
// R2): the field grows to 2280f Z cells with the extension at the FRONT (+z).
// History: 240f -> 480f (Z_MIN -30f -> -90f); DEEPEN-1015 R1 extended the BACK
// (-90f -> -540f) but REVISION 2 (2026-10-15 user steer) REVERTS the -z back
// extension and moves the extension to the FRONT instead: Z cells stay 2280f,
// Z_MIN goes BACK to -90f, so the front edge FIELD_Z_MAX = Z_MIN + Z*V =
// -90 + 570 = +480f — a real-field corridor ~450 world units beyond the
// +30f historical front edge (the corridor cells are REAL field cells filled
// by the generator; the intro flyover drops their chunk groups). The trench
// wall CAGE_Z_MAX stays PINNED at 20f — the aquarium cutaway is at the
// trench, NOT at the field front edge. 2026-10-14 (USER DIRECTIVE — cage
// full-depth) initially rode the back edge, but DEEPEN-1015 PINS the cage:
// CAGE_Z_MIN is now a PINNED -80f (it no longer derives from FIELD_Z_MIN),
// so the play area inside the glass panes does NOT grow with the field.
// This deliberately CHANGES the historical-extents regression pin — new pin:
// W=1920 Z=2280 X_MIN=-240 Z_MIN=-90, FIELD_Z_MAX +480, CAGE_Z -80..+20.
//
// 2026-10-14 (USER DIRECTIVE — field width x2, BOTH X directions): the field
// doubles in X symmetrically. W 960f -> 1920f, X_MIN -120f -> -240f; the front
// edge FIELD_X_MAX stays +240f (= X_MIN + W*V, moved symmetrically outward on
// the -x side only), FIELD_Z untouched, and the CAGE X LAW IS UNCHANGED
// (CAGE_X ±80f — the user's cage law: the cage does not move). This again
// CHANGES the historical-extents regression pin — new pin:
// W=1920 Z=480 X_MIN=-240 Z_MIN=-90, FIELD_X_MAX +240, FIELD_Z_MAX +30,
// CAGE_X ±80, CAGE_Z_MIN -80.
export const MAP_SIZES = ['default', 'medium', 'large'];
export const MAP_SIZE_FACTOR = { default: 1, medium: 2.5, large: 5 }; // data table, not code branches
// 2026-10-16 DEEPEN-1015 R6 (user: 'I JUST WANT THE VOXELS TO EXTEND DOWN
// FURTHER' — the separate under-field MESH object is retired): the field
// grows DEEPER by FLOOR_CELLS (DATA: data/voxel-terrain.json
// .floorExtension.floorCells = 520 cells = 130 world units at V=0.25). The
// extra cells live BELOW the old floor plane: cell y=0 sits at world
// y = -FLOOR_CELLS*V and the playable floor plane STAYS at world y=0 (cell
// FLOOR_CELLS). Every world<->cell y conversion goes through the helpers in
// this file (cellY / centerY / cellTopWorldY) — that IS the one-place offset
// seam. surfaceHeight keeps its playable-top semantics (cells above the
// floor plane, clamped to PLAYABLE_H - 10, byte-identical), and generate()
// adds FLOOR_CELLS when filling, so playable tops and gameplay world heights
// do not move. H below is the TOTAL depth (playable + floor extension).
// (terrainData is imported below for MATERIALS; imports hoist, so the block
// above reads it fine — single declaration kept.)
const FLOOR_EXT_DATA = (() => {
  const fe = terrainData ? terrainData.floorExtension : undefined;
  if (!fe || typeof fe !== 'object'
    || !Number.isInteger(fe.floorCells) || fe.floorCells <= 0
    || typeof fe.maxFieldBytes !== 'number' || !(fe.maxFieldBytes > 0)) {
    throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .floorExtension must be { floorCells: positive integer, maxFieldBytes: positive number }: ${JSON.stringify(fe)} — fix the data file, no JS fallback exists`);
  }
  return fe;
})();
export const FLOOR_CELLS = FLOOR_EXT_DATA.floorCells;   // deep cells below the playable floor plane
export const MAX_FIELD_BYTES = FLOOR_EXT_DATA.maxFieldBytes; // cells-allocation budget (makeField enforces)
export const PLAYABLE_H = 192; // cells above the floor plane (the historical H — surfaceHeight's clamp ceiling)
export const H = PLAYABLE_H + FLOOR_CELLS;  // 712: total cells along y, y=0 at the DEEP bottom
export const V = 0.25;       // world units per cell (40cm) — never scales
export const FLOOR_WORLD_Y = -FLOOR_CELLS * V;          // world y of cell 0 (-130 at floorCells 520)
export const CH = 32;        // chunk edge in cells

// Pure extents table for a mapSize. Throws on an unknown size (fail-noisy:
// no silent default). TURN_BUDGET scale lives beside it: 24 x factor.
export function extentsFor(mapSize) {
  const f = MAP_SIZE_FACTOR[mapSize];
  if (typeof f !== 'number') throw new RangeError(`extentsFor: unknown mapSize ${JSON.stringify(mapSize)} — expected one of ${MAP_SIZES.join('|')}`);
  // 2026-10-15 DEEPEN-1015 R2 — the extension is at the FRONT: Z stays 2280*f,
  // Z_MIN goes BACK to -90*f (the R1 -z back extension is REVERTED), so
  // FIELD_Z_MAX = Z_MIN + Z*V = +480*f for every factor — a real-field
  // corridor beyond the +30f historical front edge. 2026-10-14
  // field width x2 (user directive, BOTH X directions): W = 1920*f,
  // X_MIN = -240*f — FIELD_X_MAX stays +240f (pinned by the symmetric
  // doubling). CAGE LAW (DEEPEN-1015: the cage does not ride any field edge
  // — the play area inside the glass panes does not grow): the cage is
  // PINNED — CAGE_Z_MIN = -80*f (no longer derived from FIELD_Z_MIN),
  // CAGE_Z_MAX = +20f (the aquarium trench wall, NOT the field front edge).
  // X cage unchanged (±80f — user cage law: the cage does not move).
  const W = 1920 * f, Z = 2280 * f, X_MIN = -240 * f, Z_MIN = -90 * f;
  return {
    mapSize, W, Z, H, V,
    X_MIN, Z_MIN,
    FIELD_X_MIN: X_MIN, FIELD_X_MAX: X_MIN + W * V,
    FIELD_Z_MIN: Z_MIN, FIELD_Z_MAX: Z_MIN + Z * V,
    CAGE_X_MIN: -80 * f, CAGE_X_MAX: 80 * f,
    CAGE_Z_MIN: -80 * f, CAGE_Z_MAX: 20 * f, // PINNED (DEEPEN-1015) — does not ride FIELD_Z_MIN
    CHUNKS_X: Math.ceil(W / CH), CHUNKS_Y: Math.ceil(H / CH), CHUNKS_Z: Math.ceil(Z / CH),
  };
}

// Live module state — the exported lets every consumer reads. Default extents
// (regression pin CHANGED 2026-10-15 by DEEPEN-1015 R2 — the extension is at
// the FRONT: Z stays 2280, Z_MIN back to -90 (R1 back extension REVERTED),
// FIELD_Z_MAX +480; cage PINNED; was W=1920 Z=2280 X_MIN=-240 Z_MIN=-540 with
// FIELD_Z_MAX +30, before that W=960 Z=240 X_MIN=-120 Z_MIN=-30):
// W=1920 Z=2280 X_MIN=-240 Z_MIN=-90, FIELD_X_MAX +240, FIELD_Z_MAX +480
// (front corridor beyond the +30 historical edge), cage PINNED Z -80..+20,
// X ±80 (cage law — does not ride any field edge).
export let W = 1920;
export let Z = 2280;
export let X_MIN = -240;
export let Z_MIN = -90;
export let FIELD_X_MIN = X_MIN;
export let FIELD_X_MAX = X_MIN + W * V;
export let FIELD_Z_MIN = Z_MIN;
export let FIELD_Z_MAX = Z_MIN + Z * V;
export let CAGE_X_MIN = -80;
export let CAGE_X_MAX = 80;
export let CAGE_Z_MIN = -80;
export let CAGE_Z_MAX = 20;
export let CHUNKS_X = 60;
export let CHUNKS_Y = Math.ceil(H / CH); // derived: H is data-driven (DEEPEN-1015 R6 floor extension), never a literal
export let CHUNKS_Z = 72;

let _mapSize = 'default';
export const mapSize = () => _mapSize;

/** Reassign every extent binding to the given size's table. Throws on junk. */
export function setMapSize(size) {
  const e = extentsFor(size); // validates first: a throw leaves state untouched
  _mapSize = e.mapSize;
  W = e.W; Z = e.Z; X_MIN = e.X_MIN; Z_MIN = e.Z_MIN;
  FIELD_X_MIN = e.FIELD_X_MIN; FIELD_X_MAX = e.FIELD_X_MAX;
  FIELD_Z_MIN = e.FIELD_Z_MIN; FIELD_Z_MAX = e.FIELD_Z_MAX;
  CAGE_X_MIN = e.CAGE_X_MIN; CAGE_X_MAX = e.CAGE_X_MAX;
  CAGE_Z_MIN = e.CAGE_Z_MIN; CAGE_Z_MAX = e.CAGE_Z_MAX;
  CHUNKS_X = e.CHUNKS_X; CHUNKS_Y = e.CHUNKS_Y; CHUNKS_Z = e.CHUNKS_Z;
}

// Turn budget scales with the map so movement range stays proportional
// (plan SE-EXPANSION-1012: 24 x factor -> 24/60/120). W5 purge (plan
// SE-COMPLETE-1012 §4): the old `24` JS literal is GONE — the base budget is
// DATA (data/drive.json .turnBudget, the same block systems/drive.js and the
// drive model consume). Malformed data fails LOUD naming the file.
import driveData from '../../data/drive.json' with { type: 'json' };
const BASE_TURN_BUDGET_DATA = (() => {
  const v = driveData ? driveData.turnBudget : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new TypeError(`[se/voxel3d] data/drive.json .turnBudget missing/non-numeric: ${JSON.stringify(v)} — fix the data file, no JS fallback exists`);
  }
  return v;
})();
export const BASE_TURN_BUDGET = BASE_TURN_BUDGET_DATA;
export const turnBudgetFor = (size) => BASE_TURN_BUDGET * MAP_SIZE_FACTOR[size];

// Cell values: EMPTY (0) or a MATERIAL INDEX 1..M
export const EMPTY = 0;

// MATERIALS[0] is null (EMPTY). Cell value = index into this array.
// 2026-10-13 (user: stop hiding tunables in code): the table is DATA
// (data/voxel-terrain.json .materials — id + hex color + hardness), same
// fail-loud import pattern as drive.json. Colors/hardness are editable in the
// data file; the historical hexes are the regression pin.
import terrainData from '../../data/voxel-terrain.json' with { type: 'json' };
const MATERIALS_DATA = (() => {
  const m = terrainData ? terrainData.materials : undefined;
  if (!Array.isArray(m) || m.length !== 5) {
    throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .materials must be a 5-entry array (grass/dirt/dark/rock/rockDark): ${JSON.stringify(m && m.length)} — fix the data file, no JS fallback exists`);
  }
  return m.map((mt, i) => {
    if (!mt || typeof mt.id !== 'string' || typeof mt.hardness !== 'number' || !(mt.hardness >= 0 && mt.hardness <= 1) || typeof mt.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(mt.color)) {
      throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .materials[${i}] malformed (need id:string, hardness:0..1, color:'#rrggbb'): ${JSON.stringify(mt)}`);
    }
    return { id: mt.id, color: parseInt(mt.color.slice(1), 16), hardness: mt.hardness };
  });
})();
export const MATERIALS = [
  null,
  ...MATERIALS_DATA,
];

// y-rows contiguous: gravity is memcpy-shaped. All of these read the LIVE
// W/Z/X_MIN/Z_MIN bindings at call time — they are size-agnostic by design.
export const idx = (x, y, z) => x + z * W + y * W * Z;
export const inField = (x, y, z) => x >= 0 && x < W && y >= 0 && y < H && z >= 0 && z < Z;

// world -> cell. DEEPEN-1015 R6: +FLOOR_CELLS — the playable floor plane is
// world y=0 (cell FLOOR_CELLS); world coords below it map into the deep cells
// (down to world FLOOR_WORLD_Y = -FLOOR_CELLS*V).
export const cellX = (wx) => Math.floor((wx - X_MIN) / V);
export const cellY = (wy) => Math.floor(wy / V) + FLOOR_CELLS;
export const cellZ = (wz) => Math.floor((wz - Z_MIN) / V);

// cell -> world center of cell (cellY's exact inverse)
export const centerX = (cx) => X_MIN + (cx + 0.5) * V;
export const centerY = (cy) => (cy - FLOOR_CELLS + 0.5) * V;
export const centerZ = (cz) => Z_MIN + (cz + 0.5) * V;

// DEEPEN-1015 R6: cell TOP index (one past the highest solid cell, as
// columnTop/column scans report) -> world y of the surface plane. The ONE
// seam every (columnTop + 1) * V consumer must go through now that the deep
// floor cells sit below world y=0.
export const cellTopWorldY = (topCell) => (topCell + 1 - FLOOR_CELLS) * V;

// Chunk bucketing: CH=32 -> >>5. Chunk counts live in the CHUNKS_* lets above
// (recomputed per size; partial chunks at the +x/+y/+z edges are legal).
export const chunkKey = (x, y, z) => `${x >> 5},${y >> 5},${z >> 5}`;
