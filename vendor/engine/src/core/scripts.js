/**
 * Engine gameplay script system (per-entity behaviors).
 *
 * Mirror of the render-side EffectRegistry, but for GAMEPLAY: a script is a
 * named behavior that attaches to a single entity and runs every fixed step.
 * An entity can attach as many scripts as it wants. Attaching a script in the
 * editor writes a `scripts` component (an array, so multiple are allowed):
 *
 *   components.scripts = [ { name: 'spin', params: { speed: 2 } }, ... ]
 *
 * The legacy single-script form `components.script = { name, params }` is still
 * accepted (treated as one attached script).
 *
 * The game's step loop dispatches every attached script to the matching
 * registered script. Scripts work in BOTH the editor viewport and any shipped
 * game that registers the same scripts (poly-runner etc.).
 *
 * Lifecycle (per attached entity+script), mirroring EffectRegistry:
 *   - onAttach(entityId, params)   when a script first appears on an entity.
 *   - update(dt, api, entityId, params)  every fixed step while attached.
 *   - onDetach()                   when the script is removed from the entity
 *                                  or the entity is destroyed.
 *   - onPointerClick(entityId, params, api)   WAVE-3: dispatched when the
 *                                  entity's INTERACTIVE widget is clicked
 *                                  (render/ui.js widget interaction seam).
 *                                  Game-script descriptors use the stateful
 *                                  form onPointerClick(state, api, entityId, params).
 *
 * Unknown script names warn + no-op (never throw), so a scene can reference a
 * script the current game hasn't registered without crashing.
 */

/**
 * A registry of named gameplay scripts.
 *
 * @param {object} [opts]
 * @param {object} [opts.log]  optional logger ({ warn, error })
 */
export class ScriptRegistry {
  constructor({ log } = {}) {
    this._scripts = new Map()
    this._log = log || { warn: (m) => console.warn(m), error: (m) => console.error(m) }
  }

  /**
   * Register a gameplay script.
   * @param {string} name
   * @param {object} def
   * @param {(entityId, params) => void} [def.onAttach]
   * @param {(dt, api, entityId, params) => void} [def.update]
   * @param {() => void} [def.onDetach]
   * @param {object} [def.params]  optional { field: { type, default, required? } }
   */
  register(name, def) {
    if (!name || typeof name !== 'string') throw new TypeError('script name must be a string')
    if (!def || typeof def !== 'object') throw new TypeError('script definition must be an object')
    if (this._scripts.has(name)) throw new Error(`script already registered: ${name}`)
    if (def.params) validateParamSchema(name, def.params)
    // P2-N5: GAME-SCRIPT defs (init + 5-arg update) are wrapped HERE so the
    // raw engine path (createGame({scripts}) / api.scripts.register) runs them
    // exactly like the editor's registerScript — per-entity state included.
    // Flat 4-arg defs (built-ins) are stored as-is.
    const src = isGameScriptDef(def) ? wrapGameScript(def) : def
    this._scripts.set(name, {
      onAttach: src.onAttach,
      update: src.update,
      onDetach: src.onDetach,
      onPointerClick: src.onPointerClick ?? null,
      params: src.params || null,
    })
    return this
  }

  has(name) {
    return this._scripts.has(name)
  }

  list() {
    return [...this._scripts.keys()]
  }

  get(name) {
    return this._scripts.get(name)
  }

  /**
   * Normalize params for a script against its declared schema (defaults applied).
   * @throws {TypeError} field-level if params fail the schema.
   */
  validateParams(name, params) {
    const def = this._scripts.get(name)
    if (!def) throw new Error(`unknown script: ${name}`)
    if (!def.params) return params ?? {}
    const out = {}
    for (const [field, spec] of Object.entries(def.params)) {
      const raw = params?.[field]
      if (raw === undefined) {
        if (spec.default !== undefined) out[field] = spec.default
        else if (spec.required) throw new TypeError(`script "${name}": missing required param "${field}"`)
      } else if (raw === null && spec.nullable) {
        // `nullable: true` params accept an explicit null (documented "or null"
        // fields like unit-move `target` / nav-agent `destination`) — no warn.
        out[field] = null
      } else {
        validateParamValue(name, field, spec.type, raw)
        out[field] = raw
      }
    }
    return out
  }
}

/**
 * TRUE for a GAME-SCRIPT descriptor: the folder-driven convention
 *   { name, label?, description?, params?, init?, update(state, dt, api, entityId, params) }
 * Detection: `init` present OR update declared with >4 parameters. Flat
 * built-in defs ({ onAttach, update(dt, api, entityId, params), onDetach })
 * return false and run unwrapped.
 */
export function isGameScriptDef(def) {
  return !!def && (typeof def.init === 'function' ||
    (typeof def.update === 'function' && def.update.length > 4))
}

