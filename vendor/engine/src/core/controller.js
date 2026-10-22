/**
 * game.controller — the first-class deterministic test/scrub seam (backlog K).
 *
 * Kills the hand-rolled `window.__director` / `__restart` / `__counts` /
 * `__game` glue that every game re-derived. A genre-agnostic controller surface
 * exposed on BOTH the Game (`game.controller`) and the runtime api
 * (`api.controller`), so scripted tests AND the editor scrub drive ONE
 * mechanism, not two.
 *
 * What it owns, split between engine-owned determinism and game-registered
 * hooks:
 *
 *   - loop determinism (engine-owned): pause()/resume()/isPaused(),
 *     step(dt) (a deterministic alias for game.step), stepCount, time.
 *   - run reset: onRunReset(fn) registers the game's full run-restart (clear
 *     runtime entities, restore the player, reset the director);
 *     reset() = clock reset + counter clear + the game's run-restart, and it
 *     resumes a paused loop (a "reset run" is by definition playable).
 *   - director control (game-registered): setDirector(handle) + the `director`
 *     getter — the game plugs its wave/spawn controller (the Object.assign'd
 *     onStep that carries pause/resume/reset/setWave/advance) into this slot so
 *     tests reach it through one surface.
 *   - deterministic sim ops: spawn(id, opts) and count(has) (active entity
 *     count by component — the old `window.__counts(has)`).
 *   - monotonic counters: counters.incr/set/get/has/reset for hits-taken,
 *     kills, spawns, etc. that a poll can safely assert without racing.
 *
 * Everything here is generic — no genre-shaped built-ins. The game plugs its
 * director + run-reset + counters into the slots; the engine owns the loop.
 */
export function createController({ game }) {
  const counters = new Map()

  const controller = {
    // ---- loop determinism (engine-owned) ----
    pause() { game._loop.pause() },
    resume() { game._loop.resume() },
    isPaused() { return game._loop.isPaused() },
    step(dt) { return game.step(dt) },
    // Advance exactly ONE fixed step regardless of pause — the editor-scrub
    // (backlog C) step-forward primitive.
    stepOnce() { game._loop.runOne() },
    get stepCount() { return game._loop.stepCount },
    get time() { return game._loop.time },
    resetClock() { game._loop.reset() },

    // ---- run reset (game-registered slot) ----
    onRunReset(fn) { game._runReset = typeof fn === 'function' ? fn : null },
    reset() {
      game._loop.reset()
      game._loop.resume()
      controller.counters.reset()
      if (game._runReset) game._runReset()
    },

    // ---- director control (game-registered slot) ----
    setDirector(handle) { game._director = handle || null },
    get director() { return game._director },

    // ---- deterministic sim ops ----
    spawn(id, opts) { return game.api.spawn(id, opts) },
    count(has) { return game.api.query({ has }).length },

    // ---- monotonic counters ----
    counters: {
      incr(key, n = 1) { counters.set(key, (counters.get(key) || 0) + n) },
      set(key, n) { counters.set(key, n) },
      get(key) { return counters.get(key) || 0 },
      has(key) { return counters.has(key) },
      reset() { counters.clear() },
    },
  }
  return controller
}
