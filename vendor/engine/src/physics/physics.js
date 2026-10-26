/**
 * v1 physics: AABB/sphere collision, gravity, ground snapping, raycasts.
 *
 * Deliberately limited (FOUNDATION-PLAN.md §6/§7) — no meshes, no convex hulls,
 * no continuous collision. AABB and sphere shapes only. A more advanced backend
 * may be added later behind the same API after a real game needs it.
 */
import { normalizeTerrain, buildTerrainTriangles } from '../render/terrain-math.js'
import { isRenderPrimitive } from '../catalog/shapes.js'

export const GRAVITY = 9.81 // m/s^2 downward (positive Y down in game units)

/** AABB from center + half-extents. */
export class AABB {
  constructor(cx = 0, cy = 0, cz = 0, hx = 0.5, hy = 0.5, hz = 0.5) {
    this.cx = cx; this.cy = cy; this.cz = cz
    this.hx = hx; this.hy = hy; this.hz = hz
  }
  get minX() { return this.cx - this.hx }
  get maxX() { return this.cx + this.hx }
  get minY() { return this.cy - this.hy }
  get maxY() { return this.cy + this.hy }
  get minZ() { return this.cz - this.hz }
  get maxZ() { return this.cz + this.hz }

  static fromMinMax(minX, minY, minZ, maxX, maxY, maxZ) {
    return new AABB((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2,
      (maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2)
  }

  /** Move the box by (dx, dy, dz). Returns this for chaining. */
  translate(dx, dy, dz) {
    this.cx += dx; this.cy += dy; this.cz += dz
    return this
  }

  clone() {
    return new AABB(this.cx, this.cy, this.cz, this.hx, this.hy, this.hz)
  }

  /** True if this box overlaps another (inclusive of touching). */
  overlaps(other) {
    return this.minX <= other.maxX && this.maxX >= other.minX &&
      this.minY <= other.maxY && this.maxY >= other.minY &&
      this.minZ <= other.maxZ && this.maxZ >= other.minZ
  }

  /** True if a point is inside the box (inclusive). */
  containsPoint(x, y, z) {
    return x >= this.minX && x <= this.maxX &&
      y >= this.minY && y <= this.maxY &&
      z >= this.minZ && z <= this.maxZ
  }
}

export class Sphere {
  constructor(x = 0, y = 0, z = 0, radius = 0.5) {
    this.x = x; this.y = y; this.z = z; this.radius = radius
  }
  translate(dx, dy, dz) {
    this.x += dx; this.y += dy; this.z += dz
    return this
  }
  clone() {
    return new Sphere(this.x, this.y, this.z, this.radius)
  }
}

/** AABB vs AABB overlap. */
export function aabbOverlap(a, b) {
  return a.overlaps(b)
}

/** Sphere vs sphere overlap. */
export function sphereOverlap(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
  const r = a.radius + b.radius
  return dx * dx + dy * dy + dz * dz <= r * r
}

/**
 * Apply gravity to a velocity for one fixed step.
 * @param {number} vy  current vertical velocity (units/s)
 * @param {number} dt  step length (s)
 * @param {number} [gravity=GRAVITY]
 * @returns {number} new vertical velocity
 */
export function applyGravity(vy, dt, gravity = GRAVITY) {
  return vy + gravity * dt
}

/**
 * Ground snapping: given a position and the ground height below it, return the
 * snapped y (or null if the player is too high to snap).
 * @param {number} y        current y
 * @param {number} groundY  ground surface y
 * @param {number} snapDist  max distance for the snap to engage
 * @returns {number|null} the snapped y, or null if not close enough
 */
export function snapToGround(y, groundY, snapDist = 0.1) {
  if (y >= groundY && y - groundY <= snapDist) return groundY
  return null
}

/**
 * Ray vs AABB intersection (slab method). Returns the entry distance t (>=0)
 * or null if no hit, or if t is beyond maxDist.
 * @param {{ox,oy,oz,dx,dy,dz}} ray
 * @param {AABB} box
 * @param {number} [maxDist]
 * @returns {{ t: number, nx: number, ny: number, nz: number } | null}
 */
export function raycastAABB(ray, box, maxDist = Infinity) {
  let tmin = -Infinity
  let tmax = Infinity
  let hitNormal = null

  const slabs = [
    ['x', ray.dx, box.minX, box.maxX],
    ['y', ray.dy, box.minY, box.maxY],
    ['z', ray.dz, box.minZ, box.maxZ],
  ]
  for (const [axis, d, lo, hi] of slabs) {
    if (Math.abs(d) < 1e-12) {
      // Ray parallel to this slab: must be within [lo, hi].
      const p = axis === 'x' ? ray.ox : axis === 'y' ? ray.oy : ray.oz
      if (p < lo || p > hi) return null
    } else {
      const inv = 1 / d
      let t1 = (lo - (axis === 'x' ? ray.ox : axis === 'y' ? ray.oy : ray.oz)) * inv
      let t2 = (hi - (axis === 'x' ? ray.ox : axis === 'y' ? ray.oy : ray.oz)) * inv
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
      if (t1 > tmin) { tmin = t1; hitNormal = axis }
      if (t2 < tmax) tmax = t2
      if (tmin > tmax) return null
    }
  }
  if (tmin < 0) {
    // Origin inside or behind the box. Only report if the origin is inside.
    if (box.containsPoint(ray.ox, ray.oy, ray.oz)) return { t: 0, nx: 0, ny: 0, nz: 0 }
    return null
  }
  if (tmin > maxDist) return null
  const n = { x: hitNormal === 'x' ? (ray.dx > 0 ? -1 : 1) : 0, y: 0, z: 0 }
  if (hitNormal === 'y') { n.y = ray.dy > 0 ? -1 : 1 }
  if (hitNormal === 'z') { n.z = ray.dz > 0 ? -1 : 1 }
  return { t: tmin, nx: n.x, ny: n.y, nz: n.z }
}

/**
 * Resolve an AABB overlapping a static floor: push the box up so it rests on
 * the floor's top face. Returns the resolved y (or the input y if no overlap).
 * @param {AABB} box
 * @param {AABB} floor   a static AABB treated as solid
 * @returns {{ y: number, collided: boolean }}
 */
export function resolveFloor(box, floor) {
  if (!box.overlaps(floor)) return { y: box.cy, collided: false }
  const top = floor.maxY
  if (box.cy <= top) return { y: top + box.hy, collided: true }
  return { y: box.cy, collided: false }
}

/* ── Shape model (box / sphere / pill(capsule)) ──────────────────────────────
 * The collider component can carry a `shape` field: box (hx/hy/hz), sphere
 * (radius), cylinder (radius + height, treated as its bounding AABB), or pill
 * (radius + height — a vertical capsule, axis-aligned along Y, `height` is the
 * TOTAL height including the hemispherical caps, Unity-style). These pure
 * helpers give each shape a real geometric form so physics (floor/gravity,
 * raycast, entity-vs-entity) honors the chosen shape instead of collapsing
 * everything to a box. All shapes are built centered at the origin and
 * positioned by the caller (translateShape) to the entity transform.
 */

/** Vertical capsule (pill): a segment swept by a sphere, axis-aligned along Y. */
export class Capsule {
  constructor(x = 0, y = 0, z = 0, radius = 0.5, height = 1) {
    this.x = x; this.y = y; this.z = z
    this.radius = Math.max(0, radius)
    this.height = Math.max(0, height)
  }
  /** Half-length of the cylindrical core segment (excludes the cap spheres). */
  get coreHalf() { return Math.max(0, this.height / 2 - this.radius) }
  /** Bottom core point (the center of the bottom cap sphere). */
  get a() { return { x: this.x, y: this.y - this.coreHalf, z: this.z } }
  /** Top core point (the center of the top cap sphere). */
  get b() { return { x: this.x, y: this.y + this.coreHalf, z: this.z } }
  clone() { return new Capsule(this.x, this.y, this.z, this.radius, this.height) }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

/** Distance² from a point to a 2D axis-aligned rectangle (0 if inside). */
function distSqPointRect(px, pz, minX, maxX, minZ, maxZ) {
  const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0
  const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0
  return dx * dx + dz * dz
}

/** Distance² from a point to a segment. */
function distSqPointSegment(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const len2 = abx * abx + aby * aby + abz * abz
  let t = len2 === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2
  t = clamp(t, 0, 1)
  const cx = ax + t * abx, cy = ay + t * aby, cz = az + t * abz
  const dx = px - cx, dy = py - cy, dz = pz - cz
  return dx * dx + dy * dy + dz * dz
}

/** AABB vs sphere overlap. */
export function boxVsSphere(box, sphere) {
  const cx = clamp(sphere.x, box.minX, box.maxX)
  const cy = clamp(sphere.y, box.minY, box.maxY)
  const cz = clamp(sphere.z, box.minZ, box.maxZ)
  const dx = sphere.x - cx, dy = sphere.y - cy, dz = sphere.z - cz
  return dx * dx + dy * dy + dz * dz <= sphere.radius * sphere.radius
}

/** Sphere vs capsule (pill) overlap. */
export function sphereVsCapsule(sphere, cap) {
  const d2 = distSqPointSegment(sphere.x, sphere.y, sphere.z,
    cap.a.x, cap.a.y, cap.a.z, cap.b.x, cap.b.y, cap.b.z)
  const r = sphere.radius + cap.radius
  return d2 <= r * r
}

/** Capsule vs capsule overlap (segment-segment distance <= rA + rB). */
export function capsuleOverlap(a, b) {
  const a1 = a.a, a2 = a.b, b1 = b.a, b2 = b.b
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y, d1z = a2.z - a1.z
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y, d2z = b2.z - b1.z
  const r0x = a1.x - b1.x, r0y = a1.y - b1.y, r0z = a1.z - b1.z
  const aa = d1x * d1x + d1y * d1y + d1z * d1z
  const ee = d2x * d2x + d2y * d2y + d2z * d2z
  const ff = d2x * r0x + d2y * r0y + d2z * r0z
  let t = 0, s = 0
  if (aa <= 1e-12 && ee <= 1e-12) { s = t = 0 }
  else if (aa <= 1e-12) { s = 0; t = clamp(ff / ee, 0, 1) }
  else {
    const cc = d1x * r0x + d1y * r0y + d1z * r0z
    const bb = d1x * d2x + d1y * d2y + d1z * d2z
    const denom = aa * ee - bb * bb
    s = denom !== 0 ? clamp((bb * ff - cc * ee) / denom, 0, 1) : 0
    t = (bb * s + ff) / ee
    if (t < 0) { t = 0; s = clamp(-cc / aa, 0, 1) }
    else if (t > 1) { t = 1; s = clamp((bb - cc) / aa, 0, 1) }
  }
  const c1x = a1.x + d1x * s, c1y = a1.y + d1y * s, c1z = a1.z + d1z * s
  const c2x = b1.x + d2x * t, c2y = b1.y + d2y * t, c2z = b1.z + d2z * t
  const dx = c1x - c2x, dy = c1y - c2y, dz = c1z - c2z
  return dx * dx + dy * dy + dz * dz <= (a.radius + b.radius) ** 2
}

/** AABB vs capsule overlap (vertical core segment vs box distance <= radius). */
export function boxVsCapsule(box, cap) {
  const hd2 = distSqPointRect(cap.x, cap.z, box.minX, box.maxX, box.minZ, box.maxZ)
  const lo = cap.a.y, hi = cap.b.y
  let vy = 0
  if (lo > box.maxY) vy = lo - box.maxY
  else if (hi < box.minY) vy = box.minY - hi
  return hd2 + vy * vy <= cap.radius * cap.radius
}

/** Ray vs sphere. */
export function raycastSphere(ray, sphere, maxDist = Infinity) {
  const ox = ray.ox - sphere.x, oy = ray.oy - sphere.y, oz = ray.oz - sphere.z
  const b = ox * ray.dx + oy * ray.dy + oz * ray.dz
  const c = ox * ox + oy * oy + oz * oz - sphere.radius * sphere.radius
  const disc = b * b - c
  if (disc < 0) return null
  let t = -b - Math.sqrt(disc)
  if (t < 0) t = -b + Math.sqrt(disc)
  if (t < 0 || t > maxDist) return null
  const px = ox + ray.dx * t, py = oy + ray.dy * t, pz = oz + ray.dz * t
  return { t, nx: px / sphere.radius, ny: py / sphere.radius, nz: pz / sphere.radius }
}

/** Ray vs vertical capsule (pill): cylinder core + two cap spheres, min hit. */
export function raycastCapsule(ray, cap, maxDist = Infinity) {
  const r = cap.radius, h = cap.coreHalf
  const ox = ray.ox - cap.x, oy = ray.oy - cap.y, oz = ray.oz - cap.z
  let best = null
  const record = (t, nx, ny, nz) => {
    if (t < 0 || t > maxDist) return
    if (!best || t < best.t) best = { t, nx, ny, nz }
  }
  // Cylindrical core (axis = Y).
  const a = ray.dx * ray.dx + ray.dz * ray.dz
  if (a > 1e-12) {
    const bb = 2 * (ox * ray.dx + oz * ray.dz)
    const cc = ox * ox + oz * oz - r * r
    const disc = bb * bb - 4 * a * cc
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      for (const t of [(-bb - sq) / (2 * a), (-bb + sq) / (2 * a)]) {
        if (t >= 0) {
          const y = oy + ray.dy * t
          if (y >= -h && y <= h) record(t, (ox + ray.dx * t) / r, 0, (oz + ray.dz * t) / r)
        }
      }
    }
  }
  // Cap spheres at (0, ±h, 0).
  for (const sy of [-h, h]) {
    const cxo = ox, cyo = oy - sy, czo = oz
    const b = cxo * ray.dx + cyo * ray.dy + czo * ray.dz
    const c = cxo * cxo + cyo * cyo + czo * czo - r * r
    const disc = b * b - c
    if (disc >= 0) {
      let t = -b - Math.sqrt(disc)
      if (t < 0) t = -b + Math.sqrt(disc)
      if (t >= 0) {
        const px = cxo + ray.dx * t, py = cyo + ray.dy * t, pz = czo + ray.dz * t
        record(t, px / r, py / r, pz / r)
      }
    }
  }
  return best
}

/**
 * Build a collider's shape from a collider component, centered at the origin.
 * An ABSENT shape means a legacy box collider (back-compat default). A PRESENT
 * but unrecognized shape is a bug — throw rather than silently colliding as a
 * box (the "switch to pill but it stays a box" class of silent failure).
 *
 * The `ctx` (optional) carries the entity's `render` + `transform.scale`, needed
 * to derive the `'render'` shape (auto-match the render mesh). Legacy callers
 * that pass only the collider still work; a `'render'` shape without ctx falls
 * back to a unit box.
 * @param {object} [c] collider component.
 * @param {{ render?: object, scale?: number[]|object }} [ctx] entity context.
 * @returns {{ kind: 'box'|'sphere'|'pill', box?: AABB, sphere?: Sphere, capsule?: Capsule }}
 *   Cylinder maps to its bounding AABB (documented approximation).
 */
export function shapeFromCollider(c = {}, ctx = {}) {
  const shape = c.shape === undefined ? 'box' : c.shape
  const rot = ctx.rotation && typeof ctx.rotation === 'object' &&
    (ctx.rotation.x || ctx.rotation.y || ctx.rotation.z) ? ctx.rotation : null
  if (shape === 'box') {
    // A ROTATED box becomes a rotated mesh shape (an axis-aligned AABB cannot
    // carry rotation) — same treatment the 'render' path has always given
    // rotated boxes. Unrotated boxes stay fast AABBs. Sphere is
    // rotation-invariant; cylinder/pill get the same mesh conversion.
    if (rot) {
      if (shape === 'box') {
        return buildMeshShape(rotateTriangles(aabbToTris(c.hx ?? 0.5, c.hy ?? 0.5, c.hz ?? 0.5), rot), rot, { x: c.hx ?? 0.5, y: c.hy ?? 0.5, z: c.hz ?? 0.5 })
      }
    }
    return { kind: 'box', box: new AABB(0, 0, 0, c.hx ?? 0.5, c.hy ?? 0.5, c.hz ?? 0.5) }
  }
  if (shape === 'sphere') return { kind: 'sphere', sphere: new Sphere(0, 0, 0, c.radius ?? 0.5) }
  if (shape === 'cylinder') {
    const r = c.radius ?? 0.5, h = c.height ?? 1
    if (rot) {
      return buildMeshShape(rotateTriangles(aabbToTris(r, h / 2, r), rot), rot, { x: r, y: h / 2, z: r })
    }
    return { kind: 'box', box: new AABB(0, 0, 0, r, h / 2, r) }
  }
  if (shape === 'pill') {
    if (rot) {
      // Approximation for the P3.5 pass: a rotated pill becomes its rotated
      // bounding-box mesh (a true rotated-capsule solver shape is deferred).
      // Documented — a 90°-tilted pill collides as a rotated box, not a capsule.
      // pill default = the unit render pill's radius; r0.5 @ h1 is a degenerate sphere
      const r = c.radius ?? 0.25, h = c.height ?? 1
      return buildMeshShape(rotateTriangles(aabbToTris(r, h / 2, r), rot), rot, { x: r, y: h / 2, z: r })
    }
    return { kind: 'pill', capsule: new Capsule(0, 0, 0, c.radius ?? 0.25, c.height ?? 1) }
  }
  if (shape === 'render') return shapeFromRender(ctx)
  // A RENDER PRIMITIVE used directly as a collider shape (cone/torus/.../lathe):
  // collide as its REAL render geometry, derived the SAME way shapeFromRender
  // does for a 'render' mesh — from ctx.primitiveTriangles (the renderer's unit
  // primitive triangles) scaled by the full transform scale, falling to a box
  // only when headless (no triangles wired). ring/circle are FLAT primitives
  // (rotateX baked in) — colliding as their flat triangles is a disc/ring
  // surface, which is correct, so they're kept.
  if (isRenderPrimitive(shape)) return deriveRenderCollider(shape, ctx)
  throw new Error(`unknown collider shape "${shape}" (expected box|sphere|cylinder|pill|render)`)
}

/**
 * Derive a collider shape from a render primitive's REAL geometry — the shared
 * math source for the 'render' catch-all (deriveRenderCollider(ctx.render.mesh))
 * and for each explicit render-primitive collider shape (cone/torus/.../lathe).
 * `mesh` is the render primitive name; its unit triangles live in
 * `ctx.primitiveTriangles` (wired by the renderer via api.physics.setPrimitiveMesh)
 * and are scaled by the FULL transform scale, exactly like the renderer's
 * mesh.scale — so the collider surface IS the render surface. Only when no
 * triangles are wired (headless) does it fall back to a bounding box.
 *
 * The analytic branches below (box/sphere/cylinder/plane/pill) are kept because
 * shapeFromRender still routes the ANALYTIC render shapes through them for the
 * fast exact path (uniform sphere = exact sphere, unrotated uniform-X/Z pill =
 * exact capsule, box/plane = exact analytic surface); this helper is the
 * GENERIC mesh-derivation used for everything else.
 * @param {string} mesh  a render primitive name (the geometry to collide as).
 * @param {{ render?: object, scale?: number[]|object, rotation?: {x,y,z}, primitiveTriangles?: object[] }} [ctx]
 * @returns {{ kind: 'box'|'sphere'|'pill'|'mesh', ... }}
 */
export function deriveRenderCollider(mesh = 'box', ctx = {}) {
  const s = readScale(ctx.scale)
  const rot = ctx.rotation || null
  // A TERRAIN render collides as its real heightfield SURFACE (a mesh shape),
  // independent of any modelName — the terrain component IS the geometry.
  if (ctx.terrain) {
    const norm = normalizeTerrain(ctx.terrain)
    const tris = buildTerrainTriangles(norm)
    return buildMeshShape(rotateTriangles(scaleTriangles(tris, s), rot))
  }
  // A MODEL render collides as its REAL mesh: `ctx.modelTriangles` is the
  // model's local-frame triangle list (from the renderer), scaled by the
  // transform scale -> a MeshShape whose surface is the actual geometry.
  if (ctx.render && ctx.render.modelName) {
    const tris = ctx.modelTriangles
    if (Array.isArray(tris) && tris.length > 0) {
      return buildMeshShape(rotateTriangles(scaleTriangles(tris, s), rot))
    }
    // No mesh available (renderer hasn't measured it) -> fall back to a box at
    // the measured size × scale, or a unit box.
    const mb = ctx.modelBounds || { x: 1, y: 1, z: 1 }
    const full = [(mb.x * s[0]) / 2, (mb.y * s[1]) / 2, (mb.z * s[2]) / 2]
    // A rotated fallback box is expressed as a rotated mesh (AABB can't rotate).
    return rotatedBox(full, rot)
  }
  const m = mesh || 'box'
  // THE 'match render mesh' CONTRACT: the collider derives from the SAME
  // triangles the renderer draws. `ctx.primitiveTriangles` is the renderer's
  // unit primitive geometry extracted as triangles; physics scales them
  // per-axis by the FULL transform scale, exactly like the renderer's
  // mesh.scale. Wired automatically by renderer.render()
  // (api.physics.setPrimitiveMesh) so editor AND built games share one math
  // source. BOX stays analytic (the 1×1×1 box IS the analytic box — same math,
  // no triangles needed); PLANE stays analytic (its 2-triangle hand path is
  // byte-identical to the renderer's PlaneGeometry); a UNIFORM sphere stays the
  // exact analytic sphere; an UNROTATED uniform-X/Z pill stays the exact
  // analytic capsule. Non-uniform sphere + cylinder + ROTATED/non-uniform-X/Z
  // pill use the REAL render triangles. Everything else (cone/torus/torusKnot/
  // icosahedron/dodecahedron/octahedron/tetrahedron/ring/circle/lathe) collides
  // as its REAL render surface via the generic mesh fallback below.
  if (m === 'sphere') {
    const uniform = Math.abs(s[0] - s[1]) < 1e-6 && Math.abs(s[1] - s[2]) < 1e-6
    if (uniform) return { kind: 'sphere', sphere: new Sphere(0, 0, 0, s[0] / 2) }
    // Non-uniform scale renders an ELLIPSOID — the collider is the true
    // ellipsoid: the renderer's own unit-sphere triangles scaled per-axis
    // when wired, a local tessellation as the headless fallback (the render
    // primitive is UNIT-DIAMETER, so the fallback scales by s/2 — half-
    // extents s/2 per axis, identical to the analytic sphere's radius).
    const tris = Array.isArray(ctx.primitiveTriangles) && ctx.primitiveTriangles.length > 0
      ? ctx.primitiveTriangles
      : unitSphereTriangles()
    const sc = Array.isArray(ctx.primitiveTriangles) && ctx.primitiveTriangles.length > 0 ? s : [s[0] / 2, s[1] / 2, s[2] / 2]
    return buildMeshShape(rotateTriangles(scaleTriangles(tris, sc), rot))
  }
  if (m === 'cylinder' && Array.isArray(ctx.primitiveTriangles) && ctx.primitiveTriangles.length > 0) {
    // The renderer's cylinder geometry (24-segment) as the real collider
    // surface — not the flat-sided bounding-AABB approximation.
    return buildMeshShape(rotateTriangles(scaleTriangles(ctx.primitiveTriangles, s), rot))
  }
  if (m === 'cylinder') {
    // Headless fallback: the documented bounding-AABB approximation.
    return rotatedBox([s[0] / 2, s[1] / 2, s[0] / 2], rot)
  }
  if (m === 'plane') {
    // The plane primitive lies flat on the X/Z plane (the renderer bakes
    // rotateX(-90°) into the shared geometry): a flat 1×1 surface at y=0,
    // sized by scale X (width) and scale Z (depth). Scale Y is IGNORED —
    // exactly matching the render, which has zero height.
    // This is NOT an AABB slab: it's the REAL 2-triangle surface (kind
    // 'mesh'), so a body rests on the plane's actual Y through the solid-mesh
    // path (solidBodies/resolveSolid) — no box thickness anywhere, and the
    // collider is exactly what you see. Winding is irrelevant (the mesh
    // resolver only needs the XZ projection + surface Y).
    const tris = [
      { ax: -0.5, ay: 0, az: 0.5, bx: 0.5, by: 0, bz: 0.5, cx: 0.5, cy: 0, cz: -0.5 },
      { ax: -0.5, ay: 0, az: 0.5, bx: 0.5, by: 0, bz: -0.5, cx: -0.5, cy: 0, cz: -0.5 },
    ]
    return buildMeshShape(rotateTriangles(scaleTriangles(tris, [s[0], 1, s[2]]), rot))
  }
  if (m === 'pill') {
    // UNIT RENDER PILL (documented on the catalog's pill entry and in the
    // renderer's _geometry): THREE.CapsuleGeometry(0.25, 0.5) — cap radius
    // 0.25, mid-section 0.5, TOTAL height 1. Unrotated + uniform X/Z scale,
    // the collider is the exact ANALYTIC capsule: rendered radius =
    // 0.25 × scale.x, total height = scale.y (Capsule.height is TOTAL height
    // including caps — coreHalf = height/2 − radius — matching the pill
    // collider's Unity-style convention). The analytic capsule solves better
    // than its tessellation, the same reasoning as the analytic sphere.
    // Rotated OR non-uniform X/Z falls back to the REAL render triangles
    // (the unit capsule tessellation, scaled by the full transform scale);
    // headless (no triangles wired) mirrors the cylinder's bounding-AABB
    // fallback at the unit pill's true extents.
    const uniformXZ = Math.abs(s[0] - s[2]) < 1e-6
    const unrotated = !rot || (!rot.x && !rot.y && !rot.z)
    if (unrotated && uniformXZ) {
      return { kind: 'pill', capsule: new Capsule(0, 0, 0, 0.25 * s[0], s[1]) }
    }
    if (Array.isArray(ctx.primitiveTriangles) && ctx.primitiveTriangles.length > 0) {
      return buildMeshShape(rotateTriangles(scaleTriangles(ctx.primitiveTriangles, s), rot))
    }
    return rotatedBox([0.25 * s[0], s[1] / 2, 0.25 * s[2]], rot)
  }
  // box — an AABB at scale/2 when unrotated; a rotated mesh when rotated.
  // A generic render primitive (cone/torus/torusKnot/icosahedron/dodecahedron/
  // octahedron/tetrahedron/ring/circle/lathe) collides as its REAL render
  // surface: the renderer's unit primitive triangles scaled by the full
  // transform scale. Only when NO triangles are wired (headless) does it fall
  // back to a bounding box at scale/2. ring/circle are FLAT primitives
  // (rotateX baked in) — a disc/ring surface, which is correct.
  if (Array.isArray(ctx.primitiveTriangles) && ctx.primitiveTriangles.length > 0) {
    return buildMeshShape(rotateTriangles(scaleTriangles(ctx.primitiveTriangles, s), rot))
  }
  if (m === 'box') return rotatedBox([s[0] / 2, s[1] / 2, s[2] / 2], rot)
  // Headless render primitive: no renderer wired its geometry — a bounding box
  // at scale/2 (a unit-box approximation; the real surface appears when the
  // renderer runs).
  return rotatedBox([s[0] / 2, s[1] / 2, s[2] / 2], rot)
}

/** A transform scale value → [sx, sy, sz] (number, array, or {x,y,z}; defaults [1,1,1]). */
export function readScale(scale) {
  if (typeof scale === 'number') return [scale, scale, scale]
  if (Array.isArray(scale)) return [scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1]
  if (scale && typeof scale === 'object') {
    // {0:x,1:y,2:z} = a scale array corrupted by an old {...spread}; read as array.
    if (scale.x === undefined && (scale[0] !== undefined || scale[1] !== undefined || scale[2] !== undefined)) {
      return [scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1]
    }
    return [scale.x ?? 1, scale.y ?? 1, scale.z ?? 1]
  }
  return [1, 1, 1]
}

/**
 * Derive a collider shape that matches the entity's RENDER mesh. The render
 * primitive's unit geometry (box 1×1×1, sphere Ø1, cylinder Ø1×h1, pill
 * CapsuleGeometry(0.25, 0.5) = Ø0.5 × total h1) is scaled by the transform
 * scale, so the collider full size follows the transform scale:
 *   box      → AABB half-extents = scale/2
 *   sphere   → sphere radius = scale.x/2 (uniform diameter = scale.x)
 *   cylinder → bounding AABB (r = scale.x/2, h = scale.y) — same approximation
 *              as a manual cylinder collider
 *   pill     → analytic capsule (r = 0.25 × scale.x, total h = scale.y) when
 *              unrotated + uniform X/Z; real render triangles otherwise
 * A MODEL render (render.modelName) has no geometry available to pure physics,
 * so it uses `ctx.modelBounds` (the model's measured full LOCAL size) × the
 * transform scale → an AABB that matches the real mesh. When `ctx.modelBounds`
 * is absent (no renderer measured it) it falls back to an AABB at transform
 * scale (a unit-box approximation).
 * @param {{ render?: object, scale?: number[]|object, modelBounds?: {x,y,z}, rotation?: {x,y,z} }} [ctx]
 *   `rotation` is the entity's Euler rotation (radians) — the same rotation the
 *   renderer applies to the mesh. It is honored so a rotated 'render' collider
 *   matches the rotated render: mesh shapes (model/plane/terrain) rotate their
 *   triangles, and a rotated box/cylinder primitive becomes a rotated mesh
 *   shape (an axis-aligned AABB cannot express rotation). A sphere is
 *   rotation-invariant and stays a sphere.
 * @returns {{ kind: 'box'|'sphere'|'pill'|'mesh', box?: AABB, sphere?: Sphere, capsule?: Capsule }}
 */
export function shapeFromRender(ctx = {}) {
  // ONE math source: the 'render' catch-all derives its collider from the same
  // render-primitive geometry helper the explicit primitive collider shapes
  // (cone/torus/.../lathe) use — deriveRenderCollider(mesh, ctx). The render
  // mesh name (ctx.render.mesh, default 'box') selects which unit primitive
  // triangles to scale by the full transform scale.
  return deriveRenderCollider(ctx.render?.mesh || 'box', ctx)
}

/** Build an AABB-shaped collider, expressed as a rotated mesh when the entity
 * is rotated (an axis-aligned AABB cannot carry rotation). Identity rotation
 * keeps the cheap, exact AABB. */
function rotatedBox(half, rot) {
  const halfObj = { x: half[0], y: half[1], z: half[2] }
  if (!rot || (!rot.x && !rot.y && !rot.z)) {
    return { kind: 'box', box: new AABB(0, 0, 0, half[0], half[1], half[2]) }
  }
  return buildMeshShape(rotateTriangles(aabbToTris(half[0], half[1], half[2]), rot), rot, halfObj)
}

/* ── Triangle mesh shape (static solid body) ─────────────────────────────── */

/** Scale each triangle's vertices by [sx, sy, sz]. */
export function scaleTriangles(tris, s) {
  const [sx, sy, sz] = s
  return tris.map((t) => ({
    ax: t.ax * sx, ay: t.ay * sy, az: t.az * sz,
    bx: t.bx * sx, by: t.by * sy, bz: t.bz * sz,
    cx: t.cx * sx, cy: t.cy * sy, cz: t.cz * sz,
  }))
}

/**
 * Rotate each triangle's vertices by an XYZ Euler rotation (radians). The
 * convention matches THREE's `Euler(x,y,z)` (default order 'XYZ') — the same
 * rotation the renderer applies to the mesh — so a rotated 'render' collider
 * matches the mesh exactly. A null/zero rotation is an identity no-op.
 * @param {object[]} tris  triangle list
 * @param {{x?:number,y?:number,z?:number}|null} [rot]  Euler (radians)
 */
export function rotateTriangles(tris, rot) {
  const rx = (rot && rot.x) || 0, ry = (rot && rot.y) || 0, rz = (rot && rot.z) || 0
  if (!rx && !ry && !rz) return tris
  const c1 = Math.cos(rx), s1 = Math.sin(rx)
  const c2 = Math.cos(ry), s2 = Math.sin(ry)
  const c3 = Math.cos(rz), s3 = Math.sin(rz)
  // THREE.makeRotationFromEuler, order 'XYZ' — the same matrix the renderer
  // uses. Verified element-by-element against THREE's Matrix4 (row-major here).
  const m00 = c2 * c3, m01 = -c2 * s3, m02 = s2
  const m10 = c1 * s3 + s1 * s2 * c3, m11 = c1 * c3 - s1 * s2 * s3, m12 = -s1 * c2
  const m20 = s1 * s3 - c1 * s2 * c3, m21 = s1 * c3 + c1 * s2 * s3, m22 = c1 * c2
  const R = (v) => ({
    x: m00 * v.x + m01 * v.y + m02 * v.z,
    y: m10 * v.x + m11 * v.y + m12 * v.z,
    z: m20 * v.x + m21 * v.y + m22 * v.z,
  })
  return tris.map((t) => {
    const a = R({ x: t.ax, y: t.ay, z: t.az })
    const b = R({ x: t.bx, y: t.by, z: t.bz })
    const c = R({ x: t.cx, y: t.cy, z: t.cz })
    return { ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, cx: c.x, cy: c.y, cz: c.z }
  })
}

/**
 * The unit sphere's surface as triangles (a UV-sphere with `lat` latitude
 * bands × `lon` longitude slices). Deterministic; cached (the module-level
 * array is shared read-only — callers must not mutate the vertices).
 * Used by the 'render' collider's sphere branch: per-axis scale turns the
 * unit sphere into the TRUE ellipsoid the renderer draws, so the collider
 * is the real geometry rather than a fitted uniform sphere.
 * @param {number} [lat] latitude bands (>= 2)
 * @param {number} [lon] longitude slices (>= 3)
 * @returns {object[]} triangles { ax,ay,az, bx,by,bz, cx,cy,cz } on the unit sphere
 */
let _unitSphereCache = null
export function unitSphereTriangles(lat = 10, lon = 16) {
  if (_unitSphereCache) return _unitSphereCache
  const out = []
  // Row i: latitude ring (i from 0 = +Y pole to lat). Ring j: longitude.
  const pt = (i, j) => {
    const phi = (Math.PI * i) / lat               // 0..π from +Y pole
    const theta = (2 * Math.PI * j) / lon         // 0..2π around Y
    const sp = Math.sin(phi)
    return { x: sp * Math.cos(theta), y: Math.cos(phi), z: sp * Math.sin(theta) }
  }
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = pt(i, j), b = pt(i, j + 1), c = pt(i + 1, j + 1), d = pt(i + 1, j)
      if (i > 0) out.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, cx: c.x, cy: c.y, cz: c.z })
      if (i < lat - 1) out.push({ ax: a.x, ay: a.y, az: a.z, bx: c.x, by: c.y, bz: c.z, cx: d.x, cy: d.y, cz: d.z })
    }
  }
  _unitSphereCache = out
  return out
}

