/**
 * nav-agent movement CORE (Phase P2.5) — ONE implementation, two surfaces.
 *
 * The `nav-agent` COMPONENT + `nav-agent` SYSTEM (engine/src/systems/nav-agent.js)
 * and the legacy `nav-agent` SCRIPT shim (engine/src/scripts/nav-agent.js) both
 * drive agents through THIS module — the component is the recommended surface,
 * the script is compat; behavior can never diverge because there is only one
 * code path. Everything here moved verbatim from the script (P2-N2 → P2-N4a):
 *
 *   1. ONE MOVEMENT PRIMITIVE — never re-derives step math; COMPOSES
 *      `stepToward` from ../scripts/unit-move.js.
 *   2. DETERMINISTIC REPATH — `api.nav.findPath` is requested only when the
 *      path is exhausted (all waypoints consumed, not at the goal), the goal
 *      moved more than one nav cell since the last request, the nav version
 *      changed, or REPATH_INTERVAL_S of sim time has passed (a named constant,
 *      never wall-clock). A NULL findPath result (unreachable goal) is retried
 *      ONLY on the interval / goal-drift / version triggers — never per step.
 *      EXCEPTION — a declared off-mesh link hop is ATOMIC: while the agent is
 *      strictly between the hop's exact endpoints NO trigger fires (midLinkHop
 *      below). Mid-hop the agent stands in the BLOCKED cells the link jumps
 *      over, so findPath snaps `from` behind it and the follow would walk back
 *      to the link entrance in a limit cycle (the fence-side stall).
 *   3. ARRIVAL — waypoints within the arrive ring are dropped; the agent
 *      arrives and stops at the final waypoint (path cleared). With `follow`
 *      set, tracking continues on later steps.
 *   4. SEPARATION — `avoid` offsets the step away from other REGISTERED
 *      nav-agents within `separationRadius` (a gentle positional push, never a
 *      path re-plan). Registry mirrors the emitterState pattern: reset on scene
 *      load via `resetNavAgentState`, and per-entity via `navAgentDetach`.
 *   5. HANDLES — `api.nav` absent -> throttled warn (once per entity) + no-op.
 *
 * The agent's own transform is written directly (world space for root
 * entities — unit-move's contract); a `follow`/`target` entity's WORLD
 * position is resolved through its parent chain (the SHARED
 * nav/world-position.js resolver — extracted P2.5 W5).
 * Pure data + closure state; no DOM / no Three import — Node-vitestable.
 */
import { stepToward, isPoint } from '../scripts/unit-move.js'
import { worldPositionOf } from './world-position.js'
import { normalizeProfile } from './profile.js'
import { collectTerrainSurfaces, sampleSurfaces } from './terrain-query.js'
import { applyGravity } from '../physics/physics.js'
import { groundAnchorLocalY, placeY } from '../physics/placement.js'
import { params as NAV_AGENT_SCHEMA_PARAMS } from '../components/nav-agent.js'

/** Deterministic sim-time throttle between findPath requests (seconds). */
export const REPATH_INTERVAL_S = 0.25
/** Waypoint arrive ring (unit-move's default arriveDistance). */
const ARRIVE_DISTANCE = 0.15

/** Per-entity agent state: id -> { time, lastReq, reqGoal, path, warned }. */
const agentState = new Map()
/** Registry of active agent positions (separation): id -> { x, z }. */
const agentRegistry = new Map()

/**
 * Reset all nav-agent state (scene load so stale ids never leak) — mirrors
 * resetEmitterState in builtins.js. Separation would otherwise ghost-push
 * against agents from a previous scene.
 */
export function resetNavAgentState() {
  agentState.clear()
  agentRegistry.clear()
}

/** Per-entity attach: seed (or fetch) the agent's closure state. */
export function navAgentAttach(id) {
  return stateOf(id)
}

/** Per-entity detach: drop state + registry entry (the disposal hook). */
export function navAgentDetach(id) {
  agentState.delete(id)
  agentRegistry.delete(id)
}

function stateOf(id) {
  let st = agentState.get(id)
  if (!st) {
    st = { time: 0, lastReq: null, reqGoal: null, lastVersion: null, path: null, noPath: false, warned: false, warnedTarget: null, hop: null, settledGoal: null }
    agentState.set(id, st)
  }
  return st
}

