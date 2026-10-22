/**
 * keyframe-tracks — centralized plain-track → THREE.KeyframeTrack conversion.
 *
 * THE #1 SILENT CRASH in hand-written character assembly: `retargetClip` returns
 * a clip whose tracks are PLAIN data (`{ name, times, values }`), but the
 * renderer's AnimationMixer requires real `THREE.KeyframeTrack` subclasses —
 * feeding plain tracks throws `tracks[i].createInterpolant is not a function`
 * at runtime. Every game used to re-implement this conversion in its own
 * `main.js`; `buildAnimator` centralizes it here.
 *
 * The track subclass is chosen by the property suffix:
 *   `.quaternion`  → `THREE.QuaternionKeyframeTrack`
 *   `.position`    → `THREE.VectorKeyframeTrack`
 *   `.scale`       → `THREE.VectorKeyframeTrack`
 * Any other suffix is dropped (a track we can't interpret can't animate).
 *
 * Node-testable (no DOM): imports THREE classes that work under Node/vitest.
 */

import * as THREE from 'three'

/** Pick the THREE.KeyframeTrack subclass for a track property suffix. */
export function trackClassFor(property) {
  if (property === 'quaternion') return THREE.QuaternionKeyframeTrack
  if (property === 'position' || property === 'scale') return THREE.VectorKeyframeTrack
  return null
}

/**
 * Convert ONE plain retarget track into a real KeyframeTrack (or null when its
 * property suffix is not animatable). Copies times/values; preserves
 * interpolation.
 * @param {{ name: string, times: number[], values: ArrayLike<number>, interpolation?: number }} track
 * @returns {THREE.KeyframeTrack|null}
 */
export function toKeyframeTrack(track) {
  if (!track || typeof track.name !== 'string') return null
  const prop = track.name.slice(track.name.lastIndexOf('.') + 1)
  const Cls = trackClassFor(prop)
  if (!Cls) return null
  const out = new Cls(track.name, track.times.slice(), Array.from(track.values))
  if (track.interpolation !== undefined) out.setInterpolation(track.interpolation)
  return out
}

/**
 * Convert a `retargetClip`-style clip (PLAIN tracks) into a real
 * `THREE.AnimationClip` with KeyframeTrack subclasses. Unanimatable tracks are
 * dropped. Never mutates the input clip.
 * @param {{ name?: string, duration: number, tracks: Array }} clip  plain clip
 * @param {string} [name]  override the output clip name (defaults to clip.name)
 * @returns {THREE.AnimationClip}
 */
export function toKeyframeTracks(clip, name) {
  const tracks = ((clip && clip.tracks) || [])
    .map(toKeyframeTrack)
    .filter(Boolean)
  const out = new THREE.AnimationClip(name || (clip && clip.name) || '', clip ? clip.duration : 0, tracks)
  out.userData = { retargeted: true, from: clip && clip.name }
  return out
}
