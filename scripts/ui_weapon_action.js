/**
 * ui_weapon_action — the GENERIC weapon-bar BUTTON script (WAVE-3, 2026-10-20).
 *
 * A weapon-bar button is an INTERACTIVE PANEL widget child of the ui_top_panel
 * canvas that declares `interactive: true` (the engine WAVE-3 widget
 * interaction seam) and carries THIS script — visible in the editor hierarchy
 * + inspector like any script. ONE parametrized script covers all the bar's
 * buttons; the ACTION is the declared `action` param, per entity:
 *
 *   components.scripts = [{ name: 'ui_weapon_action', params: { action: 'page_next' } }]
 *   components.scripts = [{ name: 'ui_weapon_action', params: { action: 'quick_pick', slot: 3 } }]
 *   components.scripts = [{ name: 'ui_weapon_action', params: { action: 'armory_pick', row: 12 } }]
 *
 * Actions (dispatched through window.__se.weaponActions, which main.js wires
 * at boot — behavior wiring, not content; labels/layout live on the widgets):
 *   page_prev | page_next   flip the weapon-bar page (wrap-around)
 *   armory_open             open the FULL ARMORY overlay widget subtree
 *   armory_close            close the FULL ARMORY overlay
 *   store                   dispatch CustomEvent('se-open-store') (store gate
 *                           still applies — buying only between rounds)
 *   quick_pick              arm the weapon in bar SLOT <slot> (1..pageSize)
 *                           of the CURRENT page
 *   armory_pick             arm the weapon on overlay ROW <row> (1-based,
 *                           across the full owned list)
 *
 * The engine dispatches a click on the interactive panel to this script's
 * onPointerClick hook (engine/src/core/scripts.js pointerClickEntityScripts).
 *
 * FAIL-NOISY: an unknown action, or a known action with no wired handler,
 * errors loudly NAMING the action — never a silent dead button.
 */

export default {
  name: 'ui_weapon_action',
  label: 'UI weapon bar (button action)',
  description: 'Click behavior for a weapon-bar interactive panel widget: performs the declared action (page_prev | page_next | armory_open | armory_close | store | quick_pick | armory_pick) through the handlers main.js wires into window.__se.weaponActions.',
  params: {
    action: {
      type: 'string',
      required: true,
      description: 'The button\u2019s action: page_prev | page_next | armory_open | armory_close | store | quick_pick | armory_pick',
    },
    slot: { type: 'number', default: 0, min: 0, label: 'Bar slot index (quick_pick only, 1..pageSize)' },
    row: { type: 'number', default: 0, min: 0, label: 'Armory overlay row index (armory_pick only, 1-based)' },
  },

  init() { return {} },

  onPointerClick(state, api, entityId, params) {
    const action = params && params.action
    const actions = (typeof window !== 'undefined' && window.__se && window.__se.weaponActions) || null
    if (!action || typeof action !== 'string') {
      console.error(`[ui_weapon_action] entity "${entityId}": script carries no valid "action" param — the button cannot act`)
      return
    }
    if (!actions || typeof actions[action] !== 'function') {
      console.error(`[ui_weapon_action] entity "${entityId}": UNKNOWN or UNWIRED weapon action "${action}" (wired: ${actions ? Object.keys(actions).join('|') : 'NONE — window.__se.weaponActions is missing (main.js did not wire the weapon-bar handlers)'})`)
      return
    }
    actions[action]({
      slot: Number(params.slot) || 0,
      row: Number(params.row) || 0,
    })
  },
}
