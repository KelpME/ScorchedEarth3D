// SETTLE — pure per-frame terrain settling for the voxel3d heights-only field.
// No DOM, no engine imports: runs under `node --test`.
//
// Model (voxel3d is heights-only; columnTop + columnCompact3D define the
// invariant):
//  (a) a column with an EMPTY cell below a SOLID run is unstable — collapse =
//      re-stack the column (columnCompact3D preserves bottom-up order);
//  (b) AVALANCHE SMOOTHING: if a neighbor column's TOP exceeds this column's
//      top by more than `angle` cells (default 3 — documented choice: the
//      authored seed terrain's steepest natural cliff is 7 cells and a blast
//      rim wall is ~22 cells, so 3 reads as a shallow rest angle and craters
//      visibly slump), move ONE cell of top material from the high neighbor
//      onto this column (moved += 1). One cell per over-angle pair per call =>
//      a gradual multi-frame slump like real Scorched Earth.
//
// Determinism: fixed scan order, x outer then z inner (the queued list is
// sorted the same way). No Math.random, no wall-clock reads — same field +
// same call sequence => identical cells and identical changedColumns.
//
// Bounded work: at most `maxColumns` mutation moves per call (default 8192),
// so a caller proves a frame budget by capping iterations/time and looping.
//
// SCAN SCOPING (documented SETTLE decision): avalanche is scoped to a DIRTY
// QUEUE (columns announced via bumpColumns + the wake closure of anything that
// actually moved). A full-field avalanche every frame would relax the AUTHORED
// terrain itself — measured on live seed 1936: 398 over-angle neighbor pairs
// at rest, ~6100 moves, the pinned turn3d impact column top drifts 137->129
// and the scripted shot then flies OOB. The generator's surface is authored
// stable; only blast disturbance settles. Un-announced unsupported ledges are
// still caught by the system's rolling instability sweep (rule (a) only —
// avalanche is deliberately disturbance-scoped). opts.scanAll runs both rules
// over the whole grid (exhaustive / test mode).
import { W, H, Z, EMPTY, chunkKey } from '../voxel3d/constants.js';
import { columnCompact3D, columnTop } from '../voxel3d/field.js';

export const SETTLE_ANGLE = 3;
export const SETTLE_MAX_COLUMNS = 8192;
const ROW = () => W * Z; // SE-EXPANSION-1012 A1: live bindings, never captured

export const colKey = (x, z) => x + ',' + z;

// Per-field mutable sim state (dirty queue + rolling-sweep cursor). WeakMap so
// pure test fields GC with their state; callers never hold the live set.
const states = new WeakMap();
function stateOf(field) {
  let s = states.get(field);
  if (!s) { s = { queue: new Set(), sweepCursor: 0 }; states.set(field, s); }
  return s;
}

function enqueue(s, x, z) {
  s.queue.add(colKey(x, z));
  if (x > 0) s.queue.add(colKey(x - 1, z));
  if (x < W - 1) s.queue.add(colKey(x + 1, z));
  if (z > 0) s.queue.add(colKey(x, z - 1));
  if (z < Z - 1) s.queue.add(colKey(x, z + 1));
}

/**
 * Announce disturbed columns (e.g. a blast footprint). Each column AND its
 * four neighbors are queued: a changed column alters the angle condition of
 * every adjacent pair, so the neighborhood is exactly the closure the next
 * scan needs. Out-of-field entries are dropped. Returns a COPY of the pending
 * set after the bumps.
 */
export function bumpColumns(field, columns) {
  const s = stateOf(field);
  for (const [x, z] of columns) {
    if (x < 0 || x >= W || z < 0 || z >= Z) continue;
    enqueue(s, x, z);
  }
  return new Set(s.queue);
}

/** Number of columns pending a queued (both-rules) check. */
export function pendingColumns(field) {
  return states.get(field)?.queue.size ?? 0;
}

function markRange(map, x, z, lo, hi) {
  const k = colKey(x, z);
  const prev = map.get(k);
  if (prev) map.set(k, [Math.min(prev[0], lo), Math.max(prev[1], hi)]);
  else map.set(k, [lo, hi]);
}

// Dirty-chunk marks for one changed column, blast.js doctrine (a small
// superset, never a miss): x-1..x+1 / z-1..z+1 (clamped) crossed with the
// y-buckets covering [floor((lo-1)/CH) .. floor(min(H-1, hi+1)/CH)] of the
// net-changed cell range. The lo-1 start matches blast(): the crater FLOOR is
// the +Y face of the cell just below the lowest changed cell (lo-1), which
// lands in bucket lo/CH-1 when lo sits exactly on a chunk line — marking from
// lo alone left that floor chunk un-rebuilt and the settled crater hollow
// (see test/unit/blast-crater-floor.test.js).
function markChunks(keys, x, z, lo, hi) {
  if (hi < lo) return;
  const yTop = Math.min(H - 1, hi + 1);
  for (let cx = Math.max(0, x - 1); cx <= Math.min(W - 1, x + 1); cx++) {
    for (let cz = Math.max(0, z - 1); cz <= Math.min(Z - 1, z + 1); cz++) {
      for (let by = (lo - 1) >> 5; by <= yTop >> 5; by++) keys.add(chunkKey(cx, by << 5, cz));
    }
  }
}

