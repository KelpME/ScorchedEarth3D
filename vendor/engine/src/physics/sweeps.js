/**
 * P4b-1 — shape sweeps (pure math, deterministic).
 *
 * `sweepShape(shape, delta, candidates, shapeFor?)` casts a shape along a
 * delta vector and returns the NEAREST first-contact hit — the primitive the
 * character controller and (P4d) projectiles move by. Sweeps are casts, not
 * teleports: a body moving by sweep-and-slide cannot tunnel.
 *
 * Method (per candidate, conservative advancement on an inflated proxy):
 *   - The moving shape's position along the delta is parameterized t ∈ [0, 1]
 *     (t·delta). First contact vs a candidate is found by raycasting the
 *     center ray against the candidate shape INFLATED by the mover's extent
 *     in the ray direction. For AABB/sphere/pill primitives with an
 *     axis-aligned candidate this is EXACT (the separating-axis distance is
 *     the ray-vs-inflated-slab distance).
 *   - Sphere mover: inflate the candidate's AABB by the sphere radius (exact
 *     for AABB candidates; for sphere/pill candidates the inflated AABB
 *     proxy is exact when the ray is axis-aligned and conservative
 *     (early-but-safe) otherwise).
 *   - Pill mover: capsule radius/height inflate the candidate AABB by the
 *     radius + the cap extent along Y.
 *   - MESH candidates: their bounds AABB is the proxy (the engine's
 *     documented mesh-as-bounds approximation — same class as the
 *     broadphase; exact mesh sweeps are P4d scope).
 *   - A mover ALREADY overlapping a candidate hits at t=0 (normal = the
 *     candidate's face normal of deepest penetration, axis-aligned
 *     approximation).
 *
 * Determinism: candidates are traversed in (t, id) order — nearest t wins,
 * ties broken by ascending id. No Map iteration drives any decision.
 *
 * Zero delta degrades to an overlap test (hit t=0 iff overlapping).
 */

import { AABB, Capsule, raycastAABB, shapesOverlap as shapesOverlapInclusive } from './physics.js'

/** Penetration test: true when the shapes overlap with real DEPTH (not mere
 * touching). Shrinks the CANDIDATE by SWEEP_SKIN and tests inclusive
 * overlap — a resting body touching a surface at exactly one face is NOT
 * penetrating and must remain free to slide/sweep. (Shrinking the MOVER
 * does not work for tangency: a pill's cap radius and its cap-center height
 * shift by the same δ, so vy² and r² stay equal and the inclusive <= never
 * flips. Shrinking the candidate creates real separation.) */
const SWEEP_SKIN = 1e-6

function shapesOverlapPenetrating(a, b) {
  const shrink = (s) => {
    if (s.kind === 'box') return { kind: 'box', box: new AABB(s.box.cx, s.box.cy, s.box.cz, Math.max(0, s.box.hx - SWEEP_SKIN), Math.max(0, s.box.hy - SWEEP_SKIN), Math.max(0, s.box.hz - SWEEP_SKIN)) }
    if (s.kind === 'sphere') return { kind: 'sphere', sphere: { x: s.sphere.x, y: s.sphere.y, z: s.sphere.z, radius: Math.max(0, s.sphere.radius - SWEEP_SKIN) } }
    if (s.kind === 'pill') return { kind: 'pill', capsule: new Capsule(s.capsule.x, s.capsule.y, s.capsule.z, Math.max(0, s.capsule.radius - SWEEP_SKIN), Math.max(0, s.capsule.height - SWEEP_SKIN)) }
    return { kind: 'mesh', tris: s.tris, minX: s.minX + SWEEP_SKIN, maxX: s.maxX - SWEEP_SKIN, minY: s.minY + SWEEP_SKIN, maxY: s.maxY - SWEEP_SKIN, minZ: s.minZ + SWEEP_SKIN, maxZ: s.maxZ - SWEEP_SKIN }
  }
  return shapesOverlapInclusive(a, shrink(b))
}

