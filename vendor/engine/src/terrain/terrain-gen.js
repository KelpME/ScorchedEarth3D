/**
 * Engine — terrain generation math (pure, Node-testable; Phase A: gen + seams).
 *
 * Seeded fractal value noise + two tile generators that emit the engine's
 * terrain heightfield contract: `{ size, segments, heights }` with a full
 * row-major `(segments+1)²` grid (row 0 = `-size/2` Z edge, col 0 = `-size/2`
 * X edge). No three import — usable by editor, engine, and tests alike.
 */

import { normalizeTerrain, terrainVertexCount } from '../render/terrain-math.js'
import { mulberry32 } from '../prng.js'

const NOISE_DEFAULTS = {
  seed: 0,
  frequency: 0.05,
  amplitude: 1,
  octaves: 4,
  lacunarity: 2.0,
  persistence: 0.5,
  minAltitude: 0,
  maxAltitude: 10,
}

/** Lenient numeric fill: finite number or default. */
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const posNum = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}
const alt = (v, d) => {
  const n = Number(v)
  return typeof v !== 'undefined' && !Number.isNaN(n) ? n : d
}

// ---------------------------------------------------------------------------
// Single source of truth for tile size + world-origin math. Every call site
// below routes through these so the world-unit formula lives in exactly one
// place (previously duplicated between generateNoiseTile and tileSpan).
// ---------------------------------------------------------------------------
const DEFAULT_TILE_SIZE = 10
const DEFAULT_SEAM_BAND = 4

/** Lenient tile size: positive finite number, else DEFAULT_TILE_SIZE. */
const tileSizeOf = (size) => posNum(size, DEFAULT_TILE_SIZE)

/** World X of the west (-X) edge of tile column cx at resolved size s. */
const tileWorldX = (cx, s) => num(cx, 0) * s - s / 2

/** World Z of the north (-Z) edge of tile row cz at resolved size s. */
const tileWorldZ = (cz, s) => num(cz, 0) * s - s / 2

/** World-space tolerance for "on the border / coincident with a vertex". */
const SEAM_EPS = 1e-9

/**
 * SLOT IDENTITY of a tile descriptor (which lattice slot it occupies): the
 * index fields tileIndexX/Z (both finite) WIN; `transform.x/z` (both finite)
 * resolves to round(transform/size) only for transform-only entries. World
 * PLACEMENT for seam sampling is a separate, transform-first concern and lives
 * inline in generateSeamMatchedTile — do not unify the two.
 */
function tileIndexOf(entry, s) {
  const ix = entry && entry.tileIndexX
  const iz = entry && entry.tileIndexZ
  if (Number.isFinite(Number(ix)) && Number.isFinite(Number(iz))) {
    return { cx: Number(ix), cz: Number(iz) }
  }
  const t = entry && entry.transform
  if (t && Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.z))) {
    return { cx: Math.round(Number(t.x) / s), cz: Math.round(Number(t.z) / s) }
  }
  return { cx: num(ix, 0), cz: num(iz, 0) }
}

/**
 * Fill noise option defaults. Clamps `octaves` to an integer in 1..8; forces
 * amplitude/lacunarity/persistence finite and > 0 (default fallback). Lenient —
 * never throws.
 * @returns {{seed:number, frequency:number, amplitude:number, octaves:number,
 *   lacunarity:number, persistence:number, minAltitude:number, maxAltitude:number}}
 */
export function normalizeNoiseOpts(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {}
  let octaves = Math.floor(num(o.octaves, NOISE_DEFAULTS.octaves))
  if (octaves < 1) octaves = 1
  if (octaves > 8) octaves = 8
  return {
    seed: Number.isFinite(Number(o.seed)) ? Number(o.seed) : NOISE_DEFAULTS.seed,
    frequency: posNum(o.frequency, NOISE_DEFAULTS.frequency),
    amplitude: posNum(o.amplitude, NOISE_DEFAULTS.amplitude),
    octaves,
    lacunarity: posNum(o.lacunarity, NOISE_DEFAULTS.lacunarity),
    persistence: posNum(o.persistence, NOISE_DEFAULTS.persistence),
    minAltitude: alt(o.minAltitude, NOISE_DEFAULTS.minAltitude),
    maxAltitude: alt(o.maxAltitude, NOISE_DEFAULTS.maxAltitude),
  }
}

