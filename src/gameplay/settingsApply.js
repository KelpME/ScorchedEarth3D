/**
 * S7 — pure settings-apply model. NO DOM, NO fetch: node --test-able.
 *
 * applySettings(settingsObj, se, docs) -> { applied: [names], errors: [] }
 *  - settingsObj: FLAT map of every setting key (physics + landscape rows +
 *    economy options + play-options keys — all unique across the data files).
 *  - docs: the three loaded JSON docs { 'physics-presets', 'economy',
 *    'play-options' }. A pure module cannot fetch; the DOM layer (settings.js)
 *    loads via src/data/load.js and passes them in. Missing docs => THROW
 *    (fail-noisy doctrine: no silent vacuous validation).
 *  - EVERY field is validated against its JSON descriptor:
 *      range -> finite number within [min,max]  (fractional allowed:
 *               interestRate 0..0.3, gravity 0.05..10)
 *      enum  -> exact member of the enum list ("on"/"off" are STRINGS in the
 *               JSON, manual:L1853-L1856; per the S7 brief pin, JS booleans
 *               are ALSO accepted for on/off enums and the STORED form is a
 *               typed boolean — tanksFall true/false. All other enums stay
 *               strict-string, no coercion)
 *      file  -> string passthrough (legacy talk .cfg refs, manual:L2040-L2046)
 *    Out-of-range REJECTS with a message and leaves the target UNTOUCHED —
 *    never a silent clamp. Unknown keys are errors[], never dropped.
 *  - Per-field live-apply: valid fields apply even if siblings rejected
 *    (applied vs errors tell the whole story).
 *
 * GRAVITY CONVERSION (pinned in tests): se.gravity is WORLD u/s^2 —
 * systems/projectiles3d.js feeds it straight into stepBallistic
 * (src/gameplay/ballistics3d.js). The manual's gravity is SE px/s^2
 * (physics-presets.json "seUnit": true, manual:L1841-L1842). Conversion
 * anchor given by the S7 brief: SE_PX_TO_WORLD = 0.2 (the voxel3d cell is
 * V=0.1 world u and one SE pixel is two cells). So world = SE * 0.2 and the
 * manual default 0.2 SE px/s^2 -> 0.04 world u/s^2.
 *
 * WIND: maxWind/changingWind are stored on se.windCfg for the wind director.
 * rollWind(se, rngSeed) is the deterministic per-round roller (the
 * per-turn nudge for changingWind is a later leaf): an LCG (numericjs-style
 * constants) draws magnitude in [0, maxWind] and sign; manual wind blows
 * sideways, mapped onto x with the direction from the round seed, z stays 0.
 * The written se.wind = {x,z} is a horizontal ACCELERATION in world u/s^2 —
 * the 0.2-scaled accel (same SE_PX_TO_WORLD anchor as gravity), matching
 * stepBallistic's opts.wind semantics (ballistics3d.js header).
 *
 * W2-B (plan SE-COMPLETE-1012): wallMode is WIRED — validated here (enum) and
 * stored on se.settings.wallMode; consumers = the ballistics walls hook
 * (walls.wallsConfigFor, src/gameplay/walls.js) + the wall band visual.
 *
 * W5 ARCHITECTURE FLIP (user 2026-10-13): the voxelTerrain scene component's
 * voxelTerrain object is the SINGLE SOURCE OF TRUTH for the 3D terrain. The
 * TERRAIN_KNOBS rows (bumpiness, slope, flattenPeaks, mountainPercent,
 * randomLand, mapSize) are WRITE-THROUGH controllers: when the live `se`
 * exposes an applyTerrainKnob(key, value) hook (main.js owns it — it writes
 * the voxelTerrain component and re-generates), knob rows route THROUGH it
 * and never land on se.settings (the generator path no longer reads
 * settings). Pure-module callers without the hook fall back to the typed
 * se.settings store (documented: the hook owner is the write-through layer).
 *
 * Everything else (suspendDirt, tanksFall, bordersExtend, sky,
 * hostileEnvironment, economy options, play-options options) is stored
 * TYPE-VALIDATED on se.settings.{key} for later-leaf consumers.
 */

export const SE_PX_TO_WORLD = 0.2; // brief anchor: 1 SE px = 0.2 world u (V=0.1/cell, 2 cells/px)

// W5 architecture flip: terrain knob rows are write-through controllers onto
// the voxelTerrain scene component (via se.applyTerrainKnob) — never stored
// where the generator reads from (the generator reads params.landscape only).
export const TERRAIN_KNOBS = new Set([
  'bumpiness', 'slope', 'flattenPeaks', 'mountainPercent', 'randomLand', 'mapSize', 'rockAmount',
]);

// numericjs-style LCG constants — deterministic, no Math.random anywhere.
const LCG_A = 1664525;
const LCG_C = 1013904223;
const LCG_M = 4294967296; // 2^32

