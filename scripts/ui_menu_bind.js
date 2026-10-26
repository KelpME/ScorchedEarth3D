/**
 * ui_menu_bind — LIVE BINDING script for the migrated ui_menu canvas
 * (CANVAS-MIGRATION 2026-10). The archetype is a REAL canvas+widget tree: the
 * ROOT entity carries the screen-mode `canvas` component + this script, and
 * every visual element is a CHILD WIDGET ENTITY (text / panel + rect). This
 * script does NOT draw anything — the engine renderer (render/ui.js) paints
 * the overlay. Its job is BINDING: each sim step it reads the live menu feed
 * (window.__se.menuFeed — created by main.js, open/players/rounds written by
 * src/ui/menu.js) and writes the widget components' fields (text.string,
 * render.visible). The renderer reconciles the overlay from the live
 * components, so a written field lands in the menu the same frame — and an
 * inspector edit lands live in the editor too.
 *
 * HARD DOCTRINE (nothing hidden in code): labels/colors/layout live ONLY on
 * the widget components. The script carries NO game-content literals — its
 * only param (liveLabelTemplate) is DATA shipped in the archetype file, and
 * the child lookup law is STRUCTURAL:
 *   menu_backdrop / menu_sheet   static panel chrome (never written)
 *   menu_title / menu_footer     static text (never written)
 *   menu_version                 LIVE version line (feed.version; authored
 *                                string is the fallback)
 *   menu_row_<action>            a row's BUTTON (panel): declares
 *                                `interactive: true` (engine WAVE-3 widget
 *                                interaction seam) and carries the GENERIC
 *                                ui_menu_row script (its `action` param is
 *                                the <action> name suffix: newbattle |
 *                                settings | help — name + script + param
 *                                all visible in the hierarchy/inspector).
 *   menu_row_<action>_label      the row's text; the NEWBATTLE label is
 *                                composed LIVE (store players/rounds) through
 *                                the liveLabelTemplate param; the authored
 *                                prefix is re-read when edited externally.
 *
 * INTERACTION MECHANISM (WAVE-3, 2026-10-20): the row panels are INTERACTIVE
 * widgets — the engine overlay opens pointer-events for exactly those nodes
 * and a click dispatches to the entity scripts' onPointerClick hook
 * (ui_menu_row). The TRANSPARENT #se-menu DOM hit layer is RETIRED: clicks
 * land on the widget entities, behavior lives on the visible scripts.
 *
 * FAIL-NOISY: a missing/malformed widget child is a named console.error —
 * never a silent skip. A scene missing the feed renders the authored
 * defaults (visible — the editor preview must show the menu).
 */

import { computeMenu } from './ui_menu_view.js'

/** Known structural child-name patterns (anything else errors, named). */
const KNOWN = [
  /^menu_row_[a-z]+$/,
  /^menu_row_[a-z]+_label$/,
  /^menu_backdrop$/,
  /^menu_sheet$/,
  /^menu_title$/,
  /^menu_version$/,
  /^menu_footer$/,
]

/** Fail-noisy text-widget resolver (named error, null when unusable). */
function textWidget(api, byName, name) {
  const id = byName.get(name)
  if (!id) {
    console.error(`[ui_menu_bind] required widget child "${name}" is missing from the ui_menu canvas — not bound`)
    return null
  }
  const rec = api.entity(id)
  const t = rec && rec.components && rec.components.text
  if (!t) {
    console.error(`[ui_menu_bind] child "${name}" (${id}) has no text widget component — not bound`)
    return null
  }
  return t
}

function write(t, str) {
  if (!t) return
  if (str != null && t.string !== str) t.string = str
}

/** PLAIN-FILE derivation RETIRED (WAVE-3, 2026-10-20): the menu rows are
 *  script-carrying interactive widget entities now — no transparent DOM hit
 *  layer, so there is nothing to derive rows for. */

