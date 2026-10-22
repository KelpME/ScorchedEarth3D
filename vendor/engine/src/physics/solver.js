/**
 * P1 sequential-impulse contact solver — PURE MATH (no world/DOM access).
 * Everything here is Node-testable; the physics system composes it against the
 * live world (see plans/PHYSICS-DEPTH.md §P1).
 *
 * CONVENTIONS:
 *  - Manifold normal points from A to B (pushing B away from A, pulling A
 *    opposite) — same direction as resolveManifold's velocity impulse.
 *  - Cylinder colliders arrive already AABB-mapped (bounding-box approximation,
 *    see shapeFromCollider) — nothing special here.
 *  - P3.5: mesh shapes ARE in the pair table — as OBBs (rot+half on the
 *    shape; an UNROTATED shape is the identity-axes OBB, so box ⊂ OBB).
 *  - OBB manifolds are SINGLE-POINT (B's support point deepest along −n);
 *    multi-point manifolds remain a future refinement (as below).
 *  - Position correction: Baumgarte (bias folded into the velocity solve) over
 *    split-impulse — chosen for P1 simplicity.
 *  - NO Map iteration for ordering anywhere: sortPairs uses a plain stable
 *    sort on a string key.
 *  - contactPair's null is OVERLOADED by contract: it means "no manifold",
 *    covering both non-overlap and unsupported pair kinds (e.g. pill|pill,
 *    mesh) — callers cannot and must not need to distinguish the two.
 *  - NaN contract: inputs are assumed FINITE (the system layer validates);
 *    NaN invMass or velocity propagates silently through the math.
 *  - Single contact point: the system supplies one point per pair (the
 *    midpoint of the two shape centers) — full contact manifolds are a P3+
 *    refinement.
 */
import { Sphere, Capsule } from './physics.js'

/** Friction combine (Box2D-style geometric mean): μ = √(μa·μb). */
export function combineFriction(a, b) { return Math.sqrt(a * b) }

/** Restitution combine: e = max(ea, eb) (the bouncier body wins). */
export function combineRestitution(a, b) { return Math.max(a, b) }

/* ── Contact pair table ──────────────────────────────────────────────────────
 * Supported kinds: 'box' (AABB), 'sphere', 'pill' (vertical capsule). Each
 * handler returns { nx, ny, nz, penetration } with the normal pointing A→B,
 * or null when the shapes don't overlap (symmetric wrappers handle swapped
 * argument order). DEGENERATE-CENTER note: box/box picks the min-overlap axis
 * among x/y/z (input order tie-break — deterministic); sphere/box returns the
 * sphere's own center → closest-point direction, so degeneracy inside a box
 * (center inside, impossible by construction here) can't happen.
 */

/** Closest point on an AABB's surface to a point (0,0,0 distance if inside). */
function closestOnBox(box, px, py, pz) {
  const cx = Math.max(box.minX, Math.min(px, box.maxX))
  const cy = Math.max(box.minY, Math.min(py, box.maxY))
  const cz = Math.max(box.minZ, Math.min(pz, box.maxZ))
  return { x: cx, y: cy, z: cz }
}

/** Manifold from a contact center + normal A→B: unit-normalize, penetration
 * from the sphere/pill radius if the caller passes it, else 0. */
function manifoldFrom(dx, dy, dz, penetration) {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (len < 1e-12) return null // degenerate — same center, no axis
  return { nx: dx / len, ny: dy / len, nz: dz / len, penetration }
}

/** box/box: min-overlap axis (AABB separating axis, axis input-order tie-break). */
function boxVsBox(a, b) {
  const A = a.box, B = b.box
  const ox = Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX)
  const oy = Math.min(A.maxY, B.maxY) - Math.max(A.minY, B.minY)
  const oz = Math.min(A.maxZ, B.maxZ) - Math.max(A.minZ, B.minZ)
  if (ox <= 0 || oy <= 0 || oz <= 0) return null
  if (ox <= oy && ox <= oz) return { nx: B.cx >= A.cx ? 1 : -1, ny: 0, nz: 0, penetration: ox }
  if (oy <= oz) return { nx: 0, ny: B.cy >= A.cy ? 1 : -1, nz: 0, penetration: oy }
  return { nx: 0, ny: 0, nz: B.cz >= A.cz ? 1 : -1, penetration: oz }
}

/** box(A) vs sphere(B): normal from the box's closest surface point to the
 * sphere center; penetration = radius − center distance. */
function boxVsSphere(a, b) {
  const box = a.box, sph = b.sphere
  const c = closestOnBox(box, sph.x, sph.y, sph.z)
  const dx = sph.x - c.x, dy = sph.y - c.y, dz = sph.z - c.z
  const d2 = dx * dx + dy * dy + dz * dz
  if (d2 > sph.radius * sph.radius) return null
  if (d2 > 1e-12) return manifoldFrom(dx, dy, dz, sph.radius - Math.sqrt(d2))
  // Sphere center INSIDE the box: push out along the axis of least penetration.
  const px = Math.min(sph.x - box.minX, box.maxX - sph.x)
  const py = Math.min(sph.y - box.minY, box.maxY - sph.y)
  const pz = Math.min(sph.z - box.minZ, box.maxZ - sph.z)
  const sign = (v) => (v >= 0 ? 1 : -1)
  if (px <= py && px <= pz) return { nx: sign(sph.x - box.cx), ny: 0, nz: 0, penetration: sph.radius + px }
  if (py <= pz) return { nx: 0, ny: sign(sph.y - box.cy), nz: 0, penetration: sph.radius + py }
  return { nx: 0, ny: 0, nz: sign(sph.z - box.cz), penetration: sph.radius + pz }
}

/** sphere/sphere: normal along centers A→B. */
function sphereVsSphere(a, b) {
  const A = a.sphere, B = b.sphere
  const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z
  const r = A.radius + B.radius
  if (dx * dx + dy * dy + dz * dz > r * r) return null
  if (dx * dx + dy * dy + dz * dz < 1e-24) {
    // Coincident centers — no axis; emit +X (deterministic least-commit).
    return { nx: 1, ny: 0, nz: 0, penetration: r }
  }
  return manifoldFrom(dx, dy, dz, r - Math.sqrt(dx * dx + dy * dy + dz * dz))
}

/** Closest point on a capsule's core segment (a→b) to p, with the t of it. */
function closestOnSegment(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const len2 = abx * abx + aby * aby + abz * abz
  let t = len2 === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / len2
  t = Math.max(0, Math.min(1, t))
  return { x: ax + t * abx, y: ay + t * aby, z: az + t * abz, t }
}

/** sphere(A) vs pill(B): normal from the sphere center to the closest point on
 * the pill's core segment (A→B); penetration = rSum − distance. */
function sphereVsCapsule(a, b) {
  const s = a.sphere, c = b.capsule
  const r = s.radius + c.radius
  const cp = closestOnSegment(s.x, s.y, s.z, c.a.x, c.a.y, c.a.z, c.b.x, c.b.y, c.b.z)
  const dx = cp.x - s.x, dy = cp.y - s.y, dz = cp.z - s.z
  if (dx * dx + dy * dy + dz * dz > r * r) return null
  if (dx * dx + dy * dy + dz * dz < 1e-24) {
    // Sphere center on the segment — push out along +Y (the pill's axis).
    return { nx: 0, ny: 1, nz: 0, penetration: r }
  }
  return manifoldFrom(dx, dy, dz, r - Math.sqrt(dx * dx + dy * dy + dz * dz))
}

/** box(A) vs pill(B): closest point on the core segment vs the box surface.
 * APPROXIMATION: the pill's core segment is collapsed to its single closest
 * point to the box center and treated as a sphere of c.radius (segment-as-
 * sphere) — deep/lengthwise overlaps use the sphere answer, not a true
 * capsule-vs-box distance. */
function boxVsCapsule(a, b) {
  const box = a.box, c = b.capsule
  const cp = closestOnSegment(box.cx, box.cy, box.cz, c.a.x, c.a.y, c.a.z, c.b.x, c.b.y, c.b.z)
  // Treat the closest segment point as a sphere of c.radius vs the box.
  const fake = { sphere: new Sphere(cp.x, cp.y, cp.z, c.radius) }
  return boxVsSphere(a, fake)
}

/** pill/pill is NOT in the pair table (P1 scope; still unsupported in P3.5). */
function unsupported() { return null }

