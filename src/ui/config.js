/**
 * S1 — pure setup-config model. NO DOM, NO fetch: node --test-able.
 *
 * defaultsFromData({ playOptions, personalities }) -> default config built
 * from the REAL data files (play-options.json + ai-personalities.json):
 *   { players: [{ name, kind, personalityId, color }], rounds, options: {...} }
 * Manual pins: 2 players default (L1613-L1614), rounds default 10 range
 * 1-1000 (L1616, transcribed into play-options.json mainMenuGameplay).
 *
 * validateSetupConfig(cfg, { options, mainMenu, personalities }) ->
 *   { ok, errors[], fixes[], players, options }
 * Fail-noisy doctrine: out-of-range / unknown / bad-enum values are ERRORS,
 * never silent clamps or drops. Two documented auto-fixes (recorded in
 * `fixes`, never silent): empty player name -> "Player N" (brief pin) and a
 * computer player with no personalityId -> first file entry (manual: the
 * computer picks itself a name; first tier = Moron, the "Easy" default).
 *
 * TANK_COLORS → MOVED TO DATA (SE-NPLAYER-1012): the palette is the
 * catalog-style LIST in play-options.json .players.defaultColors (>= 4
 * entries — 2-4 players need distinct tints; index mod length assigns).
 * tankPalette(playOptions) is the reader; fail-noisy on a short/missing list.
 * Options with descriptor type 'file' (attackFile/dieFile) are legacy .cfg
 * file references — not pickers; they pass through at their JSON default and
 * the UI renders them disabled+labelled (never silently dropped).
 */

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/

/**
 * The player-color PALETTE LIST, read from the DATA file verbatim.
 * Doctrine (SE-NPLAYER-1012): count and colors are runtime data — keep the
 * list >= 4 so 4 players get distinct tints (index mod length).
 */
export function tankPalette(playOptions) {
  const list = playOptions?.players?.defaultColors
  if (!Array.isArray(list) || list.length < 4 || !list.every((c) => typeof c === 'string' && HEX_COLOR_RE.test(c))) {
    throw new Error(`[se/config] play-options.json .players.defaultColors must be a list of >= 4 #rrggbb colors, got ${JSON.stringify(list && list.length)} entries`)
  }
  return [...list]
}

/** The player-count picker range + the default-name list, from the DATA file. */
export function playerRosterData(playOptions) {
  const p = playOptions?.players
  const c = p?.count
  if (!c || !Number.isInteger(c.min) || !Number.isInteger(c.max) || !Number.isInteger(c.default)
    || c.min < 1 || c.max < c.min || c.default < c.min || c.default > c.max) {
    throw new Error(`[se/config] play-options.json .players.count must be {min,max,default} integers, got ${JSON.stringify(c)}`)
  }
  const names = p?.defaultNames
  if (!Array.isArray(names) || names.length < c.max || !names.every((n) => typeof n === 'string' && n.trim() !== '')) {
    throw new Error(`[se/config] play-options.json .players.defaultNames must be >= count.max name strings, got ${JSON.stringify(names)}`)
  }
  return { count: { ...c }, defaultNames: [...names] }
}

/** One default roster row (name/color by INDEX from the DATA lists). */
function defaultPlayer(names, palette, i) {
  return {
    name: names[i % names.length],
    kind: 'human',
    personalityId: null,
    color: palette[i % palette.length],
  }
}

export function defaultsFromData({ playOptions, personalities }, playerCount) {
  if (!playOptions || !playOptions.options || typeof playOptions.options !== 'object') {
    throw new Error('defaultsFromData: playOptions (with .options map) missing — cannot build default config')
  }
  if (!playOptions.players) {
    throw new Error('defaultsFromData: playOptions.players missing (SE-NPLAYER-1012 count/names/palette are DATA) — cannot build default config')
  }
  const list = personalities && Array.isArray(personalities.personalities)
    ? personalities.personalities
    : (Array.isArray(personalities) ? personalities : null)
  if (!list || list.length === 0) {
    throw new Error('defaultsFromData: personalities list empty/missing — cannot build default config')
  }
  const { count, defaultNames } = playerRosterData(playOptions)
  const palette = tankPalette(playOptions)
  const n = playerCount === undefined ? count.default : playerCount
  if (!Number.isInteger(n) || n < count.min || n > count.max) {
    throw new Error(`defaultsFromData: playerCount ${JSON.stringify(n)} outside the data range ${count.min}..${count.max}`)
  }
  const players = Array.from({ length: n }, (_, i) => ({ ...defaultPlayer(defaultNames, palette, i), personalityId: list[0].id }))
  if (!players[0].personalityId) throw new Error(`defaultsFromData: first personality entry has no id: ${JSON.stringify(list[0])}`)
  const options = {}
  for (const [key, d] of Object.entries(playOptions.options)) options[key] = d.default
  const roundsDesc = (playOptions.mainMenuGameplay || {}).rounds
  const rounds = roundsDesc && typeof roundsDesc.default === 'number' ? roundsDesc.default : 10
  return { players, rounds, options }
}

