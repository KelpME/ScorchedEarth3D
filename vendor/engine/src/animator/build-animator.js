/**
 * buildAnimator — the unified character-assembly routine (Animation Authoring
 * Phase 2, track-remap path).
 *
 * ONE engine routine assembles a complete, reliably-animating character from a
 * declarative `character` spec, used by BOTH the game `main.js` and the editor
 * so Play and the editor render the identical rig/clips/scale (kills the
 * recurring "wrong model / box in editor" bug).
 *
 * Pipeline (all existing primitives, orchestrated in one place):
 *   1. VALIDATE  — `validateAnimator(spec)`; reject early (unless `validate:false`).
 *   2. LOAD MODEL — `loader.loadModel(spec.model)` → decode + materials; if
 *      `subRig`, `extractRig` the named rig from the shared-skeleton file.
 *   3. SCALE + GROUND — one uniform `spec.scale`; feet on y=0 (`placeRigOnGround`).
 *   4. LOAD + RETARGET EACH CLIP — `loader.loadClip(clipId)` → first AnimationClip;
 *      resolve the bone map (auto / humanoid / persisted) → `retargetClip` →
 *      convert plain tracks to real KeyframeTracks (`toKeyframeTracks`) → attach
 *      under the canonical role name.
 *   5. ATTACH — clips live on the rig's `.animations` (the mixer root).
 *   6. LOCOMOTION — build the blend-tree descriptor from `spec.locomotion`
 *      (`buildBlendTree`; the legacy config/resolve path was removed in BT3).
 *   7. RETURN — the assembled character (rig + clips) + report + driver.
 *
 * Browser-bound (needs THREE + asset decode + textures). The loader interface is
 * the ONLY injected dependency, so tests can stub model/clip loading; the pure
 * pieces (track conversion, bone-map precedence, placement) are separate and
 * Node-testable.
 *
 * GENERALIZATION RULE: specifies by rig/asset CHARACTERISTICS only — no specific
 * asset file or pack is named here. Test inputs are chosen at build time.
 */

import * as THREE from 'three'
import { applyAnimatorDefaults } from './animator-spec.js'
import { validateAnimator } from './validate-animator.js'
import { resolveCharacterBoneMap } from './bone-map.js'
import { toKeyframeTracks } from './keyframe-tracks.js'
import { extractRig, placeRigOnGround } from '../assets/rig-extract.js'
import { retargetClip } from '../render/retarget.js'
import { migrateLocomotion } from '../render/blendTree.js'
import { autoMapRigs, classifyRig } from '../render/auto-map.js'
import { checkRigIntegrity } from './rig-integrity.js'
import { collectBindRest, buildBindCorrections, applyBindCorrections } from './bind-pose.js'

/**
 * Collect a THREE.Object3D's bone tree for `autoMapRigs`/`classifyRig`:
 * `[{ name, pos:{x,y,z}, parent }]`, first occurrence of each bone name wins,
 * parents wired from the first occurrence's actual parent (guards the
 * degenerate self-referential duplicate-bone case in multi-rig FBX).
 * Node-testable (three only).
 * @param {THREE.Object3D} model
 * @returns {Array<{name:string, pos:{x:number,y:number,z:number}, parent:any}>}
 */
export function collectRigBones(model) {
  if (!model) return []
  const scratch = new THREE.Scene()
  scratch.add(model)
  scratch.updateMatrixWorld(true)
  const byName = new Map()
  const firstBone = new Map()
  model.traverse((o) => {
    if (!o.isBone) return
    if (byName.has(o.name)) return
    const pos = o.getWorldPosition(new THREE.Vector3())
    byName.set(o.name, { name: o.name, pos: { x: pos.x, y: pos.y, z: pos.z }, parent: null })
    firstBone.set(o.name, o)
  })
  for (const [name, e] of byName) {
    const o = firstBone.get(name)
    if (!o.parent || !o.parent.isBone) continue
    const pe = byName.get(o.parent.name)
    if (pe) e.parent = pe
  }
  scratch.remove(model)
  return [...byName.values()]
}

/** Pull the first AnimationClip off a decoded clip source (or null). */
function firstClip(source) {
  if (!source || !Array.isArray(source.animations) || source.animations.length === 0) return null
  return source.animations[0]
}