/* ── P3.5 W1: rotation-aware OBB manifolds ────────────────────────────────────
 * A rotated box collider is an Oriented Bounding Box: center + 3 unit body
 * axes + half extents. An UNROTATED shape is the identity-axes OBB, so the
 * axis-aligned box is a special case of the OBB SAT (the box|box fast path
 * above stays for the common AABB case).
 *
 * Euler convention: `rot` is {x,y,z} radians matching physics.js readRotation /
 * rotateOffset — THREE 'XYZ' order. eulerMatrix reproduces rotateOffset's
 * matrix EXACTLY (same row expressions); the OBB body axes are its COLUMNS.
 *
 * PILL-AS-OBB (documented approximation): mesh|pill maps the pill to its
 * bounding OBB (half {r, h/2, r}, axes from rot) and runs the 15-axis SAT —
 * NOT a true capsule-vs-OBB distance (segment-rectangle closest-point work
 * per axis judged too heavy for P3.5). mesh|sphere keeps an EXACT
 * closest-point-on-OBB treatment (no bounding-box error).
 */

/** XYZ-Euler ('XYZ', THREE order) rotation matrix — rows identical to
 * physics.js rotateOffset. The OBB body axes are this matrix's COLUMNS. */
function eulerMatrix(rot) {
  const x = rot && rot.x ? rot.x : 0
  const y = rot && rot.y ? rot.y : 0
  const z = rot && rot.z ? rot.z : 0
  const c1 = Math.cos(x), s1 = Math.sin(x)
  const c2 = Math.cos(y), s2 = Math.sin(y)
  const c3 = Math.cos(z), s3 = Math.sin(z)
  return [
    [c2 * c3, -c2 * s3, s2],
    [c1 * s3 + s1 * s2 * c3, c1 * c3 - s1 * s2 * s3, -s1 * c2],
    [s1 * s3 - c1 * s2 * c3, s1 * c3 + c1 * s2 * s3, c1 * c2],
  ]
}

const HALF_KEYS = ['x', 'y', 'z']
const IDENTITY_AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

/**
 * OBB descriptor from a shape: { center, axes (3 unit column vectors), half }.
 *  - box  → AABB center/half, axes from shape.rot (identity when absent)
 *  - pill → BOUNDING-OBB approximation: half {r, h/2, r} (see block note)
 *  - mesh → center = bounds midpoint; half = shape.half when the shape
 *           carries explicit unrotated half extents (the W2 contract), else
 *           the bounds half-extents
 * A shape without rot is the identity-axes OBB (an AABB IS an OBB).
 */
export function obbFromShape(shape) {
  let center, half
  if (shape.kind === 'box') {
    const b = shape.box
    center = { x: b.cx, y: b.cy, z: b.cz }
    half = { x: b.hx, y: b.hy, z: b.hz }
  } else if (shape.kind === 'pill') {
    const c = shape.capsule
    center = { x: c.x, y: c.y, z: c.z }
    half = { x: c.radius, y: c.height / 2, z: c.radius }
  } else {
    // mesh (and any bounds-carrying shape)
    center = {
      x: (shape.minX + shape.maxX) / 2,
      y: (shape.minY + shape.maxY) / 2,
      z: (shape.minZ + shape.maxZ) / 2,
    }
    half = shape.half || {
      x: (shape.maxX - shape.minX) / 2,
      y: (shape.maxY - shape.minY) / 2,
      z: (shape.maxZ - shape.minZ) / 2,
    }
  }
  const R = shape.rot ? eulerMatrix(shape.rot) : IDENTITY_AXES
  const axes = R.map((_, j) => [R[0][j], R[1][j], R[2][j]])
  return { center, axes, half }
}

/**
 * 15-axis SAT between two OBBs (3 A-face + 3 B-face + 9 edge cross axes).
 *  - normal A→B (existing pair convention); penetration = MIN overlap;
 *    tie-break = axis order (A faces, B faces, then edge crosses in
 *    (ia,ib) lexicographic order), first minimal axis wins — the same
 *    input-order determinism as boxVsBox.
 *  - degenerate cross axes (parallel edges, |a×b| < 1e-12) carry no
 *    separation information and are SKIPPED (no NaN can leak).
 *  - contact point: B's support point deepest along −n — a SINGLE-POINT
 *    manifold (documented P3.5 approximation; multi-point manifolds are a
 *    future refinement).
 * @returns {{ nx,ny,nz, penetration, px,py,pz } | null}
 */
export function obbSAT(A, B) {
  const d = [
    B.center.x - A.center.x,
    B.center.y - A.center.y,
    B.center.z - A.center.z,
  ]
  const axes = [A.axes[0], A.axes[1], A.axes[2], B.axes[0], B.axes[1], B.axes[2]]
  for (let ia = 0; ia < 3; ia++) {
    for (let ib = 0; ib < 3; ib++) {
      const a = A.axes[ia], b = B.axes[ib]
      const cx = a[1] * b[2] - a[2] * b[1]
      const cy = a[2] * b[0] - a[0] * b[2]
      const cz = a[0] * b[1] - a[1] * b[0]
      const n = Math.sqrt(cx * cx + cy * cy + cz * cz)
      if (n >= 1e-12) axes.push([cx / n, cy / n, cz / n])
    }
  }
  let best = 0, bestL = null, bestRb = 0, bestDl = 0
  for (let i = 0; i < axes.length; i++) {
    const L = axes[i]
    let ra = 0, rb = 0
    for (let k = 0; k < 3; k++) {
      ra += A.half[HALF_KEYS[k]] * Math.abs(A.axes[k][0] * L[0] + A.axes[k][1] * L[1] + A.axes[k][2] * L[2])
      rb += B.half[HALF_KEYS[k]] * Math.abs(B.axes[k][0] * L[0] + B.axes[k][1] * L[1] + B.axes[k][2] * L[2])
    }
    const dl = d[0] * L[0] + d[1] * L[1] + d[2] * L[2]
    const ov = ra + rb - Math.abs(dl)
    if (ov <= 0) return null
    if (!bestL || ov < best - 1e-15) { best = ov; bestL = L; bestRb = rb; bestDl = dl }
  }
  const s = bestDl >= 0 ? 1 : -1
  const nx = bestL[0] * s, ny = bestL[1] * s, nz = bestL[2] * s
  return {
    nx, ny, nz,
    penetration: best,
    px: B.center.x - nx * bestRb,
    py: B.center.y - ny * bestRb,
    pz: B.center.z - nz * bestRb,
  }
}

/** mesh|mesh, mesh|box, mesh|pill: both sides through obbFromShape → SAT.
 * obbSAT is order-safe (normal always first→second arg), so this one handler
 * serves both pair orders without a negating wrapper. */
function obbPair(a, b) {
  return obbSAT(obbFromShape(a), obbFromShape(b))
}

/** mesh|sphere: closest point on the OBB's surface to the sphere center
 * (exact — boxVsSphere's treatment, in the OBB's local frame). */
function meshVsSphere(a, b) {
  const obb = obbFromShape(a)
  const s = b.sphere
  const rel = [s.x - obb.center.x, s.y - obb.center.y, s.z - obb.center.z]
  const local = [0, 0, 0], clamped = [0, 0, 0]
  const cp = [obb.center.x, obb.center.y, obb.center.z]
  for (let k = 0; k < 3; k++) {
    local[k] = rel[0] * obb.axes[k][0] + rel[1] * obb.axes[k][1] + rel[2] * obb.axes[k][2]
    const h = obb.half[HALF_KEYS[k]]
    clamped[k] = Math.max(-h, Math.min(h, local[k]))
    cp[0] += clamped[k] * obb.axes[k][0]
    cp[1] += clamped[k] * obb.axes[k][1]
    cp[2] += clamped[k] * obb.axes[k][2]
  }
  const dx = s.x - cp[0], dy = s.y - cp[1], dz = s.z - cp[2]
  const d2 = dx * dx + dy * dy + dz * dz
  if (d2 > s.radius * s.radius) return null
  if (d2 > 1e-12) return manifoldFrom(dx, dy, dz, s.radius - Math.sqrt(d2))
  // Sphere center INSIDE the OBB: push out along the least-penetration body
  // axis (sign = local-coordinate sign; input-order tie-break x,y,z).
  const px = obb.half.x - Math.abs(local[0])
  const py = obb.half.y - Math.abs(local[1])
  const pz = obb.half.z - Math.abs(local[2])
  const sg = (v) => (v >= 0 ? 1 : -1)
  if (px <= py && px <= pz) {
    return { nx: obb.axes[0][0] * sg(local[0]), ny: obb.axes[0][1] * sg(local[0]), nz: obb.axes[0][2] * sg(local[0]), penetration: s.radius + px }
  }
  if (py <= pz) {
    return { nx: obb.axes[1][0] * sg(local[1]), ny: obb.axes[1][1] * sg(local[1]), nz: obb.axes[1][2] * sg(local[1]), penetration: s.radius + py }
  }
  return { nx: obb.axes[2][0] * sg(local[2]), ny: obb.axes[2][1] * sg(local[2]), nz: obb.axes[2][2] * sg(local[2]), penetration: s.radius + pz }
}