// Per-call column-top cache: columnTop() is a 240-cell scan; a settle pass
// reads the same columns repeatedly. Entries are invalidated exactly when a
// column's cells change (compacted / donated / received), so within one call
// the cached value is exact, and across calls every column is recomputed on
// demand. Determinism: the cache never changes results, only work.
function makeTopCache(field) {
  const tops = new Int16Array(W * Z);
  const valid = new Uint8Array(W * Z);
  return {
    of(x, z) {
      const i = x + z * W;
      if (!valid[i]) { tops[i] = columnTop(field, x, z); valid[i] = 1; }
      return tops[i];
    },
    invalidate(x, z) { valid[x + z * W] = 0; },
  };
}

// True when some cell at y <= top has EMPTY below a solid cell above it.
function hasVoid(field, x, z, top) {
  const base = x + z * W;
  let above = 0; // solids seen above the current y (scan downward)
  for (let y = top; y >= 0; y--) {
    if (field.cells[base + y * ROW()] === EMPTY) { if (above > 0) return true; }
    else above++;
  }
  return false;
}

function settleBody(field, x, z, angle, yLoHi, changedColumns, s, tops, movedCells) {
  let moved = 0;
  // (a) unstable column: EMPTY cell under a solid run -> re-stack.
  const top = tops.of(x, z);
  if (top > 0 && hasVoid(field, x, z, top)) {
    const ys = new Set();
    if (columnCompact3D(field, x, z, ys) > 0) {
      tops.invalidate(x, z);
      let lo = Infinity, hi = -1;
      for (const y of ys) { if (y < lo) lo = y; if (y > hi) hi = y; }
      markRange(yLoHi, x, z, lo, hi);
      if (movedCells && movedCells.length < MOVED_CELLS_CAP) movedCells.push({ x, z, fromY: hi, toY: lo });
      changedColumns.add(colKey(x, z));
      if (s) enqueue(s, x, z); // top moved: neighbor angle math changed
      moved++;
    }
  }
  // (b) avalanche: every neighbor whose top exceeds this column's top by
  // more than `angle` pours ONE top cell down onto this column.
  let t = tops.of(x, z);
  if (t < 0 || t >= H - 1) return moved; // nothing to receive into / no headroom
  for (let k = 0; k < 4; k++) {
    const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
    const nz = z + (k === 2 ? -1 : k === 3 ? 1 : 0);
    if (nx < 0 || nx >= W || nz < 0 || nz >= Z) continue;
    const nt = tops.of(nx, nz);
    if (nt - t > angle) {
      const v = field.cells[nx + nz * W + nt * ROW()];
      field.cells[nx + nz * W + nt * ROW()] = EMPTY;
      field.cells[x + z * W + (t + 1) * ROW()] = v;
      tops.invalidate(nx, nz);
      tops.invalidate(x, z);
      changedColumns.add(colKey(nx, nz));
      changedColumns.add(colKey(x, z));
      markRange(yLoHi, nx, nz, nt, nt);
      markRange(yLoHi, x, z, t + 1, t + 1);
      if (movedCells && movedCells.length < MOVED_CELLS_CAP) movedCells.push({ x: nx, z: nz, fromY: nt, toY: t + 1 });
      if (s) { enqueue(s, nx, nz); enqueue(s, x, z); } // relaxation may continue
      t++;
      moved++;
    }
  }
  return moved;
}

function finish(changedColumns, moved, yLoHi, dirtyChunks, movedCells) {
  for (const [k, [lo, hi]] of yLoHi) {
    const i = k.indexOf(',');
    markChunks(dirtyChunks, Number(k.slice(0, i)), Number(k.slice(i + 1)), lo, hi);
  }
  return { changedColumns, moved, dirtyChunks, movedCells };
}

// SETTLE-PACE-1015: additive per-call report of the individual cell moves
// ({x, z, fromY, toY}) the presentation layer drops falling-dirt visuals
// from. Bounded so a caller can never balloon memory; the system-level
// pacing budget (movesPerStep) keeps it small in practice anyway.
const MOVED_CELLS_CAP = 512;