/** Convert a centered AABB (half-extents hx/hy/hz) into 12 box triangles. */
export function aabbToTris(hx, hy, hz) {
  const x = hx, y = hy, z = hz
  // Six faces, two triangles each (outward winding). Vertices:
  const V = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], // back (z=-z)
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],     // front (z=z)
  ]
  const face = (a, b, c) => ({ ax: V[a][0], ay: V[a][1], az: V[a][2], bx: V[b][0], by: V[b][1], bz: V[b][2], cx: V[c][0], cy: V[c][1], cz: V[c][2] })
  return [
    face(4, 5, 6), face(4, 6, 7), // front
    face(1, 0, 3), face(1, 3, 2), // back
    face(5, 1, 2), face(5, 2, 6), // right
    face(0, 4, 7), face(0, 7, 3), // left
    face(7, 6, 2), face(7, 2, 3), // top
    face(0, 1, 5), face(0, 5, 4), // bottom
  ]
}

/**
 * Build a `mesh` collider shape from a triangle list (world or entity frame —
 * `translateShape` moves it). Precomputes the AABB so broad-phase rejects are
 * cheap. Each triangle: `{ ax,ay,az, bx,by,bz, cx,cy,cz }`.
 * @returns {{ kind:'mesh', tris: object[], minX,minY,minZ,maxX,maxY,maxZ }}
 */