/** Candidate shapes' uniform inflated proxy: AABB big enough that a center
 * ray hit time equals the shape-pair contact time (for axis-aligned rays it
 * is exact; general rays conservative-advance to the same first contact). */
function inflatedProxy(candShape, mover) {
  // Resolve the candidate to an AABB proxy first (mesh → its bounds).
  let box
  if (candShape.kind === 'box') box = candShape.box
  else if (candShape.kind === 'sphere') {
    const s = candShape.sphere
    box = new AABB(s.x, s.y, s.z, s.radius, s.radius, s.radius)
  } else if (candShape.kind === 'pill') {
    const c = candShape.capsule
    // Pill: radius about the Y axis, caps extend ±coreHalf + radius = ±h/2.
    const halfY = c.height / 2
    box = new AABB(c.x, c.y, c.z, c.radius, halfY, c.radius)
  } else {
    // mesh (or unknown): bounds proxy — minX..maxY are precomputed on the shape.
    if (candShape.minX === undefined) return null
    const cx = (candShape.minX + candShape.maxX) / 2
    const cy = (candShape.minY + candShape.maxY) / 2
    const cz = (candShape.minZ + candShape.maxZ) / 2
    box = new AABB(cx, cy, cz, (candShape.maxX - candShape.minX) / 2, (candShape.maxY - candShape.minY) / 2, (candShape.maxZ - candShape.minZ) / 2)
  }

  // Mover extent: how far the mover's surface reaches from its center along
  // each axis — the inflation that makes center-ray contact = surface contact.
  let ex = 0, ey = 0, ez = 0
  if (mover.kind === 'box') {
    ex = mover.box.hx; ey = mover.box.hy; ez = mover.box.hz
  } else if (mover.kind === 'sphere') {
    ex = ey = ez = mover.sphere.radius
  } else if (mover.kind === 'pill') {
    const c = mover.capsule
    ex = ez = c.radius
    ey = c.height / 2
  } else if (mover.kind === 'mesh' && mover.minX !== undefined) {
    ex = (mover.maxX - mover.minX) / 2
    ey = (mover.maxY - mover.minY) / 2
    ez = (mover.maxZ - mover.minZ) / 2
  } else {
    return null
  }
  return new AABB(box.cx, box.cy, box.cz, box.hx + ex, box.hy + ey, box.hz + ez)
}

/**
 * Sweep `shape` along `delta` ([dx,dy,dz]) against candidates
 * [{ id, shape }] (or shapeFor(id) resolved ids).
 * @param {object} shape  the mover's positioned shape ({kind:...})
 * @param {number[]} delta  [dx, dy, dz] displacement for the full sweep (t 0..1)
 * @param {Array<{id: string, shape: object}>} candidates
 * @returns {{ t: number, nx: number, ny: number, nz: number, id: string } | null}
 */
