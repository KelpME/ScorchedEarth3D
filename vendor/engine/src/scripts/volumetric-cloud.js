/**
 * VOLUMETRIC-CLOUD — region script (pure container doctrine, flock mirror).
 * A volumetric-cloud region is a PURE CONTAINER: position-only transform
 * (scale ALWAYS identity), NO collider — the sizeX/Y/Z params are the ONE
 * size authority. The script owns data + lifecycle helpers only; the
 * fixed-step SYSTEM (systems/volumetric-cloud.js) is the simulation driver,
 * exactly like flock. Every number the region needs is a param below —
 * NOTHING HIDDEN. No game content literals in logic; the one hex per color
 * is a declared param default (data).
 */
export const cloudScript = {
  params: {
    // --- VOLUME (the one size authority; region = pure container) ---
    sizeX: { type: 'number', default: 200, label: 'Volume X (width)', min: 10 },
    sizeY: { type: 'number', default: 40, label: 'Volume Y (height)', min: 5 },
    sizeZ: { type: 'number', default: 200, label: 'Volume Z (depth)', min: 10 },
    // --- SHAPE OF THE CLOUDSCAPE (data-driven look, no JS literals) ---
    density: { type: 'number', default: 0.12, label: 'Density', min: 0, max: 1, step: 0.01 },
    coverage: { type: 'number', default: 0.45, label: 'Coverage (0-1)', min: 0, max: 1, step: 0.01 },
    noiseScale: { type: 'number', default: 0.015, label: 'Noise scale', min: 0.001, step: 0.001 },
    detailOctaves: { type: 'number', default: 3, label: 'Detail octaves', min: 1, max: 5, step: 1 },
    // --- LIGHT (lit scatter color; hex = data) ---
    litColor: { type: 'string', default: '#f2f4f8', label: 'Lit color (hex)' },
    shadeColor: { type: 'string', default: '#8a93a0', label: 'Shade color (hex)' },
    ambient: { type: 'number', default: 0.35, label: 'Ambient (0-1)', min: 0, max: 1, step: 0.01 },
    lightAzimuth: { type: 'number', default: 135, label: 'Light azimuth (deg)' },
    lightElevation: { type: 'number', default: 35, label: 'Light elevation (deg)' },
    // --- MOTION (deterministic; LCG-seeded per region by the system) ---
    driftSpeedX: { type: 'number', default: 1.2, label: 'Drift X (world u/s)' },
    driftSpeedZ: { type: 'number', default: 0.0, label: 'Drift Z (world u/s)' },
    // --- PERF TIERS (degrade is DATA — integrated-GPU budget) ---
    quality: { type: 'string', default: 'standard', label: 'Quality', options: ['draft', 'standard', 'high'] },
    qualityDraft: { type: 'number', default: 24, label: 'Draft march steps', min: 8, step: 1 },
    qualityStandard: { type: 'number', default: 48, label: 'Standard march steps', min: 8, step: 1 },
    qualityHigh: { type: 'number', default: 96, label: 'High march steps', min: 8, step: 1 },
    resolutionScale: { type: 'number', default: 0.5, label: 'Resolution scale (0-1)', min: 0.25, max: 1, step: 0.05 },
    // --- RENDERER (declared DATA: a game may DECLINE builtin rendering —
    // Scorched Earth drives its own slab renderer off the same params) ---
    renderer: { type: 'string', default: 'builtin', label: 'Renderer', options: ['builtin', 'none'], help: "builtin = engine raymarched mesh in the viewport/scrub; none = no builtin mesh (a game renders the region itself from these params)." },
    // --- SEAM for games (SE wind coupling folds its live wind in here) ---
    windCoupling: { type: 'number', default: 0.0, label: 'Wind coupling (0 = off)' },
  },
  onAttach(id) {
    // Per-region state map, mirror flockState: the system keeps drift offsets
    // keyed by region id; the script only declares the per-attach shape.
    if (!cloudScript._state) cloudScript._state = new Map()
    cloudScript._state.set(id, { ox: 0, oz: 0 })
  },
  // NOTE: no update() on the script — the SYSTEM is the fixed-step driver.
}

// mulberry-style LCG — same doctrine as SE weather.js lcg(); deterministic.
export function lcg(seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}

// Pure: drift offsets after one fixed step. wind (when windCoupling > 0) is
// the game's live wind {x,z}; it ADDS to the seeded drift — never an
// absolute wind*t term.
export function driftStep(ox, oz, p, wind, dt) {
  let nx = ox + p.driftSpeedX * dt, nz = oz + p.driftSpeedZ * dt
  if (wind && p.windCoupling > 0) { nx += (wind.x || 0) * p.windCoupling * dt; nz += (wind.z || 0) * p.windCoupling * dt }
  return { ox: nx, oz: nz }
}

// Pure: steps for the current quality tier — fail loud on unknown tier.
export function stepsFor(p) {
  const map = { draft: p.qualityDraft, standard: p.qualityStandard, high: p.qualityHigh }
  const n = map[p.quality]
  if (!Number.isFinite(n) || n <= 0) throw new Error(`volumetric-cloud: quality '${p.quality}' has no positive step count — fail loud`)
  return Math.round(n)
}

// Pure: coverage → density floor shaping (normalized 0..1) for the shader's
// coverage remap.
export function coverageRemap(coverage, sample) {
  const edge = Math.min(1 - 1e-4, 1 - Math.min(1, Math.max(0, coverage)))
  return Math.min(1, Math.max(0, (sample - edge) / Math.max(1e-4, 1 - edge)))
}

// Pure: resolve a region's params from EITHER load-bearing authoring form —
// the literal `volumetric-cloud` component (engine-seam form, game.test.js T4)
// or the `scripts` list entry (the EDITOR authors regions as scripts entries —
// the gizmo/inspector path). Null when this entity does not carry the script.
// A script carry WITHOUT params fails loud (never a silent skip). The returned
// params are a COPY default-filled from the declared script schema (the ONE
// defaults authority — editor-authored regions carry sparse params); raw live
// values always win, so inspector edits still flow through per frame.
export function cloudRegionParams(components) {
  if (!components || typeof components !== 'object') return null
  const comp = components['volumetric-cloud']
  let raw = null
  if (comp) {
    if (!comp.params) throw new Error(`volumetric-cloud: entity carries the script component without params — fail loud`)
    raw = comp.params
  } else {
    const list = Array.isArray(components.scripts) ? components.scripts : []
    for (const s of list) {
      if (s && s.name === 'volumetric-cloud') {
        if (!s.params) throw new Error(`volumetric-cloud: entity carries the script (scripts entry) without params — fail loud`)
        raw = s.params
        break
      }
    }
  }
  if (!raw) return null
  const out = { ...raw }
  for (const [k, spec] of Object.entries(cloudScript.params)) {
    if (out[k] === undefined && spec.default !== undefined) out[k] = spec.default
  }
  return out
}
