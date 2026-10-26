// voxel3d mesher — per-chunk greedy meshing, flat-shaded vertex colors.
// Output is a triangle soup (3 verts per quad, no indices) in world-unit
// coordinates: quad corners lie on the grid lines X_MIN + x*V / y*V /
// Z_MIN + z*V (cell boundaries, NOT cell centers).
//
// FACE RULES (pinned in test/unit/voxel3d-mesher.test.js):
// 1. A face lies between a solid cell and a non-solid neighbor, exactly on
//    their shared grid plane, normal pointing OUT of the solid (unit axis).
//    Same-material solid adjacency produces no face (rule 1 covers it).
// 2. SOLID BLOCK — out-of-field x/z neighbors count as AIR. A solid cell on
//    the field boundary EMITS its outward face on the x=W / x=-1 / z=Z /
//    z=-1 plane, colored with the edge column's own material, so the exposed
//    strata read grass/dirt/rock instead of a flat tint. The terrain reads
//    as a solid block from outside; greedy merge collapses each boundary
//    wall to few rects (same per-face loop + greedy, no special geometry).
//    Pinned in test m6/m11.
//    => Implementation: an out-of-field x/z neighbor is EMPTY => face.
// 3. BOTTOM — a -Y face is emitted exactly when the below-cell is EMPTY or
//    below y=0 (out-of-field = air, same doctrine as rule 2). A lone
//    floating cell has 6 faces, not 5 (m2). Interior -Y between two solid
//    cells stays culled by adjacency (rule 1). Bottoms shaded SHADE_BOTTOM;
//    each bottom chunk's underside merges to ~1 rect.
// 4. Sky above a solid cell is a normal non-solid neighbor: rule 1 emits
//    the +Y face; empty cells with air neighbors emit nothing.
// 5. Same-material adjacency: no interior face (rule 1; pinned in m4).
// 6. Vertex color = material color (0..1 floats, the retired src/voxel/shell.js
//    convention ((c>>16)&255)/255 etc.) times the flat face-shade constant,
//    clamped to 1.0 per channel.
//
// PERF: faces are tagged into per-axis per-slice masks by one ascending
// scan of the chunk's solid cells; a dirty-slice flag list means slices
// whose faces are all buried (interior rock far from air) cost one read
// per solid cell and zero greedy work. The greedy pass is the classic 2D
// per-layer merge: ascending scan, grow width then full-occupancy height,
// single-material rectangles, one quad per rectangle. Determinism: fixed
// ascending iteration everywhere.
import {
  W, H, Z, V, X_MIN, Z_MIN, CH, EMPTY, MATERIALS,
  CHUNKS_X, CHUNKS_Y, CHUNKS_Z,
} from './constants.js';

// Flat face-shade constants (rule 6).
export const SHADE_TOP = 1.10;    // +Y
export const SHADE_SIDE = 0.80;   // ±X / ±Z
export const SHADE_BOTTOM = 0.62; // -Y (emitted under rule 3 when below-cell is empty or below y=0)

// material index -> [r,g,b] 0..1 floats (shell.js convention), precomputed.
const PAL = MATERIALS.map((m) => (m ? [
  ((m.color >> 16) & 255) / 255,
  ((m.color >> 8) & 255) / 255,
  (m.color & 255) / 255,
] : [0, 0, 0]));

// SE-EXPANSION-1012 A1: ROW derives from the LIVE W/Z bindings at call time —
// never a module-level capture (map size is data; extents change via
// setMapSize). rowOf(field) also works off the field's own carried dims.
const ROW = () => W * Z; // idx stride for +y

const EMPTY_GEOM = () => ({
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  colors: new Float32Array(0),
  vertCount: 0,
});

// DEEPEN-1015 R6 PERF: buildChunk's six per-axis slice masks + tags are
// scratch — rebuilt per chunk, never read across calls. With the deep floor
// extension a full build allocates ~7.5GB of transient typed arrays per field
// build (major-GC churn), so they live in ONE reusable module pool, zeroed at
// the top of each build. Sized dynamically (a caller with a bigger field dims
// gets a fresh buffer; the pool grows once).
const _pool = { buf: null, size: 0, views: null };
function scratch(total) {
  if (!_pool.buf || _pool.size < total) {
    _pool.buf = new ArrayBuffer(total);
    _pool.size = total;
    _pool.views = null;
  }
  if (!_pool.views) _pool.views = { u8: new Uint8Array(_pool.buf) };
  return _pool.views.u8;
}

