/**
 * blendTree — 2D blend-space evaluation + locomotion schema migration (BT1).
 *
 * PURE engine math + data: ZERO three import, zero npm deps, deterministic.
 * This is the replacement model for the legacy string-`when` locomotion state
 * map (blend.js — a 1D first-match state selector, deleted in BT3). Per the
 * 2026-09-19 amendment blend spaces
 * are 2D from day one (`params: ['velX','velY']`, points carry `at: [x, y]`);
 * 1D (`param: 'speed'`, scalar `at`) is the degenerate case and stays first-class.
 *
 * Contracts (stable — BT2's mixer and BT4's pad UI build on these):
 *
 * `evaluateBlendSpace(points, values)` → `[{ clip, weight }]` or `null`:
 *   - ALL input points are emitted, zero-weight entries included (consumers may
 *     filter `weight > 0`); sorted by clip name (ties by coordinates) so output
 *     order is deterministic regardless of authoring order.
 *   - Weights sum to exactly 1 (normalized) in every path.
 *   - Returns NULL when it cannot evaluate — empty/all-malformed points, mixed
 *     1D/2D points, or missing/non-finite values. The CALLER falls back to the
 *     spec's `default` clip on null. (Validation guarantees well-formed shapes;
 *     the runtime contract is still null, never a throw.)
 *   - `values` is `number` for a 1D space (scalar param) and `[x, y]` for 2D.
 *   - 2D INSIDE the hull: Delaunay (Bowyer-Watson) triangulation + barycentric
 *     weights of the containing triangle — the Unity/Unreal Freeform-Cartesian
 *     semantics (piecewise-linear, local). Sums to 1 with exact-node → 1/0 and
 *     reduces to plain triangle barycentric for 3-point hulls. THE LAYOUT RULE:
 *     canonical locomotion spaces put idle at the CENTER as an interior node
 *     with the direction clips on the rim — Delaunay then fans the space into
 *     clean triangles (idle + adjacent rim pair) and strafe-any-direction
 *     blends with NO cross-leak from opposite clips (validateAnimator warns
 *     when the center node is missing). A rim-only square (no center node)
 *     still evaluates honestly: its two Delaunay triangles split along the
 *     diagonal, so the center query sits ON the shared diagonal and yields
 *     0.5/0.5 on the diagonal endpoints — correct industry semantics, not a
 *     special case. (An earlier all-hull-vertices interpolation path built to
 *     make that probe return four equal weights was removed per the
 *     2026-09-19 second amendment: 4-way-equal at the up-right diagonal means
 *     backpedal contributes 25% while moving forward-right — the cross-leak
 *     this design exists to prevent.)
 *   - 2D OUTSIDE the hull (and degenerate collinear sets): normalized inverse-
 *     distance-SQUARED falloff over all points — a soft falloff that sums to 1
 *     with the nearest point dominant; no hard cutoff, no throw.
 *   - Malformed entries (missing/non-finite `at`, missing `clip`) are skipped;
 *     duplicate coordinates are deduped to their alphabetically-first clip
 *     ("carrier"), which takes the node's weight while later duplicates get 0.
 *   - 1D: linear interpolation between ascending neighbors, clamped at the ends
 *     (the original 1D design: `at <= p < next.at → w = 1 − t/Δ`, ends hold).
 *
 * `migrateLocomotion(old)` → `{ spec, warnings }` — converts the OLD legacy
 * locomotion block (`{ param?, states: [{ when, clip }], default, fade? }`) into
 * the NEW blend-space spec (`{ params, points, default, fade? }`). Migration
 * rules, in order:
 *   1. A state migrates iff its `when` is ONE simple numeric comparison
 *      `name > num` / `name < num` / `name >= num` / `name <= num`. It becomes
 *      a point `{ at: num, clip }` under param `name`. Equality (`==`/`!=`),
 *      boolean/string RHS, multi-clause (`&&`/`||`), and any other expression
 *      DO NOT migrate — the state is skipped and a warning is returned
 *      (validateAnimator surfaces these as soft warnings).
 *   2. All migratable conditions must share ONE param name (the old scalar
 *      first-match map projects onto a single 1D strip; 2D spaces are authored,
 *      not migrated). Conditions naming a different param are skipped with a
 *      warning. An old `param:` field pins the name and wins.
 *   3. The default clip anchors the space: it becomes a point at
 *      `min(0, lowest condition value)` so the region at/below the lowest
 *      threshold resolves to the default (matching the old first-match
 *      fallback). If a condition point already occupies that exact value, the
 *      anchor drops one unit lower (`value - 1`) — duplicate coordinates would
 *      otherwise let the alphabetically-first clip swallow the node.
 *   4. `default` normalizes to the clip-role string; `fade` passes through.
 *   5. Data-only configs (`{ default: 'idle' }`, no states) migrate to a single
 *      point at the origin under the canonical scalar param `'speed'` — it
 *      evaluates to the default clip at every param value, i.e. exactly the old
 *      behavior.
 *   6. Nothing migratable and no default → `{ spec: null, warnings }`.
 *   Migration is intentionally approximate between thresholds (a blend space
 *   blends continuously where the old system hard-selected) — at/below the
 *   lowest threshold and at the exact condition values the old clip wins.
 *
 * `triangulate(points)` → `[[i, j, k], ...]` — the raw Delaunay helper, exported
 * ONCE for BT4's 2D pad hull shading (no copies). Input `[{ x, y }]`; output is
 * index triples into the INPUT array (each triple sorted ascending, list sorted
 * lexicographically). Degenerate inputs (collinear, <3 unique, duplicates) yield
 * fewer/empty triangles — never a throw.
 */

