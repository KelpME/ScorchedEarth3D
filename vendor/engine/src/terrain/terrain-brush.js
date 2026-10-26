/**
 * Engine — terrain sculpt brushes (pure, Node-testable; Phase B1).
 *
 * Pure heightfield sculpt ops over the engine's terrain contract: a full
 * row-major `(segments+1)²` grid (row 0 = `-size/2` Z edge, col 0 = `-size/2`
 * X edge). Grid coords: `cx` -> column (X), `cz` -> row (Z); fractional
 * centers allowed. Every op returns a NEW array — inputs are never mutated.
 * No three import — usable by editor, engine, and tests alike.
 */

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const mix = (a, b, t) => a + (b - a) * t

/**
 * Brush falloff weight over normalized radial distance t ∈ [0, 1] (clamped).
 * `'linear'` -> 1 - t; `'smoothstep'` -> u*u*(3 - 2u) with u = 1 - t. Both
 * are exactly 1 at t=0 and 0 at t=1, monotonic decreasing. Unknown curves
 * fall back to linear. Non-finite `t` returns 0 (no brush influence).
 * @returns {number} weight in [0, 1].
 */
export function falloffWeight(t, curve) {
  if (!Number.isFinite(Number(t))) return 0 // non-finite t -> zero weight
  const x = Math.min(1, Math.max(0, num(t, 0)))
  if (String(curve).toLowerCase() === 'smoothstep') {
    const u = 1 - x
    return u * u * (3 - 2 * u)
  }
  return 1 - x
}

/**
 * Local slope at vertex (r, c) in DEGREES from orthogonal finite differences
 * of `heights`: dhdr = (h[r+1,c]-h[r-1,c])/(2*cellSize), dhc likewise;
 * slope = atan(hypot(dhdr, dhc)) in degrees. Edge-clamped one-sided
 * differences. cellSize from opts.cellSize if provided else 1.
 */
export function localSlopeDeg(heights, segments, r, c, cellSize = 1) {
  const n = segments + 1
  const h = (rr, cc) => heights[rr * n + cc]
  const step = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : 1
  const dhdr = r < segments && r > 0
    ? (h(r + 1, c) - h(r - 1, c)) / (2 * step)
    : (h(Math.min(segments, r + 1), c) - h(Math.max(0, r - 1), c)) / step
  const dhc = c < segments && c > 0
    ? (h(r, c + 1) - h(r, c - 1)) / (2 * step)
    : (h(r, Math.min(segments, c + 1)) - h(r, Math.max(0, c - 1))) / step
  return Math.atan(Math.hypot(dhdr, dhc)) * (180 / Math.PI)
}

/**
 * Pure constraint gate. Returns the (possibly clamped) height, or `null` to
 * REJECT the candidate (leave the vertex unchanged). Fields ignored
 * individually when non-finite; absent/empty constraints pass through.
 * - `minAltitude` / `maxAltitude`: clamp final height.
 * - `slopeMinDeg` / `slopeMaxDeg`: reject when localSlopeDeg outside [min, max].
 * - `targetFilter: 'all'|'above'|'below'` + `targetFilterHeight`: `'above'`
 *   applies only where the CURRENT (pre-op) height >= targetFilterHeight,
 *   `'below'` the inverse; otherwise rejected. The pre-op height is passed via
 *   the optional `currentHeight`; when omitted it defaults to `height`, so a
 *   candidate-only call gates on the candidate itself (backward compatible).
 */
