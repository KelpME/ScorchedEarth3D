/**
 * Engine — terrain heightfield math (pure, Node-testable).
 *
 * The `terrain` component carries a square heightfield grid: `{ size, segments,
 * heights[] }`. `size` is the width/depth of the square, `segments` is the grid
 * resolution (segments per side -> `(segments+1)²` grid vertices), and `heights`
 * is a row-major array of vertex heights over that grid (row 0 = the `-size/2`
 * edge in Z, column 0 = the `-size/2` edge in X). Missing heights default to 0
 * (flat ground). The terrain is CENTERED on its entity's transform.
 *
 * This module is the pure heightfield surface: sampling (bilinear interpolation,
 * so an entity can rest on a sloped terrain), local-frame triangle generation
 * (for the real-mesh collider), and validation. No three import — fully
 * unit-testable under Node and usable by physics + the renderer alike.
 */

/** The row-major grid point count per side for a terrain. */
export function terrainVertexCount(segments) {
  return Math.max(1, Math.floor(segments) || 1) + 1
}

/** Normalize a terrain component: fill size/segments defaults and pad `heights`
 *  to the full `(segments+1)²` grid (missing entries -> 0). Returns a NEW
 *  normalized object (does not mutate the input). Lenient — never throws. */
export function normalizeTerrain(terrain = {}) {
  const size = Number(terrain.size) > 0 ? Number(terrain.size) : 10
  const segments = Number.isInteger(Number(terrain.segments)) && Number(terrain.segments) > 0
    ? Math.floor(Number(terrain.segments))
    : 8
  const n = terrainVertexCount(segments)
  const src = Array.isArray(terrain.heights) ? terrain.heights : []
  const heights = new Array(n * n).fill(0)
  for (let i = 0; i < src.length && i < heights.length; i++) {
    const v = Number(src[i])
    heights[i] = Number.isFinite(v) ? v : 0
  }
  return { size, segments, heights }
}

/**
 * The height at a world-LOCAL (x, z) point (centered on the terrain's origin),
 * via bilinear interpolation of the surrounding 4 grid vertices. Points outside
 * the terrain's extent -> 0 (the surrounding ground). Used so a body can rest on
 * a sloped/curved terrain, not just a flat plane.
 * @param {object} terrain  a normalized terrain component.
 * @param {number} x  local X (in -size/2..size/2).
 * @param {number} z  local Z (in -size/2..size/2).
 * @returns {number}  interpolated height.
 */
export function sampleTerrainHeight(terrain, x, z) {
  const { size, segments, heights } = terrain
  const n = terrainVertexCount(segments)
  // Grid coordinates in [0, segments].
  const gx = (x + size / 2) / size * segments
  const gz = (z + size / 2) / size * segments
  if (gx <= 0 || gz <= 0 || gx >= segments || gz >= segments) return 0
  const x0 = Math.floor(gx), z0 = Math.floor(gz)
  const fx = gx - x0, fz = gz - z0
  const h00 = heights[z0 * n + x0]
  const h10 = heights[z0 * n + (x0 + 1)]
  const h01 = heights[(z0 + 1) * n + x0]
  const h11 = heights[(z0 + 1) * n + (x0 + 1)]
  // Bilinear: top row (z0) then bottom row (z0+1), then blend by fz.
  const top = h00 + (h10 - h00) * fx
  const bot = h01 + (h11 - h01) * fx
  return top + (bot - top) * fz
}

/**
 * The LOCAL-FRAME triangle list for a terrain (centered on its origin), each
 * `{ ax,ay,az, bx,by,bz, cx,cy,cz }`. 2 triangles per grid cell. This is what
 * the real-mesh collider uses so an entity can walk on the actual surface.
 * @param {object} terrain  a normalized terrain component.
 * @returns {Array<object>} triangle list (empty if degenerately small).
 */
export function buildTerrainTriangles(terrain) {
  const { size, segments, heights } = terrain
  const n = terrainVertexCount(segments)
  const half = size / 2
  const tris = []
  // Grid point (r, c): world-local X = -half + c*step, Z = -half + r*step.
  const step = size / segments
  const at = (r, c) => heights[r * n + c]
  for (let r = 0; r < segments; r++) {
    for (let c = 0; c < segments; c++) {
      const x0 = -half + c * step
      const x1 = x0 + step
      const z0 = -half + r * step
      const z1 = z0 + step
      const y00 = at(r, c)
      const y10 = at(r, c + 1)
      const y01 = at(r + 1, c)
      const y11 = at(r + 1, c + 1)
      tris.push(
        { ax: x0, ay: y00, az: z0, bx: x1, by: y10, bz: z0, cx: x1, cy: y11, cz: z1 },
        { ax: x0, ay: y00, az: z0, bx: x1, by: y11, bz: z1, cx: x0, cy: y01, cz: z1 },
      )
    }
  }
  return tris
}

/**
 * Sample the terrain SURFACE under a WORLD point, honoring the terrain
 * entity's transform (position + Y rotation + uniform scale). This is the
 * function brushes/placers must use: `sampleTerrainHeight` alone samples the
 * LOCAL frame (centered, unrotated, unscaled), which only matches the world
 * when the terrain entity sits at the origin with identity transform.
 *
 * Contract (mirrors how the renderer positions the terrain mesh — transform
 * scale applies to the heightfield extents AND its heights):
 *   local = R_y(-θ) · (world - position) / s      (uniform scale s)
 *   heightLocal = sampleTerrainHeight(terrain, lx, lz)   (bilinear)
 *   worldY = position.y + heightLocal * s
 *
 * The surface normal is derived from local finite differences of the
 * heightfield (Δ = cellSize/s in world terms is NOT needed — the normal is
 * scale-invariant for uniform scaling), then rotated by the terrain's yaw.
 * `slopeDeg` is the angle between the normal and world-up (0 = flat).
 *
 * @param {object} terrain          the terrain component (normalized or raw).
 * @param {object} [transform]      the terrain entity's transform { x, y, z,
 *                                  rot?: { y }, scale? } — defaults to origin.
 * @param {number} wx                world X.
 * @param {number} wz                world Z.
 * @returns {{ y: number, nx: number, ny: number, nz: number, slopeDeg: number,
 *           inside: boolean }} `inside` is false when the world point falls
 *          outside the terrain's footprint (y falls back to transform.y).
 */