const TOL = 1e-9 // barycentric inside-tolerance (absorbs fp noise on hull edges)
const EPS_D2 = 1e-12 // distance² below which a query "is" a point

/** Deterministic clip-name comparator. */
function clipCmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Circumcircle of triangle abc, or null when the points are collinear. */
function circumcircle(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null
  const a2 = a.x * a.x + a.y * a.y
  const b2 = b.x * b.x + b.y * b.y
  const c2 = c.x * c.x + c.y * c.y
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
  const dx = a.x - ux
  const dy = a.y - uy
  return { x: ux, y: uy, r2: dx * dx + dy * dy }
}

/**
 * Bowyer-Watson Delaunay triangulation. See module docs for the contract.
 * @param {Array<{x:number,y:number}>} points
 * @returns {Array<[number,number,number]>} index triples into `points`
 */
export function triangulate(points) {
  if (!Array.isArray(points)) return []
  const uniq = []
  const seen = new Set()
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (!p || typeof p !== 'object') continue
    const x = +p.x
    const y = +p.y
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const key = x + '|' + y
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push({ x, y, idx: i })
  }
  if (uniq.length < 3) return []
  // Deterministic processing order (sorted, stable) — same input, same output.
  const sorted = [...uniq].sort((a, b) => a.x - b.x || a.y - b.y)
  const n = sorted.length

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of sorted) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const mx = (minX + maxX) / 2
  const my = (minY + maxY) / 2
  // Super-triangle far outside the hull (20x span margin).
  const verts = [
    ...sorted,
    { x: mx - 20 * span, y: my - span },
    { x: mx, y: my + 20 * span },
    { x: mx + 20 * span, y: my - span },
  ]
  const SUPER = [n, n + 1, n + 2]
  let tris = [SUPER]
  for (let i = 0; i < n; i++) {
    const p = verts[i]
    const bad = []
    for (const t of tris) {
      const cc = circumcircle(verts[t[0]], verts[t[1]], verts[t[2]])
      // Collinear-triangle circumcircles are null → "does not contain" (the
      // degenerate triangle will be filtered at the end; fully collinear sets
      // simply never accumulate triangles).
      if (cc && (p.x - cc.x) * (p.x - cc.x) + (p.y - cc.y) * (p.y - cc.y) <= cc.r2 + 1e-10 * (cc.r2 + 1)) {
        bad.push(t)
      }
    }
    if (bad.length === 0) continue
    // Boundary edges of the bad set = edges appearing exactly once.
    const count = new Map()
    for (const t of bad) {
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const k = a < b ? a + '|' + b : b + '|' + a
        count.set(k, (count.get(k) || 0) + 1)
      }
    }
    tris = tris.filter((t) => !bad.includes(t))
    for (const t of bad) {
      for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const k = a < b ? a + '|' + b : b + '|' + a
        if (count.get(k) === 1) tris.push([a, b, i])
      }
    }
  }
  const out = []
  for (const t of tris) {
    if (t.includes(n) || t.includes(n + 1) || t.includes(n + 2)) continue
    out.push([sorted[t[0]].idx, sorted[t[1]].idx, sorted[t[2]].idx].sort((a, b) => a - b))
  }
  out.sort((A, B) => A[0] - B[0] || A[1] - B[1] || A[2] - B[2])
  return out
}

