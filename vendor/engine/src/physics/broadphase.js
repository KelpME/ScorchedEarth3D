// Uniform-grid broadphase — pure, deterministic.
//
// Bodies are bucketed into axis-aligned cells of a fixed size. A body is
// inserted into EVERY cell its AABB spans, so a query only walks the query
// AABB's own cell range. Touching (inclusive) counts as overlap. Output is
// always a sorted, deduped array — the caller is responsible for excluding
// the querying body itself.
//
// Rebuild-on-change (broadphase pathology fix):
//  - `clear()` only resets bookkeeping and marks the grid BULK-PENDING; the
//    subsequent `insert()` burst records bodies WITHOUT cell work. The single
//    grid build happens lazily on the first `query()` (or explicit
//    `rebuild()`) — ONE median pass over ALL extents, then one insertion per
//    body. A mid-insert-loop rebuild cascade is structurally impossible.
//  - SPAN-CAPPED insertion: a body spanning more than SPAN_CAP cells on any
//    axis (ground meshes, terrain tiles) does NOT flood the grid. It goes to
//    a separate large-body list answered by exact AABB overlap in query() —
//    identical results (a cell walk returns exactly the AABB-overlap set),
//    bounded cost regardless of extent.
//  - Interactive (post-sync) inserts keep the median-shift rebuild rule: a
//    body >2× or <0.5× the current basis triggers one rebuild.

const EXTENT_EPS = 1e-9; // guards floor() against float drift on exact cell boundaries
// Max cells a body may span per axis before it is promoted to the large-body
// tier (exact-AABB queries). cellSize is 4× the median extent, so ordinary
// bodies span 1–2 cells; 8 is generous headroom.
const SPAN_CAP = 8;

function extentOf(aabb) {
  return Math.max(
    aabb.maxX - aabb.minX,
    aabb.maxY - aabb.minY,
    aabb.maxZ - aabb.minZ
  );
}

