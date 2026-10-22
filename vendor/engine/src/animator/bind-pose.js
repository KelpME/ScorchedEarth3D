/**
 * bind-pose — correct a retargeted clip's per-bone rest-orientation mismatch.
 *
 * WHY THIS EXISTS: `retargetClip` rewrites track NAMES so a clip binds to a
 * target rig, but it does NOT fix the case where the SOURCE clip's baked rest
 * pose differs from the TARGET rig's rest pose. When they differ, applying the
 * clip rotates every target bone toward the source's (often ~180°-flipped)
 * rest — the "ball of parts" / contorted character. Measured on real rigs:
 * 19/20 bones needed a 100-175° correction at clip t=0.
 *
 * THE FIX (pure math, no third-party lib), using the target's OWN bind pose as
 * the anchor ("move one bone at a time against the model's reference"):
 *   For each mapped bone, compute the WORLD correction that maps the source
 *   bone's world bind onto the target bone's world bind:
 *     C_world = target_world_bind ⊗ source_world_bind⁻¹
 *   Then convert C_world into the LOCAL-space correction for that bone (so it
 *   composes with the clip's local quaternion tracks), by factoring out the
 *   bone's parent world transform:
 *     C_local = parentWorld⁻¹ ⊗ C_world ⊗ parentWorld
 *   and bake it:  q_target(t) = C_local ⊗ q_source_local(t).
 *   When the clip is at the source's rest (q_source_local = source_local_rest),
 *   the target bone lands at its own world bind. ✓
 *
 * PURE + Node-testable (THREE only). This is the bind-pose-alignment primitive
 * (Phase 5) implemented small + controlled + tested.
 */

import * as THREE from 'three'

/** Collect bone world bind quats + parent world quats, keyed by bone name. */
export function collectBindRest(model) {
  const world = new Map() // name -> world quat
  const parentWorld = new Map() // name -> parent world quat (identity if no bone parent)
  if (!model) return { world, parentWorld }
  model.updateMatrixWorld(true)
  model.traverse((o) => {
    if (!o.isBone) return
    if (world.has(o.name)) return
    world.set(o.name, o.getWorldQuaternion(new THREE.Quaternion()))
    if (o.parent && o.parent.isBone) {
      parentWorld.set(o.name, o.parent.getWorldQuaternion(new THREE.Quaternion()))
    } else {
      parentWorld.set(o.name, new THREE.Quaternion())
    }
  })
  return { world, parentWorld }
}

/**
 * Build per-bone LOCAL correction quaternions, keyed by TARGET bone name (what
 * the retargeted clip's tracks are named after `retargetClip` remapped them).
 * @param {{world:Map,parentWorld:Map}} srcRest  source bind (world + parent world)
 * @param {{world:Map,parentWorld:Map}} trgRest  target bind (world + parent world)
 * @param {Map<string,string>} boneMap  source bone name -> target bone name
 * @returns {Map<string, THREE.Quaternion>}  TARGET bone name -> LOCAL correction
 */
export function buildBindCorrections(srcRest, trgRest, boneMap) {
  const corrections = new Map()
  const q = new THREE.Quaternion()
  const srcInv = new THREE.Quaternion()
  const parentInv = new THREE.Quaternion()
  for (const [srcBone, trgBone] of boneMap) {
    const qs = srcRest.world.get(srcBone)
    const qt = trgRest.world.get(trgBone)
    const pw = trgRest.parentWorld.get(trgBone)
    if (!qs || !qt || !pw) continue
    // C_world = qt ⊗ qs⁻¹  (maps source world bind -> target world bind)
    srcInv.copy(qs).invert()
    q.copy(qt).multiply(srcInv)
    // Convert to local: C_local = parentInv ⊗ C_world ⊗ parentWorld
    parentInv.copy(pw).invert()
    const local = parentInv.clone().multiply(q).multiply(pw)
    // Key by TARGET name: the retargeted clip's tracks use target bone names.
    corrections.set(trgBone, local)
  }
  return corrections
}

/**
 * Apply per-bone bind-pose corrections to a clip's PLAIN retarget tracks.
 * Each track `Bone.quaternion` whose Bone is in the corrections map gets its
 * values premultiplied:  new_q = correction ⊗ old_q. Other tracks untouched.
 * Returns a NEW clip.
 */
export function applyBindCorrections(clip, corrections) {
  if (!clip || !corrections || corrections.size === 0) return clip
  const tracks = (clip.tracks || []).map((t) => {
    const [bone, prop] = splitProp(t.name)
    if (prop !== 'quaternion') return t
    const c = corrections.get(bone)
    if (!c) return t
    const values = new Float32Array(t.values.length)
    const q = new THREE.Quaternion()
    const res = new THREE.Quaternion()
    for (let i = 0; i < t.values.length; i += 4) {
      q.set(t.values[i], t.values[i + 1], t.values[i + 2], t.values[i + 3])
      res.copy(c).multiply(q)
      values[i] = res.x; values[i + 1] = res.y; values[i + 2] = res.z; values[i + 3] = res.w
    }
    return { ...t, values }
  })
  return { name: clip.name, duration: clip.duration, tracks }
}

/** Split `Bone.property` -> [bone, property] on the last dot. */
function splitProp(name) {
  const dot = typeof name === 'string' ? name.lastIndexOf('.') : -1
  if (dot < 0) return [name, null]
  return [name.slice(0, dot), name.slice(dot + 1)]
}
