/**
 * Minimal ECS: entities, components, queries, JSON serialization.
 *
 * Design notes (FOUNDATION-PLAN.md §6):
 * - Entity ids are strings. Scene-authored ids are explicit and immutable
 *   ("house_01"); runtime-spawned ids are `entity_<N>` from a monotonically
 *   increasing, never-reused counter that is part of the serialized state.
 * - Component data is plain JSON-serializable objects keyed by component name.
 * - Serialization must round-trip losslessly (save -> load -> save identical).
 * - Hand-edited duplicate ids are rejected at load, never silently merged.
 */
export class World {
  constructor() {
    this._entities = new Map() // id -> { name?, parent?, layer?, tags?, components: { type: data } }
    this._nextEntityId = 0
    this._layers = null // null => the caller/editor resolves the default layer list
  }

  /** Total simulated seconds advanced by createGame.step. */
  get entityCount() {
    return this._entities.size
  }

  /** Monotonic, never-reused counter for runtime-spawned ids. */
  get nextEntityId() {
    return this._nextEntityId
  }

  /**
   * Create an entity. If `id` is omitted, a runtime id `entity_<N>` is
   * generated from the monotonic counter. Rejecting an explicit duplicate id
   * is the caller's job (see load); here we overwrite-check to keep spawn cheap
   * but still fail fast on obvious internal misuse.
   *
   * @param {object} [opts]
   * @param {string} [opts.id]        Explicit scene-authored id.
   * @param {string} [opts.name]      Optional human name.
   * @param {string} [opts.parent]    Optional parent entity id (transform parenting).
   * @param {string} [opts.layer]     Optional layer id (default layer when absent).
   * @param {string[]} [opts.tags]    Optional list of tag strings.
   * @param {string} [opts.archetypeId] Optional archetype id — marks the entity
   *        an ARCHETYPE INSTANCE (runtime-spawned instances via
   *        `api.spawnArchetype`; mirrors the scene-record field).
   * @param {Record<string, object>} [opts.components]  Type -> data map.
   * @returns {string} the entity id.
   */
  spawn({ id, name, parent, layer, tags, archetypeId, components = {} } = {}) {
    let entityId = id
    if (entityId === undefined || entityId === null || entityId === '') {
      entityId = this._allocateRuntimeId()
    }
    if (typeof entityId !== 'string') {
      throw new TypeError('entity id must be a string')
    }
    if (this._entities.has(entityId)) {
      throw new Error(`duplicate entity id: ${entityId}`)
    }
    const record = { name, components: {} }
    if (parent !== undefined && parent !== null) {
      if (typeof parent !== 'string' || parent === '') {
        throw new TypeError('entity parent must be a non-empty string id')
      }
      record.parent = parent
    }
    if (layer !== undefined && layer !== null && layer !== '') {
      record.layer = String(layer)
    }
    if (Array.isArray(tags) && tags.length > 0) {
      record.tags = tags.map(String)
    }
    if (archetypeId !== undefined && archetypeId !== null && archetypeId !== '') {
      record.archetypeId = String(archetypeId)
    }
    for (const [type, data] of Object.entries(components)) {
      record.components[type] = this._clone(data ?? {})
    }
    this._entities.set(entityId, record)
    return entityId
  }

  _allocateRuntimeId() {
    let id
    do {
      id = `entity_${this._nextEntityId}`
      this._nextEntityId += 1
    } while (this._entities.has(id))
    return id
  }

  /** Get an entity record, or undefined if absent. */
  entity(id) {
    return this._entities.get(id)
  }

  has(id) {
    return this._entities.has(id)
  }

  /** Remove an entity and all its components. Returns true if removed. */
  destroy(id) {
    return this._entities.delete(id)
  }

  /**
   * Get (or lazily create) a component on an entity.
   * @returns {object} the component data object (mutate it directly).
   */
  getComponent(id, type) {
    const record = this._entities.get(id)
    if (!record) return undefined
    if (!(type in record.components)) record.components[type] = {}
    return record.components[type]
  }

