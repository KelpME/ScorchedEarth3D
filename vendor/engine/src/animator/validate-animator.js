/**
 * validateAnimator — the hard validation gate for a `character` spec (Phase 1).
 *
 * PURE + Node-testable (no THREE, no decode, no browser). Called at build/import
 * time and BEFORE `buildAnimator` runs, so a broken character (no model, bad rig
 * reference, unretargetable bone map, missing declared clip) is rejected early
 * with structured reasons — never mid-game.
 *
 * Returns a structured pass/fail:
 * ```
 * {
 *   ok: boolean,                       // ok === hard.length === 0
 *   hard: [{ code, path, message }],   // reject reasons (never blocked on soft)
 *   soft: [{ code, path, message }],   // warnings (missing optional clip, tint fallback, ...)
 * }
 * ```
 *
 * Hard failures (reject): spec not an object; model manifest id missing; subRig
 * declared but empty; clips absent/empty or a clip role maps to an empty id; a
 * declared clip's manifest id missing from ctx.knownManifestIds; invalid boneMap
 * mode; invalid retarget solver / pose mode; invalid rootMotion; scale not a
 * positive finite number; a locomotion state without a valid condition object or
 * referencing an undeclared clip role; the resolved bone map (when supplied)
 * failing to cover the required skeleton roles.
 *
 * Soft warnings (never block): a recommended clip role absent (e.g. no `walk`);
 * no textures AND no tint declared (possible tint-fallback render); an unmatched
 * external texture id (in ctx.knownManifestIds). String-form locomotion `when`
 * conditions ("speed == 0") are a first-class supported form (they auto-migrate
 * onto a blend space at build time), not a warning.
 *
 * GENERALIZATION RULE: this gate knows nothing about specific assets — it reasons
 * about manifest-id existence (via ctx) and rig CHARACTERISTICS (role coverage),
 * never filenames or packs.
 *
 * @param {object} spec  the `character` component value (inside components map)
 * @param {object} [ctx]
 * @param {Set<string>} [ctx.knownManifestIds]  known manifest ids; when supplied,
 *        model/clip/texture id existence is checked (hard for model+clips, soft
 *        for textures). Omit to validate structure only.
 * @param {object} [ctx.boneMap]      a resolved source->target bone map
 * @param {object} [ctx.targetRoles]  targetBoneName -> { group } role labels
 *        (e.g. from classifyRig). Both supplied -> required-role coverage is
 *        checked as a hard gate.
 * @returns {{ ok: boolean, hard: Array, soft: Array }}
 */
import { migrateLocomotion } from '../render/blendTree.js'
import {
  RECOMMENDED_CLIP_ROLES,
  BONE_MAP_MODES,
  PERSISTED_BONE_MAP_PREFIX,
  RETARGET_SOLVERS,
  ROOT_MOTION_MODES,
  REQUIRED_BONE_ROLES,
} from './animator-spec.js'

/** Does a resolved bone map cover the required skeleton roles? Pure. Roles use
 * classifyRig's shape ({ group, side }): axial groups need no side, limbs do.
 * @param {object} map  resolved sourceBone -> targetBone
 * @param {object} targetRoles  targetBoneName -> { group, side } (from classifyRig)
 * @returns {{ ok: boolean, missing: Array<{group, side?}> }} */