/**
 * True while a declared off-mesh link hop is IN FLIGHT: `target` (the current
 * waypoint) is one exact endpoint of a declared link and `pos` lies STRICTLY
 * between that endpoint and the link's other endpoint (the agent already
 * entered the hop and has not reached the far end). Handles either traversal
 * direction; a nav handle without `links()` (test doubles) never suppresses.
 */
function midLinkHop(api, pos, target) {
  const links = api && api.nav && typeof api.nav.links === 'function' ? api.nav.links() : null
  if (!Array.isArray(links) || !isPoint(target)) return false
  for (const l of links) {
    if (!l || !isPoint(l.from) || !isPoint(l.to)) continue
    for (const [near, far] of [[l.from, l.to], [l.to, l.from]]) {
      // The current waypoint is this hop's far end (exact-endpoint waypoints).
      if (Math.hypot(target.x - far.x, target.z - far.z) > 1e-9) continue
      const ax = far.x - near.x, az = far.z - near.z
      const len2 = ax * ax + az * az
      if (!(len2 > 0)) continue
      const t = ((pos.x - near.x) * ax + (pos.z - near.z) * az) / len2
      if (t > 0 && t < 1) return true
    }
  }
  return false
}

/** True when `pos` rests ON (within 1e-6 of) a declared off-mesh link
 *  endpoint. Exact link endpoints are FIRST-CLASS walkable waypoints (the
 *  nav-agent-links waypoint semantics) — a seam recovery must never yank an
 *  agent off one, even though isNavigable can knife-reject an exact
 *  poly-edge endpoint. */
function onLinkEndpoint(api, pos) {
  const links = api && api.nav && typeof api.nav.links === 'function' ? api.nav.links() : null
  if (!Array.isArray(links)) return false
  for (const l of links) {
    if (!l || !isPoint(l.from) || !isPoint(l.to)) continue
    if (Math.hypot(pos.x - l.from.x, pos.z - l.from.z) <= 1e-6) return true
    if (Math.hypot(pos.x - l.to.x, pos.z - l.to.z) <= 1e-6) return true
  }
  return false
}

/* worldPositionOf is SHARED now (./world-position.js) — extracted P2.5 W5 so
   nav, physics and this core never carry private copies. */

/** One fixed step for one agent. `P` is the agent's param bag
 * ({ destination, target, speed, follow, avoid, separationRadius, separationWeight }
 * plus the declared capability profile — radius/height/maxSlope/stepHeight/
 * jumpHeight — which is ENFORCED (P2.5 W3): sent on EVERY findPath/isNavigable
 * call and used to gate link hops; missing ability fields take the schema
 * defaults (45° / 0.5 / 1), and the declared body dims radius/height ride
 * along (W6c-3 — they select the agent's CLEARANCE CLASS; absent dims land on
 * the DEFAULT class, so legacy agents route exactly as before). When the
 * agent's XZ is over the shared nav surface its transform.y GROUNDS the body
 * on that surface each step (T7a: y = surface - anchor — the body's
 * ground-contact point rests on the surface, never its center).
 */