export function buildMeshShape(tris, rot = null, half = null) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const t of tris) {
    minX = Math.min(minX, t.ax, t.bx, t.cx); minY = Math.min(minY, t.ay, t.by, t.cy); minZ = Math.min(minZ, t.az, t.bz, t.cz)
    maxX = Math.max(maxX, t.ax, t.bx, t.cx); maxY = Math.max(maxY, t.ay, t.by, t.cy); maxZ = Math.max(maxZ, t.az, t.bz, t.cz)
  }
  const shape = { kind: 'mesh', tris, minX, minY, minZ, maxX, maxY, maxZ }
  // P3.5 W2: rotated mesh shapes carry their construction rotation (Euler, the
  // readRotation form) + the UNROTATED half extents — the solver's OBB path
  // reconstructs the rotated axes from these. Null/absent for unrotated meshes.
  if (rot && (rot.x || rot.y || rot.z)) shape.rot = { x: rot.x ?? 0, y: rot.y ?? 0, z: rot.z ?? 0 }
  if (half && typeof half === 'object') shape.half = { x: half.x ?? 0.5, y: half.y ?? 0.5, z: half.z ?? 0.5 }
  return shape
}

/** The Y of a triangle at an (x, z) point via barycentric coordinates, or null
 * if the point is outside the triangle's XZ projection. */
