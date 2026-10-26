/**
 * telemetry/frame-profiler.js — tiny CPU frame-budget profiler (P1 of
 * plans/FRAME-BUDGET.md).
 *
 * Attributes per-frame CPU cost to NAMED buckets so the F4 overlay can name
 * the slow phases: the sim step total with per-system / per-script sub-timers
 * BY NAME, each named phase of Renderer.render(), the GPU submit/draw call,
 * and the frame total. Measurement tooling, not gameplay — it adds no
 * component and no game-side code.
 *
 * Cost model (the overhead contract): every hot-path call is a plain
 * `performance.now()` pair guarded by one `enabled` boolean check — NO
 * closures, NO per-frame allocations beyond the reused bucket maps. While
 * disabled (the default — the editor viewport, every game until the telemetry
 * overlay boots) begin/end/frameBegin/frameEnd are literal no-ops.
 *
 * Aggregation:
 *  - `begin/end` ACCUMULATE within the current frame (N entities running the
 *    same script name sum into one `sim.script.<name>` bucket).
 *  - When the frame folds (`frameEnd`, or the next `frameBegin` when the host
 *    skipped it) each bucket records `last` (this frame) and rolls a
 *    configurable-span EMA (`ema += alpha * (v - ema)`; the FIRST sample seeds
 *    the EMA directly so slow frames are visible immediately).
 *  - `snapshot()` sorts buckets by EMA ms and exposes a rolling top-offenders
 *    list — the only allocation-heavy call, meant for the overlay readout.
 *
 * Bucket naming (the exact set the F4 overlay shows):
 *   frame.total            one host frame (Game.step .. Game.frame)
 *   sim.step               fixed-step total (sums across catch-up steps)
 *   sim.onStep             the host onStep escape-hatch hook
 *   sim.system.<name>      each scene system's update(), by registered name
 *   sim.script.<name>      each entity script's update(), by registered name
 *   sim.physics            the rigid-body pipeline step
 *   render.<phase>         each named Renderer.render() phase:
 *     render.syncTerrain, render.resolveWorld, render.collect, render.syncLights,
 *     render.updateModelInstances, render.updateNodeScopes,
 *     render.updateModelBatches, render.updateBatches, render.updateSkinned,
 *     render.updateAnimations, render.applyCamera, render.resize,
 *     render.shaderTime, render.syncUi
 *   render.draw            GPU submit (renderer.render / post-FX composite)
 *   render.total           Renderer.render() wall total
 */

const DEFAULT_ALPHA = 2 / 31 // ~30-frame EMA span
const DEFAULT_TOP_N = 5

/**
 * Create a frame profiler. Tests inject `now`; production uses
 * `performance.now()`.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now]     clock (default performance.now).
 * @param {number} [opts.alpha=2/31]    EMA smoothing factor.
 * @param {number} [opts.topN=5]        top-offenders list length.
 * @returns {{
 *   enabled: boolean, setEnabled(on: boolean): void, reset(): void,
 *   begin(name: string): void, end(name: string): void,
 *   frameBegin(): void, frameEnd(): void,
 *   snapshot(): { frames: number, buckets: Array<{name, ema, last}>,
 *                 top: Array<{name, ema, last}>,
 *                 total: {ema, last}, sim: {ema, last}, render: {ema, last} }
 * }}
 */
export function createFrameProfiler({ now, alpha = DEFAULT_ALPHA, topN = DEFAULT_TOP_N } = {}) {
  const clock = now || (() => performance.now())

  let enabled = false
  let frames = 0
  let frameStart = null
  const open = new Map() // bucket -> start ms (begin/end pairing)
  const cur = new Map() // bucket -> accumulated ms this frame
  const ema = new Map() // bucket -> rolled EMA ms
  const last = new Map() // bucket -> last folded frame ms
  const seen = new Map() // bucket -> folded-frame count (first sample seeds EMA)

  function foldAt(t) {
    if (frameStart !== null) {
      cur.set('frame.total', (cur.get('frame.total') || 0) + Math.max(0, t - frameStart))
      frameStart = null
    }
    for (const [name, v] of cur) {
      last.set(name, v)
      if (seen.has(name)) ema.set(name, (ema.get(name) || 0) + alpha * (v - (ema.get(name) || 0)))
      else ema.set(name, v) // first sample seeds — no slow 0-convergence
      seen.set(name, (seen.get(name) || 0) + 1)
    }
    cur.clear()
    open.clear()
    frames += 1
  }

  return {
    get enabled() { return enabled },
    set enabled(v) { enabled = !!v },

    setEnabled(on) { enabled = !!on },

    reset() {
      frames = 0
      frameStart = null
      open.clear()
      cur.clear()
      ema.clear()
      last.clear()
      seen.clear()
    },

    begin(name) {
      if (!enabled) return
      open.set(name, clock())
    },

    end(name) {
      if (!enabled) return
      const t0 = open.get(name)
      if (t0 === undefined) return // tolerant: mid-frame enable / stray end
      open.delete(name)
      cur.set(name, (cur.get(name) || 0) + Math.max(0, clock() - t0))
    },

    frameBegin() {
      if (!enabled) return
      if (frameStart !== null) foldAt(clock()) // host skipped frameEnd — fold what we have
      frameStart = clock()
    },

    frameEnd() {
      if (!enabled) return
      if (frameStart === null) return
      foldAt(clock())
    },

    snapshot() {
      const stat = (name) => ({ ema: ema.get(name) || 0, last: last.get(name) || 0 })
      // frame.total is exposed as `total` (it would top every table) — the
      // bucket list carries only real attribution buckets, sorted by EMA ms.
      const buckets = [...ema.entries()]
        .filter(([name]) => name !== 'frame.total')
        .map(([name]) => ({ name, ...stat(name) }))
        .sort((a, b) => b.ema - a.ema || (a.name < b.name ? -1 : 1))
      return {
        frames,
        buckets,
        top: buckets.slice(0, topN),
        total: stat('frame.total'),
        sim: stat('sim.step'),
        render: stat('render.total'),
      }
    },
  }
}

/**
 * The engine-wide default profiler — the single instance Game._step,
 * Renderer.render(), runSystems/runScripts (wired via Game) and the telemetry
 * overlay all report into, so a booted game needs ZERO game-side wiring. Inert
 * (enabled=false) until something enables it — the telemetry overlay does.
 */
export const frameProfiler = createFrameProfiler()
