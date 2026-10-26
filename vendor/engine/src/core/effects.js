/**
 * Engine-extension API (FOUNDATION-PLAN.md §6, designed in B11).
 *
 * The "visual work goes through engine extensions" rule only works if the
 * surface is a real, designed contract. Extensions are render-side actors:
 * they own the renderer objects the engine hands them (scene, camera, mesh /
 * material pool) and NEVER touch the ECS or game state directly.
 *
 * Scope: per-entity. An extension attaches to an entity (onAttach), follows
 * the simulation clock (update), and detaches (onDetach). A behavior requests
 * an effect by name + data — it never imports Three.js.
 */

/**
 * An EffectRegistry holds named effect extensions.
 *
 * @param {object} [opts]
 * @param {object} [opts.log]   optional logger (e.g. the structured engine logger)
 */
export class EffectRegistry {
  constructor({ log } = {}) {
    this._effects = new Map()
    this._log = log || { warn: (m) => console.warn(m), error: (m) => console.error(m) }
  }

  /**
   * Register an effect extension.
   *
   * @param {string} name
   * @param {object} def
   * @param {(entity, params) => void} [def.onAttach]   validate params + set up
   * @param {(dt, simState) => void} [def.update]        follows the simulation clock
   * @param {() => void} [def.onDetach]
   * @param {object} [def.params]  optional { field: { type, default } } schema
   */
  register(name, def) {
    if (!name || typeof name !== 'string') throw new TypeError('effect name must be a string')
    if (!def || typeof def !== 'object') throw new TypeError('effect definition must be an object')
    if (this._effects.has(name)) throw new Error(`effect already registered: ${name}`)
    if (typeof def.update !== 'function') throw new TypeError(`effect "${name}" requires an update(dt, simState)`)

    // Validate the declared param schema up front.
    if (def.params) {
      validateParamSchema(name, def.params)
    }
    this._effects.set(name, {
      onAttach: def.onAttach,
      update: def.update,
      onDetach: def.onDetach,
      params: def.params || null,
    })
    return this
  }

  has(name) {
    return this._effects.has(name)
  }

  list() {
    return [...this._effects.keys()]
  }

  /**
   * Validate params for an effect against its declared schema.
   * @param {string} name
   * @param {object} params  caller-supplied params
   * @returns {object} normalized params (defaults applied)
   * @throws {TypeError} field-level, if params fail the schema
   */
  validateParams(name, params) {
    const def = this._effects.get(name)
    if (!def) throw new Error(`unknown effect: ${name}`)
    if (!def.params) return params ?? {}
    const out = {}
    for (const [field, spec] of Object.entries(def.params)) {
      const raw = params?.[field]
      if (raw === undefined) {
        if (spec.default !== undefined) out[field] = spec.default
        else if (spec.required) throw new TypeError(`effect "${name}": missing required param "${field}"`)
      } else {
        validateParamValue(name, field, spec.type, raw)
        out[field] = raw
      }
    }
    return out
  }
}

/**
 * Spawn an effect on an entity via a behavior-facing helper. This is what
 * `api.effects.spawn('trail', { entityId, color, duration })` routes to.
 *
 * @param {EffectRegistry} registry
 * @param {object} opts
 * @param {string} opts.name        effect name
 * @param {string} opts.entityId
 * @param {object} [opts.params]    params validated against the schema
 * @returns {object} handle { detach() }
 */
export function spawnEffect(registry, { name, entityId, params = {} }) {
  const def = registry._effects.get(name)
  if (!def) throw new Error(`unknown effect: ${name}`)
  const normalized = registry.validateParams(name, params)
  let attached = false
  if (def.onAttach) {
    def.onAttach(entityId, normalized)
    attached = true
  }
  return {
    entityId,
    name,
    detach() {
      if (attached && def.onDetach) def.onDetach()
      attached = false
    },
  }
}

/**
 * The `api.effects` surface exposed to behaviors.
 * @param {EffectRegistry} registry
 * @returns {{
 *   register: Function, spawn: Function, list: Function, has: Function
 * }}
 */
export function createEffectsApi(registry) {
  return {
    register: (name, def) => registry.register(name, def),
    spawn: (name, opts) => spawnEffect(registry, { name, ...opts }),
    list: () => registry.list(),
    has: (name) => registry.has(name),
  }
}

// ---- internal validation helpers ----

function validateParamSchema(name, schema) {
  for (const [field, spec] of Object.entries(schema)) {
    if (!spec || typeof spec !== 'object') {
      throw new TypeError(`effect "${name}": param "${field}" must be an object {type, default?}`)
    }
    if (!spec.type) {
      throw new TypeError(`effect "${name}": param "${field}" requires a "type"`)
    }
  }
}

function validateParamValue(name, field, type, value) {
  const ok =
    (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (type === 'string' && typeof value === 'string') ||
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'array' && Array.isArray(value)) ||
    (type === 'object' && ((value === null) || (typeof value === 'object' && !Array.isArray(value))))
  if (!ok) {
    throw new TypeError(`effect "${name}": param "${field}" must be ${type}, got ${typeof value}`)
  }
}