export default {
  name: 'ui_menu_bind',
  label: 'UI menu bind (live binding)',
  description: 'Binds the ui_menu canvas WIDGET TREE live: reads the menu feed and writes the widget components (text content, open/closed visibility) each step — the engine renderer paints them. No drawing, no content literals: labels/colors/layout live on the child entities; row actions bind via the menu_row_<action> child names.',
  params: {
    liveLabelTemplate: { type: 'string', default: '{label} ({players} players, {rounds} rounds)', label: 'New Battle live-label template ({label}/{players}/{rounds})' },
  },

  init() { return { authored: {} } },

  /**
   * Derive the menu context from the CURRENT widget children (re-derived every
   * update — an inspector edit lands live). Pure reading; writes in update().
   */
  menuContext(api, entityId, p, state) {
    const params = p || {}
    const byName = new Map()
    const rowPrefixes = {}
    const shortName = (rec) => {
      const s = String(rec.name || rec.id || '')
      return s.startsWith(entityId + '_') ? s.slice(entityId.length + 1) : s
    }
    for (const id of (api && api.query ? api.query({ parent: entityId }) : [])) {
      const rec = api.entity(id)
      if (!rec || !rec.components) continue
      const name = shortName(rec)
      byName.set(name, id)
      const t = rec.components.text
      if (!t && !rec.components.panel) {
        console.error(`[ui_menu_bind] child "${name}" carries neither text nor panel widget — unknown widget child (name law: menu_row_<action> / menu_row_<action>_label / menu_title / menu_version / menu_footer / menu_sheet / menu_backdrop)`)
      }
      if (t && !KNOWN.some((re) => name.match(re))) {
        console.error(`[ui_menu_bind] child "${name}" does not match any known widget-name pattern — unknown widget child, not bound`)
      }
      const lm = name.match(/^menu_row_([a-z]+)_label$/)
      if (lm && t) {
        // The NEWBATTLE label string is COMPOSED (prefix + live store) and
        // rewritten every step — cache the authored prefix; re-read it only
        // when the widget string changed EXTERNALLY (an inspector edit).
        const action = lm[1]
        const cache = state && state.authored ? state.authored[action] : null
        rowPrefixes[action] = cache ? (t.string === cache.last ? cache.prefix : t.string) : t.string
      }
    }
    const versionRec = byName.get('menu_version') ? api.entity(byName.get('menu_version')) : null
    return {
      byName,
      ctx: {
        version: versionRec && versionRec.components.text ? versionRec.components.text.string : '',
        rowPrefixes,
        template: typeof params.liveLabelTemplate === 'string' && params.liveLabelTemplate ? params.liveLabelTemplate : '{label}',
      },
    }
  },

  update(state, dt, api, entityId, p) {
    const params = p || {}
    const { byName, ctx } = this.menuContext(api, entityId, params, state)
    const feed = (typeof window !== 'undefined' && window.__se && window.__se.menuFeed) ? window.__se.menuFeed : {}
    const view = computeMenu(feed, ctx)

    // LIVE values (static labels are never written).
    write(textWidget(api, byName, 'menu_version'), view.versionText)
    write(textWidget(api, byName, 'menu_row_newbattle_label'), view.newBattleText)
    // Authored-prefix cache (external-edit detection), same law as top-panel.
    if (state.authored) {
      state.authored.newbattle = { prefix: ctx.rowPrefixes.newbattle ?? '', last: view.newBattleText }
    }

    // Open/closed visibility: the feed's open flag drives every widget's
    // render.visible (the same flag the editor visibility toggle writes). No
    // feed (editor preview / pre-boot) -> visible.
    const open = feed.open !== false
    for (const [name, id] of byName) {
      const rec = api.entity(id)
      if (!rec || !rec.components) continue
      const wr = rec.components.render || (rec.components.render = { visible: true })
      if (wr.visible !== open) wr.visible = open
    }
    state.byName = byName // handle for scrub-safe re-derivation (spec seam)
  },
}