/** Pure integer hash of (seed, ix, iz) -> [0, 1). Deterministic across runs. */
function hash2(seed, ix, iz) {
  let h = (seed | 0) ^ Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Smoothstep fade within a lattice cell. */
const fade = (t) => t * t * (3 - 2 * t)

// Octave subfield seeding constants (murmur3 finalizer multipliers + golden-
// ratio salt). Additive `seed + i * SALT` derivation collided for seeds
// differing by a multiple of the salt; multiplicative mixing decorrelates.
const OCTAVE_MIX_A = 0x85ebca6b
const OCTAVE_MIX_B = 0xc2b2ae35
const OCTAVE_SEED_SALT = 0x9e3779b9

/** Deterministically mix (seed, octave index) into a lattice seed. */
function octaveSeed(seed, i) {
  let h = (Math.imul(seed | 0, OCTAVE_MIX_A) ^ Math.imul(i + 1, OCTAVE_MIX_B)) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, OCTAVE_SEED_SALT)
  h ^= h >>> 13
  return h | 0
}

/**
 * Deterministic fractal value noise at world (wx, wz). Per octave i: lattice
 * spacing scaled by `frequency * lacunarity^i`, amplitude scaled by
 * `amplitude * persistence^i`; cell values from hash2(seed, ix, iz), bilinearly
 * interpolated with a smooth fade. The final sum is CLAMPED to
 * [minAltitude, maxAltitude].
 * @param {number} wx  world X.
 * @param {number} wz  world Z.
 * @param {object} [opts]  see normalizeNoiseOpts defaults.
 * @returns {number} clamped noise height.
 */
export function valueNoiseHeight(wx, wz, opts = {}) {
  const o = normalizeNoiseOpts(opts)
  let sum = 0
  for (let i = 0; i < o.octaves; i++) {
    const freq = o.frequency * Math.pow(o.lacunarity, i)
    const amp = o.amplitude * Math.pow(o.persistence, i)
    const sx = wx * freq
    const sz = wz * freq
    const x0 = Math.floor(sx), z0 = Math.floor(sz)
    const fx = fade(sx - x0), fz = fade(sz - z0)
    // Lattice values in [0,1) -> centered to [-1,1] so octaves sum around 0.
    const lseed = octaveSeed(o.seed, i)
    const v00 = hash2(lseed, x0, z0) * 2 - 1
    const v10 = hash2(lseed, x0 + 1, z0) * 2 - 1
    const v01 = hash2(lseed, x0, z0 + 1) * 2 - 1
    const v11 = hash2(lseed, x0 + 1, z0 + 1) * 2 - 1
    const top = v00 + (v10 - v00) * fx
    const bot = v01 + (v11 - v01) * fx
    sum += (top + (bot - top) * fz) * amp
  }
  return Math.min(o.maxAltitude, Math.max(o.minAltitude, sum))
}

/**
 * Random-elevation tile: a deterministic low-frequency field (single octave)
 * centered near `baseHeight` plus a seeded per-tile offset, amplitude ±jitter.
 * @param {object} p  { size, segments, seed, baseHeight=0, jitter=1.5,
 *   minAltitude=-Infinity, maxAltitude=Infinity }
 * @returns {{size:number, segments:number, heights:number[]}} full row-major grid.
 */
export function generateRandomTile({ size, segments, seed, baseHeight = 0, jitter = 1.5, minAltitude = -Infinity, maxAltitude = Infinity } = {}) {
  const seg = terrainVertexCount(segments) - 1
  const s = tileSizeOf(size)
  const j = posNum(jitter, 1.5)
  // Seeded per-tile offset (mulberry32 PRNG), leaving headroom so the
  // total stays within baseHeight ± jitter before clamping.
  const rng = mulberry32(Number.isFinite(Number(seed)) ? Number(seed) : 0)
  const offset = (rng() * 2 - 1) * j * 0.5
  const fieldAmp = Math.max(0, j - Math.abs(offset))
  const step = s / seg
  const heights = []
  for (let r = 0; r <= seg; r++) {
    for (let c = 0; c <= seg; c++) {
      const wx = -s / 2 + c * step
      const wz = -s / 2 + r * step
      const n = valueNoiseHeight(wx, wz, {
        seed: Number.isFinite(Number(seed)) ? Number(seed) : 0,
        frequency: 0.02,
        amplitude: fieldAmp,
        octaves: 1,
        minAltitude: -fieldAmp,
        maxAltitude: fieldAmp,
      })
      const h = num(baseHeight, 0) + offset + n
      heights.push(Math.min(maxAltitude, Math.max(minAltitude, h)))
    }
  }
  return normalizeTerrain({ size: s, segments: seg, heights })
}