/**
 * Build the per-input-entry output from per-unique-point weights: only the
 * CARRIER (first input entry at each unique coordinate — entries arrive sorted
 * by coordinate then clip, so the carrier is the alphabetically-first clip)
 * carries the weight; later duplicates emit 0. Output is re-sorted by clip
 * name (ties by coordinates) and stripped to { clip, weight }.
 * @param {Array} sorted  entries sorted by (coord, clip), each { i, clip, u }
 * @param {number[]} wUniq  weight per unique point (sums to 1)
 * @param {Function} coordOf  entry -> { x, y } | { at } for output tie-sorting
 */
function emitWeights(sorted, wUniq, coordOf) {
  const carrier = new Map()
  for (const e of sorted) if (!carrier.has(e.u)) carrier.set(e.u, e.i)
  const out = sorted.map((e) => ({
    clip: e.clip,
    weight: carrier.get(e.u) === e.i ? wUniq[e.u] : 0,
    ...coordOf(e),
  }))
  out.sort((a, b) => clipCmp(a.clip, b.clip) || (a.x ?? a.at ?? 0) - (b.x ?? b.at ?? 0) || (a.y ?? 0) - (b.y ?? 0))
  return out.map(({ clip, weight }) => ({ clip, weight }))
}

/** Normalized inverse-distance-squared falloff over the unique points. */
function inverseDistance(uniq, px, py, sorted, coordOf) {
  const d2 = uniq.map((u) => {
    const dx = px - u.x
    const dy = py - u.y
    return dx * dx + dy * dy
  })
  const hit = d2.findIndex((v) => v < EPS_D2) // query coincides with a point
  let wUniq
  if (hit >= 0) {
    wUniq = uniq.map((_, i) => (i === hit ? 1 : 0))
  } else {
    let sum = 0
    const inv = d2.map((v) => { const w = 1 / v; sum += w; return w })
    wUniq = inv.map((w) => w / sum)
  }
  return emitWeights(sorted, wUniq, coordOf)
}

/**
 * Convex hull (Andrew monotone chain) of the unique points, counter-clockwise,
 * starting at the lexicographically-smallest vertex. Deterministic. Collinear
 * points on hull edges are dropped (strictly-convex hull). Returns INDICES
 * into `uniq`. Requires uniq sorted by (x, y).
 */