function triYAt(t, x, z) {
  const d = (t.bx - t.ax) * (t.cz - t.az) - (t.bz - t.az) * (t.cx - t.ax)
  if (Math.abs(d) < 1e-9) return null // degenerate in XZ
  const s = ((x - t.ax) * (t.cz - t.az) - (z - t.az) * (t.cx - t.ax)) / d
  const q = ((t.bx - t.ax) * (z - t.az) - (t.bz - t.az) * (x - t.ax)) / d
  if (s < 0 || q < 0 || s + q > 1) return null
  const p = 1 - s - q
  return p * t.ay + s * t.by + q * t.cy
}

/** Closest point on a triangle's XZ projection to an (x, z) point. Robust
 * closest-point-on-triangle (Ericson), so it also handles a degenerate XZ
 * projection (a vertical wall collapses to a line segment in XZ). */
function closestPointTriXZ(t, x, z) {
  const abx = t.bx - t.ax, abz = t.bz - t.az
  const acx = t.cx - t.ax, acz = t.cz - t.az
  const apx = x - t.ax, apz = z - t.az
  const d1 = abx * apx + abz * apz
  const d2 = acx * apx + acz * apz
  if (d1 <= 0 && d2 <= 0) return { x: t.ax, z: t.az }
  const bpx = x - t.bx, bpz = z - t.bz
  const d3 = abx * bpx + abz * bpz
  const d4 = acx * bpx + acz * bpz
  if (d3 >= 0 && d4 <= d3) return { x: t.bx, z: t.bz }
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3 || 1); return { x: t.ax + v * abx, z: t.az + v * abz } }
  const cpx = x - t.cx, cpz = z - t.cz
  const d5 = abx * cpx + abz * cpz
  const d6 = acx * cpx + acz * cpz
  if (d6 >= 0 && d5 <= d6) return { x: t.cx, z: t.cz }
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6 || 1); return { x: t.ax + w * acx, z: t.az + w * acz } }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6) || 1); return { x: t.bx + w * (t.cx - t.bx), z: t.bz + w * (t.cz - t.bz) } }
  const denom = 1 / (va + vb + vc || 1)
  const v = vb * denom, w = vc * denom
  return { x: t.ax + abx * v + acx * w, z: t.az + abz * v + acz * w }
}