export function navAgentUpdate(dt, api, id, p) {
  const P = p || {}
  // The capability profile this agent declares (schema defaults filled in —
  // the movement core always sends a COMPLETE profile; W6c-3: declared body
  // dims ride through with it).
  const profile = normalizeProfile({
    radius: P.radius, height: P.height,
    maxSlope: P.maxSlope, stepHeight: P.stepHeight, jumpHeight: P.jumpHeight,
  })
  const st = stateOf(id)
  if (!api || !api.nav) {
    if (!st.warned) {
      st.warned = true
      console.warn(`[nav-agent] no api.nav wired — no-op (entity "${id}")`)
    }
    return
  }
  const rec = typeof api.entity === 'function' ? api.entity(id) : null
  const tf = rec && rec.components && rec.components.transform
  if (!tf) return
  const pos = { x: Number.isFinite(tf.x) ? tf.x : 0, z: Number.isFinite(tf.z) ? tf.z : 0 }
  // T7a grounding anchor: every grounded Y write this tick is
  // surface - anchor (placeY semantics).
  const anchor = agentAnchorY(rec.components, P)

  // Goal precedence (P2.5 W5, D-7): `follow` (dynamic tracking) > `target`
  // (a MOVABLE world point — nav-point entity) > `destination` (literal {x,z},
  // the advanced fallback — kept, never silently dropped). `target` is resolved
  // EVERY update through its parent chain, so moving the point entity moves the
  // goal and the goalDrift trigger (> cell) re-routes the agent automatically.
  // A dangling target is a warn-throttled no-op that falls through.
  let goal = null
  const followId = typeof P.follow === 'string' ? P.follow.trim() : ''
  if (followId && typeof api.entity === 'function' && api.entity(followId)) {
    const g = worldPositionOf(api, followId)
    if (Number.isFinite(g.x) && Number.isFinite(g.z)) goal = { x: g.x, z: g.z }
  }
  if (!goal) {
    const targetId = typeof P.target === 'string' ? P.target.trim() : ''
    if (targetId && typeof api.entity === 'function') {
      if (api.entity(targetId)) {
        const g = worldPositionOf(api, targetId)
        if (Number.isFinite(g.x) && Number.isFinite(g.z)) goal = { x: g.x, z: g.z }
      } else if (st.warnedTarget !== targetId) {
        // House rule: warn-throttled no-op (once per agent per target id).
        st.warnedTarget = targetId
        console.warn(`[nav-agent] target "${targetId}" not found — falling back to destination (entity "${id}")`)
      }
    }
  }
  if (!goal && isPoint(P.destination)) goal = { x: P.destination.x, z: P.destination.z }
  if (!goal) {
    // P2-N4: a goal-less agent still reports its LIVE position to the
    // registry (a stale entry would ghost-push other agents); it never moves.
    agentRegistry.set(id, { x: pos.x, z: pos.z })
    if (!P.gravityY) drapeY(api, tf, pos.x, pos.z, anchor) // P2.5 W3 + T7a: sit ON the surface (never when gravity owns Y)
    return
  }

  const speed = Number.isFinite(Number(P.speed)) ? Number(P.speed) : 3
  st.time += Number.isFinite(dt) && dt > 0 ? dt : 0

  // --- Path maintenance (deterministic triggers) ---
  const cfg = typeof api.nav.config === 'function' ? api.nav.config() : null
  const cell = (cfg && Number.isFinite(cfg.cellSize) && cfg.cellSize > 0) ? cfg.cellSize : 1
  const due = st.lastReq == null || st.time - st.lastReq >= REPATH_INTERVAL_S
  const goalDrift = st.reqGoal != null && Math.hypot(goal.x - st.reqGoal.x, goal.z - st.reqGoal.z) > cell
  // P2-N4a: the path is INVALIDATED by a nav rebuild — re-path immediately
  // when api.nav.version() changed since the last request (in addition to
  // the existing triggers below).
  const curVersion = typeof api.nav.version === 'function' ? api.nav.version() : null
  const versionChanged = curVersion !== null && st.lastVersion !== null && curVersion !== st.lastVersion
  // Immediate re-path when the path is EXHAUSTED (all waypoints consumed,
  // not at the goal) while NOT at the goal. A NULL findPath result is NOT
  // re-requested per step — those retries wait for REPATH_INTERVAL_S, a
  // goal-drift, or a version change (the unreachable-goal thrash guard).
  // A goal the arrival cleanup already settled (last waypoint dropped in the
  // arrive ring) is AT GOAL even when the raw goal sits just outside the ring
  // (findPath snaps to cell centers) — without this latch `pathGone` re-fires
  // EVERY step at the goal (the per-step findPath storm pinned below).
  if (st.settledGoal && Math.hypot(goal.x - st.settledGoal.x, goal.z - st.settledGoal.z) > 1e-9) st.settledGoal = null
  // + cell/2 slack: findPath's final waypoint is the goal's CELL-SNAP, so an
  // arrived agent rests up to half a cell off the raw goal; without the slack
  // the boundary case (arrived at exactly ARRIVE_DISTANCE) never latches and
  // `pathGone` re-fires EVERY step at the goal (the per-step findPath storm
  // pinned in nav-ballistic.test.js). Repath GATE only — the stop distance is
  // unit-move's arrive ring, unchanged.
  const atGoal = st.settledGoal != null ||
    Math.hypot(goal.x - pos.x, goal.z - pos.z) <= ARRIVE_DISTANCE + cell / 2
  const pathGone = !atGoal && !st.noPath && (st.path == null || st.path.length === 0)
  // P2-N4a link traversal: a declared off-mesh hop is ATOMIC — while the
  // agent is strictly between the hop's exact endpoints NO trigger fires
  // (midLinkHop). The current path keeps walking to the far endpoint; the
  // suppressed triggers resume the moment the hop completes (st.lastReq is
  // untouched, so `due` fires right after). Deterministic — sim state only.
  const hopInFlight = st.hop != null || midLinkHop(api, pos, st.path && st.path.length ? st.path[0] : null)
  // W6a2 seam recovery (the api.nav snap seam — true inverse of isNavigable):
  // a REBUILD can strand the agent OFF the surface (standing where a new
  // obstacle's ERODED clearance hole just appeared). On the version-change
  // event, re-snap it onto the surface via nearestWalkable BEFORE anything
  // else — every returned point passes isNavigable (the inverse contract), so
  // the walk samples stay on walkable ground. Never mid-link-hop (an off-mesh
  // hop is atomic) and never ON a link endpoint (first-class waypoint).
  if (!hopInFlight && versionChanged && !onLinkEndpoint(api, pos) &&
    typeof api.nav.isNavigable === 'function' &&
    typeof api.nav.nearestWalkable === 'function' && !api.nav.isNavigable(pos.x, pos.z, profile)) {
    const snapped = api.nav.nearestWalkable(pos.x, pos.z, profile)
    if (snapped && api.nav.isNavigable(snapped.x, snapped.z, profile)) {
      pos.x = snapped.x
      pos.z = snapped.z
    }
  }
  if ((pathGone || goalDrift || versionChanged || due) && !hopInFlight) {
    st.lastReq = st.time
    st.reqGoal = { x: goal.x, z: goal.z }
    st.lastVersion = curVersion
    const raw = typeof api.nav.findPath === 'function' ? api.nav.findPath(pos, goal, profile) : null
    st.path = Array.isArray(raw) ? raw.filter(isPoint) : null
    // P2-N4: remember that the planner found NO path — those retries are
    // interval-gated below (never once per step).
    st.noPath = !st.path || st.path.length === 0
    // findPath snaps `from` to a cell center: when that first waypoint is
    // BEHIND the agent (dot product with the onward leg is negative) drop it,
    // so a mid-path re-plan never walks the agent backward. Forward waypoints
    // are always kept — the chain never corner-cuts a blocked cell.
    while (st.path && st.path.length > 1) {
      const v1x = st.path[0].x - pos.x, v1z = st.path[0].z - pos.z
      const v2x = st.path[1].x - st.path[0].x, v2z = st.path[1].z - st.path[0].z
      if (v1x * v2x + v1z * v2z >= 0) break
      if (Math.hypot(v1x, v1z) > cell) break
      st.path.shift()
    }
  }

  // --- Drop waypoints already inside the arrive ring; exhausted -> clear ---
  while (st.path && st.path.length && Math.hypot(st.path[0].x - pos.x, st.path[0].z - pos.z) <= ARRIVE_DISTANCE) {
    const wp = st.path[0]
    // Settle latch: the LAST waypoint, dropped in the arrive ring, within the
    // goal's cell-snap slack -> the agent has ARRIVED at this goal.
    if (st.path.length === 1 && Math.hypot(goal.x - wp.x, goal.z - wp.z) <= ARRIVE_DISTANCE + cell / 2) {
      st.settledGoal = { x: goal.x, z: goal.z }
    }
    st.path.shift()
  }
  if (st.path && st.path.length === 0) st.path = null // arrived: clear path

  // --- Ballistic launch at an off-mesh link entrance (gravityY agents) ---
  // A gravity-driven agent cannot WALK an off-mesh hop (there is no ground
  // under it — Y is physics-owned): the hop is a PROJECTILE. At the link's
  // near endpoint the core computes a launch velocity whose parabola lands on
  // the far endpoint (ballisticLaunchVelocity) and the hop flies under
  // gravity: XZ at constant horizontal velocity here, Y integrated by the
  // entity's dynamic-body from the handed-off `velocity.vy` (applyGravity +
  // position step — the physics fall/land/settle path, pill rests on its
  // radius). No dynamic-body -> the core integrates Y itself, same parabola.
  if (!st.hop && P.gravityY && st.path && st.path.length && isPoint(st.path[0])) {
    const entrance = linkEntranceFor(api, pos, st.path[0])
    if (entrance) {
      const far = entrance.far
      const dx = far.x - pos.x, dz = far.z - pos.z
      const dist = Math.hypot(dx, dz)
      const gRaw = api.physics && typeof api.physics.gravity === 'function' ? Number(api.physics.gravity()) : NaN
      const g = Number.isFinite(gRaw) && gRaw > 0 ? gRaw : 9.81
      const y0 = Number.isFinite(tf.y) ? tf.y : 0
      const yEnd = linkEndY(api, entrance.link, far)
      const y1 = yEnd === null ? y0 : yEnd
      const { vy, T } = ballisticLaunchVelocity(y0, y1, dist, speed, g)
      st.hop = {
        far: { x: far.x, z: far.z },
        vx: dist > 1e-6 ? dx / T : 0,
        vz: dist > 1e-6 ? dz / T : 0,
        t: 0, T, g, landY: y1,
        vy: null, // null = physics-owned Y (dynamic-body integrates velocity.vy)
      }
      // Hand the launch velocity to the physics integrator (down-positive).
      const scripts = (rec.components && rec.components.scripts) || []
      const hasDyn = Array.isArray(scripts) && scripts.some((s) => s && s.name === 'dynamic-body')
      let handed = false
      if (hasDyn && api.world && typeof api.world.setComponent === 'function') {
        const vel = rec.components.velocity || api.world.setComponent(id, 'velocity', { vy: 0 })
        if (vel) {
          vel.vy = -vy // down-positive convention (physics/system.js dynamic-body)
          handed = true
        }
      }
      if (!handed) st.hop.vy = -vy // core-integrated fallback (same parabola)
    }
  }

  // --- Movement: COMPOSES unit-move's stepToward (never reimplemented) ---
  let nx = pos.x
  let nz = pos.z
  if (st.hop) {
    // IN FLIGHT: projectile — XZ at constant horizontal velocity, Y under
    // gravity (physics-owned or core-integrated). Repath triggers are already
    // suppressed (hopInFlight), so the hop stays atomic.
    const sdt = Number.isFinite(dt) && dt > 0 ? dt : 0
    st.hop.t += sdt
    nx = pos.x + st.hop.vx * sdt
    nz = pos.z + st.hop.vz * sdt
    if (st.hop.vy !== null) {
      st.hop.vy = applyGravity(st.hop.vy, sdt, st.hop.g) // down-positive
      tf.y = (Number.isFinite(tf.y) ? tf.y : 0) - st.hop.vy * sdt
    }
    const landed = st.hop.t >= st.hop.T ||
      Math.hypot(st.hop.far.x - nx, st.hop.far.z - nz) <= ARRIVE_DISTANCE
    if (landed) {
      nx = st.hop.far.x
      nz = st.hop.far.z
      // T7a: landY is the SURFACE y at the link end — land anchor-aware
      // (y = surface - anchor), never the raw surface on the body center.
      if (st.hop.vy !== null) tf.y = anchor === null ? st.hop.landY : placeY({ anchor, surfaceTopY: st.hop.landY })
      st.hop = null
      if (st.path && st.path.length && Math.hypot(st.path[0].x - nx, st.path[0].z - nz) <= ARRIVE_DISTANCE) {
        st.path.shift()
        if (st.path.length === 0) st.path = null
      }
    }
  } else if (st.path && st.path.length) {
    const r = stepToward(pos, st.path[0], speed, dt, ARRIVE_DISTANCE)
    nx = r.x
    nz = r.z
    if (r.arrived) {
      st.path.shift()
      if (st.path.length === 0) st.path = null
    }
  }

  // --- avoid: gentle separation push from other REGISTERED agents ---
  // Applied to the step result (even at rest) so converging agents settle
  // apart instead of piling onto one point. Capped at 2x the step budget —
  // a nudge, never a teleport.
  if (P.avoid !== false && !st.hop) {
    const sep = Number.isFinite(Number(P.separationRadius)) ? Number(P.separationRadius) : 1
    // P2-N4a: separationWeight scales the push magnitude (0 = separation
    // off, default 1; negative clamps to 0).
    const wRaw = Number(P.separationWeight)
    const weight = Number.isFinite(wRaw) ? Math.max(0, wRaw) : 1
    const cap = Math.max(0, speed) * (Number.isFinite(dt) && dt > 0 ? dt : 0) * 2
    if (weight > 0 && sep > 0 && agentRegistry.size > 1) {
      let px = 0, pz = 0
      for (const [oid, o] of agentRegistry) {
        if (oid === id) continue
        const dx = nx - o.x, dz = nz - o.z
        const d = Math.hypot(dx, dz)
        if (d >= sep) continue
        const mag = Math.min((sep - d) * 0.5, cap) * weight
        if (d > 1e-6) { px += (dx / d) * mag; pz += (dz / d) * mag }
        else px += (id < oid ? -1 : 1) * mag // coincident: deterministic tie-break
      }
      // P2-N2 review fix: a push must never shove the agent through a wall.
      // Validate the pushed spot; when blocked, shrink the push toward zero
      // (deterministic halvings) and skip it entirely if even the smallest
      // shrink is still blocked.
      const bx = nx
      const bz = nz
      nx += px
      nz += pz
      const canStand = typeof api.nav.isNavigable === 'function'
        ? (x, z) => api.nav.isNavigable(x, z, profile)
        : null
      if (canStand && !canStand(nx, nz)) {
        let placed = false
        for (let s = 0.5; s >= 1 / 64; s *= 0.5) {
          if (canStand(bx + px * s, bz + pz * s)) {
            nx = bx + px * s
            nz = bz + pz * s
            placed = true
            break
          }
        }
        if (!placed) { nx = bx; nz = bz }
      }
    }
  }

  tf.x = nx
  tf.z = nz
  if (!P.gravityY) drapeY(api, tf, nx, nz, anchor) // P2.5 W3 + T7a: agent grounds on the surface (never when gravity owns Y)
  agentRegistry.set(id, { x: nx, z: nz })
}

