// W8-G (plan SE-COMPLETE-1012, user-directed) — Lichtenberg bolt geometry:
// PURE midpoint displacement. No THREE, no DOM, no Math.random, no clock —
// every channel point is a seeded function of `seed`, so the same strike seed
// always produces the same bolt (determinism pin).
//
// Algorithm (iterative level loop — treeDebris doctrine: no recursion):
//   - channel 0: cloud -> target straight segment (width 1).
//   - per level L: subdivide every segment longer than segmentMinLen at its
//     midpoint; displace the midpoint perpendicular to its segment by
//     amp(L) = baseLen * roughness^(L+1) * jitter, plus a small along-segment
//     component toward the target (DBM field-gradient flavor, data `bias`).
//     amp decays STRICTLY per level when roughness < 1 (decay-bound pin).
//   - at each new midpoint a BRANCH channel may spawn (probability
//     branchChance * branchDecay^L): shorter (branchDecay * parent segment)
//     and thinner (branchWidthFrac * parent width), subdivided by the same
//     loop with the remaining levels.
//   - segment budget maxSegments: main-channel segments always kept; branch
//     channels are dropped once the budget is hit (spawn order).
//
// ALL shape params arrive via opts (levels, roughness, branchChance,
// branchDecay, segmentMinLen, seed, bias, branchWidthFrac, maxSegments) —
// no content literals here; the shipped numbers live in
// data/physics-presets.json .lightning.vfx.

function num(v, dflt) { return typeof v === 'number' && Number.isFinite(v) ? v : dflt }
function pt(p) { return { x: p?.x ?? 0, y: p?.y ?? 0, z: p?.z ?? 0 } }

/** mulberry32 — same seed, same stream (the ONE prng here). */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Orthonormal basis (u, v) perpendicular to segment direction d (unit).
// Deterministic: the reference axis flips only at a fixed threshold.
function perpBasis(dx, dy, dz) {
  let rx = 0, ry = 1, rz = 0
  if (Math.abs(dy) > 0.9) { rx = 1; ry = 0 }
  // u = normalize(d x r); v = d x u (unit — d,u orthonormal)
  let ux = dy * rz - dz * ry, uy = dz * rx - dx * rz, uz = dx * ry - dy * rx
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul; uy /= ul; uz /= ul
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux
  return { ux, uy, uz, vx, vy, vz }
}

/**
 * Build one bolt's channel geometry. Returns
 *   { segments: [{ ax,ay,az, bx,by,bz, w, branch }], branches, levelMax }
 * levelMax[L] = the largest displacement magnitude applied at level L
 * (diagnostics for the decay-bound pin). PURE.
 */
export function boltPath(opts) {
  const from = pt(opts.from)
  const to = pt(opts.to)
  const levels = Math.max(0, Math.min(8, opts.levels | 0))
  const roughness = num(opts.roughness, 0.35)
  const branchChance = num(opts.branchChance, 0)
  const branchDecay = num(opts.branchDecay, 0.5)
  const minLen = num(opts.segmentMinLen, 0.5)
  const bias = num(opts.bias, 0.25)
  const branchWidthFrac = num(opts.branchWidthFrac, 0.5)
  const maxSegments = Math.max(1, opts.maxSegments ?? 96)
  const rng = mulberry32(opts.seed ?? 0)
  const baseLen = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)

  // channels[0] is the main channel; branches append in spawn order.
  const channels = [{ pts: [from, to], w: 1, branch: false }]
  const levelMax = []

  for (let L = 0; L < levels; L++) {
    const amp = baseLen * Math.pow(roughness, L + 1)
    let ampMax = 0
    const born = [] // branches spawned this level join the NEXT level
    for (const ch of channels) {
      const pts = ch.pts
      const next = [pts[0]]
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1]
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
        const len = Math.hypot(dx, dy, dz)
        if (len < minLen || len < 1e-9) { next.push(b); continue }
        // midpoint displacement: perpendicular jitter + toward-target bias
        const { ux, uy, uz, vx, vy, vz } = perpBasis(dx / len, dy / len, dz / len)
        const phi = rng() * Math.PI * 2
        const j = rng() * 2 - 1
        const mag = amp * j
        const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2, pz = (a.z + b.z) / 2
        const hx = dx / len * (mag * bias), hy = dy / len * (mag * bias), hz = dz / len * (mag * bias)
        const mid = {
          x: px + (ux * Math.cos(phi) + vx * Math.sin(phi)) * mag + hx,
          y: py + (uy * Math.cos(phi) + vy * Math.sin(phi)) * mag + hy,
          z: pz + (uz * Math.cos(phi) + vz * Math.sin(phi)) * mag + hz,
        }
        next.push(mid, b)
        const d = Math.abs(mag)
        if (d > ampMax) ampMax = d
        // branch spawn: low probability, decaying with depth (data-driven).
        // Branches may themselves fork — always thinner than their parent.
        if (rng() < branchChance * Math.pow(branchDecay, L)) {
            const phi2 = rng() * Math.PI * 2
            const blen = len * branchDecay * (0.6 + 0.8 * rng())
            const bx = (ux * Math.cos(phi2) + vx * Math.sin(phi2)) * 0.85 + dx / len * 0.45
            const by = (uy * Math.cos(phi2) + vy * Math.sin(phi2)) * 0.85 + dy / len * 0.45
            const bz = (uz * Math.cos(phi2) + vz * Math.sin(phi2)) * 0.85 + dz / len * 0.45
            const bl = Math.hypot(bx, by, bz) || 1
            born.push({
              pts: [mid, { x: mid.x + (bx / bl) * blen, y: mid.y + (by / bl) * blen, z: mid.z + (bz / bl) * blen }],
              w: ch.w * branchWidthFrac, branch: true,
            })
        }
      }
      ch.pts = next
    }
    levelMax.push(ampMax)
    for (const c of born) channels.push(c)
  }

  // Emit segments: main channel first, then branches in spawn order, until
  // the budget is hit (branch channels drop whole).
  const segmentsOut = []
  let branches = 0
  for (const ch of channels) {
    if (ch.branch && segmentsOut.length + (ch.pts.length - 1) > maxSegments) continue
    for (let i = 0; i + 1 < ch.pts.length; i++) {
      if (ch.branch && segmentsOut.length >= maxSegments) break
      const a = ch.pts[i], b = ch.pts[i + 1]
      segmentsOut.push({
        ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z,
        w: ch.w, branch: ch.branch,
      })
    }
    if (ch.branch) branches++
  }
  return { segments: segmentsOut, branches, levelMax }
}

/**
 * Orientation for a Y-axis box (the render bolt segment): the engine applies
 * transform.rot as THREE.Euler(rot.x, rot.y, rot.z) ('XYZ' order). With
 * rot.x = 0, local +Y maps to (-sin rz * cos ry, cos rz, sin rz * sin ry) —
 * solve (ry, rz) so that equals the unit segment direction. PURE.
 */
export function segmentOrientation(dx, dy, dz) {
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-12) return { ry: 0, rz: 0 }
  const ny = dy / len
  const rz = Math.acos(Math.max(-1, Math.min(1, ny)))
  const s = Math.sin(rz)
  if (s < 1e-9) return { ry: 0, rz } // vertical: yaw is a free axis
  const rx = dx / len, nz = dz / len
  // cos ry = -rx/s, sin ry = nz/s
  return { ry: Math.atan2(nz, -rx), rz }
}