// Classic 2D greedy over one slice. occ[i]=1 & mats[i]=materialId mark a
// needed face; layout is base + v*du + u, ascending v then u. Rectangles
// must be fully occupied and single-material. emitRect(u0, v0, w, h, m).
function greedy(occ, mats, du, dv, base, emitRect) {
  for (let v = 0; v < dv; v++) {
    const rb = base + v * du;
    for (let u = 0; u < du; u++) {
      const i = rb + u;
      if (occ[i] === 0) continue;
      const m = mats[i];
      let w = 1;
      while (u + w < du && occ[i + w] === 1 && mats[i + w] === m) w++;
      let hgt = 1;
      grow: while (v + hgt < dv) {
        const nb = i + hgt * du;
        for (let k = 0; k < w; k++) {
          if (occ[nb + k] !== 1 || mats[nb + k] !== m) break grow;
        }
        hgt++;
      }
      emitRect(u, v, w, hgt, m);
      for (let r = 0; r < hgt; r++) {
        const nb = i + r * du;
        for (let k = 0; k < w; k++) occ[nb + k] = 0;
      }
    }
  }
}

// Build one chunk's geometry. Triangle soup: 6 verts per merged rectangle.
// opts.slabZ (DEEPEN-1015 R4, hollow-intro fix): when set (with opts.slabZStart),
// interior z-boundary faces are ALSO emitted where both cells are solid and
// the shared plane sits on a slab grid line (z or z+1 a multiple of slabZ,
// strictly inside the corridor at/after slabZStart). Legacy behavior (faces
// only against air/OOB) when absent — byte-identical geometry for every
// non-corridor caller (skirt side fields, legacy tests).
export function buildChunk(f, cx, cy, cz, opts = {}) {
  const slabZ = Number.isInteger(opts.slabZ) && opts.slabZ > 0 ? opts.slabZ : 0;
  const slabZStart = slabZ ? (Number.isInteger(opts.slabZStart) ? opts.slabZStart : 0) : 0;
  // FPS-1012g generalization: dims/origins read off the FIELD OBJECT (f.W/f.H/
  // f.Z/f.X_MIN/f.Z_MIN — makeField attaches them; skirt side fields carry
  // their own). Behavior-identical for the real field (f dims == globals).
  const FW = f.W, FH = f.H, FZ = f.Z;
  const FX = f.X_MIN, FZMIN = f.Z_MIN;
  // DEEPEN-1015 R6: the field's world-y origin for cell 0 (real field:
  // -FLOOR_CELLS*V so the deep floor cells render below world y=0; side
  // fields / synthetic test fields without Y_MIN default to 0 — unchanged).
  const FY = f.Y_MIN ?? 0;
  const x0 = cx * CH, x1 = Math.min(FW, x0 + CH);
  const y0 = cy * CH, y1 = Math.min(FH, y0 + CH);
  const z0 = cz * CH, z1 = Math.min(FZ, z0 + CH);
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const cells = f.cells;

  // Per-axis per-direction slice sizes (mask dims).
  const sX = dy * dz, sZ = dx * dy, sY = dx * dz;
  let xOp, xOm, xOpTag, xOmTag, zOp, zOm, zOpTag, zOmTag, yOp, yOm, yOpTag, yOmTag;
  let dXp, dXm, dZp, dZm, dYp, dYm;
  // DEEPEN-1015 R6 PERF: the 6 mask/tag arrays + dirty flags come from the
  // shared scratch pool (zeroed here every call — they are pure per-chunk
  // scratch). Same layout/semantics as the previous per-call allocations.
  {
    const need = 4 * dx * sX + 4 * dz * sZ + 4 * dy * sY + 2 * dx + 2 * dz + 2 * dy;
    const u8 = scratch(need);
    u8.fill(0, 0, need);
    let o = 0;
    const view = (n) => u8.subarray(o, o += n);
    xOp = view(dx * sX); xOm = view(dx * sX); xOpTag = view(dx * sX); xOmTag = view(dx * sX);
    zOp = view(dz * sZ); zOm = view(dz * sZ); zOpTag = view(dz * sZ); zOmTag = view(dz * sZ);
    yOp = view(dy * sY); yOpTag = view(dy * sY);
    dXp = view(dx); dXm = view(dx); dZp = view(dz); dZm = view(dz); dYp = view(dy);
    yOm = view(dy * sY); yOmTag = view(dy * sY); dYm = view(dy);
  }

  // ---- tag pass: ascending scan of the chunk's solid cells --------------
  // PERF (m9, 2026-10-11): the +y stride is stable for one buildField call —
  // hoist it; ROW() per solid cell cost ~15% of the full-field build.
  const rowV = FW * FZ;
  for (let x = x0; x < x1; x++) {
    const xi = x - x0;
    for (let z = z0; z < z1; z++) {
      const zi = z - z0;
      const col = x + z * FW;
      for (let y = y0; y < y1; y++) {
        const v = cells[col + y * rowV];
        if (v === EMPTY) continue;
        const i = col + y * rowV;
        const yi = y - y0;
        // +X: OOB (x+1 === W) counts as AIR => rim face (rule 2, solid block)
        if (x + 1 >= FW || cells[i + 1] === EMPTY) {
          const k = xi * sX + yi * dz + zi;
          xOp[k] = 1; xOpTag[k] = v; dXp[xi] = 1;
        }
        // -X: x-1 === -1 is OOB air => rim face (rule 2)
        if (x - 1 < 0 || cells[i - 1] === EMPTY) {
          const k = xi * sX + yi * dz + zi;
          xOm[k] = 1; xOmTag[k] = v; dXm[xi] = 1;
        }
        // +Z / -Z: OOB beyond the field edges counts as AIR => rim faces (rule 2).
        // DEEPEN-1015 R4: with opts.slabZ, a solid-solid boundary on a slab
        // plane inside the corridor ALSO emits (both chunks emit their own
        // material's face) so welded fall slabs read solid when they separate.
        const zSlabP = slabZ !== 0 && (z + 1) % slabZ === 0 && z >= slabZStart && z + 1 < FZ && cells[i + FW] !== EMPTY;
        if (z + 1 >= FZ || cells[i + FW] === EMPTY || zSlabP) {
          const k = zi * sZ + yi * dx + xi;
          zOp[k] = 1; zOpTag[k] = v; dZp[zi] = 1;
        }
        const zSlabM = slabZ !== 0 && z % slabZ === 0 && z - 1 >= slabZStart && z - 1 >= 0 && cells[i - FW] !== EMPTY;
        if (z - 1 < 0 || cells[i - FW] === EMPTY || zSlabM) {
          const k = zi * sZ + yi * dx + xi;
          zOm[k] = 1; zOmTag[k] = v; dZm[zi] = 1;
        }
        // +Y: sky (incl. y+1 === H) is air => face (rules 1 + 4)
        if (y + 1 >= FH || cells[i + rowV] === EMPTY) {
          const k = yi * sY + zi * dx + xi;
          yOp[k] = 1; yOpTag[k] = v; dYp[yi] = 1;
        }
        // -Y: emit when the below-cell is EMPTY or below y=0 (rule 3)
        if (y - 1 < 0 || cells[i - rowV] === EMPTY) {
          const k = yi * sY + zi * dx + xi;
          yOm[k] = 1; yOmTag[k] = v; dYm[yi] = 1;
        }
      }
    }
  }

  const pos = [], nor = [], col = [];
  const quad = (a, b, c, d, n0, n1, n2, m, shade) => {
    const p = PAL[m];
    const r = Math.min(1, p[0] * shade);
    const g = Math.min(1, p[1] * shade);
    const bl = Math.min(1, p[2] * shade);
    // a,b,c,d are CCW seen from +normal; two triangles.
    for (const t of [a, b, c, a, c, d]) {
      pos.push(t[0], t[1], t[2]);
      nor.push(n0, n1, n2);
      col.push(r, g, bl);
    }
  };

  // ---- greedy pass per axis, ascending slice order -----------------------
  for (let xi = 0; xi < dx; xi++) {
    if (dXp[xi]) {
      const px = FX + (x0 + xi + 1) * V;
      greedy(xOp, xOpTag, dz, dy, xi * sX, (zu, yv, w, h, m) => {
        const zl = FZMIN + (z0 + zu) * V, zh = FZMIN + (z0 + zu + w) * V;
        const yl = FY + (y0 + yv) * V, yh = FY + (y0 + yv + h) * V;
        quad([px, yl, zl], [px, yh, zl], [px, yh, zh], [px, yl, zh], 1, 0, 0, m, SHADE_SIDE);
      });
    }
    if (dXm[xi]) {
      const px = FX + (x0 + xi) * V;
      greedy(xOm, xOmTag, dz, dy, xi * sX, (zu, yv, w, h, m) => {
        const zl = FZMIN + (z0 + zu) * V, zh = FZMIN + (z0 + zu + w) * V;
        const yl = FY + (y0 + yv) * V, yh = FY + (y0 + yv + h) * V;
        quad([px, yl, zh], [px, yh, zh], [px, yh, zl], [px, yl, zl], -1, 0, 0, m, SHADE_SIDE);
      });
    }
  }
  for (let yi = 0; yi < dy; yi++) {
    if (dYp[yi]) {
      const py = FY + (y0 + yi + 1) * V;
      greedy(yOp, yOpTag, dx, dz, yi * sY, (xu, zv, w, h, m) => {
        const xl = FX + (x0 + xu) * V, xh = FX + (x0 + xu + w) * V;
        const zl = FZMIN + (z0 + zv) * V, zh = FZMIN + (z0 + zv + h) * V;
        quad([xl, py, zh], [xh, py, zh], [xh, py, zl], [xl, py, zl], 0, 1, 0, m, SHADE_TOP);
      });
    }
    if (dYm[yi]) {
      const py = FY + (y0 + yi) * V; // face plane = bottom of the cell (rule 3)
      greedy(yOm, yOmTag, dx, dz, yi * sY, (xu, zv, w, h, m) => {
        const xl = FX + (x0 + xu) * V, xh = FX + (x0 + xu + w) * V;
        const zl = FZMIN + (z0 + zv) * V, zh = FZMIN + (z0 + zv + h) * V;
        quad([xl, py, zl], [xh, py, zl], [xh, py, zh], [xl, py, zh], 0, -1, 0, m, SHADE_BOTTOM);
      });
    }
  }
  for (let zi = 0; zi < dz; zi++) {
    if (dZp[zi]) {
      const pz = FZMIN + (z0 + zi + 1) * V;
      greedy(zOp, zOpTag, dx, dy, zi * sZ, (xu, yv, w, h, m) => {
        const xl = FX + (x0 + xu) * V, xh = FX + (x0 + xu + w) * V;
        const yl = FY + (y0 + yv) * V, yh = FY + (y0 + yv + h) * V;
        quad([xl, yl, pz], [xh, yl, pz], [xh, yh, pz], [xl, yh, pz], 0, 0, 1, m, SHADE_SIDE);
      });
    }
    if (dZm[zi]) {
      const pz = FZMIN + (z0 + zi) * V;
      greedy(zOm, zOmTag, dx, dy, zi * sZ, (xu, yv, w, h, m) => {
        const xl = FX + (x0 + xu) * V, xh = FX + (x0 + xu + w) * V;
        const yl = FY + (y0 + yv) * V, yh = FY + (y0 + yv + h) * V;
        quad([xl, yh, pz], [xh, yh, pz], [xh, yl, pz], [xl, yl, pz], 0, 0, -1, m, SHADE_SIDE);
      });
    }
  }

  if (pos.length === 0) return EMPTY_GEOM();
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    colors: new Float32Array(col),
    vertCount: pos.length / 3,
  };
}