/**
 * Noise tile: samples valueNoiseHeight at every grid vertex WORLD position.
 * Tile (tileIndexX, tileIndexZ) spans [tileIndex*size - size/2, ... +size];
 * col c -> x = tileIndexX*size - size/2 + c*(size/segments), row r -> z
 * likewise (row 0 = -size/2 Z edge, col 0 = -size/2 X edge). heightOffset = 0.
 * @param {object} p  { size, segments, tileIndexX, tileIndexZ, seed, ...noiseOpts }
 * @returns {{size:number, segments:number, heights:number[]}} full row-major grid.
 */
export function generateNoiseTile({ size, segments, tileIndexX = 0, tileIndexZ = 0, seed, ...noiseOpts } = {}) {
  const seg = terrainVertexCount(segments) - 1
  const s = tileSizeOf(size)
  const opts = normalizeNoiseOpts({ ...noiseOpts, seed })
  const step = s / seg
  const heights = []
  for (let r = 0; r <= seg; r++) {
    for (let c = 0; c <= seg; c++) {
      const wx = tileWorldX(tileIndexX, s) + c * step
      const wz = tileWorldZ(tileIndexZ, s) + r * step
      heights.push(valueNoiseHeight(wx, wz, opts))
    }
  }
  return normalizeTerrain({ size: s, segments: seg, heights })
}

/**
 * World-space extent of tile (cx, cz): centered at (cx*size, cz*size), so
 * `minX = cx*size - size/2` ... `maxZ = cz*size + size/2`. Contiguous tiles
 * share edges exactly (tileSpan(cx+1).minX === tileSpan(cx).maxX).
 * @returns {{minX:number, maxX:number, minZ:number, maxZ:number}}
 */
export function tileSpan(cx, cz, size) {
  const s = tileSizeOf(size)
  // Same origin math as generateNoiseTile: minX/maxX straddle tileWorldX(cx).
  const x = num(cx, 0) * s
  const z = num(cz, 0) * s
  return { minX: tileWorldX(cx, s), maxX: x + s / 2, minZ: tileWorldZ(cz, s), maxZ: z + s / 2 }
}

/**
 * Map a WORLD grid vertex (WX, WZ) — where local (r, c) of tile (cx, cz) is
 * WX = cx*segments + c, WZ = cz*segments + r — to this tile's local { r, c }.
 * Returns null when outside the tile's grid footprint
 * [cx*segments .. cx*segments+segments] x same for Z, or when WX/WZ are not
 * finite integers (grid vertices live on integer world coordinates).
 * @returns {{r:number, c:number}|null}
 */
export function worldVertexToLocal(tileIndexX, tileIndexZ, segments, WX, WZ) {
  const seg = terrainVertexCount(segments) - 1
  const c = num(WX, NaN) - num(tileIndexX, 0) * seg
  const r = num(WZ, NaN) - num(tileIndexZ, 0) * seg
  if (!Number.isFinite(r) || !Number.isFinite(c)) return null
  if (!Number.isInteger(r) || !Number.isInteger(c)) return null
  if (c < 0 || c > seg || r < 0 || r > seg) return null
  return { r, c }
}

/**
 * Neighbor height AT a world point on the neighbor's border polyline: the exact
 * grid-vertex height when the point coincides with a neighbor grid vertex
 * (within SEAM_EPS per world axis), else LINEAR interpolation along the
 * neighbor's border row/column the point sits on. `step` is the neighbor's
 * grid spacing (size/segments), `minX/minZ` its west/north edge.
 */
