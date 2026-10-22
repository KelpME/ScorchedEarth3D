/**
 * Archetype nesting — the `base` chain resolver for archetype composition.
 *
 * An archetype definition may carry `base: '<otherArchetypeId>'`. Nesting
 * semantics:
 *  - components merge DEEPLY for plain-object values (own field wins, base
 *    fields the own def does not mention are INHERITED — a distro archetype
 *    can override just `render.material` and keep the base's `render.mesh`).
 *    Arrays (e.g. `scripts`) and primitives are replaced wholesale.
 *  - children CONCAT: base children first; an own child with the SAME `name`
 *    REPLACES the base child of that name (delta-overrides-a-part)
 *  - chains resolve transitively; cycles throw; a missing base throws
 *  - the instance record's own overrides still win over the whole resolved chain
 *    (handled by the caller — overrides are a SHALLOW per-component merge,
 *    which is the pre-existing instance contract and deliberately unchanged)
 *
 * Pure module: no scene/world imports, Node-testable, inputs never mutated.
 */

/** Plain-object check (excludes arrays and null). */
function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Deep merge `own` over `base`: plain objects merge per key recursively;
 * arrays, primitives, and `own`-only keys replace. `undefined` own values
 * never delete base values.
 */
function mergeDeep(base, own) {
  if (own === undefined) return base
  if (!isPlainObj(base) || !isPlainObj(own)) return own
  const out = { ...base }
  for (const k of Object.keys(own)) out[k] = mergeDeep(base[k], own[k])
  return out
}

/**
 * Components merge for NESTING: per top-level component key, deep-merge own
 * over base (see module doc). Distinct from `mergeArchetype` (the instance
 * override merge), which stays shallow by contract.
 */
function mergeComponentMapsDeep(baseComponents = {}, ownComponents = {}) {
  return mergeDeep(baseComponents, ownComponents)
}

/**
 * Fold `ownChildren` over `baseChildren`: same non-empty `name` REPLACES the
 * base child but DEEP-MERGES its components (own fields win, base fields the
 * own child omits are inherited — a derived archetype can override just a
 * logo's material and keep its mesh/transform). Children without a name, and
 * named children absent from the base, append. `offset` merges per-axis.
 */
function mergeChildren(baseChildren = [], ownChildren = []) {
  const out = [...baseChildren]
  for (const child of ownChildren) {
    const name = typeof child?.name === 'string' && child.name !== '' ? child.name : undefined
    const idx = name != null ? out.findIndex((c) => c.name === name) : -1
    if (idx >= 0) {
      const base = out[idx]
      const merged = {
        ...base,
        ...child,
        components: mergeDeep(base.components ?? {}, child.components ?? {}),
        offset: mergeDeep(base.offset ?? {}, child.offset ?? {}),
      }
      out[idx] = merged
    } else {
      out.push(child)
    }
  }
  return out
}

/**
 * Merge an archetype's base components with an instance's overrides.
 * Override wins per top-level component type key (shallow merge per key) —
 * the INSTANCE OVERRIDE contract, unchanged. (Nesting uses its own deep merge.)
 * @param {object} baseComponents
 * @param {object} overridesComponents
 * @returns {object} merged components (new object, inputs unmutated)
 */
export function mergeArchetype(baseComponents = {}, overridesComponents = {}) {
  return { ...baseComponents, ...overridesComponents }
}

/**
 * Resolve a nested-archetype chain starting at `rootId`, fetching each def
 * through `fetchDef(id)` (any id->def source: the game's archetype map, the
 * editor's loaded map, a test fixture). Returns the EFFECTIVE definition
 * { id, components, children? } with `base` stripped. Throws on cycles and
 * missing defs with actionable messages.
 *
 * @param {string} rootId
 * @param {(id: string) => object|undefined} fetchDef
 * @returns {object} effective definition { id, components, children? }
 */
export function resolveArchetypeChainById(rootId, fetchDef) {
  const chain = [] // [{ id, def }] root-most first
  const collect = (id) => {
    if (chain.some((c) => c.id === id)) {
      throw new Error(`archetype base cycle detected at "${id}" (chain: ${chain.map((c) => c.id).join(' -> ')})`)
    }
    const d = fetchDef(id)
    if (!d) {
      throw new Error(`archetype "${id}" not found (referenced as a base archetype)`)
    }
    chain.push({ id, def: d })
    if (d.base != null) collect(d.base)
  }
  collect(rootId)

  let components = {}
  let children = []
  for (const { id, def: d } of [...chain].reverse()) {
    components = mergeComponentMapsDeep(components, d.components ?? {})
    children = mergeChildren(children, d.children ?? [])
  }
  const eff = { id: rootId, components }
  if (children.length > 0) eff.children = children
  return eff
}

/**
 * Convenience wrapper: resolve the chain for `def` within a full archetype
 * id->def map.
 * @param {object} def  the archetype def (may carry `base`)
 * @param {Record<string, object>} all  the full archetype id -> def map
 * @returns {object} effective definition { id, components, children? }
 */
export function resolveArchetypeChain(def, all) {
  return resolveArchetypeChainById(def.id, (id) => all[id] ?? (id === def.id ? def : undefined))
}

/**
 * Merge a base archetype's effective definition with a derived archetype's own
 * definition (nesting merge): deep component merge + children concat with
 * same-name replacement. Both inputs unmutated.
 * @param {object} baseEff  effective base def { components, children? }
 * @param {object} ownDef   the derived archetype's own def { components, children? }
 * @returns {object} effective definition { id?, components, children? }
 */
export function mergeArchetypeWithBase(baseEff = {}, ownDef = {}) {
  const components = mergeComponentMapsDeep(baseEff.components ?? {}, ownDef.components ?? {})
  const children = mergeChildren(baseEff.children ?? [], ownDef.children ?? [])
  const eff = { components }
  if (ownDef.id != null) eff.id = ownDef.id
  else if (baseEff.id != null) eff.id = baseEff.id
  if (children.length > 0) eff.children = children
  return eff
}
