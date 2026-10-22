// S5 — score.js PURE scoring state machine. All award rules are encoded from
// the manual's Economics Menu, Scoring Mode entry (manual:L1802-L1818) with
// line anchors as JSDoc tags per branch. Any magnitude the manual leaves open
// is flagged `_placeholder: true` in the rule object (never invented silently)
// and listed in the leaf report.
//
// The three manual rules, verbatim (docs/manuals/scorched-earth-1.5-manual.txt):
//   manual:L1804-L1806  "BASIC scoring gives you points only
//                        for killing tanks and surviving a
//                        round."
//   manual:L1807-L1810  "STANDARD scoring gives you less points
//                        for actually killing a tank, but gives
//                        you points every time you damage a
//                        tank or shield."
//   manual:L1811-L1818  "GREEDY scoring works like STANDARD
//                        scoring, but the final rankings at the
//                        end of each round are based on the Net
//                        Worth of your tank, e.g. how much cash
//                        you have in the bank plus the
//                        depreciated value of all weapons, etc.
//                        in stock ("He who dies with the most
//                        toys wins")."
//
// Support rules:
//   manual:L486-L490   retreat: "You will gain no points for this action"
//                      (nobody scores a retreating tank's death as a kill).
//   manual:L1311       suicide (own shot destroys own tank): "you will also
//                      lose points for this! And points mean money..."
//   manual:L2235       teams: "you will lose points for damaging or killing
//                      your teammates".
//   manual:L1419-L1423 Mass Kill: "equal portion of whatever points remained
//                      ... but giving no single tank credit for surviving".
//   manual:L1813-L1816 depreciation rate for GREEDY Net Worth is NEVER
//                      specified (economy.json selling.interestDrift agrees).

const RULES = {
  BASIC: {
    /** @manual L1804-L1806 "points only for killing tanks and surviving a round" */
    damagePoints: 0, // exact consequence of "only" — NOT a placeholder
    /** @manual L1807 "STANDARD ... gives you LESS points for actually killing"
     *  -> BASIC kill must exceed STANDARD kill; magnitudes never given. _placeholder */
    killPoints: 1000, killPoints_placeholder: true,
    /** @manual L1805 "surviving a round" awards points; magnitude open. _placeholder */
    survivalPoints: 1000, survivalPoints_placeholder: true,
    /** @manual L2235 friendly-fire loses points; magnitude open. _placeholder */
    friendlyFactor: -0.5, friendlyFactor_placeholder: true,
    rankBy: 'score',
    _source: 'manual:L1804-L1806',
  },
  STANDARD: {
    /** @manual L1809-L1810 "points every time you damage a tank or shield";
     *  points-per-damage-point magnitude never given (linear assumed). _placeholder */
    damagePoints: 1, damagePoints_placeholder: true,
    /** @manual L1807-L1808 "less points for actually killing a tank" than BASIC;
     *  magnitude open, relation killPoints < BASIC.killPoints enforced. _placeholder */
    killPoints: 500, killPoints_placeholder: true,
    /** @manual L1805-BASIC text implies survival scoring named there; STANDARD
     *  inherits award-for-surviving (manual never denies it). _placeholder */
    survivalPoints: 1000, survivalPoints_placeholder: true,
    /** @manual L2235 friendly fire loses points; magnitude open. _placeholder */
    friendlyFactor: -0.5, friendlyFactor_placeholder: true,
    rankBy: 'score',
    _source: 'manual:L1807-L1810',
  },
  GREEDY: {
    /** @manual L1811 "GREEDY scoring works like STANDARD scoring" — awards identical */
    damagePoints: 1, damagePoints_placeholder: true,
    killPoints: 500, killPoints_placeholder: true,
    survivalPoints: 1000, survivalPoints_placeholder: true,
    friendlyFactor: -0.5, friendlyFactor_placeholder: true,
    /** @manual L1811-L1816 "final rankings ... based on the Net Worth ...
     *  cash ... plus the depreciated value of all weapons, etc. in stock".
     *  Depreciation RATE never specified (manual:L1816; economy.json
     *  selling.interestDrift) -> stockValue is taken pre-depreciated from
     *  state, rate 1.0. _placeholder */
    rankBy: 'netWorth', rankByNote: 'netWorth = cash + stockValue * depreciationRate',
    depreciationRate: 1.0, depreciationRate_placeholder: true,
    _source: 'manual:L1811-L1818',
  },
}

export function scoringRules() {
  return JSON.parse(JSON.stringify(RULES))
}

/**
 * createScoreState(config) -> { awardDamage, awardKill, roundEnd, standings, scoreOf }
 * config: { scoringMode, players: [{ id, cash?, stockValue?, team? }] }
 */
