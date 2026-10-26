// W4-C (plan SE-COMPLETE-1012) — TALKING TANKS: attack/die taunt lines as DATA
// (data/talk.json, verbatim from the OG shareware TALK1/TALK2.CFG pack); this
// module is the pure MECHANISM. Doctrine (deaths.js rules apply):
//   - the picker is deterministic per battle seed + pick index: the same
//     (kind, seed, index) ALWAYS yields the same line — no Math.random
//   - the no-repeat window + cooldown/skip rules are DATA (pick block), not
//     code literals; a cooldown-skipped play consumes NO pick
//   - the speech element is presentation only (HUD rules): it reads the pick
//     and writes DOM text; it never touches the simulation. All visual
//     numbers (position/size/duration) live in data/talk.json .speech and are
//     editor-tunable there (deaths.json doctrine).
// Mounts itself lazily on window.__se (se.talk = createTalk(se)) from the DIE
// call site (src/gameplay/deaths.js playDeath). The ATTACK call site is a
// 1-line hook in main.js fireActiveTurn (documented in the W4-C report).
// DISPLAY (follows the widget-child pattern of the ui_* canvases): one persistent speech
// element, top-panel-ADJACENT (inserted after #top-panel), cleared after the
// data duration. Timers/now are injectable so unit tests stay deterministic.

import talkDataJson from '../data/talk.json' with { type: 'json' }

// mulberry32 — seeded PRNG (deterministic per battle seed), same shape as
// deaths.js/treeDebris.js's rng (duplicated, not imported: deaths.js imports
// THIS module, and a back-import would be a cycle).
export function mulberry32(seed) {
  let a = seed | 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function talkData(d = talkDataJson) {
  return d
}

/** Fail-loud: a kind without a data pool is a data-file bug, not an empty string. */
function poolFor(kind, d) {
  const pool = d[kind]
  if (!Array.isArray(pool) || pool.length === 0) {
    throw new Error(`[se/talk] unknown kind "${kind}" — no line pool in data/talk.json`)
  }
  return pool
}

/**
 * Pure line picker: deterministic per (kind, seed, index). The window state is
 * DERIVED, not stored — line #index replays the rng stream from #0 with the
 * no-repeat window applied, so the same battle seed always produces the same
 * line sequence no matter how the call is observed. Different kinds hash the
 * seed apart (attack and die streams are independent).
 */
export function pickLine(kind, seed, index, d = talkDataJson) {
  const pool = poolFor(kind, d)
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`[se/talk] pick index must be a non-negative integer (got ${index})`)
  }
  let khash = 0
  for (const ch of String(kind)) khash = (Math.imul(khash, 31) + ch.charCodeAt(0)) | 0
  const rng = mulberry32((seed | 0) ^ khash)
  const w = Math.min(Math.max(0, d.pick?.noRepeatWindow ?? 0), pool.length - 1)
  const recent = []
  let line = null
  for (let i = 0; i <= index; i++) {
    let cand = null
    for (let guard = 0; guard < 1000; guard++) {
      cand = pool[Math.floor(rng() * pool.length)]
      if (!recent.includes(cand)) break // window honored; guard never trips (w < pool.length)
    }
    line = cand
    recent.push(line)
    if (recent.length > w) recent.shift()
  }
  return line
}

/** Battle seed for picks: the SAME seed the death sequencer uses (terrain seed). */
function battleSeed(se) {
  return (se?.terrainSeed?.value | 0) || 0
}

/**
 * Talk handle (mounted as se.talk). play(kind, tankId, opts?) -> the shown
 * line, or null when the data cooldown rule SKIPS the play (no pick consumed,
 * the on-screen line stays untouched). opts.seed overrides the battle seed
 * (the die call site passes the death sequencer's seed so the same death is
 * the same line). All rules come from data/talk.json.
 */
export function createTalk(se, { timers, doc, plays } = {}) {
  timers = timers || {
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  }
  doc = doc || (typeof document !== 'undefined' ? document : null)
  const data = talkDataJson
  const sp = data.speech || {}
  const state = (se.talkState = se.talkState || { count: {}, lastAt: {}, clearId: null })
  let el = null

  function ensureElement() {
    if (!doc) return null // headless purity: no DOM, no render (unit paths)
    if (!el) el = doc.getElementById(sp.id || 'se-speech')
    if (!el) {
      el = doc.createElement('div')
      el.id = sp.id || 'se-speech'
      Object.assign(el.style, {
        position: 'fixed',
        top: `${sp.topPx ?? 92}px`,
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: `${sp.maxWidthPx ?? 640}px`,
        font: `${sp.fontSizePx ?? 15}px/1.5 ui-monospace,monospace`,
        color: '#f3e9c8',
        background: 'rgba(20,26,18,.92)',
        border: '1px solid #e8c547',
        borderRadius: '10px',
        padding: '6px 14px',
        textAlign: 'center',
        whiteSpace: 'normal',
        pointerEvents: 'none',
        zIndex: 80,
        textShadow: '0 1px 2px #000',
        boxShadow: '0 2px 0 #000',
        display: 'none',
      })
      // CANVAS-MIGRATION 2026-10: the static #top-panel markup is gone —
      // anchor to the setup layer (top-of-page HUD-adjacent position).
      const panel = doc.getElementById('setup-layer')
      if (panel && panel.nextSibling) doc.body.insertBefore(el, panel.nextSibling) // setup-layer-adjacent
      else doc.body.insertBefore(el, doc.body.firstChild ?? null)
    }
    return el
  }

  function clearLine() {
    state.clearId = null
    if (el) { el.textContent = ''; el.style.display = 'none' } // cleared after the data duration
  }

  function play(kind, tankId, opts = {}) {
    const cd = data.pick?.cooldownS ?? 0
    const now = timers.now()
    if (cd > 0 && state.lastAt[kind] != null && now - state.lastAt[kind] < cd - 1e-9) {
      return null // data skip rule: inside the cooldown -> silent, no pick consumed
    }
    const seed = opts.seed != null ? opts.seed | 0 : battleSeed(se)
    const index = state.count[kind] ?? 0
    const line = pickLine(kind, seed, index, data)
    state.count[kind] = index + 1
    state.lastAt[kind] = now
    const node = ensureElement()
    if (node) {
      if (state.clearId != null) timers.clearTimeout(state.clearId) // a new line replaces a live one
      node.textContent = line
      node.style.display = 'block'
      state.clearId = timers.setTimeout(clearLine, (sp.durationS ?? 2.5) * 1000)
    }
    plays?.push({ kind, tankId, line, seed, index })
    return line
  }

  const handle = { play, clear: clearLine, data }
  se.talk = handle // self-mount: window.__se.talk (deaths.js installs us lazily)
  return handle
}