export function applyConstraints(height, localSlopeDeg, constraints, currentHeight = height) {
  const k = constraints && typeof constraints === 'object' ? constraints : {}
  let h = num(height, NaN)
  if (!Number.isFinite(h)) return null

  const slope = Number(localSlopeDeg)
  const sMin = Number(k.slopeMinDeg)
  const sMax = Number(k.slopeMaxDeg)
  if (Number.isFinite(slope)) {
    if (Number.isFinite(sMin) && slope < sMin) return null
    if (Number.isFinite(sMax) && slope > sMax) return null
  }

  const filter = String(k.targetFilter ?? 'all').toLowerCase()
  if (filter === 'above' || filter === 'below') {
    const tfh = Number(k.targetFilterHeight)
    if (Number.isFinite(tfh)) {
      // Gate on the CURRENT (pre-op) height, not the candidate. null and
      // undefined both mean 'not provided' -> fall back to the candidate.
      const cur = currentHeight == null ? num(height, NaN) : num(currentHeight, NaN)
      const passes = filter === 'above' ? cur >= tfh : cur < tfh
      if (!passes) return null
    }
  }

  const minA = Number(k.minAltitude)
  const maxA = Number(k.maxAltitude)
  if (Number.isFinite(minA)) h = Math.max(minA, h)
  if (Number.isFinite(maxA)) h = Math.min(maxA, h)
  return h
}

/** Average of the up-to-8 orthogonal+diagonal NEIGHBOR heights (existing
 *  neighbors only, clamped at grid edges; excludes the vertex itself). */
function localAvg8(heights, segments, r, c) {
  const n = segments + 1
  let sum = 0
  let count = 0
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue
      const rr = r + dr
      const cc = c + dc
      if (rr < 0 || rr > segments || cc < 0 || cc > segments) continue
      sum += heights[rr * n + cc]
      count++
    }
  }
  return count ? sum / count : 0
}

/**
 * Apply one sculpt op over a circular brush on a tile heightfield. Returns a
 * NEW array; never mutates `heights`. Vertices within `radiusCells` (Euclidean,
 * grid cells) of the fractional center `(cx, cz)` get weight w = falloffWeight(
 * dist/radiusCells, falloff); per-op:
 * - raise:     h + strength*w
 * - lower:     h - strength*w
 * - flatten:   h + (targetHeight - h) * min(1, strength) * w
 * - smooth:    mix(h, localAvg8, strength * w)
 * - setHeight: mix(h, targetHeight, w)
 * Every candidate passes through applyConstraints(newH, slopeFromORIGINALHeights,
 * constraints, ORIGINALVertexHeight); rejection (null) or a non-finite result
 * leaves the vertex unchanged. Unknown op / radiusCells <= 0 -> unchanged copy.
 * @param {number[]} heights  row-major (segments+1)² grid.
 * @param {number} segments
 * @param {object} opts  { op, cx, cz, radiusCells, strength, targetHeight,
 *   falloff='linear', cellSize=1, constraints }
 * @returns {number[]} new heightfield.
 */
export function sculptTileHeights(heights, segments, opts = {}) {
  const seg = Math.max(1, Math.floor(segments) || 1)
  const n = seg + 1
  const src = Array.isArray(heights) ? heights : []
  const out = new Array(n * n)
  for (let i = 0; i < out.length; i++) {
    const v = Number(src[i])
    out[i] = Number.isFinite(v) ? v : 0
  }

  const o = opts && typeof opts === 'object' ? opts : {}
  const op = String(o.op ?? '')
  const OPS = ['raise', 'lower', 'flatten', 'smooth', 'setHeight']
  if (!OPS.includes(op)) return out

  const radius = Number(o.radiusCells)
  if (!Number.isFinite(radius) || radius <= 0) return out

  const cx = num(o.cx, NaN)
  const cz = num(o.cz, NaN)
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) return out

  const strength = Number(o.strength)
  const targetHeight = Number(o.targetHeight)
  const falloff = o.falloff ?? 'linear'
  const cellSize = num(o.cellSize, 1)
  const constraints = o.constraints

  const r0 = Math.max(0, Math.floor(cz - radius))
  const r1 = Math.min(seg, Math.ceil(cz + radius))
  const c0 = Math.max(0, Math.floor(cx - radius))
  const c1 = Math.min(seg, Math.ceil(cx + radius))

  // Slope gating and smooth's neighbor average read the ORIGINAL (pre-sculpt)
  // sanitized grid, never the partially-written output.
  const orig = out.slice()

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const dist = Math.hypot(c - cx, r - cz)
      if (dist > radius) continue
      const i = r * n + c
      // sculptOpAt serves sculptTileHeights; applySculptWorld's world patch
      // pass carries a parallel op switch (the parity regression test is the
      // drift guard between the two).
      const gated = sculptOpAt(orig, seg, r, c, out[i], dist, {
        op, strength, targetHeight, falloff, radius, cellSize, constraints,
      })
      if (gated === null || !Number.isFinite(gated)) continue // rejection leaves vertex unchanged
      out[i] = gated
    }
  }
  return out
}

