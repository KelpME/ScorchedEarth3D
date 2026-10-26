import { driftStep, stepsFor, cloudRegionParams } from '../scripts/volumetric-cloud.js'

/**
 * Volumetric Cloud — fixed-step system (mirror of systems/flock.js shape).
 *
 * For every entity carrying a `volumetric-cloud` script component: reconcile
 * params → drift state via the pure `driftStep` law (§3b, deterministic — no
 * Math.random, no wall clock), and publish a seam for the renderer module and
 * Playwright pins: `api.seams.volumetricCloud = { regions: [{ id, params, offsets }] }`
 * (the `window.__clouds` analog). No members, no transform writes — the region
 * is a pure container; the renderer module owns the pixels.
 */
export const cloudSystem = {
  name: 'volumetric-cloud',
  label: 'Volumetric clouds (region)',
  description: 'Fixed-step driver for every entity carrying a `volumetric-cloud` script: deterministic drift integration + params→seam reconcile for the raymarch renderer.',
  params: {},

  init(params) {
    this._p = params || {}
    this._offsets = new Map() // region id → { ox, oz } persistent drift state
  },

  update(dt, api) {
    const regions = []
    // Regions are authored in TWO load-bearing forms (see cloudRegionParams):
    // the literal component (engine tests) and the `scripts` list entry (the
    // editor's region tooling). Both reach the seam.
    const ids = new Set([
      ...api.query({ has: 'volumetric-cloud' }),
      ...api.query({ has: 'scripts' }),
    ])
    for (const id of ids) {
      const rec = api.entity(id)
      const p = rec ? cloudRegionParams(rec.components) : null
      if (!p) continue
      // Fail loud on an unusable quality tier before integrating (§5 coverage guarantee).
      stepsFor(p)

      let st = this._offsets.get(id)
      if (!st) { st = { ox: 0, oz: 0 }; this._offsets.set(id, st) }

      const wind = api.wind || null
      const next = driftStep(st.ox, st.oz, p, wind, dt)
      st.ox = next.ox
      st.oz = next.oz

      regions.push({ id, params: p, offsets: { ox: st.ox, oz: st.oz } })
    }

    const seam = { regions }
    if (api.seams) api.seams.volumetricCloud = seam
    if (typeof globalThis !== 'undefined') globalThis.__clouds = seam
    return seam
  },
}

/** Built-in cloud system registry entry: { 'volumetric-cloud': cloudSystem }. */
export const BUILTIN_CLOUD_SYSTEMS = { 'volumetric-cloud': cloudSystem }
