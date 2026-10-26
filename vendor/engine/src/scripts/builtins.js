/**
 * Engine built-in gameplay tools: camera rig + audio emitter.
 *
 * These are the two universal per-entity "tools" (see plans/TOOLS-CAMERA-AUDIO.md):
 * registered gameplay scripts that work in the editor and any shipped game that
 * passes the matching handles. They are auto-registered by `createGame` and
 * exported from the engine facade, so no game needs to copy them.
 *
 * Access model:
 *  - `camera-rig` reads `api.camera` ({ setPreset, setFocus, setActive }) if the
 *    host wired one (typically wrapping the engine Renderer). Absent -> warn +
 *    no-op, exactly like an unregistered script.
 *  - `audio-emitter` reads `api.audio` ({ has, play, playLoop, stopLoop,
 *    stopAllLoops, setEnabled }) if wired. Absent -> warn + no-op.
 *
 * Both are pure data + closure state; no DOM / no Three import, so fully
 * unit-testable in Node.
 */
import { CAMERA_PRESETS } from '../render/camera.js'
import { flockScript } from './flock.js'
import { cloudScript } from './volumetric-cloud.js'
import { unitMoveScript } from './unit-move.js'
import { navAgentScript, resetNavAgentState } from './nav-agent.js'

// Scene-load reset for the nav-agent separation registry — mirror of
// resetEmitterState below (resetNavAgentState lives in nav-agent.js).
export { resetNavAgentState }

const log = { warn: (m) => console.warn(m) }

/** Module-level id of the currently active camera rig (null = none yet). */
let activeRigId = null

/** Per-entity audio-emitter playback state: id -> { started, stop }. */
const emitterState = new Map()

/** Per-entity last-warned unknown camera-rig mode: id -> mode string. */
const unknownModeWarned = new Map()

/** Reset rig selection (used on scene load so a stale id never stays active). */
export function resetActiveRig() {
  activeRigId = null
}

/** Reset per-entity emitter playback state (used on scene load to avoid leaks). */
export function resetEmitterState() {
  emitterState.clear()
}

/** Reset camera-rig unknown-mode warn dedup (used on scene load). */
export function resetUnknownModeWarnings() {
  unknownModeWarned.clear()
}

/**
 * `camera-rig` — a data-driven camera. Attach to a (usually empty) entity and
 * give it `mode` + focus + placement params. On each fixed step the ACTIVE rig
 * drives `api.camera.setPreset(...)`; the renderer's existing preset math then
 * places the camera. `active:true` promotes this rig; otherwise the first rig
 * seen claims active. An unknown `mode` is a no-op; it warns only when the
 * (entity, mode) pair changes, not on every step.
 */
export const cameraRigScript = {
  params: {
    mode: { type: 'string', default: 'third-person-follow' },
    focus: { type: 'string' },
    active: { type: 'boolean', default: false },
    distance: { type: 'number', default: 4 },
    height: { type: 'number', default: 2.2 },
    yaw: { type: 'number', default: 0 },
    radius: { type: 'number', default: 5 },
    theta: { type: 'number', default: 0 },
    phi: { type: 'number', default: Math.PI / 2 },
    eyeHeight: { type: 'number', default: 1.6 },
    pitch: { type: 'number', default: 0 },
    fov: { type: 'number', default: 60 },
  },
  onAttach(id, params) {
    if (activeRigId === null) activeRigId = id
  },
  update(dt, api, id, p) {
    if (!api.camera) return // no camera handle wired -> no-op
    if (p.active === true) activeRigId = id
    else if (activeRigId === null) activeRigId = id
    if (activeRigId !== id) return // only the active rig drives the camera
    if (CAMERA_PRESETS.indexOf(p.mode) < 0) {
      if (unknownModeWarned.get(id) !== p.mode) {
        unknownModeWarned.set(id, p.mode)
        log.warn(`[camera-rig] unknown mode "${p.mode}" — no-op (entity "${id}")`)
      }
      return
    }
    if (typeof api.camera.setActive === 'function') api.camera.setActive(id)
    if (typeof api.camera.setFocus === 'function' && p.focus) api.camera.setFocus(p.focus)
    if (typeof api.camera.setPreset === 'function') {
      api.camera.setPreset(p.mode, {
        focus: p.focus,
        distance: p.distance,
        height: p.height,
        yaw: p.yaw,
        radius: p.radius,
        theta: p.theta,
        phi: p.phi,
        eyeHeight: p.eyeHeight,
        pitch: p.pitch,
        fov: p.fov,
      })
    }
  },
  onDetach(id) {
    if (activeRigId === id) activeRigId = null
    unknownModeWarned.delete(id)
  },
}

/**
 * `audio-emitter` — makes an entity a triggerable, configurable sound source.
 * `trigger: 'onSpawn'` plays on attach; `trigger: 'manual'` waits for another
 * script to call `api.audio.play(clip, ...)` (e.g. footsteps on collision).
 * Loop buses (music/ambience) stop on detach; one-shots finish on their own.
 */