/**
 * Build the runtime-ready blend-tree descriptor from a character spec's
 * `locomotion` block — the (BT1) path. Accepts BOTH shapes:
 *   - NEW blend-space spec: `{ params: ['velX','velY'] | 'speed',
 *     points: [{ at, clip }], default, states?: [{ name, clip }] }` → passed
 *     through normalized (params as an array, default as a clip string).
 *   - OLD legacy shape: `{ param?, states: [{ when, clip }], default }` →
 *     migrated via `migrateLocomotion` (see blendTree.js for the rules).
 * @param {object} locomotion  `spec.locomotion` (optional)
 * @returns {{ params: string[]|null, points: Array, default: string|null,
 *             states: Array }|null} the tree descriptor, or null when no
 *   locomotion block (or no usable points) is given.
 */
export function buildBlendTree(locomotion) {
  if (!locomotion || typeof locomotion !== 'object') return null
  const isNewShape = locomotion.points !== undefined || locomotion.params !== undefined
  let params
  let points
  let states
  if (isNewShape) {
    params = locomotion.params === undefined
      ? null
      : Array.isArray(locomotion.params) ? [...locomotion.params] : [locomotion.params]
    points = Array.isArray(locomotion.points)
      ? locomotion.points.map((p) => ({ at: p.at, clip: p.clip }))
      : []
    states = Array.isArray(locomotion.states) ? locomotion.states : []
  } else {
    // Old legacy shape — auto-migrate (warnings are validateAnimator's job).
    const mig = migrateLocomotion(locomotion)
    if (!mig.spec) return null
    params = mig.spec.params
    points = mig.spec.points
    states = []
  }
  if (!Array.isArray(points) || points.length === 0) return null
  const def = typeof locomotion.default === 'string'
    ? locomotion.default
    : locomotion.default && typeof locomotion.default === 'object' && typeof locomotion.default.clip === 'string'
      ? locomotion.default.clip
      : null
  return { params, points, default: def, states }
}

/**
 * Assemble a character from a spec. See the module header for the pipeline.
 *
 * @param {object} spec  the `character` component value
 * @param {object} ctx
 * @param {object} ctx.loader  REQUIRED — how to fetch assets:
 *   - `loadModel(modelId)` → Promise<THREE.Object3D> (decoded + materials resolved)
 *   - `loadClip(clipId)`   → Promise<THREE.Object3D> (decoded clip source, with
 *     `.animations`)
 * @param {boolean} [ctx.validate=true]  run validateAnimator first (reject on hard)
 * @param {object} [ctx.validation]      extra ctx for validateAnimator
 * @param {Function} [ctx.autoMapRigs]   override (defaults to engine autoMapRigs)
 * @param {Function} [ctx.getPersistedMap]  (group) => authored map for `retarget/<group>.json`
 * @returns {Promise<{
 *   character: THREE.Group,
 *   clips: Array<THREE.AnimationClip>,
 *   report: object,
 *   locomotion: { tree: object|null },   // tree = BT1 blend-tree descriptor
 * }>}
 */