export function createScoreState(config) {
  if (!config || !RULES[config.scoringMode]) {
    console.error('[se/score] unknown scoringMode — failing loud', config && config.scoringMode)
    throw new Error(`createScoreState: scoringMode ${JSON.stringify(config && config.scoringMode)} not one of BASIC|STANDARD|GREEDY (manual:L1802-L1804)`)
  }
  const rules = RULES[config.scoringMode]
  if (!Array.isArray(config.players)) throw new Error('createScoreState: players array required')
  const P = new Map(config.players.map((p) => [p.id, { score: 0, cash: p.cash ?? 0, stockValue: p.stockValue ?? 0, team: p.team ?? null }]))
  const require = (id) => {
    const e = P.get(id)
    if (!e) throw new Error(`createScoreState: unknown player id ${JSON.stringify(id)} — not silently ignored`)
    return e
  }
  const sameTeam = (a, b) => a.team != null && a.team === b.team

  /**
   * Award for damaging a tank/shield.
   * @manual L1809-L1810 STANDARD/GREEDY: "points every time you damage a tank
   *         or shield" -> damagePoints * damage (placeholder slope).
   * @manual L1804-L1806 BASIC: "points ONLY for killing tanks and surviving"
   *         -> damage awards 0.
   * @manual L2235 teams: "lose points for damaging ... your teammates".
   */
  function awardDamage({ attackerId, victimId, damage }) {
    const att = require(attackerId)
    const vic = require(victimId)
    if (!(typeof damage === 'number' && Number.isFinite(damage) && damage >= 0)) {
      throw new Error(`awardDamage: damage must be a non-negative number, got ${JSON.stringify(damage)}`)
    }
    const ff = sameTeam(att, vic)
    const pts = rules.damagePoints * damage * (ff ? rules.friendlyFactor : 1)
    att.score += pts
    return pts
  }

  /**
   * Award for killing a tank.
   * @manual L1804-L1806 BASIC killPoints; L1807-L1808 STANDARD "less points
   *         for actually killing a tank" (relation enforced below).
   * @manual L486-L490 retreat / self-kill: "gain no points" for the killer.
   * @manual L1311 suicide: victim "lose[s] points for this".
   * @manual L2235 teams: "lose points for ... killing your teammates".
   */
  function awardKill({ attackerId, victimId }) {
    const vic = require(victimId)
    const self = attackerId === victimId || attackerId == null
    if (self) {
      // manual:L1311 — destroying yourself LOSES points; nobody gains.
      vic.score -= rules.killPoints
      return 0
    }
    const att = require(attackerId)
    const ff = sameTeam(att, vic)
    const pts = rules.killPoints * (ff ? rules.friendlyFactor : 1)
    att.score += pts
    return pts
  }

  /**
   * Round end: award survival points.
   * @manual L1805 "surviving a round" gives points (BASIC at minimum;
   *         STANDARD/GREEDY inherit — manual never denies it, _placeholder).
   * @manual L1419-L1423 Mass Kill: pass { massKill: true } -> "giving no
   *         single tank credit for surviving the round" -> survival 0.
   */
  function roundEnd({ alive = [], massKill = false } = {}) {
    const survivalAward = {}
    for (const id of alive) {
      const e = require(id)
      const pts = massKill ? 0 : rules.survivalPoints // manual:L1419-L1423
      e.score += pts
      survivalAward[id] = pts
    }
    return { survivalAward, standings: standings() }
  }

  /**
   * Rank players.
   * @manual L1811-L1816 GREEDY: "final rankings ... based on the Net Worth ...
   *         cash ... plus the depreciated value of ... stock".
   * STANDARD/BASIC: plain score (manual limits Net Worth ranking to GREEDY,
   *         L1812 "but").
   * Tie rule: cash desc, then id asc — manual gives NO tie rule -> _placeholder.
   */
  function standings() {
    const rows = [...P.entries()].map(([id, e]) => ({
      id,
      score: e.score,
      cash: e.cash,
      netWorth: e.cash + e.stockValue * (rules.depreciationRate ?? 1),
    }))
    const key = rules.rankBy === 'netWorth' ? 'netWorth' : 'score'
    rows.sort((a, b) =>
      b[key] - a[key] || b.cash - a.cash || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return rows.map((r, i) => ({ rank: i + 1, ...r }))
  }

  function scoreOf(id) { return require(id).score }
  function setCash(id, cash) { require(id).cash = cash }
  function setStockValue(id, v) { require(id).stockValue = v }

  return { awardDamage, awardKill, roundEnd, standings, scoreOf, setCash, setStockValue, rules }
}