/**
 * Wrap a game-script descriptor into a ScriptRegistry-compatible def
 * ({ params, onAttach, update, onDetach }) with per-entity state managed in a
 * closure Map — the SINGLE implementation shared with editor/src/scripts.js
 * (makeScript delegates here, P2-N5):
 *   - onAttach seeds state via init()
 *   - update passes (state, dt, api, entityId, params)
 *   - onDetach clears the entity's state
 * `params` is passed through as-is (null = no schema = raw params).
 */
export function wrapGameScript(desc) {
  const state = new Map()
  const init = desc.init
  const update = desc.update
  const pointerClick = desc.onPointerClick
  return {
    params: desc.params ?? null,
    onAttach: (id) => { if (!state.has(id)) state.set(id, init ? init() : {}) },
    update: (dt, api, id, p) => {
      if (!state.has(id)) state.set(id, init ? init() : {})
      if (update) update(state.get(id), dt, api, id, p)
    },
    // WAVE-3 pointer-click hook, stateful form: onPointerClick(state, api, entityId, params)
    // (flat dispatch signature is (entityId, params, api), mirroring onAttach).
    onPointerClick: (id, p, api) => {
      if (!state.has(id)) state.set(id, init ? init() : {})
      if (pointerClick) pointerClick(state.get(id), api, id, p)
    },
    onDetach: (id) => { state.delete(id) },
  }
}

/**
 * WAVE-3 — dispatch a pointer click on an entity to its attached scripts'
 * `onPointerClick` hook. Called by the interactive-widget seam (render/ui.js
 * dispatchUiWidgetClick) via `api.scripts.pointerClick(id)`. Mechanical: ANY
 * entity script may define the hook — no per-game wiring.
 *
 * FAIL-NOISY: an entity with NO script attached errors loudly (an interactive
 * widget without behavior is a broken declaration, never a dead element); an
 * unknown script name errors (not the per-step warn — at click time the user
 * is actively pressing it).
 *
 * @param {object} api  the game facade (passed through to the hook).
 * @param {string} entityId
 */
export function pointerClickEntityScripts(registry, api, entityId) {
  const rec = api && typeof api.entity === 'function' ? api.entity(entityId) : null
  const comps = rec && rec.components ? collectScripts(rec.components) : []
  if (!comps.length) {
    registry._log.error(`[scripts] pointerClick on entity "${entityId}": NO script attached — an interactive widget must carry its behavior as a VISIBLE script (components.scripts)`)
    return
  }
  for (const s of comps) {
    const def = registry._scripts.get(s.name)
    if (!def) {
      registry._log.error(`[scripts] pointerClick "${s.name}" (entity "${entityId}") is NOT registered — cannot dispatch onPointerClick`)
      continue
    }
    if (!def.onPointerClick) {
      registry._log.error(`[scripts] pointerClick: script "${s.name}" (entity "${entityId}") has no onPointerClick hook — the widget is clickable but the script defines no click behavior`)
      continue
    }
    let params
    try {
      params = registry.validateParams(s.name, s.params)
    } catch (err) {
      registry._log.error(`[scripts] pointerClick "${s.name}": ${err && err.message || err}`)
      continue
    }
    try {
      def.onPointerClick(entityId, params, api)
    } catch (err) {
      registry._log.error(`[scripts] onPointerClick "${s.name}" entity "${entityId}": ${err}`)
    }
  }
}

/**
 * The `api.scripts` surface exposed to the game host (list/check/register
 * available scripts).
 * @param {ScriptRegistry} registry
 * @param {object|Function} [apiOrResolver]  the game facade (or a () => facade
 *   resolver — the api object is still being constructed when this runs).
 * @returns {{ list: Function, has: Function, register: Function, pointerClick: Function }}
 */
export function createScriptsApi(registry, apiOrResolver) {
  return {
    list: () => registry.list(),
    has: (name) => registry.has(name),
    register: (name, def) => registry.register(name, def),
    // WAVE-3 — dispatch a widget click to the entity's scripts (see
    // pointerClickEntityScripts). The api facade resolves lazily.
    pointerClick: (entityId) => {
      const api = typeof apiOrResolver === 'function' ? apiOrResolver() : apiOrResolver
      pointerClickEntityScripts(registry, api, entityId)
    },
  }
}

/**
 * Dispatch every entity's attached scripts to their registered script, running
 * ALL of them (multiple scripts per entity are supported). Manages
 * attach/detach lifecycle. Called by the game's fixed step.
 *
 * A script is attached via either:
 *   components.scripts = [ { name: 'spin', params: { speed: 2 } }, ... ]
 *   — the canonical form; any number per entity.
 *   components.script = { name, params }  — legacy single-script form; still
 *   supported (treated as one attached script, deduped by name if also listed).
 *
 * @param {ScriptRegistry} registry
 * @param {object} api         the game's public facade (query/entity)
 * @param {number} dt          fixed step length
 * @param {Map<string, {name:string, def:object}>} attached
 *   `"<entityId>::<scriptName>"` -> { name, def } for attached scripts
 *   (lifecycle state, persists across steps). Pass the SAME map every step.
 * @param {object} [prof]  optional frame profiler (frame-profiler.js): each
 *   script's `update` is timed into a `sim.script.<name>` bucket (summed across
 *   entities, attributed BY registered script name). Omitted = no timing.
 */