export async function buildAnimator(spec, ctx = {}) {
  const { loader, validate = true } = ctx
  if (!loader || typeof loader.loadModel !== 'function' || typeof loader.loadClip !== 'function') {
    throw new Error('buildAnimator: ctx.loader with loadModel + loadClip is required')
  }
  const norm = applyAnimatorDefaults(spec)

  // 1. Validation gate. The model is resolved from `ctx.model` (the render
  //    dependency); thread it into the validation ctx so the gate can verify a
  //    model source exists.
  if (validate) {
    const v = validateAnimator(spec, { ...(ctx.validation || {}), model: ctx.model })
    if (!v.ok) {
      throw new Error('buildAnimator: invalid character spec — ' + v.hard.map((h) => `${h.path} ${h.message}`).join('; '))
    }
  }

  // 2. Model source — the `character` spec DEPENDS on `render.modelName` (the
  //    single model authority); the caller passes it as `ctx.model`. `spec.model`
  //    is kept as a backward-compat fallback but is NOT the canonical source.
  const modelId = ctx.model || norm.model
  if (!modelId) {
    throw new Error('buildAnimator: no model — the character spec requires a model via render.modelName (ctx.model) or character.model')
  }

  // 3. Load model. Scale + materials (tint/textures) are IMPORT/RENDER
  //    concerns: the loader normalizes the model's baked scale to a readable
  //    footprint and applies the model's material (via importModel), and
  //    render.material owns the appearance. The animator does NOT pass
  //    scale/tint/textures — those no longer live on the spec.
  const model = await loader.loadModel(modelId)

  // 4. Extract the rig (subRig) or use the model as-is.
  let character
  if (norm.subRig) {
    character = extractRig(model, norm.subRig)
    if (!character) {
      throw new Error(`buildAnimator: subRig '${norm.subRig}' not found in model '${modelId}'`)
    }
  } else {
    character = model
  }

  // 5. Ground (feet on y=0). Scale is IMPORT-owned: the loader already
  //    normalized the model's baked scale to a readable footprint, so we
  //    preserve it — placeRigOnGround(rig, s) resets rig.scale, so we capture
  //    the loader's scale and re-apply it after grounding.
  const importScale = character.scale.clone()
  placeRigOnGround(character, 1)
  character.scale.copy(importScale)

  // 6. Load + retarget each clip.
  const targetBones = collectRigBones(character)
  const clips = []
  for (const [role, clipId] of Object.entries(norm.clips || {})) {
    const source = await loader.loadClip(clipId)
    const srcClip = firstClip(source)
    if (!srcClip) {
      // A declared clip that doesn't decode is a hard failure (validate may not
      // have decoded it — only the manifest id). Throw loudly, not a silent miss.
      throw new Error(`buildAnimator: clip '${clipId}' (role '${role}') has no decodable animation`)
    }
    const srcBones = collectRigBones(source)
    const { map } = resolveCharacterBoneMap(norm, {
      srcBones, targetBones,
      autoMapRigs: ctx.autoMapRigs || autoMapRigs,
      getPersistedMap: ctx.getPersistedMap,
    })
    // BUNDLED CLIP DETECTION: if the clip's tracks already bind to the target
    // rig by name (a character with its OWN clips — e.g. a rig whose bundled
    // animation uses the same bone names), retargeting is a NO-OP and applying
    // a humanoid name map would DROP the rig's non-humanoid bone tracks (e.g.
    // a frog's `DEF_*`/`IK_*`). Skip retargeting entirely and use the clip
    // as-is. This is the correct bundled/own-clips path.
    const bundled = (() => {
      const clipTrackBones = new Set()
      for (const t of (srcClip.tracks || [])) {
        const dot = t.name.lastIndexOf('.')
        clipTrackBones.add(dot >= 0 ? t.name.slice(0, dot) : t.name)
      }
      const targetNameSet = new Set(targetBones.map((b) => b.name))
      let matched = 0
      for (const b of clipTrackBones) if (targetNameSet.has(b)) matched++
      // "Bundled" when most clip bones exist in the target (>=75% — a rig's
      // clip legitimately references a few IK/weapon/control bones absent from
      // the skinned mesh skeleton, so allow those); OR the map resolved to
      // nothing (autoMapRigs failed + no name match).
      return clipTrackBones.size > 0 && (matched / clipTrackBones.size) >= 0.75
    })()
    const retargeted = bundled ? srcClip : retargetClip(srcClip, map || undefined)
    // Bind-pose correction: ONLY when explicitly enabled (`retarget.bindPose:
    // true`). For same-rest-pose characters (a rig with its own clips) the
    // correction is ~identity and unnecessary; it exists for the CROSS-PACK
    // rest-pose-mismatch case, which is a Phase 5 (bind-pose solver) concern.
    // Default OFF keeps the proven track-remap path untouched.
    const doBindPose = !!(norm.retarget && norm.retarget.bindPose === true)
    // buildBindCorrections expects a Map<src,target>; resolveCharacterBoneMap
    // returns a plain object. Convert (guarding null/empty).
    const bindMap = map && typeof map === 'object' && !(map instanceof Map)
      ? new Map(Object.entries(map))
      : map
    const corrected = doBindPose && bindMap && bindMap.size
      ? applyBindCorrections(retargeted, buildBindCorrections(
          collectBindRest(source), collectBindRest(character), bindMap))
      : retargeted
    const threeClip = toKeyframeTracks(corrected, role)
    clips.push(threeClip)
  }
  // Attach clips to the rig (the mixer root).
  character.animations = clips

  // 6. Locomotion (BT3): the assembled character carries ONLY the blend-tree
  //    descriptor — the legacy config/resolve path was removed; hosts attach
  //    `tree` via renderer.setBlendTree and feed params via api.setAnimParam.
  const tree = buildBlendTree(norm.locomotion)
  const locomotion = { tree }

  // 7. Return — include the rig-integrity check (deterministic rig health).
  const targetRoles = classifyRig(targetBones)
  const integrity = checkRigIntegrity(character)
  return {
    character,
    clips,
    locomotion,
    report: {
      model: modelId,
      subRig: norm.subRig || null,
      scale: 1, // scale is import/render/transform-owned (no longer on the animator spec)
      boneMapMode: norm.boneMap || 'auto',
      clipRoles: Object.keys(norm.clips || {}),
      targetBones: targetBones.length,
      targetRoles: Object.keys(targetRoles).length,
      onGround: norm.onGround,
      integrity: integrity.report,
      rigProblems: integrity.problems,
      rigSoft: integrity.soft,
    },
  }
}
