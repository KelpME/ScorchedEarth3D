/**
 * P4c Task 2 — JOINT constraint solver — PURE MATH (no world/DOM access).
 * plans/PHYSICS-DEPTH.md §P4c: fixed/point/distance/spring here; hinge/
 * prismatic/motors land in Task 3. The system (system.js) composes this
 * against the live world inside the existing impulse iteration.
 *
 * CONVENTIONS (inherited from solver.js):
 *  - Accumulate-then-clamp: λ' = max(λ+Δλ, 0) for unilateral (rope) axes;
 *    bilateral axes (fixed/point/spring) clamp symmetrically where noted.
 *    Only the DELTA (λ' − λ) is applied to the body descriptors.
 *  - Bodies are plain descriptors { vx,vy,vz, invMass, cx,cy,cz (center of
 *    mass), wx?,wy?,wz?, invInertia?: {ix,iy,iz}|null, lockFlags? } — the
 *    solve MUTATES velocity/ω fields; position fields are not touched
 *    (positional repair returns deltas for the caller, same contract as
 *    solveManifoldPosition).
 *  - Normal convention A→B: the rope/spring axis unit points from A's
 *    anchor to B's anchor; a positive λ PULLS B toward A (rope tension) —
 *    mirrored by the impulse application (−J on A, +J on B).
 *  - Units: stiffness in N/m (impulse = stiffness · error · dt); damping in
 *    N·s/m. Defaults spring 50 / 5 (schema in components/joint.js).
 *  - NaN contract: inputs assumed finite (the system layer validates);
 *    degenerate geometry (zero-length axes) emits a +X fallback direction,
 *    deterministic, never NaN.
 *  - No Map iteration drives any ordering decision; the system sorts
 *    joints by canonical (pair-key, type) before building.
 */

/** Deterministic +X fallback for a degenerate (zero-length) axis. */
const FALLBACK_AXIS = [1, 0, 0]

/** Unit-normalize [x,y,z] with the deterministic +X fallback. */
function unitOrFallback(dx, dy, dz) {
  const l = Math.hypot(dx, dy, dz)
  if (l < 1e-12) return FALLBACK_AXIS.slice()
  return [dx / l, dy / l, dz / l]
}

/**
 * Anchor derivation (plan rule): an anchor local offset resolves against
 * the body's center of mass; when absent the SHARED anchor is the MIDPOINT
 * between the body centers (both anchors coincide there).
 * @param {object} bodyA descriptor with cx,cy,cz center
 * @param {object} bodyB descriptor
 * @param {number[]|undefined} anchorA authored local offset [x,y,z]
 * @param {number[]|undefined} anchorB authored local offset [x,y,z]
 * @returns {{ ax,ay,az, bx,by,bz }} WORLD anchor points
 */
export function deriveAnchors(bodyA, bodyB, anchorA, anchorB) {
  const hasA = Array.isArray(anchorA) && anchorA.length === 3
  const hasB = Array.isArray(anchorB) && anchorB.length === 3
  if (hasA || hasB) {
    // Local offset = world anchor − body center (per side; the missing side
    // takes the SAME world point — authored anchors coincide by intent).
    const w = hasA && hasB ? null : null // resolved below from sides
    void w
    const axw = hasA
      ? [bodyA.cx + anchorA[0], bodyA.cy + anchorA[1], bodyA.cz + anchorA[2]]
      : null
    const bxw = hasB
      ? [bodyB.cx + anchorB[0], bodyB.cy + anchorB[1], bodyB.cz + anchorB[2]]
      : null
    // When only one side authored, share that side's world point.
    const p = hasA ? axw : bxw
    return { ax: p[0], ay: p[1], az: p[2], bx: p[0], by: p[1], bz: p[2] }
  }
  // Midpoint between body centers — the plan's auto-derivation rule.
  const mx = (bodyA.cx + bodyB.cx) / 2
  const my = (bodyA.cy + bodyB.cy) / 2
  const mz = (bodyA.cz + bodyB.cz) / 2
  return { ax: mx, ay: my, az: mz, bx: mx, by: my, bz: mz }
}

/**
 * Axis derivation: authored [x,y,z] verbatim; absent → the body-to-body
 * direction (B center − A center), unit-normalized (+X fallback when
 * coincident). Stored here for hinge/prismatic (Task 3) reuse.
 * @returns {[number, number, number]} unit axis
 */
export function deriveAxis(bodyA, bodyB, axis) {
  if (Array.isArray(axis) && axis.length === 3) return unitOrFallback(axis[0], axis[1], axis[2])
  return unitOrFallback(bodyB.cx - bodyA.cx, bodyB.cy - bodyA.cy, bodyB.cz - bodyA.cz)
}

/** Relative velocity at the anchors, B − A, with ω×r terms (angular path). */
function relativeVelocityAt(a, b, rA, rB) {
  const wax = Number.isFinite(a.wx) ? a.wx : 0
  const way = Number.isFinite(a.wy) ? a.wy : 0
  const waz = Number.isFinite(a.wz) ? a.wz : 0
  const wbx = Number.isFinite(b.wx) ? b.wx : 0
  const wby = Number.isFinite(b.wy) ? b.wy : 0
  const wbz = Number.isFinite(b.wz) ? b.wz : 0
  const wxaA = way * rA[2] - waz * rA[1]
  const wyaA = waz * rA[0] - wax * rA[2]
  const wzaA = wax * rA[1] - way * rA[0]
  const wxaB = wby * rB[2] - wbz * rB[1]
  const wyaB = wbz * rB[0] - wbx * rB[2]
  const wzbB = wbx * rB[1] - wby * rB[0]
  return [
    (b.vx + wxaB) - (a.vx + wxaA),
    (b.vy + wyaB) - (a.vy + wyaA),
    (b.vz + wzbB) - (a.vz + wzaA),
  ]
}