/**
 * Ballistic launch solver (the jump arc). Given a hop's start/end CENTER
 * heights, the horizontal distance and the travel speed (the hop flies at
 * constant horizontal velocity = speed, so flight time T = dist / speed),
 * compute the projectile's initial vertical velocity whose exact parabola
 * lands on the far endpoint:
 *
 *   y(t) = fromY + vy*t - 0.5*g*t^2   (vy up-positive)
 *   y(T) = toY  =>  vy = ((toY - fromY) + 0.5*g*T^2) / T
 *
 * Returns { vy (UP-positive), T }. Pure — pinned in nav-ballistic.test.js.
 */
export function ballisticLaunchVelocity(fromY, toY, dist, speed, gravity = 9.81, flightTime = null) {
  const g = Number.isFinite(gravity) && gravity > 0 ? gravity : 9.81
  const d = Number.isFinite(dist) && dist > 0 ? dist : 0
  const s = Number.isFinite(speed) && speed > 0 ? speed : 0
  const T = Number.isFinite(flightTime) && flightTime > 0
    ? flightTime
    : (s > 0 && d > 0 ? d / s : 0.8)
  const dy = (Number.isFinite(toY) ? toY : 0) - (Number.isFinite(fromY) ? fromY : 0)
  return { vy: (dy + 0.5 * g * T * T) / T, T }
}