/**
 * One bounded settle pass.
 * @param {object} field voxel3d field ({cells: Uint8Array})
 * @param {{maxColumns?: number, angle?: number, scanAll?: boolean}} [opts]
 * @returns {{changedColumns: Set<string>, moved: number, dirtyChunks: Set<string>}}
 *   changedColumns holds 'x,z' for EVERY column whose cells changed
 *   (re-stacked, donated, received); dirtyChunks holds chunk keys to remesh.
 *   moved counts re-stacked columns + individual avalanche cell moves.
 *   moved === 0 with pendingColumns(field) === 0 => the (dirty) terrain is
 *   stable. Queued scan is deterministic: sorted x then z, budget tail stays
 *   pending. scanAll walks the whole grid in fixed x-then-z order and does not
 *   touch the queue.
 */
export function stepSettle(field, opts = {}) {
  const angle = opts.angle ?? SETTLE_ANGLE;
  const maxColumns = opts.maxColumns ?? SETTLE_MAX_COLUMNS;
  const changedColumns = new Set();
  const yLoHi = new Map();
  const dirtyChunks = new Set();
  const tops = makeTopCache(field);
  let moved = 0;
  const movedCells = [];

  let s = null, list = null;
  if (opts.scanAll) {
    // exhaustive fixed-order full grid; queue untouched
  } else {
    s = states.get(field);
    if (!s || s.queue.size === 0) return finish(changedColumns, 0, yLoHi, dirtyChunks, []);
    list = [...s.queue]
      .map((k) => { const i = k.indexOf(','); return [Number(k.slice(0, i)), Number(k.slice(i + 1))]; })
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]); // deterministic x then z
    s.queue.clear();
  }
  const n = opts.scanAll ? W * Z : list.length;

  for (let li = 0; li < n; li++) {
    if (moved >= maxColumns) { // budget: the unscanned tail stays pending
      if (s) for (let r = li; r < n; r++) s.queue.add(colKey(list[r][0], list[r][1]));
      break;
    }
    const x = opts.scanAll ? (li / Z) | 0 : list[li][0];
    const z = opts.scanAll ? li % Z : list[li][1];
    moved += settleBody(field, x, z, angle, yLoHi, changedColumns, s, tops, movedCells);
  }
  return finish(changedColumns, moved, yLoHi, dirtyChunks, movedCells);
}

/**
 * Rolling instability-only sweep: scans the next `budget` columns (x outer,
 * z inner, persistent cursor — the whole grid is covered every
 * W*Z/budget calls) and re-stacks any column with an EMPTY cell below a solid
 * run. Avalanche is NOT applied here: the sweep is the autonomous safety net
 * for unsupported ledges nothing announced; angle relaxation stays
 * disturbance-scoped (see SCAN SCOPING above). Compacted columns are enqueued
 * so their neighbors get avalanche-checked by the next stepSettle.
 * @returns {{changedColumns: Set<string>, moved: number, dirtyChunks: Set<string>}}
 */
export function sweepInstability(field, budget = 2048) {
  const s = stateOf(field);
  const changedColumns = new Set();
  const yLoHi = new Map();
  const dirtyChunks = new Set();
  const tops = makeTopCache(field);
  let moved = 0;
  const total = W * Z;
  for (let li = 0; li < budget; li++) {
    const i = (s.sweepCursor + li) % total;
    const x = (i / Z) | 0;
    const z = i % Z;
    const top = tops.of(x, z);
    if (top > 0 && hasVoid(field, x, z, top)) {
      const ys = new Set();
      if (columnCompact3D(field, x, z, ys) > 0) {
        let lo = Infinity, hi = -1;
        for (const y of ys) { if (y < lo) lo = y; if (y > hi) hi = y; }
        markRange(yLoHi, x, z, lo, hi);
        changedColumns.add(colKey(x, z));
        enqueue(s, x, z);
        moved++;
      }
    }
  }
  s.sweepCursor = (s.sweepCursor + budget) % total;
  return finish(changedColumns, moved, yLoHi, dirtyChunks, []);
}