/** Per-axis effective inverse mass on the anchor line: Σ invMass + (r×n)²·I⁻¹
 * angular terms (rot-locked axes zeroed — mirrors solver.js effInvTensor's
 * diagonal path; the world-tensor 3×3 path is carried in invInertia3x3?). */
function effectiveMassAlong(bodyA, bodyB, rA, rB, n) {
  const lockA = new Set(bodyA.lockFlags || [])
  const lockB = new Set(bodyB.lockFlags || [])
  const iA = lockA.has('posX') && lockA.has('posY') && lockA.has('posZ') ? 0 : (bodyA.invMass || 0)
  const iB = lockB.has('posX') && lockB.has('posY') && lockB.has('posZ') ? 0 : (bodyB.invMass || 0)
  const rxnA = [
    rA[1] * n[2] - rA[2] * n[1],
    rA[2] * n[0] - rA[0] * n[2],
    rA[0] * n[1] - rA[1] * n[0],
  ]
  const rxnB = [
    rB[1] * n[2] - rB[2] * n[1],
    rB[2] * n[0] - rB[0] * n[2],
    rB[0] * n[1] - rB[1] * n[0],
  ]
  const angTerm = (body, lock, rxn) => {
    const I = body.invInertia3x3 || body.invInertia
    if (!I || typeof I !== 'object') return 0
    let s = 0
    const keys = ['x', 'y', 'z']
    for (let i = 0; i < 3; i++) {
      if (lock.has(`rot${keys[i].toUpperCase()}`)) continue
      s += rxn[i] * rxn[i] * (I[`i${keys[i]}`] ?? 0)
    }
    return s
  }
  return iA + iB + angTerm(bodyA, lockA, rxnA) + angTerm(bodyB, lockB, rxnB)
}

/** Shared anchor-line constraint state: rA, rB (center→anchor), unit axis
 * A→B, effective mass K. (Internal shared builder.) */
function anchorLine(bodyA, bodyB, opts = {}, anchorsAtCenters = false) {
  const an = anchorsAtCenters
    ? { ax: bodyA.cx || 0, ay: bodyA.cy || 0, az: bodyA.cz || 0, bx: bodyB.cx || 0, by: bodyB.cy || 0, bz: bodyB.cz || 0 }
    : deriveAnchors(bodyA, bodyB, opts.anchorA, opts.anchorB)
  const rA = [an.ax - (bodyA.cx || 0), an.ay - (bodyA.cy || 0), an.az - (bodyA.cz || 0)]
  const rB = [an.bx - (bodyB.cx || 0), an.by - (bodyB.cy || 0), an.bz - (bodyB.cz || 0)]
  const n = unitOrFallback(an.bx - an.ax, an.by - an.ay, an.bz - an.az)
  return { an, rA, rB, n, K: effectiveMassAlong(bodyA, bodyB, rA, rB, n) }
}

/** Apply impulse J (along the constraint) — −J on A, +J on B (linear only;
 * angular ω response on the anchor lever arms when the body carries inertia). */
function applyAnchorImpulse(c, jx, jy, jz) {
  const a = c.bodyA, b = c.bodyB
  // Position-locked axes must not receive linear impulse (the body cannot
  // translate there) — otherwise the locked body's descriptor velocity
  // mutates and the next Gauss-Seidel pass reverses the constraint impulse
  // (observed: rope impulse oscillating ±4, never arresting).
  const lockA = new Set(a.lockFlags || [])
  const lockB = new Set(b.lockFlags || [])
  const axes = ['x', 'y', 'z']
  const j = [jx, jy, jz]
  for (let i = 0; i < 3; i++) {
    const key = axes[i]
    if (!lockA.has(`pos${key.toUpperCase()}`)) a[`v${key}`] -= j[i] * c.iA
    if (!lockB.has(`pos${key.toUpperCase()}`)) b[`v${key}`] += j[i] * c.iB
  }
  const applyAng = (body, r, sign) => {
    const lock = new Set(body.lockFlags || [])
    const I = body.invInertia3x3 || body.invInertia
    if (!I || typeof I !== 'object') return
    const rxJ = [
      r[1] * jz - r[2] * jy,
      r[2] * jx - r[0] * jz,
      r[0] * jy - r[1] * jx,
    ]
    const keys = ['x', 'y', 'z']
    for (let i = 0; i < 3; i++) {
      if (lock.has(`rot${keys[i].toUpperCase()}`)) continue
      const k = `i${keys[i]}`
      const inv = I[k] !== undefined ? I[k] : 0
      const wKey = `w${keys[i]}`
      body[wKey] = (Number.isFinite(body[wKey]) ? body[wKey] : 0) + sign * rxJ[i] * inv
    }
  }
  if (c.tA) applyAng(a, c.rA, -1)
  if (c.tB) applyAng(b, c.rB, +1)
}

/**
 * FIXED (weld): zero the relative velocity AT THE ANCHOR on all three axes
 * + position repair pulling the anchors together (Baumgarte-style bias,
 * weighted by invMass — statics/kinematics take zero correction).
 * @param {object} bodyA descriptor
 * @param {object} bodyB descriptor
 * @param {object} joint authored joint data ({ type:'fixed', other, ... })
 * @param {object} centerA { x,y,z } body A center
 * @param {object} centerB { x,y,z } body B center
 * @param {object} [opts] { bias = 0 } precomputed Baumgarte bias velocity
 * @returns constraint (solved by solveJointConstraint)
 */
