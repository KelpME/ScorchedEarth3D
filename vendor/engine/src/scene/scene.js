/**
 * Scene authoring: validation, migration, archetypes, SceneBuilder hydration,
 * and world-transform resolution for transform parenting.
 *
 * Vocabulary (scene format v3, 2026-09-27): an **archetype** is the authored
 * template; an entity authored from one is an **archetype instance** — a
 * description, never a separate noun. A scene is a JSON object:
 *   {
 *     version: <int>,
 *     nextEntityId: <int>,
 *     entities: [{ id, name?, parent?, components?, archetypeId?, overrides? }],
 *     archetypes?: { <archetypeId>: { components: {...}, children?: [...] } }
 *   }
 *
 * `parent` is an optional entity id on a record: transform parenting. An
 * entity's stored `transform` is its LOCAL position; its world position =
 * parent's world position + local, resolved recursively (see
 * resolveWorldTransforms).
 *
 * PROVENANCE IS A FIELD, NOT A TYPE: a record may carry `archetypeId` (+ an
 * optional `overrides` bag). Hydration branches on its presence: present → the
 * archetype chain resolves and base+overrides merge at hydration; absent → the
 * record hydrates as-is. Archetypes are lightweight data templates. No
 * propagation, no shared mutable state. Serialization must round-trip
 * losslessly. The pre-v3 second instance array is REJECTED (hard cut): the
 * fold lives only in the dated migration tool — see validateScene's error.
 */

import { COLLIDER_SHAPES, RENDER_PRIMITIVES } from '../catalog/shapes.js'
import { normalizeLayers } from '../physics/layers.js'
import { JOINT_TYPES } from '../components/joint.js'
import { mergeArchetype, resolveArchetypeChainById } from './archetype-nesting.js'

// Sanctioned literal (plans/ENTITY-UNIFICATION.md §Gate): the ONLY occurrence
// of the legacy pre-v3 format key in engine source. Detection only — the key
// is hard-cut rejected here and never read.
export const LEGACY_INSTANCE_KEY = 'eidolons'

/** The implicit layer id an entity belongs to when it has no explicit layer. */
export const DEFAULT_LAYER = 'default'

/** Field-level numeric guards for rigid-body physics validation. */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const hasPos = (v) => isNum(v) && v > 0

/**
 * Maximum number of archetype instances a single archetype may be
 * instantiated as in one scene. Beyond this, the scene is almost certainly a
 * materialization hazard: every instance gets a full model loaded into the
 * editor's renderer heap, so a pathological count (e.g. 6,000+ decorative
 * trees) OOMs the editor even though it renders fine via batching. This is
 * the "repeated archetype" guard — it catches the class of bug, not just
 * trees: any archetype spawned hundreds of times (trees, rocks, buildings,
 * enemies) trips it. It never blocks a single reasonable spawn (a flock of 30
 * fish is fine); it flags the pathological case. @see validateScene
 */
export const MAX_INSTANCES_PER_ARCHETYPE = 500

/** The built-in default layer list used when a scene defines none. */
export function defaultLayers() {
  return [{ id: DEFAULT_LAYER, name: 'Default', visible: true, locked: false, color: '#8a8f98' }]
}

/**
 * Resolve a scene's effective layer list: the explicit `scene.layers` array
 * when present and non-empty, otherwise the default single-layer list. The
 * scene is NOT mutated (callers that want to persist the list materialize it
 * explicitly). @returns {Array<{id,name,visible,locked,color}>}
 */
export function resolveLayers(scene) {
  if (scene && Array.isArray(scene.layers) && scene.layers.length > 0) return scene.layers
  return defaultLayers()
}

/**
 * Resolve a scene's effective tag palette: the explicit `scene.tags` array
 * (a list of tag-name strings) when present, otherwise `[]`. The palette is
 * scene-level metadata (tags available to assign), independent of the tags
 * actually on entities. The scene is NOT mutated.
 * @returns {string[]}
 */
export function resolveTags(scene) {
  if (scene && Array.isArray(scene.tags)) return scene.tags.filter((t) => typeof t === 'string')
  return []
}