  /** Attach a component (replaces any existing data of that type). */
  setComponent(id, type, data) {
    const record = this._entities.get(id)
    if (!record) throw new Error(`no entity: ${id}`)
    record.components[type] = this._clone(data ?? {})
    return record.components[type]
  }

  /** Remove a component type from an entity. Returns true if it existed. */
  removeComponent(id, type) {
    const record = this._entities.get(id)
    if (!record) return false
    if (!(type in record.components)) return false
    return delete record.components[type]
  }

  /** Get an entity's parent id (or undefined if none). */
  getParent(id) {
    const record = this._entities.get(id)
    return record ? record.parent : undefined
  }

  /**
   * Set (or clear) an entity's transform parent.
   * @param {string} id
   * @param {string|null|undefined} parent  parent entity id, or null/undefined to clear
   * @returns {string|undefined} the new parent (undefined when cleared)
   */
  setParent(id, parent) {
    const record = this._entities.get(id)
    if (!record) throw new Error(`no entity: ${id}`)
    if (parent === undefined || parent === null || parent === '') {
      delete record.parent
      return undefined
    }
    if (typeof parent !== 'string') throw new TypeError('parent must be a non-empty string id')
    record.parent = parent
    return parent
  }

  /**
   * Get an entity's layer id (undefined when on the default layer).
   * @param {string} id
   * @returns {string|undefined}
   */
  getLayer(id) {
    const record = this._entities.get(id)
    return record ? record.layer : undefined
  }

  /**
   * Set (or clear) an entity's layer id. Passing null/'' clears it (default layer).
   * @returns {string|undefined} the new layer id (undefined when cleared).
   */
  setLayer(id, layer) {
    const record = this._entities.get(id)
    if (!record) return undefined
    if (layer === undefined || layer === null || layer === '') {
      delete record.layer
      return undefined
    }
    record.layer = String(layer)
    return record.layer
  }

  /** Get an entity's tags (empty array when it has none). Never mutates. */
  getTags(id) {
    const record = this._entities.get(id)
    return record && Array.isArray(record.tags) ? record.tags.slice() : []
  }

  /** Replace an entity's tags. @returns {string[]} the new tags. */
  setTags(id, tags) {
    const record = this._entities.get(id)
    if (!record) return []
    const list = Array.isArray(tags) ? tags.map(String) : []
    if (list.length > 0) record.tags = list
    else delete record.tags
    return this.getTags(id)
  }

  /** Add a single tag (no-op if already present). @returns {string[]} tags. */
  addTag(id, tag) {
    const record = this._entities.get(id)
    if (!record) return []
    if (!Array.isArray(record.tags)) record.tags = []
    const t = String(tag)
    if (!record.tags.includes(t)) record.tags.push(t)
    return this.getTags(id)
  }

  /** Remove a single tag. @returns {boolean} true if it was removed. */
  removeTag(id, tag) {
    const record = this._entities.get(id)
    if (!record || !Array.isArray(record.tags)) return false
    const i = record.tags.indexOf(String(tag))
    if (i < 0) return false
    record.tags.splice(i, 1)
    if (record.tags.length === 0) delete record.tags
    return true
  }

  /** True if the entity has the given tag. */
  hasTag(id, tag) {
    const record = this._entities.get(id)
    return !!(record && Array.isArray(record.tags) && record.tags.includes(String(tag)))
  }

  /** The scene's layer list, or null when the default layer list is in effect. */
  getLayers() {
    return this._layers
  }

  /** Set the scene's explicit layer list (or clear it back to defaults). */
  setLayers(layers) {
    this._layers = Array.isArray(layers) && layers.length > 0
      ? layers.map((l) => this._clone(l ?? {}))
      : null
    return this._layers
  }

