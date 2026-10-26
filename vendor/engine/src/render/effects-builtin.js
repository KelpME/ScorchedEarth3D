/**
 * Built-in effect extensions that ship with the engine.
 *
 * B11 requires at least one minimal built-in extension (e.g. `impact-flash`
 * or `trail`) to prove the contract with a working example. These are pure
 * descriptor producers: they return the effect definition; the render layer
 * owns the actual Three.js objects.
 */

/**
 * `impact-flash` — a quick flash on a hit entity.
 * @returns {object} effect definition with a declared params schema.
 */
export function impactFlashEffect() {
  return {
    params: {
      color: { type: 'array', default: [1, 1, 1] }, // [r,g,b] 0..1
      duration: { type: 'number', default: 0.15 },  // seconds
      intensity: { type: 'number', default: 1 },
    },
    onAttach(entityId, params) {
      // Render layer reads params to schedule a flash; no ECS access here.
      this._elapsed = 0
      this._entityId = entityId
      this._params = params
    },
    update(dt) {
      this._elapsed += dt
      // Simple lifecycle signal: return true while the flash is active.
      return this._elapsed < this._params.duration
    },
    onDetach() {
      this._elapsed = 0
      this._entityId = null
    },
  }
}
