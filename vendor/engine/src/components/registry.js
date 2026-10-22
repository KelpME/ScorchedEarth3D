/**
 * Engine component-metadata registry (mirror of the ScriptRegistry seam).
 *
 * The engine owns the six representation-primitive components (transform /
 * render / collider / playback / audio / camera) as pure editable data + a
 * `params` field schema — no behavior of their own. A GAME may register
 * additional, game-local component metas (e.g. `health`, `projectile`,
 * `enemy`) so they surface in the editor's Add-Component picker and render an
 * editable card, WITHOUT the engine acting on them. This honors the
 * six-primitives decision: gameplay-shaped components stay game-local DATA,
 * surfaced by a per-game registry — never engine built-ins.
 *
 * A component meta is:
 *   {
 *     name: string,           // component name (also the key in entity.components)
 *     label?: string,         // display name for the picker/card
 *     description?: string,   // one-line help shown in the inspector
 *     params?: { field: { type: 'number'|'string'|'boolean'|'array'|'object',
 *                         default?, required?, label?, min?, max? } },
 *   }
 *
 * The registry is metadata only — registering a component here never changes
 * engine behavior. It exists so the editor (and any game host) can discover
 * which components are attachable + what their editable fields are, and to
 * apply schema defaults on attach.
 */
export class ComponentRegistry {
  constructor({ metas = {} } = {}) {
    this._metas = new Map()
    for (const [name, meta] of Object.entries(metas)) {
      if (!meta) continue
      this.register(name, meta)
    }
  }

  /**
   * Register a component meta.
   * @param {string} name
   * @param {object} meta  { label?, description?, params? }
   */
  register(name, meta) {
    if (!name || typeof name !== 'string') throw new TypeError('component name must be a string')
    if (!meta || typeof meta !== 'object') throw new TypeError('component meta must be an object')
    if (this._metas.has(name)) throw new Error(`component already registered: ${name}`)
    if (meta.params) validateParamSchema(name, meta.params)
    this._metas.set(name, {
      name,
      label: meta.label || name,
      description: meta.description || '',
      params: meta.params || {},
    })
    return this
  }

  has(name) {
    return this._metas.has(name)
  }

  get(name) {
    return this._metas.get(name)
  }

  /** All registered metas as [{ name, label, description, params }]. */
  list() {
    return [...this._metas.values()]
  }

  /**
   * Default component data for a component name, with schema defaults applied
   * ({}, plus typed defaults). Unknown names -> {}.
   * @param {string} name
   * @returns {object}
   */
  defaults(name) {
    const meta = this._metas.get(name)
    if (!meta) return {}
    const out = {}
    for (const [field, spec] of Object.entries(meta.params || {})) {
      if (spec.default !== undefined) out[field] = spec.default
    }
    return out
  }
}

/**
 * The `api.components` surface exposed to the game host / editor
 * (list/check/register/defaults available components). Mirrors
 * createScriptsApi for the script registry.
 * @param {ComponentRegistry} registry
 * @returns {{ list: Function, has: Function, get: Function, register: Function, defaults: Function }}
 */
export function createComponentsApi(registry) {
  return {
    list: () => registry.list(),
    has: (name) => registry.has(name),
    get: (name) => registry.get(name),
    register: (name, meta) => registry.register(name, meta),
    defaults: (name) => registry.defaults(name),
  }
}

// ---- internal validation helpers (mirror scripts.js / effects.js) ----

function validateParamSchema(name, schema) {
  for (const [field, spec] of Object.entries(schema)) {
    if (!spec || typeof spec !== 'object') {
      throw new TypeError(`component "${name}": param "${field}" must be an object {type, default?}`)
    }
    if (!spec.type) {
      throw new TypeError(`component "${name}": param "${field}" requires a "type"`)
    }
  }
}
