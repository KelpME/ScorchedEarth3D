// S5 — scoreboard.js DOM overlay. NO engine deps (pure DOM + the passed
// snapshot). showScoreboard(snapshot) / showRoundEnd(roundSnapshot) append a
// retro panel to document.body (styling mirrors the S2 store panel: dark
// sheet, 2px green borders, hard drop shadow, ui-monospace) and return a
// controller { close() }.
//
// snapshot: { scoringMode, players: [{ id, name, hull, maxHull, cash, score }] }
// Rows are ranked client-side: score desc; hull desc; cash desc; id asc —
// deterministic (score.js standings() tie rule; manual gives none -> _placeholder).
// roundSnapshot: { round, standings: [{ rank, id, name, hull, maxHull, cash, score }] }
// — pre-ranked; rank 1 gets data-winner.
//
// Fail-noisy doctrine: a player row missing hull/maxHull/cash/score throws
// naming the field — never renders a silent zero.

import { themeColor } from './theme.js'

let panelEl = null

const fmt = (n) => (n < 0 ? '-$' + Math.abs(n).toLocaleString('en-US') : '$' + n.toLocaleString('en-US'))

function style() {
  if (document.getElementById('se-scoreboard-style')) return
  const s = document.createElement('style')
  s.id = 'se-scoreboard-style'
  // Retro palette matches the in-game HUD / store panel (store.js #se-store).
  s.textContent = `
    #se-scoreboard { position:fixed; inset:0; z-index:95; display:flex; align-items:center;
      justify-content:center; background:rgba(0,0,0,.65);
      font:13px/1.45 ui-monospace,monospace; color:${themeColor('text.body')}; }
    #se-scoreboard .sheet { width:min(560px,94vw); background:${themeColor('panels.sheetBg')};
      border:2px solid ${themeColor('panels.sheetBorder')}; box-shadow:0 0 0 2px #000, 6px 6px 0 #000; }
    #se-scoreboard header { display:flex; justify-content:space-between; padding:10px 14px;
      border-bottom:2px solid ${themeColor('panels.sheetBorder')}; background:${themeColor('panels.headerBg')}; letter-spacing:1px; }
    #se-scoreboard .mode { color:${themeColor('text.green')}; }
    #se-scoreboard .row { display:flex; align-items:center; gap:8px; padding:6px 14px;
      border-bottom:1px dotted ${themeColor('rows.dotted')}; }
    #se-scoreboard .row[data-dead="true"] { opacity:.45; }
    #se-scoreboard .row[data-winner="true"] { background:${themeColor('rows.activeBg')};
      box-shadow:inset 0 0 0 1px ${themeColor('states.activeLine')}; }
    #se-scoreboard .sb-rank { flex:0 0 22px; color:${themeColor('text.cash')}; font-weight:bold; }
    #se-scoreboard .sb-name { flex:1.2; min-width:0; overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap; }
    #se-scoreboard .sb-hull { flex:1.4; height:10px; background:${themeColor('panels.hullTrack')};
      border:1px solid ${themeColor('panels.sheetBorder')}; }
    #se-scoreboard .sb-hull-fill { height:100%; background:${themeColor('text.green')}; }
    #se-scoreboard .sb-cash { flex:0 0 84px; text-align:right; color:${themeColor('text.cash')}; }
    #se-scoreboard .sb-score { flex:0 0 56px; text-align:right; color:${themeColor('text.green')}; }
    #se-scoreboard footer { display:flex; justify-content:flex-end; padding:10px 14px;
      border-top:2px solid ${themeColor('panels.sheetBorder')}; background:${themeColor('panels.headerBg')}; }
    #se-scoreboard-close { font:inherit; background:${themeColor('buttons.doneBg')}; color:${themeColor('buttons.doneText')};
      border:2px solid ${themeColor('buttons.doneBorder')}; padding:4px 22px; cursor:pointer; letter-spacing:2px; }
  `
  document.head.appendChild(s)
}

function requireField(p, f) {
  if (typeof p[f] !== 'number' || !Number.isFinite(p[f])) {
    console.error(`[se/scoreboard] player ${JSON.stringify(p.id)} missing numeric "${f}" — refusing to render a silent zero`, p)
    throw new Error(`showScoreboard: player ${JSON.stringify(p.id)} missing numeric field "${f}"`)
  }
  return p[f]
}

