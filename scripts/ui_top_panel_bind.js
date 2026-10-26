/**
 * ui_top_panel_bind — LIVE BINDING script for the full-screen ui_top_panel
 * canvas (WEAPON-BAR-FOLD 2026-10-20). The archetype is a REAL canvas+widget
 * tree: the ROOT entity carries the screen-mode `canvas` component + this
 * script, and every HUD element AND the folded-in bottom weapon bar + FULL
 * ARMORY overlay are CHILD WIDGET ENTITIES (organized under the hud_group /
 * weapon_group / armory_group layout groups). This script does NOT draw —
 * the engine renderer (render/ui.js) paints the overlay. Its job is BINDING:
 * each sim step it reads the live state feed (systems/hud.js getTopPanelFeed —
 * main.js computes per frame; the weapon-bar part carries the paged owned
 * weapons / page state / overlay state, whose STATE lives in main.js's
 * window.__se.weaponBar controller) and writes the widget components' fields
 * (text.string, text.color, render.visible).
 *
 * HARD DOCTRINE (nothing hidden in code): labels/colors/layout live ONLY on
 * the widget components. NO hidden data carriers: the script's params
 * (accent/status/dim/noWindText/weaponPageSize/headWord/armedMark/pagePrefix/
 * armoryPrefix/store* /armory* /accessoryIds) are DATA shipped in the
 * archetype file, and the child lookup law is structural:
 *   hud_group / weapon_group / armory_group   layout groups (transparent
 *                                             panels; armory opens/closes by
 *                                             render.visible — a REAL panel)
 *   panel_label_/panel_value_/panel_status_*  the classic HUD rows (unchanged)
 *   panel_player / panel_weapon / panel_wind / panel_hint / panel_divider_*
 *   wp_*                                      weapon-bar widgets (slots,
 *                                             arrows, indicator, +N, store,
 *                                             status, backdrop, head)
 *   arm_*                                     full-armory overlay widgets
 *
 * KEYBOARD (1-9 / ',' / '.' / 'I' / overlay nav) is INPUT — it stays in
 * main.js (registered keydown handler); clicks on the bar's interactive
 * panels dispatch through the generic ui_weapon_action script.
 *
 * FAIL-NOISY: a missing/unknown widget child is a named console.error — never
 * a silent skip. A scene missing the feed renders the authored defaults.
 */

import { computeTopPanel, computeWeaponBar } from './ui_top_panel_view.js'

/** Known structural child-name patterns (anything else errors, named). */
const KNOWN = [
  /^panel_label_[a-z_]+$/,
  /^panel_value_[a-z_]+$/,
  /^panel_status_[a-z_]+$/,
  /^panel_divider_[a-z]+$/,
  /^panel_player$/,
  /^panel_weapon$/,
  /^panel_wind$/,
  /^panel_hint$/,
  /^hud_group$/,
  /^weapon_group$/,
  /^armory_group$/,
  /^wp_[a-z_0-9]+$/,
  /^arm_[a-z_0-9]+$/,
]

/** Fail-noisy widget resolver: returns the entity's `text` component or null
 * (named error) when the child is missing or carries no text widget. */
function textWidget(api, byName, name) {
  const id = byName.get(name)
  if (!id) {
    console.error(`[ui_top_panel_bind] required widget child "${name}" is missing from the ui_top_panel canvas — not bound`)
    return null
  }
  const rec = api.entity(id)
  const t = rec && rec.components && rec.components.text
  if (!t) {
    console.error(`[ui_top_panel_bind] child "${name}" (${id}) has no text widget component — not bound`)
    return null
  }
  return t
}

/** Write text content + optional color into a text widget (changed-only). */
function write(t, str, color) {
  if (!t) return
  if (str != null && t.string !== str) t.string = str
  if (color && t.color !== color) t.color = color
}

/** Show/hide a widget child by writing its render.visible flag (the same flag
 * the editor visibility toggle writes; the renderer skips hidden subtrees —
 * open/close on REAL panels, never hidden data carriers). Creates the render
 * component on first write (the archetype authors none — closed-by-default
 * subtrees are the bind script's job). */
function setVisible(api, byName, name, visible) {
  const id = byName.get(name)
  if (!id) {
    console.error(`[ui_top_panel_bind] required widget child "${name}" is missing from the ui_top_panel canvas — not bound`)
    return
  }
  const rec = api.entity(id)
  if (!rec || !rec.components) return
  const wr = rec.components.render || (rec.components.render = { visible: true })
  if (wr.visible !== visible) wr.visible = visible
}

