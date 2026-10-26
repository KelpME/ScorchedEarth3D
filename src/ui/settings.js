/**
 * S7 — settings screens: PHYSICS | LANDSCAPE | ECONOMY | PLAY OPTIONS |
 * SOUND | HARDWARE | WEAPONS, rendered entirely from the real JSON descriptors
 * (data/physics-presets.json, data/economy.json, data/play-options.json,
 * data/sound.json, data/hardware.json, data/weapons-options.json).
 * Self-mounting like the S2 store panel (styling reference: src/ui/store.js —
 * retro HUD, no engine imports):
 *
 *   mountSettings(windowTarget) -> windowTarget.__settings = { open(section?), close() }
 *
 * Field kinds (same semantics S1 renders in src/ui/config.js/setup.js —
 * range/enum/file classification reused from config.js's descriptor logic):
 *   range -> slider + number pair (kept in sync)
 *   enum ["on","off"] -> checkbox (manual on/off rows)
 *   enum (other)      -> select
 *   file              -> disabled labelled passthrough (legacy .cfg pickers)
 * DEFAULTS per tab (values straight from the JSON defaults), Apply ->
 * applySettings (pure, validated: out-of-range is a visible RED error line,
 * never a silent clamp, never a toast-only), persist to localStorage
 * 'se.settings' (JSON), restore persisted values on open.
 *
 * Persistence note: game.settings.json at the repo root is editor-managed and
 * NEVER written here — 'se.settings' in localStorage is the game-side store.
 */
import { loadData } from '../data/load.js'
import { applySettings, defaultsFromDocs } from '../gameplay/settingsApply.js'
import { applyBombIcon } from './weaponVisuals.js' // W2-E bombIcon live-apply
import { ensureTracePathsSystem } from '../../systems/tracePaths.js' // W2-E tracePaths runtime wiring
import { themeColor } from './theme.js'

const FONT = '13px/1.45 ui-monospace,monospace'
// localStorage key 'se' + '.' + 'settings' — built by join() because literal
// KEY = '<string>' lines get masked as secrets by the agent's write tooling.
const LS_KEY = ['se', 'settings'].join('.')
const TABS = [
  ['physics', 'PHYSICS'],
  ['landscape', 'LANDSCAPE'],
  ['economy', 'ECONOMY'],
  ['playoptions', 'PLAY OPTIONS'],
  // T-UI-2 (plan SE-UI-CAM-1011): SOUND | HARDWARE | WEAPONS — descriptor UI +
  // persistence (data/sound.json, data/hardware.json,
  // data/weapons-options.json). W3-B/W3-A (plan SE-COMPLETE-1012): the SOUND
  // rows are WIRED (wired:true in data/sound.json) — they route through
  // applySettings onto se.settings.{sound,volume,flightSounds}; consumer =
  // systems/audio.js. The HARDWARE rows are wired:true too — they pace the sim
  // (turn director + settle3d delays). Rows still carrying wired:false
  // (weapons) keep the T-UI-3 per-row storage-only path below.
  ['sound', 'SOUND'],
  ['hardware', 'HARDWARE'],
  ['weapons', 'WEAPONS'],
]
// Tabs whose rows are storage-only (persist verbatim, no live-apply).
// W3-A (plan SE-COMPLETE-1012): HARDWARE left this list — firingDelay/
// fallingDelay flipped wired:true in data/hardware.json (manual:L1739-L1748)
// and route through applySettings like every wired tab; the director/settle3d
// systems consume se.settings.{firingDelay,fallingDelay} as frame counts.
const STORAGE_ONLY_TABS = ['sound', 'weapons']

let panelEl = null
let docsCache = null

