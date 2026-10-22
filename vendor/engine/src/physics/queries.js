/**
 * P4a T3: overlap queries — pure geometric core.
 *
 * `collectOverlaps` answers "which collider entities' shapes intersect this
 * query shape?" over a caller-supplied candidate id list. Deterministic by
 * construction: candidates are copied + sorted ascending, hits are reported
 * in that order, no Map iteration. Shape-vs-shape tests are delegated to the
 * SAME `shapesOverlap` the pair loop uses (box/sphere/pill mixed) — the query
 * shape is built in world space and every candidate shape comes from the
 * caller's `shapeFor` (the engine's cached, transform-honoring path), so
 * parent-chain world position + local `center` offset + rotation conventions
 * are inherited, not re-derived.
 *
 * POINT queries are degenerate zero-extent boxes flowing through the standard
 * overlap path — the simplest choice, and inclusive of touching boundaries
 * (a point exactly on a face/edge/corner hits; a sphere collider contains the
 * points within its radius of the point, matching "inside or on").
 *
 * MESH-shaped candidates (rotated boxes / 'render' colliders) are tested
 * against their world bounds AABB (buildMeshShape's minX..maxZ) — the same
 * approximation class the broadphase uses for them.
 *
 * Returns [{ id }] — id only; add distance/normal later if a game asks.
 */
import { AABB, Sphere, shapesOverlap, boxVsSphere } from './physics.js'

/**
 * Normalize a position argument: {x,y,z} or [x,y,z] → {x,y,z}.
 * @param {{x?,y?,z?} | number[]} v
 * @param {string} field argument name for error messages
 * @returns {{x: number, y: number, z: number}}
 * @throws TypeError with a field-level message on any non-finite component.
 */
export function readVec3Arg(v, field) {
  if (v === null || v === undefined || typeof v !== 'object') {
    throw new TypeError(`${field} must be {x,y,z} or [x,y,z] (got ${v === null ? 'null' : typeof v})`)
  }
  const comp = (name, val) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new TypeError(`${field}.${name} must be a finite number (got ${val})`)
    }
    return val
  }
  if (Array.isArray(v)) return { x: comp('[0]', v[0]), y: comp('[1]', v[1]), z: comp('[2]', v[2]) }
  return { x: comp('x', v.x), y: comp('y', v.y), z: comp('z', v.z) }
}

/**
 * Generic overlap query core.
 * @param {{
 *   center: {x,y,z},
 *   type: 'sphere' | 'box' | 'point',
 *   params: { radius?: number, halfExtents?: {x,y,z} },
 *   candidates: string[],           // entity ids to test (any order)
 *   shapeFor: (id: string) => object | null,  // positioned collider shape
 *   filter?: (id: string) => boolean,          // optional pre-shape filter
 * }} q
 * @returns {{ id: string }[]} hits, candidates-sorted ascending (id-only)
 */
export function collectOverlaps({ center, type, params, candidates, shapeFor, filter }) {
  const cx = center.x, cy = center.y, cz = center.z
  const isPoint = type === 'point'
  let query
  if (type === 'sphere') {
    query = { kind: 'sphere', sphere: new Sphere(cx, cy, cz, params.radius) }
  } else if (type === 'box' || isPoint) {
    // 'box' uses the given halfExtents; 'point' is a degenerate zero-extent
    // box (inclusive containment through the standard overlap path).
    const h = isPoint ? { x: 0, y: 0, z: 0 } : params.halfExtents
    query = { kind: 'box', box: new AABB(cx, cy, cz, h.x, h.y, h.z) }
  } else {
    throw new TypeError(`unknown query type "${type}" (expected sphere|box|point)`)
  }
  const ids = [...candidates].sort()
  const out = []
  for (const id of ids) {
    if (filter && !filter(id)) continue
    const s = shapeFor(id)
    if (!s) continue
    if (s.kind === 'mesh') {
      // Mesh shapes (rotated boxes / render colliders) carry world bounds —
      // test the bounds AABB (documented approximation).
      if (s.minX === undefined) continue
      const bb = new AABB(
        (s.minX + s.maxX) / 2, (s.minY + s.maxY) / 2, (s.minZ + s.maxZ) / 2,
        (s.maxX - s.minX) / 2, (s.maxY - s.minY) / 2, (s.maxZ - s.minZ) / 2,
      )
      if (query.kind === 'sphere') {
        if (boxVsSphere(bb, query.sphere)) out.push({ id })
      } else if (isPoint ? bb.containsPoint(cx, cy, cz) : query.box.overlaps(bb)) {
        out.push({ id })
      }
    } else if (shapesOverlap(query, s)) {
      out.push({ id })
    }
  }
  return out
}
