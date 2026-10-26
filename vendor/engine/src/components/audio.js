/**
 * Engine built-in component: `audio`.
 *
 * An audio source reference (src / loop / volume) for the host to play. Drives
 * the engine AudioSystem preview in the editor and audio-emitter behaviors.
 */

export const name = 'audio'

export const label = 'Audio'

export const description = 'An audio source reference (src / loop / volume) for the host to play.'

export const params = {
  src: { type: 'string', default: '' },
  loop: { type: 'boolean', default: false },
  volume: { type: 'number', default: 1 },
}

export default { name, label, description, params }