// Full field -> Map<chunkKey, geom> for ALL chunks (empty geometry is
// still stored). Deterministic insertion order: cx, then cy, then cz
// ascending.
// DEEPEN-1015 R6 PERF: the deep floor extension triples the y-bucket count
// (CHUNKS_Y 6 -> 23) and the deep interior is SOLID DIRT — fully-buried
// chunks (all cells solid, all 4 side neighbors solid, not at the world
// bottom, no slab plane inside) can emit NO face (rule 1 culls interior
// adjacency; rims need an out-of-field/air side). Skipping their full tag
// scan is byte-identical: they come back EMPTY_GEOM exactly as before.
// Buried detection uses per-column tops (columns are heights-only after every
// mutation — field.js doctrine) found by binary search.
export function buildField(f, opts = {}) {
  // FPS-1012g: chunk counts read off the FIELD (skirt side fields carry their
  // own grid) — globals remain the fallback for bare fields.
  const NCX = f.CHUNKS_X ?? CHUNKS_X, NCY = f.CHUNKS_Y ?? CHUNKS_Y, NCZ = f.CHUNKS_Z ?? CHUNKS_Z;
  const out = new Map();
  const FW = f.W, FH = f.H, FZ = f.Z;
  const row = FW * FZ, cells = f.cells;
  const FX = f.X_MIN, FZMIN = f.Z_MIN, FY = f.Y_MIN ?? 0; // slabFast world placement (same law as buildChunk)
  // Per-column top (highest solid y, or -1) via binary search: heights-only.
  const tops = new Int16Array(row);
  for (let c = 0; c < row; c++) {
    let lo = 0, hi = FH - 1, top = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cells[c + mid * row] !== EMPTY) { top = mid; lo = mid + 1; } else hi = mid - 1;
    }
    tops[c] = top;
  }
  // min top over a chunk footprint (x0..x1, z0..z1), memoized per (cx,cz).
  const minTopCache = new Map();
  const minTop = (cx, cz) => {
    const key = cx + cz * NCX;
    let m = minTopCache.get(key);
    if (m === undefined) {
      m = Infinity;
      const x0 = cx * CH, x1 = Math.min(FW, x0 + CH), z0 = cz * CH, z1 = Math.min(FZ, z0 + CH);
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) {
          const t = tops[x + z * FW];
          if (t < m) m = t;
        }
      }
      minTopCache.set(key, m);
    }
    return m;
  };
  const slabZ = Number.isInteger(opts.slabZ) && opts.slabZ > 0 ? opts.slabZ : 0;
  const slabZStart = slabZ ? (Number.isInteger(opts.slabZStart) ? opts.slabZStart : 0) : 0;
  // Fully-solid block test (self + 4 side neighbors solid through y1; full
  // 32-cell ranges). Such a chunk can ONLY emit: field-rim faces, the y=0
  // bottom face, and corridor slab-plane faces — rule 1 culls everything else.
  const solidBlock = (cx, cy, cz) => {
    const y1b = (cy + 1) * CH;
    if (y1b > FH) return false;
    const x0b = cx * CH, z0b = cz * CH;
    if (x0b + CH > FW || z0b + CH > FZ) return false;
    // self fully solid; existing side neighbors fully solid — an OOB side
    // (field rim) is air and becomes the chunk's boundary face (fast path).
    if (minTop(cx, cz) < y1b) return false;
    if (cx > 0 && minTop(cx - 1, cz) < y1b) return false;
    if ((cx + 1) * CH < FW && minTop(cx + 1, cz) < y1b) return false;
    if (cz > 0 && minTop(cx, cz - 1) < y1b) return false;
    if ((cz + 1) * CH < FZ && minTop(cx, cz + 1) < y1b) return false;
    return true;
  };
  // DEEPEN-1015 R6 PERF (uniform solid-block fast path): a fully-solid chunk
  // whose 32^3 cells are ONE material emits ONLY its boundary faces — rim
  // (-x/+x/-z/+z), world-bottom (-y at cy 0), corridor slab planes — each a
  // single full-face greedy rect. Byte-identical to buildChunk (same quad()
  // vertex order: x-faces ascending xi [+X before -X per xi], then y-faces,
  // then z-faces; one rect per full uniform face) without mask/greedy work.
  // Returns: geometry object (possibly vertCount 0 = fully buried), or null
  // when materials are mixed (caller falls back to the full buildChunk).
  const blockFast = (cx, cy, cz) => {
    const x0b = cx * CH, y0b = cy * CH, z0b = cz * CH;
    const y1b = y0b + CH;
    // eligible faces in buildChunk emission order
    const faces = [];
    if (cx === 0) faces.push(['-X', 0]);
    if ((cx + 1) * CH >= FW) faces.push(['+X', 0]);
    if (cy === 0) faces.push(['-Y', 0]);
    if (cz === 0) faces.push(['-Z', 0]);
    if ((cz + 1) * CH >= FZ) faces.push(['+Z', 0]);
    if (slabZ) {
      for (let zi = 0; zi < CH; zi++) {
        const zp = z0b + zi + 1;
        if (zp % slabZ === 0 && zp < FZ && z0b + zi >= slabZStart) faces.push(['+Z', zp]);
        const zm = z0b + zi;
        if (zm % slabZ === 0 && zm - 1 >= slabZStart && zm - 1 >= 0) faces.push(['-Z', zm]);
      }
    }
    if (!faces.length) return { vertCount: 0, positions: new Float32Array(0), normals: new Float32Array(0), colors: new Float32Array(0) };
    // uniform material check (single tight scan, no allocations)
    const m0 = cells[x0b + z0b * FW + y0b * row];
    let _mix = 0;
    for (let y = y0b; y < y1b; y++) {
      const yoff = y * row;
      for (let z = z0b; z < z0b + CH; z++) {
        const base = x0b + z * FW + yoff;
        for (let x = 0; x < CH; x++) {
          if (cells[base + x] !== m0) _mix++;
        }
      }
    }
    if (_mix) return null; // mixed materials — full build
    const xl = FX + x0b * V, xh = FX + (x0b + CH) * V;
    const yl = FY + y0b * V, yh = FY + y1b * V;
    const zl = FZMIN + z0b * V, zh = FZMIN + (z0b + CH) * V;
    const positions = [], normals = [], colors = [];
    const quad = (a, b, c, d, n0, n1, n2, shade) => {
      const p = PAL[m0];
      const r = Math.min(1, p[0] * shade), g2 = Math.min(1, p[1] * shade), b2 = Math.min(1, p[2] * shade);
      for (const t of [a, b, c, a, c, d]) {
        positions.push(t[0], t[1], t[2]);
        normals.push(n0, n1, n2);
        colors.push(r, g2, b2);
      }
    };
    for (const [kind, plane] of faces) {
      if (kind === '+X') quad([xh, yl, zl], [xh, yh, zl], [xh, yh, zh], [xh, yl, zh], 1, 0, 0, SHADE_SIDE);
      else if (kind === '-X') quad([xl, yl, zh], [xl, yh, zh], [xl, yh, zl], [xl, yl, zl], -1, 0, 0, SHADE_SIDE);
      else if (kind === '-Y') quad([xl, yl, zl], [xh, yl, zl], [xh, yl, zh], [xl, yl, zh], 0, -1, 0, SHADE_BOTTOM);
      else if (kind === '+Z') { const pz = plane ? FZMIN + plane * V : zh; quad([xl, yl, pz], [xh, yl, pz], [xh, yh, pz], [xl, yh, pz], 0, 0, 1, SHADE_SIDE); }
      else { const pz = plane ? FZMIN + plane * V : zl; quad([xl, yh, pz], [xh, yh, pz], [xh, yl, pz], [xl, yl, pz], 0, 0, -1, SHADE_SIDE); }
    }
    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      colors: new Float32Array(colors),
      vertCount: positions.length / 3,
    };
  };
  for (let cx = 0; cx < NCX; cx++) {
    for (let cy = 0; cy < NCY; cy++) {
      for (let cz = 0; cz < NCZ; cz++) {
        const key = `${cx},${cy},${cz}`;
        if (solidBlock(cx, cy, cz)) {
          const fast = blockFast(cx, cy, cz);
          // blockFast null = mixed materials (near-surface strata) — fall back
          // to the full build, never a silent empty.
          out.set(key, fast ?? buildChunk(f, cx, cy, cz, opts));
        } else {
          out.set(key, buildChunk(f, cx, cy, cz, opts));
        }
      }
    }
  }
  return out;
}

// Rebuild only the given chunk keys (blast dirty path).
export function rebuildChunks(f, chunkKeys, opts = {}) {
  const out = new Map();
  for (const key of chunkKeys) {
    const c = key.split(',');
    out.set(key, buildChunk(f, +c[0], +c[1], +c[2], opts));
  }
  return out;
}
