/**
 * WebAudio buses: music / SFX / ambience, plus pooled SFX sources.
 *
 * The system is written against a minimal AudioContext interface so it runs in
 * the browser (real WebAudio) and in Node (an injected mock). The three buses
 * are separate GainNodes routed to the destination, so each can be muted/set
 * independently (e.g. music down, ambience up).
 *
 * SFX playback uses a Pool of BufferSource nodes to avoid per-shot allocation.
 * Music/ambience are looped, single-stream buses.
 */
import { Pool } from '../core/pool.js'

const BUS_DEFS = {
  music: { gain: 0.6 },
  sfx: { gain: 0.9 },
  ambience: { gain: 0.4 },
}

export class AudioSystem {
  /**
   * @param {object} opts
   * @param {object} opts.context   an AudioContext-like ({ createGain, createBufferSource, destination })
   * @param {number} [opts.sfxPoolSize=16]
   * @param {object} [opts.busGains]   per-bus initial gain overrides
   */
  constructor({ context, sfxPoolSize = 16, busGains = {} } = {}) {
    if (!context || typeof context.createGain !== 'function') {
      throw new TypeError('AudioSystem requires an AudioContext-like `context`')
    }
    this.context = context
    this.buses = {}
    this._sfxPool = null
    this._tracks = new Map() // busName -> { source, buffer }
    this._enabled = true

    for (const [name, def] of Object.entries(BUS_DEFS)) {
      const gain = context.createGain()
      const gainValue = busGains[name] ?? def.gain
      gain.gain.value = gainValue
      gain.connect(context.destination)
      this.buses[name] = { gainNode: gain, gain: gainValue }
    }

    this._sfxPool = new Pool({
      initial: sfxPoolSize,
      create: () => {
        const source = context.createBufferSource()
        source.connect(this.buses.sfx.gainNode)
        return source
      },
      reset: (source) => {
        try { source.stop() } catch { /* not started */ }
        source.buffer = null
      },
      onAcquire: (source) => {
        source.onended = null
      },
    })
  }

  /** Master on/off. Muting pauses; unmuting resumes in place. */
  setEnabled(enabled) {
    this._enabled = enabled
    for (const { gainNode, gain } of Object.values(this.buses)) {
      gainNode.gain.value = enabled ? gain : 0
    }
  }

  /** Set a bus's gain (0..1). */
  setBusGain(name, value) {
    if (!this.buses[name]) throw new Error(`unknown bus: ${name}`)
    this.buses[name].gain = value
    this.buses[name].gainNode.gain.value = this._enabled ? value : 0
  }

  /** Load a decoded AudioBuffer into a music/ambience loop on a bus. */
  playLoop(busName, buffer, { loop = true } = {}) {
    const bus = this.buses[busName]
    if (!bus || busName === 'sfx') {
      throw new Error(`playLoop: not a loop bus: ${busName}`)
    }
    const existing = this._tracks.get(busName)
    if (existing) {
      try { existing.source.stop() } catch { /* stopped */ }
    }
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.loop = loop
    source.connect(bus.gainNode)
    source.start()
    this._tracks.set(busName, { source, buffer })
    return source
  }

  /**
   * Play a one-shot sound on the sfx bus through the pool.
   * @param {AudioBuffer} buffer  decoded sound
   * @param {{ volume?: number, rate?: number }} [opts]
   * @returns {object} { source, stop() } — stop returns the source to the pool.
   */
  playSound(buffer, { volume = 1, rate = 1 } = {}) {
    if (!buffer) throw new TypeError('playSound requires an AudioBuffer')
    const source = this._sfxPool.acquire()
    source.buffer = buffer
    source.playbackRate.value = rate
    source.onended = () => this._sfxPool.release(source)
    try {
      source.start()
    } catch {
      this._sfxPool.release(source)
      throw new Error('playSound failed to start source')
    }
    return {
      source,
      stop() {
        try { source.stop() } catch { /* stopped */ }
      },
    }
  }

  /** Stop and clear a loop bus. */
  stopLoop(busName) {
    const track = this._tracks.get(busName)
    if (!track) return
    try { track.source.stop() } catch { /* stopped */ }
    this._tracks.delete(busName)
  }

  /** Stop all loops (music + ambience). SFX one-shots finish on their own. */
  stopAllLoops() {
    for (const name of [...this._tracks.keys()]) this.stopLoop(name)
  }
}
