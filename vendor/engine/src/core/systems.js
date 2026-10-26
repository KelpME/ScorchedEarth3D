/**
 * Engine global system registry (scene-level behaviors).
 *
 * The symmetric counterpart of the per-entity ScriptRegistry (core/scripts.js),
 * for GLOBAL behaviors that act across MANY entities or game-wide state
 * (projectile/contact resolution, a director/spawner, the HUD, win/lose).
 *
 * A system attaches to the SCENE, not a single entity. The scene carries a
 * top-level `systems` array (declared update order, NOT load order):
 *
 *   systems = [ { name: 'aim', params: {...} }, { name: 'weapon', ... } ]
 *
 * Every fixed step the engine calls the systems in list order — the ordering
 * exists to satisfy per-frame data dependencies (a behavior reads state an
 * earlier behavior wrote that same frame). After systems, the engine dispatches
 * per-entity scripts.
 *
 * Lifecycle (per system, mirroring scripts.js's per-entity lifecycle):
 *   - init(params)           when a system first appears in the scene's `systems`.
 *   - update(dt, api)        every fixed step while attached.
 *   - onDetach()             when the system is removed from the scene's `systems`
 *                            or the scene is reloaded.
 *
 * Unknown system names warn + no-op (never throw), so a scene can reference a
 * system the current game hasn't registered without crashing.
 */

/**
 * A registry of named global systems.
 *
 * @param {object} [opts]
 * @param {object} [opts.log]  optional logger ({ warn, error })
 */
export class SystemRegistry {
  constructor({ log } = {}) {
    this._systems = new Map()
    this._log = log || { warn: (m) => console.warn(m), error: (m) => console.error(m) }
  }

  /**
   * Register a global system.
   * @param {string} name
   * @param {object} def
   * @param {(params) => void} [def.init]     once, when the system first appears
   * @param {(dt, api) => void} [def.update]  every fixed step while attached
   * @param {() => void} [def.onDetach]       when removed / scene reload
   * @param {object} [def.params]  optional { field: { type, default, required? } }
   */
  register(name, def) {
    if (!name || typeof name !== 'string') throw new TypeError('system name must be a string')
    if (!def || typeof def !== 'object') throw new TypeError('system definition must be an object')
    if (this._systems.has(name)) throw new Error(`system already registered: ${name}`)
    if (def.params) validateSystemParamSchema(name, def.params)
    this._systems.set(name, {
      init: def.init,
      update: def.update,
      onDetach: def.onDetach,
      params: def.params || null,
    })
    return this
  }

  has(name) {
    return this._systems.has(name)
  }

  list() {
    return [...this._systems.keys()]
  }

  get(name) {
    return this._systems.get(name)
  }

  /**
   * Normalize params for a system against its declared schema (defaults applied).
   * @throws {TypeError} field-level if params fail the schema.
   */
  validateParams(name, params) {
    const def = this._systems.get(name)
    if (!def) throw new Error(`unknown system: ${name}`)
    if (!def.params) return params ?? {}
    const out = {}
    for (const [field, spec] of Object.entries(def.params)) {
      const raw = params?.[field]
      if (raw === undefined) {
        if (spec.default !== undefined) out[field] = spec.default
        else if (spec.required) throw new TypeError(`system "${name}": missing required param "${field}"`)
      } else {
        validateSystemParamValue(name, field, spec.type, raw)
        out[field] = raw
      }
    }
    return out
  }
}

/**
 * The `api.systems` surface exposed to the game host (list/check/register
 * available systems).
 * @param {SystemRegistry} registry
 * @returns {{ list: Function, has: Function, register: Function }}
 */
export function createSystemsApi(registry) {
  return {
    list: () => registry.list(),
    has: (name) => registry.has(name),
    register: (name, def) => registry.register(name, def),
  }
}

/**
 * Dispatch the scene's `systems` list to the matching registered systems,
 * running them in DECLARED order every fixed step. Manages init/detach
 * lifecycle. Called by the game's fixed step BEFORE per-entity scripts so a
 * global system (e.g. a director) can write state the entity scripts read.
 *
 * @param {SystemRegistry} registry
 * @param {object} api         the game's public facade (query/entity)
 * @param {number} dt          fixed step length
 * @param {Array<{name: string, params?: object}>} systemsList
 *   the scene's `systems` array (may be undefined).
 * @param {Map<string, {name: string, def: object}>} active
 *   `"<systemName>"` -> { name, def } for attached systems (lifecycle state,
 *   persists across steps). Pass the SAME map every step.
 * @param {object} [prof]  optional frame profiler (frame-profiler.js): each
 *   system's `update` is timed into a `sim.system.<name>` bucket (attributed BY
 *   registered system name). Omitted = no timing.
 */
export function runSystems(registry, api, dt, systemsList, active, prof) {
  const list = Array.isArray(systemsList) ? systemsList : []
  const seen = new Set()

  for (const item of list) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string') continue
    const name = item.name
    seen.add(name)

    const def = registry.get(name)
    if (!def) {
      registry._log.warn(`[systems] "${name}" not registered — no-op`)
      continue
    }

    const params = normalizeSystemParams(registry, name, item.params)
    let entry = active.get(name)
    if (!entry) {
      if (def.init) {
        try { def.init(params) } catch (err) { registry._log.error(`[systems] init "${name}": ${err}`) }
      }
      entry = { name, def }
      active.set(name, entry)
    }
    if (def.update) {
      // P1 frame-budget attribution: time update() BY SYSTEM NAME (the bucket
      // name is only built while a profiler is active — zero cost otherwise).
      const bucket = prof && prof.enabled ? `sim.system.${name}` : null
      if (bucket) prof.begin(bucket)
      try { def.update(dt, api) } catch (err) { registry._log.error(`[systems] update "${name}": ${err}`) }
      if (bucket) prof.end(bucket)
    }
  }

  // Detach systems no longer in the scene's `systems` list.
  for (const [name, entry] of active) {
    if (!seen.has(name)) {
      if (entry.def.onDetach) {
        try { entry.def.onDetach() } catch (err) { registry._log.error(`[systems] onDetach "${entry.name}": ${err}`) }
      }
      active.delete(name)
    }
  }
}

/** Validate + normalize params (defaults applied), falling back to raw on error. */
function normalizeSystemParams(registry, name, raw) {
  try {
    return registry.validateParams(name, raw)
  } catch (err) {
    registry._log.warn(`[systems] ${err && err.message || err}`)
    return raw ?? {}
  }
}

// ---- internal validation helpers (mirror scripts.js) ----

function validateSystemParamSchema(name, schema) {
  for (const [field, spec] of Object.entries(schema)) {
    if (!spec || typeof spec !== 'object') {
      throw new TypeError(`system "${name}": param "${field}" must be an object {type, default?}`)
    }
    if (!spec.type) {
      throw new TypeError(`system "${name}": param "${field}" requires a "type"`)
    }
  }
}

function validateSystemParamValue(name, field, type, value) {
  const ok =
    (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (type === 'string' && typeof value === 'string') ||
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'array' && Array.isArray(value)) ||
    (type === 'object' && ((value === null) || (typeof value === 'object' && !Array.isArray(value))))
  if (!ok) {
    throw new TypeError(`system "${name}": param "${field}" must be ${type}, got ${typeof value}`)
  }
}