function borderHeightAt(heights, nseg, minX, minZ, step, wx, wz) {
  const nn = nseg + 1
  const fc = (wx - minX) / step
  const fr = (wz - minZ) / step
  const rc = Math.round(fc)
  const rr = Math.round(fr)
  if (rr >= 0 && rr <= nseg && rc >= 0 && rc <= nseg &&
      Math.abs(fr - rr) * step <= SEAM_EPS && Math.abs(fc - rc) * step <= SEAM_EPS) {
    return Number(heights[rr * nn + rc])
  }
  const clamp = (v) => Math.min(nseg, Math.max(0, v))
  const onCol = Math.abs(fc) <= SEAM_EPS / step || Math.abs(fc - nseg) <= SEAM_EPS / step
  if (onCol) {
    // West/east border column -> interpolate between the bracketing rows.
    const cn = Math.abs(fc) <= SEAM_EPS / step ? 0 : nseg
    const f = clamp(fr)
    const r0 = Math.min(Math.floor(f), nseg - 1)
    const h0 = Number(heights[r0 * nn + cn])
    const h1 = Number(heights[(r0 + 1) * nn + cn])
    return h0 + (h1 - h0) * (f - r0)
  }
  // North/south border row -> interpolate between the bracketing columns.
  const rn = Math.abs(fr) <= SEAM_EPS / step ? 0 : nseg
  const f = clamp(fc)
  const c0 = Math.min(Math.floor(f), nseg - 1)
  const h0 = Number(heights[rn * nn + c0])
  const h1 = Number(heights[rn * nn + c0 + 1])
  return h0 + (h1 - h0) * (f - c0)
}

/**
 * Seam-matched noise tile: the pure `generateNoiseTile` field with every grid
 * vertex that lies on a shared world edge with an EXISTING neighbor PINNED to
 * the neighbor's height at that same world vertex (watertightness), blended
 * inward over `seamBand` grid cells with smoothstep falloff:
 * w = t*t*(3-2t), t = clamp(d/seamBand, 0, 1), d = Chebyshev cell distance to
 * the nearest pinned border; height = pinnedH*(1-w) + noiseH*w. At d=0 the
 * height is exactly the neighbor's; at d >= seamBand it is pure noise. With
 * `seamBand <= 0` there is no blend band: shared vertices are HARD-PINNED to
 * the neighbor's exact height and every other vertex stays pure noise.
 *
 * Side convention (from world grid math, matching the row-major contract where
 * row 0 is the -size/2 Z edge): east = cx+1, west = cx-1, NORTH = cz-1 (world
 * -Z), SOUTH = cz+1 (world +Z); diagonals likewise (ne = cx+1,cz-1 etc.).
 * Pinning itself ignores side names: each neighbor's shared vertex set is the
 * overlap of both extents' border polylines in WORLD space, so tiles with
 * DIFFERENT segment counts seam-match watertight. A shared vertex takes the
 * neighbor's border height AT its world position — the exact neighbor vertex
 * height within 1e-9, else linear interpolation along the neighbor's border
 * row/column. Neighbor placement: `transform: {x, z}` (both finite) centers
 * the neighbor at (x, z) with extent ±size/2; else the index convention.
 * Diagonal neighbors share a single corner vertex — pinned exactly,
 * no inward blend. Vertices with no existing neighbor stay pure noise.
 * @param {object} p  { size, segments, tileIndexX, tileIndexZ, seed, seamBand=4, ...noiseOpts }
 * @param {Array<{side?:string, tileIndexX:number, tileIndexZ:number, size:number, segments:number, heights:number[]}>} [neighbors]
 * @returns {{size:number, segments:number, heights:number[]}} full row-major grid.
 */