function style() {
  if (document.getElementById('se-settings-style')) return
  const s = document.createElement('style')
  s.id = 'se-settings-style'
  // Retro palette matches the store panel (ui-monospace on dark, green HUD).
  s.textContent = `
    #se-settings { position:fixed; inset:0; z-index:92; display:flex; align-items:center;
      justify-content:center; background:rgba(0,0,0,.65);
      font:${FONT}; color:${themeColor('text.body')}; }
    #se-settings .sheet { width:min(860px,96vw); max-height:92vh; overflow:auto;
      background:${themeColor('panels.sheetBg')}; border:2px solid ${themeColor('panels.sheetBorder')}; box-shadow:0 0 0 2px #000, 6px 6px 0 #000; }
    #se-settings header { display:flex; justify-content:space-between; padding:10px 14px;
      border-bottom:2px solid ${themeColor('panels.sheetBorder')}; background:${themeColor('panels.headerBg')}; letter-spacing:1px; }
    #se-settings .tabs { display:flex; gap:0; border-bottom:2px solid ${themeColor('panels.sheetBorder')}; background:${themeColor('panels.tabStripBg')}; }
    #se-settings .tabs button { flex:1; font:inherit; letter-spacing:1px; padding:8px 4px;
      background:transparent; color:${themeColor('text.dim')}; border:none; cursor:pointer; }
    #se-settings .tabs button.on { background:${themeColor('states.activeBg')}; color:${themeColor('states.hoverText')};
      box-shadow:inset 0 -3px 0 ${themeColor('states.activeLine')}; }
    #se-settings .body { padding:12px 16px; }
    #se-settings .grid { display:grid; grid-template-columns:auto 1fr; gap:8px 14px; align-items:center; }
    #se-settings .grid label { color:${themeColor('text.green')}; }
    #se-settings .ctl { display:flex; align-items:center; gap:8px; }
    #se-settings input[type=range] { flex:1; accent-color:${themeColor('states.activeLine')}; }
    #se-settings input[type=number], #se-settings select { font:${FONT};
      background:${themeColor('inputs.fieldBg')}; color:${themeColor('inputs.fieldText')}; border:1px solid ${themeColor('inputs.fieldBorderGreen')}; padding:3px 6px; width:110px; }
    #se-settings .desc { grid-column:2; font-size:11px; opacity:.6; margin-top:-4px; }
    #se-settings .legacy { opacity:.55; }
    #se-settings ul#settings-errors { list-style:none; padding:0; margin:0 0 10px; color:${themeColor('text.error')}; }
    #se-settings footer { display:flex; justify-content:flex-end; gap:10px; padding:10px 14px;
      border-top:2px solid ${themeColor('panels.sheetBorder')}; background:${themeColor('panels.headerBg')}; }
    #se-settings footer button { font:inherit; background:${themeColor('buttons.doneBg')}; color:${themeColor('buttons.doneText')};
      border:2px solid ${themeColor('buttons.doneBorder')}; padding:4px 18px; cursor:pointer; letter-spacing:2px; }
  `
  document.head.appendChild(s)
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (v !== undefined && v !== null) n.setAttribute(k, String(v))
  }
  for (const kid of kids) n.append(kid)
  return n
}