/** Validate a scene, returning a list of field-level error strings ([] = valid). */
export function validateScene(scene) {
  const errors = []
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
    return ['scene must be a non-array object']
  }
  // HARD CUT (scene format v3): a scene carrying the pre-v3 legacy instance
  // array is rejected outright with an actionable pointer to the migration
  // tool — the engine never folds or hydrates it. plans/ENTITY-UNIFICATION.md
  // §Gate sanctions exactly this one literal in engine source; tests import
  // the constant, adding no further occurrences. (The ERROR MESSAGE names no
  // legacy term either.)
  if (Object.prototype.hasOwnProperty.call(scene, LEGACY_INSTANCE_KEY)) {
    errors.push('pre-v3 scene: legacy instance array present — run tools/migration/2026-09-27-entities-unification.mjs')
  }
  // Migration shim: canonicalize legacy component shapes so old scenes
  // validate against the current vocabulary.
  scene = normalizeScene(scene)
  if (!Number.isInteger(scene.version)) {
    errors.push('scene.version must be an integer')
  }
  if (!Number.isInteger(scene.nextEntityId) || scene.nextEntityId < 0) {
    errors.push('scene.nextEntityId must be a non-negative integer')
  }
  // Optional scene-level layer definitions: [{ id, name, visible?, locked?, color? }].
  if (scene.layers !== undefined) {
    if (!Array.isArray(scene.layers)) {
      errors.push('scene.layers must be an array')
    } else {
      const layerIds = new Set()
      for (let i = 0; i < scene.layers.length; i++) {
        const l = scene.layers[i]
        if (!l || typeof l !== 'object') {
          errors.push(`scene.layers[${i}] must be an object`)
          continue
        }
        if (typeof l.id !== 'string' || l.id === '') {
          errors.push(`scene.layers[${i}].id must be a non-empty string`)
        } else if (layerIds.has(l.id)) {
          errors.push(`duplicate layer id: ${l.id}`)
        } else {
          layerIds.add(l.id)
        }
        if (l.name !== undefined && typeof l.name !== 'string') {
          errors.push(`scene.layers[${i}].name must be a string`)
        }
      }
    }
  }
  // Optional scene-level tag palette: a list of non-empty string tag names.
  if (scene.tags !== undefined) {
    if (!Array.isArray(scene.tags)) {
      errors.push('scene.tags must be an array')
    } else {
      const tagSeen = new Set()
      for (let i = 0; i < scene.tags.length; i++) {
        const t = scene.tags[i]
        if (typeof t !== 'string' || t.trim() === '') {
          errors.push(`scene.tags[${i}] must be a non-empty string`)
        } else if (tagSeen.has(t)) {
          errors.push(`duplicate tag: ${t}`)
        } else {
          tagSeen.add(t)
        }
      }
    }
  }
  // Optional scene-level physics settings: { gravity?, snapDist?, enabled? }.
  if (scene.physics !== undefined) {
    if (!scene.physics || typeof scene.physics !== 'object' || Array.isArray(scene.physics)) {
      errors.push('scene.physics must be an object')
    } else {
      if (scene.physics.gravity !== undefined) {
        const g = scene.physics.gravity
        // TWO accepted forms, ONE canonical meaning: a scalar magnitude
        // (legacy scenes, applied along −Y) or a {x,y,z} vector (P1 editor
        // form; the Y magnitude is the world gravity the engine reads).
        const scalarOk = typeof g === 'number' && Number.isFinite(g)
        const vecOk = g && typeof g === 'object' && !Array.isArray(g)
          && Number.isFinite(g.x) && Number.isFinite(g.y) && Number.isFinite(g.z)
        if (!scalarOk && !vecOk) {
          errors.push('scene.physics.gravity must be a finite number or a finite {x,y,z} vector')
        }
      }
      if (scene.physics.snapDist !== undefined && (typeof scene.physics.snapDist !== 'number' || !Number.isFinite(scene.physics.snapDist) || scene.physics.snapDist < 0)) {
        errors.push('scene.physics.snapDist must be a non-negative finite number')
      }
      if (scene.physics.enabled !== undefined && typeof scene.physics.enabled !== 'boolean') {
        errors.push('scene.physics.enabled must be a boolean')
      }
      if (scene.physics.floorTag !== undefined && (typeof scene.physics.floorTag !== 'string' || scene.physics.floorTag.trim() === '')) {
        errors.push('scene.physics.floorTag must be a non-empty string')
      }
      // P4a T1: physics.layers block — structural validation (≤32 unique
      // non-empty string names). Field-level messages come from normalizeLayers.
      if (scene.physics.layers !== undefined) {
        try {
          normalizeLayers(scene.physics.layers)
        } catch (e) {
          errors.push(`scene.physics.layers: ${e.message}`)
        }
      }
    }
  }
  // Optional scene-level global systems: [{ name, params? }] — per-frame update order.
  if (scene.systems !== undefined) {
    if (!Array.isArray(scene.systems)) {
      errors.push('scene.systems must be an array')
    } else {
      const seenSystems = new Set()
      for (let i = 0; i < scene.systems.length; i++) {
        const sys = scene.systems[i]
        if (!sys || typeof sys !== 'object') {
          errors.push(`scene.systems[${i}] must be an object`)
          continue
        }
        if (typeof sys.name !== 'string' || sys.name === '') {
          errors.push(`scene.systems[${i}].name must be a non-empty string`)
        } else if (seenSystems.has(sys.name)) {
          errors.push(`duplicate system name: ${sys.name}`)
        } else {
          seenSystems.add(sys.name)
        }
        if (sys.params !== undefined && (sys.params === null || typeof sys.params !== 'object' || Array.isArray(sys.params))) {
          errors.push(`scene.systems[${i}].params must be an object`)
        }
      }
    }
  }
  // Optional scene-level materials map: { <name>: def } — data-driven materials
  // (RENDERING-PIPELINE.md §R1). Each def is { type?, color?, roughness?,
  // metalness?, emissive?, emissiveIntensity?, map?, normalMap? }.
  if (scene.materials !== undefined) {
    if (!scene.materials || typeof scene.materials !== 'object' || Array.isArray(scene.materials)) {
      errors.push('scene.materials must be an object')
    } else {
      for (const [name, def] of Object.entries(scene.materials)) {
        if (typeof name !== 'string' || name === '') {
          errors.push('scene.materials keys must be non-empty strings')
        } else if (!def || typeof def !== 'object' || Array.isArray(def)) {
          errors.push(`scene.materials.${name} must be an object`)
        } else {
          if (def.type !== undefined && !['standard', 'physical', 'basic', 'custom'].includes(def.type)) {
            errors.push(`scene.materials.${name}.type must be standard|physical|basic|custom`)
          }
          if (def.type === 'custom' && (typeof def.shader !== 'string' || def.shader === '')) {
            errors.push(`scene.materials.${name}.shader must be a non-empty string (a custom material references a folder shader by name)`)
          }
          if (def.uniforms !== undefined && (def.uniforms === null || typeof def.uniforms !== 'object' || Array.isArray(def.uniforms))) {
            errors.push(`scene.materials.${name}.uniforms must be an object`)
          }
          for (const k of ['color', 'emissive']) {
            if (def[k] !== undefined && typeof def[k] !== 'string') {
              errors.push(`scene.materials.${name}.${k} must be a string`)
            }
          }
          for (const k of ['roughness', 'metalness', 'emissiveIntensity']) {
            if (def[k] !== undefined && (typeof def[k] !== 'number' || !Number.isFinite(def[k]))) {
              errors.push(`scene.materials.${name}.${k} must be a finite number`)
            }
          }
        }
      }
    }
  }
  // Optional scene-level lights array: [{ type, color?, intensity?, position?,
  //   castShadow?, shadow? }] — data-driven lights (RENDERING-PIPELINE.md §R4).
  if (scene.lights !== undefined) {
    if (!Array.isArray(scene.lights)) {
      errors.push('scene.lights must be an array')
    } else {
      const seenLight = new Set()
      for (let i = 0; i < scene.lights.length; i++) {
        const l = scene.lights[i]
        if (!l || typeof l !== 'object' || typeof l.type !== 'string' || l.type === '') {
          errors.push(`scene.lights[${i}] must be an object with a non-empty type`)
          continue
        }
        if (!['directional', 'point', 'spot', 'hemisphere', 'ambient'].includes(l.type)) {
          errors.push(`scene.lights[${i}].type must be directional|point|spot|hemisphere|ambient`)
        } else if (seenLight.has(l.type)) {
          errors.push(`duplicate light type: ${l.type}`)
        } else {
          seenLight.add(l.type)
        }
        if (l.color !== undefined && typeof l.color !== 'string') errors.push(`scene.lights[${i}].color must be a string`)
        if (l.intensity !== undefined && (typeof l.intensity !== 'number' || !Number.isFinite(l.intensity))) {
          errors.push(`scene.lights[${i}].intensity must be a finite number`)
        }
        if (l.position !== undefined && (!Array.isArray(l.position) || l.position.length < 3)) {
          errors.push(`scene.lights[${i}].position must be a [x,y,z] array`)
        }
        if (l.castShadow !== undefined && typeof l.castShadow !== 'boolean') {
          errors.push(`scene.lights[${i}].castShadow must be a boolean`)
        }
        if (l.shadow !== undefined && (l.shadow === null || typeof l.shadow !== 'object' || Array.isArray(l.shadow))) {
          errors.push(`scene.lights[${i}].shadow must be an object`)
        }
      }
    }
  }
  // Optional scene-level render settings: { post?, shadows? } — data-driven rendering.
  // `post` is the R2 post-processing block { enabled, passes:[{type,params}] }.
  if (scene.render !== undefined) {
    if (!scene.render || typeof scene.render !== 'object' || Array.isArray(scene.render)) {
      errors.push('scene.render must be an object')
    } else {
      if (scene.render.shadows !== undefined) {
        const sh = scene.render.shadows
        if (!sh || typeof sh !== 'object' || Array.isArray(sh)) {
          errors.push('scene.render.shadows must be an object')
        } else if (sh.type !== undefined && !['PCFSoftShadowMap', 'PCFShadowMap', 'VSMShadowMap', 'BasicShadowMap'].includes(sh.type)) {
          errors.push('scene.render.shadows.type must be PCFSoftShadowMap|PCFShadowMap|VSMShadowMap|BasicShadowMap')
        }
      }
    if (scene.render.post !== undefined) {
      const post = scene.render.post
      if (!post || typeof post !== 'object' || Array.isArray(post)) {
        errors.push('scene.render.post must be an object')
      } else {
        if (post.enabled !== undefined && typeof post.enabled !== 'boolean') {
          errors.push('scene.render.post.enabled must be a boolean')
        }
        if (post.passes !== undefined && !Array.isArray(post.passes)) {
          errors.push('scene.render.post.passes must be an array')
        } else if (Array.isArray(post.passes)) {
          const seenPass = new Set()
          for (let i = 0; i < post.passes.length; i++) {
            const p = post.passes[i]
            if (!p || typeof p !== 'object' || typeof p.type !== 'string' || p.type === '') {
              errors.push(`scene.render.post.passes[${i}] must be an object with a non-empty type`)
              continue
            }
            if (!['grade', 'bloom', 'vignette', 'grain'].includes(p.type)) {
              // Custom post-FX scripts are a valid pass type; unknown names are
              // rejected at build time (createPostFX) with a loud error.
            } else if (seenPass.has(p.type)) {
              errors.push(`duplicate post pass type: ${p.type}`)
            } else {
              seenPass.add(p.type)
            }
            if (p.params !== undefined && (p.params === null || typeof p.params !== 'object' || Array.isArray(p.params))) {
              errors.push(`scene.render.post.passes[${i}].params must be an object`)
            }
          }
        }
      }
    }
  }
  }
  const knownIds = new Set()
  if (!Array.isArray(scene.entities)) {
    errors.push('scene.entities must be an array')
  } else {
    const seen = new Set()
    for (let i = 0; i < scene.entities.length; i++) {
      const ent = scene.entities[i]
      if (!ent || typeof ent !== 'object') {
        errors.push(`entities[${i}] must be an object`)
        continue
      }
      if (typeof ent.id !== 'string' || ent.id === '') {
        errors.push(`entities[${i}].id must be a non-empty string`)
      } else if (seen.has(ent.id)) {
        errors.push(`duplicate entity id: ${ent.id}`)
      } else {
        seen.add(ent.id)
        knownIds.add(ent.id)
      }
      if (ent.parent !== undefined && ent.parent !== null) {
        if (typeof ent.parent !== 'string' || ent.parent === '') {
          errors.push(`entities[${i}].parent must be a non-empty string id`)
        } else if (ent.id === ent.parent) {
          errors.push(`entities[${i}].parent must not reference itself: ${ent.id}`)
        }
      }
      if (ent.layer !== undefined && ent.layer !== null) {
        if (typeof ent.layer !== 'string' || ent.layer === '') {
          errors.push(`entities[${i}].layer must be a non-empty string`)
        }
      }
      if (ent.tags !== undefined && ent.tags !== null) {
        if (!Array.isArray(ent.tags)) {
          errors.push(`entities[${i}].tags must be an array of strings`)
        } else {
          for (let t = 0; t < ent.tags.length; t++) {
            if (typeof ent.tags[t] !== 'string') {
              errors.push(`entities[${i}].tags[${t}] must be a string`)
            }
          }
        }
      }
      if (ent.components !== undefined && (typeof ent.components !== 'object' || ent.components === null || Array.isArray(ent.components))) {
        errors.push(`entities[${i}].components must be an object`)
      }
      // Provenance (v3): an entity record MAY be authored from an archetype —
      // `archetypeId` (+ optional `overrides`) live ON the record.
      if (ent.archetypeId !== undefined && (typeof ent.archetypeId !== 'string' || ent.archetypeId === '')) {
        errors.push(`entities[${i}].archetypeId must be a non-empty string`)
      }
      if (ent.overrides !== undefined && (ent.overrides === null || typeof ent.overrides !== 'object' || Array.isArray(ent.overrides))) {
        errors.push(`entities[${i}].overrides must be an object`)
      }
    }
    // Dangling parent references (parent id doesn't exist) are field-level
    // errors — parenting a child to a missing entity is a real bug. One id
    // namespace: plain records and archetype instances share it.
    for (const ent of scene.entities) {
      if (ent && typeof ent.parent === 'string' && ent.parent && !knownIds.has(ent.parent)) {
        errors.push(`entity "${ent.id}" has a parent "${ent.parent}" that does not exist`)
      }
    }
    // Component vocabulary validation — a collider `shape` or render `mesh`
    // that isn't a known value is a real bug (it silently renders/collides as
    // a box otherwise), so ERROR on it rather than falling back. Walks every
    // serialized component container: a record's own `components` AND its
    // `overrides.components` (the per-instance override bag).
    // (The valid sets come from the engine shape catalog — the single source
    // of truth for render primitives / collider shapes.)
    const containers = []
    const jointPairs = []
    for (const ent of scene.entities || []) {
      if (ent && ent.id && ent.components) containers.push([`entity "${ent.id}"`, ent.components, ent.id])
      if (ent && ent.id && ent.overrides && ent.overrides.components) {
        containers.push([`entity "${ent.id}" overrides`, ent.overrides.components, ent.id])
      }
    }
    for (const [label, comps, selfId] of containers) {
      const col = comps.collider
      if (col && col.shape !== undefined && !COLLIDER_SHAPES.includes(col.shape)) {
        errors.push(`${label} collider.shape must be one of ${COLLIDER_SHAPES.join('|')} (got "${col.shape}")`)
      }
      // P4a T1: physics layers. Unknown collider.layer / collider.mask names
      // are real bugs (the pair/raycast filter would silently exclude), so
      // ERROR rather than fall back. layerNames defaults to ['default'].
      const layerNames = scene.physics && scene.physics.layers
        ? normalizeLayers(scene.physics.layers).names
        : ['default']
      if (col && typeof col === 'object' && !Array.isArray(col)) {
        if (col.layer !== undefined && !layerNames.includes(col.layer)) {
          errors.push(`${label} collider.layer "${col.layer}" is not in physics.layers.names [${layerNames.join(', ')}]`)
        }
        if (col.mask !== undefined) {
          if (!Array.isArray(col.mask)) {
            errors.push(`${label} collider.mask must be an array of layer names`)
          } else {
            for (const m of col.mask) {
              if (typeof m !== 'string' || !layerNames.includes(m)) {
                errors.push(`${label} collider.mask entry "${m}" is not in physics.layers.names [${layerNames.join(', ')}]`)
              }
            }
          }
        }
      }
      const ren = comps.render
      if (ren && ren.mesh !== undefined && ren.mesh !== '' && !RENDER_PRIMITIVES.includes(ren.mesh)) {
        errors.push(`${label} render.mesh must be one of ${RENDER_PRIMITIVES.join('|')} or a model via render.modelName (got "${ren.mesh}")`)
      }
      // Physics rules (P1): rigid-body/velocity field-level validation. These
      // fire for plain entities AND instance override bags via the same containers.
      const rb = comps['rigid-body']
      if (rb && typeof rb === 'object' && !Array.isArray(rb)) {
        if (!col) errors.push(`${label} rigid-body requires a collider component`)
        const mass = rb.mass, density = rb.density
        if (mass !== undefined || density !== undefined) {
          if (mass !== undefined && (!isNum(mass) || mass < 0)) {
            errors.push(`${label} rigid-body mass must be positive (got ${mass})`)
          } else if (!hasPos(mass) && !hasPos(density)) {
            // No viable mass source: mass <= 0 AND density <= 0 (or missing).
            errors.push(`${label} rigid-body mass must be positive when density is not positive (got mass ${mass}, density ${density})`)
          }
        }
        if (rb.isKinematic === true && isNum(mass) && mass > 0) {
          errors.push(`${label} rigid-body isKinematic bodies must not carry mass > 0 (got mass ${mass})`)
        }
        if (rb.velocity !== undefined && (!Array.isArray(rb.velocity) || rb.velocity.length !== 3 || !rb.velocity.every((x) => typeof x === 'number' && Number.isFinite(x)))) {
          errors.push(`${label} rigid-body velocity must be three finite numbers [vx,vy,vz]`)
        }
        for (const k of ['restitution', 'friction']) {
          if (rb[k] !== undefined && (!isNum(rb[k]) || rb[k] < 0 || rb[k] > 1)) {
            errors.push(`${label} rigid-body ${k} must be a number in 0..1 (got ${rb[k]})`)
          }
        }
        if (rb.linearDamping !== undefined && (!isNum(rb.linearDamping) || rb.linearDamping < 0)) {
          errors.push(`${label} rigid-body linearDamping must be a non-negative finite number (got ${rb.linearDamping})`)
        }
        if (rb.gravityScale !== undefined && !isNum(rb.gravityScale)) {
          errors.push(`${label} rigid-body gravityScale must be a finite number (got ${rb.gravityScale})`)
        }
        // P4d: ccd opts the body's integration into swept (continuous)
        // movement — must be a boolean when authored.
        if (rb.ccd !== undefined && typeof rb.ccd !== 'boolean') {
          errors.push(`${label} rigid-body ccd must be a boolean (got ${rb.ccd})`)
        }
      }
      const vel = comps.velocity
      if (vel && typeof vel === 'object' && Array.isArray(vel.v)) {
        if (!vel.v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
          errors.push(`${label} velocity v elements must be finite numbers (got [${vel.v.join(', ')}])`)
        }
      }
      // P4c: joint rules — a dangling/self-referencing `other`, an unknown
      // type, a negative breakForce, or a duplicate joint pair are real bugs
      // (the joint would silently do nothing or, worse, wake/sleep bodies
      // that were never meant to be coupled). Checked against the known-id
      // set (all entity records). Pair duplication is checked
      // per-container pair (A→B twice on A) and cross-body (A→B with B→A):
      // both describe the same physical constraint.
      const j = comps.joint
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        if (typeof j.other !== 'string' || j.other === '') {
          errors.push(`${label} joint.other must be the entity id of the joined body (got ${JSON.stringify(j.other)})`)
        } else if (j.other === selfId) {
          errors.push(`${label} joint.other must not reference the joint's own entity (${selfId})`)
        } else if (knownIds.has(j.other) === false) {
          errors.push(`${label} joint.other references entity "${j.other}" that does not exist`)
        } else {
          jointPairs.push([selfId, j.other])
        }
        if (j.type !== undefined && !JOINT_TYPES.includes(j.type)) {
          errors.push(`${label} joint.type must be one of ${JOINT_TYPES.join('|')} (got "${j.type}")`)
        }
        if (j.breakForce !== undefined && (!isNum(j.breakForce) || j.breakForce < 0)) {
          errors.push(`${label} joint breakForce must be a non-negative finite number (0 = unbreakable; got ${j.breakForce})`)
        }
        // P4c-3 fields: limits + motor. Limits only make sense as a pair
        // (min ≤ max); a lone bound is allowed (open-ended). The motor must
        // be finite, and its strength cannot be negative.
        if (j.jointLimitMin !== undefined && !isNum(j.jointLimitMin)) {
          errors.push(`${label} joint jointLimitMin must be a finite number (got ${j.jointLimitMin})`)
        }
        if (j.jointLimitMax !== undefined && !isNum(j.jointLimitMax)) {
          errors.push(`${label} joint jointLimitMax must be a finite number (got ${j.jointLimitMax})`)
        }
        if (isNum(j.jointLimitMin) && isNum(j.jointLimitMax) && j.jointLimitMin > j.jointLimitMax) {
          errors.push(`${label} joint jointLimitMin (${j.jointLimitMin}) must be <= jointLimitMax (${j.jointLimitMax})`)
        }
        if (j.motorSpeed !== undefined && !isNum(j.motorSpeed)) {
          errors.push(`${label} joint motorSpeed must be a finite number (got ${j.motorSpeed})`)
        }
        if (j.maxMotorForce !== undefined && (!isNum(j.maxMotorForce) || j.maxMotorForce < 0)) {
          errors.push(`${label} joint maxMotorForce must be a non-negative finite number (0 = no motor; got ${j.maxMotorForce})`)
        }
        for (const k of ['anchorA', 'anchorB', 'axis']) {
          if (j[k] !== undefined && (!Array.isArray(j[k]) || j[k].length !== 3 || !j[k].every((x) => typeof x === 'number' && Number.isFinite(x)))) {
            errors.push(`${label} joint ${k} must be three finite numbers [x,y,z]`)
          }
        }
        if (j.collideConnected !== undefined && typeof j.collideConnected !== 'boolean') {
          errors.push(`${label} joint collideConnected must be a boolean`)
        }
      }
    }
    // Duplicate joint pairs, canonicalized (sorted pair key) so A→B and B→A
    // count as the same constraint. A pair seen twice = one error each.
    const seenPairs = new Map()
    for (const [a, b] of jointPairs) {
      const key = [a, b].sort().join('|')
      const count = (seenPairs.get(key) || 0) + 1
      seenPairs.set(key, count)
      if (count > 1) errors.push(`duplicate joint pair ${a}→${b} (both directions count as the same joint)`)
    }
  }
  return errors
}