export function buildFixedJointConstraint(bodyA, bodyB, joint, centerA, centerB, opts = {}) {
  void centerA; void centerB // centers ride on the descriptors (cx..cz)
  // Default anchors = the BODY CENTERS: the weld preserves the authored
  // separation. (Coincident midpoint anchors would pull the centers INTO
  // each other — the drift/explosion observed pre-fix.) Authored anchors
  // still win.
  const line = anchorLine(bodyA, bodyB, joint, !joint.anchorA && !joint.anchorB)
  return {
    kind: 'fixed',
    type: 'fixed',
    bodyA, bodyB,
    rA: line.rA, rB: line.rB, n: line.n,
    K: [line.K, line.K, line.K], // one scalar K per axis placeholder — per-axis below
    iA: bodyA.invMass || 0,
    iB: bodyB.invMass || 0,
    tA: bodyA.invInertia || bodyA.invInertia3x3 || null,
    tB: bodyB.invInertia || bodyB.invInertia3x3 || null,
    bias: opts.bias || 0,
    // Per-axis scalar K (linear-only here; the angular lever terms are inside
    // effectiveMassAlong's single-axis answer — the weld axis is the anchor
    // line, so K[0] is used for the 3-dof linear solve below).
    lx: 0, ly: 0, lz: 0,
  }
}

/**
 * POINT (ball/socket): 3-dof linear constraint — anchors coincide, angular
 * free. Same anchor-line machinery as fixed; position correction on the
 * anchor error.
 */
export function buildPointJointConstraint(bodyA, bodyB, joint, centerA, centerB, opts = {}) {
  // Same center-anchor default as fixed (preserves authored separation).
  const c = buildFixedJointConstraint(bodyA, bodyB, joint, centerA, centerB, opts)
  c.kind = 'point'
  c.type = 'point'
  return c
}

/**
 * DISTANCE (rope): |anchorB − anchorA| within [minDist, maxDist] (absent
 * min/max derived from the INITIAL configuration — the caller passes them
 * pre-derived in joint.minDist/joint.maxDist). Unilateral: taut only when
 * stretched beyond max or compressed below min.
 * @param {object} [opts] { restLength } fallback when both bounds absent
 */
export function buildDistanceJointConstraint(bodyA, bodyB, joint, centerA, centerB, opts = {}) {
  void centerA; void centerB
  // Distance anchors default to the BODY CENTERS (their initial separation
  // is the rest geometry — coincident midpoint anchors are meaningless for a
  // rope and made the spring/rope err a constant −restLength: runaway).
  const line = anchorLine(bodyA, bodyB, joint, !joint.anchorA && !joint.anchorB)
  const dx = line.an.bx - line.an.ax, dy = line.an.by - line.an.ay, dz = line.an.bz - line.an.az
  const dist = Math.hypot(dx, dy, dz)
  let minDist = joint.minDist
  let maxDist = joint.maxDist
  if (minDist === undefined && maxDist === undefined) {
    minDist = maxDist = opts.restLength ?? dist
  } else if (minDist === undefined) {
    minDist = 0
  } else if (maxDist === undefined) {
    maxDist = minDist
  }
  // Inequality activation, SPECULATIVE on the predicted end-of-step
  // separation: the joint block runs after velocity integration but BEFORE
  // transforms move, so the current dist lags — a rope tested on dist alone
  // activates a step late and never arrests a fling (observed maxSeen 8.0
  // with maxDist 1.5). Predicted = dist + vSep·dt; taut/push on predicted.
  // sign: +1 = pull toward A's anchor (rope tension), −1 = push.
  const rv0 = relativeVelocityAt(bodyA, bodyB, line.rA, line.rB)
  const vSep0 = rv0[0] * line.n[0] + rv0[1] * line.n[1] + rv0[2] * line.n[2]
  const dtP = opts.dt ?? 1 / 60
  const predicted = dist + vSep0 * dtP
  let active = 0
  // Baumgarte-style bias: the position error against the violated bound,
  // expressed as a separation velocity the solver drives toward. Without it
  // a STATIC overlap (vSep = 0) has zero target velocity and the rope never
  // pushes/pulls the bodies to the boundary.
  const JOINT_BIAS = 0.4 // percent of the position error per step
  let bias = 0
  if (predicted > maxDist) {
    active = 1
    bias = -JOINT_BIAS * (predicted - maxDist) / dtP // negative: pull B back
  } else if (predicted < minDist) {
    active = -1
    bias = JOINT_BIAS * (minDist - predicted) / dtP // positive: push B out
  }
  return {
    kind: 'distance',
    type: 'distance',
    bodyA, bodyB,
    rA: line.rA, rB: line.rB, n: line.n,
    K: line.K,
    iA: bodyA.invMass || 0,
    iB: bodyB.invMass || 0,
    tA: bodyA.invInertia || bodyA.invInertia3x3 || null,
    tB: bodyB.invInertia || bodyB.invInertia3x3 || null,
    dist,
    minDist,
    maxDist,
    active, // 0 = slack (no-op), ±1 = pull/push
    bias,
    l: 0,
  }
}

/**
 * SPRING (soft distance): implicit spring-damper on the anchor separation.
 * stiffness (N/m, default 50), damping (N·s/m, default 5). The impulse is
 * J = (stiffness·err + damping·vRel)·dt — soft, NOT clamped unilateral
 * (a spring pulls AND pushes), so λ is bilateral.
 */
export function buildSpringJointConstraint(bodyA, bodyB, joint, centerA, centerB, opts = {}) {
  void centerA; void centerB
  // Same center-anchor default as distance (see above).
  const line = anchorLine(bodyA, bodyB, joint, !joint.anchorA && !joint.anchorB)
  const dx = line.an.bx - line.an.ax, dy = line.an.by - line.an.ay, dz = line.an.bz - line.an.az
  const dist = Math.hypot(dx, dy, dz)
  let restLength = joint.restLength
  if (restLength === undefined) {
    restLength = (joint.minDist !== undefined && joint.maxDist !== undefined)
      ? (joint.minDist + joint.maxDist) / 2
      : opts.restLength ?? dist
  }
  return {
    kind: 'spring',
    type: 'spring',
    bodyA, bodyB,
    rA: line.rA, rB: line.rB, n: line.n,
    K: line.K,
    iA: bodyA.invMass || 0,
    iB: bodyB.invMass || 0,
    tA: bodyA.invInertia || bodyA.invInertia3x3 || null,
    tB: bodyB.invInertia || bodyB.invInertia3x3 || null,
    dist,
    restLength,
    stiffness: joint.stiffness ?? 50,
    damping: joint.damping ?? 5,
    bias: opts.bias || 0,
    l: 0,
  }
}

