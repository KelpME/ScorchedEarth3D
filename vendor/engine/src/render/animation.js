/**
 * Minimal animation helpers — pure clip-selection + option normalization
 * (FOUNDATION-PLAN §12 B9.5).
 *
 * This module drives the single-clip `playback` component model:
 *   { clip: string, loop?, playbackRate?, playing?, fade? }
 *
 * It is deliberately free of any `three` import so it runs and unit-tests
 * under Node/vitest. The browser-bound `Renderer` (renderer.js) consumes these
 * helpers to drive its per-entity `AnimationMixer`.
 *
 * No state machines, no auto-transitions, no blend trees, no controllers.
 * Only explicit `api.playAnimation(entityId, clipName, ...)` / `stopAnimation`
 * calls drive a clip change.
 */

/** Default cross-fade (seconds) used when `playAnimation` omits fadeDuration. */
export const DEFAULT_FADE = 0.15

/**
 * Resolve a clip name against the clips actually available on a model.
 * Returns the clip name unchanged when it is a non-empty string that is
 * present in `availableClipNames`; otherwise `null` so a missing/unknown clip
 * can warn + no-op (never throw).
 * @param {string|null|undefined} clipName  the requested clip name.
 * @param {string[]} [availableClipNames]   clip names present on the model.
 * @returns {string|null} the resolved clip name, or null if missing/unknown.
 */
export function resolveClip(clipName, availableClipNames) {
  if (typeof clipName !== 'string' || clipName === '') return null
  if (!Array.isArray(availableClipNames)) return null
  if (!availableClipNames.includes(clipName)) return null
  return clipName
}

/**
 * Apply defaults to animation options (used by `api.playAnimation`).
 * @param {{ loop?: boolean, playbackRate?: number, fadeDuration?: number }} [opts]
 * @returns {{ loop: boolean, playbackRate: number, fadeDuration: number }}
 *   `loop` default true, `playbackRate` default 1, `fadeDuration` default
 *   DEFAULT_FADE (0.15). Explicit values are honored — including an explicit
 *   `fadeDuration: 0` for a hard cut.
 */
export function normalizeAnimOptions({ loop, playbackRate, fadeDuration } = {}) {
  return {
    loop: loop !== undefined ? Boolean(loop) : true,
    playbackRate: playbackRate !== undefined ? Number(playbackRate) : 1,
    fadeDuration: fadeDuration !== undefined ? Number(fadeDuration) : DEFAULT_FADE,
  }
}

/**
 * True once a fading-out action's weight has reached ~0, i.e. its fade-out
 * (the old-clip side of a true crossfade) has completed and the renderer can
 * stop + drop it from its in-flight list. The AnimationMixer clamps weights to
 * [0, 1], so this is a small-tolerance check against the floor. Pure (no Three.js
 * import) so it unit-tests under Node.
 * @param {number} weight     a THREE.AnimationAction.weight (0..1).
 * @param {number} [epsilon]  tolerance below which the weight counts as done.
 * @returns {boolean} true when the fade-out is complete.
 */
export function fadeOutComplete(weight, epsilon = 1e-3) {
  return typeof weight === 'number' && weight <= epsilon
}

/**
 * Validate a `playback` sub-range TRIM (`playback.start` / `playback.end`,
 * both optional numbers in CLIP time, seconds) against a clip duration.
 * Returns the effective `{ start, end }` range the renderer plays the clip
 * within. Missing or invalid fields fall back to the FULL clip
 * (`{ start: 0, end: duration }` — the exact pre-trim behavior, zero
 * migration). An `end` that exceeds `duration` only by float noise is
 * clamped to `duration`; anything genuinely out of range
 * (`start < 0`, `start >= end`, `end > duration` beyond tolerance) is
 * rejected wholesale in favor of the full range. Pure (no Three import).
 * @param {{ start?: number, end?: number }} [playback] the playback component.
 * @param {number} duration  the clip's duration (seconds).
 * @returns {{ start: number, end: number }}
 */
export function clampAnimRange(playback, duration) {
  const dur = typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    ? duration
    : 0
  const p = playback || {}
  const start = typeof p.start === 'number' ? p.start : NaN
  const end = typeof p.end === 'number' ? p.end : NaN
  // Anything not a finite number -> the whole trim is absent -> full range.
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { start: 0, end: dur }
  // An end slightly past the clip end is float noise from authoring — clamp it.
  const clampedEnd = end > dur && end - dur <= 1e-6 ? dur : end
  if (start < 0 || start >= clampedEnd || clampedEnd > dur) return { start: 0, end: dur }
  return { start, end: clampedEnd }
}

