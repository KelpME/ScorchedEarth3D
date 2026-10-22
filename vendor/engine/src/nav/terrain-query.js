/**
 * World-side terrain sampling for height-aware nav (Phase P2.5 W3). Thin
 * adapter over the PURE heightfield math in render/terrain-math.js — all
 * interpolation/validation lives there (never reimplemented here); this
 * module only answers "which terrain entity covers this world point" for a
 * world/api bundle ({ query, entity, getParent? } — the World and the game
 * api both qualify).
 *
 * Determinism: terrain entities are iterated in STABLE sorted id order and
 * the FIRST surface whose footprint covers the point wins (multiple terrains:
 * sample whichever covers the cell). No terrain covers the point -> height 0,
 * slope 0 (flat behavior preserved).
 */
import { sampleTerrainSurface, normalizeScale } from '../render/terrain-math.js'

/** Parent-chain-resolved WORLD transform of a terrain entity. */
function worldTransformOf(bundle, id, rec) {
  const own = (rec && rec.components && rec.components.transform) || {}
  let x = 0, y = 0, z = 0
  let cur = id
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const r = cur === id ? rec : (typeof bundle.entity === 'function' ? bundle.entity(cur) : null)
    const t = (r && r.components && r.components.transform) || {}
    x += Number.isFinite(t.x) ? t.x : 0
    y += Number.isFinite(t.y) ? t.y : 0
    z += Number.isFinite(t.z) ? t.z : 0
    const parent = typeof bundle.getParent === 'function' ? bundle.getParent(cur) : (r && r.parent)
    if (parent === undefined || parent === null || parent === cur) break
    cur = parent
  }
  return {
    x, y, z,
    rot: own.rot && typeof own.rot === 'object' ? { ...own.rot } : undefined,
    scale: own.scale,
  }
}

/**
 * Every terrain surface in the bundle: [{ id, terrain, transform }] in
 * stable sorted id order. Empty when the bundle has no query seam (stubs).
 */
export function collectTerrainSurfaces(bundle) {
  if (!bundle || typeof bundle.query !== 'function' || typeof bundle.entity !== 'function') return []
  let ids = []
  try { ids = [...bundle.query({ has: ['terrain'] })] } catch { return [] }
  ids.sort()
  const out = []
  for (const id of ids) {
    const rec = bundle.entity(id)
    const comps = (rec && rec.components) || {}
    if (!comps.terrain) continue
    out.push({ id, terrain: comps.terrain, transform: worldTransformOf(bundle, id, rec) })
  }
  return out
}

/**
 * Sample the FIRST covering terrain surface at a world point:
 * { y, nx, ny, nz, slopeDeg, inside } — `inside: false` (y 0, slope 0) when
 * no terrain covers the point.
 */
export function sampleSurfaces(surfaces, x, z) {
  for (const s of surfaces || []) {
    const r = sampleTerrainSurface(s.terrain, s.transform, x, z)
    if (r.inside) return r
  }
  return { y: 0, nx: 0, ny: 1, nz: 0, slopeDeg: 0, inside: false }
}

/** World height at a point: the covering terrain surface, else 0. */
export function heightAtSurfaces(surfaces, x, z) {
  const r = sampleSurfaces(surfaces, x, z)
  return r.inside ? r.y : 0
}

/**
 * The XZ AABB of one terrain surface's footprint (size · uniform scale,
 * rotated by the entity's yaw) — what derived nav bounds must cover.
 */
export function terrainFootprintXZ(entry) {
  const t = (entry && entry.transform) || {}
  const raw = Number(entry && entry.terrain && entry.terrain.size)
  const size = raw > 0 ? raw : 10
  const half = (size / 2) * normalizeScale(t.scale)
  const theta = t.rot && Number.isFinite(t.rot.y) ? t.rot.y : 0
  const ext = half * (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta)))
  const px = Number.isFinite(t.x) ? t.x : 0
  const pz = Number.isFinite(t.z) ? t.z : 0
  return { minX: px - ext, maxX: px + ext, minZ: pz - ext, maxZ: pz + ext }
}