function lcg(seed) {
  let s = (seed >>> 0) || 1; // 0 would fixpoint on LCG_C; 1 keeps determinism pinned
  return () => {
    s = (Math.imul(s, LCG_A) + LCG_C) >>> 0;
    return s / LCG_M;
  };
}

/** Flat descriptor map: key -> { desc, section } from the three JSON docs. */
export function descriptorMap(docs) {
  if (!docs || !docs['physics-presets'] || !docs.economy || !docs['play-options']) {
    throw new Error(
      'applySettings: docs {physics-presets, economy, play-options} missing — ' +
      'cannot validate settings descriptors (fail loud, no vacuous validation)',
    );
  }
  const map = new Map()
  const put = (section, opts) => {
    for (const [key, d] of Object.entries(opts || {})) {
      if (key.startsWith('_') || !d || typeof d !== 'object') continue
      if (!d.range && !Array.isArray(d.enum) && d.type !== 'file') continue
      map.set(key, { desc: d, section })
    }
  }
  put('physics', docs['physics-presets'].physics)
  put('landscape', docs['physics-presets'].landscape)
  put('economy', docs.economy.options)
  put('playOptions', docs['play-options'].options)
  // T-UI-3: the sound/hardware/weapons-options docs join the descriptor map so
  // rows flipped wired:true route through applySettings (live-apply to the
  // sim). Docs may be absent (older callers) — absent docs simply contribute
  // no descriptors; a PRESENT doc with a wired:true row applies for real.
  if (docs.sound) put('sound', docs.sound.options)
  if (docs.hardware) put('hardware', docs.hardware.options)
  if (docs['weapons-options']) put('weapons', docs['weapons-options'].options)
  return map
}

/** Defaults for every renderable descriptor, straight from the JSON files. */
export function defaultsFromDocs(docs) {
  const out = {}
  for (const [key, { desc }] of descriptorMap(docs)) out[key] = desc.default
  return out
}

function validate(key, { desc }, value, errors) {
  if (Array.isArray(desc.enum)) {
    // Data truth (physics-presets.json manual:L1853-L1856): on/off rows are
    // STRINGS "on"/"off". Brief pin: booleans are ALSO accepted for on/off
    // enums and normalize to typed booleans on se.settings (documented, not
    // silent — every other enum stays strict-string, no coercion). Junk
    // ("yes", numbers) is still rejected.
    if (isOnOff(desc.enum)) {
      if (value === 'on' || value === 'off' || value === true || value === false) return true
      errors.push(`${key}: ${JSON.stringify(value)} is not one of ${desc.enum.join('|')} (or boolean)`)
      return false
    }
    if (!desc.enum.includes(value)) {
      errors.push(`${key}: ${JSON.stringify(value)} is not one of ${desc.enum.join('|')}`)
      return false
    }
    return true
  }
  if (desc.range) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < desc.range.min || value > desc.range.max) {
      errors.push(`${key}: ${JSON.stringify(value)} out of range ${desc.range.min}..${desc.range.max}`)
      return false
    }
    return true
  }
  if (desc.type === 'file') {
    if (typeof value !== 'string') {
      errors.push(`${key}: file option needs a string, got ${JSON.stringify(value)}`)
      return false
    }
    return true
  }
  errors.push(`${key}: unrecognized descriptor (no enum/range/file type) — not dropped, fix the data`)
  return false
}

function isOnOff(enumList) {
  return enumList.length === 2 && enumList.includes('on') && enumList.includes('off')
}

// Canonical stored form for an accepted value: on/off enums -> typed boolean
// (brief pin "tanksFall false/true stored typed"); everything else verbatim.
function canonical({ desc }, value) {
  if (Array.isArray(desc.enum) && isOnOff(desc.enum)) {
    if (value === 'on') return true
    if (value === 'off') return false
    return value // already a boolean (validated)
  }
  return value
}

export function applySettings(settingsObj, se, docs) {
  const map = descriptorMap(docs) // throws on missing docs — doctrine
  const applied = []
  const errors = []
  if (!settingsObj || typeof settingsObj !== 'object' || Array.isArray(settingsObj)) {
    errors.push(`settings payload must be a plain object, got ${JSON.stringify(settingsObj)}`)
    return { applied, errors }
  }
  // Unknown keys: errors, never dropped silently (fail-noisy doctrine).
  for (const key of Object.keys(settingsObj)) {
    if (!map.has(key)) {
      errors.push(`${key}: not declared in physics-presets/economy/play-options JSON — unknown settings are errors, not dropped`)
    }
  }
  for (const [key, value] of Object.entries(settingsObj)) {
    const d = map.get(key)
    if (!d) continue // already reported as unknown
    if (!validate(key, d, value, errors)) continue // rejected: target untouched
    const stored = canonical(d, value)
    if (key === 'gravity') {
      // SE px/s^2 -> world u/s^2 (see header; pinned at 0.04 for manual 0.2)
      se.gravity = value * SE_PX_TO_WORLD
    } else if (TERRAIN_KNOBS.has(key) && typeof se.applyTerrainKnob === 'function') {
      // W5 write-through: terrain knobs land on the voxelTerrain component via
      // main.js's controller — never on se.settings (the generator path does
      // not read settings). se is the same object in the DOM and in the
      // engine-dispatched system, so the hook behaves identically.
      se.applyTerrainKnob(key, stored)
    } else if (key === 'maxWind' || key === 'changingWind') {
      se.windCfg = { ...(se.windCfg || {}), [key]: stored }
      // W1-A: the changing-wind per-turn nudge is bounded by DATA — surface
      // the descriptor's deltaRange on windCfg when it rides the row.
      if (key === 'changingWind' && d.desc.deltaRange) se.windCfg.deltaRange = d.desc.deltaRange
    } else {
      se.settings = { ...(se.settings || {}) }
      se.settings[key] = stored
    }
    applied.push(key)
  }
  return { applied, errors }
}