/**
 * When `pos` stands AT a declared link's near endpoint and `target` is that
 * link's exact far endpoint, return { link, near, far } — the hop entrance.
 * Handles either traversal direction; never matches mid-hop positions (the
 * caller launches only from the entrance ring).
 */
function linkEntranceFor(api, pos, target) {
  const links = api && api.nav && typeof api.nav.links === 'function' ? api.nav.links() : null
  if (!Array.isArray(links) || !isPoint(target)) return null
  for (const l of links) {
    if (!l || !isPoint(l.from) || !isPoint(l.to)) continue
    for (const [near, far] of [[l.from, l.to], [l.to, l.from]]) {
      if (Math.hypot(target.x - far.x, target.z - far.z) > 1e-9) continue
      // Standing at the entrance (the near endpoint's arrive ring, generous
      // enough for a dropped waypoint) and NOT already mid-hop.
      if (Math.hypot(pos.x - near.x, pos.z - near.z) > Math.max(1, ARRIVE_DISTANCE * 4)) continue
      if (Math.hypot(pos.x - far.x, pos.z - far.z) <= ARRIVE_DISTANCE) continue
      return { link: l, near, far }
    }
  }
  return null
}

/**
 * The far endpoint's Y for the ballistic solver: an AUTHORED link endpoint y
 * (normalizeNavLinks preserves it), else the draped baked endpoint (the
 * meshes() links seam), else null (caller falls back to a flat hop).
 */