// ---------------------------------------------------------------------------
// W2-A (plan SE-COMPLETE-1012) — SUSPEND DIRT (manual:L1844-L1851):
//   "This number allows dirt to remain suspended in the air some of the time.
//    It is a percentage chance, per shot, that ALL the dirt on screen will
//    fall."
// OG-faithful model implemented here (the manual's semantics, which SUPERSEDE
// the brief's "% of displaced dirt returned as floating dirt" phrasing):
//   - suspendDisplaced lifts each blast-disturbed column's UNSUPPORTED RUN
//     (solid cells above the first void — the dirt that would immediately
//     fall) off the field into a per-field suspension pool;
//   - stepSuspendDirt is the PER-SHOT roll: one seeded draw rng(); draw <
//     suspendDirt/100 releases the ENTIRE pool (all dirt falls together),
//     otherwise it all stays suspended another shot. percent 0 (the default)
//     releases immediately WITHOUT consuming a draw — dirt never persists,
//     i.e. the pre-W2A behavior. Earth Disrupters semantics (manual
//     L1149-L1153: "force all dirt to settle") = a forced release at
//     percent 0 semantics — callers pass 0 to disrupt.
//   - _placeholder/_observed: OG tracks individual floating dirt CELLS on a
//     2D screen; our heights-only voxel3d field holds the FALLING back by
//     lifting whole unsupported runs per disturbed column. Observed pin:
//     release re-adds cells on the column top and re-announces the column so
//     the ordinary settle rules relax them.
// Determinism: fixed scan order (x outer, z inner), injected rng, no
// Math.random / wall-clock. Same field + same seed sequence => identical.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// W3-A (plan SE-COMPLETE-1012) — fallingDelay TIMING SEAM (manual:L1746-L1748:
// "how fast the tanks fall on screen"). Pure per-settling gate: the caller
// (systems/settle3d) creates one gate at the settling edge and calls step()
// once per frame while the phase is 'settling'; step() is false for the first
// `delay` calls (the shell/dirt fall pause — the slump drain and instability
// sweep are HELD) and true afterwards. Counts sim STEPS, never wall-clock:
// deterministic, node-testable. Delay 0 = open on the first step (the
// pre-W3A behavior, byte-identical). This adds NO settle math — it only
// paces WHEN the existing rules run.
// ---------------------------------------------------------------------------
export function makeStepGate(delay = 0) {
  const d = Math.max(0, Math.floor(Number(delay) || 0));
  let n = 0;
  return {
    step() { n += 1; return n > d },
    get elapsed() { return n },
  };
}

function suspendedState(field) {
  const s = stateOf(field);
  if (!s.suspended) s.suspended = [];
  return s;
}

/** Total cells currently held in the suspension pool. */
export function suspendedCount(field) {
  const s = states.get(field);
  if (!s || !s.suspended) return 0;
  let n = 0;
  for (const e of s.suspended) n += e.cells.length;
  return n;
}

/**
 * Lift the unsupported run of each given column into the suspension pool.
 * columns: iterable of [x, z]. Columns with no void (fully supported) or
 * out-of-field coordinates are skipped. Returns { columns, cells } — the
 * number of columns that actually contributed and cells lifted.
 */
export function suspendDisplaced(field, columns) {
  const s = suspendedState(field);
  let cols = 0, cells = 0;
  for (const [x, z] of columns) {
    if (x < 0 || x >= W || z < 0 || z >= Z) continue;
    const top = columnTop(field, x, z);
    if (top < 0) continue;
    // First void BELOW a solid, scanning downward from the top (same
    // predicate as hasVoid): everything above that void is unsupported.
    let voidY = -1, above = 0;
    for (let y = top; y >= 0; y--) {
      const v = field.cells[x + z * W + y * ROW()];
      if (v === EMPTY) { if (above > 0) { voidY = y; break; } }
      else above++;
    }
    if (voidY < 0) continue; // fully supported: nothing to suspend
    const lifted = [];
    for (let y = voidY + 1; y <= top; y++) {
      const i = x + z * W + y * ROW();
      if (field.cells[i] !== EMPTY) { lifted.push(field.cells[i]); field.cells[i] = EMPTY; }
    }
    if (lifted.length) {
      s.suspended.push({ x, z, cells: lifted });
      cols++; cells += lifted.length;
    }
  }
  return { columns: cols, cells };
}

/** Re-add every pooled cell on its column top and re-announce the columns. */
function releaseAll(field, s) {
  const cols = [];
  for (const e of s.suspended) {
    let y = columnTop(field, e.x, e.z) + 1;
    for (const v of e.cells) {
      if (y < H) field.cells[e.x + e.z * W + y * ROW()] = v;
      y++;
    }
    cols.push([e.x, e.z]);
  }
  const released = s.suspended.reduce((n, e) => n + e.cells.length, 0);
  s.suspended = [];
  if (cols.length) bumpColumns(field, cols);
  return released;
}

/**
 * The per-shot Suspend Dirt roll (manual:L1844-L1851). percent: the raw
 * 0..100 setting. rng: injected deterministic draw (LCG per settingsApply
 * doctrine). Returns { fell, released }.
 */
export function stepSuspendDirt(field, rng, percent) {
  const s = suspendedState(field);
  if (!s.suspended.length) return { fell: false, released: 0 };
  const p = typeof percent === 'number' && Number.isFinite(percent) ? percent : 0;
  if (p <= 0) return { fell: true, released: releaseAll(field, s) }; // default / disrupt: no draw
  if (rng() < p / 100) return { fell: true, released: releaseAll(field, s) };
  return { fell: false, released: 0 };
}