function row(p, rank, winner) {
  const r = document.createElement('div')
  r.className = 'row'
  r.dataset.playerId = p.id
  const hull = requireField(p, 'hull')
  const maxHull = requireField(p, 'maxHull')
  requireField(p, 'cash')
  requireField(p, 'score')
  if (p.name == null) throw new Error(`showScoreboard: player ${JSON.stringify(p.id)} missing "name"`)
  if (maxHull <= 0) throw new Error(`showScoreboard: player ${JSON.stringify(p.id)} maxHull must be > 0, got ${maxHull}`)
  if (winner) r.dataset.winner = 'true'
  if (hull <= 0) r.dataset.dead = 'true'

  const rk = document.createElement('span'); rk.className = 'sb-rank'; rk.textContent = String(rank)
  const nm = document.createElement('span'); nm.className = 'sb-name'; nm.textContent = p.name
  const bar = document.createElement('div'); bar.className = 'sb-hull'
  const fill = document.createElement('div'); fill.className = 'sb-hull-fill'
  fill.style.width = (Math.max(0, Math.min(1, hull / maxHull)) * 100) + '%'
  bar.appendChild(fill)
  const cash = document.createElement('span'); cash.className = 'sb-cash'; cash.textContent = fmt(p.cash)
  const sc = document.createElement('span'); sc.className = 'sb-score'; sc.textContent = String(p.score)

  r.append(rk, nm, bar, cash, sc)
  return r
}

function panel(titleText, modeText, rows, onClose) {
  style()
  close()
  const root = document.createElement('div')
  root.id = 'se-scoreboard'
  const sheet = document.createElement('div')
  sheet.className = 'sheet'

  const header = document.createElement('header')
  const title = document.createElement('span'); title.textContent = titleText
  const mode = document.createElement('span'); mode.className = 'mode'; mode.textContent = modeText
  header.append(title, mode)

  const body = document.createElement('div')
  for (const r of rows) body.appendChild(r)

  const footer = document.createElement('footer')
  const done = document.createElement('button')
  done.id = 'se-scoreboard-close'
  done.textContent = 'DONE'
  // The standings overlay is the round-end dismissal gate: closing it (the
  // DONE button) fires the optional onClose hook — used to open the shop
  // AFTER the standings (round-end-before-shop ordering).
  done.addEventListener('click', () => { close(); if (onClose) onClose() })
  footer.appendChild(done)

  sheet.append(header, body, footer)
  root.appendChild(sheet)
  document.body.appendChild(root)
  panelEl = root
  return { close: () => close() }
}

function close() {
  if (panelEl) { panelEl.remove(); panelEl = null }
}

/**
 * In-round scoreboard. Rows ranked here: score desc, hull desc, cash desc,
 * id asc (deterministic; manual gives no tie rule -> _placeholder, mirrors
 * score.js standings()).
 */
export function showScoreboard(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.players) || snapshot.players.length === 0) {
    console.error('[se/scoreboard] snapshot.players missing/empty — refusing to render an empty scoreboard silently')
    throw new Error('showScoreboard: snapshot.players (non-empty array) required')
  }
  if (!snapshot.scoringMode) throw new Error('showScoreboard: snapshot.scoringMode required (BASIC|STANDARD|GREEDY, manual:L1802-L1804)')
  const ranked = [...snapshot.players].sort((a, b) =>
    (b.score ?? 0) - (a.score ?? 0) ||
    (b.hull ?? 0) - (a.hull ?? 0) ||
    (b.cash ?? 0) - (a.cash ?? 0) ||
    String(a.id).localeCompare(String(b.id)))
  return panel('SCOREBOARD', `SCORING: ${snapshot.scoringMode}`,
    ranked.map((p, i) => row(p, i + 1, false)))
}

/**
 * End-of-round standings (pre-ranked by the integration leaf, e.g.
 * score.js roundEnd()/standings()). rank 1 is highlighted as winner.
 * GREEDY rankings come from Net Worth (manual:L1811-L1816) — the caller
 * ranks, this just renders the given order.
 *
 * onClose (optional): fired when the user dismisses the standings (DONE).
 * Used to open the shop AFTER the standings — the round-end-before-shop
 * ordering (the standings overlay is the dismissal gate; the shop opens
 * behind it only once the user has read/dismissed the standings).
 */
export function showRoundEnd(roundSnapshot, onClose) {
  if (!roundSnapshot || !Array.isArray(roundSnapshot.standings) || roundSnapshot.standings.length === 0) {
    console.error('[se/scoreboard] roundSnapshot.standings missing/empty — refusing to render an empty standings panel silently')
    throw new Error('showRoundEnd: roundSnapshot.standings (non-empty array) required')
  }
  const rows = roundSnapshot.standings.map((s) => row(s, s.rank, s.rank === 1))
  return panel(`ROUND ${roundSnapshot.round ?? '?'} — FINAL STANDINGS`, 'RANKINGS', rows, onClose)
}
