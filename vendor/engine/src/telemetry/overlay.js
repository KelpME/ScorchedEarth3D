/**
 * telemetry/overlay.js — in-game perf/scale telemetry overlay (backlog N).
 *
 * A toggleable live overlay for a RUNNING game (Test Scene) that makes the
 * engine's scale/perf data VISIBLE to the human while playing — active entities
 * (total + by type), fps, draw calls, and (optionally) entity-pool stats. This
 * is the scale gate made tangible: the headless spec proved ~500 entities,
 * this is how you SEE it in real gameplay.
 *
 * It is a genre-agnostic measurement TOOL, not entity data — so it adds no
 * engine-built-in component (the six-primitives rule is preserved). It mirrors
 * the precedent of `game.controller` (backlog K) + the built-in scripts
 * (`camera-rig`, `audio-emitter`) as a thin, genre-agnostic engine seam.
 *
 * Lives in the engine so EVERY game gets it without re-implementing. The game
 * constructs it with its own `api` (the game facade), its `renderer` (a
 * `Renderer` whose `.renderer.info.render` gives draw calls), and optionally a
 * `getPoolStats()` callback exposing its entity-pool readout.
 *
 * P1 frame-budget extension (plans/FRAME-BUDGET.md): the panel also shows a
 * CPU bucket table (frame total, sim-vs-render split, top buckets sorted by
 * ms) fed by the frame profiler (`telemetry/frame-profiler.js`) — the F4
 * readout NAMES the slow phases. F5 dumps that same readout to the console
 * (`console.log` — the built game's log-forward shim carries it to the
 * editor's Play Console). Both keys are swallowed with `preventDefault()`
 * (F5 is the browser reload key; F4 can trigger browser actions too).
 * Constructing the overlay ENABLES the given profiler (default: the
 * engine-wide `frameProfiler` that Game._step / Renderer.render report into —
 * still zero game-side code); `dispose()` turns it back off and clears it.
 */
import { frameProfiler } from './frame-profiler.js'

const DEFAULT_KEYS = { toggle: 'F4', dump: 'F5' }

/**
 * Test Scene auto-boot gate (backlog N): should a booted game auto-construct
 * the telemetry overlay from its URL? True ONLY for a Test Scene launch that
 * asked for telemetry — BOTH `scene` and `telemetry` URL params present and
 * telemetry not explicitly '0'. That is exactly the shape `editor/src/play.js`
 * sends (`?session=…&scene=scenes/<name>&telemetry=1`): the Options toggle OFF
 * OMITS `telemetry` (gate on the PARAM, not the game setting) and a full Play
 * launch has no `scene` param — so neither shows the overlay.
 *
 * @param {string|URLSearchParams} [search]  query string (default: location.search;
 *   '' in non-browser environments, so Node never boots an overlay by accident).
 * @returns {boolean}
 */
export function shouldBootTelemetry(search) {
  const q = search === undefined || search === null
    ? (typeof location !== 'undefined' && location ? location.search : '')
    : String(search)
  const params = new URLSearchParams(q)
  return params.has('scene') && params.has('telemetry') && params.get('telemetry') !== '0'
}

/**
 * Zero-game-code bootstrap: construct the overlay iff the URL gate passes
 * (see shouldBootTelemetry). Returns the overlay, or null when not a telemetry
 * Test Scene launch. `keys` defaults apply (F4 toggle, F5 console dump).
 */
export function bootTelemetryOverlay({ api, renderer, getPoolStats, root, keys, search } = {}) {
  if (!shouldBootTelemetry(search)) return null
  return createTelemetryOverlay({ api, renderer, getPoolStats, root, keys })
}

/** A no-op storage/DOM shim for non-DOM (Node test) environments. */
function makeEl(tag, cls) {
  const el = typeof document !== 'undefined' ? document.createElement(tag) : { style: {}, appendChild() {}, textContent: '' }
  if (cls) el.className = cls
  return el
}

/**
 * Create a telemetry overlay attached to the game page.
 * @param {object} opts
 * @param {object} opts.api        the game facade (query/entity).
 * @param {object} [opts.renderer] the game's Renderer (reads `.renderer.info.render`).
 * @param {Function} [opts.getPoolStats]  optional () => object of pool stats per pool.
 * @param {object} [opts.profiler] frame profiler to enable + read (default `frameProfiler`).
 * @param {HTMLElement} [opts.root]  DOM node to append to (default document.body).
 * @param {{toggle?:string, dump?:string, enabled?:boolean}} [opts.keys]
 *   key bindings (defaults `{ toggle: 'F4', dump: 'F5' }`); `dump: ''` disables
 *   the console dump key.
 * @returns {{ setVisible(v:boolean), getVisible():boolean, toggle():boolean,
 *             dump():void, read():object, render():void, dispose():void }}
 */