export function generateSeamMatchedTile({ size, segments, tileIndexX = 0, tileIndexZ = 0, seed, seamBand = DEFAULT_SEAM_BAND, ...noiseOpts } = {}, neighbors = []) {
  const seg = terrainVertexCount(segments) - 1
  const s = tileSizeOf(size)
  const cx = num(tileIndexX, 0)
  const cz = num(tileIndexZ, 0)
  const pure = generateNoiseTile({ size: s, segments: seg, tileIndexX: cx, tileIndexZ: cz, seed, ...noiseOpts })
  const n = seg + 1
  let band = Number(seamBand)
  if (!Number.isFinite(band) || band < 0) band = DEFAULT_SEAM_BAND

  // Shared vertex sets per neighbor, derived WORLD-position based: the shared
  // edge is the overlap of both extents' border polylines; each of our grid
  // vertices on it takes the neighbor's border height AT that world position
  // (exact grid-vertex height within SEAM_EPS, else linear interpolation along
  // the neighbor's border row/column). Neighbor placement: `transform.x/z`
  // (both finite) centers the neighbor at (x, z); else the index convention.
  const step = s / seg
  const edgePins = [] // { shared: [{r, c, h}] } — contributes a blend field
  const cornerPins = [] // single-vertex pins (diagonals): exact override only
  for (const nb of Array.isArray(neighbors) ? neighbors : []) {
    if (!nb || !Array.isArray(nb.heights)) continue
    const sNb = posNum(nb.size, s)
    const nseg = terrainVertexCount(nb.segments) - 1
    const tn = nb.transform
    const useTransform = tn && Number.isFinite(Number(tn.x)) && Number.isFinite(Number(tn.z))
    const ncx = useTransform ? Number(tn.x) : num(nb.tileIndexX, 0) * sNb
    const ncz = useTransform ? Number(tn.z) : num(nb.tileIndexZ, 0) * sNb
    const nbMinX = ncx - sNb / 2
    const nbMaxX = ncx + sNb / 2
    const nbMinZ = ncz - sNb / 2
    const nbMaxZ = ncz + sNb / 2
    const stepNb = sNb / nseg
    const shared = []
    for (let r = 0; r <= seg; r++) {
      for (let c = 0; c <= seg; c++) {
        // Only our border can sit on the shared world edge.
        if (r !== 0 && r !== seg && c !== 0 && c !== seg) continue
        const wx = tileWorldX(cx, s) + c * step
        const wz = tileWorldZ(cz, s) + r * step
        const onX = Math.abs(wx - nbMinX) <= SEAM_EPS || Math.abs(wx - nbMaxX) <= SEAM_EPS
        const onZ = Math.abs(wz - nbMinZ) <= SEAM_EPS || Math.abs(wz - nbMaxZ) <= SEAM_EPS
        const inX = wx >= nbMinX - SEAM_EPS && wx <= nbMaxX + SEAM_EPS
        const inZ = wz >= nbMinZ - SEAM_EPS && wz <= nbMaxZ + SEAM_EPS
        if (!((onX && inZ) || (onZ && inX))) continue // off the neighbor's border polyline
        const h = borderHeightAt(nb.heights, nseg, nbMinX, nbMinZ, stepNb, wx, wz)
        if (Number.isFinite(h)) shared.push({ r, c, h })
      }
    }
    if (!shared.length) continue
    // An edge neighbor shares a full row/column; a diagonal shares one vertex.
    const spansRows = new Set(shared.map((v) => v.r)).size > 1
    const spansCols = new Set(shared.map((v) => v.c)).size > 1
    if (shared.length === 1 || (!spansRows && !spansCols)) cornerPins.push(shared[0])
    else edgePins.push({ shared })
  }

  const heights = pure.heights.slice()
  for (let r = 0; r <= seg; r++) {
    for (let c = 0; c <= seg; c++) {
      let bestD = Infinity
      let pinnedH = null
      for (const pin of edgePins) {
        // Chebyshev distance to the shared set + height of its nearest vertex.
        for (const v of pin.shared) {
          const d = Math.max(Math.abs(r - v.r), Math.abs(c - v.c))
          if (d < bestD) { bestD = d; pinnedH = v.h }
        }
      }
      if (pinnedH === null) continue // no shared pin -> pure noise untouched
      const i = r * n + c
      if (band <= 0) {
        // seamBand <= 0: hard-pin-no-blend — a vertex sharing a pinned world
        // vertex gets the EXACT neighbor height; everything else stays noise.
        if (bestD === 0) heights[i] = pinnedH
        continue
      }
      if (bestD >= band) continue // pure noise untouched
      const t = Math.min(1, Math.max(0, bestD / band))
      const w = t * t * (3 - 2 * t)
      if (w <= 0) heights[i] = pinnedH
      else if (w >= 1) heights[i] = pure.heights[i]
      else heights[i] = pinnedH * (1 - w) + pure.heights[i] * w
    }
  }
  // Diagonal corners: exact pin, applied last (same world vertex -> same value).
  for (const v of cornerPins) heights[v.r * n + v.c] = v.h
  return normalizeTerrain({ size: s, segments: seg, heights })
}