/**
 * HINGE (P4c-3): 1-axis rotational joint. Frozen design:
 *  (a) 3-dof linear point constraint at the shared anchor (the point
 *      machinery — anchors coincide by midpoint rule or authored);
 *  (b) relative angular velocity allowed ONLY about the axis: the two
 *      perpendicular components are zeroed with the SAFE momentum-averaging
 *      pattern (the weld's invI-weighted mean, applied per perpendicular
 *      component — idempotent, bounded; NOT the exploded iterative form);
 *  (c) optional limits jointLimitMin/Max (rad) on the ACCUMULATED angle
 *      about the axis (runtime state, opts.angle) — sign-gated speculative
 *      inequality (predicted = angle + ω_rel·dt) with the rope's 0.4
 *      Baumgarte bias;
 *  (d) optional motor: motorSpeed (rad/s) drives ω_rel toward the target,
 *      accumulated impulse clamped |λ| ≤ maxMotorForce·dt (0 = no motor).
 * The axis is FROZEN from the initial configuration (opts.frozenAxis — the
 * system persists it per joint pair); absent, deriveAxis at build time.
 */
function rotInvMassAlong(body, u) {
  const lock = new Set(body.lockFlags || [])
  const I = body.invInertia3x3 || body.invInertia
  if (!I || typeof I !== 'object') return 0
  let s = 0
  const keys = ['x', 'y', 'z']
  for (let i = 0; i < 3; i++) {
    if (lock.has(`rot${keys[i].toUpperCase()}`)) continue
    s += u[i] * u[i] * (I[`i${keys[i]}`] ?? 0)
  }
  return s
}

/** Relative angular velocity of B w.r.t. A projected on u. */
function relOmegaU(a, b, u) {
  const wax = Number.isFinite(a.wx) ? a.wx : 0
  const way = Number.isFinite(a.wy) ? a.wy : 0
  const waz = Number.isFinite(a.wz) ? a.wz : 0
  const wbx = Number.isFinite(b.wx) ? b.wx : 0
  const wby = Number.isFinite(b.wy) ? b.wy : 0
  const wbz = Number.isFinite(b.wz) ? b.wz : 0
  return (wbx - wax) * u[0] + (wby - way) * u[1] + (wbz - waz) * u[2]
}

/** Torque impulse ju·u: −ju·u on A, +ju·u on B (rot-locked axes skipped). */
function applyRotImpulseU(c, ju) {
  const apply = (body, sign) => {
    const lock = new Set(body.lockFlags || [])
    const I = body.invInertia3x3 || body.invInertia
    if (!I || typeof I !== 'object') return
    const keys = ['x', 'y', 'z']
    for (let i = 0; i < 3; i++) {
      if (lock.has(`rot${keys[i].toUpperCase()}`)) continue
      const k = keys[i]
      const inv = I[`i${k}`] !== undefined ? I[`i${k}`] : 0
      const wKey = `w${k}`
      body[wKey] = (Number.isFinite(body[wKey]) ? body[wKey] : 0) + sign * ju * c.u[i] * inv
    }
  }
  apply(c.bodyA, -1)
  apply(c.bodyB, +1)
}

/** Hinge (b): zero the PERPENDICULAR relative ω via the weld's safe
 * momentum-averaging, per world axis, keeping each body's along-axis
 * component (the free hinge spin) untouched. Locked axes pin the partner
 * to the locked body's (zero) perpendicular value. Idempotent: after one
 * application the relative perpendicular ω is exactly 0. */
function zeroPerpAngular(c) {
  const a = c.bodyA, b = c.bodyB, u = c.u
  const read = (body) => {
    const w = [0, 0, 0]
    const keys = ['x', 'y', 'z']
    for (let i = 0; i < 3; i++) w[i] = Number.isFinite(body[`w${keys[i]}`]) ? body[`w${keys[i]}`] : 0
    const wu = w[0] * u[0] + w[1] * u[1] + w[2] * u[2]
    return { w, wu, I: body.invInertia3x3 || body.invInertia, lock: new Set(body.lockFlags || []) }
  }
  const A = read(a), B = read(b)
  const keys = ['x', 'y', 'z']
  for (let i = 0; i < 3; i++) {
    const lockAi = A.lock.has(`rot${keys[i].toUpperCase()}`)
    const lockBi = B.lock.has(`rot${keys[i].toUpperCase()}`)
    if (lockAi && lockBi) continue
    const perpA = A.w[i] - A.wu * u[i]
    const perpB = B.w[i] - B.wu * u[i]
    let shared
    if (lockAi || lockBi) {
      shared = 0 // the locked body's perpendicular ω is rigidly 0
    } else {
      const ixA = A.I && typeof A.I === 'object' ? (A.I[`i${keys[i]}`] ?? 0) : 0
      const ixB = B.I && typeof B.I === 'object' ? (B.I[`i${keys[i]}`] ?? 0) : 0
      if (!(ixA + ixB > 0)) continue
      shared = (perpA * ixA + perpB * ixB) / (ixA + ixB) // the weld mean
    }
    if (!lockAi && A.I && typeof A.I === 'object') a[`w${keys[i]}`] = A.wu * u[i] + shared
    if (!lockBi && B.I && typeof B.I === 'object') b[`w${keys[i]}`] = B.wu * u[i] + shared
  }
}