/** sphere|mesh: meshVsSphere's normal is mesh→sphere; negate for A=sphere. */
function sphereVsMesh(a, b) {
  const m = meshVsSphere(b, a)
  if (!m) return null
  const out = { nx: -m.nx, ny: -m.ny, nz: -m.nz, penetration: m.penetration }
  if (m.px !== undefined) { out.px = m.px; out.py = m.py; out.pz = m.pz }
  return out
}

const PAIRS = {
  'box|box': boxVsBox,
  'box|sphere': boxVsSphere,
  'sphere|sphere': sphereVsSphere,
  'sphere|pill': sphereVsCapsule,
  'box|pill': boxVsCapsule,
  // P3.5: mesh shapes dispatch as OBBs (identity axes when unrotated — an
  // AABB is the special case). obbPair is order-safe; sphereVsMesh negates.
  'mesh|mesh': obbPair,
  'mesh|box': obbPair,
  'box|mesh': obbPair,
  'mesh|pill': obbPair,
  'pill|mesh': obbPair,
  'mesh|sphere': meshVsSphere,
  'sphere|mesh': sphereVsMesh,
}

/**
 * Broad contact entry: builds the pair key from shape kinds and dispatches.
 * `cylinder` shapes arrive pre-mapped to kind 'box' (shapeFromCollider). Mesh
 * shapes dispatch through the P3.5 OBB/SAT path (obbFromShape/obbSAT):
 * mesh|mesh, mesh|box, mesh|pill (pill mapped to its bounding OBB — see the
 * obbFromShape note) and mesh|sphere (exact closest-point-on-OBB).
 * @returns {{ nx, ny, nz, penetration } | null} manifold (normal A→B) or null.
 */
export function contactPair(shapeA, shapeB) {
  const fn = PAIRS[`${shapeA.kind}|${shapeB.kind}`]
  if (fn) return fn(shapeA, shapeB)
  // Swapped-order symmetric wrappers — negate the swapped result's normal so
  // it still points A→B (argument A to argument B), per the header convention.
  const swap = PAIRS[`${shapeB.kind}|${shapeA.kind}`]
  if (swap) {
    const m = swap(shapeB, shapeA)
    return m ? { nx: -m.nx, ny: -m.ny, nz: -m.nz, penetration: m.penetration } : null
  }
  return unsupported()
}

/** Position-correction constants (Baumgarte). system.js pins its copies to
 * these via a drift-guard test — change both together or break that test. */
export const SOLVER_SLOP = 0.005
export const SOLVER_PERCENT = 0.2

/* ── P2 angular dynamics ────────────────────────────────────────────────────── */

/**
 * Diagonal INVERSE inertia tensor for a collider shape (P2).
 * Heuristics (documented):
 *  - box    → exact m/12·(b²+c²) per axis from the FULL extents (a = 2hx etc.)
 *  - sphere → 2/5·m·r² on every axis
 *  - pill   → Y axis the exact 2/5·m·r² (core + caps agree); X/Z the
 *             density-weighted core+caps integral (see the formula below)
 *  - cylinder → its mapped bounding AABB (hx = r, hy = h/2, hz = r — the same
 *             mapping shapeFromCollider uses)
 *  - mesh   → bounding-box heuristic: AABB of the shape's min/max (tri bounds)
 *             treated as a box diagonal.
 * mass ≤ 0 (or non-finite) → null (infinite mass — the body never spins).
 * @param {object} shape a collider shape ({ kind, box|sphere|capsule, ... })
 * @param {number} mass positive mass in kg
 * @returns {{ ix, iy, iz } | null} the INVERSE inertia diagonal. invInertia is
 *   body-frame diagonal; NOT rotated into world frame as orientation changes —
 *   world-axis-aligned approximation (P3 candidate).
 */
export function inertiaTensor(shape, mass) {
  if (!(typeof mass === 'number' && Number.isFinite(mass) && mass > 0)) return null
  if (!shape || typeof shape !== 'object') return null
  const boxInv = (hx, hy, hz) => ({
    ix: 1 / ((mass / 12) * 4 * (hy * hy + hz * hz)),
    iy: 1 / ((mass / 12) * 4 * (hx * hx + hz * hz)),
    iz: 1 / ((mass / 12) * 4 * (hx * hx + hy * hy)),
  })
  if (shape.kind === 'box') {
    const b = shape.box
    return boxInv(b.hx, b.hy, b.hz)
  }
  if (shape.kind === 'sphere') {
    const I = (2 / 5) * mass * shape.sphere.radius * shape.sphere.radius
    return { ix: 1 / I, iy: 1 / I, iz: 1 / I }
  }
  if (shape.kind === 'pill') {
    // Core-cylinder + spherical-cap integral, density-weighted by volume.
    const r = shape.capsule.radius, h = shape.capsule.height
    const a = Math.max(h / 2 - r, 0), d = a + r / 2
    const Vc = Math.PI * r * r * 2 * a, Vcap = (4 / 3) * Math.PI * r ** 3
    const mc = mass * Vc / (Vc + Vcap), mcap = mass * Vcap / (Vc + Vcap)
    const Iy = (2 / 5) * mass * r * r
    const Ix = mc * (r * r / 4 + (a * a) / 3) + mc * a * a + 2 * (mcap * r * r / 4 + mcap * d * d)
    return { ix: 1 / Ix, iy: 1 / Iy, iz: 1 / Ix }
  }
  if (shape.kind === 'cylinder') {
    // Cylinder → its mapped AABB (shapeFromCollider): hx = r, hy = h/2, hz = r.
    const r = shape.radius ?? 0.5, h = shape.height ?? 1
    return boxInv(r, h / 2, r)
  }
  if (shape.kind === 'mesh') {
    // Bounding-box heuristic: the mesh's own min/max (tri bounds) → box diagonal.
    const hx = shape.maxX !== undefined ? (shape.maxX - shape.minX) / 2 : 0.5
    const hy = shape.maxY !== undefined ? (shape.maxY - shape.minY) / 2 : 0.5
    const hz = shape.maxZ !== undefined ? (shape.maxZ - shape.minZ) / 2 : 0.5
    return boxInv(hx, hy, hz)
  }
  return null
}

/** Cross product a×b as [x, y, z]. */
function cross3(ax, ay, az, bx, by, bz) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]
}

/** Angular-field presence probe: a body opts into angular dynamics by carrying
 * ANY of the angular fields (ω, inverse inertia, center of mass). */
const ANGULAR_KEYS = ['wx', 'wy', 'wz', 'invInertia', 'invInertia3x3', 'cx', 'cy', 'cz']
function isAngularBody(b) {
  for (let i = 0; i < ANGULAR_KEYS.length; i++) {
    if (b[ANGULAR_KEYS[i]] !== undefined) return true
  }
  return false
}

/**
 * Effective inverse inertia for one body: a 3-ARRAY of per-axis values in the
 * DIAGONAL path, or a 3×3 row-major tensor in the WORLD-FRAME path (P3.5 W3).
 *  - legacy  { invInertia: {ix,iy,iz} } → per-axis diagonal, rot-locked axes
 *    (and null/absent tensors) zeroed — mirrors the per-axis position-lock
 *    pattern, back-compat exact.
 *  - world   { invInertia3x3: {xx..zz} } → the FULL tensor (already in world
 *    frame, built by worldInvInertia); the matrix is scaled by the rot-lock
 *    mask: a rot-locked axis zeroed means no torque may spin that body axis,
 *    implemented as M' = S·M·S (S = diag(lock mask)).
 * Returns { kind: 'diag'|'mat', v } — v is a 3-array or a row-major 3×3.
 */