export function runScripts(registry, api, dt, attached, prof) {
  const single = api.query({ has: 'script' })
  const multi = api.query({ has: 'scripts' })
  const ids = [...new Set([...single, ...multi])]
  const seen = new Set()

  for (const id of ids) {
    const rec = api.entity(id)
    if (!rec || !rec.components) continue
    for (const comp of collectScripts(rec.components)) {
      const key = scriptKey(id, comp.name)
      seen.add(key)

      const def = registry.get(comp.name)
      if (!def) {
        // Unknown script: warn + no-op (never throw). Leave any prior attachment
        // alone so a transient missing registration doesn't tear down a script.
        registry._log.warn(`[scripts] "${comp.name}" not registered — no-op for entity "${id}"`)
        continue
      }

      const params = normalizeParams(registry, comp.name, comp.params)
      let entry = attached.get(key)
      if (!entry) {
        if (def.onAttach) {
          try { def.onAttach(id, params) } catch (err) { registry._log.error(`[scripts] onAttach "${comp.name}": ${err}`) }
        }
        entry = { name: comp.name, def }
        attached.set(key, entry)
      }
      if (def.update) {
        // P1 frame-budget attribution: time update() BY SCRIPT NAME (the bucket
        // name is only built while a profiler is active — zero cost otherwise).
        const bucket = prof && prof.enabled ? `sim.script.${comp.name}` : null
        if (bucket) prof.begin(bucket)
        try { def.update(dt, api, id, params) } catch (err) { registry._log.error(`[scripts] update "${comp.name}" entity "${id}": ${err}`) }
        if (bucket) prof.end(bucket)
      }
    }
  }

  // Detach scripts whose entity no longer qualifies (script removed / gone).
  for (const [key, entry] of attached) {
    if (!seen.has(key)) {
      if (entry.def.onDetach) {
        const entityId = key.split('\u0000')[0]
        // Pass `api` so a script can clean up entities it owns on detach
        // (backward compatible: existing onDetach(id) ignores the 2nd arg).
        try { entry.def.onDetach(entityId, api) } catch (err) { registry._log.error(`[scripts] onDetach "${entry.name}" entity "${entityId}": ${err}`) }
      }
      attached.delete(key)
    }
  }
}

/**
 * Collect every script attached to an entity's components. Reads the canonical
 * `scripts` array plus the legacy single `script` component (deduped by name).
 */
function collectScripts(comps) {
  const out = []
  if (Array.isArray(comps.scripts)) {
    for (const s of comps.scripts) {
      if (s && typeof s === 'object' && typeof s.name === 'string') out.push(s)
    }
  }
  if (comps.script && typeof comps.script === 'object' && typeof comps.script.name === 'string') {
    if (!out.some((s) => s.name === comps.script.name)) out.push(comps.script)
  }
  return out
}

/** Stable lifecycle key per (entity, script) so one entity can run many scripts. */
function scriptKey(id, name) {
  return `${id}\u0000${name}`
}

/** Validate + normalize params (defaults applied), falling back to raw on error. */
function normalizeParams(registry, name, raw) {
  try {
    return registry.validateParams(name, raw)
  } catch (err) {
    registry._log.warn(`[scripts] ${err && err.message || err}`)
    return raw ?? {}
  }
}

// ---- internal validation helpers (mirror effects.js) ----

function validateParamSchema(name, schema) {
  for (const [field, spec] of Object.entries(schema)) {
    if (!spec || typeof spec !== 'object') {
      throw new TypeError(`script "${name}": param "${field}" must be an object {type, default?}`)
    }
    if (!spec.type) {
      throw new TypeError(`script "${name}": param "${field}" requires a "type"`)
    }
  }
}

function validateParamValue(name, field, type, value) {
  const ok =
    (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (type === 'string' && typeof value === 'string') ||
    // P2.5 W5: an `entity` param is a scene entity ID — stored as a string
    // (the editor's entity-ref picker writes ids; legacy raw strings pass).
    (type === 'entity' && typeof value === 'string') ||
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'array' && Array.isArray(value)) ||
    (type === 'object' && ((value === null) || (typeof value === 'object' && !Array.isArray(value))))
  if (!ok) {
    throw new TypeError(`script "${name}": param "${field}" must be ${type}, got ${typeof value}`)
  }
}