/** Unit 3D face normal of a triangle (cross product), or null if degenerate. */
function triNormal(t) {
  const abx = t.bx - t.ax, aby = t.by - t.ay, abz = t.bz - t.az
  const acx = t.cx - t.ax, acy = t.cy - t.ay, acz = t.cz - t.az
  let nx = aby * acz - abz * acy
  let ny = abz * acx - abx * acz
  let nz = abx * acy - aby * acx
  const l = Math.hypot(nx, ny, nz)
  if (l < 1e-9) return null
  nx /= l; ny /= l; nz /= l
  return { x: nx, y: ny, z: nz }
}

/** Ray vs a triangle (Möller–Trumbore). Returns `{t,nx,ny,nz}` or null. */
function rayTriangle(ox, oy, oz, dx, dy, dz, t) {
  const ex1x = t.bx - t.ax, ex1y = t.by - t.ay, ex1z = t.bz - t.az
  const ex2x = t.cx - t.ax, ex2y = t.cy - t.ay, ex2z = t.cz - t.az
  const px = dy * ex2z - dz * ex2y, py = dz * ex2x - dx * ex2z, pz = dx * ex2y - dy * ex2x
  const det = ex1x * px + ex1y * py + ex1z * pz
  if (det > -1e-9 && det < 1e-9) return null
  const inv = 1 / det
  const tx = ox - t.ax, ty = oy - t.ay, tz = oz - t.az
  const u = (tx * px + ty * py + tz * pz) * inv
  if (u < 0 || u > 1) return null
  const qx = ty * ex1z - tz * ex1y, qy = tz * ex1x - tx * ex1z, qz = tx * ex1y - ty * ex1x
  const v = (dx * qx + dy * qy + dz * qz) * inv
  if (v < 0 || u + v > 1) return null
  const dist = (ex2x * qx + ex2y * qy + ex2z * qz) * inv
  if (dist < 0) return null
  // Face normal = edge1 × edge2 (unit).
  const n = { x: ex1y * ex2z - ex1z * ex2y, y: ex1z * ex2x - ex1x * ex2z, z: ex1x * ex2y - ex1y * ex2x }
  const nl = Math.hypot(n.x, n.y, n.z) || 1
  return { t: dist, nx: n.x / nl, ny: n.y / nl, nz: n.z / nl }
}