/**
 * Mass-append driver: `count` tiles laid along `dir` ('N' = cz-1 step, 'S' =
 * cz+1, 'E' = cx+1, 'W' = cx-1) starting at (startTileIndexX, startTileIndexZ),
 * each generated via `generateSeamMatchedTile` against existingTiles UNION the
 * row's own earlier tiles — internally seam-matched AND seams to the world.
 * Slots already occupied by an existingTiles entry are SKIPPED — never
 * generated, never emitted — and the run continues past them along `dir`.
 * Slot identity is index-first: tileIndexX/Z (both finite) name the slot;
 * `transform.x/z` only resolves via round(transform/size) for transform-only
 * entries. Inputs are never mutated.
 * @param {object} p  { size, segments, seed, startTileIndexX, startTileIndexZ, dir, count, ...noiseOpts }
 * @param {Array<{tileIndexX:number, tileIndexZ:number, size:number, segments:number, heights:number[]}>} [existingTiles]
 * @returns {Array<{tileIndexX:number, tileIndexZ:number, terrain:{size:number, segments:number, heights:number[]}}>}
 */
export function generateRow({ size, segments, seed, startTileIndexX = 0, startTileIndexZ = 0, dir = 'E', count = 1, ...noiseOpts } = {}, existingTiles = []) {
  const stepByDir = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }
  const [dx, dz] = stepByDir[String(dir).toUpperCase()] || stepByDir.E
  const pool = Array.isArray(existingTiles) ? existingTiles.slice() : []
  const s = tileSizeOf(size)
  const occupied = new Set(pool.map((t) => {
    const { cx, cz } = tileIndexOf(t, s)
    return `${cx},${cz}`
  }))
  const out = []
  const total = Math.max(0, Math.floor(num(count, 1)))
  // Each occupied slot consumes at most one step; the bound stops runaways.
  for (let i = 0; out.length < total && i < total + occupied.size; i++) {
    const cx = num(startTileIndexX, 0) + dx * i
    const cz = num(startTileIndexZ, 0) + dz * i
    if (occupied.has(`${cx},${cz}`)) continue // occupied slot: never generated
    const terrain = generateSeamMatchedTile({ size, segments, tileIndexX: cx, tileIndexZ: cz, seed, ...noiseOpts }, pool)
    out.push({ tileIndexX: cx, tileIndexZ: cz, terrain })
    pool.push({ tileIndexX: cx, tileIndexZ: cz, size: terrain.size, segments: terrain.segments, heights: terrain.heights })
  }
  return out
}

/**
 * Free lattice slots orthogonally edge-adjacent to >= 1 tile. Slot identity is
 * index-first: tileIndexX/tileIndexZ (both finite) name the slot; transform-only
 * entries resolve via round(transform/size). Occupied slots are never returned;
 * with no tiles the answer is `[{cx: 0, cz: 0}]`. Deterministic order: sorted by
 * cz, then cx.
 * @param {{tiles?: Array<object>, size?: number}} [p]
 * @returns {Array<{cx:number, cz:number}>}
 */
export function adjacentFreeSlots({ tiles, size } = {}) {
  const s = tileSizeOf(size)
  const occupied = new Set()
  for (const t of Array.isArray(tiles) ? tiles : []) {
    if (!t) continue
    const { cx, cz } = tileIndexOf(t, s)
    occupied.add(`${cx},${cz}`)
  }
  if (!occupied.size) return [{ cx: 0, cz: 0 }]
  const free = new Map()
  for (const key of occupied) {
    const [cx, cz] = key.split(',').map(Number)
    for (const [dx, dz] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
      const k = `${cx + dx},${cz + dz}`
      if (!occupied.has(k)) free.set(k, { cx: cx + dx, cz: cz + dz })
    }
  }
  return [...free.values()].sort((a, b) => (a.cz - b.cz) || (a.cx - b.cx))
}
