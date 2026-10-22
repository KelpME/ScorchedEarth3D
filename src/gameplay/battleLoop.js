// INT — battleLoop.js PURE battle-loop state machine: blast -> damage -> death
// -> score -> scoreboard snapshot -> round rollover / match over. No DOM, no
// engine imports, no Math.random, no wall clock (deterministic; the live
// wiring in main.js/projectiles3d.js is the only impure side).
//
// Wraps an S3D battle (src/gameplay/turnState.js) + an S5 score state
// (src/gameplay/score.js). Damage math is S5 damage.js verbatim: blast radii
// are RECORD PIXELS (rPx), applied over a mirror of ALIVE battle players at
// live tank positions.
//
// Attacker seam contract (pinned, INT):
//   registerShot(shooterTankId)   — main.js calls this when the director
//     accepts a shot; the NEXT onBlast attributes to it (then clears).
//   onBlast({x,y,z,rPx,attackerTank}) — projectiles3d hands the firing tank
//     id straight on the blast (p.tank); attackerTank wins over registerShot.
//   With neither, damage still applies but scoring is SKIPPED with a loud
//   console.error naming the missing attacker (fail-noisy doctrine).
//
// Position seam (pinned, INT): setTankPositions([{id,x,y,z}]) — the loop only
// mirrors ALIVE players; applyBlast mutates the mirror, then hull is copied
// back onto battle.players (dead -> alive=false). Corpses are excluded from
// the mirror so damage.js's idempotent-dead path never double-counts.
//
// Turn order: onTurnAdvance() counts turns for diagnostics/state only —
// since the user-verified LAST-TANK-STANDING rule, the round NEVER ends on
// turns spent; it ends ONLY when at most one tank remains alive
// (isRoundOver(aliveCount) — no team concept exists yet). Mass Kill (nobody
// alive) is the <=1 edge: endRound passes massKill -> survival 0
// (manual:L1419-L1423). Scoring magnitudes: score.js RULES
// (manual:L1802-L1818); default STANDARD (manual:L1802-L1804 default, data/
// economy.json settings.scoringMode.default === 'STANDARD').

import { applyBlast } from './damage.js';
import { createScoreState } from './score.js';
import { aliveTeams, ALIVE_TEAMS_END } from './teams.js';
import econData from '../../data/economy.json' with { type: 'json' };
import ppData from '../../data/physics-presets.json' with { type: 'json' };

// Doctrine sweep (plan SE-COMPLETE-1012 §5, W1-B): the old JS literal default
// ('STANDARD' at the former :61) is gone — the default comes from the
// data/economy.json descriptor, validated fail-loud.
const SCORING_MODE_DEFAULT = (() => {
  const d = econData.options?.scoringMode?.default;
  if (!['BASIC', 'STANDARD', 'GREEDY'].includes(d)) {
    throw new TypeError(`[se/battleLoop] data/economy.json options.scoringMode.default invalid: ${JSON.stringify(d)} — fix the data file, no JS fallback exists`);
  }
  return d;
})();

// W5 purge (plan SE-COMPLETE-1012 §4): the old `MAX_HULL = 100` JS literal is
// GONE — the hull comes from the DATA (data/physics-presets.json
// .battle.maxHull). Malformed data fails LOUD naming the file.
const MAX_HULL_DATA = (() => {
  const v = ppData && ppData.battle ? ppData.battle.maxHull : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new TypeError(`[se/battleLoop] data/physics-presets.json .battle.maxHull missing/non-numeric: ${JSON.stringify(v)} — fix the data file, no JS fallback exists`);
  }
  return v;
})();

export const MAX_HULL = MAX_HULL_DATA // createBattle starts every player at the data hull

/**
 * USER-VERIFIED RULE (last-tank-standing): a round continues cycling turns
 * indefinitely and ends ONLY when at most ONE tank remains alive. There is no
 * team concept in the repo — do not invent one. Pure end-condition function
 * so the rule is unit-pinnable without a battle fixture.
 */
export function isRoundOver(aliveCount) {
  if (!Number.isInteger(aliveCount) || aliveCount < 0) {
    throw new TypeError(`[se/battleLoop] isRoundOver needs a non-negative integer alive count, got ${JSON.stringify(aliveCount)}`)
  }
  return aliveCount <= 1 // 1 = last tank standing; 0 = Mass Kill edge
}

/**
 * @param {object} p
 * @param {object} p.battle createBattle() result (mutated: hull, alive, round)
 * @param {'BASIC'|'STANDARD'|'GREEDY'} [p.scoringMode] default STANDARD (manual:L1802-L1804)
 * @param {number} [p.rounds] rounds in the match; default battle.round ?? 1
 */
