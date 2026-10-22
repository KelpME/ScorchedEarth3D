// INT — turn director. Turn cycle over an ORDER array (makeDirector({
// turnOrder: ['tank1','tank2',...]})); the default is exactly the historical
// hardcoded 2-player alternation. On settle end the turn advances to the next
// ALIVE entry (isAlive callback — dead players are skipped); the consumer
// (main.js) is notified via onTurnAdvance(turnId) BEFORE settling back to
// 'aim', and endRound(turnId) lets it veto into 'roundend'/'matchover'
// (director stops accepting shots there). With no callbacks wired the
// behavior is byte-for-byte the pre-INT director.
//
// W4-A (plan SE-COMPLETE-1012) — SIMULTANEOUS turn mode (manual:L2164-L2212):
// params.turnMode === 'simultaneous' swaps the state machine to a lockstep
// cycle: 'planning' collects ONE committed shot per ALIVE tank (turn budget =
// 1 commit each; the turn pointer walks the alive-uncommitted tanks, AI or
// human — the fire path is the commit, per the manual "fire" highlights the
// tank ready), then ALL committed shots resolve in ONE 'resolving' flight
// phase: nextResolveShot() pops shots[0..] into state.shot/'flight' (the
// existing projectiles3d seam spawns each unchanged), impact() returns to
// 'resolving' while the queue is non-empty, and draining it lands in
// 'settling' — settleTick then completes the cycle back to 'planning' with
// the endRound veto honored exactly like synchronous. Default (turnMode
// unset/'synchronous') = the pre-W4A alternation, byte-identical.
export function makeDirector(params = {}) {
  const settleTimeout = params.settleTimeout ?? 600
  // W3-A (plan SE-COMPLETE-1012) hardware pacing, manual:L1739-L1748 —
  // frame-count delays: firingDelay holds the shot between requestFire and
  // flight entry (a new 'firing' phase, so projectiles3d's flight+shot spawn
  // check and battle-loop's aim-idle check both simply wait); fallingDelay
  // holds the settle START (settle clock frozen — settleSteps stays 0, so the
  // settleTimeout cannot fire mid-hold). Values are sim STEPS, never ms.
  // 0/undefined (the boot state: nothing pre-applies JSON defaults) = the
  // pre-W3A behavior, byte-identical.
  let pacing = sanitizePacing(params)
  function sanitizePacing(p = {}) {
    const frame = (v) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    }
    // W1 (plan SETTLE-SEQUENCE-1014): holdSteps = the settle-stage machine's
    // cartoon hold BEFORE dirt physics start (data/physics-presets.json
    // settleSequence.holdSteps, supplied by systems/turn_director). 0 is a
    // VALID value (no hold) — sanitize only rejects junk/non-finite/negative.
    const hold = (v) => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
    }
    // P1 (plan SETTLE-PACE-1015): stageMinSteps — a per-stage MINIMUM number
    // of sim steps before the machine advances out of it, applied AFTER the
    // existing done-gates (settled flag / caller stageDone). Data
    // (settleSequence.stageMinSteps, supplied by systems/turn_director).
    // Undefined / missing key => 0 => the pre-P1 passthrough (legacy tests).
    const mins = p.stageMinSteps && typeof p.stageMinSteps === 'object' ? p.stageMinSteps : {}
    const stageMinSteps = {}
    for (const k of ['hold', 'dirt', 'tanks', 'fallDamage', 'deaths']) stageMinSteps[k] = hold(mins[k])
    return {
      firingDelay: frame(p.firingDelay),
      fallingDelay: frame(p.fallingDelay),
      holdSteps: hold(p.holdSteps ?? p.settleHoldSteps),
      stageMinSteps,
    }
  }
  const order = Array.isArray(params.turnOrder) && params.turnOrder.length > 0
    ? [...params.turnOrder]
    : ['tank1', 'tank2'] // default = exactly today's behavior (INT)
  if (order.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new TypeError(`[se/director] turnOrder must be non-empty strings, got ${JSON.stringify(order)}`)
  }
  const isAlive = params.isAlive ?? (() => true)
  const onTurnAdvance = params.onTurnAdvance ?? null
  const endRound = params.endRound ?? null
  // W4-A simultaneous lockstep mode (see header). Anything but the exact
  // string 'simultaneous' = the historical synchronous alternation.
  const simultaneous = params.turnMode === 'simultaneous'
  const planningTurn = () => order.find((id) => isAlive(id)) ?? null
  let state = simultaneous
    ? { turn: planningTurn(), phase: 'planning', settleSteps: 0, shot: null, shots: [] }
    : { turn: order[0], phase: 'aim', settleSteps: 0, shot: null }

  // Next entry in order after `from`; skip !isAlive; wrap. If NOBODY is
  // alive (Mass Kill) return null — the consumer decides the round end.
  function nextAlive(from) {
    const start = order.indexOf(from)
    for (let k = 1; k <= order.length; k++) {
      const cand = order[(start + k) % order.length]
      if (isAlive(cand)) return cand
    }
    return null
  }

  return {
    state: () => state,
    set(s) { state = { ...state, ...s } },
    // W3-A: live-apply seam — systems/turn_director pushes the resolved
    // hardware pacing each frame; a mid-battle APPLY takes effect on the
    // next requestFire / impact without rebuilding the director.
    setPacing(p) { if (p && typeof p === 'object') pacing = sanitizePacing(p) },
    order: () => [...order],
    requestFire(tankId, shot) {
      if (simultaneous) {
        // W4-A lockstep commit: phase 'planning', pointer tank, alive, and the
        // turn budget (ONE commit per tank per cycle — committed ids are the
        // budget ledger; the pointer already skips them).
        if (state.phase !== 'planning' || tankId !== state.turn || !isAlive(tankId)) return false
        state.shots.push({ ...shot, tank: tankId })
        const committed = new Set(state.shots.map((s) => s.tank))
        const nxt = order.find((id) => isAlive(id) && !committed.has(id)) ?? null
        if (nxt) { state.turn = nxt; return true }
        // every alive tank committed -> ONE resolving phase for the whole volley
        state.turn = null
        state.phase = 'resolving'
        return true
      }
      // A dead tank does not shoot (turn skips cover it; this guards the
      // Mass-Kill edge where turn parks on a corpse — _placeholder, the
      // manual pins no line for firing while destroyed).
      if (state.phase === 'aim' && tankId === state.turn && isAlive(tankId)) {
        state.shot = shot
        if (pacing.firingDelay > 0) {
          state.phase = 'firing'; state.firingSteps = 0 // manual:L1739-L1744 hold
        } else {
          state.phase = 'flight'
        }
        return true
      }
      return false
    },
    // W4-A simultaneous: pop the next volley shot into 'flight' (the existing
    // projectiles3d seam spawns st.shot unchanged). False = queue drained —
    // the settling hold begins; idempotent (double-drain is a no-op).
    nextResolveShot() {
      if (!simultaneous || state.phase !== 'resolving' || state.shots.length === 0) {
        if (simultaneous && state.phase === 'resolving') {
          state.phase = 'settling'; state.settleSteps = 0
          state.settleStage = 'hold'; state.stageSteps = 0
        }
        return false
      }
      state.shot = state.shots[0]
      state.shots = state.shots.slice(1)
      state.phase = 'flight'
      return true
    },
    impact() {
      // W4-A: a resolved volley shot goes back to 'resolving' for the next
      // pop (nextResolveShot drains -> 'settling'); synchronous unchanged.
      if (simultaneous && state.phase === 'flight') { state.phase = 'resolving'; return }
      // W1: every settling entry starts the stage machine fresh at 'hold'.
      state.phase = 'settling'; state.settleSteps = 0; state.firingSteps = 0
      state.settleStage = 'hold'; state.stageSteps = 0
    },
    // W1 (plan SETTLE-SEQUENCE-1014) — settle STAGE machine, whole thing
    // still externally phase 'settling'. Order: hold (cartoon beat, data
    // holdSteps) -> dirt (the EXISTING settling body verbatim) -> tanks ->
    // fallDamage -> deaths -> the existing turn advance. tanks/fallDamage/
    // deaths are caller-gated via the new 2nd arg `stageDone` (main.js sets
    // se.settleStageDone each frame, W2): truthy on the current stage
    // advances it; undefined (legacy callers/tests) = 1-tick passthrough +
    // deaths done immediately, so the net old behavior is preserved except
    // the new data-driven hold. Exposed via st.settleStage / st.stageSteps.
    settleTick(settled, stageDone) {
      if (state.phase === 'firing') {
        // firingDelay countdown (manual:L1739-L1744): the shot exists but the
        // phase is not 'flight' yet, so projectiles3d holds the spawn and
        // battle-loop holds round-end checks. Flight entry lands EXACTLY on
        // the firingDelay-th step.
        state.firingSteps++
        if (state.firingSteps >= pacing.firingDelay) state.phase = 'flight'
        return
      }
      if (state.phase !== 'settling') return
      if (!state.settleStage) { state.settleStage = 'hold'; state.stageSteps = 0 }
      for (;;) {
        if (state.settleStage === 'hold') {
          // data-driven cartoon hold: settleSteps frozen (settleTimeout cannot
          // fire mid-hold, same law as the fallingDelay hold below).
          state.stageSteps++
          if (state.stageSteps >= pacing.holdSteps) {
            state.settleStage = 'dirt'; state.stageSteps = 0
            continue
          }
          return
        }
        if (state.settleStage === 'dirt') {
          // the EXISTING settling body, verbatim (fallingDelay hold, 3-step
          // slump guard, settled gate / settleTimeout force).
          if (pacing.fallingDelay > 0) {
            state.fallingSteps = (state.fallingSteps ?? 0) + 1
            if (state.fallingSteps <= pacing.fallingDelay) return
          }
          state.settleSteps++
          state.stageSteps++ // P1: the dirt stage's own breathing clock
          if (state.settleSteps < 3) return       // let the slump START before honoring a stale settled flag
          if (settled || state.settleSteps > settleTimeout) {
            // P1 (plan SETTLE-PACE-1015): the stage does not END before its
            // data minimum (stageMinSteps.dirt) — the drain is budget-paced,
            // so this is what keeps the camera on the visible cascade.
            if (state.stageSteps < pacing.stageMinSteps.dirt) return
            state.settleStage = 'tanks'; state.stageSteps = 0
            continue
          }
          return
        }
        // tanks / fallDamage / deaths: caller-gated. A DEFINED stageDone
        // advances exactly ONE stage per tick (fallDamage -> deaths is 1 tick
        // minimum even when the caller says done immediately); undefined
        // (legacy callers) = full passthrough + deaths-done in this tick.
        // P1: each stage also holds for its data minimum (stageSteps ticks
        // every frame the stage is current); 0 = the pre-P1 behavior.
        state.stageSteps++
        if (state.stageSteps < pacing.stageMinSteps[state.settleStage]) return
        if (stageDone === false) return
        if (stageDone === undefined) {
          if (state.settleStage === 'tanks') { state.settleStage = 'fallDamage'; state.stageSteps = 0; continue }
          if (state.settleStage === 'fallDamage') { state.settleStage = 'deaths'; state.stageSteps = 0; continue }
        } else if (state.settleStage === 'tanks') { state.settleStage = 'fallDamage'; state.stageSteps = 0; return }
        else if (state.settleStage === 'fallDamage') { state.settleStage = 'deaths'; state.stageSteps = 0; return }
        // deaths done -> the existing turn-advance block, verbatim.
        const nxt = nextAlive(state.turn)
        if (onTurnAdvance) onTurnAdvance(nxt)
        // endRound veto: the loop says the round is over -> 'roundend'
        // (requestFire rejects: phase is no longer 'aim'); the final round
        // gets 'matchover'. Returning false/undefined keeps play going.
        if (endRound) {
          const veto = endRound(nxt)
          if (veto === 'match') { state.phase = 'matchover'; state.shot = null; return }
          if (veto === 'round' || veto === true) { state.phase = 'roundend'; state.shot = null; return }
        }
        state.turn = nxt ?? state.turn // Mass Kill: nowhere to go; roundend veto expected
        if (simultaneous) {
          // W4-A: the volley settled -> next lockstep planning cycle.
          state.shots = []; state.shot = null; state.turn = planningTurn()
          state.phase = 'planning'; state.settleSteps = 0
          return
        }
        state.phase = 'aim'; state.shot = null
        return
      }
    },
  }
}