/**
 * Count the model-name distribution across all hydrated entities (after
 * archetype `render.modelName` merges are accounted via the overrides bag).
 * This is the materialization report the editor uses to warn when one model
 * type is loaded an unreasonable number of times — the same "repeated
 * archetype" signal as the validateScene multiplicity check, but computed
 * against the hydrated model names so it catches runtime-spawned repetition
 * too.
 *
 * @param {object} scene  a normalized scene (validated shape).
 * @returns {Array<{ model: string, count: number }>}  sorted desc by count.
 */
export function sceneMaterializationReport(scene) {
  if (!scene || typeof scene !== 'object') return []
  const byModel = new Map()
  const bump = (mn) => {
    if (typeof mn !== 'string' || mn === '') return
    const base = mn.replace(/^model\//, '')
    byModel.set(base, (byModel.get(base) || 0) + 1)
  }
  for (const ent of scene.entities || []) {
    if (ent && ent.components && ent.components.render) bump(ent.components.render.modelName)
    // An archetype instance whose override carries its own render.modelName.
    if (ent && ent.overrides && ent.overrides.components && ent.overrides.components.render) {
      bump(ent.overrides.components.render.modelName)
    }
  }
  const out = [...byModel.entries()].map(([model, count]) => ({ model, count }))
  out.sort((a, b) => b.count - a.count)
  return out
}

/**
 * Canonicalize legacy component shapes (the migration shim). The pre-v3
 * instance-array fold does NOT live here — the engine hard-cuts that format
 * (validateScene rejects it); the fold lives only in the dated migration
 * tool. This function only re-shapes legacy COMPONENT data (render.scale,
 * hud, velocity) and returns a NEW scene in the current form. Pure: inputs
 * are unmutated.
 */
export function normalizeScene(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return scene
  const out = { ...scene }
  // Scale now lives on the TRANSFORM (the single TRS owner), not `render`.
  // Move any legacy `render.scale` into `transform.scale` (entity records and
  // archetype definitions) so old scenes load unchanged.
  // Finally, migrate a legacy `hud` component (WS3) into the ECS canvas +
  // widget model (WS3-Pro) — see migrateHudToCanvas. And fold a legacy
  // `velocity` component into `rigid-body.velocity` (P3.5 — live velocity is
  // motion-map state; the component was only ever authored spawn data).
  return migrateVelocityToRigidBody(migrateHudToCanvas(migrateScaleToTransform(out)))
}

/**
 * Move a legacy `render.scale` into `transform.scale` — scale belongs on the
 * transform (full TRS), not the render component. Applied to plain entity
 * records, instance override bags, and archetype definitions. Pure: inputs
 * are unmutated. If `transform.scale` is already present it wins (the stale
 * `render.scale` is still dropped — the renderer never reads it).
 */
/**
 * Move a legacy `render.scale` into `transform.scale` on ONE component set.
 * The same rule the scene-level migration applies, usable by paths that build
 * component sets outside a scene record (instance child hydration, runtime
 * placement). Pure: inputs are unmutated. If `transform.scale` is already
 * present it wins (the stale `render.scale` is still dropped — the renderer
 * never reads it).
 *
 * FLOCK-REGION EXCEPTION (region scale doctrine): an entity carrying a `flock`
 * script is a REGION — a container/boid-volume entity whose members spawn as
 * CHILDREN. A legacy `render.scale` on it was authored as the flock VOLUME's
 * size (sizeX/Y/Z) so the old pre-TRS volume preview showed the box — it was
 * never a TRS scale. Moving it into `transform.scale` made the region a scaled
 * parent and every fish child inherited [sizeX, sizeY, sizeZ] through the
 * render hierarchy, scattering the whole school across the map. So on flock
 * regions the legacy `render.scale` is DROPPED (never moved) and any authored
 * `transform.scale` is forced back to identity [1,1,1] — regions are sized by
 * the flock params (shape + sizeX/Y/Z), which the editor's volume gizmo reads
 * directly; the transform is position-only. The volume's VISUAL box is drawn by
 * the gizmo scaling its own unit mesh (addons/forge-flock flockVolume.js), so
 * the size preview does not need an entity scale.
 */
/** Does this component set carry a `flock` script (i.e. a flock region)? */
function isFlockRegionComponents(components) {
  if (!components || typeof components !== 'object' || Array.isArray(components)) return false
  const list = Array.isArray(components.scripts) ? components.scripts : (components.script ? [components.script] : [])
  return list.some((s) => s && s.name === 'flock')
}

export function migrateRenderScaleInComponents(components) {
  if (!components || typeof components !== 'object' || Array.isArray(components)) return components
  const c = { ...components }
  const r = c.render
  const flockRegion = isFlockRegionComponents(c)
  if (r && typeof r === 'object' && r.scale != null) {
    if (flockRegion) {
      // Region container: the legacy scale is the VOLUME size, not TRS — drop
      // it, never move it into transform.scale (children inherit transform
      // scale, and a scaled region scatters every spawned boid).
      const nr = { ...r }
      delete nr.scale
      c.render = Object.keys(nr).length > 0 ? nr : undefined
    } else if (!(c.transform && c.transform.scale != null)) {
      c.transform = { ...(c.transform || {}), scale: r.scale }
      const nr = { ...r }
      delete nr.scale
      c.render = Object.keys(nr).length > 0 ? nr : undefined
    } else {
      // transform.scale already present: it wins — drop the stale render.scale.
      const nr = { ...r }
      delete nr.scale
      c.render = Object.keys(nr).length > 0 ? nr : undefined
    }
  }
  // Scorched-earth region doctrine: a flock region is a PURE CONTAINER —
  // identity transform.scale and NO collider. It is a boid-volume container
  // (boids spawn as region-local children); the volume size lives on the flock
  // params (sizeX/Y/Z) which the volume gizmo reads, and a dormant collider
  // duplicate of sizeX/Y/Z/2 is a drift hazard (containment reads the params).
  if (flockRegion) {
    if (c.collider) delete c.collider
    const t = c.transform
    if (t && t.scale != null) {
      const s = Array.isArray(t.scale) ? t.scale : (typeof t.scale === 'object' ? [t.scale.x, t.scale.y, t.scale.z] : [t.scale, t.scale, t.scale])
      const identity = s.every((v) => Number(v) === 1)
      if (!identity) {
        c.transform = { ...t, scale: [1, 1, 1] }
      } else if (!Array.isArray(t.scale)) {
        c.transform = { ...t, scale: [1, 1, 1] }
      }
    }
  }
  return c
}

export function migrateScaleToTransform(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return scene
  // Fast path: if there is nothing to migrate anywhere, return the INPUT
  // unchanged. Identity matters: the editor holds this scene as its serialized
  // source of truth while game.scene must be the SAME object (scrub reset
  // re-hydrates from game.scene) — a needless copy forks them, and edits made
  // through one silently vanish from the other (2026-09-18 override loss). A
  // copy is made only when a legacy render.scale is actually moved.
  if (!_hasLegacyRenderScale(scene)) return scene
  const out = { ...scene }
  const move = migrateRenderScaleInComponents
  if (Array.isArray(out.entities)) {
    out.entities = out.entities.map((e) => {
      if (!e || typeof e !== 'object') return e
      const n = { ...e, components: move(e.components) }
      if (n.overrides && typeof n.overrides === 'object' && !Array.isArray(n.overrides)) {
        n.overrides = { ...n.overrides, components: move(n.overrides.components) }
      }
      return n
    })
  }
  if (out.archetypes && typeof out.archetypes === 'object' && !Array.isArray(out.archetypes)) {
    const arch = {}
    for (const [k, v] of Object.entries(out.archetypes)) {
      arch[k] = (v && typeof v === 'object') ? { ...v, components: move(v.components) } : v
    }
    out.archetypes = arch
  } else if (Array.isArray(out.archetypes)) {
    out.archetypes = out.archetypes.map((v) => (v && typeof v === 'object') ? { ...v, components: move(v.components) } : v)
  }
  return out
}

/** Does ANY entity/archetype in this scene still carry a legacy
 *  render.scale (i.e. would migrateScaleToTransform rewrite something)? */
function _hasLegacyRenderScale(scene) {
  const has = (components) => {
    if (!components || typeof components !== 'object' || Array.isArray(components)) return false
    const r = components.render
    return !!(r && typeof r === 'object' && r.scale != null)
  }
  if (Array.isArray(scene.entities)) {
    for (const e of scene.entities) {
      if (!e) continue
      if (e && has(e.components)) return true
      if (e.overrides && has(e.overrides.components)) return true
    }
  }
  if (scene.archetypes && typeof scene.archetypes === 'object') {
    const defs = Array.isArray(scene.archetypes) ? scene.archetypes : Object.values(scene.archetypes)
    for (const def of defs) if (def && has(def.components)) return true
  }
  return false
}

/**
 * Fold a legacy `velocity` component into `rigid-body.velocity` — live
 * velocity is engine-internal state (the motion map), so the ONLY reason a
 * velocity component ever existed was authored spawn data, and that belongs
 * on the rigid-body next to its mass/friction. Applied to plain entity
 * records, instance override bags, and archetype definitions. Pure; idempotent
 * (an existing `rigid-body.velocity` wins over the legacy component; the
 * legacy component is always dropped). Entities WITHOUT a `rigid-body` keep
 * their `velocity` component — the legacy `dynamic-body` script still owns
 * that shape for non-rigid entities.
 * (P3.5 follow-up, 2026-09-13.)
 */
export function migrateVelocityToRigidBody(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return scene
  const out = { ...scene }
  const move = (components) => {
    if (!components || typeof components !== 'object' || Array.isArray(components)) return components
    const c = { ...components }
    const v = c.velocity
    if (!v || typeof v !== 'object' || !Array.isArray(v.v)) return c
    const rb = c['rigid-body']
    if (rb && typeof rb === 'object' && !Array.isArray(rb)) {
      const nr = { ...rb }
      if (nr.velocity === undefined) {
        // Fold: fold the component into rigid-body and drop it.
        nr.velocity = [...v.v]
        c['rigid-body'] = nr
        delete c.velocity
      }
      // rb.velocity already present: the component is NEWER override data —
      // keep it (seedMotion lets the component override rb.velocity).
    }
    // No rigid-body → legacy dynamic-body territory: leave the component.
    return c
  }
  if (Array.isArray(out.entities)) {
    out.entities = out.entities.map((e) => {
      if (!e || typeof e !== 'object') return e
      const n = { ...e, components: move(e.components) }
      if (n.overrides && typeof n.overrides === 'object' && !Array.isArray(n.overrides)) {
        n.overrides = { ...n.overrides, components: move(n.overrides.components) }
      }
      return n
    })
  }
  if (out.archetypes && typeof out.archetypes === 'object' && !Array.isArray(out.archetypes)) {
    const arch = {}
    for (const [k, v] of Object.entries(out.archetypes)) {
      arch[k] = (v && typeof v === 'object') ? { ...v, components: move(v.components) } : v
    }
    out.archetypes = arch
  } else if (Array.isArray(out.archetypes)) {
    out.archetypes = out.archetypes.map((v) => (v && typeof v === 'object') ? { ...v, components: move(v.components) } : v)
  }
  return out
}

/**
 * Migrate a legacy `hud: { elements: [...] }` component (WS3) into the ECS
 * canvas + widget model (WS3-Pro): the hud entity becomes a `canvas` entity
 * (renderMode 'screen'), and each element becomes a child widget entity
 * (parented, carrying a `rect` + a typed widget component). Pure: inputs are
 * unmutated; returns the SAME scene when nothing carries a `hud` component.
 *
 * Mapping: label→text, bar→bar, counter→text (nothing dropped). The bar's
 * `height` was px in the legacy model; it is re-based to normalized assuming a
 * 600px reference viewport (`h/600`) so the rendered size is preserved.
 */
export function migrateHudToCanvas(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return scene
  const entities = Array.isArray(scene.entities) ? scene.entities : []
  const hasHud = entities.some((e) => e && e.components && e.components.hud)
  if (!hasHud) return scene

  const existingIds = new Set(entities.map((e) => e && e.id).filter(Boolean))
  let nextId = typeof scene.nextEntityId === 'number' ? scene.nextEntityId : 1
  const outEntities = []

  for (const ent of entities) {
    if (!ent || typeof ent !== 'object') { outEntities.push(ent); continue }
    const hud = ent.components && ent.components.hud
    if (!hud || !Array.isArray(hud.elements)) { outEntities.push(ent); continue }

    // The hud entity becomes a screen canvas root (keep id/name/transform).
    const canvasEntry = {
      ...ent,
      components: { ...(ent.components || {}), hud: undefined, canvas: { renderMode: 'screen' } },
    }
    delete canvasEntry.components.hud
    outEntities.push(canvasEntry)

    // Each element becomes a child widget entity.
    const canvasId = ent.id
    hud.elements.forEach((el, i) => {
      if (!el || typeof el !== 'object') return
      const slug = String(el.id || `el-${i}`).replace(/[^A-Za-z0-9_-]+/g, '-') || `el-${i}`
      let wid = `${canvasId}__${slug}`
      let n = 2
      while (existingIds.has(wid)) { wid = `${canvasId}__${slug}-${n}`; n++ }
      existingIds.add(wid)
      nextId = Math.max(nextId, parseInt(wid.replace(/^\D+/g, '') || '0', 10) + 1, nextId + 1)

      const rect = { x: num(el.x) || 0, y: num(el.y) || 0, w: 0, h: 0, anchorX: 0, anchorY: 0 }
      let widget
      if (el.type === 'bar') {
        rect.w = num(el.width) > 0 ? num(el.width) : 0.25
        rect.h = num(el.height) > 0 ? num(el.height) / 600 : 0.03
        widget = { value: num(el.value) || 0, color: el.color || '#4caf50', backColor: el.backColor || 'rgba(0,0,0,0.5)' }
      } else if (el.type === 'counter') {
        widget = { string: `${el.text ?? ''}${el.value ?? 0}`, color: el.color || '#ffffff', size: num(el.size) || 20 }
      } else {
        // label
        widget = { string: el.text ?? '', color: el.color || '#ffffff', size: num(el.size) || 20 }
      }
      const wtype = el.type === 'bar' ? 'bar' : 'text'
      outEntities.push({
        id: wid,
        name: wid,
        parent: canvasId,
        components: { transform: { x: 0, y: 0, z: 0 }, rect, [wtype]: widget },
      })
    })
  }

  return { ...scene, nextEntityId: nextId, entities: outEntities }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Apply an ordered list of pure migration functions (scene)=>scene.
 * Returns { scene, applied }. Version is NOT auto-bumped (caller owns it).
 */
export function migrateScene(scene, migrations = []) {
  let out = scene
  let applied = 0
  if (Array.isArray(migrations)) {
    for (const fn of migrations) {
      out = fn(out)
      applied += 1
    }
  }
  return { scene: out, applied }
}

/**
 * Merge an archetype's base components with an instance's overrides.
 * Override wins per top-level component type key (shallow merge per key).
 * @returns {object} the merged components object (new object, inputs unmutated)
 */
export { mergeArchetype, resolveArchetypeChain, resolveArchetypeChainById, mergeArchetypeWithBase } from './archetype-nesting.js'

/**
 * Merge an override vector (scale or rotation) into a base vector axis-by-axis,
 * so an override that names only some axes inherits the rest from the base —
 * Unity/Godot/Unreal prefab-inheritance behavior. Accepts any vector shape
 * (number, array, or {x,y,z}); defaults a missing base axis to `def`. The
 * RESULT keeps the override's container shape (array stays array, object stays
 * object, number stays number) so the data format is unchanged.
 *
 * RETIRED from instance hydration (origin-authored doctrine: the arch root is
 * identity, overrides replace over defaults 1/0 — see the hydration block).
 * Kept exported for any future per-axis vector merge outside placement.
 */
function mergeAxes(base, override, { def = 1 } = {}) {
  const get = (src, k) => {
    if (typeof src === 'number') return src
    if (Array.isArray(src)) return src[k === 'x' ? 0 : k === 'y' ? 1 : 2]
    if (src && typeof src === 'object') {
      // numeric-keyed object {0,1,2} (corrupted array) -> treat as array
      if (src.x === undefined && (src[0] !== undefined || src[1] !== undefined || src[2] !== undefined)) {
        return src[k === 'x' ? 0 : k === 'y' ? 1 : 2]
      }
      return src[k]
    }
    return undefined
  }
  const axis = (k) => get(override, k) ?? get(base, k) ?? def
  // Preserve the override's container shape.
  if (typeof override === 'number') return axis('x')
  if (Array.isArray(override)) return [axis('x'), axis('y'), axis('z')]
  return { x: axis('x'), y: axis('y'), z: axis('z') }
}

/**
 * SceneBuilder: hydrates a validated scene into entity records.
 * @param {{ resolveArchetype?: (archetypeId) => object|undefined }} opts
 *   Nesting: if the resolved def carries `base: '<id>'`, the chain resolves
 *   through this same `resolveArchetype` (deep merge, children concat).
 */
export class SceneBuilder {
  constructor({ resolveArchetype } = {}) {
    this._resolveArchetype = resolveArchetype || (() => undefined)
  }

  /**
   * Hydrate a scene.
   * @param {object} scene
   * @returns {{ entities: Array<{ id: string, parent?: string, components: object }>, errors: string[] }}
   *   entities are created for plain records and for archetype instances whose
   *   archetype resolves; missing archetypes are reported as errors and skipped.
   */
  hydrate(scene) {
    // Normalize BEFORE hydrating so the live entities carry migrated scale
    // (legacy render.scale -> transform.scale) — validateScene normalizes
    // internally but discards the result, so hydration must normalize itself.
    scene = normalizeScene(scene)
    const errors = validateScene(scene)
    const entities = []

    // ONE pass over the ONE entities array (scene format v3): a record with
    // `archetypeId` is an archetype instance — it hydrates through the chain
    // resolve + merge + child-hydration path (_hydrateInstance); a record
    // without it hydrates as-is (preserving the optional transform parent,
    // layer id, and tags).
    if (Array.isArray(scene.entities)) {
      for (const ent of scene.entities) {
        if (ent && typeof ent.archetypeId === 'string' && ent.archetypeId !== '') {
          this._hydrateInstance(ent, entities, errors)
        } else {
          const rec = { id: ent.id, components: clone(ent.components ?? {}) }
          if (typeof ent.parent === 'string' && ent.parent !== '') rec.parent = ent.parent
          if (typeof ent.layer === 'string' && ent.layer !== '') rec.layer = ent.layer
          if (Array.isArray(ent.tags) && ent.tags.length > 0) rec.tags = ent.tags.map(String)
          entities.push(rec)
        }
      }
    }

    return { entities, errors }
  }

  /**
   * Hydrate ONE archetype-instance record (a v3 entity record carrying
   * `archetypeId`). This is the pre-v3 instance hydration path, unchanged:
   * archetype chain resolve, base+override shallow merge, origin-authored
   * transform replace-over-defaults, and child hydration
   * (`<instanceId>_<childName>`).
   */
  _hydrateInstance(inst, entities, errors) {
    let base = this._resolveArchetype(inst.archetypeId)
    if (base === undefined) {
      errors.push(`missing archetype: ${inst.archetypeId}`)
      return
    }
    // Archetype nesting: a def carrying `base` resolves through the chain
    // (deep component merge — own fields win, base fields inherited;
    // children concat with same-name replacement). The chain walks the
    // SAME resolveArchetype source the instance record used, so nesting
    // works identically in game boot, loadScene, and the editor.
    if (base && base.base != null) {
      try {
        base = resolveArchetypeChainById(inst.archetypeId, this._resolveArchetype)
      } catch (err) {
        errors.push(String(err && err.message || err))
        return
      }
    }
    // BASE MIGRATION FIRST (T-ENG-A): the legacy home of a declared scale is
    // `render.scale` (e.g. shell.json's 0.1). Migrate the BASE and the
    // INSTANCE OVERRIDES into `transform.scale` BEFORE the merge and the
    // placement injection below, so a position-only override cannot clobber
    // the archetype-declared scale with the default (mergeArchetype REPLACES
    // the whole transform key — migrating after the merge moved the base's
    // scale into the override's transform object, where the injection's
    // `baseTf.scale` lookup could never find it). This is the same migration
    // the editor's Place button applies before spawning
    // (editor/src/archetypes.js) — without it, runtime spawns of
    // scale-declaring archetypes dropped the scale the scene-placed ones
    // kept. Pure + idempotent; the final migrate at the record build re-runs
    // it on the injected result (a no-op after this) and enforces flock
    // doctrine.
    const baseComponents = migrateRenderScaleInComponents(base.components ?? {})
    const overrideComponents = migrateRenderScaleInComponents(inst.overrides?.components ?? {})
    const merged = mergeArchetype(baseComponents, overrideComponents)
    // ORIGIN-AUTHORED ARCHETYPES (the placement doctrine): an archetype is
    // authored at origin — its root transform is identity and means "the
    // mount point", not a part. The INSTANCE owns its full placement: the
    // override transform (world values) REPLACES per-field over DEFAULTS
    // (x/y/z → 0, scale → 1, rot → 0). No additive math, no axis
    // inheritance over the archetype root — identity roots make those
    // special cases meaningless. Editing an archetype's root transform
    // therefore never re-positions placed instances (no-propagation,
    // restored to its original meaning); children/components propagate.
    const baseTf = merged.transform ?? {}
    // The scale default for a placement override that OMITS scale is the
    // ARCHETYPE-DECLARED transform.scale — read from the migrated BASE
    // components, NOT merged.transform: mergeArchetype replaces the whole
    // transform key per-instance, so once an override carries a transform the
    // merged copy no longer holds the base's declared scale (T-ENG-A: this is
    // exactly where shell.json's render.scale 0.1 used to vanish).
    const baseDeclaredScale = baseComponents.transform?.scale
    // Read the override transform from the MIGRATED copy (overrideComponents,
    // above): an override declaring only a legacy render.scale must hydrate
    // its declared scale, not fall through the 'omitted scale' default.
    const ovTf = overrideComponents.transform || {}
    if (baseTf && (typeof baseTf === 'object') && !Array.isArray(baseTf) &&
        (ovTf.x != null || ovTf.y != null || ovTf.z != null ||
         ovTf.scale != null || ovTf.rot != null)) {
      // Defaults fill any axis the override omits. Legacy alternate shapes
      // (position arrays etc.) pass through untouched via baseTf spread.
      merged.transform = {
        ...baseTf,
        x: ovTf.x ?? 0,
        y: ovTf.y ?? 0,
        z: ovTf.z ?? 0,
        ...(ovTf.scale != null ? { scale: ovTf.scale } : { scale: baseDeclaredScale ?? 1 }),
        ...(ovTf.rot != null ? { rot: ovTf.rot } : { rot: 0 }),
      }
    }
    const rec = { id: inst.id, components: migrateRenderScaleInComponents(clone(merged)) }
    if (typeof inst.parent === 'string' && inst.parent !== '') rec.parent = inst.parent
    // TAGS are a TOP-LEVEL entity field, hydration honors ONLY it (the
    // `components.tags` placement was REMOVED — migrate authored data with
    // tools/migration/2026-10-04-components-tags-hoist.mjs).
    if (Array.isArray(inst.tags) && inst.tags.length > 0) rec.tags = inst.tags.map(String)
    entities.push(rec)
    // Children: parented sub-entities (the multi-entity prefab part).
    // NESTED PREFABS (MODEL-IMPORT lossless mirror): a child record may
    // carry its own `children` array — the walker's expanded glTF tree is
    // deeply nested — so hydration RECURSES: each descendant becomes an
    // entity parented to its record parent, id
    // `<instId>_<ancestorNames...>_<childName>`.
    if (Array.isArray(base.children)) {
      const hydrateChild = (child, parentId, idPrefix, ci) => {
        if (!child || typeof child !== 'object') {
          errors.push(`archetype "${inst.archetypeId}" child[${ci}] must be an object`)
          return
        }
        const childName = typeof child.name === 'string' && child.name !== '' ? child.name : `child${ci}`
        const cid = `${idPrefix}_${childName}`
        if (entities.some((e) => e.id === cid)) {
          errors.push(`duplicate instance child id: ${cid}`)
          return
        }
        const childComponents = migrateRenderScaleInComponents(clone(child.components ?? {}))
        // Apply a positional offset so children sit relative to the root.
        // BEFORE the override merge — an instance transform override is a
        // full LOCAL transform (world − mount), not a delta, so folding
        // the offset after the merge clobbered it (user report 09-18:
        // child transform overrides silently reverted).
        if (child.offset) {
          const tf = childComponents.transform ?? {}
          // MERGE — never replace: every other transform field (rot,
          // scale, anything future) survives the offset fold, matching
          // buildSyntheticScene. Replacing dropped authored rot/scale
          // (node-scoped children render through a proxy whose world
          // matrix comes from these transforms — losing scale inflates
          // the render by exactly the model's baked node scale).
          childComponents.transform = {
            ...tf,
            x: tf.x ?? 0, y: tf.y ?? 0, z: tf.z ?? 0,
            ...(child.offset.x !== undefined ? { x: child.offset.x } : {}),
            ...(child.offset.y !== undefined ? { y: child.offset.y } : {}),
            ...(child.offset.z !== undefined ? { z: child.offset.z } : {}),
          }
        }
        // Per-INSTANCE child overrides (overrides.children[childName]):
        // an instance record can override ANY component on ONE spawned
        // child
        // (e.g. a collider on tank_2's turret only) without touching the
        // archetype or its siblings. Per-component: arrays and primitives
        // REPLACE wholesale (scripts is an array — spreading an array into
        // an object literal produces {0:...}, not an array), plain objects
        // shallow-merge (override wins).
        const childOv = inst.overrides?.children?.[childName]
        if (childOv && typeof childOv === 'object' && !Array.isArray(childOv)) {
          for (const [ck, cv] of Object.entries(childOv.components ?? {})) {
            const baseC = childComponents[ck]
            if (Array.isArray(cv) || Array.isArray(baseC) || typeof cv !== 'object' || cv === null) {
              childComponents[ck] = clone(cv)
            } else {
              childComponents[ck] = { ...(baseC ?? {}), ...clone(cv) }
            }
          }
        }
        const rec = { id: cid, parent: parentId, components: childComponents, name: childName }
        // TAGS are a TOP-LEVEL entity field: a child's authored top-level
        // `tags` carries onto the hydrated record. `components.tags` is NOT
        // read here (removed — migrate with
        // tools/migration/2026-10-04-components-tags-hoist.mjs).
        if (Array.isArray(child.tags) && child.tags.length > 0) rec.tags = child.tags.map(String)
        entities.push(rec)
        // Recurse into the record's own children (parented to THIS child).
        if (Array.isArray(child.children)) {
          for (let ni = 0; ni < child.children.length; ni++) {
            hydrateChild(child.children[ni], cid, cid, ni)
          }
        }
      }
      for (let ci = 0; ci < base.children.length; ci++) {
        hydrateChild(base.children[ci], inst.id, inst.id, ci)
      }
    }
  }

  /**
   * Instantiate ONE archetype instance at RUNTIME — the exact path scene load
   * uses (`_hydrateInstance`: chain resolve, shallow merge, placement
   * transform replace-over-defaults, child hydration). Used by
   * `api.spawnArchetype` so scripts (the flock spawner) spawn archetype
   * instances that look identical to scene-placed ones: the entity carries
   * `archetypeId`, hydration-applied components (declared scale/collider),
   * and placement overrides.
   * @param {{ id: string, archetypeId: string, parent?: string, overrides?: object }} inst
   * @returns {{ entities: Array<{ id, parent?, components, name? }>, errors: string[] }}
   */
  instantiate(inst) {
    const entities = []
    const errors = []
    this._hydrateInstance(inst, entities, errors)
    return { entities, errors }
  }
}

/**
 * Resolve every entity's WORLD position from its LOCAL transform + parent
 * chain. Pure function over plain scene records — no DOM/Three dependency, so
 * it is unit-testable in Node.
 *
 * An entity with no parent has world = local. An entity with a parent has
 * world = parent.world + local (recursively). Cycles and dangling parents are
 * handled defensively (the entity resolves to its own local position rather
 * than throwing).
 *
 * @param {Array<{ id: string, parent?: string, components?: object }>} entities
 * @returns {Map<string, { x: number, y: number, z: number }>} id -> world position
 */
function composeWorld(parent, local) {
  // Full TRS composition (world = parent ∘ local): a child's position lives in
  // the PARENT's scaled/rotated space (glTF semantics), so parent scale must
  // scale the child offset and the parent rotation must rotate it — additive
  // position alone misplaces children of scaled nodes by the inverse of the
  // ancestor scale. `matrix` is the EXACT composed 4×4 (column-major) — the
  // authority for rendering, because a non-uniform ancestor scale composed
  // with a rotated child does NOT decompose back into TRS (shear). The TRS
  // fields (quat/scale, positions applied once) remain for approximate/
  // position-only consumers.
  const px = parent.scale.x * local.x
  const py = parent.scale.y * local.y
  const pz = parent.scale.z * local.z
  // Rotate the scaled offset by the parent quaternion (applyQuaternion):
  // v' = v + 2w(q×v) + 2 q×(q×v)
  const qx = parent.quat.x; const qy = parent.quat.y; const qz = parent.quat.z; const qw = parent.quat.w
  const cx = qy * pz - qz * py
  const cy = qz * px - qx * pz
  const cz = qx * py - qy * px
  return {
    x: parent.x + px + 2 * qw * cx + 2 * (qy * cz - qz * cy),
    y: parent.y + py + 2 * qw * cy + 2 * (qz * cx - qx * cz),
    z: parent.z + pz + 2 * qw * cz + 2 * (qx * cy - qy * cx),
    quat: quatMultiply(parent.quat, local.quat),
    scale: {
      x: parent.scale.x * local.scale.x,
      y: parent.scale.y * local.scale.y,
      z: parent.scale.z * local.scale.z,
    },
    matrix: mat4Multiply(parent.matrix, local.matrix),
  }
}

/** Column-major 4×4 TRS matrix from a local transform record (pure JS, three-free). */
function trsMatrix(t) {
  const { x: qx, y: qy, z: qz, w: qw } = t.quat
  const sx = t.scale.x; const sy = t.scale.y; const sz = t.scale.z
  const x2 = qx + qx; const y2 = qy + qy; const z2 = qz + qz
  const xx = qx * x2; const xy = qx * y2; const xz = qx * z2
  const yy = qy * y2; const yz = qy * z2; const zz = qz * z2
  const wx = qw * x2; const wy = qw * y2; const wz = qw * z2
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t.x, t.y, t.z, 1,
  ]
}

/** Column-major 4×4 multiply: out = a · b. */
function mat4Multiply(a, b) {
  const o = new Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}

/**
 * TRANSFORM PREVIEW OVERRIDES (optional `overrides`): Map<id, {x,y,z,quat}>
 * — WORLD-space quaternion + position supplied by the renderer while a gizmo
 * transform preview is active for `id`. During the chain walk, an overridden
 * entity contributes its PREVIEWED world quat/pos to every descendant
 * compose (scale stays the resolved serialized one), so the whole subtree
 * follows the dragged parent live. Absent/empty → behavior is byte-identical
 * to the plain two-arg call.
 */
export function resolveWorldTransforms(entities, overrides) {
  const byId = new Map()
  for (const e of entities) {
    if (e && typeof e.id === 'string') byId.set(e.id, e)
  }

  const world = new Map()
  const memo = new Map()

  function resolve(id, stack) {
    if (memo.has(id)) return memo.get(id)
    if (stack.has(id)) {
      // Cycle: fall back to this entity's local position (no throw).
      const local = localOf(byId.get(id))
      memo.set(id, local)
      return local
    }
    const rec = byId.get(id)
    const local = localOf(rec)
    if (rec && typeof rec.parent === 'string' && rec.parent && rec.parent !== id && byId.has(rec.parent)) {
      stack.add(id)
      let pw = resolve(rec.parent, stack)
      stack.delete(id)
      // TRANSFORM PREVIEW: an overridden ANCESTOR contributes its previewed
      // world quat/pos to this compose (its resolved world scale is kept) —
      // the whole subtree follows the dragged parent live. O(1) per step, so
      // the walk stays O(depth).
      if (overrides && overrides.size) {
        const ov = overrides.get(rec.parent)
        if (ov) pw = withQuatPos(pw, ov)
      }
      // `let`, not `const`: the preview override REPLACES the composed world
      // quat/pos below. `const` made resolveWorldTransforms THROW
      // ("Assignment to constant variable") whenever a previewed entity had a
      // parent — every mid-drag sync died, so the transform preview never
      // propagated to the subtree of a mid-hierarchy drag (real tank1
      // repro: dragging tank1_Scene or tank1_Scene_Hull_Barrel left their
      // children composing the stale serialized chain; only world-ROOT drags
      // worked, because roots take the `let out = local` branch below).
      let out = composeWorld(pw, local)
      // TRANSFORM PREVIEW: the dragged entity itself also composes from its
      // previewed world quat/pos (same contract as the renderer's direct
      // `_previewFor(id)` suppression in the sync paths).
      if (overrides && overrides.size && overrides.has(id)) out = withQuatPos(out, overrides.get(id))
      memo.set(id, out)
      return out
    }
    let out = local
    if (overrides && overrides.size && overrides.has(id)) out = withQuatPos(out, overrides.get(id))
    memo.set(id, out)
    return out
  }

  for (const e of entities) {
    if (e && typeof e.id === 'string') world.set(e.id, resolve(e.id, new Set()))
  }
  return world
}

/** Read the local position (x,y,z) of a scene record, defaulting to 0. */
function localOf(rec) {
  const t = rec && rec.components && rec.components.transform
  const x = (t && t.x) || 0
  const y = (t && t.y) || 0
  const z = (t && t.z) || 0
  // Full TRS: rotation ({x,y,z} rot / legacy yaw) and scale (array, number or
  // {x,y,z}) read with the SAME precedence the renderer's _rotation/_scale use.
  const rot = (t && (t.rot || t.rotation)) || (t && t.yaw !== undefined ? { x: 0, y: t.yaw, z: 0 } : null)
  const quat = rot && typeof rot === 'object' ? eulerToQuat(rot.x || 0, rot.y || 0, rot.z || 0) : { x: 0, y: 0, z: 0, w: 1 }
  const s = t ? t.scale : undefined
  let scale
  if (Array.isArray(s)) scale = { x: s[0] ?? 1, y: s[1] ?? 1, z: s[2] ?? 1 }
  else if (typeof s === 'number') scale = { x: s, y: s, z: s }
  else if (s && typeof s === 'object') scale = { x: s.x ?? 1, y: s.y ?? 1, z: s.z ?? 1 }
  else scale = { x: 1, y: 1, z: 1 }
  const local = { x, y, z, quat, scale }
  local.matrix = trsMatrix(local)
  return local
}

/** Euler (XYZ order, radians) -> quaternion — same convention as three.js
 *  `Quaternion.setFromEuler(Euler(x,y,z,'XYZ'))`: q = qx ⊗ qy ⊗ qz with
 *  x = s1·c2·c3 + c1·s2·s3, y = c1·s2·c3 − s1·c2·s3, z = c1·c2·s3 + s1·s2·c3,
 *  w = c1·c2·c3 − s1·s2·s3. (The previous formula here was the REVERSED-order
 *  ZYX convention — it disagreed with the renderer's THREE.Euler('XYZ')
 *  composition for any mixed-axis euler, so a gizmo rotate that serialized a
 *  mixed rot{x,y,z} snapped 40°+ the instant the drag was released: the
 *  preview drew THREE.XYZ, the engine recomposed ZYX from the same record.) */
export function eulerToQuat(x, y, z) {
  const cx = Math.cos(x / 2); const sx = Math.sin(x / 2)
  const cy = Math.cos(y / 2); const sy = Math.sin(y / 2)
  const cz = Math.cos(z / 2); const sz = Math.sin(z / 2)
  return {
    w: cx * cy * cz - sx * sy * sz,
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
  }
}

/**
 * A resolved WORLD record with its quat/pos REPLACED by a transform-preview
 * override (scale retained from the resolved record); `matrix` recomputed so
 * the exact-matrix consumers stay consistent.
 */
function withQuatPos(rec, ov) {
  const out = {
    x: ov.x, y: ov.y, z: ov.z,
    quat: { x: ov.quat.x, y: ov.quat.y, z: ov.quat.z, w: ov.quat.w },
    scale: rec.scale,
  }
  out.matrix = trsMatrix(out)
  return out
}

/** Quaternion product a ∘ b (apply b first, then a) — three.js multiplyQuaternions convention. */
function quatMultiply(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  }
}

function clone(value) {
  return value === undefined ? {} : JSON.parse(JSON.stringify(value))
}
