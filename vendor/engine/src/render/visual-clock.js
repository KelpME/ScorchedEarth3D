/**
 * Visual clock — derive the renderer's per-frame visual delta (mixer advance,
 * shader `time`) from the SIMULATION clock (`loop.time`), never from the
 * render-frame count.
 *
 * Why: the renderer used to advance visuals by `fixedDt` once per RENDER
 * frame. That silently created a second clock that only agrees with the
 * simulation at exactly 60 fps: at 30 fps animations ran at half speed, at
 * 144 Hz at 2.4x, and a PAUSED sim kept animating. Driving the visual delta
 * from `loop.time` makes visuals refresh-rate independent and gives pause
 * (dt = 0) and scrub/runOne (dt = fixedDt) the right behavior for free.
 * (FOUNDATION-PLAN.md §6: the fixed timestep is the authoritative clock.)
 *
 * Pure math — no renderer state — so it is unit-testable headlessly.
 *
 * @param {number|undefined} simTime      current `loop.time` (seconds), if a loop was passed.
 * @param {number|undefined} lastSimTime  the previous frame's simTime, if any.
 * @returns {{ dt: number, lastSimTime: number|undefined }}
 *   dt: seconds of visual time to advance this render frame.
 *   lastSimTime: the value to carry into the next frame.
 */
export function visualDelta(simTime, lastSimTime) {
  if (typeof simTime !== 'number' || !Number.isFinite(simTime)) {
    // No loop handle (bare render calls, e.g. isolated previews): legacy
    // one-fixed-step-per-frame behavior so standalone visuals still animate.
    return { dt: 1 / 60, lastSimTime }
  }
  if (typeof lastSimTime !== 'number' || !Number.isFinite(lastSimTime)) {
    // First render: sync the visual clock to the sim clock from 0, so total
    // visual time always equals loop.time (mixers on looping clips just land
    // at the same phase the sim says they should be at).
    return { dt: Math.max(0, simTime), lastSimTime: simTime }
  }
  if (simTime < lastSimTime) {
    // The loop was reset (scene load / scrub reset): resync without a jump.
    return { dt: 0, lastSimTime: simTime }
  }
  return { dt: simTime - lastSimTime, lastSimTime: simTime }
}