export function validateBoneMapCoverage(map, targetRoles) {
  if (!map || typeof map !== 'object') return { ok: false, missing: [...REQUIRED_BONE_ROLES] }
  if (!targetRoles || typeof targetRoles !== 'object') {
    return { ok: true, missing: [] } // no role labels supplied — nothing to check against
  }
  // A target bone is "covered" if some source maps onto it.
  const coveredTargets = new Set(Object.values(map))
  const missing = []
  for (const role of REQUIRED_BONE_ROLES) {
    const found = Object.entries(targetRoles).some(([boneName, roleInfo]) => {
      if (!roleInfo || roleInfo.group !== role.group) return false
      if (role.side !== undefined && roleInfo.side !== role.side) return false
      return coveredTargets.has(boneName)
    })
    if (!found) missing.push(role)
  }
  return { ok: missing.length === 0, missing }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Validate a `character` spec. See header for the gate contract.
 * @param {object} spec
 * @param {object} [ctx]
 * @returns {{ ok, hard, soft }}
 */
export function validateAnimator(spec, ctx = {}) {
  const hard = []
  const soft = []
  const known = ctx.knownManifestIds instanceof Set ? ctx.knownManifestIds : null
  const p = (severity, code, path, message) => {
    ;(severity === 'soft' ? soft : hard).push({ code, path, message })
  }

  // --- top level ---
  if (!isPlainObject(spec)) {
    return {
      ok: false,
      hard: [{ code: 'spec-type', path: '', message: 'character spec must be an object' }],
      soft: [],
    }
  }

  // --- model (the character DEPENDS on render.modelName; model is sourced from
  //     ctx.model — the render-derived manifest id — OR spec.model as a
  //     backward-compat fallback). At least one must provide a model. ---
  const modelSource = spec.model || ctx.model
  if (typeof modelSource !== 'string' || !modelSource.trim()) {
    p('hard', 'model-missing', 'model', 'character requires a model — set render.modelName (ctx.model) or character.model')
  } else if (known && !known.has(modelSource)) {
    p('hard', 'model-unknown', 'model', `model manifest id '${modelSource}' not found in manifest`)
  }

  // --- subRig (optional) ---
  if (spec.subRig !== undefined && (typeof spec.subRig !== 'string' || !spec.subRig.trim())) {
    p('hard', 'subrig-empty', 'subRig', 'character.subRig, when present, must be a non-empty string')
  }

  // --- clips (required, hard) ---
  if (!isPlainObject(spec.clips) || Object.keys(spec.clips).length === 0) {
    p('hard', 'clips-empty', 'clips', 'character.clips must be a non-empty object mapping role -> clip manifest id')
  } else {
    for (const [role, clipId] of Object.entries(spec.clips)) {
      if (typeof clipId !== 'string' || !clipId.trim()) {
        p('hard', 'clip-empty', `clips.${role}`, `clip '${role}' must map to a non-empty clip manifest id`)
      } else if (known && !known.has(clipId)) {
        p('hard', 'clip-unknown', `clips.${role}`, `clip '${role}' references unknown manifest id '${clipId}'`)
      }
    }
    for (const role of RECOMMENDED_CLIP_ROLES) {
      if (!(role in spec.clips)) {
        p('soft', 'clip-recommended-missing', `clips.${role}`, `recommended clip role '${role}' is not declared (character will not ${role === 'walk' ? 'walk' : role})`)
      }
    }
  }

  // NOTE: scale/tint/textures are NOT animator fields (2026-08-29) — they are
  // model/render/transform concerns (render.material has color+map; transform
  // owns scale). No validation for them here.

  // --- boneMap (hard) ---
  if (spec.boneMap !== undefined && typeof spec.boneMap !== 'string') {
    p('hard', 'bonemap-type', 'boneMap', 'character.boneMap must be a string')
  } else if (typeof spec.boneMap === 'string') {
    const bm = spec.boneMap
    const validMode = BONE_MAP_MODES.includes(bm)
    const persisted = bm.startsWith(PERSISTED_BONE_MAP_PREFIX)
    if (!validMode && !persisted) {
      p('hard', 'bonemap-mode', 'boneMap', `unknown boneMap mode '${bm}' (expected "auto", "humanoid", or "retarget/<group>.json")`)
    }
  }

  // --- retarget (hard on invalid enums) ---
  if (spec.retarget !== undefined && !isPlainObject(spec.retarget)) {
    p('hard', 'retarget-type', 'retarget', 'character.retarget must be an object')
  } else if (isPlainObject(spec.retarget)) {
    const rt = spec.retarget
    if (rt.solver !== undefined && !RETARGET_SOLVERS.includes(rt.solver)) {
      p('hard', 'retarget-solver', 'retarget.solver', `unknown retarget solver '${rt.solver}' (expected ${RETARGET_SOLVERS.join(' | ')})`)
    }
    if (rt.bindPose !== undefined && typeof rt.bindPose !== 'boolean') {
      p('hard', 'retarget-bindpose', 'retarget.bindPose', 'bindPose must be a boolean')
    }
  }

  // --- rootMotion (hard) ---
  if (spec.rootMotion !== undefined && !ROOT_MOTION_MODES.includes(spec.rootMotion)) {
    p('hard', 'rootmotion-mode', 'rootMotion', `unknown rootMotion '${spec.rootMotion}' (expected ${ROOT_MOTION_MODES.join(' | ')})`)
  }

  // --- locomotion (both shapes: the legacy string-`when` state map AND the
  //     BT1 blend-space spec; hard on undeclared clip roles in either) ---
  const clipRoles = isPlainObject(spec.clips) ? spec.clips : {}
  if (spec.locomotion !== undefined && !isPlainObject(spec.locomotion)) {
    p('hard', 'locomotion-type', 'locomotion', 'character.locomotion must be an object')
  } else if (isPlainObject(spec.locomotion)) {
    const loco = spec.locomotion
    // Shape detection: `points`/`params` present → NEW blend-space spec; the
    // legacy shape's `states` entries carry string `when` conditions. The new
    // shape is validated field-level here; the legacy shape still validates
    // exactly as before (and auto-migrates at build time — buildBlendTree).
    const isNewShape = loco.points !== undefined || loco.params !== undefined
    if (isNewShape) {
      // params: a param name or array of 1-2 names (1 = 1D strip, 2 = 2D pad).
      let params = loco.params
      if (typeof params === 'string') params = [params]
      const dim = Array.isArray(params) ? params.length : 0
      if (dim < 1 || dim > 2 || !params.every((n) => typeof n === 'string' && n.trim())) {
        p('hard', 'locomotion-params', 'locomotion.params', 'locomotion.params must be a param name or an array of 1-2 param names (e.g. "speed" or ["velX", "velY"])')
      }
      // points: non-empty; `at` is numeric (1D) or [x, y] (2D), matching params.
      if (!Array.isArray(loco.points) || loco.points.length === 0) {
        p('hard', 'locomotion-points', 'locomotion.points', 'locomotion.points must be a non-empty array of { at, clip }')
      } else if (dim === 1 || dim === 2) {
        loco.points.forEach((pt, i) => {
          if (!isPlainObject(pt)) {
            p('hard', 'locomotion-point', `locomotion.points[${i}]`, 'each blend point must be an object { at, clip }')
            return
          }
          const atOk = dim === 2
            ? Array.isArray(pt.at) && pt.at.length === 2 && pt.at.every(Number.isFinite)
            : typeof pt.at === 'number' && Number.isFinite(pt.at)
          if (!atOk) {
            p('hard', 'locomotion-point-at', `locomotion.points[${i}].at`, dim === 2
              ? 'each 2D blend point needs at: [x, y] (two finite numbers)'
              : 'each 1D blend point needs a numeric at')
          }
          // Ascending order is NOT required in either dim — the evaluator sorts
          // internally; order is authorial only.
          if (typeof pt.clip !== 'string' || !pt.clip) {
            p('hard', 'locomotion-point-clip', `locomotion.points[${i}].clip`, 'each blend point must declare a clip role')
          } else if (!(pt.clip in clipRoles)) {
            p('hard', 'locomotion-point-clip-undeclared', `locomotion.points[${i}].clip`, `locomotion references clip role '${pt.clip}' which is not declared in character.clips`)
          }
        })
        // 2D soft warning — the canonical-layout rule (plan SECOND amendment):
        // idle belongs at the CENTER as an interior node so Delaunay fans the
        // space into clean (idle + adjacent rim pair) triangles. Fires when no
        // point sits within the middle half of the points' bounding box (the
        // rim-only 'missing center node' layout).
        const pts2d = loco.points.filter((pt) => isPlainObject(pt) && Array.isArray(pt.at) && pt.at.length === 2 && pt.at.every(Number.isFinite))
        if (pts2d.length >= 3) {
          const xs = pts2d.map((pt) => pt.at[0])
          const ys = pts2d.map((pt) => pt.at[1])
          const minX = Math.min(...xs)
          const maxX = Math.max(...xs)
          const minY = Math.min(...ys)
          const maxY = Math.max(...ys)
          const inMidHalf = (v, lo, hi) => v >= lo + (hi - lo) / 4 && v <= hi - (hi - lo) / 4
          const hasCenter = pts2d.some((pt) => inMidHalf(pt.at[0], minX, maxX) && inMidHalf(pt.at[1], minY, maxY))
          if (!hasCenter) {
            p('soft', 'locomotion-center-node', 'locomotion.points', 'locomotion blend space has no center point — add an idle/center node so direction triangles fan cleanly (Unity Freeform-Cartesian style)')
          }
        }
      }
      // states (override layer — data-only in BT1, runtime in BT2/BT3):
      // a hard-select list of { name, clip } — NOT the legacy `when` form.
      if (loco.states !== undefined) {
        if (!Array.isArray(loco.states)) {
          p('hard', 'locomotion-states', 'locomotion.states', 'locomotion.states must be an array')
        } else {
          loco.states.forEach((st, i) => {
            if (!isPlainObject(st)) {
              p('hard', 'locomotion-state', `locomotion.states[${i}]`, 'each override state must be an object { name, clip }')
              return
            }
            if (st.when !== undefined) {
              p('hard', 'locomotion-state-when', `locomotion.states[${i}].when`, 'new-shape override states are { name, clip } — string `when` conditions belong to the legacy locomotion shape')
            }
            if (typeof st.name !== 'string' || !st.name) {
              p('hard', 'locomotion-state-name', `locomotion.states[${i}].name`, 'each override state needs a state-field name (e.g. "airborne")')
            }
            if (typeof st.clip !== 'string' || !st.clip) {
              p('hard', 'locomotion-state-clip', `locomotion.states[${i}].clip`, 'each override state must declare a clip role')
            } else if (!(st.clip in clipRoles)) {
              p('hard', 'locomotion-state-clip-undeclared', `locomotion.states[${i}].clip`, `locomotion references clip role '${st.clip}' which is not declared in character.clips`)
            }
          })
        }
      }
    } else {
      if (loco.states !== undefined && !Array.isArray(loco.states)) {
        p('hard', 'locomotion-states', 'locomotion.states', 'locomotion.states must be an array')
      } else if (Array.isArray(loco.states)) {
        loco.states.forEach((st, i) => {
          if (!isPlainObject(st)) {
            p('hard', 'locomotion-state', `locomotion.states[${i}]`, 'each locomotion state must be an object')
            return
          }
          if (typeof st.when !== 'string' || !st.when) {
            p('hard', 'locomotion-when', `locomotion.states[${i}].when`, 'a locomotion state needs a string `when` condition (e.g. "speed > 0")')
          }
          if (typeof st.clip !== 'string' || !st.clip) {
            p('hard', 'locomotion-clip', `locomotion.states[${i}].clip`, 'each locomotion state must declare a clip role')
          } else if (!(st.clip in clipRoles)) {
            p('hard', 'locomotion-clip-undeclared', `locomotion.states[${i}].clip`, `locomotion references clip role '${st.clip}' which is not declared in character.clips`)
          }
        })
      }
      // The legacy block auto-migrates onto a blend space (BT1): conditions that
      // cannot migrate surface as SOFT warnings (see blendTree.js rules).
      const mig = migrateLocomotion(loco)
      for (const w of mig.warnings) {
        p('soft', 'locomotion-migrate', 'locomotion', w)
      }
    }
    if (loco.default !== undefined) {
      const defClip = typeof loco.default === 'string' ? loco.default : loco.default?.clip
      if (typeof defClip !== 'string' || !defClip) {
        p('hard', 'locomotion-default', 'locomotion.default', 'locomotion.default must be a clip role string or { clip: <role> }')
      } else if (!(defClip in clipRoles)) {
        p('hard', 'locomotion-default-undeclared', 'locomotion.default', `locomotion.default references clip role '${defClip}' which is not declared in character.clips`)
      }
    }
  }

  // --- bone-map coverage (hard, only when both supplied) ---
  if (ctx.boneMap !== undefined && ctx.targetRoles !== undefined) {
    const cov = validateBoneMapCoverage(ctx.boneMap, ctx.targetRoles)
    if (!cov.ok) {
      p('hard', 'bonemap-coverage', 'boneMap', `bone map fails to cover required skeleton roles: ${cov.missing.join(', ')}`)
    }
  }

  return { ok: hard.length === 0, hard, soft }
}