export function sweepShape(shape, delta, candidates) {
  if (!Array.isArray(delta) || delta.length !== 3) throw new TypeError('sweepShape: delta must be [dx, dy, dz]')
  const [dx, dy, dz] = delta
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) throw new TypeError('sweepShape: delta components must be finite')
  if (!Array.isArray(candidates)) throw new TypeError('sweepShape: candidates must be an array')

  // Mover center.
  let cx, cy, cz
  if (shape.kind === 'box') { cx = shape.box.cx; cy = shape.box.cy; cz = shape.box.cz } else if (shape.kind === 'sphere') { cx = shape.sphere.x; cy = shape.sphere.y; cz = shape.sphere.z } else if (shape.kind === 'pill') { cx = shape.capsule.x; cy = shape.capsule.y; cz = shape.capsule.z } else if (shape.kind === 'mesh' && shape.minX !== undefined) {
    cx = (shape.minX + shape.maxX) / 2; cy = (shape.minY + shape.maxY) / 2; cz = (shape.minZ + shape.maxZ) / 2
  } else {
    throw new TypeError(`sweepShape: unsupported mover shape kind "${shape.kind}"`)
  }

  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const ray = { ox: cx, oy: cy, oz: cz, dx, dy, dz }

  let best = null // { t, nx, ny, nz, id }
  for (const cand of candidates) {
    if (!cand || cand.id === undefined || !cand.shape) continue
    const proxy = inflatedProxy(cand.shape, shape)
    if (!proxy) continue

    // Already overlapping → immediate contact at t=0. Overlap here means
    // REAL penetration (not mere touching): a body resting exactly ON a
    // surface touches it but must still slide horizontally — the inclusive
    // <= overlap of the primitive helpers would otherwise weld a standing
    // character to the floor (every sweep returning t=0). Penetration is
    // detected by shrinking the candidate proxy by a small epsilon.
    const touching = shapesOverlapPenetrating(shape, cand.shape)
    if (touching) {
      if (len === 0) { best = pick(best, { t: 0, nx: 0, ny: 1, nz: 0, id: cand.id }); continue }
      // Face normal of the approach: dominant axis of the center offset.
      const n = approachNormal(shape, cand.shape)
      best = pick(best, { t: 0, nx: n[0], ny: n[1], nz: n[2], id: cand.id })
      continue
    }
    if (len === 0) continue // zero delta, not overlapping → no hit

    const hit = raycastAABB(ray, proxy, 1 + 1e-9)
    if (!hit || hit.t < 0 || hit.t > 1) continue
    // A zero-normal t=0 from raycastAABB means the CENTER RAY ORIGIN is
    // inside the inflated proxy — for a mover resting exactly on a surface
    // its center sits ON the proxy boundary (containsPoint is inclusive).
    // That is boundary contact, not penetration: skip so the mover can move
    // along the surface. Real penetration was already handled by the
    // shapesOverlapPenetrating check above.
    if (hit.t === 0 && hit.nx === 0 && hit.ny === 0 && hit.nz === 0) continue
    // raycastAABB's t is the parameter s where pos = origin + s·direction;
    // with direction = the full delta, s IS the 0..1 delta fraction.
    best = pick(best, { t: hit.t, nx: hit.nx, ny: hit.ny, nz: hit.nz, id: cand.id })
  }
  return best
}

/** Nearest-hit selection with id tiebreak (deterministic). */
function pick(best, cand) {
  if (!best) return cand
  if (cand.t < best.t - 1e-12) return cand
  if (Math.abs(cand.t - best.t) <= 1e-12 && cand.id < best.id) return cand
  return best
}

/** Axis-aligned normal of deepest penetration between two overlapping
 * shapes (approximation — used only for t=0 contact resolution). */
function approachNormal(a, b) {
  const boxOf = (s) => {
    if (s.kind === 'box') return s.box
    if (s.kind === 'sphere') return new AABB(s.sphere.x, s.sphere.y, s.sphere.z, s.sphere.radius, s.sphere.radius, s.sphere.radius)
    if (s.kind === 'pill') return new AABB(s.capsule.x, s.capsule.y, s.capsule.z, s.capsule.radius, s.capsule.height / 2, s.capsule.radius)
    return new AABB((s.minX + s.maxX) / 2, (s.minY + s.maxY) / 2, (s.minZ + s.maxZ) / 2, (s.maxX - s.minX) / 2, (s.maxY - s.minY) / 2, (s.maxZ - s.minZ) / 2)
  }
  const ba = boxOf(a), bb = boxOf(b)
  // Overlap depths on each axis; the smallest is the separating axis.
  const ox = Math.min(ba.maxX, bb.maxX) - Math.max(ba.minX, bb.minX)
  const oy = Math.min(ba.maxY, bb.maxY) - Math.max(ba.minY, bb.minY)
  const oz = Math.min(ba.maxZ, bb.maxZ) - Math.max(ba.minZ, bb.minZ)
  const acx = ba.cx, bcx = bb.cx
  if (ox <= oy && ox <= oz) return [acx <= bcx ? -1 : 1, 0, 0]
  if (oy <= oz) return [0, ba.cy <= bb.cy ? -1 : 1, 0]
  return [0, 0, ba.cz <= bb.cz ? -1 : 1]
}