/**
 * Deterministic round-wind roller. |value| <= maxWind, scaled 0.2 into the
 * world accel stepBallistic consumes; sign/direction from the LCG seeded with
 * rngSeed (per-round seed — later leaves re-roll per turn for changingWind).
 * Writes AND returns se.wind = { x, z: 0 }.
 */
/**
 * W1-C (plan SE-COMPLETE-1012) — Random Land (manual:L1955-L1960): re-roll
 * bumpiness / slope / flattenPeaks PER ROUND from the ROUND SEED. Same LCG
 * as rollWind — deterministic: same seed = same landscape, overriding the
 * manual settings values for that round. Pure: returns the params object the
 * terrain generator consumes (voxel3d/generator.js generate(seed, params)).
 */
export function rollLandscape(rngSeed) {
  const rand = lcg(Number(rngSeed) >>> 0)
  const bumpiness = Math.floor(rand() * 101) // 0..100, physics-presets range
  const slope = Math.floor(rand() * 101) // 0..100
  const flattenPeaks = rand() < 0.5 // on/off, stored typed like applySettings
  return { bumpiness, slope, flattenPeaks }
}

export function rollWind(se, rngSeed) {
  const maxWind = se && se.windCfg ? se.windCfg.maxWind : undefined
  if (typeof maxWind !== 'number' || !Number.isFinite(maxWind)) {
    console.error(`[se/settings] rollWind: se.windCfg.maxWind missing/invalid (${JSON.stringify(maxWind)}) — wind parks at 0; applySettings must run first`)
    se.wind = { x: 0, z: 0 }
    return se.wind
  }
  const rand = lcg(Number(rngSeed) >>> 0)
  const dir = rand() < 0.5 ? -1 : 1 // direction per round seed (manual: wind blows sideways -> x)
  const mag = rand() * maxWind * SE_PX_TO_WORLD // 0.2-scaled accel, world u/s^2
  se.wind = { x: mag === 0 ? 0 : dir * mag, z: 0 } // mag 0 -> +0, never -0
  return se.wind
}

/**
 * W1-A — per-turn changing-wind nudge. Deterministic by (seed, turnIndex):
 * an LCG hashed off the round seed + turn index draws a delta from the DATA
 * deltaRange (se.windCfg.deltaRange, sourced from physics-presets.json
 * changingWind; default ±25 SE px/s when absent), converted by the same 0.2
 * anchor, added to se.wind.x and CLAMPED so |wind.x| never exceeds
 * maxWind * 0.2. Writes AND returns se.wind.
 */
export function rollWindTurn(se, rngSeed, turnIndex) {
  const maxWind = se && se.windCfg ? se.windCfg.maxWind : undefined
  if (typeof maxWind !== 'number' || !Number.isFinite(maxWind)) {
    console.error(`[se/settings] rollWindTurn: se.windCfg.maxWind missing/invalid (${JSON.stringify(maxWind)}) — wind unchanged; applySettings/boot must set windCfg first`)
    return se.wind
  }
  const b = se.windCfg.deltaRange && Number.isFinite(se.windCfg.deltaRange.min) && Number.isFinite(se.windCfg.deltaRange.max)
    ? se.windCfg.deltaRange
    : { min: -25, max: 25 }
  const hash = (Math.imul(Number(rngSeed) >>> 0, 2654435761) ^ Math.imul(((turnIndex | 0) + 1) >>> 0, 40503)) >>> 0
  const rand = lcg(hash)
  const delta = b.min + rand() * (b.max - b.min) // SE px/s
  const maxWorld = maxWind * SE_PX_TO_WORLD
  const next = Math.max(-maxWorld, Math.min(maxWorld, se.wind.x + delta * SE_PX_TO_WORLD))
  se.wind = { x: next === 0 ? 0 : next, z: 0 } // next 0 -> +0, never -0
  return se.wind
}
