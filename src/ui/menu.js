/**
 * T-UI-1 — Start-menu hub (src/ui/menu.js), WAVE-3 rework 2026-10-20.
 *
 * The menu VISUALS are the ui_menu archetype's canvas+widget tree, painted by
 * the ENGINE overlay (scripts/ui_menu_bind.js writes live values into the
 * widgets). The menu BUTTONS are the row widgets themselves now: each
 * menu_row_<action> panel child declares `interactive: true` (engine widget
 * interaction seam) and carries the ui_menu_row script (its action is the
 * declared param) — the engine dispatches the click to the script, visible in
 * the editor hierarchy + inspector. THIS module owns the remaining shell:
 * window.__menu {open,close,isOpen}, the Help/Controls overlay (a separate
 * screen — same class as the settings dialog, not part of the menu canvas),
 * and the document-level ESC handling (Help first, then the menu). The
 * TRANSPARENT #se-menu DOM hit layer is RETIRED — clicks land on the widget
 * entities; keyboard row navigation (arrows/Enter on focused hit buttons)
 * retired with it. Row HANDLERS are exposed via menuRowActions(menu) for
 * main.js to wire into window.__se.menuActions (what the ui_menu_row script
 * performs). Quit — OMITTED: main.js exposes no quit path; doctrine: never
 * invent one.
 *
 *   mountMenu({ onStart, version }) -> { open, close, isOpen }
 */

import { mountSettings } from './settings.js'
import { themeColor } from './theme.js'

let helpEl = null
let api = null
let settingsPromise = null
let explicitVersion = '' // mountMenu's version arg (main.js pkg version / specs)
let openState = false // the menu's open flag (the feed carries it to the bind script)
const cfg = { onStart: null } // behavior (not editable content)

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null) n.setAttribute(k, String(v))
  }
  for (const kid of kids) n.append(kid)
  return n
}

// LIVE store read (never cached): window.__se.config is written by main.js on
// START BATTLE; defaults mirror config.js's defaultsFromData until then.
const DEFAULT_PLAYERS = 2 // config.js defaultsFromData pin (manual L1613)
const DEFAULT_ROUNDS = 10 // config.js fallback (play-options mainMenuGameplay default)
function livePlayersRounds() {
  const c = window.__se?.config
  const players = Array.isArray(c?.players) && c.players.length ? c.players.length : DEFAULT_PLAYERS
  const rounds = Number.isInteger(c?.rounds) && c.rounds >= 1 ? c.rounds : DEFAULT_ROUNDS
  return { players, rounds }
}

/** The bind script's feed: open/players/rounds are written here (main.js seeds
 *  the object + version). Absent feed -> created on first write (fail-soft for
 *  the direct-mount specs; main.js boots first in the real game). */
function writeFeed(patch) {
  if (typeof window === 'undefined') return
  window.__se = window.__se || {}
  window.__se.menuFeed = { open: false, version: '', players: 0, rounds: 0, ...(window.__se.menuFeed || {}) }
  Object.assign(window.__se.menuFeed, patch)
}

function versionLine() { return explicitVersion }

const HELP_LINES = [
  ['Q / E', 'barrel angle down / up (default binding)'],
  ['\u2190 / \u2192 (or A / D)', 'bearing left / right'],
  ['\u2191 / \u2193 (or W / S)', 'drive forward / back (default binding)'],
  ['Space', 'hold to charge power meter, release to FIRE'],
  ['Mouse wheel', 'camera zoom (84..336 radius, default binding)'],
  [', / .', 'camera orbit azimuth left / right (default binding)'],
  ['Follow button', 'camera behind-tank follow toggle (default binding)'],
]

/** <style id="se-help-style"> — ONLY the help overlay mechanics (no menu
 *  CONTENT: colors/labels/layout live on the widget entities). */
function ensureMenuStyle(doc) {
  const old = doc.getElementById('se-help-style')
  if (old) old.remove()
  const s = doc.createElement('style')
  s.id = 'se-help-style'
  s.textContent = `
    #se-menu-help { position:fixed; inset:0; z-index:94; display:flex; align-items:center;
      justify-content:center; background:rgba(0,0,0,.7); font:13px/1.45 ui-monospace,monospace; color:${themeColor('text.body')}; }
    #se-menu-help .sheet { width:min(620px,96vw); max-height:88vh; overflow:auto; background:${themeColor('panels.sheetBg')};
      border:2px solid ${themeColor('panels.sheetBorder')}; box-shadow:0 0 0 2px #000, 6px 6px 0 #000; padding:16px 22px; }
    #se-menu-help h2 { margin:0 0 10px; font:700 16px ui-monospace,monospace; letter-spacing:2px; color:${themeColor('text.gold')}; }
    #se-menu-help dl { display:grid; grid-template-columns:auto 1fr; gap:6px 16px; margin:0; }
    #se-menu-help dt { color:${themeColor('text.green')}; white-space:nowrap; }
    #se-menu-help .note { margin-top:12px; color:${themeColor('text.dim')}; }
  `
  doc.head.appendChild(s)
}

function openHelp() {
  if (helpEl) return
  helpEl = el('div', { id: 'se-menu-help' })
  const sheet = el('div', { class: 'sheet' })
  sheet.append(el('h2', { text: 'HELP / CONTROLS' }))
  const dl = el('dl')
  for (const [k, v] of HELP_LINES) dl.append(el('dt', { text: k }), el('dd', { text: v }))
  sheet.append(dl)
  sheet.append(el('div', { class: 'note', text: 'Bindings as wired in src/main.js; "(default binding)" marks the current hardcoded map — rebinding arrives with the options UI (T-UI-2).' }))
  helpEl.append(sheet)
  document.body.append(helpEl)
}

function closeHelp() {
  if (helpEl) { helpEl.remove(); helpEl = null }
}

export function mountMenu({ onStart, version } = {}) {
  cfg.onStart = typeof onStart === 'function' ? onStart : null
  if (typeof version === 'string' && version) explicitVersion = version
  ensureMenuStyle(document)
  // Document-level ESC: Help closes first, then the menu (the DOM hit layer
  // that used to carry this keydown is retired with WAVE-3).
  if (!mountMenu._escBound) {
    mountMenu._escBound = true
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      if (helpEl) { e.preventDefault(); closeHelp(); return }
      if (openState) { e.preventDefault(); close() }
    })
  }
  writeFeed({ version: explicitVersion, open: false })

  function open() {
    const { players, rounds } = livePlayersRounds()
    writeFeed({ open: true, players, rounds }) // the bind script paints the live label
    openState = true
  }
  function close() {
    closeHelp()
    writeFeed({ open: false })
    openState = false
  }
  function isOpen() { return openState }

  api = { open, close, isOpen }
  return api
}

/** The row HANDLERS the ui_menu_row widget script performs (main.js wires them
 *  into window.__se.menuActions at boot — behavior wiring, not content).
 *  Unknown actions are the SCRIPT's fail-noisy job (it names them). */
export function menuRowActions(menu) {
  return {
    newbattle: () => {
      menu.close()
      cfg.onStart?.()
    },
    settings: () => {
      // mountSettings is async (loads data/*.json) — cache the promise so a
      // double-click can't double-mount; open() only after it resolves.
      if (!settingsPromise) settingsPromise = window.__settings ? Promise.resolve() : mountSettings(window)
      settingsPromise.then(() => window.__settings.open())
    },
    help: openHelp,
  }
}

/** Version line (spec seam parity — the bind script paints it from the feed). */
export function menuVersionLine() { return versionLine() }
