/**
 * Agent capability PROFILE + the height-aware walkability rules (Phase P2.5
 * W3, plans/NAV-UX-REVISION.md D-5). Pure, Node-safe — no engine imports.
 *
 * A profile is plain declared data, exactly the `nav-agent` component fields:
 *   { radius, height, maxSlope (deg), stepHeight, jumpHeight }
 * `normalizeProfile` fills the schema defaults (45 / 0.5 / 1) for absent or
 * invalid ability fields and KEEPS the declared BODY DIMS radius/height (W6c-
 * 3: they rode into class resolution — the e526c70 strip made multi-class
 * routing unreachable). A dim that is absent/invalid is simply not present in
 * the result — the query lands on the DEFAULT clearance class (radius 0.5,
 * height 2 — navmesh.js NAVMESH_CLASS_DEFAULT), so legacy threshold-only
 * callers route exactly as before. A MISSING profile (undefined/null) means
 * PERMISSIVE/LEGACY — every rule passes and behavior is exactly the pre-W3
 * XZ-only nav.
 *
 * Rules (conservative — any failing rule blocks):
 *   - cell gate:      slope ≤ maxSlope (what a point query / snap accepts),
 *   - edge rule:      BOTH cells' slope ≤ maxSlope  OR  |Δh| ≤ stepHeight
 *                     (the small-ledge rescue: a crossing can be legal even
 *                     where the local slope is steep),
 *   - link gate:      |height(from) − height(to)| ≤ jumpHeight.
 * Diagonals additionally keep A*'s strict no-corner-cut cardinal rule.
 */

/** The `nav-agent` component's declared capability defaults. */
export const DEFAULT_CAPABILITY_PROFILE = Object.freeze({ maxSlope: 45, stepHeight: 0.5, jumpHeight: 1 })

/**
 * Normalize a declared profile: null/undefined/non-object -> null (the
 * PERMISSIVE/LEGACY marker — rules pass unconditionally); otherwise a NEW
 * { maxSlope, stepHeight, jumpHeight } with schema defaults for absent,
 * non-finite, or negative fields, PLUS the declared body dims {radius, height}
 * (W6c-3 — kept, never stripped: they select the CLEARANCE CLASS; an absent or
 * invalid dim is omitted and the query lands on the DEFAULT class).
 */
export function normalizeProfile(p) {
  if (p === undefined || p === null || typeof p !== 'object' || Array.isArray(p)) return null
  const pick = (v, d) => {
    if (v === undefined || v === null) return d
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : d
  }
  // Body dims: KEEP when validly declared (the caller's clearance class),
  // omit otherwise (the DEFAULT class at the navmesh layer fills them).
  const dim = (v) => {
    if (v === undefined || v === null) return undefined
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : undefined
  }
  const out = {
    maxSlope: pick(p.maxSlope, DEFAULT_CAPABILITY_PROFILE.maxSlope),
    stepHeight: pick(p.stepHeight, DEFAULT_CAPABILITY_PROFILE.stepHeight),
    jumpHeight: pick(p.jumpHeight, DEFAULT_CAPABILITY_PROFILE.jumpHeight),
  }
  const radius = dim(p.radius)
  const height = dim(p.height)
  if (radius !== undefined) out.radius = radius
  if (height !== undefined) out.height = height
  return out
}

/** Cell gate: a cell is point-queryable/snapable when its slope ≤ maxSlope. */
export function cellSlopeOk(slope, profile) {
  return !profile || slope <= profile.maxSlope
}

/**
 * Adjacent-cell step rule: pass when BOTH cells' slope ≤ maxSlope OR the
 * pairwise height delta |Δh| ≤ stepHeight (small-ledge rule). No profile ->
 * unconditional pass (legacy).
 */
export function edgeTraversable(slopeA, slopeB, heightDelta, profile) {
  if (!profile) return true
  if (Math.abs(heightDelta) <= profile.stepHeight) return true
  return slopeA <= profile.maxSlope && slopeB <= profile.maxSlope
}

/** Off-mesh link gate: traversable iff |Δh| between its endpoints ≤ jumpHeight. */
export function linkTraversable(heightDelta, profile) {
  if (!profile) return true
  return Math.abs(heightDelta) <= profile.jumpHeight
}
