/**
 * Fixed-timestep game loop.
 *
 * The fixed timestep is the authoritative simulation clock. Gameplay logic
 * stays scrub-friendly: `step(dt)` advances the simulation in exact fixed
 * steps, never on the wall clock. Rendering interpolates between the previous
 * and current simulation states using the returned `alpha`.
 */
export class GameLoop {
  /**
   * @param {object} options
   * @param {number} [options.fixedDt=1/60]  Length of one simulation step (s).
   * @param {number} [options.maxSteps=5]    Cap steps per update to avoid the
   *                                         spiral-of-death after a long pause.
   * @param {(dt: number, simState: object) => void} options.update  Simulation step callback.
   */
  constructor({ fixedDt = 1 / 60, maxSteps = 5, update } = {}) {
    if (typeof update !== 'function') {
      throw new TypeError('GameLoop requires an `update(dt)` function')
    }
    if (!(fixedDt > 0)) throw new RangeError('fixedDt must be > 0')
    if (!(maxSteps >= 1)) throw new RangeError('maxSteps must be >= 1')

    this.fixedDt = fixedDt
    this.maxSteps = maxSteps
    this._stepFn = update

    this._accumulator = 0
    this._time = 0 // total simulated time (seconds)
    this._alpha = 0 // interpolation factor between last two sim states
    this._stepCount = 0
    this._stepsLast = 0 // fixed steps run by the most recent update()
    this._paused = false
  }

  /** Pause the simulation — `update()` runs no steps while paused. */
  pause() {
    this._paused = true
  }

  /** Resume a paused simulation. */
  resume() {
    this._paused = false
  }

  /** True while the loop is paused. */
  isPaused() {
    return this._paused === true
  }

  /**
   * Run exactly ONE fixed step, ignoring pause — the editor-scrub primitive
   * (backlog C). Advances time + stepCount and clears the accumulator so a
   * subsequent normal update doesn't double-run the same step.
   */
  runOne() {
    this._stepFn(this.fixedDt)
    this._time += this.fixedDt
    this._stepCount += 1
    this._accumulator = 0
    this._alpha = 0
  }

  /** Total simulated time advanced so far (seconds). */
  get time() {
    return this._time
  }

  /** Total number of fixed steps run so far. */
  get stepCount() {
    return this._stepCount
  }

  /** Interpolation factor (0..1) for the render frame between fixed steps. */
  get alpha() {
    return this._alpha
  }

  /**
   * Read-only loop stats (O1 read-seam). Pure read — no timing hooks.
   * @returns {{ fixedDt: number, stepsLast: number, totalSteps: number }}
   *   fixedDt: configured fixed timestep (s)
   *   stepsLast: fixed steps run by the most recent update() (0 before the first)
   *   totalSteps: cumulative fixed steps run
   */
  stats() {
    return { fixedDt: this.fixedDt, stepsLast: this._stepsLast, totalSteps: this._stepCount }
  }

  /**
   * Advance the simulation by a wall-clock delta, running 0..maxSteps fixed
   * steps. Returns { steps, alpha }.
   *
   * A large delta is clamped to maxSteps per call; the remainder is carried in
   * the accumulator so time never silently drifts. After steps are run, alpha
   * is (remaining accumulator) / fixedDt, which the renderer uses to
   * interpolate between the last two sim states.
   */
  update(dt) {
    if (!(dt >= 0)) throw new RangeError('dt must be >= 0')
    if (this._paused) {
      this._alpha = 0
      this._stepsLast = 0
      return { steps: 0, alpha: 0 }
    }
    if (dt > this.maxSteps * this.fixedDt) {
      // Spiral-of-death guard: clamp rather than run unbounded steps.
      this._accumulator = Math.min(this._accumulator + dt, this.maxSteps * this.fixedDt)
    } else {
      this._accumulator += dt
    }

    let steps = 0
    while (this._accumulator >= this.fixedDt) {
      this._stepFn(this.fixedDt)
      this._accumulator -= this.fixedDt
      this._time += this.fixedDt
      this._stepCount += 1
      steps += 1
      if (steps >= this.maxSteps) {
        // If we hit the cap with leftover time, drop it to avoid a spiral.
        if (this._accumulator >= this.fixedDt) this._accumulator = 0
        break
      }
    }

    this._stepsLast = steps
    this._alpha = this.fixedDt > 0 ? this._accumulator / this.fixedDt : 0
    return { steps, alpha: this._alpha }
  }

  /** Reset the loop to a clean state (time, steps, accumulator). */
  reset() {
    this._accumulator = 0
    this._time = 0
    this._stepCount = 0
    this._stepsLast = 0
    this._alpha = 0
  }
}