function convexHull(uniq) {
  const n = uniq.length
  if (n < 3) return []
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower = []
  for (let i = 0; i < n; i++) {
    while (lower.length >= 2 && cross(uniq[lower[lower.length - 2]], uniq[lower[lower.length - 1]], uniq[i]) <= 0) lower.pop()
    lower.push(i)
  }
  const upper = []
  for (let i = n - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(uniq[upper[upper.length - 2]], uniq[upper[upper.length - 1]], uniq[i]) <= 0) upper.pop()
    upper.push(i)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

/**
 * Locate a query against a CCW convex hull: 'out', 'in' (strictly interior),
 * or 'edge' (on hull edge `i`, parameter t ∈ [0,1] from vertex i to i+1).
 */
function hullLocate(hull, uniq, px, py) {
  let edge = null
  for (let i = 0; i < hull.length; i++) {
    const A = uniq[hull[i]]
    const B = uniq[hull[(i + 1) % hull.length]]
    const ex = B.x - A.x
    const ey = B.y - A.y
    const len = Math.hypot(ex, ey) || 1
    const cr = ex * (py - A.y) - ey * (px - A.x)
    if (cr < -TOL * len) return { loc: 'out' }
    if (Math.abs(cr) <= TOL * len) {
      const t = ((px - A.x) * ex + (py - A.y) * ey) / (len * len)
      if (t >= -TOL && t <= 1 + TOL) edge = { loc: 'edge', i, t: Math.max(0, Math.min(1, t)) }
    }
  }
  return edge || { loc: 'in' }
}

/** 2D evaluation — pure Delaunay + containing-triangle barycentric (the
 *  Unity/Unreal Freeform-Cartesian semantics, per the 2026-09-19 second
 *  amendment). THE LAYOUT RULE lives here in spirit and in validateAnimator in
 *  code: canonical locomotion spaces put idle at the CENTER as an interior
 *  node, direction clips on the rim — Delaunay fans the space into triangles
 *  of (idle + adjacent rim pair), so blends stay LOCAL: the forward-right
 *  region blends forward/right/idle and the opposite clip (backpedal) gets
 *  exactly zero. A rim-only square (no center node) evaluates via its two
 *  Delaunay triangles: the center lies ON the shared diagonal and yields
 *  0.5/0.5 on the diagonal endpoints — correct industry semantics; add the
 *  center node instead of special-casing it.
 *  Outside the hull: normalized inverse-distance falloff; on a hull edge:
 *  linear interpolation between that edge's endpoints. */
function eval2D(entries, px, py) {
  const sorted = entries
    .map((e, i) => ({ i, x: e.x, y: e.y, clip: e.clip, u: -1 }))
    .sort((a, b) => a.x - b.x || a.y - b.y || clipCmp(a.clip, b.clip))
  // Dedupe coordinates; the alphabetically-first clip carries the node.
  const uniq = []
  for (const e of sorted) {
    let u = uniq.findIndex((q) => q.x === e.x && q.y === e.y)
    if (u < 0) { u = uniq.length; uniq.push({ x: e.x, y: e.y }) }
    e.u = u
  }
  const coordOf = (e) => ({ x: e.x, y: e.y })

  if (uniq.length === 1) return emitWeights(sorted, [1], coordOf)
  if (uniq.length === 2) {
    // Segment interpolation: project the query onto the segment, clamp to [0,1].
    const [A, B] = uniq
    const dx = B.x - A.x
    const dy = B.y - A.y
    const l2 = dx * dx + dy * dy
    let t = l2 > 0 ? ((px - A.x) * dx + (py - A.y) * dy) / l2 : 0
    t = Math.max(0, Math.min(1, t))
    return emitWeights(sorted, [1 - t, t], coordOf)
  }
  const hull = convexHull(uniq)
  if (hull.length < 3) {
    // Collinear/degenerate set — no hull: soft falloff.
    return inverseDistance(uniq, px, py, sorted, coordOf)
  }
  const loc = hullLocate(hull, uniq, px, py)
  if (loc.loc === 'out') return inverseDistance(uniq, px, py, sorted, coordOf)

  const wUniq = uniq.map(() => 0)
  if (loc.loc === 'edge') {
    // On the hull boundary: linear interpolation between the edge endpoints.
    const A = hull[loc.i]
    const B = hull[(loc.i + 1) % hull.length]
    wUniq[A] = 1 - loc.t
    wUniq[B] = loc.t
    return emitWeights(sorted, wUniq, coordOf)
  }
  // Strictly interior: Delaunay + barycentric of the containing triangle
  // (first containing triangle in sorted order). Interior points (the center
  // idle node of the canonical layout) weight naturally alongside rim nodes.
  const tris = triangulate(uniq)
  for (const [i, j, k] of tris) {
    const A = uniq[i]
    const B = uniq[j]
    const C = uniq[k]
    const d = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y)
    if (Math.abs(d) < 1e-12) continue // degenerate triangle — skip
    const w0 = ((B.y - C.y) * (px - C.x) + (C.x - B.x) * (py - C.y)) / d
    const w1 = ((C.y - A.y) * (px - C.x) + (A.x - C.x) * (py - C.y)) / d
    const w2 = 1 - w0 - w1
    if (w0 < -TOL || w1 < -TOL || w2 < -TOL) continue // not this triangle
    const clamped = [w0, w1, w2].map((w) => Math.max(0, w))
    const sum = clamped[0] + clamped[1] + clamped[2]
    wUniq[i] = clamped[0] / sum
    wUniq[j] = clamped[1] / sum
    wUniq[k] = clamped[2] / sum
    return emitWeights(sorted, wUniq, coordOf)
  }
  // Outside every usable triangle — soft falloff.
  return inverseDistance(uniq, px, py, sorted, coordOf)
}

/** 1D evaluation: linear between ascending neighbors, clamped at the ends. */
function eval1D(entries, v) {
  const sorted = entries
    .map((e, i) => ({ i, at: e.at, clip: e.clip, u: -1 }))
    .sort((a, b) => a.at - b.at || clipCmp(a.clip, b.clip))
  // Dedupe `at` values; the alphabetically-first clip carries the node.
  const uniq = []
  for (const e of sorted) {
    if (uniq.length === 0 || uniq[uniq.length - 1].at !== e.at) uniq.push({ at: e.at })
    e.u = uniq.length - 1
  }
  const coordOf = (e) => ({ at: e.at })
  const wUniq = uniq.map(() => 0)
  if (uniq.length === 1 || v <= uniq[0].at) {
    wUniq[0] = 1 // single point, or clamp below the first point
  } else if (v >= uniq[uniq.length - 1].at) {
    wUniq[uniq.length - 1] = 1 // clamp above the last point
  } else {
    for (let i = 0; i < uniq.length - 1; i++) {
      if (v >= uniq[i].at && v <= uniq[i + 1].at) {
        const t = (v - uniq[i].at) / (uniq[i + 1].at - uniq[i].at)
        wUniq[i] = 1 - t
        wUniq[i + 1] = t
        break
      }
    }
  }
  return emitWeights(sorted, wUniq, coordOf)
}