export function createBroadphase() {
  let cellSize = 0; // 0 = not yet initialized (set on first build)
  /** @type {Map<string, Set<string>>} cellKey -> body ids */
  let cells = new Map();
  /** @type {Map<string, object>} id -> aabb */
  let bodies = new Map();
  /** @type {Map<string, object>} large-tier ids -> aabb (span-capped bodies) */
  let largeBodies = new Map();
  // Bulk-pending: after clear(), inserts only record; the first query builds.
  let bulkPending = false;
  // Cumulative single-pass rebuild count (observability for the
  // rebuild-on-change contract: an unchanged collider set must not rebuild).
  let rebuildCount = 0;

  const cellKey = (cx, cy, cz) => `${cx}|${cy}|${cz}`;

  function clear() {
    cellSize = 0;
    cells = new Map();
    bodies = new Map();
    largeBodies = new Map();
    bulkPending = true;
  }

  // Single-pass rebuild: decide cellSize ONCE from the median full extent of
  // ALL current bodies, then insert every body exactly once (span-capped).
  function rebuild() {
    const extents = [...bodies.values()].map(extentOf).sort((a, b) => a - b);
    const mid = Math.floor((extents.length - 1) / 2);
    const median =
      extents.length % 2 === 1
        ? extents[mid]
        : (extents[mid] + extents[mid + 1]) / 2;
    cellSize = Math.max(4 * median, Number.MIN_VALUE);
    cells = new Map();
    largeBodies = new Map();
    for (const [id, aabb] of bodies) insertIntoCells(id, aabb);
    bulkPending = false;
    rebuildCount++;
  }

  function spansTooWide(aabb) {
    const lo = [
      Math.floor(aabb.minX / cellSize + EXTENT_EPS),
      Math.floor(aabb.minY / cellSize + EXTENT_EPS),
      Math.floor(aabb.minZ / cellSize + EXTENT_EPS),
    ];
    const hi = [
      Math.floor(aabb.maxX / cellSize + EXTENT_EPS),
      Math.floor(aabb.maxY / cellSize + EXTENT_EPS),
      Math.floor(aabb.maxZ / cellSize + EXTENT_EPS),
    ];
    return (hi[0] - lo[0] >= SPAN_CAP) ||
      (hi[1] - lo[1] >= SPAN_CAP) ||
      (hi[2] - lo[2] >= SPAN_CAP);
  }

  function insertIntoCells(id, aabb) {
    // Span cap: oversized bodies join the large tier (exact overlap in
    // query) instead of flooding thousands of cells.
    if (spansTooWide(aabb)) {
      largeBodies.set(id, aabb);
      return;
    }
    const lo = [
      Math.floor(aabb.minX / cellSize + EXTENT_EPS),
      Math.floor(aabb.minY / cellSize + EXTENT_EPS),
      Math.floor(aabb.minZ / cellSize + EXTENT_EPS),
    ];
    const hi = [
      Math.floor(aabb.maxX / cellSize + EXTENT_EPS),
      Math.floor(aabb.maxY / cellSize + EXTENT_EPS),
      Math.floor(aabb.maxZ / cellSize + EXTENT_EPS),
    ];
    for (let cx = lo[0]; cx <= hi[0]; cx++) {
      for (let cy = lo[1]; cy <= hi[1]; cy++) {
        for (let cz = lo[2]; cz <= hi[2]; cz++) {
          const key = cellKey(cx, cy, cz);
          let set = cells.get(key);
          if (!set) {
            set = new Set();
            cells.set(key, set);
          }
          set.add(id);
        }
      }
    }
  }

  function insert(id, aabb) {
    if (bulkPending) {
      // Bulk sync (post-clear): record only. The single grid build happens
      // on the first query/rebuild — no mid-insert-loop rebuild cascade.
      bodies.set(id, aabb);
      return;
    }
    if (bodies.size === 0 && largeBodies.size === 0) {
      // First interactive insert: initialize the grid from this extent.
      bodies.set(id, aabb);
      cellSize = Math.max(4 * extentOf(aabb), Number.MIN_VALUE);
      insertIntoCells(id, aabb);
      return;
    }
    // Median-shift detection against the current basis (cellSize = 4 × median):
    // a body more than 2× larger or smaller than the basis triggers ONE
    // full rebuild (single pass — the cascade can't happen because the
    // rebuild loop goes through bulk-style recording, not re-entrant insert()).
    const basis = cellSize / 4;
    const wasReinsert = bodies.has(id) || largeBodies.has(id);
    if (wasReinsert) {
      // Re-insert = replace: drop the old AABB's occupancy first.
      const old = bodies.get(id) || largeBodies.get(id);
      bodies.delete(id);
      largeBodies.delete(id);
      removeFromCells(id, old);
    }
    bodies.set(id, aabb);
    const outOfBand = extentOf(aabb) > 2 * basis || extentOf(aabb) < 0.5 * basis;
    if (outOfBand) rebuild();
    else insertIntoCells(id, aabb);
  }

  function remove(id) {
    const aabb = bodies.get(id) || largeBodies.get(id);
    if (!aabb) return;
    bodies.delete(id);
    largeBodies.delete(id);
    if (bodies.size === 0 && largeBodies.size === 0) {
      clear();
      return;
    }
    if (!bulkPending) removeFromCells(id, aabb);
  }

  function removeFromCells(id, aabb) {
    if (largeBodies.has(id)) return; // large tier: no cell occupancy
    const lo = [
      Math.floor(aabb.minX / cellSize + EXTENT_EPS),
      Math.floor(aabb.minY / cellSize + EXTENT_EPS),
      Math.floor(aabb.minZ / cellSize + EXTENT_EPS),
    ];
    const hi = [
      Math.floor(aabb.maxX / cellSize + EXTENT_EPS),
      Math.floor(aabb.maxY / cellSize + EXTENT_EPS),
      Math.floor(aabb.maxZ / cellSize + EXTENT_EPS),
    ];
    for (let cx = lo[0]; cx <= hi[0]; cx++) {
      for (let cy = lo[1]; cy <= hi[1]; cy++) {
        for (let cz = lo[2]; cz <= hi[2]; cz++) {
          const set = cells.get(cellKey(cx, cy, cz));
          if (set) {
            set.delete(id);
            if (set.size === 0) cells.delete(cellKey(cx, cy, cz));
          }
        }
      }
    }
  }

  function query(aabb) {
    if (bulkPending && bodies.size > 0) rebuild(); // single lazy build
    if (cellSize === 0) return [];
    const hits = new Set();
    const loX = Math.floor(aabb.minX / cellSize + EXTENT_EPS);
    const loY = Math.floor(aabb.minY / cellSize + EXTENT_EPS);
    const loZ = Math.floor(aabb.minZ / cellSize + EXTENT_EPS);
    const hiX = Math.floor(aabb.maxX / cellSize + EXTENT_EPS);
    const hiY = Math.floor(aabb.maxY / cellSize + EXTENT_EPS);
    const hiZ = Math.floor(aabb.maxZ / cellSize + EXTENT_EPS);
    for (let cx = loX; cx <= hiX; cx++) {
      for (let cy = loY; cy <= hiY; cy++) {
        for (let cz = loZ; cz <= hiZ; cz++) {
          const set = cells.get(cellKey(cx, cy, cz));
          if (!set) continue;
          for (const id of set) hits.add(id);
        }
      }
    }
    // Large tier: exact AABB overlap (the cell walk returns exactly the
    // AABB-overlap set, so this keeps query results identical).
    for (const [id, bb] of largeBodies) {
      if (bb.minX <= aabb.maxX && bb.maxX >= aabb.minX &&
          bb.minY <= aabb.maxY && bb.maxY >= aabb.minY &&
          bb.minZ <= aabb.maxZ && bb.maxZ >= aabb.minZ) {
        hits.add(id);
      }
    }
    return [...hits].sort();
  }

  return {
    clear,
    insert,
    remove,
    query,
    rebuild,
    cellSize: () => cellSize,
    stats: () => ({
      bodies: bodies.size,
      cells: cells.size,
      largeBodies: largeBodies.size,
      rebuilds: rebuildCount,
    }),
  };
}