/** Raycast a ray against a mesh shape — nearest triangle hit. */
export function meshRaycast(ray, mesh, maxDist = Infinity) {
  let best = null
  for (const t of mesh.tris) {
    const h = rayTriangle(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, t)
    if (h && h.t <= maxDist && (best === null || h.t < best.t)) best = h
  }
  return best
}

/**
 * Solid-body resolution of a dynamic body against a static triangle mesh.
 * Given a body (box/sphere/pill, world-positioned) and a mesh shape, returns
 * the horizontal push-out to clear any wall/roof surface the body penetrates,
 * plus the floor top the body can rest on (a triangle top under the body).
 *
 *   `{ pushX, pushZ, floorTop }`
 *
 * - `floorTop` — the highest triangle-top height at the body's center that's
 *   within `snapDist` below the body's bottom (a walkable/roof surface).
 * - `pushX/pushZ` — the horizontal translation that separates the body's XZ
 *   footprint from every triangle that rises above the body's bottom (walls
 *   and roof edges), so the body can't be placed inside the solid.
 *
 * This is the "can't walk through the mesh" primitive: each step, apply the
 * push to the body's position, then snap it to `floorTop` (like the existing
 * floor snapping, but against the actual mesh surface).
 */
export function resolveBodyVsMesh(body, mesh, snapDist = 0.15) {
  if (!mesh || mesh.kind !== 'mesh') return { pushX: 0, pushZ: 0, floorTop: null }
  const c = bodyCenter(body)
  const r = horizontalRadius(body)
  const bottom = shapeBottomY(body)
  const top = bodyTopY(body)
  let pushX = 0, pushZ = 0, floorTop = null
  for (const t of mesh.tris) {
    // Broad-phase: triangle's Y span must overlap the body's Y range.
    const tyMin = Math.min(t.ay, t.by, t.cy), tyMax = Math.max(t.ay, t.by, t.cy)
    if (tyMax < bottom - snapDist * 2 || tyMin > top) continue
    const n = triNormal(t)
    // FLOOR-like (mostly horizontal surface): the body rests on its top when the
    // surface under the body's center is at/just below the body's bottom.
    if (n && Math.abs(n.y) > 0.5) {
      const ty = triYAt(t, c.x, c.z)
      if (ty != null && ty <= bottom + snapDist && ty >= bottom - snapDist * 4) {
        if (floorTop === null || ty > floorTop) floorTop = ty
      }
      continue // a floor never pushes laterally
    }
    // WALL-like (vertical/sloped side): push the body horizontally out of any
    // surface whose XZ footprint is within the body's footprint.
    const cp = closestPointTriXZ(t, c.x, c.z)
    const dx = c.x - cp.x, dz = c.z - cp.z
    const d = Math.hypot(dx, dz)
    if (d < r) {
      const push = r - d
      if (d > 1e-6) { pushX += (dx / d) * push; pushZ += (dz / d) * push }
      else pushX += push // center inside the footprint — push +X (least-commit)
    }
  }
  return { pushX, pushZ, floorTop }
}

