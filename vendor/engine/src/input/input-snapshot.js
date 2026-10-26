/**
 * Input snapshots and game-feel primitives (FOUNDATION-PLAN.md §6).
 *
 * These are small, pure modules where thin unit tests are worthwhile. They
 * capture per-frame input state and provide the responsiveness primitives:
 * jump buffer, coyote time, and fixed-timestep interpolation.
 */

/**
 * Immutable per-frame input snapshot.
 *
 * A snapshot records the state of every device for exactly one simulation
 * frame. Gameplay logic reads snapshots; it never polls the DOM/device
 * directly, which keeps it deterministic and scrub-friendly.
 */
export class InputSnapshot {
  /**
   * @param {object} [data]
   * @param {Record<string, boolean>} [data.buttons]  logical button name -> pressed
   * @param {Record<string, number>}  [data.axes]     logical axis name -> value (-1..1)
   * @param {number} [data.frame]                     simulation frame index
   * @param {number} [data.timestamp]                 simulation time (s)
   */
  constructor({ buttons = {}, axes = {}, frame = 0, timestamp = 0 } = {}) {
    this.buttons = Object.freeze({ ...buttons })
    this.axes = Object.freeze({ ...axes })
    this.frame = frame
    this.timestamp = timestamp
  }

  /** True if a logical button is currently held down. */
  down(name) {
    return this.buttons[name] === true
  }

  /** Value of a logical axis (0 if absent). */
  axis(name) {
    return this.axes[name] ?? 0
  }

  /** A new snapshot with the given buttons/axes merged over this one. */
  with({ buttons = {}, axes = {} } = {}) {
    return new InputSnapshot({
      buttons: { ...this.buttons, ...buttons },
      axes: { ...this.axes, ...axes },
      frame: this.frame,
      timestamp: this.timestamp,
    })
  }

  /**
   * True if a button is newly pressed this frame vs the previous snapshot.
   * A key repeated (auto-repeat) counts as a fresh press if the previous
   * frame did not have it down.
   */
  pressed(name, prev = null) {
    return this.down(name) && (prev === null || !prev.down(name))
  }

  /** True if a button was released this frame vs the previous snapshot. */
  released(name, prev = null) {
    return !this.down(name) && prev !== null && prev.down(name)
  }
}

/**
 * Captures input into per-frame snapshots, aggregating multiple devices into a
 * single logical view. In the headless/browser harness, `beginFrame` is called
 * once per simulation step with the merged physical state.
 */
export class InputCapture {
  constructor() {
    this._frame = 0
    this._pendingButtons = {}
    this._pendingAxes = {}
    this._prev = null
    this.current = new InputSnapshot()
  }

  /** Begin a new simulation frame, clearing pending state. */
  beginFrame() {
    const snap = new InputSnapshot({
      buttons: this._pendingButtons,
      axes: this._pendingAxes,
      frame: this._frame,
    })
    this._prev = this.current
    this.current = snap
    this._frame += 1
    this._pendingButtons = {}
    this._pendingAxes = {}
    return snap
  }

  /** Set a logical button state for the current frame. */
  setButton(name, pressed) {
    this._pendingButtons[name] = pressed
  }

  /** Set a logical axis value for the current frame. */
  setAxis(name, value) {
    this._pendingAxes[name] = value
  }

  /** True if a button was pressed vs the previous frame. */
  pressed(name) {
    return this.current.pressed(name, this._prev)
  }

  /** True if a button was released vs the previous frame. */
  released(name) {
    return this.current.released(name, this._prev)
  }
}

/**
 * Jump buffer: a jump pressed shortly before landing is honored on landing.
 *
 * When the player presses jump, we arm the buffer for `windowSec` seconds. If
 * they become grounded within that window, the buffered jump fires. Consuming
 * the buffer after it fires prevents re-triggering.
 */
export class JumpBuffer {
  /**
   * @param {number} [windowSec=0.12]  how long a jump press stays valid (s)
   * @param {number} [fixedDt=1/60]    simulation step length (s)
   */
  constructor({ windowSec = 0.12, fixedDt = 1 / 60 } = {}) {
    this.windowSec = windowSec
    this.fixedDt = fixedDt
    this._remaining = 0
  }

  /** Called when the jump button is pressed. */
  press() {
    this._remaining = this.windowSec
  }

  /** Called every fixed step; ticks the buffer down. */
  tick() {
    if (this._remaining > 0) this._remaining -= this.fixedDt
    if (this._remaining < 0) this._remaining = 0
  }

  /** True if a jump press is still within the window. */
  get armed() {
    return this._remaining > 0
  }

  /** Consume the buffer (call on a successful jump). Returns true if it fired. */
  consume() {
    if (this._remaining > 0) {
      this._remaining = 0
      return true
    }
    return false
  }
}

/**
 * Coyote time: the player can still jump for a short window after walking off
 * a ledge. When grounded, we set a grace timer; it ticks down in the air. If
 * the player jumps while the grace is still active, it counts as grounded.
 */
export class CoyoteTime {
  /**
   * @param {number} [windowSec=0.1]   how long after leaving ground jump works (s)
   * @param {number} [fixedDt=1/60]
   */
  constructor({ windowSec = 0.1, fixedDt = 1 / 60 } = {}) {
    this.windowSec = windowSec
    this.fixedDt = fixedDt
    this._remaining = 0
  }

  /** Called every fixed step with whether the player is grounded. */
  tick(grounded) {
    if (grounded) {
      this._remaining = this.windowSec
    } else if (this._remaining > 0) {
      this._remaining -= this.fixedDt
      if (this._remaining < 0) this._remaining = 0
    }
  }

  /** True if the player may still jump from the edge (grace still active). */
  get usable() {
    return this._remaining > 0
  }

  /** Consume the grace (call on a coyote jump). Returns true if it fired. */
  consume() {
    if (this._remaining > 0) {
      this._remaining = 0
      return true
    }
    return false
  }
}

/**
 * Fixed-timestep interpolation: render a smooth value between the previous and
 * current simulation states using the GameLoop's `alpha`.
 *
 * `lerp(a, b, t)` is a pure helper; `Interpolator` tracks a value across sim
 * steps and returns the interpolated render value for the current alpha.
 */
export function lerp(a, b, t) {
  return a + (b - a) * t
}

export class Interpolator {
  constructor({ start = 0, alpha = 0 } = {}) {
    this._prev = start
    this._curr = start
    this._alpha = alpha
  }

  /** Set the current simulation value at the start of a new sim step. */
  set(value) {
    this._prev = this._curr
    this._curr = value
  }

  /** Set the interpolation factor for the current render frame (0..1). */
  setAlpha(alpha) {
    this._alpha = alpha
  }

  /** Interpolated render value between the last two sim states. */
  get value() {
    return lerp(this._prev, this._curr, this._alpha)
  }
}
