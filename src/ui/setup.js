/**
 * S1 — roster & game-setup screen. Game-owned DOM overlay (product decision:
 * the engine canvas-ui is display-only; interactive screens are game DOM),
 * styled to the retro HUD. NO engine imports — pure DOM + the pure model in
 * ./config.js + src/data/load.js (browser fetch).
 *
 * openSetup(existingConfig) -> Promise<config>: builds the panel over
 * #setup-layer, every enumerable field a PICKER fed from the real data files
 * (doctrine: pickers over free text — only the player NAME is free input).
 * START BATTLE validates via validateSetupConfig; invalid -> visible inline
 * errors (fail-noisy: out-of-range is an error, never a silent clamp).
 * ESC deliberately does NOT close the overlay (first launch has no battle to
 * return to — S-later scope).
 *
 * Legacy JSON entries are never silently dropped: option descriptors the UI
 * cannot render (type 'file' — the legacy talk .cfg pickers, and any unknown
 * descriptor) render as a DISABLED, labelled row showing the value and WHY
 * (console.error names each one), and pass through the config untouched.
 *
 * TANK_COLORS → the palette is DATA now (SE-NPLAYER-1012): play-options.json
 * .players.defaultColors, read through tankPalette(). The player-COUNT is a
 * 2..4 PICKER fed from .players.count (pickers-over-freetext doctrine); the
 * picker lengthens/shortens cfg.players, and each new row takes its default
 * name/color by INDEX from the DATA lists.
 */
import { loadAll } from '../data/load.js'
import { tankPalette, playerRosterData, defaultsFromData, validateSetupConfig } from './config.js'
import { themeColor } from './theme.js'
import { hideBattleLoading } from './battle-loading.js'

const FONT = '14px/1.5 ui-monospace,monospace'

// Field styling shared by every picker/number input on this screen — colors
// come from data/ui-theme.json (fail-loud; no fallback literals).
const fieldStyle = (pad, w) => `font:${FONT};background:${themeColor('inputs.fieldBg')};color:${themeColor('inputs.fieldText')};border:1px solid ${themeColor('inputs.fieldBorderBlue')};padding:${pad}` + (w ? `;width:${w}` : '')

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