export function createBattleLoop({ battle, scoringMode, rounds, teams } = {}) {
  if (!battle || !Array.isArray(battle.players) || battle.players.length === 0) {
    throw new TypeError('[se/battleLoop] createBattleLoop needs a battle with players')
  }
  // W4-A (plan SE-COMPLETE-1012) teams seam (manual:L1989-L1993, L2233-L2255):
  // teams = tankId->team map from src/gameplay/teams.js assignTeams (null =
  // no teams, legacy behavior). Friendly fire is OFF between teammates — the
  // blast mirror EXCLUDES teammates of the attacker (self-damage unaffected);
  // the round ends when the last TEAM stands (aliveTeams <= 1).
  const teamsMap = teams && typeof teams === 'object' ? teams : null
  const mode = scoringMode ?? SCORING_MODE_DEFAULT // descriptor default (data/economy.json, manual:L1802-L1804)
  const totalRounds = Number.isInteger(rounds) && rounds >= 1 ? rounds : (battle.round ?? 1)
  const scoreState = createScoreState({
    scoringMode: mode,
    players: battle.players.map((p) => ({ id: p.id, cash: p.inventory?.cash ?? 0 })),
  })

  let attacker = null // next-blast attacker (registerShot seam)
  let turnsThisRound = 0
  let positions = new Map() // tankId -> {x,y,z} (live transforms, per blast)
  let matchOver = null

  function alivePlayers() {
    return battle.players.filter((p) => p.alive).map((p) => p.id)
  }

  /** Live position feed from the engine (projectiles3d/main call per blast). */
  function setTankPositions(list) {
    if (!Array.isArray(list)) {
      console.error('[se/battleLoop] setTankPositions needs an array of {id,x,y,z}', list)
      throw new TypeError('[se/battleLoop] setTankPositions(list) required')
    }
    positions = new Map(list.map((t) => [t.id, t]))
  }

  function registerShot(shooterTankId) {
    if (shooterTankId != null && !battle.players.some((p) => p.id === shooterTankId)) {
      console.error(`[se/battleLoop] registerShot("${shooterTankId}") is not a battle player — attacker dropped, blast scoring will fail loud`)
      return
    }
    attacker = shooterTankId ?? null
  }

  /**
   * One blast, world position + RECORD-PIXEL radius. Mutates the alive mirror
   * via applyBlast, copies hull/death back onto battle players, scores.
   * W2-Cb: `hostile: true` (lightning etc.) applies damage through the SAME
   * applyBlast path but scores NOTHING — the sky is nobody's attacker (a null
   * attacker would trip the fail-noisy error for a legitimate case).
   * @returns {Array<{id,damage,killed}>} results, input (alive) order
   */
  function onBlast({ x, y, z, rPx, attackerTank, hostile } = {}) {
    const attId = attackerTank ?? attacker ?? null
    attacker = null // single-use either way — a stale attacker must never score
    // W9 friendly-fire consumer (SE-FIXUP-1012 C4): se.settings.friendlyFire
    // (data/play-options.json; applySettings stores a typed boolean) is read
    // LIVE at THE single damage-application site — NOT main.js. Off (default)
    // -> the attacker deals ZERO hull damage to itself AND its teammates
    // (direct + splash alike; zero damage -> zero score); on -> damage and
    // score flow as before (self-damage still scores nothing, manual:L1809-
    // L1810 foreman amend). Read per-blast so a settings change applies to
    // the very next blast. Missing/absent window (node tests, pre-boot) = off.
    const ff = typeof window !== 'undefined' && window.__se && window.__se.settings
      ? window.__se.settings.friendlyFire === true
      : false
    const attTeam = attId != null && teamsMap ? teamsMap[attId] : null
    // ff off: teammates of the attacker AND the attacker's own tank are
    // excluded from the blast mirror (W4-A pin extended to self by W9).
    // ff on / no teams map: everyone in range takes damage (legacy mirror).
    const friendly = (id) =>
      !ff && ((attId != null && id === attId) || (attTeam != null && teamsMap[id] === attTeam && id !== attId))
    const mirror = battle.players
      .filter((p) => p.alive && !friendly(p.id))
      .map((p) => {
        const pos = positions.get(p.id)
        if (!pos) {
          console.error(`[se/battleLoop] no live position for player ${p.id} — excluded from this blast (setTankPositions must run first)`)
          return null
        }
        return { id: p.id, x: pos.x, y: pos.y, z: pos.z, hull: p.hull, _p: p }
      })
      .filter(Boolean)
    if (mirror.length === 0) {
      console.error('[se/battleLoop] onBlast with no mappable alive tanks — no damage applied', { x, y, z, rPx })
      return []
    }
    // W4-A: excluded teammates still report a ZERO row so callers see one
    // result per alive tank, in input (alive) order.
    const friendlyRows = battle.players
      .filter((p) => p.alive && friendly(p.id))
      .map((p) => ({ id: p.id, damage: 0, killed: false }))
    const results = [...applyBlast({ tanks: mirror, blast: { x, y, z, rPx }, world: null }), ...friendlyRows]
    for (const r of results) {
      const m = mirror.find((mm) => mm.id === r.id)
      if (!m) continue // W4-A friendly zero-row: no mirror entry, nothing to copy back
      const p = m._p
      p.hull = m.hull
      if (r.killed) p.alive = false
    }
    if (attId == null && !hostile) {
      // Fail-noisy: the shot seam lost the attacker — damage landed, score did
      // not (silent zero-score would corrupt standings).
      console.error('[se/battleLoop] blast with NO attacker (registerShot/attackerTank missing) — damage applied, scoring skipped')
      return results
    }
    if (hostile) return results // W2-Cb: the sky is nobody's attacker — NO scoring path at all
    for (const r of results) {
      // Self-damage scores NOTHING: the manual awards damage points for
      // damaging "a tank or shield" (L1809-L1810) — your own blast hurting
      // YOU is not that. (Self-KILL penalty L1311 is score.js's, kept.)
      if (r.damage > 0 && r.id !== attId) scoreState.awardDamage({ attackerId: attId, victimId: r.id, damage: r.damage })
      if (r.killed) scoreState.awardKill({ attackerId: attId, victimId: r.id })
    }
    return results
  }

  /** The director/turn machinery feeds one turn consumption per call. */
  function onTurnAdvance() {
    turnsThisRound++
  }

  function roundOver() {
    // W4-A TEAMS: with a teams map the round ends when the LAST TEAM stands —
    // <= 1 distinct alive team (manual:L2238-L2239 "work together to eliminate
    // opposing teams"). Legacy no-teams rule (<=1 alive) is untouched.
    if (teamsMap) return aliveTeams(battle.players, teamsMap) <= ALIVE_TEAMS_END
    // USER-VERIFIED RULE (last-tank-standing): rounds end ONLY on <=1 alive.
    // The old fire-count condition (turnsThisRound >= players.length) is
    // REMOVED — the round cycles turns indefinitely while 2+ tanks stand.
    return isRoundOver(alivePlayers().length)
  }

  /** Snapshot for showScoreboard (src/ui/scoreboard.js shape). */
  function snapshot() {
    return {
      scoringMode: mode,
      players: battle.players.map((p) => ({
        id: p.id,
        name: p.name,
        hull: p.hull,
        maxHull: MAX_HULL,
        cash: p.inventory?.cash ?? 0,
        score: scoreState.scoreOf(p.id),
        team: teamsMap ? teamsMap[p.id] ?? null : null, // W4-A: scoreboard per team
      })),
    }
  }

  /** standings rows enriched with the fields showRoundEnd renders. */
  function rankedRows() {
    const byId = new Map(battle.players.map((p) => [p.id, p]))
    return scoreState.standings().map((s) => {
      const p = byId.get(s.id)
      return { ...s, name: p.name, hull: p.hull, maxHull: MAX_HULL }
    })
  }

  /** Reset for the next round: hull/alive refreshed, cash/score/ammo kept. */
  function nextRound() {
    battle.round = (battle.round ?? 1) + 1
    for (const p of battle.players) {
      p.hull = MAX_HULL
      p.alive = true
      delete p.dead // applyBlast-style corpse flag must not linger (loop owns alive)
    }
    turnsThisRound = 0
  }

  /**
   * Close the round: survival awards + standings; then roll over or end match.
   * @returns {{roundSnapshot, survivalAward, standings, next:'round'|'match', matchOver}}
   *   next==='round': roundSnapshot of the round that ENDED, then state rolled
   *   to round+1. next==='match': matchOver={winner, standings}.
   */
  function endRound() {
    const alive = alivePlayers()
    const massKill = alive.length === 0 // manual:L1419-L1423 Mass Kill
    const { survivalAward } = scoreState.roundEnd({ alive, massKill })
    const standings = rankedRows()
    const roundSnapshot = { round: battle.round ?? 1, standings }
    const current = battle.round ?? 1
    if (current < totalRounds) {
      nextRound()
      return { roundSnapshot, survivalAward, standings, next: 'round', matchOver: null }
    }
    matchOver = { winner: standings[0]?.id ?? null, standings }
    return { roundSnapshot, survivalAward, standings, next: 'match', matchOver }
  }

  return {
    scoreOf: (id) => scoreState.scoreOf(id),
    scoreState,
    registerShot,
    setTankPositions,
    onBlast,
    onTurnAdvance,
    alivePlayers,
    roundOver,
    endRound,
    nextRound,
    snapshot,
    state: () => ({ round: battle.round ?? 1, turnsThisRound, totalRounds, matchOver }),
  }
}
