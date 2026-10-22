/**
 * ui_top_panel_view — PURE view model for the migrated ui_top_panel canvas
 * (CANVAS-MIGRATION 2026-10). No DOM, no param store: `computeTopPanel`
 * consumes the live state feed + the panel context derived from the widget
 * CHILDREN (labels ride the entities — see ui_top_panel_bind) and returns the
 * display texts the bind script writes into the text widgets each step.
 *
 * The display laws are unchanged from the retired ui_top_panel_render DOM
 * renderer (power ×1000 OG scale / maxPower cur-max / hull integer clamp /
 * dim-at-zero counts / wind arrows): test/unit/top-panel.test.js pins them
 * through systems/hud.js's re-export.
 */

const countText = (n) => (n === Infinity ? '\u221e' : String(n))

/**
 * FALLBACK context (used only when a caller passes no panel context — e.g. the
 * unit pins calling computeTopPanel(inp) directly). Mirrors the SHIPPED
 * archetype context (assets/archetypes/ui_top_panel.json children + bind
 * params); a live bind always derives the ctx from the widget children.
 */
export const DEFAULT_CTX = {
  labels: { power: 'POWER', angle: 'ANGLE', bearing: 'BEARING', distLeft: 'DIST LEFT' },
  statusFields: [
    { id: 'max', label: 'MAX', ids: [] },
    { id: 'battery', label: 'BAT', ids: ['battery'] },
    { id: 'parachute', label: 'PARA', ids: ['parachute'] },
    { id: 'armor', label: 'ARM', ids: ['armor'] },
    { id: 'shield', label: 'SHLD', ids: ['shield', 'force_shield', 'heavy_shield', 'super_mag', 'mag_deflector'] },
    { id: 'guidance', label: 'GUID', ids: ['heat_guidance', 'ballistic_guidance', 'horz_guidance', 'vert_guidance', 'lazy_boy'] },
    { id: 'trigger', label: 'TRIG', ids: ['contact_trigger'] },
    { id: 'fuel', label: 'FUEL', ids: ['fuel_tank'] },
    { id: 'hull', label: 'HEALTH', ids: [] },
  ],
  windPrefix: 'WIND',
  noWindText: 'No Wind',
  weaponPrefix: '\u2192',
}

/**
 * PURE: weapon-bar feed -> view model (WEAPON-BAR-FOLD 2026-10-20). The
 * bottom weapon bar + FULL ARMORY overlay are REAL widget entities of the
 * ui_top_panel canvas; main.js owns the page/overlay STATE (per player) and
 * feeds the raw bar data; this pure model composes the widget texts the bind
 * script writes. No content literals: the armed marker, head word, page
 * prefix and armory prefix come from the ctx (the bind script's archetype
 * params). Never throws: a missing feed renders the closed/empty bar.
 * @param {object} bar  the live weapon-bar feed (mounted, playerName, page,
 *   pages, slots[{id,name,qty,selected,keyIndex}], ownedCount, paged,
 *   overlayOpen, overlayRows[{id,name,qty,selected}], lastChoose, shopLocked).
 * @param {object} ctx  composed-marker context: { headWord, armedMark,
 *   pagePrefix, armoryPrefix }.
 */
const qtyChar = (q) => (q === Infinity ? '\u221e' : String(q))

export function computeWeaponBar(bar = {}, ctx = {}) {
  const headWord = typeof ctx.headWord === 'string' ? ctx.headWord : 'weapons'
  const armedMark = typeof ctx.armedMark === 'string' ? ctx.armedMark : '\u2192'
  const pagePrefix = typeof ctx.pagePrefix === 'string' ? ctx.pagePrefix : 'p'
  const armoryPrefix = typeof ctx.armoryPrefix === 'string' ? ctx.armoryPrefix : '+'
  const mounted = bar.mounted === true
  const page = Number.isInteger(bar.page) ? bar.page : 0
  const pages = Math.max(1, Number.isInteger(bar.pages) ? bar.pages : 1)
  const slotText = (s) => (!s ? ''
    : `${s.selected ? armedMark + ' ' : ''}${s.keyIndex} ${s.name} \u00d7${qtyChar(s.qty)}`)
  const slots = (Array.isArray(bar.slots) ? bar.slots : []).map((s) => ({
    text: slotText(s),
    visible: mounted && !!s,
  }))
  const rowText = (r) => (!r ? ''
    : `${r.selected ? armedMark + ' ' : ''}${r.name} \u00d7${qtyChar(r.qty)}`)
  const overlayRows = (Array.isArray(bar.overlayRows) ? bar.overlayRows : []).map((r) => ({
    text: rowText(r),
    visible: mounted && bar.overlayOpen === true && !!r,
  }))
  const choose = bar.lastChoose && !bar.lastChoose.ok ? bar.lastChoose : null
  return {
    mounted,
    headText: mounted ? `${bar.playerName ?? ''} ${headWord}` : '',
    slots,
    paged: mounted && bar.paged === true,
    pageIndicatorText: `${pagePrefix}${Math.min(page + 1, pages)}/${pages}`,
    moreText: `${armoryPrefix}${Math.max(0, bar.ownedCount ?? 0)}`,
    statusText: choose ? `${choose.weaponId}: ${choose.reason}` : '',
    armory: { open: mounted && bar.overlayOpen === true, rows: overlayRows },
    storeDim: mounted && bar.shopLocked === true,
  }
}