function optionError(key, d, value, errors) {
  if (d && Array.isArray(d.enum)) {
    if (!d.enum.includes(value)) {
      errors.push(`option ${key}: "${value}" is not one of ${d.enum.join('|')}`)
    }
    return
  }
  if (d && d.range) {
    const v = value
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < d.range.min || v > d.range.max) {
      errors.push(`option ${key}: ${JSON.stringify(v)} out of range ${d.range.min}..${d.range.max}`)
    }
    return
  }
  if (d && d.type === 'file') {
    if (typeof value !== 'string') errors.push(`option ${key}: file option needs a string, got ${JSON.stringify(value)}`)
    return
  }
  errors.push(`option ${key}: unrecognized descriptor in play-options.json (no enum/range/file type) — not dropped, fix the data`)
}

export function validateSetupConfig(cfg, { options = {}, mainMenu, personalities, palette, defaultNames } = {}) {
  const errors = []
  const fixes = []
  const list = personalities && Array.isArray(personalities.personalities)
    ? personalities.personalities
    : (Array.isArray(personalities) ? personalities : [])
  if (list.length === 0) errors.push('personalities list missing/empty — cannot validate computer players')
  const ids = list.map((p) => p.id)

  if (!cfg || typeof cfg !== 'object') {
    return { ok: false, errors: ['config is not an object'], fixes, players: [], options: {} }
  }
  const rawPlayers = Array.isArray(cfg.players) ? cfg.players : []
  if (rawPlayers.length < 2 || rawPlayers.length > 10) {
    errors.push(`players: ${rawPlayers.length} — the game needs 2..10 players (manual L1613-L1614)`)
  }
  const players = rawPlayers.map((p, i) => {
    const out = { ...p }
    // name: empty -> auto from the DATA default-name list (PIN: auto-name,
    // not an error). Missing list = a caller bug, named loudly.
    if (typeof out.name !== 'string' || out.name.trim() === '') {
      if (!Array.isArray(defaultNames) || defaultNames.length === 0) {
        errors.push(`player ${i + 1}: empty name and no data default-name list provided (play-options.json .players.defaultNames)`)
      } else {
        out.name = defaultNames[i % defaultNames.length]
        fixes.push(`player ${i + 1}: empty name auto-named "${out.name}"`)
      }
    } else {
      out.name = out.name.trim()
    }
    // kind: human|computer only
    if (out.kind !== 'human' && out.kind !== 'computer') {
      errors.push(`player ${i + 1}: kind ${JSON.stringify(out.kind)} is not 'human' or 'computer'`)
    }
    // personalityId: computer needs one; missing -> Easy default (Moron, first
    // file entry), recorded; unknown -> error (never dropped).
    if (out.kind === 'computer') {
      if (out.personalityId == null || out.personalityId === '') {
        out.personalityId = ids[0] ?? null
        fixes.push(`player ${i + 1}: computer with no personality defaulted to ${JSON.stringify(out.personalityId)}`)
      } else if (ids.length && !ids.includes(out.personalityId)) {
        errors.push(`player ${i + 1}: personalityId "${out.personalityId}" not in ai-personalities.json`)
      }
    } else if (out.personalityId != null && out.personalityId !== '' && ids.length && !ids.includes(out.personalityId)) {
      errors.push(`player ${i + 1}: personalityId "${out.personalityId}" not in ai-personalities.json`)
    }
    // color: the DATA palette only (validated when the caller provides it)
    if (palette && !palette.includes(out.color)) {
      errors.push(`player ${i + 1}: color ${JSON.stringify(out.color)} is not in the play-options.json player palette`)
    }
    return out
  })

  // rounds: integer within the data file's range — error, never silent clamp
  const rRange = (mainMenu && mainMenu.rounds && mainMenu.rounds.range) || { min: 1, max: 1000 }
  const r = cfg.rounds
  if (typeof r !== 'number' || !Number.isFinite(r) || !Number.isInteger(r) || r < rRange.min || r > rRange.max) {
    errors.push(`rounds: ${JSON.stringify(r)} out of range ${rRange.min}..${rRange.max}`)
  }

  // options: unknown key -> error (NOT dropped); each key checked against its
  // JSON descriptor; every declared key must be present.
  const rawOpts = cfg.options && typeof cfg.options === 'object' ? cfg.options : {}
  const optsOut = { ...rawOpts }
  for (const key of Object.keys(rawOpts)) {
    if (!(key in options)) {
      errors.push(`option ${key}: not declared in play-options.json — unknown options are errors, not dropped`)
    }
  }
  for (const [key, d] of Object.entries(options)) {
    if (!(key in rawOpts)) {
      errors.push(`option ${key}: missing from config (data file declares it)`)
      continue
    }
    optionError(key, d, rawOpts[key], errors)
  }

  return { ok: errors.length === 0, errors, fixes, players, options: optsOut }
}