export function buildHingeJointConstraint(bodyA, bodyB, joint, centerA, centerB, opts = {}) {
  void centerA; void centerB
  const line = anchorLine(bodyA, bodyB, joint, !joint.anchorA && !joint.anchorB)
  const u = opts.frozenAxis
    ? unitOrFallback(opts.frozenAxis[0], opts.frozenAxis[1], opts.frozenAxis[2])
    : deriveAxis(bodyA, bodyB, joint.axis)
  const angle = opts.angle ?? 0
  const dtP = opts.dt ?? 1 / 60
  const hasLimit = joint.jointLimitMin !== undefined || joint.jointLimitMax !== undefined
  const limitMin = hasLimit ? (joint.jointLimitMin ?? 0) : 0
  const limitMax = hasLimit ? (joint.jointLimitMax ?? 0) : 0
  // Speculative limit activation on the PREDICTED angle (rope pattern).
  let limitActive = 0
  let limitBias = 0
  if (hasLimit) {
    const predicted = angle + relOmegaU(bodyA, bodyB, u) * dtP
    const JOINT_BIAS = 0.4
    if (predicted > limitMax) {
      limitActive = 1
      limitBias = -JOINT_BIAS * (predicted - limitMax) / dtP
    } else if (predicted < limitMin) {
      limitActive = -1
      limitBias = JOINT_BIAS * (limitMin - predicted) / dtP
    }
  }
  return {
    kind: 'hinge',
    type: 'hinge',
    bodyA, bodyB,
    rA: line.rA, rB: line.rB, u,
    angle,
    hasLimit, limitMin, limitMax, limitActive, limitBias,
    Kt: rotInvMassAlong(bodyA, u) + rotInvMassAlong(bodyB, u),
    motorSpeed: joint.motorSpeed ?? 0,
    maxMotorForce: joint.maxMotorForce ?? 0,
    dt: dtP,
    iA: bodyA.invMass || 0,
    iB: bodyB.invMass || 0,
    tA: bodyA.invInertia || bodyA.invInertia3x3 || null,
    tB: bodyB.invInertia || bodyB.invInertia3x3 || null,
    bias: opts.bias || 0,
    lx: 0, ly: 0, lz: 0,
    l: 0,
    motorL: 0,
  }
}

/**
 * PRISMATIC (P4c-3): 1-axis linear slider. Frozen design:
 *  (a) relative linear motion allowed ONLY along the axis — the two
 *      PERPENDICULAR linear components are solved as bilateral constraints
 *      (deterministic perpendicular basis from the frozen axis);
 *  (b) relative ω zeroed (the weld's ω-averaging);
 *  (c) optional limits jointLimitMin/Max (u along the axis, measured from
 *      the INITIAL anchor offset — opts.initOff persisted by the system):
 *      sign-gated speculative inequality (rope pattern, 0.4 bias);
 *  (d) optional motor: motorSpeed (u/s) drives the relative axial velocity,
 *      accumulated impulse clamped |λ| ≤ maxMotorForce·dt.
 */
/** Deterministic perpendicular basis for a unit axis u. */
function perpBasis(u) {
  const abs = [Math.abs(u[0]), Math.abs(u[1]), Math.abs(u[2])]
  let mi = 0
  if (abs[1] < abs[mi]) mi = 1
  if (abs[2] < abs[mi]) mi = 2
  const e1 = [0, 0, 0]
  e1[mi] = 1
  const e2 = [
    u[1] * e1[2] - u[2] * e1[1],
    u[2] * e1[0] - u[0] * e1[2],
    u[0] * e1[1] - u[1] * e1[0],
  ]
  return [e1, e2]
}

export function buildPrismaticJointConstraint(bodyA, bodyB, joint, centerA, centerB, opts = {}) {
  void centerA; void centerB
  const line = anchorLine(bodyA, bodyB, joint, !joint.anchorA && !joint.anchorB)
  const u = opts.frozenAxis
    ? unitOrFallback(opts.frozenAxis[0], opts.frozenAxis[1], opts.frozenAxis[2])
    : deriveAxis(bodyA, bodyB, joint.axis)
  const [e1, e2] = perpBasis(u)
  // Axial offset vs the joint's INITIAL configuration (runtime state).
  const rawOff = (line.an.bx - line.an.ax) * u[0] + (line.an.by - line.an.ay) * u[1] + (line.an.bz - line.an.az) * u[2]
  const offU = rawOff - (opts.initOff ?? 0)
  const rv0 = relativeVelocityAt(bodyA, bodyB, line.rA, line.rB)
  const vRelU = rv0[0] * u[0] + rv0[1] * u[1] + rv0[2] * u[2]
  const dtP = opts.dt ?? 1 / 60
  const hasLimit = joint.jointLimitMin !== undefined || joint.jointLimitMax !== undefined
  const limitMin = hasLimit ? (joint.jointLimitMin ?? 0) : 0
  const limitMax = hasLimit ? (joint.jointLimitMax ?? 0) : 0
  let limitActive = 0
  let limitBias = 0
  if (hasLimit) {
    const predicted = offU + vRelU * dtP
    const JOINT_BIAS = 0.4
    if (predicted > limitMax) {
      limitActive = 1
      limitBias = -JOINT_BIAS * (predicted - limitMax) / dtP
    } else if (predicted < limitMin) {
      limitActive = -1
      limitBias = JOINT_BIAS * (limitMin - predicted) / dtP
    }
  }
  return {
    kind: 'prismatic',
    type: 'prismatic',
    bodyA, bodyB,
    rA: line.rA, rB: line.rB, u, e1, e2,
    offU,
    hasLimit, limitMin, limitMax, limitActive, limitBias,
    K: effectiveMassAlong(bodyA, bodyB, line.rA, line.rB, u),
    motorSpeed: joint.motorSpeed ?? 0,
    maxMotorForce: joint.maxMotorForce ?? 0,
    dt: dtP,
    iA: bodyA.invMass || 0,
    iB: bodyB.invMass || 0,
    tA: bodyA.invInertia || bodyA.invInertia3x3 || null,
    tB: bodyB.invInertia || bodyB.invInertia3x3 || null,
    lx: 0, ly: 0, lz: 0,
    l: 0,
    motorL: 0,
  }
}