/**
 * One brush candidate at grid vertex (r, c): op formula from `h`, falloff from
 * `dist`/radiusCells, then constraint gate with slope + targetFilter read from
 * the ORIGINAL patch `orig`. Returns null when the vertex must stay unchanged.
 * Used by sculptTileHeights only; applySculptWorld's world patch pass carries
 * a parallel op switch — the parity regression test is the drift guard.
 */
function sculptOpAt(orig, seg, r, c, h, dist, o) {
  const w = falloffWeight(dist / o.radius, o.falloff)
  let candidate
  switch (o.op) {
    case 'raise':   candidate = h + o.strength * w; break
    case 'lower':   candidate = h - o.strength * w; break
    case 'flatten': candidate = h + (o.targetHeight - h) * Math.min(1, num(o.strength, 0)) * w; break
    case 'smooth':  candidate = mix(h, localAvg8(orig, seg, r, c), num(o.strength, 0) * w); break
    case 'setHeight': candidate = mix(h, o.targetHeight, w); break
    default: return null
  }
  if (!Number.isFinite(candidate)) return null // NaN-guard: leave unchanged
  const slope = localSlopeDeg(orig, seg, r, c, o.cellSize)
  // targetFilter gates on the ORIGINAL pre-op vertex height.
  const gated = applyConstraints(candidate, slope, o.constraints, orig[r * (seg + 1) + c])
  if (gated === null || !Number.isFinite(gated)) return null // rejection leaves vertex unchanged
  return gated
}

/**
 * Apply one sculpt brush in WORLD space across a set of tiles (T2).
 * Tiles are plain JSON: { tileIndexX, tileIndexZ, terrain:{ size, segments,
 * heights }, transform?:{x,y,z} }. World placement is per-tile TRANSFORM-based:
 * grid vertex (r, c) sits at x = transform.x - size/2 + c*step and
 * z = transform.z - size/2 + r*step with step = size/segments (the transform is
 * honored when finite, else the index-based default). No tileIndex*seg position
 * math — tiles off the index lattice land at their real world positions.
 *
 * 1. Validate every tile's terrain.size/segments against args (mismatch ->
 *    TypeError). Non-finite center or radius <= 0 -> { changed:false, tiles,
 *    changedTiles: [] }.
 * 2. affected = tiles whose REAL world extent [x±size/2]² overlaps the brush
 *    circle (point clamped to the extent); empty -> passthrough. Only tiles in
 *    `affected` are brush-written; seam propagation (step 5) additionally
 *    writes the border of edge-coincident non-affected neighbors (lazy-copied).
 * 3. Gather world vertices near the circle (bbox + one step margin) keyed by
 *    quantized world position. Owner preference on shared vertices: higher
 *    tileIndexX, then tileIndexZ. Vertices owned by NO provided tile are absent
 *    and never written.
 * 4. Brush op over the gathered vertices with sculptTileHeights semantics
 *    (radius in WORLD units; slope + targetFilter from ORIGINAL heights). Each
 *    WORLD vertex is computed once and written to EVERY tile whose grid holds
 *    it — a painted tile's border is never fed from a world-disjoint neighbor.
 * 5. Border propagation ONLY across genuinely shared world edges: two tiles
 *    propagate only if their extents are edge-coincident in world space
 *    (|A.maxX - B.minX| < 1e-6, likewise all four sides, orthogonal extents
 *    matching). The higher tileIndexX, then tileIndexZ, tile's border is
 *    canonical on both sides (only the lower-index side is written).
 *    Index-adjacent but world-disjoint tiles never touch each other.
 * @returns {{ changed: boolean, tiles: object[], changedTiles: object[] }}
 *    `tiles`: all tiles, copied where written (the original `tiles` reference
 *    when nothing changed). `changedTiles`: ONLY tiles whose heights array
 *    actually changed — fresh objects carrying fresh arrays. Inputs are never
 *    mutated.
 */
