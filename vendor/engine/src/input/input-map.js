/**
 * InputActionMap — a full controller/input-mapping suite (backlog P).
 *
 * Kills the hard-coded `KEYMAP` in every game's `main.js`. A genre-agnostic,
 * data-driven input-mapping layer on top of `InputCapture`:
 *
 *   - ACTIONS (logical): named inputs a game consumes ('forward', 'fire',
 *     'jump', 'moveX', ...).
 *   - BINDINGS: physical inputs bound to an action. A physical input is one of:
 *       { kind: 'key',    code: 'KeyW' }            keyboard (KeyboardEvent.code)
 *       { kind: 'mouse',  button: 0 }               mouse button (0 left/1 mid/2 right)
 *       { kind: 'pad',    index: 0, button: 3 }     gamepad button
 *       { kind: 'padAxis', index: 0, axis: 0, direction: 1 }  gamepad axis (analog)
 *     Multiple bindings per action are OR'ed: the action is DOWN if ANY bound
 *     input is active. An action is ANALOG when it carries a `padAxis` binding
 *     (read its value via `axis(name)`); otherwise it is DIGITAL (down/pressed/
 *     released).
 *   - DEVICE-AGNOSTIC CAPTURE: the host (main.js) feeds the current physical
 *     device state each frame via `update({ keys, mouse, pads })`; the map is
 *     PURE — it only computes states, it owns no listeners. This mirrors
 *     `InputCapture` (headless-testable). A game then pumps action states into
 *     `InputCapture` (`setButton`/`setAxis`) so existing behaviors read a normal
 *     snapshot.
 *   - CONFLICT DETECTION: one physical input should not feed two actions.
 *     `findConflict(input)` reports it; `bind()` refuses; `resolve(action,
 *     input)` MOVES a binding (the operation a live-remap UI / player remap
 *     drives).
 *   - PROFILE persistence: the whole map serializes to/from a per-game
 *     `controls.json` (`toJSON`/`fromJSON`/`static from`).
 */
const AXIS_DEADZONE = 0.2

/** Build a keyboard binding. */
export const key = (code) => ({ kind: 'key', code })
/** Build a mouse-button binding. */
export const mouseButton = (button) => ({ kind: 'mouse', button })
/** Build a gamepad-button binding. */
export const padButton = (index, button) => ({ kind: 'pad', index, button })
/** Build a gamepad-axis (analog) binding. direction: +1 normal, -1 inverted. */
export const padAxis = (index, axis, direction = 1) => ({ kind: 'padAxis', index, axis, direction })

const sameInput = (a, b) => {
  a = normalizeInput(a)
  b = normalizeInput(b)
  if (a.kind !== b.kind) return false
  if (a.kind === 'key') return a.code === b.code
  if (a.kind === 'mouse') return a.button === b.button
  if (a.kind === 'pad') return a.index === b.index && a.button === b.button
  if (a.kind === 'padAxis') return a.index === b.index && a.axis === b.axis && (a.direction ?? 1) === (b.direction ?? 1)
  return false
}

/** Accept a bare string (a key code, or 'mouse:N') as shorthand for a binding. */
function normalizeInput(input) {
  if (typeof input === 'string') {
    if (input.startsWith('mouse:')) {
      const n = parseInt(input.slice('mouse:'.length), 10)
      return { kind: 'mouse', button: Number.isFinite(n) ? n : 0 }
    }
    return { kind: 'key', code: input }
  }
  return input && typeof input === 'object' ? input : null
}

export class InputActionMap {
  /**
   * @param {object} [profile]  controls.json profile:
   *   { version?, actions: { name: { label?, bindings: [input...] } } }
   */
  constructor(profile = {}) {
    this._actions = {} // name -> { label, bindings: [] }
    this._prev = {}    // name -> down (for pressed/released edges)
    this._last = { keys: new Set(), mouse: new Set(), pads: [] }
    this.fromJSON(profile)
  }