  /**
   * Query entities by component presence. Supports `has`, `not`, `name`,
   * `layer`, and `tags` (matches entities whose tag list contains every listed
   * tag; an entity with no tags belongs to no explicit tag and matches only an
   * empty `tags` list).
   * @param {{ has?: string[], not?: string[], name?: string, layer?: string, tags?: string[] }} q
   * @returns {string[]} entity ids in insertion order.
   */
  query({ has = [], not = [], name, layer, tags, parent } = {}) {
    const hasList = Array.isArray(has) ? has : [has]
    const notList = Array.isArray(not) ? not : [not]
    const tagsList = Array.isArray(tags) ? tags : (tags ? [tags] : [])
    const out = []
    for (const [id, record] of this._entities) {
      if (name !== undefined && record.name !== name) continue
      if (layer !== undefined && (record.layer ?? 'default') !== layer) continue
      if (tagsList.length > 0) {
        const recTags = record.tags || []
        if (!tagsList.every((t) => recTags.includes(t))) continue
      }
      if (parent !== undefined) {
        const p = record.parent
        if (parent === null) { if (p != null) continue } else if (p !== parent) continue
      }
      let ok = true
      for (const t of hasList) {
        if (!(t in record.components)) { ok = false; break }
      }
      if (ok) {
        for (const t of notList) {
          if (t in record.components) { ok = false; break }
        }
      }
      if (ok) out.push(id)
    }
    return out
  }

  /**
   * Serialize to a plain JSON-safe object. Top-level shape:
   * { nextEntityId, entities: [{ id, name, parent?, layer?, tags?, components }],
   *   layers? }
   */
  toJSON() {
    const entities = []
    for (const [id, record] of this._entities) {
      const e = { id }
      if (record.name !== undefined) e.name = record.name
      if (record.parent !== undefined) e.parent = record.parent
      if (record.layer !== undefined) e.layer = record.layer
      if (Array.isArray(record.tags) && record.tags.length > 0) e.tags = record.tags.slice()
      e.components = this._clone(record.components)
      entities.push(e)
    }
    const out = { nextEntityId: this._nextEntityId, entities }
    if (this._layers && this._layers.length > 0) out.layers = this._clone(this._layers)
    return out
  }

  /**
   * Build a World from serialized JSON. Rejects duplicate ids and
   * non-integer/negative nextEntityId.
   * @param {object} data  Output of toJSON().
   * @returns {World}
   */
  static fromJSON(data) {
    if (!data || typeof data !== 'object') {
      throw new TypeError('world data must be an object')
    }
    if (!Array.isArray(data.entities)) {
      throw new TypeError('world.entities must be an array')
    }
    if (!Number.isInteger(data.nextEntityId) || data.nextEntityId < 0) {
      throw new TypeError('world.nextEntityId must be a non-negative integer')
    }
    const world = new World()
    world._nextEntityId = data.nextEntityId
    if (Array.isArray(data.layers) && data.layers.length > 0) {
      world._layers = world._clone(data.layers)
    }
    const seen = new Set()
    for (const ent of data.entities) {
      if (!ent || typeof ent.id !== 'string' || ent.id === '') {
        throw new TypeError('entity requires a non-empty string id')
      }
      if (seen.has(ent.id)) {
        throw new Error(`duplicate entity id in scene: ${ent.id}`)
      }
      seen.add(ent.id)
      const record = {
        name: ent.name,
        parent: (typeof ent.parent === 'string' && ent.parent !== '') ? ent.parent : undefined,
        layer: (typeof ent.layer === 'string' && ent.layer !== '') ? ent.layer : undefined,
        tags: Array.isArray(ent.tags) ? ent.tags.map(String) : undefined,
        components: world._clone(ent.components ?? {}),
      }
      if (record.tags !== undefined && record.tags.length === 0) delete record.tags
      world._entities.set(ent.id, record)
    }
    return world
  }

  _clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  }
}