function linkEndY(api, link, end) {
  if (link && isPoint(link.from) && Number.isFinite(link.from.y) &&
    Math.hypot(end.x - link.from.x, end.z - link.from.z) <= 1e-9) return link.from.y
  if (link && isPoint(link.to) && Number.isFinite(link.to.y) &&
    Math.hypot(end.x - link.to.x, end.z - link.to.z) <= 1e-9) return link.to.y
  try {
    const meshes = api && api.nav && typeof api.nav.meshes === 'function' ? api.nav.meshes() : null
    const list = meshes && meshes.links
    if (Array.isArray(list)) {
      for (const m of list) {
        for (const e of [m && m.from, m && m.to]) {
          if (e && Number.isFinite(e.y) && Math.hypot(end.x - e.x, end.z - e.z) <= 1e-6) return e.y
        }
      }
    }
  } catch { /* viz seam optional */ }
  return null
}

/**
 * T7a grounding anchor (placeY semantics): the local-Y offset of the agent's
 * ground-contact point from its transform origin (POSITIVE = above origin),
 * or null (legacy: the origin rests on the surface). Frozen order:
 *   1. declared `placement.groundY` (finite) — wins;
 *   2. else primitive-collider geometry (groundAnchorLocalY): an unrotated
 *      primitive derives its bottom directly (a pill: coreHalf + radius — the
 *      TOTAL height, clamped at the cap radius for degenerate pills); a
 *      ROTATED primitive derives through its rotated bounding mesh
 *      (bottom = -mesh.minY). A derivation THROW (unknown collider shape)
 *      falls THROUGH to the next tier — it never escapes a tick;
 *   3. else the nav-agent body height: agents are CENTER-ORIGIN capsules and
 *      `height` is the TOTAL height (component -> params -> schema default),
 *      so the contact point is -(height/2); height <= 0 -> null.
 */
