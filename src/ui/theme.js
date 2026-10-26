// ui-theme loader — the SINGLE runtime reader for data/ui-theme.json
// (doctrine slice 1, plan SE-COMPLETE-1012 W8-H). Every UI color literal that
// used to live in src/ui/*.js + scripts/ui_*_render.js now lives in that data
// file; this module is the only accessor.
//
// FAIL-LOUD doctrine: a missing role/field THROWS naming the path — there are
// NO fallback literals here (the `?? '#hex'` pattern is exactly what this
// slice removes). In the browser the fetch happens at MODULE INIT (top-level
// await): the whole ES-module graph that imports any UI screen blocks until
// the theme is in hand, so sync render paths (scoreboard/menu) read it
// synchronously. In node (unit tests) the file is read from disk via
// import.meta.url — same data, same accessors.

let THEME = null

if (typeof document !== 'undefined') {
  // Browser: fetch relative to the GAME page base (same rule as src/data/load.js).
  const res = await fetch(new URL('data/ui-theme.json', document.baseURI), { cache: 'no-cache' })
  if (!res.ok) {
    console.error(`[ui-theme] fetch failed for data/ui-theme.json (${res.status}) — UI palette unavailable`)
    throw new Error(`[ui-theme] missing data/ui-theme.json: HTTP ${res.status}`)
  }
  THEME = await res.json()
} else {
  // Node (unit tests): read the same file straight off disk.
  const { readFileSync } = await import('node:fs')
  THEME = JSON.parse(readFileSync(new URL('../../data/ui-theme.json', import.meta.url), 'utf8'))
}

function fail(msg) {
  console.error(`[ui-theme] ${msg} — fix data/ui-theme.json (fail-loud: no fallbacks)`)
  throw new Error(`[ui-theme] ${msg}`)
}

/** Raw fail-loud lookup: 'panels.sheetBg' -> value; missing path THROWS. */
export function themeValue(path) {
  let node = THEME
  for (const k of path.split('.')) {
    if (node == null || typeof node !== 'object' || !(k in node)) {
      fail(`missing theme field "${path}"`)
    }
    node = node[k]
  }
  return node
}

/** Color lookup: like themeValue but asserts a string (a paint value). */
export function themeColor(path) {
  const v = themeValue(path)
  if (typeof v !== 'string') fail(`theme field "${path}" is ${typeof v}, not a color string`)
  return v
}
