/**
 * ECS auto-batching -> InstancedMesh (FOUNDATION-PLAN.md §6, "day-one").
 *
 * Two entities share a batch iff they share the same mesh, the same material
 * instance, and have no per-instance variation that instancing can't express
 * (a uniform tint is fine; a unique material, damage decals, or a
 * skinned/skeletal mesh is not).
 *
 * This module computes the **batch key** and groups entities into batches.
 * It is pure JS (no Three.js) so the grouping logic is unit-testable; the
 * render layer consumes the batch list to build InstancedMeshes.
 */
export const SKINNED = 'skinned' // skinned/animated meshes do not instance

/**
 * Compute the batch key for an entity's renderable descriptor.
 *
 * @param {{ mesh: string, material: string|number, skinned?: boolean, tint?: [number,number,number]|null, materialParams?: object }} r
 * @returns {string} a stable batch key, or null if the entity must render
 *   individually (skinned/skeletal mesh, or missing mesh).
 */
export function batchKey(r) {
  // An entity with NO material (empty/undefined) still renders — through the
  // renderer's shared default material (_material('') falls back to it) — so
  // it must still BATCH. Historically a missing material returned null here,
  // which silently DROPPED the entity from every render pass: groupBatches
  // skipped it (null key) and _updateSkinned only picks up skinned/unique-
  // material entities, so the object drew nothing while its selection
  // outline (always a box) made it look "stuck as a box" when the inspector
  // changed render.mesh. The '' key segment keeps default-material entities
  // in their own batch (never merged with a real named material batch).
  if (!r || !r.mesh) return null
  if (r.skinned === true) return null // skinned meshes bypass the system
  if (r.uniqueMaterial === true) return null // custom shader materials opt OUT (R3)
  let key = `${r.mesh}|${r.material || ''}`
  // Per-entity shadow control is part of batch identity. three's castShadow /
  // receiveShadow are per-Object3D (the WHOLE InstancedMesh), NOT per-instance,
  // so two entities that differ in shadow flags cannot share a batch — the
  // entity that turned shadows off must break out into its own InstancedMesh.
  // Identical flags still batch together, so batching is preserved (never
  // regressed to one-draw-per-entity). The suffix is added ONLY when a flag is
  // non-default (off), so default-shadow entities keep the plain name key and
  // existing batch keys stay stable.
  const { castShadow, receiveShadow } = resolveShadow(r)
  if (castShadow === false || receiveShadow === false) {
    key += `|s:${castShadow ? 1 : 0}${receiveShadow ? 1 : 0}`
  }
  // A per-entity materialParams override is part of the batch identity: two
  // entities with IDENTICAL params share a batch (instanced — no per-entity
  // draw), and an entity with different params gets its own. Editing the
  // params string (e.g. color) that this key derives from still groups
  // identical entities together, so batching is preserved, never regressed to
  // one-draw-per-entity.
  if (r.materialParams && typeof r.materialParams === 'object') {
    key += `|p:${stableStringify(r.materialParams)}`
  }
  return key
}

/**
 * Resolve an entity's effective shadow flags, defaulting to ON (matches the
 * engine's long-standing default: every rendered object casts + receives).
 * castShadow=false stops the object being rendered into any light's shadow
 * map; receiveShadow=false stops it displaying shadows cast onto it.
 * @param {{ castShadow?: boolean, receiveShadow?: boolean }|null} r
 * @returns {{ castShadow: boolean, receiveShadow: boolean }}
 */
export function resolveShadow(r) {
  return {
    castShadow: !r || r.castShadow !== false,
    receiveShadow: !r || r.receiveShadow !== false,
  }
}

/**
 * Group renderable descriptors into batches.
 *
 * @param {Array<{ id: string, ...r }>} items  entities with render fields
 * @returns {Array<{ key: string, mesh: string, material: string|number, materialParams?: object, ids: string[] }>}
 *   one entry per distinct batch key (insertion order of first occurrence).
 *   Entities with a null batch key are NOT included here; the caller handles
 *   them as individual meshes.
 */
export function groupBatches(items) {
  const order = []
  const map = new Map() // key -> { key, mesh, material, materialParams, ids }
  for (const item of items) {
    const key = batchKey(item)
    if (key === null) continue
    let batch = map.get(key)
    if (!batch) {
      const { castShadow, receiveShadow } = resolveShadow(item)
      batch = { key, mesh: item.mesh, material: item.material, materialParams: item.materialParams, castShadow, receiveShadow, ids: [] }
      map.set(key, batch)
      order.push(batch)
    }
    batch.ids.push(item.id)
  }
  return order
}

/**
 * Decide whether an entity must break out of its batch to render individually.
 * Returns null if it stays instanced, or the reason string if it must break.
 *
 * @param {{ skinned?: boolean, uniqueMaterial?: boolean, decals?: boolean, mesh?: string, material?: string|number }} r
 * @returns {string|null}
 */
export function breakoutReason(r) {
  if (!r || !r.mesh || !r.material) return 'missing-mesh-or-material'
  if (r.skinned === true) return SKINNED
  if (r.uniqueMaterial === true) return 'unique-material'
  if (r.decals === true) return 'damage-decals'
  return null
}

/**
 * Given a descriptor, does it support a per-instance uniform tint?
 * (A uniform tint is fine; a unique material is not.)
 */
export function supportsInstancedTint(r) {
  return !r || breakoutReason(r) === null
}

/**
 * Deterministic JSON-ish serialization with sorted keys, so two entities whose
 * materialParams have the same values (in any key order) share a batch key.
 * @param {*} obj
 * @returns {string}
 */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