  /** All action names. */
  get actions() {
    return Object.keys(this._actions)
  }

  /** [ { name, label, bindings } ] — for editor UI / iteration. */
  get actionList() {
    return this.actions.map((name) => ({
      name,
      label: this._actions[name].label || name,
      bindings: this.bindingsFor(name),
    }))
  }

  // ---- definition ----
  addAction(name, { label } = {}) {
    if (!this._actions[name]) this._actions[name] = { label: label || name, bindings: [] }
    else if (label) this._actions[name].label = label
    return this
  }

  removeAction(name) {
    delete this._actions[name]
    delete this._prev[name]
    return this
  }

  label(name) {
    return this._actions[name]?.label || name
  }

  isAnalog(name) {
    return (this._actions[name]?.bindings || []).some((b) => b.kind === 'padAxis')
  }

  // ---- bindings ----
  bindingsFor(name) {
    return (this._actions[name]?.bindings || []).map((b) => ({ ...b }))
  }

  /** True if a physical input (string shorthand or binding object) is bound to any action. */
  isBound(input) {
    input = normalizeInput(input)
    return this.actions.some((b) => this.has(b, input))
  }

  /** True if an action has a specific physical input bound. */
  has(action, input) {
    input = normalizeInput(input)
    return (this._actions[action]?.bindings || []).some((b) => sameInput(b, input))
  }

  /** The action(s) a physical input is bound to ([] if none). */
  buttonsFor(input) {
    input = normalizeInput(input)
    return this.actions.filter((b) => this.has(b, input))
  }

  /** The action a physical input is currently bound to, or null. */
  findConflict(input) {
    for (const name of this.actions) {
      if (this._actions[name].bindings.some((b) => sameInput(b, input))) return name
    }
    return null
  }

  /**
   * Bind `input` to `action`. Refuses if the input is already bound to a
   * DIFFERENT action (conflict). Returns { ok, conflict? }.
   */
  bind(action, input) {
    input = normalizeInput(input)
    const conflict = this.findConflict(input)
    if (conflict && conflict !== action) return { ok: false, conflict }
    if (!this._actions[action]) this.addAction(action)
    if (!this._actions[action].bindings.some((b) => sameInput(b, input))) {
      this._actions[action].bindings.push({ ...input })
    }
    return { ok: true, conflict: null }
  }

  unbind(action, input) {
    const arr = this._actions[action]?.bindings
    if (!arr) return this
    const i = arr.findIndex((b) => sameInput(b, input))
    if (i >= 0) arr.splice(i, 1)
    return this
  }

  clearAction(action) {
    if (this._actions[action]) this._actions[action].bindings = []
    return this
  }

  /**
   * MOVE a physical input to `action`: remove it from any other action first,
   * then bind. Returns { ok, movedFrom } (movedFrom is null when no conflict).
   * This is the operation a live-remap UI drives.
   */
  resolve(action, input) {
    input = normalizeInput(input)
    const conflict = this.findConflict(input)
    if (conflict && conflict !== action) this.unbind(conflict, input)
    if (!this._actions[action]) this.addAction(action)
    if (!this._actions[action].bindings.some((b) => sameInput(b, input))) {
      this._actions[action].bindings.push({ ...input })
    }
    return { ok: true, movedFrom: conflict && conflict !== action ? conflict : null }
  }

  // ---- device state feeding ----
  /**
   * Feed the current physical device state for this frame.
   * @param {{ keys?: Set<string>, mouse?: Set<number>, pads?: Array<{buttons:Set<number>, axes:number[]}> }} fed
   */
  update(fed = {}) {
    // Snapshot the PREVIOUS frame's down-state for edge detection BEFORE
    // replacing the live device state.
    const prev = {}
    for (const name of this.actions) prev[name] = this._rawDown(name, this._last)
    this._prev = prev
    this._last = {
      keys: fed.keys || new Set(),
      mouse: fed.mouse || new Set(),
      pads: fed.pads || [],
    }
    return this
  }