export function openSetup(existingConfig) {
  const layer = document.getElementById('setup-layer')
  if (!layer) {
    console.error('[se/setup] #setup-layer missing from index.html — setup overlay cannot mount')
    return Promise.reject(new Error('#setup-layer missing'))
  }
  layer.textContent = ''
  // The layer must own a real box (Playwright visibility + input blocking).
  layer.style.cssText = 'position:fixed;inset:0;z-index:40'

  return loadAll().then((data) => {
    const playOptions = data['play-options']
    const aiPersonalities = data['ai-personalities']
    if (!playOptions?.options) console.error('[se/setup] play-options.json has no .options map — setup cannot render game options')
    if (!aiPersonalities?.personalities?.length) console.error('[se/setup] ai-personalities.json has no .personalities — personality picker empty')

    const cfg = existingConfig
      ? structuredClone(existingConfig)
      : defaultsFromData({ playOptions, personalities: aiPersonalities })
    const personalities = aiPersonalities.personalities
    const optionDefs = playOptions.options
    const roundsRange = (playOptions.mainMenuGameplay?.rounds?.range) || { min: 1, max: 1000 }
    // SE-NPLAYER-1012: the roster's count range + default names + the color
    // palette all come from the DATA file (fail-noisy readers).
    const rosterData = playerRosterData(playOptions)
    const palette = tankPalette(playOptions)

    const panel = el('div', {
      id: 'setup-panel',
      style: 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;'
        + `background:rgba(10,14,20,.88);z-index:40;font:${FONT};color:${themeColor('text.body')}`,
    })
    const box = el('div', {
      style: `background:${themeColor('panels.blueBoxBg')};border:2px solid ${themeColor('panels.blueBorder')};padding:20px 24px;max-height:92vh;`
        + 'overflow-y:auto;min-width:640px;box-shadow:0 8px 40px #000',
    })
    panel.append(box)
    layer.append(panel)

    box.append(el('h1', {
      style: `margin:0 0 4px;font:700 18px ${FONT};letter-spacing:2px;color:${themeColor('text.gold')}`,
      text: 'SCORCHED EARTH — SETUP',
    }))
    box.append(el('div', {
      style: 'opacity:.7;margin-bottom:12px',
      text: 'Roster & game options (manual Ch.2 fidelity — every picker fed from the data files)',
    }))

    const errBox = el('ul', { id: 'setup-errors', style: `list-style:none;padding:0;margin:0 0 10px;color:${themeColor('text.error')}` })
    box.append(errBox)
    const showErrors = (errs) => {
      errBox.textContent = ''
      for (const e of errs) errBox.append(el('li', { text: '\u2717 ' + e }))
      errBox.style.display = errs.length ? 'block' : 'none'
    }
    showErrors([])

    // ---- Roster -----------------------------------------------------------
    // SE-NPLAYER-1012: a player-COUNT PICKER (2..4, from the data file) drives
    // cfg.players' length; rows render per player. Growing adds DATA-default
    // rows (name/color by index); shrinking drops the tail rows. The picker is
    // fed by playerRosterData(playOptions) — pickers over freetext, always.
    const roster = el('div', { id: 'setup-roster' })
    box.append(el('h2', { style: `margin:12px 0 6px;font:700 13px ${FONT};color:${themeColor('text.label')}`, text: 'PLAYERS' }))
    const countRow = el('div', { style: 'display:flex;align-items:center;gap:8px;margin:0 0 6px' })
    countRow.append(el('label', { for: 'player-count', text: 'Player count' }))
    const countSel = el('select', {
      id: 'player-count', class: 'se-player-count',
      style: fieldStyle('3px'),
    })
    for (let n = rosterData.count.min; n <= rosterData.count.max; n++) {
      countSel.append(el('option', { value: String(n), text: String(n) }))
    }
    countSel.value = String(cfg.players.length >= rosterData.count.min && cfg.players.length <= rosterData.count.max
      ? cfg.players.length : rosterData.count.default)
    countRow.append(countSel)
    box.append(countRow)
    box.append(roster)

    const rowRefs = [] // parallel to cfg.players: live inputs
    const buildRow = (p, i) => {
      const nameIn = el('input', {
        id: `p${i + 1}-name`, class: 'se-name', value: p.name, type: 'text',
        style: fieldStyle('3px 6px', '140px'),
      })
      const kindSel = el('select', {
        id: `p${i + 1}-kind`, class: 'se-kind',
        style: fieldStyle('3px'),
      },
        el('option', { value: 'human', text: 'Human' }),
        el('option', { value: 'computer', text: 'Computer' }),
      )
      kindSel.value = p.kind
      const perSel = el('select', {
        id: `p${i + 1}-personality`, class: 'se-personality',
        style: fieldStyle('3px'),
      })
      for (const pers of personalities) {
        perSel.append(el('option', { value: pers.id, text: `${pers.name} — ${pers.description}` }))
      }
      perSel.value = p.personalityId ?? personalities[0].id
      perSel.disabled = p.kind !== 'computer'
      kindSel.addEventListener('change', () => { perSel.disabled = kindSel.value !== 'computer' })

      // Tank color swatch picker — the DATA palette (>= 4 entries)
      const swatches = el('span', { class: 'se-swatches' })
      palette.forEach((c, ci) => {
        const b = el('button', {
          id: `p${i + 1}-color-${ci}`, type: 'button', title: c, 'aria-label': `tank color ${c}`,
          'data-color': c,
          style: `width:22px;height:22px;margin-right:4px;cursor:pointer;border:2px solid ${p.color === c ? themeColor('text.body') : themeColor('panels.blueBorder')};background:${c}`,
        })
        b.addEventListener('click', () => {
          p.color = c
          for (const s of swatches.querySelectorAll('button')) s.style.borderColor = themeColor('panels.blueBorder')
          b.style.borderColor = themeColor('text.body')
        })
        swatches.append(b)
      })

      const row = el('div', {
        class: 'player-row',
        style: `display:flex;align-items:center;gap:10px;margin:6px 0;padding:6px;border:1px solid ${themeColor('rows.blueRowBorder')};background:${themeColor('rows.blueRowBg')}`,
      },
        el('span', { style: `width:70px;color:${themeColor('text.label')}`, text: `TANK ${i + 1}` }),
        nameIn, kindSel, perSel, swatches,
      )
      roster.append(row)
      rowRefs.push({ nameIn, kindSel, perSel, player: p })
    }
    const buildRoster = (n) => {
      // resize cfg.players to n: growth takes DATA-default rows, shrink trims.
      while (cfg.players.length < n) {
        const i = cfg.players.length
        cfg.players.push({
          name: rosterData.defaultNames[i % rosterData.defaultNames.length],
          kind: 'human',
          personalityId: null,
          color: palette[i % palette.length],
        })
      }
      cfg.players.length = n
      roster.textContent = ''
      rowRefs.length = 0
      cfg.players.forEach(buildRow)
    }
    buildRoster(Number(countSel.value))
    countSel.addEventListener('change', () => { buildRoster(Number(countSel.value)) })

    // ---- Game options -----------------------------------------------------
    box.append(el('h2', { style: `margin:14px 0 6px;font:700 13px ${FONT};color:${themeColor('text.label')}`, text: 'GAME OPTIONS' }))
    const optGrid = el('div', { id: 'setup-options', style: 'display:grid;grid-template-columns:auto 1fr;gap:6px 12px;align-items:center' })
    box.append(optGrid)

    // Rounds (Main Menu knob, manual L1616: range from the data file)
    optGrid.append(el('label', { for: 'rounds', text: 'Rounds' }))
    const roundsIn = el('input', {
      id: 'rounds', type: 'number', min: roundsRange.min, max: roundsRange.max, value: cfg.rounds,
      style: fieldStyle('3px 6px', '90px'),
    })
    optGrid.append(roundsIn)

    const optRefs = new Map() // key -> { read(): value }
    for (const [key, d] of Object.entries(optionDefs)) {
      const label = d.label || key
      if (Array.isArray(d.enum) && d.enum.length > 0) {
        const sel = el('select', {
          id: `opt-${key}`,
          style: fieldStyle('3px'),
        })
        for (const v of d.enum) sel.append(el('option', { value: v, text: v }))
        if (!d.enum.includes(cfg.options[key])) {
          // legacy value not in the enum: show it disabled+labelled, never dropped
          const o = el('option', { value: cfg.options[key], text: `${cfg.options[key]} (legacy — not in manual options)` })
          sel.append(o)
          console.error(`[se/setup] option ${key}: default "${cfg.options[key]}" not in enum ${d.enum.join('|')} — shown as legacy`)
        }
        sel.value = cfg.options[key]
        optGrid.append(el('label', { for: `opt-${key}`, text: label }), sel)
        optRefs.set(key, { read: () => sel.value })
      } else if (d.range) {
        const num = el('input', {
          id: `opt-${key}`, type: 'number', min: d.range.min, max: d.range.max, value: cfg.options[key],
          style: fieldStyle('3px 6px', '90px'),
        })
        optGrid.append(el('label', { for: `opt-${key}`, text: label }), num)
        optRefs.set(key, { read: () => (num.value === '' ? NaN : Number(num.value)) })
      } else {
        // Unrenderable descriptor ('file' talk-cfg pickers, unknown types):
        // DISABLED + labelled row, value passed through, loud console line.
        const why = d.type === 'file'
          ? 'legacy .cfg file picker — no file dialog in this build'
          : 'unrecognized descriptor in play-options.json'
        console.error(`[se/setup] option ${key} (${label}): ${why} — rendered disabled, value "${cfg.options[key]}" passes through`)
        const box2 = el('span', { style: 'opacity:.55' },
          el('input', { id: `opt-${key}`, type: 'text', value: String(cfg.options[key]), disabled: true,
            style: `font:${FONT};background:${themeColor('inputs.fieldBg')};color:${themeColor('text.disabledInput')};border:1px solid ${themeColor('rows.blueRowBorder')};padding:3px 6px;width:160px` }),
          el('span', { text: ` — ${why}` }))
        optGrid.append(el('label', { for: `opt-${key}`, text: label }), box2)
        optRefs.set(key, { read: () => cfg.options[key] })
      }
    }

    // ---- START ------------------------------------------------------------
    const start = el('button', {
      id: 'btn-start-battle', type: 'button',
      style: `margin-top:16px;font:700 14px ${FONT};letter-spacing:1px;padding:8px 22px;cursor:pointer;`
        + `background:${themeColor('buttons.primaryBg')};color:${themeColor('buttons.primaryText')};border:none`,
      text: 'START BATTLE',
    })
    box.append(start)

    return new Promise((resolve) => {
      start.addEventListener('click', () => {
        for (const r of rowRefs) {
          r.player.name = r.nameIn.value
          r.player.kind = r.kindSel.value
          r.player.personalityId = r.perSel.value
        }
        const draft = {
          players: cfg.players.map((p) => ({ ...p })),
          rounds: roundsIn.value === '' ? NaN : Number(roundsIn.value),
          options: {},
        }
        for (const [key, ref] of optRefs) draft.options[key] = ref.read()
        const res = validateSetupConfig(draft, {
          options: optionDefs,
          mainMenu: playOptions.mainMenuGameplay,
          personalities: aiPersonalities,
          palette,
          defaultNames: rosterData.defaultNames,
        })
        if (!res.ok) {
          hideBattleLoading()
          showErrors(res.errors)
          console.error('[se/setup] START rejected (config invalid): ' + res.errors.join('; '))
          return
        }
        for (const f of res.fixes) console.info('[se/setup] auto-fix: ' + f)
        layer.style.display = 'none'
        resolve({ players: res.players, rounds: draft.rounds, options: res.options })
      })
    })
  })
}