/** Translate a mesh shape's triangles (and return the {x,y,z} delta applied). */
function meshTranslate(shape, x, y, z) {
  for (const t of shape.tris) {
    t.ax += x; t.ay += y; t.az += z
    t.bx += x; t.by += y; t.bz += z
    t.cx += x; t.cy += y; t.cz += z
  }
  return { x, y, z }
}

/** The body's center (the positioned shape's transform origin). */
function bodyCenter(shape) {
  if (shape.kind === 'box') return { x: shape.box.cx, y: shape.box.cy, z: shape.box.cz }
  if (shape.kind === 'sphere') return { x: shape.sphere.x, y: shape.sphere.y, z: shape.sphere.z }
  if (shape.kind === 'mesh') {
    // Mesh shapes carry their AABB (minX…maxZ) from buildMeshShape — center of
    // the bounding box is the mesh body's transform origin approximation.
    return {
      x: (shape.minX + shape.maxX) / 2,
      y: (shape.minY + shape.maxY) / 2,
      z: (shape.minZ + shape.maxZ) / 2,
    }
  }
  const c = shape.capsule
  return { x: c.x, y: c.y, z: c.z }
}

/** The body's horizontal radius (largest XZ reach) for footprint tests. */
function horizontalRadius(shape) {
  if (shape.kind === 'box') return Math.max(shape.box.hx, shape.box.hz)
  if (shape.kind === 'sphere') return shape.sphere.radius
  if (shape.kind === 'mesh') {
    return Math.max((shape.maxX - shape.minX) / 2, (shape.maxZ - shape.minZ) / 2)
  }
  return shape.capsule.radius
}

/** The body's top Y. */
function bodyTopY(shape) {
  if (shape.kind === 'box') return shape.box.maxY
  if (shape.kind === 'sphere') return shape.sphere.y + shape.sphere.radius
  if (shape.kind === 'mesh') return shape.maxY
  return shape.capsule.y + shape.capsule.radius
}

/** Translate a shape (from shapeFromCollider) to a world position (mutates). */
export function translateShape(shape, x, y, z) {
  if (shape.kind === 'box') { shape.box.translate(x, y, z) }
  else if (shape.kind === 'sphere') { shape.sphere.translate(x, y, z) }
  else if (shape.kind === 'pill') { shape.capsule.x = x; shape.capsule.y = y; shape.capsule.z = z }
  else if (shape.kind === 'mesh') {
    const off = meshTranslate(shape, x, y, z)
    shape.minX += off.x; shape.maxX += off.x
    shape.minY += off.y; shape.maxY += off.y
    shape.minZ += off.z; shape.maxZ += off.z
  }
  return shape
}

/**
 * The collider's LOCAL center offset from its entity transform: `[x, y, z]`.
 * Accepts the array form (`center: [x, y, z]`, the component default) or an
 * object form (`center: { x, y, z }`) defensively. Absent/empty → `[0, 0, 0]`
 * (the shape is centered on the transform — legacy behavior, no migration).
 */
export function colliderCenter(c = {}) {
  const ctr = Array.isArray(c.center)
    ? c.center
    : (c.center && typeof c.center === 'object' ? [c.center.x ?? 0, c.center.y ?? 0, c.center.z ?? 0] : null)
  return [ctr?.[0] ?? 0, ctr?.[1] ?? 0, ctr?.[2] ?? 0]
}

/**
 * Read a transform's rotation as an `{x,y,z}` Euler (radians), or null when
 * unrotated. Accepts the `rot` / `rotation` object forms and the legacy `yaw`
 * number — the same inputs the renderer reads (`_rotation`), so a 'render'
 * collider uses the exact rotation the mesh renders with. Absent/zero → null.
 * @param {object} [t] transform component.
 */