export function createTelemetryOverlay({ api, renderer, getPoolStats, profiler, root, keys } = {}) {
  const k = { ...DEFAULT_KEYS, ...(keys || {}) }
  let visible = keys && typeof keys.enabled === 'boolean' ? keys.enabled : true
  const prof = profiler || frameProfiler
  prof.setEnabled(true) // the overlay IS the profiling gate (zero game-side code)

  const el = makeEl('div', 'hf-telemetry-overlay')
  el.style.cssText = 'position:fixed;top:10px;left:10px;z-index:9999;padding:8px 10px;' +
    'background:rgba(0,0,0,.72);color:#9ff;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;' +
    'border-radius:4px;pointer-events:none;white-space:pre;display:' + (visible ? 'block' : 'none')
  el.textContent = 'telemetry…'
  ;(root || (typeof document !== 'undefined' ? document.body : null))?.appendChild(el)

  let last = 0
  let fps = 0

  /** Read a fresh telemetry sample. Pure read — never mutates game state. */
  function read() {
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (last > 0) {
      const dt = (now - last) / 1000
      if (dt > 0) fps = Math.round(1 / dt)
    }
    last = now

    const all = api && typeof api.query === 'function' ? api.query({}) : []
    const counts = { total: all.length }
    if (api && typeof api.query === 'function') {
      for (const id of all) {
        const rec = api.entity && api.entity(id)
        const comps = rec && rec.components
        if (!comps) continue
        for (const name of Object.keys(comps)) {
          if (name === 'transform' || name === 'render') continue // noise
          counts[name] = (counts[name] || 0) + 1
        }
      }
    }

    let draw = null
    if (renderer && renderer.renderer && renderer.renderer.info && renderer.renderer.info.render) {
      draw = renderer.renderer.info.render
    }

    let memory = null
    if (renderer && renderer.renderer && renderer.renderer.info && renderer.renderer.info.memory) {
      memory = renderer.renderer.info.memory
    }

    const pools = typeof getPoolStats === 'function' ? getPoolStats() : null

    return { fps, counts, draw, memory, pools, frame: prof.snapshot() }
  }

  /** Format a sample as the readout lines (panel text == console dump body). */
  function formatLines(s) {
    const lines = []
    lines.push(`fps ${s.fps}`)
    lines.push(`entities ${s.counts.total}`)
    for (const [name, n] of Object.entries(s.counts)) {
      if (name === 'total') continue
      lines.push(`  ${name} ${n}`)
    }
    if (s.draw) {
      lines.push(`draw ${s.draw.calls} · tris ${s.draw.triangles}`)
    }
    if (s.pools) {
      for (const [name, p] of Object.entries(s.pools)) {
        if (p && typeof p === 'object') {
          lines.push(`pool ${name} ${p.size ?? '?'}/${p.inUse ?? '?'} free ${p.free ?? '?'}`)
        }
      }
    }
    // P1 frame-budget block: frame total + sim-vs-render split (last frame),
    // then the top buckets sorted by ms (EMA), last-frame values alongside.
    const f = s.frame
    if (f && f.frames > 0) {
      lines.push(`frame ${f.total.last.toFixed(1)}ms · sim ${f.sim.last.toFixed(1)} · render ${f.render.last.toFixed(1)}`)
      lines.push('ema-last  bucket')
      for (const b of f.buckets.slice(0, 8)) {
        lines.push(`${b.ema.toFixed(1)}-${b.last.toFixed(1)}  ${b.name}`)
      }
    }
    return lines
  }

  /** Render the current sample into the DOM overlay. */
  function render() {
    el.textContent = formatLines(read()).join('\n')
  }

  /**
   * Dump the current readout to the console (F5) as one readable multi-line
   * entry — frame line + bucket rows (ema/last ms) + fps/entities/draws/tris.
   * The built game's log-forward shim (scripts/build-game.mjs LOG_SHIM)
   * forwards it to the editor's Play Console; no editor-side work needed.
   */
  function dump() {
    console.log(['telemetry — frame budget dump', ...formatLines(read())].join('\n'))
  }

  let raf = 0
  function tick() {
    if (visible) render()
    raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(tick) : 0
  }

  function setVisible(v) {
    visible = !!v
    el.style.display = visible ? 'block' : 'none'
  }
  function getVisible() { return visible }
  function toggle() { setVisible(!visible); return visible }

  function onKey(e) {
    if (!e || !e.key) return
    const key = e.key.toLowerCase()
    if (k.toggle && key === k.toggle.toLowerCase()) {
      e.preventDefault && e.preventDefault() // swallow: F4 can trigger browser actions
      toggle()
    } else if (k.dump && key === k.dump.toLowerCase()) {
      e.preventDefault && e.preventDefault() // swallow: F5 is the browser reload key
      dump()
    }
  }
  if (typeof document !== 'undefined') document.addEventListener('keydown', onKey)

  tick()

  return {
    setVisible,
    getVisible,
    toggle,
    dump,
    read,
    render,
    dispose() {
      if (typeof cancelAnimationFrame !== 'undefined' && raf) cancelAnimationFrame(raf)
      if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey)
      if (el.parentNode) el.parentNode.removeChild(el)
      prof.setEnabled(false)
      prof.reset()
    },
  }
}