function effInvTensor(body, lock) {
  const M = body.invInertia3x3
  if (M && typeof M === 'object') {
    const s = [
      lock.has('rotX') ? 0 : 1,
      lock.has('rotY') ? 0 : 1,
      lock.has('rotZ') ? 0 : 1,
    ]
    // S·M·S with row-major M: row i kept iff s[i], col j kept iff s[j].
    const out = [0, 0, 0, 0, 0, 0, 0, 0, 0]
    const k = ['xx', 'xy', 'xz', 'yx', 'yy', 'yz', 'zx', 'zy', 'zz']
    for (let i = 0; i < 3; i++) {
      if (!s[i]) continue
      for (let j = 0; j < 3; j++) {
        if (!s[j]) continue
        out[i * 3 + j] = M[k[i * 3 + j]] ?? 0
      }
    }
    return { kind: 'mat', v: out }
  }
  const I = body.invInertia
  if (!I || typeof I !== 'object') return { kind: 'diag', v: [0, 0, 0] }
  return {
    kind: 'diag',
    v: [
      lock.has('rotX') ? 0 : (I.ix ?? 0),
      lock.has('rotY') ? 0 : (I.iy ?? 0),
      lock.has('rotZ') ? 0 : (I.iz ?? 0),
    ],
  }
}

/** I⁻¹·v shared by the solver and the system: v is a 3-array, I⁻¹ either a
 * row-major 3×3 (9 numbers from worldInvInertia) or a 3-array diagonal.
 * @returns {[number, number, number]} */
export function applyInvInertia(Iinv, vec) {
  if (Array.isArray(Iinv)) {
    return [Iinv[0] * vec[0], Iinv[1] * vec[1], Iinv[2] * vec[2]]
  }
  const k = ['xx', 'xy', 'xz', 'yx', 'yy', 'yz', 'zx', 'zy', 'zz']
  return [0, 1, 2].map((i) =>
    (Iinv[k[i * 3]] ?? 0) * vec[0] +
    (Iinv[k[i * 3 + 1]] ?? 0) * vec[1] +
    (Iinv[k[i * 3 + 2]] ?? 0) * vec[2]
  )
}

/** angK = (r×n)ᵀ·I⁻¹·(r×n) for the effective tensor shape from effInvTensor. */
function angTerm(t, rxn) {
  if (t.kind === 'diag') {
    return rxn[0] * rxn[0] * t.v[0] + rxn[1] * rxn[1] * t.v[1] + rxn[2] * rxn[2] * t.v[2]
  }
  const M = t.v
  const Mv = [
    M[0] * rxn[0] + M[1] * rxn[1] + M[2] * rxn[2],
    M[3] * rxn[0] + M[4] * rxn[1] + M[5] * rxn[2],
    M[6] * rxn[0] + M[7] * rxn[1] + M[8] * rxn[2],
  ]
  return rxn[0] * Mv[0] + rxn[1] * Mv[1] + rxn[2] * Mv[2]
}

/** Δω = I⁻¹·(r×J) for the effective tensor shape from effInvTensor. */
function angDelta(t, rxJ) {
  if (t.kind === 'diag') {
    return [rxJ[0] * t.v[0], rxJ[1] * t.v[1], rxJ[2] * t.v[2]]
  }
  const M = t.v
  return [
    M[0] * rxJ[0] + M[1] * rxJ[1] + M[2] * rxJ[2],
    M[3] * rxJ[0] + M[4] * rxJ[1] + M[5] * rxJ[2],
    M[6] * rxJ[0] + M[7] * rxJ[1] + M[8] * rxJ[2],
  ]
}

/**
 * Sequential-impulse velocity response for one contact — PURE (no mutation).
 *
 * P2 ANGULAR EXTENSION: bodies may carry optional angular fields
 *   { wx,wy,wz, invInertia: {ix,iy,iz}|null, cx,cy,cz (center of mass),
 *     lockFlags += 'rotX'|'rotY'|'rotZ' }
 * P3.5 W3: alternatively (or additionally) invInertia3x3: {xx..zz} — a FULL
 *   3×3 WORLD-frame inverse inertia (from worldInvInertia). When present it
 *   takes precedence: the angular K term and the Δω applications use the
 *   full tensor (r×n)ᵀ·I⁻¹·(r×n) and I⁻¹·(r×J) instead of the per-axis
 *   diagonal (rot-lock still zeroes the locked body axes).
 * and the manifold may carry a contact point { px,py,pz }. When it does:
 *   rA = p − cA, rB = p − cB (both ZERO when no contact point → the legacy
 *   linear-only answer). The contact-relative velocity gains the ω×r terms,
 *   the effective mass K gains the (r×n)²·I⁻¹ angular terms (per-axis, with
 *   rot-locked axes zeroed), and the impulses apply torques
 *   Δωa = Ia⁻¹·(rA×(−J)), Δωb = Ib⁻¹·(rB×J). Friction uses the same tangent
 *   impulse and the same μ·jn Coulomb cone, torque included.
 * OUTPUT: 12-key { vax..vbz, wax..wbz } when either body carries angular
 * fields or the manifold has a contact point; the EXACT legacy 6-key
 * otherwise (back-compat). K ≤ 0 → everything returned unchanged.
 *
 * @param {object} bodyA { vx,vy,vz, invMass, lockFlags?, wx?,...,invInertia?,cx? }
 * @param {object} bodyB same shape as bodyA
 * @param {object} manifold { nx,ny,nz, penetration, px?,py?,pz? } — normal A→B.
 * @param {object} opts { restitution, friction, slop = 0.005, percent = 0.2 }
 *   restitution/friction are PRE-COMBINED by the caller (combineFriction /
 *   combineRestitution live in the system's pair loop, not here).
 *   Baumgarte bias: bias = (percent/dt) · max(penetration − slop, 0) — folded
 *   into the target relative normal velocity.
 * @returns {object} the NEW velocities (6-key legacy) or velocities+spin
 *   (12-key angular).
 */