/**
 * PURE: fed state + panel context -> view model. No DOM.
 * @param {object} inp  the live feed (power/angleDeg/bearingDeg/distLeft/
 *   playerName/playerColor/weaponName/weaponCount/accessories/hull/maxPower/
 *   armor/windX).
 * @param {object} ctx  panel context derived from the widget children:
 *   { labels:{power,angle,bearing,distLeft}, statusFields:[{id,label,ids}],
 *     windPrefix, noWindText, weaponPrefix }.
 */
export function computeTopPanel(inp = {}, ctx = DEFAULT_CTX) {
  // SE-EXPANSION-1012 A2: POWER displays as the 0-1000 INTEGER —
  // display = round(power*1000). The internal 0-1 law is unchanged.
  const power = typeof inp.power === 'number' ? inp.power : 0
  // W2-Cb damage->maxPower display law: when the active tank is DAMAGED
  // (maxPower < 1) the POWER value shows the cap — 'cur/max', both on the
  // same ×1000 integer display law. Undamaged tanks keep the classic integer.
  const maxPower = typeof inp.maxPower === 'number' && Number.isFinite(inp.maxPower) ? Math.min(1, Math.max(0, inp.maxPower)) : 1
  const shownPower = Math.min(power, maxPower)
  const powerNum = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000)
  const powerText = maxPower < 1 ? `${powerNum(shownPower)}/${powerNum(maxPower)}` : String(powerNum(power))
  const accessories = inp.accessories || {}
  const status = (ctx.statusFields || []).map((f) => {
    // hull: NOT an accessory count — the ACTIVE player's hull % (main feeds
    // it). Integer, rounded, clamped to 0-100; 0 dims (never hidden).
    if (f.id === 'max') {
      return { id: f.id, text: `${f.label} ${powerNum(maxPower)}`, dim: false }
    }
    if (f.id === 'hull') {
      const raw = inp.hull
      const h = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(Math.min(100, Math.max(0, raw))) : 0
      return { id: f.id, text: `${f.label} ${h}`, dim: !(h > 0) }
    }
    // armor: NOT a count — the toggle state. Unowned renders DIM 'ARM —';
    // owned renders bright 'ARM ON'/'ARM OFF' (never dim while owned).
    if (f.id === 'armor') {
      if (inp.armor === undefined || inp.armor === null) {
        return { id: f.id, text: `${f.label} \u2014`, dim: true }
      }
      return { id: f.id, text: `${f.label} ${inp.armor ? 'ON' : 'OFF'}`, dim: false }
    }
    const count = (f.ids || []).reduce((s, id) => s + (accessories[id] > 0 ? accessories[id] : 0), 0)
    return { id: f.id, text: `${f.label} ${countText(count)}`, dim: !(count > 0) }
  })
  const wx = typeof inp.windX === 'number' ? inp.windX : 0
  const labels = ctx.labels || {}
  const distLabel = typeof labels.distLeft === 'string' ? labels.distLeft : ''
  const windPrefix = typeof ctx.windPrefix === 'string' ? ctx.windPrefix : ''
  const noWindText = typeof ctx.noWindText === 'string' ? ctx.noWindText : ''
  const weaponPrefix = typeof ctx.weaponPrefix === 'string' ? ctx.weaponPrefix : ''
  const weaponName = inp.weaponName ?? '\u2014'
  const weaponCountText = `×${countText(typeof inp.weaponCount === 'number' ? inp.weaponCount : 0)}`
  return {
    labels,
    powerText,
    angleText: `${Math.round(inp.angleDeg ?? 45)}\u00b0`,
    bearingText: `${Math.round(inp.bearingDeg ?? 0)}\u00b0`,
    distText: `${distLabel} ${(typeof inp.distLeft === 'number' ? inp.distLeft : 0).toFixed(2)}`,
    distValueText: (typeof inp.distLeft === 'number' ? inp.distLeft : 0).toFixed(2),
    playerText: inp.playerName ?? 'PLAYER 1',
    playerColor: inp.playerColor ?? null,
    weaponText: `${weaponPrefix} ${weaponName} ${weaponCountText}`,
    weaponValueText: `${weaponName} ${weaponCountText}`,
    status,
    windText: wx === 0 ? (noWindText || 'No Wind') : `${windPrefix} ${wx < 0 ? '\u2190' : '\u2192'} ${Math.abs(wx).toFixed(3)} u/s\u00b2`,
  }
}

export default { computeTopPanel }