export function sampleTerrainSurface(terrain, transform, wx, wz) {
  const norm = normalizeTerrain(terrain)
  const t = transform && typeof transform === 'object' ? transform : {}
  const px = Number.isFinite(t.x) ? t.x : 0
  const py = Number.isFinite(t.y) ? t.y : 0
  const pz = Number.isFinite(t.z) ? t.z : 0
  const rot = t.rot && typeof t.rot === 'object' ? t.rot : {}
  const theta = Number.isFinite(rot.y) ? rot.y : 0
  const scale = normalizeScale(t.scale)

  // World -> local: translate, inverse scale, inverse Y-rotation.
  // THREE's forward map (Euler y=θ) sends local (x,z) to world
  // (x·cosθ + z·sinθ, −x·sinθ + z·cosθ); the inverse of that is
  // lx = dx·cosθ − dz·sinθ ; lz = dx·sinθ + dz·cosθ.
  const dx = (wx - px) / scale
  const dz = (wz - pz) / scale
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const lx = dx * cos - dz * sin
  const lz = dx * sin + dz * cos

  const half = norm.size / 2
  const inside = lx >= -half && lx <= half && lz >= -half && lz <= half
  const hLocal = sampleTerrainHeight(norm, lx, lz)
  const y = py + hLocal * scale

  // Local-frame normal from central differences (one cell step). Sample coords
  // are CLAMPED to the terrain extent (minus an epsilon: the height sampler's
  // outside-contract excludes the exact boundary, so a raw clamp to ±half would
  // still read 0 and fake a slope within one cell of any edge — clamp-to-edge
  // is the standard heightfield-normal treatment).
  const step = norm.size / norm.segments
  const cl = (v) => Math.max(-half + 1e-6, Math.min(half - 1e-6, v))
  const hx = sampleTerrainHeight(norm, cl(lx + step), lz) - sampleTerrainHeight(norm, cl(lx - step), lz)
  const hz = sampleTerrainHeight(norm, lx, cl(lz + step)) - sampleTerrainHeight(norm, lx, cl(lz - step))
  // Local surface tangent vectors: T_x = (2*step, hx, 0), T_z = (0, hz, 2*step).
  // Normal = T_z × T_x  →  (-hx*2step, 4*step², -hz*2step) → normalize.
  let nx = -hx / (2 * step)
  let ny = 1
  let nz = -hz / (2 * step)
  const len = Math.hypot(nx, ny, nz) || 1
  nx /= len; ny /= len; nz /= len
  // Rotate the normal by the terrain's yaw into the world frame.
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const wnx = nx * c + nz * s
  const wnz = -nx * s + nz * c
  const slopeDeg = Math.acos(Math.max(-1, Math.min(1, ny))) * 180 / Math.PI

  return { y, nx: wnx, ny, nz: wnz, slopeDeg, inside }
}

/** Normalize a transform scale to a uniform positive number (default 1). */
export function normalizeScale(s) {
  if (typeof s === 'number' && Number.isFinite(s) && s > 0) return s
  if (Array.isArray(s)) {
    const v = Number(s[0])
    return Number.isFinite(v) && v > 0 ? v : 1
  }
  if (s && typeof s === 'object') {
    const v = Number(s.x)
    return Number.isFinite(v) && v > 0 ? v : 1
  }
  return 1
}

/**
 * Validate a terrain component against the authoring contract. Returns [] when
 * valid (or when `terrain` is undefined). `heights` may be shorter than the
 * grid (missing -> 0) but every present value must be a finite number, and the
 * grid cannot be absurdly large.
 * @param {object|undefined} terrain
 * @returns {Array<string>} human-readable errors, [] when valid.
 */
export function validateTerrain(terrain) {
  const errors = []
  if (terrain === undefined) return errors
  if (!terrain || typeof terrain !== 'object') {
    errors.push('terrain must be an object')
    return errors
  }
  if (terrain.size !== undefined && (!Number.isFinite(Number(terrain.size)) || Number(terrain.size) <= 0)) {
    errors.push('terrain.size must be a positive number')
  }
  if (terrain.segments !== undefined && (!Number.isInteger(Number(terrain.segments)) || Number(terrain.segments) < 1)) {
    errors.push('terrain.segments must be a positive integer')
  } else {
    const seg = terrain.segments === undefined ? 8 : Number(terrain.segments)
    if (seg > 256) errors.push(`terrain.segments is too large (${seg} > 256)`)
  }
  if (terrain.heights !== undefined && !Array.isArray(terrain.heights)) {
    errors.push('terrain.heights must be an array')
  } else if (Array.isArray(terrain.heights)) {
    const seg = terrain.segments === undefined ? 8 : Number(terrain.segments)
    const max = (seg + 1) * (seg + 1)
    if (terrain.heights.length > max) errors.push(`terrain.heights has ${terrain.heights.length} entries (max ${max} for segments=${seg})`)
    for (let i = 0; i < terrain.heights.length; i++) {
      if (!Number.isFinite(Number(terrain.heights[i]))) errors.push(`terrain.heights[${i}] must be a number`)
    }
  }
  return errors
}
