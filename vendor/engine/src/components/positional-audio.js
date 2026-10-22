/**
 * Engine built-in component: `positionalAudio`.
 *
 * Declarative 3D spatialization surface for an entity — a spatialized sound
 * SOURCE. It rides ALONGSIDE an `audio` component (or the `audio-emitter`
 * script's own clip); it carries ONLY the spatialization params, never a clip
 * reference. The `audio-emitter` built-in reads it via `readPositional(api, id)`
 * and passes the params through the duck-typed `api.audio` handle as
 * `opts.positional`; the host wires `THREE.PositionalAudio` when available
 * (fail-soft: a handle with no positional support simply ignores it).
 *
 * Pure data schema — no behavior of its own.
 */

export const name = 'positionalAudio'

export const label = 'Positional Audio'

export const description = 'Declarative 3D spatialization for an audio source: distance attenuation + radius/gain. Rides alongside an `audio` component.'

export const params = {
  enabled: { type: 'boolean', default: true, description: 'Master on/off for this positional source' },
  distanceModel: { type: 'string', default: 'inverse', description: 'How attenuation falls off: none | linear | inverse | exponential' },
  refDistance: { type: 'number', default: 1, description: 'Reference distance (world units) at which volume is full' },
  maxDistance: { type: 'number', default: 100, description: 'Max distance (world units) beyond which volume stops falling' },
  rolloffFactor: { type: 'number', default: 1, description: 'Rolloff rate (distanceModel inverse/exponential)' },
  innerRadius: { type: 'number', default: 0, description: 'Inner radius (world units) of full volume (distanceModel none/linear)' },
  outerRadius: { type: 'number', default: 0, description: 'Outer radius (world units) beyond which volume is muted (0 = maxDistance)' },
  outerGain: { type: 'number', default: 0, description: 'Gain applied past outerRadius (0 = silent)' },
}

export default { name, label, description, params }