/**
 * One solve pass over a joint constraint — ACCUMULATE-THEN-CLAMP (mirror of
 * solveContactConstraint). Mutates accumulated impulses + body velocities.
 *  - fixed/point: 3-dof linear solve along world X/Y/Z at the anchor
 *    (bilateral λ per axis; K per axis from the linear masses — the scalar
 *    K from the anchor line is the LINE mass; per-axis we reuse it).
 *  - distance: unilateral along the rope axis (λ' = max(λ+Δλ, 0) for pull,
 *    λ' = min(λ+Δλ, 0) for push — the clamp is sign-gated by `active`).
 *  - spring: implicit force impulse (bilateral, no clamp).
 * @param {object} c constraint from a build* fn
 * @returns c
 */
export function solveJointConstraint(c) {
  const a = c.bodyA, b = c.bodyB
  if (c.kind === 'fixed' || c.kind === 'point') {
    // 3-dof linear solve at the anchor, one axis at a time (X, Y, Z).
    const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    const lam = ['lx', 'ly', 'lz']
    for (let k = 0; k < 3; k++) {
      const n = axes[k]
      const K = effectiveMassAlong(a, b, c.rA, c.rB, n)
      if (!(K > 0)) continue
      const rv = relativeVelocityAt(a, b, c.rA, c.rB)
      const vn = rv[0] * n[0] + rv[1] * n[1] + rv[2] * n[2]
      const dlam = (c.bias - vn) / K
      const lOld = c[lam[k]]
      c[lam[k]] = lOld + dlam
      applyAnchorImpulse(c, (c[lam[k]] - lOld) * n[0], (c[lam[k]] - lOld) * n[1], (c[lam[k]] - lOld) * n[2])
    }
    // Weld torque (fixed only): zero relative ω by MOMENTUM-AVERAGING —
    // both bodies take the invInertia-weighted mean ω per axis (a single
    // non-iterative application). The iterative accumulate-then-clamp
    // version of this solve fed back positively with the stale lever arms
    // (ω grew 0.86 → 193 → 126,883 rad/s in three steps) — the mean-ω form
    // is momentum-conserving and unconditionally stable. Point joints
    // leave ω free.
    if (c.kind === 'fixed') {
      const lockA = new Set(a.lockFlags || [])
      const lockB = new Set(b.lockFlags || [])
      const IA = a.invInertia3x3 || a.invInertia
      const IB = b.invInertia3x3 || b.invInertia
      const keys = ['x', 'y', 'z']
      for (let i = 0; i < 3; i++) {
        if (lockA.has(`rot${keys[i].toUpperCase()}`) || lockB.has(`rot${keys[i].toUpperCase()}`)) continue
        const ixA = IA ? (IA[`i${keys[i]}`] ?? 0) : 0
        const ixB = IB ? (IB[`i${keys[i]}`] ?? 0) : 0
        const Kt = ixA + ixB
        if (!(Kt > 0)) continue
        const wa = Number.isFinite(a[`w${keys[i]}`]) ? a[`w${keys[i]}`] : 0
        const wb = Number.isFinite(b[`w${keys[i]}`]) ? b[`w${keys[i]}`] : 0
        // Momentum-conserving mean: L = wa/ixA + wb/ixB shared → ω = L·(I_eff).
        const wMean = (wa * ixA + wb * ixB) / Kt
        a[`w${keys[i]}`] = wMean
        b[`w${keys[i]}`] = wMean
      }
    }
    return c
  }
  if (c.kind === 'hinge') {
    // (a) 3-dof linear solve at the anchor (the point machinery).
    const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    const lam = ['lx', 'ly', 'lz']
    for (let k = 0; k < 3; k++) {
      const n = axes[k]
      const K = effectiveMassAlong(a, b, c.rA, c.rB, n)
      if (!(K > 0)) continue
      const rv = relativeVelocityAt(a, b, c.rA, c.rB)
      const vn = rv[0] * n[0] + rv[1] * n[1] + rv[2] * n[2]
      const dlam = (c.bias - vn) / K
      const lOld = c[lam[k]]
      c[lam[k]] = lOld + dlam
      applyAnchorImpulse(c, (c[lam[k]] - lOld) * n[0], (c[lam[k]] - lOld) * n[1], (c[lam[k]] - lOld) * n[2])
    }
    // (b) perpendicular relative ω zeroed — safe momentum-averaging (once
    // per solve call, idempotent).
    zeroPerpAngular(c)
    // (c) limits: sign-gated speculative inequality on the angle about u.
    if (c.limitActive !== 0 && c.Kt > 0) {
      const wRel = relOmegaU(a, b, c.u)
      const target = c.limitBias
      const dlam = (target - wRel) / c.Kt
      const lOld = c.l
      // Pull mode (over max): the corrective torque opposes +ωu → λ ≤ 0
      // (the impulse is −λ·u on A, +λ·u on B; negative λ drives ω_rel down).
      // Push mode (under min): λ ≥ 0.
      const lNew = c.limitActive === 1 ? Math.min(lOld + dlam, 0) : Math.max(lOld + dlam, 0)
      c.l = lNew
      applyRotImpulseU(c, lNew - lOld)
    }
    // (d) motor: drive ω_rel toward motorSpeed, |λ_acc| ≤ maxMotorForce·dt.
    // Only the CLAMPED delta is applied — the raw Δλ past a saturated
    // accumulator would keep pumping torque (the starved-motor leak).
    if (c.maxMotorForce > 0 && c.Kt > 0) {
      const wRel = relOmegaU(a, b, c.u)
      const dlam = (c.motorSpeed - wRel) / c.Kt
      const maxL = c.maxMotorForce * c.dt
      const lOld = c.motorL
      c.motorL = Math.min(Math.max(lOld + dlam, -maxL), maxL)
      applyRotImpulseU(c, c.motorL - lOld)
    }
    return c
  }
  if (c.kind === 'prismatic') {
    // (b) relative ω zeroed FIRST (the weld's momentum-averaging) — the
    // perpendicular anchor solves below read ω through the lever arms; a
    // fresh fling's ω spike leaks past them into a standing linear residual
    // if not averaged away first (observed vy+wz = 0.41 each surviving).
    {
      const lockA = new Set(a.lockFlags || [])
      const lockB = new Set(b.lockFlags || [])
      const IA = a.invInertia3x3 || a.invInertia
      const IB = b.invInertia3x3 || b.invInertia
      const keys = ['x', 'y', 'z']
      for (let i = 0; i < 3; i++) {
        const lockAi = lockA.has(`rot${keys[i].toUpperCase()}`)
        const lockBi = lockB.has(`rot${keys[i].toUpperCase()}`)
        if (lockAi && lockBi) continue
        const wa = Number.isFinite(a[`w${keys[i]}`]) ? a[`w${keys[i]}`] : 0
        const wb = Number.isFinite(b[`w${keys[i]}`]) ? b[`w${keys[i]}`] : 0
        // A rot-locked side pins the pair to ITS ω (rigidly 0) — skipping
        // left the free body a spin-drift pair (vy=wz standing wave) the
        // anchor constraint cannot see. Both free → the weld mean.
        if (lockAi || lockBi) {
          const pinned = lockAi ? wa : wb
          if (!lockAi) a[`w${keys[i]}`] = pinned
          if (!lockBi) b[`w${keys[i]}`] = pinned
          continue
        }
        const ixA = IA ? (IA[`i${keys[i]}`] ?? 0) : 0
        const ixB = IB ? (IB[`i${keys[i]}`] ?? 0) : 0
        const Kt = ixA + ixB
        if (!(Kt > 0)) continue
        const wMean = (wa * ixA + wb * ixB) / Kt
        a[`w${keys[i]}`] = wMean
        b[`w${keys[i]}`] = wMean
      }
    }
    // (a) the two PERPENDICULAR linear components are bilateral constraints.
    for (const key of ['e1', 'e2']) {
      const n = c[key]
      const K = effectiveMassAlong(a, b, c.rA, c.rB, n)
      if (!(K > 0)) continue
      const rv = relativeVelocityAt(a, b, c.rA, c.rB)
      const vn = rv[0] * n[0] + rv[1] * n[1] + rv[2] * n[2]
      const dlam = (0 - vn) / K
      const lamKey = key === 'e1' ? 'lx' : 'ly'
      const lOld = c[lamKey]
      c[lamKey] = lOld + dlam
      applyAnchorImpulse(c, (c[lamKey] - lOld) * n[0], (c[lamKey] - lOld) * n[1], (c[lamKey] - lOld) * n[2])
    }
    // (c) axial limits (speculative, rope-pattern).
    if (c.limitActive !== 0 && c.K > 0) {
      const rv = relativeVelocityAt(a, b, c.rA, c.rB)
      const vRelU = rv[0] * c.u[0] + rv[1] * c.u[1] + rv[2] * c.u[2]
      const dlam = (c.limitBias - vRelU) / c.K
      const lOld = c.l
      // Over max: pull B back → λ ≤ 0; under min: push out → λ ≥ 0.
      const lNew = c.limitActive === 1 ? Math.min(lOld + dlam, 0) : Math.max(lOld + dlam, 0)
      c.l = lNew
      applyAnchorImpulse(c, (lNew - lOld) * c.u[0], (lNew - lOld) * c.u[1], (lNew - lOld) * c.u[2])
    }
    // (d) axial motor — only the CLAMPED delta is applied (see hinge).
    if (c.maxMotorForce > 0 && c.K > 0) {
      const rv = relativeVelocityAt(a, b, c.rA, c.rB)
      const vRelU = rv[0] * c.u[0] + rv[1] * c.u[1] + rv[2] * c.u[2]
      const dlam = (c.motorSpeed - vRelU) / c.K
      const maxL = c.maxMotorForce * c.dt
      const lOld = c.motorL
      c.motorL = Math.min(Math.max(lOld + dlam, -maxL), maxL)
      const d = c.motorL - lOld
      applyAnchorImpulse(c, d * c.u[0], d * c.u[1], d * c.u[2])
    }
    return c
  }
  if (c.kind === 'distance') {
    if (c.active === 0) return c // slack rope: no-op this pass
    const rv = relativeVelocityAt(a, b, c.rA, c.rB)
    const vn = rv[0] * c.n[0] + rv[1] * c.n[1] + rv[2] * c.n[2]
    // Target: drive the anchor's separating velocity TO the bias velocity
    // (the position error healed over one step). For pull (active=1) the
    // bias is NEGATIVE (B pulled back toward A); for push (active=−1) it is
    // POSITIVE (B pushed away). vn sign matches n (A→B): positive vn = B
    // separating. So target = bias works for both — the SIGN-GATED CLAMP
    // (pull λ ≤ 0, push λ ≥ 0) keeps each mode unilateral.
    const target = c.bias
    if (!(c.K > 0)) return c
    const dlam = (target - vn) / c.K
    const lOld = c.l
    // Sign-gated clamp: the tension impulse on B is NEGATIVE along n (n
    // points A→B, pulling B back) — so pull (active=1) keeps λ ≤ 0, and the
    // push (active=−1) keeps λ ≥ 0. (The original max/min was inverted —
    // the correcting λ was clamped away and the rope never arrested.)
    const lNew = c.active === 1 ? Math.min(lOld + dlam, 0) : Math.max(lOld + dlam, 0)
    c.l = lNew
    // Impulse: −λ·n on A, +λ·n on B (tension pulls B toward A).
    applyAnchorImpulse(c, (lNew - lOld) * c.n[0], (lNew - lOld) * c.n[1], (lNew - lOld) * c.n[2])
    return c
  }
  if (c.kind === 'spring') {
    // Implicit spring-damper impulse along the anchor axis (bilateral):
    // J = (−stiffness·err − damping·vSep)·dt where err = dist − restLength
    // (positive = stretched → pull B back) and vSep = d(dist)/dt along n.
    // dt-scaled FORCE semantics: applied ONCE per solve pass — the system
    // calls the spring solve exactly once per step (build in the wiring,
    // not per Gauss-Seidel iteration), so no iteration compounding.
    if (!(c.K > 0)) return c
    const err = c.dist - c.restLength
    const rv = relativeVelocityAt(a, b, c.rA, c.rB)
    const vSep = rv[0] * c.n[0] + rv[1] * c.n[1] + rv[2] * c.n[2]
    const f = -c.stiffness * err - c.damping * vSep
    // Stability clamp (Box2D-style soft-constraint formulation): the raw
    // J = f·dt is bounded so the discrete update can never overshoot the
    // rest state in one step. Two bounds:
    //  - damping: never reverses the separation speed (|Jd| ≤ K·|vSep| —
    //    full cancellation is the limit, reversal would inject energy);
    //  - stiffness: at most a 30% positional-error heal per step
    //    (β = 0.3, the Baumgarte percent scale) IN VELOCITY UNITS:
    //    Jk ≤ K·β·|err| — the discrete oscillator then always decays.
    // The raw spring (stiffness 50, dt 1/60, m 1) overshoots 8×/step —
    // the observed B.x = 50 runaway; clamped, it oscillates and settles.
    const dtS = c.dt ?? 1 / 60
    const iMass = c.K
    const JDampRaw = -c.damping * vSep * dtS
    const JDamp = Math.abs(JDampRaw) > iMass * Math.abs(vSep)
      ? Math.sign(JDampRaw) * iMass * Math.abs(vSep)
      : JDampRaw
    const JStiffRaw = -c.stiffness * err * dtS
    // Max per-step Δv contribution from the stiffness term: β·|err| with
    // β = 0.3 (the Baumgarte percent scale) — the discrete oscillator then
    // always decays (the raw spring overshoots and GAINS energy every step
    // when stiffness·dt·K > 1: the observed B.x = 50 runaway).
    const JStiff = Math.sign(JStiffRaw) * Math.min(Math.abs(JStiffRaw), 0.3 * Math.abs(err))
    const J = JStiff + JDamp
    const lOld = c.l
    c.l = lOld + J
    applyAnchorImpulse(c, (c.l - lOld) * c.n[0], (c.l - lOld) * c.n[1], (c.l - lOld) * c.n[2])
    return c
  }
  return c
}