export function resolveManifold(bodyA, bodyB, manifold, opts = {}) {
  const { nx, ny, nz, penetration = 0 } = manifold
  const restitution = opts.restitution ?? 0
  const friction = opts.friction ?? 0
  const slop = opts.slop ?? SOLVER_SLOP
  const percent = opts.percent ?? SOLVER_PERCENT
  const dt = opts.dt ?? (1 / 60)
  const lockA = new Set(bodyA.lockFlags || [])
  const lockB = new Set(bodyB.lockFlags || [])

  const angular = isAngularBody(bodyA) || isAngularBody(bodyB) ||
    (manifold.px !== undefined && manifold.py !== undefined && manifold.pz !== undefined)
  const hasP = manifold.px !== undefined && manifold.py !== undefined && manifold.pz !== undefined

  // Per-axis effective inverse mass: 0 where the axis is position-locked
  // (treat invMass 0 for the velocity response on locked axes).
  const invMassA = (axis) => (lockA.has(`pos${axis}`) ? 0 : bodyA.invMass)
  const invMassB = (axis) => (lockB.has(`pos${axis}`) ? 0 : bodyB.invMass)

  // Contact-point lever arms (zero when no contact point → linear-only).
  const rAx = hasP ? manifold.px - (bodyA.cx || 0) : 0
  const rAy = hasP ? manifold.py - (bodyA.cy || 0) : 0
  const rAz = hasP ? manifold.pz - (bodyA.cz || 0) : 0
  const rBx = hasP ? manifold.px - (bodyB.cx || 0) : 0
  const rBy = hasP ? manifold.py - (bodyB.cy || 0) : 0
  const rBz = hasP ? manifold.pz - (bodyB.cz || 0) : 0
  const iIA = angular ? effInvTensor(bodyA, lockA) : { kind: 'diag', v: [0, 0, 0] }
  const iIB = angular ? effInvTensor(bodyB, lockB) : { kind: 'diag', v: [0, 0, 0] }

  const vax = bodyA.vx, vay = bodyA.vy, vaz = bodyA.vz
  const vbx = bodyB.vx, vby = bodyB.vy, vbz = bodyB.vz
  const wax = Number.isFinite(bodyA.wx) ? bodyA.wx : 0
  const way = Number.isFinite(bodyA.wy) ? bodyA.wy : 0
  const waz = Number.isFinite(bodyA.wz) ? bodyA.wz : 0
  const wbx = Number.isFinite(bodyB.wx) ? bodyB.wx : 0
  const wby = Number.isFinite(bodyB.wy) ? bodyB.wy : 0
  const wbz = Number.isFinite(bodyB.wz) ? bodyB.wz : 0

  // Relative velocity at the contact (B relative to A, normal A→B),
  // including the surface-velocity ω×r terms.
  const wxaA = way * rAz - waz * rAy, wyaA = waz * rAx - wax * rAz, wzaA = wax * rAy - way * rAx
  const wxaB = wby * rBz - wbz * rBy, wybB = wbz * rBx - wbx * rBz, wzbB = wbx * rBy - wby * rBx
  const rvx = (vbx + wxaB) - (vax + wxaA)
  const rvy = (vby + wybB) - (vay + wyaA)
  const rvz = (vbz + wzbB) - (vaz + wzaA)
  const vn = rvx * nx + rvy * ny + rvz * nz

  // Denominator on the contact axes (X, Y, Z each may differ if locked) plus
  // the angular terms (r×n)²·I⁻¹ per axis.
  const iAx = invMassA('X'), iAy = invMassA('Y'), iAz = invMassA('Z')
  const iBx = invMassB('X'), iBy = invMassB('Y'), iBz = invMassB('Z')
  const xn = cross3(rAx, rAy, rAz, nx, ny, nz)
  const xnB = cross3(rBx, rBy, rBz, nx, ny, nz)
  const angK = angTerm(iIA, xn) + angTerm(iIB, xnB)
  const denom = iAx * nx * nx + iAy * ny * ny + iAz * nz * nz
    + iBx * nx * nx + iBy * ny * ny + iBz * nz * nz
    + angK
  if (denom <= 0) {
    // Both fully locked on the contact axes — nothing can respond.
    return angular
      ? { vax, vay, vaz, vbx, vby, vbz, wax, way, waz, wbx, wby, wbz }
      : { vax, vay, vaz, vbx, vby, vbz }
  }

  // Baumgarte position bias (folded into the velocity target).
  const bias = (percent / dt) * Math.max(penetration - slop, 0)

  // Normal impulse: restitution drives the relative normal velocity to
  // −e·vn; the Baumgarte bias adds separation along +n. Combined:
  //   jn = ( −(1+e)·vn + bias ) / K,  clamped jn ≥ 0.
  let jn = (-(1 + restitution) * vn + bias) / denom
  if (jn < 0) jn = 0

  // Apply the normal impulse (linear Δv and the torque pair Δω = I⁻¹·(r×∓J)).
  const Jx = jn * nx, Jy = jn * ny, Jz = jn * nz
  let nvax = vax - Jx * iAx, nvay = vay - Jy * iAy, nvaz = vaz - Jz * iAz
  let nvbx = vbx + Jx * iBx, nvby = vby + Jy * iBy, nvbz = vbz + Jz * iBz
  const rAxJ = cross3(rAx, rAy, rAz, -Jx, -Jy, -Jz)
  const rBxJ = cross3(rBx, rBy, rBz, Jx, Jy, Jz)
  const dA = angDelta(iIA, rAxJ), dB = angDelta(iIB, rBxJ)
  let nwax = wax + dA[0], nway = way + dA[1], nwaz = waz + dA[2]
  let nwbx = wbx + dB[0], nwby = wby + dB[1], nwbz = wbz + dB[2]

  // Friction: Coulomb cone |jt| ≤ μ·jn, tangent ⊥ normal (torque included).
  const rvx2 = (nvbx + (nwby * rBz - nwbz * rBy)) - (nvax + (nway * rAz - nwaz * rAy))
  const rvy2 = (nvby + (nwbz * rBx - nwbx * rBz)) - (nvay + (nwaz * rAx - nwax * rAz))
  const rvz2 = (nvbz + (nwbx * rBy - nwby * rBx)) - (nvaz + (nwax * rAy - nway * rAx))
  const vn2 = rvx2 * nx + rvy2 * ny + rvz2 * nz
  let tx = rvx2 - vn2 * nx, ty = rvy2 - vn2 * ny, tz = rvz2 - vn2 * nz
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz)
  if (tl > 1e-12 && friction > 0) {
    tx /= tl; ty /= tl; tz /= tl
    const xtA = cross3(rAx, rAy, rAz, tx, ty, tz)
    const xtB = cross3(rBx, rBy, rBz, tx, ty, tz)
    const tAngK = angTerm(iIA, xtA) + angTerm(iIB, xtB)
    const tDenom = iAx * tx * tx + iAy * ty * ty + iAz * tz * tz
      + iBx * tx * tx + iBy * ty * ty + iBz * tz * tz
      + tAngK
    if (tDenom > 0) {
      const jt = -tl / tDenom // impulse to stop tangential motion
      const maxJt = friction * jn // Coulomb clamp
      const jtc = Math.max(-maxJt, Math.min(maxJt, jt))
      const jfx = jtc * tx, jfy = jtc * ty, jfz = jtc * tz
      nvax -= jfx * iAx; nvay -= jfy * iAy; nvaz -= jfz * iAz
      nvbx += jfx * iBx; nvby += jfy * iBy; nvbz += jfz * iBz
      const rAxJf = cross3(rAx, rAy, rAz, -jfx, -jfy, -jfz)
      const rBxJf = cross3(rBx, rBy, rBz, jfx, jfy, jfz)
      const fA = angDelta(iIA, rAxJf), fB = angDelta(iIB, rBxJf)
      nwax += fA[0]; nway += fA[1]; nwaz += fA[2]
      nwbx += fB[0]; nwby += fB[1]; nwbz += fB[2]
    }
  }

  return angular
    ? { vax: nvax, vay: nvay, vaz: nvaz, vbx: nvbx, vby: nvby, vbz: nvbz, wax: nwax, way: nway, waz: nwaz, wbx: nwbx, wby: nwby, wbz: nwbz }
    : { vax: nvax, vay: nvay, vaz: nvaz, vbx: nvbx, vby: nvby, vbz: nvbz }
}

/**
 * WORLD-frame INVERSE inertia tensor (P3.5 W3): I_world⁻¹ = R·diag(inv)·Rᵀ
 * where diag(inv) is the BODY-frame diagonal from inertiaTensor and R is the
 * rotation from shape.rot (identity when absent — R·diag·Rᵀ = diag, the
 * legacy behavior). Row-major {xx,xy,xz,yx,yy,yz,zx,zy,zz}; null for
 * infinite mass (mass ≤ 0 / non-finite / unsupported shape — matching
 * inertiaTensor's contract). Static helper `applyInvInertia` multiplies it.
 */
export function worldInvInertia(shape, mass) {
  const diag = inertiaTensor(shape, mass)
  if (!diag) return null
  const R = shape && shape.rot ? eulerMatrix(shape.rot) : null
  if (!R) {
    return {
      xx: diag.ix, xy: 0, xz: 0,
      yx: 0, yy: diag.iy, yz: 0,
      zx: 0, zy: 0, zz: diag.iz,
    }
  }
  const d = [diag.ix, diag.iy, diag.iz]
  // M = R·diag(d)·Rᵀ: M[i][j] = Σ_k R[i][k]·d[k]·R[j][k]
  const M = [
    [
      R[0][0] * d[0] * R[0][0] + R[0][1] * d[1] * R[0][1] + R[0][2] * d[2] * R[0][2],
      R[0][0] * d[0] * R[1][0] + R[0][1] * d[1] * R[1][1] + R[0][2] * d[2] * R[1][2],
      R[0][0] * d[0] * R[2][0] + R[0][1] * d[1] * R[2][1] + R[0][2] * d[2] * R[2][2],
    ],
    [
      R[1][0] * d[0] * R[0][0] + R[1][1] * d[1] * R[0][1] + R[1][2] * d[2] * R[0][2],
      R[1][0] * d[0] * R[1][0] + R[1][1] * d[1] * R[1][1] + R[1][2] * d[2] * R[1][2],
      R[1][0] * d[0] * R[2][0] + R[1][1] * d[1] * R[2][1] + R[1][2] * d[2] * R[2][2],
    ],
    [
      R[2][0] * d[0] * R[0][0] + R[2][1] * d[1] * R[0][1] + R[2][2] * d[2] * R[0][2],
      R[2][0] * d[0] * R[1][0] + R[2][1] * d[1] * R[1][1] + R[2][2] * d[2] * R[1][2],
      R[2][0] * d[0] * R[2][0] + R[2][1] * d[1] * R[2][1] + R[2][2] * d[2] * R[2][2],
    ],
  ]
  return {
    xx: M[0][0], xy: M[0][1], xz: M[0][2],
    yx: M[1][0], yy: M[1][1], yz: M[1][2],
    zx: M[2][0], zy: M[2][1], zz: M[2][2],
  }
}

