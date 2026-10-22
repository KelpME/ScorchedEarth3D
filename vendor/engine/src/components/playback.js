/**
 * Engine built-in component: `playback`.
 *
 * Plays a clip from the object's loaded model (clip / loop / playbackRate /
 * playing). Consumed by the engine Renderer's AnimationMixer.
 */

export const name = 'playback'

export const label = 'Playback'

export const description = 'Plays a clip from the object\'s loaded model (clip / loop / rate).'

export const params = {
  clip: { type: 'string' },
  loop: { type: 'boolean', default: true },
  playbackRate: { type: 'number', default: 1 },
  playing: { type: 'boolean', default: true },
  fade: { type: 'number', default: 0.15 },
}

export default { name, label, description, params }