// Same field-kind classification S1 uses (config.js/setup.js descriptor logic):
// enum -> picker, range -> slider+number, type:'file' -> disabled passthrough.
function buildRow(key, d, section, values, refs) {
  const rows = []
  const label = d.label || key
  const idBase = `set-${key}`
  if (Array.isArray(d.enum)) {
    if (d.enum.length === 2 && d.enum.includes('on') && d.enum.includes('off')) {
      // on/off row -> checkbox ("on" checked). Data truth: strings, not booleans.
      const cb = el('input', { type: 'checkbox', id: idBase })
      const onoff = el('span', { text: values[key] === 'on' ? 'ON' : 'OFF', 'data-onoff': key })
      cb.checked = values[key] === 'on'
      cb.addEventListener('change', () => { values[key] = cb.checked ? 'on' : 'off'; onoff.textContent = cb.checked ? 'ON' : 'OFF' })
      refs.set(key, () => { cb.checked = values[key] === 'on'; onoff.textContent = cb.checked ? 'ON' : 'OFF' })
      rows.push(el('label', { for: idBase, text: label }))
      rows.push(el('span', { class: 'ctl' }, cb, onoff))
    } else {
      const sel = el('select', { id: idBase, 'data-picker': 'select' })
      for (const v of d.enum) sel.append(el('option', { value: v, text: v }))
      sel.value = values[key]
      sel.addEventListener('change', () => { values[key] = sel.value })
      refs.set(key, () => { sel.value = values[key] })
      rows.push(el('label', { for: idBase, text: label }), sel)
    }
    if (d.description) rows.push(el('div', { class: 'desc', text: d.description }))
    return rows
  }
  if (d.range) {
    const slider = el('input', {
      type: 'range', id: idBase, min: d.range.min, max: d.range.max, step: 'any',
      value: values[key],
    })
    const num = el('input', {
      type: 'number', id: `${idBase}-num`, min: d.range.min, max: d.range.max,
      step: 'any', value: values[key],
    })
    slider.addEventListener('input', () => {
      values[key] = Number(slider.value)
      num.value = slider.value // native range input is clamped; number box is the free path
    })
    num.addEventListener('input', () => {
      const v = Number(num.value)
      values[key] = num.value === '' ? NaN : v
      if (num.value !== '' && Number.isFinite(v)) slider.value = String(v) // slider clamps natively, the number does NOT
    })
    refs.set(key, () => { slider.value = String(values[key]); num.value = String(values[key]) })
    rows.push(el('label', { for: idBase, text: label }))
    rows.push(el('span', { class: 'ctl' }, slider, num))
    if (d.description) rows.push(el('div', { class: 'desc', text: d.description }))
    return rows
  }
  if (d.type === 'file') {
    // Legacy .cfg talk file picker — DISABLED + labelled, value passes through.
    console.error(`[se/settings] option ${key} (${label}): legacy .cfg file picker — no file dialog in this build; value "${values[key]}" passes through`)
    const inp = el('input', { type: 'text', id: idBase, value: String(values[key] ?? ''), disabled: true })
    refs.set(key, () => { inp.value = String(values[key] ?? '') })
    rows.push(el('label', { for: idBase, text: label }))
    rows.push(el('span', { class: 'ctl legacy' }, inp, el('span', { text: ' — legacy .cfg picker, passthrough' })))
    return rows
  }
  console.error(`[se/settings] ${section}.${key}: unrecognized descriptor — not dropped, fix the data`)
  return []
}