  /** Recomputed state for the CURRENT fed frame. */
  _rawDown(name, last) {
    for (const b of this._actions[name].bindings) {
      if (b.kind === 'key') { if (last.keys.has(b.code)) return true }
      else if (b.kind === 'mouse') { if (last.mouse.has(b.button)) return true }
      else if (b.kind === 'pad') { if (last.pads[b.index]?.buttons.has(b.button)) return true }
      else if (b.kind === 'padAxis') {
        const v = last.pads[b.index]?.axes[b.axis] ?? 0
        if (Math.abs(v) > AXIS_DEADZONE) return true
      }
    }
    return false
  }

  /** Raw analog value for the current fed frame (analog actions only). */
  _rawAxis(name, last) {
    let v = 0
    for (const b of this._actions[name].bindings) {
      if (b.kind === 'padAxis') {
        const raw = last.pads[b.index]?.axes[b.axis] ?? 0
        const s = Math.abs(raw) > AXIS_DEADZONE ? raw * (b.direction ?? 1) : 0
        if (Math.abs(s) > Math.abs(v)) v = s
      } else if (this._rawDown(name, last)) {
        v = v === 0 ? 1 : v
      }
    }
    return v
  }

  // ---- action state (after update) ----
  /** True if any binding of `name` is currently active. */
  down(name) {
    return this._rawDown(name, this._last) === true
  }

  /** True if `name` transitioned to down this frame. */
  pressed(name) {
    return this.down(name) && !(this._prev[name] === true)
  }

  /** True if `name` transitioned to up this frame. */
  released(name) {
    return !this.down(name) && this._prev[name] === true
  }

  /** Analog value (-1..1, deadzone'd) for an analog action. */
  axis(name) {
    return this._rawAxis(name, this._last)
  }

  // ---- persistence ----
  toJSON() {
    const actions = {}
    for (const name of this.actions) {
      actions[name] = {
        label: this._actions[name].label,
        bindings: this.bindingsFor(name),
      }
    }
    return { version: 1, actions }
  }

  fromJSON(profile) {
    this._actions = {}
    this._prev = {}
    const actions = (profile && profile.actions) || profile || {}
    for (const [name, def] of Object.entries(actions)) {
      let bindings = def
      if (def && typeof def === 'object' && !Array.isArray(def)) bindings = def.bindings
      // Accept a bare string (single key code) or an array of codes as bindings.
      if (typeof bindings === 'string') bindings = [bindings]
      this._actions[name] = {
        label: (def && typeof def === 'object' && !Array.isArray(def) && def.label) || name,
        bindings: (Array.isArray(bindings) ? bindings : []).map((b) => normalizeInput(b) || {}),
      }
    }
    return this
  }

  static from(profile) {
    return new InputActionMap(profile)
  }

  // ---- display ----
  /** Human-readable label for a physical input (for hints/remap UI). */
  static displayName(input) {
    if (!input) return ''
    if (input.kind === 'key') return prettyKey(input.code)
    if (input.kind === 'mouse') return ['Mouse Left', 'Mouse Middle', 'Mouse Right'][input.button] || `Mouse ${input.button}`
    if (input.kind === 'pad') return `Pad ${input.index + 1} Button ${input.button}`
    if (input.kind === 'padAxis') return `Pad ${input.index + 1} ${axisName(input.axis)}${(input.direction ?? 1) < 0 ? ' −' : ''}`
    return String(input.code || input.button || '')
  }
}

function prettyKey(code) {
  if (!code) return ''
  if (code === 'Space') return 'Space'
  const named = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt', Tab: 'Tab', Backspace: 'Backspace' }
  if (named[code]) return named[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return 'Numpad ' + code.slice(6)
  return code
}

function axisName(i) {
  return ['L-Stick X', 'L-Stick Y', 'R-Stick X', 'R-Stick Y', 'L-Trigger', 'R-Trigger'][i] || `Axis ${i}`
}