/**
 * Max per-step displacement before a shape can tunnel through geometry of its
 * own scale: HALF the shape's minimum extent.
 *   box   → min(hx, hy, hz)
 *   sphere → radius
 *   pill  → radius
 * Mesh shapes: not clamped here (statics; the system handles them).
 */
export function tunnelingClamp(shape) {
  if (shape.kind === 'box') {
    const b = shape.box
    return Math.min(b.hx, b.hy, b.hz)
  }
  if (shape.kind === 'sphere') return shape.sphere.radius
  if (shape.kind === 'pill') return shape.capsule.radius
  // W5: dynamic mesh bodies (rotated boxes via buildMeshShape) get a clamp =
  // half of their bbox's minimum full dimension. Statics are unaffected in
  // practice — their displacement is never integrated.
  if (shape.kind === 'mesh') {
    return Math.min((shape.maxX - shape.minX) / 2, (shape.maxY - shape.minY) / 2, (shape.maxZ - shape.minZ) / 2)
  }
  return Infinity // unsupported — no clamp
}

/**
 * Substeps needed so per-step displacement stays within tunnelingClamp.
 * Simple deterministic formula: the LARGEST per-axis magnitude ratio,
 *   n = ceil( max(|dx|/max, |dy|/max, |dz|/max) ) , min 1.
 * (max-norm of the step / max allowed step — cheap and axis-conservative.)
 */
export function substepsNeeded(shape, dx, dy, dz) {
  const max = tunnelingClamp(shape)
  if (!isFinite(max) || max <= 0) return 1
  const m = Math.max(Math.abs(dx) / max, Math.abs(dy) / max, Math.abs(dz) / max)
  return Math.max(1, Math.ceil(m - 1e-12))
}

/**
 * Stable pair ordering by canonical entity-id key `a|b` (sorted). No Map
 * iteration anywhere — Array.prototype.sort is stable (ES2019+).
 * @param {{ a: string, b: string }[]} pairs
 * @returns {{ a: string, b: string }[]} a NEW sorted array (input untouched).
 */
