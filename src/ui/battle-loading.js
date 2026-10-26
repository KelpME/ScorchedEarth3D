/**
 * Battle-loading overlay — host-drawn boot/transition infrastructure.
 *
 * Product decision (setup.js precedent): the engine canvas-ui is display-only;
 * interactive/boot screens are GAME DOM, not engine surfaces. This is a
 * transient boot state, NOT an editor-visible archetype — it is drawn by the
 * host the instant the user clicks START BATTLE and torn down the moment the
 * landscape + tanks are mounted (main.js hides it via startBattle(...).finally).
 *
 * Idempotent pair: showBattleLoading() / hideBattleLoading(). Colors come from
 * data/ui-theme.json via themeColor (fail-loud; no hex literals). The pulsing
 * dots are pure CSS (@keyframes opacity) — no external assets, no npm deps.
 */
import { themeColor } from './theme.js'

const LABEL = 'GENERATING'
const STYLE_ID = 'se-battle-loading-style'
const OVERLAY_ID = 'se-battle-loading'

/** Inject the overlay's <style> once (idempotent) — keyframes + base box. */
function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return
  const s = doc.createElement('style')
  s.id = STYLE_ID
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed; inset: 0; z-index: 50;
      display: flex; align-items: center; justify-content: center;
      background: rgba(10, 14, 20, 0.92);
      font: 700 18px ui-monospace, monospace;
      color: ${themeColor('text.gold')};
      text-align: center;
      user-select: none;
      pointer-events: none;
      letter-spacing: 3px;
    }
    #${OVERLAY_ID} .dots { animation: se-loading-pulse 1s steps(1) infinite; }
    @keyframes se-loading-pulse {
      0%   { opacity: 1; }
      33%  { opacity: 1; }
      34%  { opacity: 0; }
      66%  { opacity: 0; }
      67%  { opacity: 1; }
      100% { opacity: 1; }
    }
  `
  doc.head.appendChild(s)
}

/**
 * Show the full-screen "GENERATING…" overlay. Idempotent: a second call while
 * it is already on screen is a no-op.
 */
export function showBattleLoading() {
  if (document.getElementById(OVERLAY_ID)) return
  ensureStyle(document)
  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  overlay.textContent = `${LABEL}<span class="dots">...</span>`
  document.body.appendChild(overlay)
  if (window.__se) window.__se.battleLoading = overlay
}

/**
 * Hide/remove the overlay (and its injected <style> if present). Idempotent:
 * a no-op when nothing is on screen.
 */
export function hideBattleLoading() {
  const overlay = document.getElementById(OVERLAY_ID)
  if (overlay) overlay.remove()
  const style = document.getElementById(STYLE_ID)
  if (style) style.remove()
  if (window.__se && window.__se.battleLoading) window.__se.battleLoading = null
}