export const audioEmitterScript = {
  params: {
    // `clip` is optional: when omitted, the emitter plays the entity's `audio`
    // component `src` (the data-driven `audio` component drives the emitter).
    clip: { type: 'string', default: '' },
    bus: { type: 'string', default: 'sfx' }, // sfx | music | ambience
    loop: { type: 'boolean', default: false },
    volume: { type: 'number', default: 1 },
    trigger: { type: 'string', default: 'onSpawn' }, // onSpawn | manual
  },
  onAttach(id) {
    if (!emitterState.has(id)) emitterState.set(id, { started: false, stop: null })
  },
  update(dt, api, id, p) {
    const st = emitterState.get(id)
    if (!st) return
    if (!api.audio) return // no audio handle wired -> no-op
    if (p.trigger === 'onSpawn' && !st.started) {
      st.started = true
      st.stop = startEmitter(api.audio, resolveEmitterParams(api, id, p))
    }
  },
  onDetach(id) {
    const st = emitterState.get(id)
    if (st && typeof st.stop === 'function') {
      try { st.stop() } catch { /* stop best-effort */ }
    }
    emitterState.delete(id)
  },
}

/**
 * Resolve the effective emitter params from an entity's `audio` COMPONENT when
 * the script doesn't declare its own `clip`. This is what makes the data-driven
 * `audio` component (`{ src, loop, volume }`) actually drive the `audio-emitter`
 * script: an entity carrying both plays its component's `src` through the
 * emitter on spawn. The component's `loop`/`volume` feed the emitter when the
 * script params aren't set. A script with an explicit `clip` always wins.
 */
export function resolveEmitterParams(api, id, p) {
  const positional = readPositional(api, id)
  if (p.clip) return positional ? { ...p, positional } : p
  const rec = api && typeof api.entity === 'function' ? api.entity(id) : null
  const audio = rec && rec.components && rec.components.audio
  if (!audio || !audio.src) return positional ? { ...p, positional } : p
  const loop = p.loop === true ? true : audio.loop === true
  // A looping audio component has no bus concept; route it to a loop bus
  // (music) so playLoop succeeds. One-shots use the script bus (sfx default).
  const bus = loop && (!p.bus || p.bus === 'sfx') ? 'music' : p.bus
  return {
    ...p,
    clip: audio.src,
    loop,
    bus,
    volume: audio.volume != null ? audio.volume : p.volume,
    ...(positional ? { positional } : {}),
  }
}

/**
 * Read the entity's `positionalAudio` component and return its spatialization
 * params object, or null when the component is absent or disabled. The emitter
 * attaches these to `opts.positional` so a duck-typed `api.audio` handle can
 * wire THREE.PositionalAudio — a handle without positional support simply
 * ignores them (fail-soft; the emitter still plays).
 */
function readPositional(api, id) {
  const rec = api && typeof api.entity === 'function' ? api.entity(id) : null
  const pa = rec && rec.components && rec.components.positionalAudio
  if (!pa || pa.enabled === false) return null
  return {
    distanceModel: pa.distanceModel,
    refDistance: pa.refDistance,
    maxDistance: pa.maxDistance,
    rolloffFactor: pa.rolloffFactor,
    innerRadius: pa.innerRadius,
    outerRadius: pa.outerRadius,
    outerGain: pa.outerGain,
  }
}

/**
 * Start an emitter through an api.audio handle. Returns a stop() for looping
 * emitters (stopping the bus); one-shots stop themselves and return a no-op.
 * `opts.positional` (from the entity's `positionalAudio` component) is attached
 * when present — the HOST wires THREE.PositionalAudio from it when available; a
 * handle with no positional support ignores it (duck-typed, fail-soft).
 */
export function startEmitter(audio, p) {
  const clip = p.clip
  if (!clip) return null
  if (typeof audio.has === 'function' && !audio.has(clip)) {
    log.warn(`[audio-emitter] unknown clip "${clip}" — no-op`)
    return null
  }
  const opts = { volume: p.volume, bus: p.bus }
  if (p.positional) opts.positional = p.positional
  const isLoop = p.loop === true || p.bus === 'music' || p.bus === 'ambience'
  if (isLoop) {
    try {
      if (typeof audio.playLoop === 'function') audio.playLoop(clip, opts)
    } catch (err) {
      log.warn(`[audio-emitter] playLoop failed: ${err && err.message || err}`)
      return null
    }
    const bus = p.bus
    return () => { if (typeof audio.stopLoop === 'function') audio.stopLoop(bus) }
  }
  try {
    if (typeof audio.play === 'function') audio.play(clip, opts)
  } catch (err) {
    log.warn(`[audio-emitter] play failed: ${err && err.message || err}`)
    return null
  }
  return () => {} // one-shot finishes on its own
}