/**
 * Evaluate a blend space against current param values. See the module header
 * for the full contract (return shape, null cases, inside/outside behavior).
 * @param {Array<{at:number|[number,number], clip:string}>} points
 * @param {number|[number,number]} values  scalar for 1D spaces, [x, y] for 2D
 * @returns {Array<{clip:string, weight:number}>|null}
 */
export function evaluateBlendSpace(points, values) {
  if (!Array.isArray(points) || points.length === 0) return null
  const entries = []
  for (const p of points) {
    if (!p || typeof p !== 'object' || typeof p.clip !== 'string' || !p.clip) continue
    if (Array.isArray(p.at)) {
      if (p.at.length !== 2 || !p.at.every(Number.isFinite)) continue
      entries.push({ dim: 2, x: p.at[0], y: p.at[1], clip: p.clip })
    } else if (typeof p.at === 'number' && Number.isFinite(p.at)) {
      entries.push({ dim: 1, at: p.at, clip: p.clip })
    }
    // other malformed entries are skipped (documented)
  }
  if (entries.length === 0) return null
  const dim = entries[0].dim
  for (const e of entries) if (e.dim !== dim) return null // mixed dims — cannot evaluate
  if (dim === 2) {
    if (!Array.isArray(values) || values.length !== 2 || !values.every(Number.isFinite)) return null
    return eval2D(entries, values[0], values[1])
  }
  if (typeof values !== 'number' || !Number.isFinite(values)) return null
  return eval1D(entries, values)
}

/** Regex for ONE simple numeric comparison — the only migratable condition form. */
const MIGRATE_RE = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(>=|<=|>|<)\s*(-?(?:\d+\.?\d*|\.\d+))\s*$/

/**
 * Migrate the OLD legacy locomotion block (string-`when` states) to the NEW
 * blend-space spec.
 * See the module header for every rule. Data-only, non-throwing.
 * @param {object} old  `{ param?, states?: [{ when, clip }], default?, fade? }`
 * @returns {{ spec: object|null, warnings: string[] }}
 */
export function migrateLocomotion(old) {
  const warnings = []
  if (!old || typeof old !== 'object') return { spec: null, warnings }
  const states = Array.isArray(old.states) ? old.states : []
  const defClip = typeof old.default === 'string'
    ? old.default
    : old.default && typeof old.default === 'object' && typeof old.default.clip === 'string'
      ? old.default.clip
      : null
  const skip = (st, reason) =>
    warnings.push(`locomotion: state '${st && st.clip}' condition "${st && st.when}" ${reason} — skipped (blend spaces need one numeric >, <, >=, <= comparison over a single scalar param)`)

  let param = typeof old.param === 'string' && old.param.trim() ? old.param : null
  const migratable = []
  for (const st of states) {
    if (!st || typeof st !== 'object' || typeof st.when !== 'string' || !st.when) {
      skip(st, 'has no usable string condition')
      continue
    }
    const m = MIGRATE_RE.exec(st.when)
    if (!m) {
      skip(st, 'is not a single numeric comparison')
      continue
    }
    const [, name, , num] = m
    if (param && name !== param) {
      warnings.push(`locomotion: state '${st.clip}' conditions param '${name}' but the space is keyed on '${param}' — skipped (1-param migration; 2D spaces are authored, not migrated)`)
      continue
    }
    if (!param) param = name
    migratable.push({ at: Number(num), clip: st.clip })
  }

  if (migratable.length === 0) {
    if (!defClip) return { spec: null, warnings }
    // Rule 5: data-only (or fully-unmigratable) — a single origin point under
    // the canonical scalar param; it evaluates to the default everywhere.
    return {
      spec: {
        params: ['speed'],
        points: [{ at: 0, clip: defClip }],
        default: defClip,
        ...(old.fade !== undefined ? { fade: old.fade } : {}),
      },
      warnings,
    }
  }

  migratable.sort((a, b) => a.at - b.at)
  const points = migratable.map(({ at, clip }) => ({ at, clip }))
  if (defClip && !points.some((p) => p.clip === defClip)) {
    // Rule 3: anchor the default at/below the lowest threshold.
    let at = Math.min(0, points[0].at)
    if (points.some((p) => p.at === at)) at -= 1
    points.push({ at, clip: defClip })
    points.sort((a, b) => a.at - b.at)
  }
  return {
    spec: {
      params: [param],
      points,
      ...(defClip ? { default: defClip } : {}),
      ...(old.fade !== undefined ? { fade: old.fade } : {}),
    },
    warnings,
  }
}