export function applySculptWorld({ tiles, worldCenterX, worldCenterZ, radius, size, segments, brush } = {}) {
  const seg = Math.max(1, Math.floor(segments) || 1)
  const n = seg + 1
  const list = Array.isArray(tiles) ? tiles : []

  for (const t of list) {
    if (!t || !t.terrain || t.terrain.size !== size || t.terrain.segments !== segments) {
      throw new TypeError(`applySculptWorld: tile (${t?.tileIndexX}, ${t?.tileIndexZ}) terrain.size/segments must match args (size=${size}, segments=${segments})`)
    }
  }

  const cxW = Number(worldCenterX)
  const czW = Number(worldCenterZ)
  const rW = Number(radius)
  if (!Number.isFinite(cxW) || !Number.isFinite(czW) || !Number.isFinite(rW) || rW <= 0) {
    return { changed: false, tiles, changedTiles: [] }
  }

  // (A) Per-tile TRANSFORM-based placement: explicit transform when finite,
  // else the index-based default. Grid vertex (r, c) sits at
  // center - size/2 + c*step (no tileIndex*seg position math).
  const step = size / seg
  const centerX = (t) => num(t.transform?.x, (t.tileIndexX + 0.5) * size - size / 2)
  const centerZ = (t) => num(t.transform?.z, (t.tileIndexZ + 0.5) * size - size / 2)
  const vertX = (t, c) => centerX(t) - size / 2 + c * step
  const vertZ = (t, r) => centerZ(t) - size / 2 + r * step

  // (B) affected: REAL extent overlaps the brush circle (clamp point to extent).
  const half = size / 2
  const affected = list.filter((t) => {
    const dx = Math.max(Math.abs(cxW - centerX(t)) - half, 0)
    const dz = Math.max(Math.abs(czW - centerZ(t)) - half, 0)
    return Math.hypot(dx, dz) <= rW
  })
  if (affected.length === 0) return { changed: false, tiles, changedTiles: [] }

  // Owner preference: sort ascending so higher tileIndexX, then tileIndexZ,
  // overwrites on shared world vertices.
  const owners = [...list].sort((a, b) =>
    (a.tileIndexX - b.tileIndexX) || (a.tileIndexZ - b.tileIndexZ))

  // Gather world vertices within the circle bbox + one step margin (covers all
  // ±1-vertex neighbors for slope/smooth), keyed by quantized world position
  // so tiles agree on genuinely shared vertices even off the index lattice.
  const QUANT = 1e6 // world-position key quantization (1/EPS); shared vertices agree on a key
  const keyOf = (x, z) => `${Math.round(x * QUANT)},${Math.round(z * QUANT)}`
  const world = new Map() // key -> { x, z, h, t, r, c } (owner-preference value)
  const reach = rW + step
  for (const t of owners) {
    for (let r = 0; r <= seg; r++) {
      const z = vertZ(t, r)
      if (Math.abs(z - czW) > reach) continue
      for (let c = 0; c <= seg; c++) {
        const x = vertX(t, c)
        if (Math.abs(x - cxW) > reach) continue
        const v = Number(t.terrain.heights[r * n + c])
        // later owner (higher index) wins even when sanitizing
        world.set(keyOf(x, z), { x, z, h: Number.isFinite(v) ? v : 0, t, r, c })
      }
    }
  }

  // Brush op over gathered world vertices: same semantics as
  // sculptTileHeights — neighbors for smooth are looked up by world position.
  const o = brush && typeof brush === 'object' ? brush : {}
  const OP_NAMES = ['raise', 'lower', 'flatten', 'smooth', 'setHeight']
  const op = String(o.op ?? '')
  const falloff = o.falloff ?? 'linear'
  const strength = Number(o.strength)
  const targetHeight = Number(o.targetHeight)
  const constraints = o.constraints
  const cs = Number.isFinite(o.cellSize) && o.cellSize > 0 ? Number(o.cellSize) : step

  const worldVal = (x, z) => {
    const e = world.get(keyOf(x, z))
    return e ? e.h : null // absent -> owned by no provided tile, never fabricated
  }
  const worldAvg8 = (x, z) => {
    let sum = 0
    let count = 0
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue
        const v = worldVal(x + dc * step, z + dr * step)
        if (v !== null) { sum += v; count++ }
      }
    }
    return count ? sum / count : 0
  }

  // Slope gating reads the owning tile's ORIGINAL heights sanitized exactly
  // like sculptTileHeights' input copy (non-finite -> 0), then slopes from the
  // sanitized grid — so both functions gate identically even with NaN heights.
  const sanGrids = new Map() // tile -> sanitized n*n copy (built lazily, once)
  const sanitizedGrid = (t) => {
    let g = sanGrids.get(t)
    if (!g) {
      const src = t.terrain.heights
      g = new Array(n * n)
      for (let i = 0; i < g.length; i++) {
        const v = Number(src[i])
        g[i] = Number.isFinite(v) ? v : 0
      }
      sanGrids.set(t, g)
    }
    return g
  }

  // Brush pass: each WORLD vertex is computed once and later written to every
  // tile whose grid holds it. Only vertices inside the circle are candidates.
  const results = new Map() // key -> new height, only vertices that changed
  if (OP_NAMES.includes(op)) {
    for (const [k, e] of world) {
      const dist = Math.hypot(e.x - cxW, e.z - czW)
      if (dist > rW) continue
      const w = falloffWeight(dist / rW, falloff)
      let candidate
      switch (op) {
        case 'raise':   candidate = e.h + strength * w; break
        case 'lower':   candidate = e.h - strength * w; break
        case 'flatten': candidate = e.h + (targetHeight - e.h) * Math.min(1, num(strength, 0)) * w; break
        case 'smooth':  candidate = mix(e.h, worldAvg8(e.x, e.z), num(strength, 0) * w); break
        case 'setHeight': candidate = mix(e.h, targetHeight, w); break
        default: continue
      }
      if (!Number.isFinite(candidate)) continue // NaN-guard: leave unchanged
      // Slope + targetFilter gate on the ORIGINAL pre-op heights, sanitized
      // to 0 where non-finite (parity with sculptTileHeights' gating grid).
      const slope = localSlopeDeg(sanitizedGrid(e.t), seg, e.r, e.c, cs)
      const gated = applyConstraints(candidate, slope, constraints, e.h)
      if (gated === null || !Number.isFinite(gated)) continue // rejection leaves vertex unchanged
      if (gated !== e.h) results.set(k, gated)
    }
  }
  if (results.size === 0) return { changed: false, tiles, changedTiles: [] }

  // Write back into affected tiles as NEW arrays; inputs stay untouched. World
  // vertices map to each tile through its own transform — every tile whose grid
  // holds a changed vertex receives the SAME value (watertight seams for free).
  const affectedSet = new Set(affected)
  const outIndex = new Map(list.map((t, i) => [t, i]))
  const outTiles = list.map((t) => {
    if (!affectedSet.has(t)) return t
    const heights = t.terrain.heights.slice()
    for (let r = 0; r <= seg; r++) {
      const z = vertZ(t, r)
      for (let c = 0; c <= seg; c++) {
        const v = results.get(keyOf(vertX(t, c), z))
        if (v !== undefined) heights[r * n + c] = v
      }
    }
    return { ...t, terrain: { ...t.terrain, heights } }
  })

  // (C) Border propagation ONLY across genuinely shared world edges: extents
  // edge-coincident in world space (|A.maxX - B.minX| < 1e-6, likewise all four
  // sides) with matching orthogonal extents. The higher tileIndexX, then
  // tileIndexZ, tile's border is canonical on both sides (only the lower-index
  // side is written). Index-adjacent but world-disjoint tiles never touch each
  // other, and a painted tile's border is never fed from a world-disjoint
  // 'neighbor'. Non-affected neighbors are lazily COPIED before being written.
  const copies = new Set(outTiles.filter((t) => affectedSet.has(t)))
  const mutableTile = (t) => {
    const i = outIndex.get(t)
    let cur = outTiles[i]
    if (!copies.has(cur)) {
      cur = { ...cur, terrain: { ...cur.terrain, heights: cur.terrain.heights.slice() } }
      outTiles[i] = cur
      copies.add(cur)
    }
    return cur
  }
  const outOf = (t) => outTiles[outIndex.get(t)] // post-brush copy (or input ref)
  const EPS = 1e-6
  const near = (a, b) => Math.abs(a - b) < EPS
  const extentOf = (t) => ({
    minX: centerX(t) - half, maxX: centerX(t) + half,
    minZ: centerZ(t) - half, maxZ: centerZ(t) + half,
  })
  const idxCmp = (a, b) => (a.tileIndexX - b.tileIndexX) || (a.tileIndexZ - b.tileIndexZ)

  for (const t0 of affected) {
    const e0 = extentOf(t0)
    for (const t of list) {
      if (t === t0) continue
      const e1 = extentOf(t)
      const lo = idxCmp(t0, t) < 0 ? t0 : t // lower-index side gets written
      const hi = lo === t0 ? t : t0
      const loE = extentOf(lo)
      const hiE = extentOf(hi)
      // Vertical shared edge (E/W): X edges coincide, Z extents match.
      if (near(e0.minZ, e1.minZ) && near(e0.maxZ, e1.maxZ) &&
          (near(e0.maxX, e1.minX) || near(e1.maxX, e0.minX))) {
        const loCol = near(loE.maxX, hiE.minX) ? seg : 0 // lo west of hi -> lo east col
        const hiCol = loCol === seg ? 0 : seg
        const loTile = mutableTile(lo)
        const hiHeights = outOf(hi).terrain.heights
        for (let r = 0; r <= seg; r++) loTile.terrain.heights[r * n + loCol] = hiHeights[r * n + hiCol]
      }
      // Horizontal shared edge (N/S): Z edges coincide, X extents match.
      if (near(e0.minX, e1.minX) && near(e0.maxX, e1.maxX) &&
          (near(e0.maxZ, e1.minZ) || near(e1.maxZ, e0.minZ))) {
        const loRow = near(loE.maxZ, hiE.minZ) ? seg : 0 // lo north of hi -> lo south row
        const hiRow = loRow === seg ? 0 : seg
        const loTile = mutableTile(lo)
        const hiHeights = outOf(hi).terrain.heights
        for (let c = 0; c <= seg; c++) loTile.terrain.heights[loRow * n + c] = hiHeights[hiRow * n + c]
      }
    }
  }

  // (D) changedTiles: ONLY tiles whose heights array actually changed — fresh
  // objects carrying fresh arrays.
  const sameH = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b))
  const changedTiles = []
  for (let i = 0; i < list.length; i++) {
    const before = list[i].terrain.heights
    const after = outTiles[i].terrain.heights
    if (after === before) continue
    let diff = before.length !== after.length
    for (let j = 0; !diff && j < before.length; j++) {
      if (!sameH(before[j], after[j])) diff = true
    }
    if (diff) changedTiles.push(outTiles[i])
  }

  return { changed: true, tiles: outTiles, changedTiles }
}