function agentAnchorY(components, P) {
  let geom = null
  try { geom = groundAnchorLocalY(components || {}) } catch { geom = null } // unknown/broken collider -> next tier, never a per-tick throw
  if (geom !== null) return geom
  const comp = (components && components['nav-agent']) || {}
  let h = Number(comp.height)
  if (!Number.isFinite(h) && P) h = Number(P.height)
  if (!Number.isFinite(h)) h = Number(NAV_AGENT_SCHEMA_PARAMS.height.default) // schema-default body height
  return h > 0 ? -(h / 2) : null
}

/**
 * T7a shared grounding surface Y at world (x, z): the SHARED nav surface
 * (api.nav.surfaceY — the bake's source-faithful sampler: terrain GRID-NODE
 * triangles AND primitive face-plane tops, so box platforms ground agents)
 * when the seam exists, else the legacy terrain-only sample (stub apis).
 * `yHint` = the body's ground-contact Y estimate — stacked surfaces
 * (caves/overhangs) pick the layer the agent is ALREADY on; a roof above
 * never steals the layer. null = no surface under (x, z) -> y is NEVER
 * touched (legacy behavior).
 */
function groundSurfaceY(api, x, z, yHint) {
  if (api && api.nav && typeof api.nav.surfaceY === 'function') {
    const y = api.nav.surfaceY(x, z, yHint)
    return Number.isFinite(y) ? y : null
  }
  if (!api || typeof api.query !== 'function') return null
  const s = sampleSurfaces(collectTerrainSurfaces(api), x, z)
  return s.inside ? s.y : null
}

/**
 * T7a agent grounding (the P2.5 W3 drape, anchor-aware): set transform.y so
 * the body's ground-contact point rests ON the surface under (x, z) —
 * y = surfaceTopY - anchor (the placeY contract). anchor === null keeps the
 * legacy origin-on-surface write. No surface under the point -> y is NEVER
 * touched (legacy behavior).
 */
function drapeY(api, tf, x, z, anchor) {
  // The layer hint is the body's CURRENT ground-contact Y estimate:
  // tf.y + anchor (anchor is NEGATIVE, = the ground-contact offset from the
  // transform origin, so tf.y + anchor is the surface the body is already
  // standing on). anchor === null (legacy origin-on-surface) -> tf.y itself.
  // This picks the face the agent is ALREADY on — never jump layers because
  // a roof exists above (the cave-roof teleport).
  const yHint = anchor === null ? tf.y : tf.y + anchor
  const sY = groundSurfaceY(api, x, z, yHint)
  if (sY === null) return
  tf.y = anchor === null ? sY : placeY({ anchor, surfaceTopY: sY })
}