/**
 * Position repair for weld/point joints — pure deltas (mirror of
 * solveManifoldPosition): pull the anchors together, invMass-weighted,
 * statics/kinematics take zero correction.
 * @param {object} c constraint (fixed/point)
 * @param {number} [percent] fraction of the anchor error to repair per pass
 * @returns {{ dax,day,daz, dbx,dby,dbz }} displacements to ADD to bodies
 */
export function solveJointPosition(c, percent = 0.2) {
  const out = { dax: 0, day: 0, daz: 0, dbx: 0, dby: 0, dbz: 0 }
  if (c.kind !== 'fixed' && c.kind !== 'point') return out
  const a = c.bodyA, b = c.bodyB
  const iA = a.invMass || 0, iB = b.invMass || 0
  if (iA + iB <= 0) return out
  // The error repaired is the DRIFT from the joint's INITIAL relative anchor
  // offset (c.initOffset = worldAnchorB − worldAnchorA at first build) — NOT
  // the raw anchor gap. A weld/point preserves the authored configuration;
  // pulling the raw gap to zero would collapse the bodies into each other.
  const init = c.initOffset || [0, 0, 0]
  const err = [
    ((b.cx + c.rB[0]) - (a.cx + c.rA[0])) - init[0],
    ((b.cy + c.rB[1]) - (a.cy + c.rA[1])) - init[1],
    ((b.cz + c.rB[2]) - (a.cz + c.rA[2])) - init[2],
  ]
  const wA = iA / (iA + iB), wB = iB / (iA + iB)
  for (let k = 0; k < 3; k++) {
    const corr = err[k] * percent
    const key = 'xyz'[k]
    const lockA = new Set(a.lockFlags || [])
    const lockB = new Set(b.lockFlags || [])
    // Sign convention: err = (B-anchor − A-anchor) − init. To REDUCE err,
    // A moves ALONG +err (toward B's excess) and B moves ALONG −err — the
    // original signs (A −=, B +=) DIVERGED, doubling the error every pass
    // (the welded-pair explosion to a.y ≈ 10^5).
    if (iA > 0 && !lockA.has(`pos${key.toUpperCase()}`)) out[['dax', 'day', 'daz'][k]] += corr * wA
    if (iB > 0 && !lockB.has(`pos${key.toUpperCase()}`)) out[['dbx', 'dby', 'dbz'][k]] -= corr * wB
  }
  return out
}