/**
 * `anim-events` — declarative audio consumer for animation EVENTS (AN1).
 * The Renderer pushes each clip-event crossing into the game's per-entity
 * pending queue; this script DRAINS it on every fixed step and maps each
 * event name to a sound via `params.map`:
 *
 *   scripts: [{ name: 'anim-events', params: { map: {
 *     footstep: { sound: 'sfx/footstep', bus: 'sfx' },
 *   } } }]
 *
 * Unknown names (or a missing `map` entry) are a SILENT no-op — the crossing
 * was fired, the mapping decides what consumes it. Requires an `api.audio`
 * handle + the `api.animEvents` plumbing (both absent -> no-op). An entity
 * WITHOUT this script still fires api.onAnimEvent handlers; this script is
 * only the declarative audio route.
 */
export const animEventsScript = {
  params: {
    // eventName -> { sound, bus? }. The bus is advisory: one-shot sfx sounds
    // play through api.audio.play; music/ambience buses route as loops.
    map: { type: 'object', default: {} },
  },
  update(dt, api, id, p) {
    if (!api.animEvents || typeof api.animEvents.take !== 'function') return
    const events = api.animEvents.take(id)
    if (!events || events.length === 0) return
    if (!api.audio) return // no audio handle wired -> no-op
    const map = p && typeof p.map === 'object' && p.map ? p.map : {}
    for (const ev of events) {
      const route = map[ev.name]
      if (!route || !route.sound) continue // unmapped event: silent no-op
      const bus = route.bus || 'sfx'
      const isLoop = bus === 'music' || bus === 'ambience'
      try {
        if (isLoop && typeof api.audio.playLoop === 'function') {
          // Loop buses (music/ambience) start a stream (idempotent per bus).
          if (typeof api.audio.has === 'function' && !api.audio.has(route.sound)) {
            log.warn(`[anim-events] unknown sound "${route.sound}" — no-op`)
            continue
          }
          api.audio.playLoop(route.sound, { bus })
        } else if (typeof api.audio.play === 'function') {
          if (typeof api.audio.has === 'function' && !api.audio.has(route.sound)) {
            log.warn(`[anim-events] unknown sound "${route.sound}" — no-op`)
            continue
          }
          api.audio.play(route.sound, { bus })
        }
      } catch (err) {
        log.warn(`[anim-events] play failed: ${err && err.message || err}`)
      }
    }
  },
}

/** All engine built-in gameplay tools, keyed by script name. */
export const BUILTIN_SCRIPTS = {
  'camera-rig': cameraRigScript,
  'audio-emitter': audioEmitterScript,
  'flock': flockScript,
  'volumetric-cloud': cloudScript,
  'anim-events': animEventsScript,
  'unit-move': unitMoveScript,
  'nav-agent': navAgentScript,
}

/** Metadata for the editor's Script picker (mirror the folder-script shape). */
export const BUILTIN_SCRIPT_METAS = [
  {
    name: 'camera-rig',
    label: 'Camera rig',
    description: 'Data-driven camera: mode, focus target, distance/height/angles. The active rig drives the view.',
    params: cameraRigScript.params,
  },
  {
    name: 'audio-emitter',
    label: 'Audio emitter',
    description: 'Turn an entity into a triggerable sound source (clip, bus, loop, volume; onSpawn or manual).',
    params: audioEmitterScript.params,
  },
  {
    name: 'flock',
    label: 'Flock (region boids)',
    description: 'Turn a GameObject into a flock region: spawns fish children and drives them with boids inside a box/cylinder/sphere/custom volume. Edit shape, size, count, model + weights here.',
    params: flockScript.params,
  },
  {
    name: 'volumetric-cloud',
    label: 'Volumetric clouds (region)',
    description: 'Turn a GameObject into a volumetric cloud region: a pure container (sizeX/Y/Z box of sky — no collider) driving deterministic drift, coverage→density shaping, lit/shade scatter colors and quality tiers for one raymarched cloud mesh. Edit density, coverage, colors, drift + quality here.',
    params: cloudScript.params,
  },
  {
    name: 'anim-events',
    label: 'Animation events',
    description: 'Map animation clip events to sounds: eventName -> { sound, bus }. The renderer fires clip events (within the playback start/end trim) each step; this script plays the mapped sound. Unmapped events stay silent.',
    params: animEventsScript.params,
  },
  {
    name: 'unit-move',
    label: 'Unit move',
    description: 'The movement primitive: move the entity toward a world XZ point at a speed, stopping on the arrive ring (never overshoots). nav-agent composes this.',
    params: unitMoveScript.params,
  },
  {
    name: 'nav-agent',
    label: 'Nav agent',
    description: 'Compat shim — prefer the nav-agent component. Waypoint-following movement over the nav grid: steer to a destination or track a follow entity via findPath (deterministic re-pathing), with optional agent separation. Needs api.nav.',
    params: navAgentScript.params,
  },
]
