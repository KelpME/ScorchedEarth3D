// W4-A (plan SE-COMPLETE-1012) — TEAMS pure data. Assignment + lookups.
// Manual anchors: Teams option manual:L1989-L1993 (NONE/STANDARD/...), Being a
// Team Player manual:L2233-L2255 (Standard/Corporate/Vicious). This build
// ships the two concrete layouts the brief pins: 2V2 and 1V2V1 (both 4
// players); friendly fire is OFF between teammates (damage path filters —
// battleLoop.js), and a round ends when the last TEAM stands.
// Pure: no DOM, no Math.random, no clock.

export const TEAM_LAYOUTS = {
  // 4 players, two pairs.
  '2V2': ['TEAM A', 'TEAM A', 'TEAM B', 'TEAM B'],
  // 4 players: solo, pair, solo.
  '1V2V1': ['TEAM A', 'TEAM B', 'TEAM B', 'TEAM C'],
}

/**
 * Assign teams for a battle roster.
 * @param {Array<{id:string}>} players battle players, index order = tankN
 * @param {string} teamsMode 'NONE' | '2V2' | '1V2V1' (data/play-options.json teams enum)
 * @returns {Object<string,string>|null} tankId -> team label; null = no teams
 */
export function assignTeams(players, teamsMode) {
  if (teamsMode === 'NONE' || teamsMode === undefined || teamsMode === null) return null
  const layout = TEAM_LAYOUTS[teamsMode]
  if (!layout) throw new TypeError(`[se/teams] unknown teams mode ${JSON.stringify(teamsMode)} — fix the caller or data/play-options.json`)
  if (!Array.isArray(players) || players.length !== layout.length) {
    throw new TypeError(`[se/teams] teams mode ${teamsMode} needs exactly ${layout.length} players, got ${Array.isArray(players) ? players.length : JSON.stringify(players)}`)
  }
  const map = {}
  players.forEach((p, i) => { map[p.id] = layout[i] })
  return map
}

/** Team of a tank id under a map from assignTeams; no teams / unknown id -> null. */
export function teamOf(teamsMap, tankId) {
  return (teamsMap && teamsMap[tankId]) || null
}

/** Last-team-standing end rule: a round is over when <= this many DISTINCT alive teams remain. */
export const ALIVE_TEAMS_END = 1

/** Count distinct teams among the ALIVE players under a teams map (null map = no teams). */
export function aliveTeams(players, teamsMap) {
  if (!teamsMap) return null
  const teams = new Set()
  for (const p of players) if (p.alive) teams.add(teamsMap[p.id])
  return teams.size
}