/**
 * Pure trim WRAP (AN1 fix, foreman-probed edge): map an arbitrary playhead
 * position into `[start, end)` for a LOOPING action. JS `%` keeps the sign of
 * the dividend, so the naive `start + ((t - start) % span)` formula produces
 * out-of-range values whenever three's own full-clip wrap fires within one
 * step (lag spike / high playbackRate × large dt) and lands the playhead
 * BELOW `start` — the next frame then re-derives the same wrong value forever
 * (playhead frozen outside the trim, events dead). Normalizing the offset
 * first (`((x % span) + span) % span`) fixes every input, including negatives
 * and multi-span overshoot.
 *
 * @param {number} t  the action's clip time after the mixer advanced.
 * @param {{ start: number, end: number }} range  the validated play range.
 * @returns {number} the wrapped time, always within [start, end).
 */
export function wrapInRange(t, range) {
  const span = range.end - range.start
  const offset = ((t - range.start) % span + span) % span
  return range.start + offset
}

/**
 * Pure crossing test for animation EVENTS: given a clip's event list
 * (`[{ t, name }]`, t in clip seconds), the action's previous and current
 * time (in the SAME clip-time space as `range`), the validated play range
 * (`clampAnimRange`'s `{ start, end }`), and whether the clip LOOPS, return
 * the events crossed moving forward from `prevTime` to `nowTime` as
 * `[{ name, t }]` sorted by t (each event fires AT MOST ONCE per pass).
 *
 * Semantics:
 * - `nowTime === prevTime` (paused / zero dt / scrub-in-place) -> `[]`: the
 *   paused/scrub guarantee falls out of the math, no special-casing.
 * - Inclusive at `now`, half-open at `prev`: landing exactly on an event's t
 *   fires it; an event exactly at the prev boundary does not re-fire.
 * - One large dt stepping past several events fires EACH ONCE, in t order.
 * - Events OUTSIDE `[range.start, range.end)` never fire — a trimmed range
 *   plays a sub-section of the clip, so its events outside the trim are
 *   authored-but-unreachable while trimmed.
 * - LOOP WRAP (three's LoopRepeat wrapped past the clip end, `now < prev`):
 *   treated as a forward pass `prev -> range.end` followed by
 *   `range.start -> now`, so events near the clip end AND events near the
 *   clip start fire on the wrap, and the cursor RE-ARMS each loop pass
 *   (the same event fires again on every pass). Only when `loop` is true.
 *
 * @param {Array<{t: number, name: string}>} [events]
 * @param {number} prevTime  the action's clip time BEFORE this step advanced.
 * @param {number} nowTime   the action's clip time AFTER this step advanced.
 * @param {{ start: number, end: number }} range  the validated play range.
 * @param {boolean} loop  whether the action is looping (LoopRepeat).
 * @returns {Array<{ name: string, t: number }>} crossings in t order.
 */
export function crossedEvents(events, prevTime, nowTime, range, loop) {
  if (!Array.isArray(events) || events.length === 0) return []
  if (nowTime === prevTime) return [] // paused / no advance: fire nothing
  const start = range.start
  const end = range.end
  const fireInWindow = (from, to, fromInclusive = false) => {
    if (!(to > from)) return []
    const aboveFrom = fromInclusive
      ? (t) => t >= from
      : (t) => t > from
    return events
      .filter((ev) => ev && Number.isFinite(ev.t) && aboveFrom(ev.t) && ev.t <= to && ev.t >= start && ev.t < end)
      .map((ev) => ({ name: ev.name, t: ev.t }))
  }
  let crossed
  if (loop && nowTime < prevTime) {
    // Wrapped: prev -> end, then re-arm -> start -> now. The head window is
    // INCLUSIVE at start: the playhead touches `start` at the wrap instant,
    // so an event authored exactly at the trim start fires every pass.
    crossed = [...fireInWindow(prevTime, end), ...fireInWindow(start, nowTime, true)]
  } else {
    crossed = fireInWindow(prevTime, nowTime)
  }
  crossed.sort((a, b) => a.t - b.t)
  return crossed
}
