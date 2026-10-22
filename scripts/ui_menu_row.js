/**
 * ui_menu_row — the GENERIC menu-row BUTTON script (WAVE-3, 2026-10-20).
 *
 * A menu row is a menu_row_<action> PANEL widget child of the ui_menu canvas
 * that declares `interactive: true` (the engine widget interaction seam) and
 * carries THIS script — visible in the editor hierarchy + inspector like any
 * script. ONE parametrized script covers all rows (the actions share shape);
 * the ACTION is the declared `action` param, per entity:
 *
 *   components.scripts = [{ name: 'ui_menu_row', params: { action: 'newbattle' } }]
 *
 * The engine dispatches a click on the interactive panel to this script's
 * onPointerClick hook (engine/src/core/scripts.js pointerClickEntityScripts).
 * The script performs the action through window.__se.menuActions — the
 * HANDLERS are wired by main.js at boot (behavior wiring, not content: labels/
 * layout stay on the widget entities per hard doctrine).
 *
 * FAIL-NOISY: an unknown action, or a known action with no wired handler,
 * errors loudly NAMING the action — never a silent dead button.
 */

export default {
  name: 'ui_menu_row',
  label: 'UI menu row (button action)',
  description: 'Click behavior for a menu_row_<action> interactive panel widget: performs the declared action (newbattle | settings | help) through the handlers main.js wires into window.__se.menuActions.',
  params: {
    action: { type: 'string', required: true, description: "The row's action: newbattle | settings | help" },
  },

  init() { return {} },

  onPointerClick(state, api, entityId, params) {
    const action = params && params.action
    const actions = (typeof window !== 'undefined' && window.__se && window.__se.menuActions) || null
    if (!action || typeof action !== 'string') {
      console.error(`[ui_menu_row] entity "${entityId}": script carries no valid "action" param — the row cannot act`)
      return
    }
    if (!actions || typeof actions[action] !== 'function') {
      console.error(`[ui_menu_row] entity "${entityId}": UNKNOWN or UNWIRED menu action "${action}" (wired: ${actions ? Object.keys(actions).join('|') : 'NONE — window.__se.menuActions is missing (main.js did not wire the row handlers)'})`)
      return
    }
    actions[action]()
  },
}