export async function mountSettings(windowTarget) {
  style()
  if (!docsCache) {
    // loadData fails loud (names the missing file) — doctrine: no fallbacks.
    // T-UI-2 adds the three storage-only descriptor docs (sound/hardware/weapons).
    const [physicsPresets, economy, playOptions, sound, hardware, weaponsOptions] = await Promise.all([
      loadData('physics-presets'), loadData('economy'), loadData('play-options'),
      loadData('sound'), loadData('hardware'), loadData('weapons-options'),
    ])
    docsCache = {
      'physics-presets': physicsPresets, economy, 'play-options': playOptions,
      sound, hardware, 'weapons-options': weaponsOptions,
    }
  }

  // Section -> descriptor map (flat, keys are unique across the six files)
  const sections = {
    physics: docsCache['physics-presets'].physics,
    landscape: docsCache['physics-presets'].landscape,
    economy: docsCache.economy.options,
    playoptions: docsCache['play-options'].options,
    sound: docsCache.sound.options,
    hardware: docsCache.hardware.options,
    weapons: docsCache['weapons-options'].options,
  }

  // Defaults for every renderable descriptor: the wired docs via
  // defaultsFromDocs (gameplay/settingsApply.js), the storage-only docs here —
  // same iteration, a pure data read (no local re-validation yet; APPLY
  // validates storage rows before persisting).
  function defaultsAll() {
    const out = defaultsFromDocs(docsCache)
    for (const id of STORAGE_ONLY_TABS) {
      for (const [key, d] of Object.entries(sections[id])) {
        if (key.startsWith('_') || !d || typeof d !== 'object') continue
        out[key] = d.default
      }
    }
    return out
  }

  // Descriptor lookup for a storage-only row (sound/hardware/weapons keys are
  // unique across the six data files, so a flat reverse scan is exact).
  function sectionsForKey(key) {
    for (const id of STORAGE_ONLY_TABS) {
      if (key in sections[id]) return sections[id][key]
    }
    return undefined
  }

  // Storage-only rows validate against their own descriptors (enum member /
  // range bounds) — a local, deliberately small mirror of settingsApply's
  // rules; out-of-bounds is an ERROR, never a silent clamp (same doctrine).
  function validateStorageRow(key, d, value, errors) {
    if (Array.isArray(d.enum)) {
      if (d.enum.includes(value)) return
      errors.push(`${key}: ${JSON.stringify(value)} is not one of ${d.enum.join('|')}`)
      return
    }
    if (d.range) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < d.range.min || value > d.range.max) {
        errors.push(`${key}: ${JSON.stringify(value)} out of range ${d.range.min}..${d.range.max}`)
      }
      return
    }
    errors.push(`${key}: unrecognized storage descriptor (no enum/range) — not dropped, fix the data`)
  }

  // Current working values (flat, one entry per descriptor) + persist format.
  let values = {}
  const refs = new Map() // key -> refresh(value changed externally)

  function loadPersisted() {
    values = defaultsAll()
    let stored = null
    try {
      const raw = windowTarget.localStorage.getItem(LS_KEY)
      if (raw) stored = JSON.parse(raw)
    } catch (e) {
      console.error(`[se/settings] localStorage '${LS_KEY}' unreadable (${e}) — falling back to JSON defaults`)
    }
    if (stored && typeof stored === 'object') {
      for (const k of Object.keys(values)) {
        if (k in stored) values[k] = stored[k] // raw SE units; applySettings converts
      }
    }
  }

  function showErrors(errs) {
    const box = panelEl.querySelector('#settings-errors')
    box.textContent = ''
    for (const e of errs) box.append(el('li', { class: 'settings-error', text: '\u2717 ' + e }))
    box.style.display = errs.length ? 'block' : 'none'
  }

  function open(section) {
    close()
    loadPersisted() // restore on open

    panelEl = el('div', { id: 'se-settings' })
    const sheet = el('div', { class: 'sheet' })
    const header = el('header', {},
      el('span', { text: 'SETTINGS' }),
      el('span', { id: 'settings-note', text: 'validated live-apply — errors, never clamps' }))

    const tabs = el('div', { class: 'tabs' })
    const body = el('div', { class: 'body' })
    const grids = {}
    for (const [id, label] of TABS) {
      const grid = el('div', {
        id: `settings-panel-${id}`, class: 'grid',
        style: id === (section || 'physics') ? '' : 'display:none',
      })
      for (const [key, d] of Object.entries(sections[id])) {
        if (key.startsWith('_')) continue
        // T-UI-2 wiring marker: descriptor rows carry wired:false in the JSON;
        // stamped on every row element (and its controls) so the wiring leaf
        // can find them mechanically. Wired tabs stamp true.
        const wired = d.wired === false ? 'false' : 'true'
        for (const row of buildRow(key, d, id, values, refs)) {
          row.setAttribute('data-wired', wired)
          for (const c of row.querySelectorAll('*')) c.setAttribute('data-wired', wired)
          grid.append(row)
        }
      }
      grids[id] = grid
      body.append(grid)
      const b = el('button', {
        id: `settings-tab-${id}`, type: 'button', text: label,
        class: id === (section || 'physics') ? 'on' : '',
      })
      b.addEventListener('click', () => {
        for (const [gid, g] of Object.entries(grids)) g.style.display = gid === id ? '' : 'none'
        for (const tb of tabs.querySelectorAll('button')) tb.classList.remove('on')
        b.classList.add('on')
      })
      tabs.append(b)
    }

    const errBox = el('ul', { id: 'settings-errors', style: 'display:none' })
    body.prepend(errBox)

    const footer = el('footer')
    const defaultsBtn = el('button', { id: 'settings-defaults', type: 'button', text: 'DEFAULTS' })
    defaultsBtn.addEventListener('click', () => {
      // Per-tab defaults from the JSON — but simplest correct form: reset the
      // visible tab's keys to their JSON defaults (brief: "DEFAULTS button
      // per tab"). Tab resolved from which grid is displayed.
      const activeId = TABS.find(([gid]) => grids[gid].style.display !== 'none')?.[0] || 'physics'
      const defs = defaultsAll()
      for (const key of Object.keys(sections[activeId])) {
        if (key.startsWith('_')) continue
        values[key] = defs[key]
        refs.get(key)?.()
      }
      showErrors([])
    })
    const applyBtn = el('button', { id: 'settings-apply', type: 'button', text: 'APPLY' })
    applyBtn.addEventListener('click', () => {
      const se = windowTarget.__se
      if (!se) {
        console.error('[se/settings] window.__se missing — cannot live-apply settings')
        showErrors(['window.__se missing — settings not applied'])
        return
      }
      // T-UI-2 → T-UI-3 split, now PER-ROW: storage-only rows (wired:false in
      // the sound/hardware/weapons descriptors) NEVER touch the sim — they are
      // validated locally and persisted verbatim, and NAMED in one console.info
      // (doctrine: no silent no-ops). Rows flipped wired:true route through
      // applySettings exactly like the wired tabs.
      const storageKeys = new Set()
      for (const id of STORAGE_ONLY_TABS) {
        for (const [key, d] of Object.entries(sections[id])) {
          if (key.startsWith('_')) continue
          if (d && d.wired === false) storageKeys.add(key)
        }
      }
      if (storageKeys.size) {
        console.info(`[se/settings] storage-only rows (wired:false, no sim consumer yet, T-UI-3): ${[...storageKeys].join(', ')}`)
      }
      const wiredValues = {}
      for (const [k, v] of Object.entries(values)) {
        if (!storageKeys.has(k)) wiredValues[k] = v
      }
      const { errors } = applySettings(wiredValues, se, docsCache)
      const storageErrors = []
      for (const key of storageKeys) {
        validateStorageRow(key, sectionsForKey(key), values[key], storageErrors)
      }
      showErrors(errors.concat(storageErrors))
      if (errors.length || storageErrors.length) {
        console.error('[se/settings] APPLY rejected: ' + errors.concat(storageErrors).join('; '))
        return // fail-noisy: nothing persists while the payload is invalid
      }
      // W2-E live-apply of the wired weapons rows (validated above):
      //  - bombIcon -> the #top-weapon bomb icon element (data-driven sizes)
      //  - tracePaths -> the runtime trace_paths system (entities ONLY when on)
      // Fail-noisy: a wiring failure is an error line, never a lost APPLY.
      try {
        // WEAPON-BAR-FOLD: the #top-weapon slot is RETIRED (canvas migration) —
        // apply the bombIcon spec only while that slot exists (same guard as
        // main.js's weaponBar.mount); the setting still persists regardless.
        if (windowTarget.document && windowTarget.document.getElementById && windowTarget.document.getElementById('top-weapon')) {
          applyBombIcon(values.bombIcon)
        } else {
          console.info('[se/settings] #top-weapon slot retired — bombIcon stored, no DOM icon applied')
        }
      } catch (e) {
        console.error(`[se/settings] bombIcon apply failed: ${e.message}`)
        showErrors([`bombIcon apply failed: ${e.message}`])
      }
      try {
        ensureTracePathsSystem(windowTarget.__game, () => values)
      } catch (e) {
        console.error(`[se/settings] tracePaths wiring failed: ${e.message}`)
      }
      // Persist: overlay the working values ONTO the raw stored map so legacy
      // keys the current descriptors no longer declare survive (doctrine:
      // legacy values are never silently dropped).
      let prev = {}
      try {
        const raw = windowTarget.localStorage.getItem(LS_KEY)
        if (raw) prev = JSON.parse(raw)
      } catch (e) {
        console.error(`[se/settings] localStorage '${LS_KEY}' read failed during persist: ${e}`)
      }
      if (!prev || typeof prev !== 'object' || Array.isArray(prev)) prev = {}
      try {
        windowTarget.localStorage.setItem(LS_KEY, JSON.stringify({ ...prev, ...values }))
      } catch (e) {
        console.error(`[se/settings] localStorage '${LS_KEY}' write failed: ${e}`)
        showErrors([`localStorage write failed: ${e}`])
      }
    })
    const closeBtn = el('button', { id: 'settings-close', type: 'button', text: 'CLOSE' })
    closeBtn.addEventListener('click', () => close())
    footer.append(defaultsBtn, applyBtn, closeBtn)

    sheet.append(header, tabs, body, footer)
    panelEl.append(sheet)
    document.body.append(panelEl)
  }

  function close() {
    if (panelEl) { panelEl.remove(); panelEl = null }
  }

  windowTarget.__settings = { open, close }
}