export default {
  name: 'ui_top_panel_bind',
  label: 'UI top panel bind (live binding)',
  description: 'Binds the full-screen ui_top_panel canvas WIDGET TREE live (HUD rows + weapon bar + armory overlay): reads the state feed and writes the widget components (text content/color, group visibility) each step — the engine renderer paints them. No drawing, no content literals: labels/colors/layout live on the child entities.',
  params: {
    accent: { type: 'string', label: 'Accent color (labels/player default — value from the archetype file)' },
    status: { type: 'string', label: 'Status color (lit — value from the archetype file)' },
    dim: { type: 'string', label: 'Dim color — value from the archetype file' },
    noWindText: { type: 'string', default: 'No Wind', label: 'Wind: the no-wind text' },
    weaponPageSize: { type: 'number', default: 9, min: 1, label: 'Weapon bar page size (quick-pick slots + keyboard)' },
    headWord: { type: 'string', default: 'weapons', label: 'Weapon bar head word (composed after the player name)' },
    armedMark: { type: 'string', default: '\u2192', label: 'Armed-weapon marker prefixed to the selected slot/row' },
    pagePrefix: { type: 'string', default: 'p', label: 'Page indicator prefix' },
    armoryPrefix: { type: 'string', default: '+', label: 'Full-armory affordance prefix (composed with the owned count)' },
    storeColor: { type: 'string', label: '[STORE] text color (shop open) — value from the archetype file' },
    storeDimColor: { type: 'string', label: '[STORE] text color (shop locked) — value from the archetype file' },
    armoryRowColor: { type: 'string', label: 'Armory row text color — value from the archetype file' },
    armorySelColor: { type: 'string', label: 'Armory highlight (keyboard-selected row) color — value from the archetype file' },
    accessoryIds: { type: 'object', default: {}, label: 'Accessory catalog ids per status field (shield/guidance sum variants)' },
  },

  init() { return { panel: null, authored: {} } },

  /**
   * Derive the panel context from the CURRENT widget children (called from
   * init AND every update — a child's authored label edited in the inspector
   * lands live). Pure reading; writes happen in update(). Walks the FULL
   * descendant subtree (root -> group -> widget), keyed by structural name.
   */
  panelContext(api, entityId, p, state) {
    const params = p || {}
    const accessoryIds = (params.accessoryIds && typeof params.accessoryIds === 'object') ? params.accessoryIds : {}
    const byName = new Map()
    const labelOf = {}
    const statusFields = []
    // Structural child name: the record's name (hydration names it with the
    // FULL ancestor chain for nested widgets — '<rootId>_hud_group_…_x'), or
    // the id. Strip the root prefix, then any layout-GROUP prefixes, so the
    // structural law (panel_*/wp_*/arm_*) is depth-independent.
    const shortName = (rec) => {
      let s = String(rec.name || rec.id || '')
      if (s.startsWith(entityId + '_')) s = s.slice(entityId.length + 1)
      for (const g of ['hud_group', 'weapon_group', 'armory_group']) {
        if (s.startsWith(g + '_')) s = s.slice(g.length + 1)
      }
      return s
    }
    const visit = (parentId) => {
      for (const id of (api && api.query ? api.query({ parent: parentId }) : [])) {
        const rec = api.entity(id)
        if (!rec || !rec.components) continue
        const name = shortName(rec)
        if (!byName.has(name)) byName.set(name, id)
        const t = rec.components.text
        if (!t && !rec.components.panel) {
          console.error(`[ui_top_panel_bind] child "${name}" carries neither text nor panel widget — unknown widget child (name law: panel_* | hud_group | weapon_group | armory_group | wp_* | arm_*)`)
        }
        if (name.startsWith('panel_label_') && t) labelOf[name.replace('panel_label_', '')] = t.string
        if (name.startsWith('panel_status_') && t) {
          const id0 = name.replace('panel_status_', '')
          const cache = state && state.authored ? state.authored[id0] : null
          const label = cache ? (t.string === cache.last ? cache.label : t.string) : t.string
          statusFields.push({ id: id0, label, ids: [...(accessoryIds[id0] || [])] })
        }
        if (t && !KNOWN.some((re) => name.match(re))) {
          console.error(`[ui_top_panel_bind] child "${name}" does not match any known widget-name pattern — unknown widget child, not bound`)
        }
        visit(id)
      }
    }
    visit(entityId)
    // The wind prefix: the wind widget's authored string IS the prefix — but
    // the wind widget's string is also rewritten live; cache the authored
    // prefix the same way as the status labels (key '__wind').
    const windRec = byName.get('panel_wind') ? api.entity(byName.get('panel_wind')) : null
    const windRaw = windRec && windRec.components.text ? windRec.components.text.string : ''
    const wcache = state && state.authored ? state.authored['__wind'] : null
    const windPrefix = wcache ? (windRaw === wcache.last ? wcache.label : windRaw) : windRaw
    // The weapon selector prefix: panel_weapon's authored string.
    const wpRec = byName.get('panel_weapon') ? api.entity(byName.get('panel_weapon')) : null
    const weaponPrefix = wpRec && wpRec.components.text ? wpRec.components.text.string : ''
    return {
      byName,
      ctx: {
        labels: {
          power: labelOf.power ?? '',
          angle: labelOf.angle ?? '',
          bearing: labelOf.bearing ?? '',
          distLeft: labelOf.dist_left ?? '',
        },
        statusFields,
        windPrefix,
        noWindText: typeof params.noWindText === 'string' ? params.noWindText : 'No Wind',
        weaponPrefix,
      },
    }
  },

  /** Bind the folded-in weapon bar + armory overlay: the feed carries the
   * RAW controller state (main.js's weaponBar.view()); the PURE view model
   * (computeWeaponBar) composes the widget texts from it + the archetype
   * marker params. */
  bindWeaponBar(api, byName, params, rawBar) {
    const barCtx = {
      headWord: params.headWord,
      armedMark: params.armedMark,
      pagePrefix: params.pagePrefix,
      armoryPrefix: params.armoryPrefix,
    }
    const v = computeWeaponBar(rawBar || {}, barCtx)
    const vRaw = rawBar || {}
    // The whole bar: visible only while a battle is mounted (no bar under the
    // start menu — the retired DOM strip behaved the same way).
    setVisible(api, byName, 'weapon_group', v.mounted)
    write(textWidget(api, byName, 'wp_head'), v.headText)
    // Quick-pick slots: iterate the AUTHORED wp_slot_* children (the page
    // size is the number of slot panels the archetype ships — no count
    // literal; the keyboard/digit seam reads weaponPageSize separately).
    let slots = 0
    while (byName.has(`wp_slot_${slots + 1}`)) slots++
    for (let i = 1; i <= slots; i++) {
      const s = v.slots[i - 1] || null
      setVisible(api, byName, `wp_slot_${i}`, !!(s && s.visible))
      write(textWidget(api, byName, `wp_slot_${i}_text`), s ? s.text : '\u2014 \u00d70')
    }
    // Paged chrome: arrows / indicator / +N affordance only when paged.
    setVisible(api, byName, 'wp_page_prev', v.paged)
    setVisible(api, byName, 'wp_page_next', v.paged)
    setVisible(api, byName, 'wp_page_indicator', v.paged)
    setVisible(api, byName, 'wp_more', v.paged)
    write(textWidget(api, byName, 'wp_page_indicator'), v.pageIndicatorText)
    write(textWidget(api, byName, 'wp_more_text'), v.moreText)
    // Blocked-pick status (never silent).
    write(textWidget(api, byName, 'wp_status'), v.statusText)
    // [STORE]: dim while the shop gate locks buying (state from the feed).
    write(textWidget(api, byName, 'wp_store_text'), null, v.storeDim ? params.storeDimColor : params.storeColor)
    // FULL ARMORY overlay: open/close = render.visible on the REAL panel
    // subtree (title/close/rows ride their parent group).
    setVisible(api, byName, 'armory_group', v.armory.open)
    setVisible(api, byName, 'arm_title', v.armory.open)
    setVisible(api, byName, 'arm_close', v.armory.open)
    // Armory rows: iterate the AUTHORED arm_row_* children (no count literal).
    let rows = 0
    while (byName.has(`arm_row_${rows + 1}`)) rows++
    for (let i = 1; i <= rows; i++) {
      const r = v.armory.rows[i - 1] || null
      setVisible(api, byName, `arm_row_${i}`, !!(r && r.visible))
      const sel = v.armory.open && (i - 1) === vRaw.overlaySel
      write(textWidget(api, byName, `arm_row_${i}_text`), r ? r.text : '\u2014', sel ? params.armorySelColor : params.armoryRowColor)
    }
  },

  update(state, dt, api, entityId, p) {
    const params = p || {}
    const accent = params.accent || ''
    const statusColor = params.status || ''
    const dimColor = params.dim || ''
    // Re-derive from the live subtree (cheap: ~130 children, idempotent reads).
    const { byName, ctx } = this.panelContext(api, entityId, params, state)
    const feed = typeof window !== 'undefined' && window.__se && window.__se.topPanelFeed ? window.__se.topPanelFeed : {}
    const view = computeTopPanel(feed, ctx)
    // Row-1 LIVE values (labels are static widgets — never written).
    write(textWidget(api, byName, 'panel_value_power'), view.powerText)
    write(textWidget(api, byName, 'panel_value_angle'), view.angleText)
    write(textWidget(api, byName, 'panel_value_bearing'), view.bearingText)
    write(textWidget(api, byName, 'panel_value_dist'), view.distValueText)
    write(textWidget(api, byName, 'panel_value_weapon'), view.weaponValueText)
    // Active player: name in that tank's color (accent default).
    const player = textWidget(api, byName, 'panel_player')
    write(player, view.playerText, view.playerColor || accent)
    // Wind: prefix authored on the widget; the live text is the whole string.
    write(textWidget(api, byName, 'panel_wind'), view.windText)
    // Status fields: label (authored) + live count/state; dim = color (never
    // hidden); MAX never dims (the cap value IS the message).
    for (const f of view.status) {
      const t = textWidget(api, byName, `panel_status_${f.id}`)
      write(t, f.text, f.dim ? dimColor : statusColor)
      if (state.authored) state.authored[f.id] = { label: ctx.statusFields.find((x) => x.id === f.id)?.label ?? '', last: f.text }
    }
    if (state.authored) state.authored['__wind'] = { label: ctx.windPrefix, last: view.windText }
    // The folded-in weapon bar + full-armory overlay (pure view model).
    this.bindWeaponBar(api, byName, params, feed.weaponBar)
    state.panel = byName // handle for scrub-safe re-derivation (spec seam)
  },
}