export function readRotation(t = {}) {
  // ROT_EPS: residual solver ω noise accumulates into transform.rotation at
  // 1e-11..1e-8 scale — far below any authored rotation (the renderer renders
  // such values as exactly zero). Treating them as rotated flipped resting
  // boxes to MESH shapes (bounds-midpoint OBBs), which unhooked them from the
  // box manifold path and fed phantom lateral pushes. Anything below 1e-7 rad
  // is identity by declaration. (W3 integration, 2026-09-13.)
  const ROT_EPS = 1e-7
  const nz = (v) => (Math.abs(v) >= ROT_EPS ? v : 0)
  if (t.rot && typeof t.rot === 'object') {
    const x = nz(t.rot.x ?? 0), y = nz(t.rot.y ?? 0), z = nz(t.rot.z ?? 0)
    return (x || y || z) ? { x: t.rot.x ?? 0, y: t.rot.y ?? 0, z: t.rot.z ?? 0 } : null
  }
  if (t.rotation && typeof t.rotation === 'object') {
    const x = nz(t.rotation.x ?? 0), y = nz(t.rotation.y ?? 0), z = nz(t.rotation.z ?? 0)
    return (x || y || z) ? { x: t.rotation.x ?? 0, y: t.rotation.y ?? 0, z: t.rotation.z ?? 0 } : null
  }
  if (t.yaw !== undefined && t.yaw) return { x: 0, y: t.yaw, z: 0 }
  return null
}

/**
 * Rotate a local translation offset by an XYZ Euler (radians) — the world-space
 * position of a local `center` offset on a rotated entity. Matches THREE's
 * `Euler(x,y,z)` ('XYZ') rotation. Null/zero rotation returns the offset
 * unchanged.
 */
export function rotateOffset(x, y, z, rot) {
  if (!rot || (!rot.x && !rot.y && !rot.z)) return { x, y, z }
  const c1 = Math.cos(rot.x), s1 = Math.sin(rot.x)
  const c2 = Math.cos(rot.y), s2 = Math.sin(rot.y)
  const c3 = Math.cos(rot.z), s3 = Math.sin(rot.z)
  const m00 = c2 * c3, m01 = -c2 * s3, m02 = s2
  const m10 = c1 * s3 + s1 * s2 * c3, m11 = c1 * c3 - s1 * s2 * s3, m12 = -s1 * c2
  const m20 = s1 * s3 - c1 * s2 * c3, m21 = s1 * c3 + c1 * s2 * s3, m22 = c1 * c2
  return {
    x: m00 * x + m01 * y + m02 * z,
    y: m10 * x + m11 * y + m12 * z,
    z: m20 * x + m21 * y + m22 * z,
  }
}

/** Absolute lowest Y of a WORLD-positioned shape (as returned by translateShape
 * / api.physics.shape). The downward rest extent from the shape's center minus
 * its vertical position — so it accounts for a collider's local `center` offset.
 * Pill: a Capsule is CENTER-origin with `height` the TOTAL height including the
 * hemispherical caps; the true bottom is `y - (coreHalf + radius)`. coreHalf
 * (height/2 - radius) CLAMPS AT 0, so a degenerate pill (height < 2*radius,
 * incl. height 0) bottoms out at `y - radius`, NOT `y - height/2` — the
 * y-(h/2-r)-r = y-h/2 identity holds ONLY for height >= 2*radius. */
export function shapeBottomY(shape) {
  if (shape.kind === 'box') return shape.box.minY
  if (shape.kind === 'sphere') return shape.sphere.y - shape.sphere.radius
  if (shape.kind === 'pill') return shape.capsule.y - (shape.capsule.coreHalf + shape.capsule.radius)
  return shape.minY // mesh
}

/** True if two collider shapes overlap (mixed shapes supported). */
export function shapesOverlap(a, b) {
  const ak = a.kind, bk = b.kind
  if (ak === 'box' && bk === 'box') return a.box.overlaps(b.box)
  if (ak === 'sphere' && bk === 'sphere') return sphereOverlap(a.sphere, b.sphere)
  if (ak === 'pill' && bk === 'pill') return capsuleOverlap(a.capsule, b.capsule)
  if (ak === 'sphere' && bk === 'box') return boxVsSphere(b.box, a.sphere)
  if (ak === 'box' && bk === 'sphere') return boxVsSphere(a.box, b.sphere)
  if (ak === 'pill' && bk === 'box') return boxVsCapsule(b.box, a.capsule)
  if (ak === 'box' && bk === 'pill') return boxVsCapsule(a.box, b.capsule)
  if (ak === 'pill' && bk === 'sphere') return sphereVsCapsule(b.sphere, a.capsule)
  if (ak === 'sphere' && bk === 'pill') return sphereVsCapsule(a.sphere, b.capsule)
  return false
}

/** Raycast a ray against any collider shape. */
export function raycastShape(ray, shape, maxDist = Infinity) {
  if (shape.kind === 'box') return raycastAABB(ray, shape.box, maxDist)
  if (shape.kind === 'sphere') return raycastSphere(ray, shape.sphere, maxDist)
  if (shape.kind === 'pill') return raycastCapsule(ray, shape.capsule, maxDist)
  return meshRaycast(ray, shape, maxDist)
}

/** Downward extent from the shape's center to its lowest point (rest height).
 * Pill: `coreHalf + radius` — the TOTAL capsule height (caps included; coreHalf
 * CLAMPS AT 0, so a degenerate pill — height < 2*radius, incl. height 0 —
 * bottoms at its radius, never below it), never the cap radius alone (T7a: a
 * pill resting on its radius sat sunk by h/2 - r). Mesh: local-origin triangles
 * (shapeFromCollider / rotateTriangles) extend `minY` below the origin, so the
 * downward extent is `-minY` (shapeBottomY(mesh) = minY stays the absolute
 * bottom of a world-positioned mesh). */
export function shapeBottom(shape) {
  if (shape.kind === 'box') return shape.box.hy
  if (shape.kind === 'sphere') return shape.sphere.radius
  if (shape.kind === 'pill') return shape.capsule.coreHalf + shape.capsule.radius
  return -shape.minY // mesh — local-origin: downward extent from the origin
}

/** The shape's horizontal (XZ) footprint for overlap tests. */
export function shapeXZ(shape) {
  if (shape.kind === 'box') return { minX: shape.box.minX, maxX: shape.box.maxX, minZ: shape.box.minZ, maxZ: shape.box.maxZ }
  if (shape.kind === 'sphere') return { minX: shape.sphere.x - shape.sphere.radius, maxX: shape.sphere.x + shape.sphere.radius, minZ: shape.sphere.z - shape.sphere.radius, maxZ: shape.sphere.z + shape.sphere.radius }
  if (shape.kind === 'pill') {
    const c = shape.capsule
    return { minX: c.x - c.radius, maxX: c.x + c.radius, minZ: c.z - c.radius, maxZ: c.z + c.radius }
  }
  return { minX: shape.minX, maxX: shape.maxX, minZ: shape.minZ, maxZ: shape.maxZ } // mesh
}