export function sortPairs(pairs) {
  return pairs
    .map((p) => ({ key: p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`, p }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    .map((e) => e.p)
}

/* ── P3.5 W2: accumulating contact-constraint pipeline ────────────────────────
 * Replaces the per-sweep NON-accumulating resolveManifold solve with a
 * per-point constraint that ACCUMULATES impulses (accumulate-then-clamp) and
 * warm-starts from the persistent contact cache. resolveManifold stays for
 * back-compat; system.js switchover is W3.
 *
 * Conventions (inherited): normal A→B; bodies are plain descriptor objects
 * { vx,vy,vz, invMass, cx?,cy?,cz?, wx?,wy?,wz?, invInertia?, invInertia3x3?,
 *   lockFlags? } — the solver MUTATES the velocity/spin fields of the
 * descriptors it is given (pure math otherwise, no module state).
 * Position fields are NOT touched (positional repair is solveManifoldPosition,
 * which returns deltas for the caller to apply).
 */

/** Deterministic tangent basis for a unit normal n.
 * t1 = normalize(n × worldUp), worldUp = (0,1,0) unless |n.y| > 0.99 then
 * (1,0,0); t2 = n × t1. For n = (0,1,0): t1 = (0,0,−1), t2 = (1,0,0)
 * (documented choice — same every call, no RNG).
 * @returns {{ t1: number[], t2: number[] }} */
export function tangentBasis(nx, ny, nz) {
  const ux = Math.abs(ny) > 0.99 ? 1 : 0
  const uy = Math.abs(ny) > 0.99 ? 0 : 1
  // t1 = n × up (already unit when n ⊥ up; renormalize anyway)
  let t1 = cross3(nx, ny, nz, ux, uy, 0)
  const l = Math.hypot(t1[0], t1[1], t1[2])
  if (l < 1e-12) t1 = [1, 0, 0] // unreachable for a unit n — least-commit guard
  else t1 = [t1[0] / l, t1[1] / l, t1[2] / l]
  const t2 = cross3(nx, ny, nz, t1[0], t1[1], t1[2])
  return { t1, t2 }
}

/**
 * Build one contact constraint from a manifold point — precomputes everything
 * the velocity solve needs (PURE; no body mutation here).
 * @param {object} bodyA descriptor (see module block)
 * @param {object} bodyB descriptor
 * @param {object} point { px,py,pz, ... } contact point (world)
 * @param {{ x,y,z }} manifoldNormal unit normal A→B
 * @param {object} [opts] { friction = 0, restitution = 0, applyRestitution =
 *   true (fold restTarget = −e·vn0 — vn0 is the PRE-SOLVE relative normal
 *   velocity, so restitution is first-sweep-only by construction), bias (the
 *   Baumgarte bias velocity, precomputed by the caller), warmNormal,
 *   warmT1, warmT2 (initial accumulated impulses) }
 * @returns constraint object (mutated by solveContactConstraint)
 */
export function buildContactConstraint(bodyA, bodyB, point, manifoldNormal, opts = {}) {
  const nx = manifoldNormal.x, ny = manifoldNormal.y, nz = manifoldNormal.z
  const { t1, t2 } = tangentBasis(nx, ny, nz)
  const lockA = new Set(bodyA.lockFlags || [])
  const lockB = new Set(bodyB.lockFlags || [])
  const iAx = lockA.has('posX') ? 0 : (bodyA.invMass || 0)
  const iAy = lockA.has('posY') ? 0 : (bodyA.invMass || 0)
  const iAz = lockA.has('posZ') ? 0 : (bodyA.invMass || 0)
  const iBx = lockB.has('posX') ? 0 : (bodyB.invMass || 0)
  const iBy = lockB.has('posY') ? 0 : (bodyB.invMass || 0)
  const iBz = lockB.has('posZ') ? 0 : (bodyB.invMass || 0)
  const rAx = point.px - (bodyA.cx || 0), rAy = point.py - (bodyA.cy || 0), rAz = point.pz - (bodyA.cz || 0)
  const rBx = point.px - (bodyB.cx || 0), rBy = point.py - (bodyB.cy || 0), rBz = point.pz - (bodyB.cz || 0)
  const tA = effInvTensor(bodyA, lockA)
  const tB = effInvTensor(bodyB, lockB)

  // Effective masses along n, t1, t2.
  const dirs = [[nx, ny, nz], t1, t2]
  const Ks = dirs.map((d) => {
    const rxnA = cross3(rAx, rAy, rAz, d[0], d[1], d[2])
    const rxnB = cross3(rBx, rBy, rBz, d[0], d[1], d[2])
    return iAx * d[0] * d[0] + iAy * d[1] * d[1] + iAz * d[2] * d[2]
      + iBx * d[0] * d[0] + iBy * d[1] * d[1] + iBz * d[2] * d[2]
      + angTerm(tA, rxnA) + angTerm(tB, rxnB)
  })

  // Restitution target from the PRE-SOLVE relative normal velocity (baked, so
  // later sweeps cannot re-inject bounce energy). Two guards:
  //  - opts.restTargetOverride: pin the baked target across the caller's
  //    per-sweep solve calls (call 2+ would otherwise re-derive restTarget
  //    from the post-impulse velocity, sign flipped, and cancel the bounce).
  //  - Restitution velocity threshold (Box2D-style): a resting contact
  //    re-penetrates at vn0 ≈ −g·dt every step; baking restTarget there
  //    injects a perpetual +e·g·dt kick that never settles (the micro-bounce
  //    limit cycle that kept the determinism fixture awake). Bounce only for
  //    real impacts (|vn0| above 1 m/s); slower approaches rest.
  const rv = relativeVelocityOf(bodyA, bodyB, rAx, rAy, rAz, rBx, rBy, rBz)
  const vn0 = rv[0] * nx + rv[1] * ny + rv[2] * nz
  const e = opts.restitution ?? 0
  // Restitution fires only above noise scale: below this, a "bounce" is
  // settling churn (the leaf's original 1.0 threshold killed every small
  // real bounce — e.g. a 0.5 m/s drop with e=0.1 — and broke the pinned
  // e=1 unit case; 0.05 = sleep-scale, 10× the solver slop).
  const RESTITUTION_VN_THRESHOLD = 0.05
  const restTarget = opts.restTargetOverride !== undefined
    ? opts.restTargetOverride
    : ((opts.applyRestitution !== false && e > 0 && -vn0 > RESTITUTION_VN_THRESHOLD) ? -e * vn0 : 0)

  return {
    bodyA, bodyB,
    rA: [rAx, rAy, rAz], rB: [rBx, rBy, rBz],
    n: [nx, ny, nz], t1, t2,
    iA: [iAx, iAy, iAz], iB: [iBx, iBy, iBz],
    tA, tB,
    Kn: Ks[0], Kt1: Ks[1], Kt2: Ks[2],
    bias: opts.bias || 0,
    restTarget,
    mu: opts.friction ?? 0,
    // Accumulated impulses (warm-started or zero).
    ln: Math.max(opts.warmNormal ?? 0, 0),
    lt1: opts.warmT1 ?? 0,
    lt2: opts.warmT2 ?? 0,
  }
}

/** Relative velocity at the contact, B − A, with ω×r terms. */
function relativeVelocityOf(a, b, rAx, rAy, rAz, rBx, rBy, rBz) {
  const wax = Number.isFinite(a.wx) ? a.wx : 0
  const way = Number.isFinite(a.wy) ? a.wy : 0
  const waz = Number.isFinite(a.wz) ? a.wz : 0
  const wbx = Number.isFinite(b.wx) ? b.wx : 0
  const wby = Number.isFinite(b.wy) ? b.wy : 0
  const wbz = Number.isFinite(b.wz) ? b.wz : 0
  const wxaA = way * rAz - waz * rAy, wyaA = waz * rAx - wax * rAz, wzaA = wax * rAy - way * rAx
  const wxaB = wby * rBz - wbz * rBy, wybB = wbz * rBx - wbx * rBz, wzbB = wbx * rBy - wby * rBx
  return [
    (b.vx + wxaB) - (a.vx + wxaA),
    (b.vy + wybB) - (a.vy + wyaA),
    (b.vz + wzbB) - (a.vz + wzaA),
  ]
}

/** Apply impulse J (world, at the contact) to both descriptors in place. */
function applyContactImpulse(c, jx, jy, jz) {
  const a = c.bodyA, b = c.bodyB
  a.vx -= jx * c.iA[0]; a.vy -= jy * c.iA[1]; a.vz -= jz * c.iA[2]
  b.vx += jx * c.iB[0]; b.vy += jy * c.iB[1]; b.vz += jz * c.iB[2]
  if (c.tA.kind !== 'diag' || c.tA.v.some((v) => v !== 0)) {
    const rAxJ = cross3(c.rA[0], c.rA[1], c.rA[2], -jx, -jy, -jz)
    const dA = angDelta(c.tA, rAxJ)
    a.wx = (Number.isFinite(a.wx) ? a.wx : 0) + dA[0]
    a.wy = (Number.isFinite(a.wy) ? a.wy : 0) + dA[1]
    a.wz = (Number.isFinite(a.wz) ? a.wz : 0) + dA[2]
  }
  if (c.tB.kind !== 'diag' || c.tB.v.some((v) => v !== 0)) {
    const rBxJ = cross3(c.rB[0], c.rB[1], c.rB[2], jx, jy, jz)
    const dB = angDelta(c.tB, rBxJ)
    b.wx = (Number.isFinite(b.wx) ? b.wx : 0) + dB[0]
    b.wy = (Number.isFinite(b.wy) ? b.wy : 0) + dB[1]
    b.wz = (Number.isFinite(b.wz) ? b.wz : 0) + dB[2]
  }
}

/**
 * One accumulating solve pass over a contact constraint — ACCUMULATE-THEN-
 * CLAMP. Mutates the constraint's accumulated impulses AND the bodies'
 * velocity/spin fields in place: only the DELTA (λ' − λ) is applied.
 *  - normal:  λn' = max(λn + Δλn, 0), target vn = bias + restTarget
 *  - tangent: λti' = clamp(λti + Δλti, −μ·λn', +μ·λn') (CURRENT accumulated λn)
 * @param {object} c constraint from buildContactConstraint
 * @param {object[]} [bodies] [bodyA, bodyB] override (defaults to c's refs)
 * @param {number} [dt] unused (bias is precomputed at build) — signature compat
 */
export function solveContactConstraint(c, bodies, dt) {
  void dt
  if (bodies) { c.bodyA = bodies[0]; c.bodyB = bodies[1] }
  if (c.Kn > 0) {
    const a = c.bodyA, b = c.bodyB
    const rv = relativeVelocityOf(a, b, c.rA[0], c.rA[1], c.rA[2], c.rB[0], c.rB[1], c.rB[2])
    const vn = rv[0] * c.n[0] + rv[1] * c.n[1] + rv[2] * c.n[2]
    const target = c.bias + c.restTarget
    const dln = (target - vn) / c.Kn
    const lnOld = c.ln
    c.ln = Math.max(c.ln + dln, 0)
    applyContactImpulse(c, (c.ln - lnOld) * c.n[0], (c.ln - lnOld) * c.n[1], (c.ln - lnOld) * c.n[2])

    if (c.mu > 0) {
      const maxJt = c.mu * c.ln
      const rvs = relativeVelocityOf(a, b, c.rA[0], c.rA[1], c.rA[2], c.rB[0], c.rB[1], c.rB[2])
      const tangents = [c.t1, c.t2]
      const keys = ['lt1', 'lt2']
      for (let i = 0; i < 2; i++) {
        const t = tangents[i]
        const vt = rvs[0] * t[0] + rvs[1] * t[1] + rvs[2] * t[2]
        const Kt = i === 0 ? c.Kt1 : c.Kt2
        if (!(Kt > 0)) continue
        const dlt = -vt / Kt
        const ltOld = c[keys[i]]
        const ltNew = Math.max(-maxJt, Math.min(maxJt, ltOld + dlt))
        c[keys[i]] = ltNew
        applyContactImpulse(c, (ltNew - ltOld) * t[0], (ltNew - ltOld) * t[1], (ltNew - ltOld) * t[2])
      }
    }
  }
  return c
}

/**
 * Orchestrated velocity solve for one manifold — warm start + N sweeps.
 *  - Fetches cached impulses via cache.warmStartOf(pairKey, step) and matches
 *    them to this step's points by id (cache.match — exact string ids).
 *  - Builds one constraint per point (restitution target baked from pre-solve
 *    vn0 — first-sweep-only by construction; Baumgarte bias = (percent/dt)·
 *    max(−sep − slop, 0) per point).
 *  - Runs opts.sweeps velocity sweeps over the per-point constraints.
 *  - Stores the accumulated impulses back via cache.store.
 * @param {object} descA body descriptor A (mutated velocities)
 * @param {object} descB body descriptor B
 * @param {object} manifold { normal:{x,y,z}, points:[{px,py,pz,sep,id,...}] }
 *   (contactManifold output shape)
 * @param {object|null} cache contact cache (null → cold start, no store)
 * @param {string} pairKey canonical pair key
 * @param {number} step current step index
 * @param {object} [opts] { sweeps = 8, restitution = 0, friction = 0,
 *   dt = 1/60, slop = SOLVER_SLOP, percent = SOLVER_PERCENT }
 * @returns {{ constraints: object[] }} the per-point constraints (impulses
 *   readable off them: ln, lt1, lt2)
 */
export function solveManifoldVelocity(descA, descB, manifold, cache, pairKey, step, opts = {}) {
  const sweeps = Math.max(1, opts.sweeps ?? 8)
  const slop = opts.slop ?? SOLVER_SLOP
  const percent = opts.percent ?? SOLVER_PERCENT
  const dt = opts.dt ?? (1 / 60)
  const points = manifold.points || []
  const ids = points.map((p) => p.id)
  const warm = cache ? cache.warmStartOf(pairKey, step) : null
  const matches = warm ? cache.match(warm, ids) : new Map()

  const constraints = points.map((p) => {
    const old = matches.get(p.id)
    // NO Baumgarte penetration bias here: the iterative position repair
    // (solveManifoldPosition, positionIterations×) owns penetration. Bias +
    // repair double-count — the bias accelerates the body into the contact
    // while the repair pushes it out; the equilibrium sits at pen ≈ slop +
    // g·dt²/(repair-rate − bias-rate), keeping a permanent +0.1 vy on stacked
    // crates (never quiet, never sleep). Restitution still enters via
    // restTarget from pre-solve vn0. (W3 integration, 2026-09-13.)
    const bias = 0
    return buildContactConstraint(descA, descB, p, manifold.normal, {
      friction: opts.friction ?? 0,
      restitution: opts.restitution ?? 0,
      applyRestitution: opts.applyRestitution !== false,
      // Pinned target across the caller's per-sweep calls (W3 continuation).
      restTargetOverride: opts.restTargetOverride,
      bias,
      warmNormal: old ? old.normalImpulse : 0,
      // W3-continuation (2026-09-13): tangential impulses are NOT warm-
      // started. The cached λt encodes the PREVIOUS step's contact-frame
      // tangential demand; re-applying it at the (midpoint-biased) corner
      // lever arms re-creates last step's torque on a re-penetrating contact
      // — a self-sustaining tilt/roll limit cycle that never lets a resting
      // stack go quiet. λn warm-start (the dominant stabilizer) is kept.
      warmT1: 0,
      warmT2: 0,
    })
  })

  // WARM-START APPLICATION (Box2D WarmStart phase): the cached impulses are
  // APPLIED to the bodies here, not just used as initial λ values. Without
  // this, each step's solve starts from the raw gravity-loaded velocity and
  // the stored λn ratchets (+m·g·dt per step, compounding unboundedly —
  // observed λn = 4.905 = 30× the correct resting impulse). With the apply,
  // the warm impulse cancels last step's residual and the solve converges:
  // λn settles at the true per-step requirement (m·g·dt) and stays there.
  // (W3 integration, 2026-09-13.)
  for (let i = 0; i < constraints.length; i++) {
    const c = constraints[i]
    if (c.ln > 0 || c.lt1 !== 0 || c.lt2 !== 0) {
      applyContactImpulse(
        c,
        c.ln * c.n[0] + c.lt1 * c.t1[0] + c.lt2 * c.t2[0],
        c.ln * c.n[1] + c.lt1 * c.t1[1] + c.lt2 * c.t2[1],
        c.ln * c.n[2] + c.lt1 * c.t1[2] + c.lt2 * c.t2[2]
      )
    }
  }

  for (let s = 0; s < sweeps; s++) {
    for (let i = 0; i < constraints.length; i++) {
      solveContactConstraint(constraints[i])
      // W3: a symmetric multi-point flat contact must leave NO residual spin
      // (each point's tangent impulse fights the others; the accumulating
      // residual is float noise at 1e-9 scale). Zero ω within that band.
      if (Math.abs(constraints[i].bodyB.wy ?? 0) < 1e-7) constraints[i].bodyB.wy = 0
    }
  }

  if (cache) {
    cache.store(pairKey, points.map((p, i) => ({
      id: p.id,
      normalImpulse: constraints[i].ln,
      lt1: constraints[i].lt1,
      lt2: constraints[i].lt2,
    })), step)
  }
  return { constraints }
}

/**
 * Per-point POSITIONAL repair (pure — returns deltas, does not move bodies).
 * Mirrors the W0 D4 semantics: invMass-weighted split (weights sum to 1 per
 * point → total separation preserved), posX/Y/Z locks zero a body's motion on
 * that axis, invMass 0 (statics/kinematics) takes zero correction. Per-point
 * correction = percent · max(−sep − slop, 0) / pointCount (split across the
 * manifold so N points don't over-correct).
 * @param {object[]} points manifold points ({ px..pz, sep, ... })
 * @param {object} descA body descriptor A (uses invMass + lockFlags)
 * @param {object} descB body descriptor B
 * @param {object} manifold { normal:{x,y,z} } — normal A→B
 * @param {object} [opts] { slop = SOLVER_SLOP, percent = SOLVER_PERCENT }
 * @returns {{ dax,day,daz, dbx,dby,dbz }} displacements to ADD to each body.
 */
export function solveManifoldPosition(points, descA, descB, manifold, opts = {}) {
  const slop = opts.slop ?? SOLVER_SLOP
  const percent = opts.percent ?? SOLVER_PERCENT
  const nx = manifold.normal.x, ny = manifold.normal.y, nz = manifold.normal.z
  const lockA = new Set(descA.lockFlags || [])
  const lockB = new Set(descB.lockFlags || [])
  const iA = descA.invMass || 0
  const iB = descB.invMass || 0
  const out = { dax: 0, day: 0, daz: 0, dbx: 0, dby: 0, dbz: 0, drax: 0, dray: 0, draz: 0, drbx: 0, drby: 0, drbz: 0 }
  const n = points.length
  if (n === 0 || iA + iB <= 0) return out
  const wA = iA / (iA + iB), wB = iB / (iA + iB)
  // P3.5 (2026-09-14, XPBD angular position correction per Müller et al.):
  // penetration of an OFF-CENTER contact point must be repaired by ROTATING
  // the body about its contact point, not only translating the center — a
  // tipped box pushed straight up keeps its tilt forever (the observed
  // "rotation locked at 45°" fake equilibrium). For each point with
  // separation beyond slop, compute the positional correction p = corr·n and
  // derive the angular delta Δω ≈ I⁻¹(r × p) at that body's contact lever
  // arm r (center → contact point). The angular part is applied as a
  // rotation-vector delta (radians, small-angle) by the caller; the linear
  // part is REDUCED by the fraction the rotation already repairs
  // (|r × n| per point), so a corner contact mostly rotates while a
  // face-flat contact mostly translates — matching XPBD's correction
  // operations. Locks and statics (invMass 0) are honored as before.
  const invA = descA.invInertia || null
  const invB = descB.invInertia || null
  // Per-body angular weight for correction distribution (diagonal path).
  const wAngA = (invA && iA > 0) ? 1 : 0
  const wAngB = (invB && iB > 0) ? 1 : 0
  for (const p of points) {
    const corr = (percent / n) * Math.max(-p.sep - slop, 0)
    if (!(corr > 0)) continue
    // Lever arms: descA/B carry the body CENTER (cx,cy,cz); the point is the
    // contact location. r = point − center.
    const rax = p.px - (descA.cx || 0), ray = p.py - (descA.cy || 0), raz = p.pz - (descA.cz || 0)
    const rbx = p.px - (descB.cx || 0), rby = p.py - (descB.cy || 0), rbz = p.pz - (descB.cz || 0)
    // How much of this point's normal correction is tangential to the body
    // center (i.e. produces rotation): |r × n|. For a point directly under
    // the center this is 0 → pure translation; at a corner/edge it → |r|.
    const crossA = Math.hypot(ray * nz - raz * ny, raz * nx - rax * nz, rax * ny - ray * nx)
    const crossB = Math.hypot(rby * nz - rbz * ny, rbz * nx - rbx * nz, rbx * ny - rby * nx)
    // Linear share: scale down by the rotational share so face contacts
    // translate (crossA≈0) and corner contacts mostly rotate (crossA≈|r|).
    const rotShareA = wAngA ? Math.min(1, crossA / 0.5) : 0
    const rotShareB = wAngB ? Math.min(1, crossB / 0.5) : 0
    const linA = corr * (1 - 0.8 * rotShareA)
    const linB = corr * (1 - 0.8 * rotShareB)
    if (iA > 0) {
      if (!lockA.has('posX')) out.dax -= nx * linA * wA
      if (!lockA.has('posY')) out.day -= ny * linA * wA
      if (!lockA.has('posZ')) out.daz -= nz * linA * wA
    }
    if (iB > 0) {
      if (!lockB.has('posX')) out.dbx += nx * linB * wB
      if (!lockB.has('posY')) out.dby += ny * linB * wB
      if (!lockB.has('posZ')) out.dbz += nz * linB * wB
    }
    // Angular correction: rotate about the contact edge by the tangential
    // remainder. Δθ = (corr − linShare) around axis n × r direction.
    const rotA = corr * rotShareA * 0.8
    const rotB = corr * rotShareB * 0.8
    if (rotA > 0 && wAngA && !lockA.has('rotZ')) {
      // Sign: gravity pulls the overhanging corner down → the body must
      // rotate TOWARD the contact (drop the high side). n points A→B.
      // Δθ around z from the lever: r × n z-component sign.
      const s = (rax * ny - ray * nx)
      out.draz -= s > 0 ? rotA : -rotA
    }
    if (rotB > 0 && wAngB && !lockB.has('rotZ')) {
      const s = (rbx * ny - rby * nx)
      out.drbz += s > 0 ? rotB : -rotB
    }
  }
  return out
}
