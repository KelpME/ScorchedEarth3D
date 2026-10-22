/**
 * Bone-remap (retarget) animation utility — Backlog S (ANIMATION-RETARGETING.md).
 *
 * Animation clips only bind to a rig whose **bone names match** the clip's
 * tracks (three's AnimationMixer binds by `track.name`, sourcing the bone name
 * portion before the final `.`). When an animation pack uses a DIFFERENT
 * skeleton naming (Kevin Iglesias `B-*`, Mixamo `mixamorig:*`, generic `LeftArm`)
 * than the target rig's (`Root/Hips/Spine_01/UpperArm_L/...`, standard humanoid),
 * the clips will not bind as-is.
 *
 * This module rewrites a clip's tracks so they drive a target rig: track names
 * are remapped `srcBone.property -> targetBone.property` through a bone map
 * (`{ srcBone: targetBone }`), unknown source bones are dropped, and the input
 * clip is never mutated.
 *
 * Pure (no `three` import) so it unit-tests under Node/vitest like the other
 * engine math; the browser Renderer consumes the produced clip via its
 * AnimationMixer. The mapping can be authored as DATA (persisted per game and
 * edited by the human in the bone-mapper panel) — it is NOT hardcoded.
 */

/** @typedef {{ name: string, times: number[], values: ArrayLike<number>, interpolation?: number }} RetargetTrack */
/** @typedef {{ name?: string, duration: number, tracks: RetargetTrack[] }} RetargetClip */

/**
 * Split a track name into `[bone, property]` on the LAST dot, so a
 * `Bone.property` track (e.g. `B-upperArm.L.position`) yields the bone
 * `B-upperArm.L` and the property `position`. Tracks without a dot are treated
 * as `[name, null]`.
 * @param {string} name
 * @returns {[string, string|null]}
 */
export function splitTrackName(name) {
  const dot = typeof name === 'string' ? name.lastIndexOf('.') : -1
  if (dot < 0) return [name, null]
  return [name.slice(0, dot), name.slice(dot + 1)]
}

/**
 * Default humanoid bone map: source skeleton spellings -> PolygonFarm standard-
 * humanoid targets (`Root/Hips/Spine_01/...`), covering the real naming of the
 * packs the engine ships with, verified by decoding actual clips (2026-08-22):
 *   - Kevin Iglesias `B-*` (three decodes `B-thighL`, `B-upperArmL`, no dot)
 *   - Idle MoCap `MHuman_*` (Mixamo-style, `MHuman_L_Femur`, `MHuman_Spine1`)
 *   - Mixamo `mixamorig:*`
 *   - generic `LeftArm` / `LeftUpLeg` / `Spine1` (Blender, etc.)
 * One directional source->target entry per spelling; the farm nicknames
 * (`Spine_01`, `UpperLeg_L`, `Toes_L`, ...) are identity-mapped so an already-
 * bound clip round-trips harmlessly. Bones with no farm equivalent (jaw,
 * spineProxy, handProp, foot-visual, ToeEnd, Head_End, and the suffixed finger
 * chains — the farm rig's fingers are shared/unsuffixed) are intentionally
 * ABSENT, so retargetClip drops their tracks.
 * @type {Record<string,string>}
 */
export const HUMANOID_BONE_MAP = {
  // Kevin Iglesias B-* (bilateral is suffixed without a dot: B-thighL/B-thighR)
  Rig: 'Root',
  'B-root': 'Root',
  'B-hips': 'Hips',
  'B-spine': 'Spine_01',
  'B-chest': 'Spine_02',
  'B-neck': 'Neck',
  'B-head': 'Head',
  'B-shoulderL': 'Clavicle_L',
  'B-shoulderR': 'Clavicle_R',
  'B-upperArmL': 'Shoulder_L',
  'B-upperArmR': 'Shoulder_R',
  'B-forearmL': 'Elbow_L',
  'B-forearmR': 'Elbow_R',
  'B-handL': 'Hand_L',
  'B-handR': 'Hand_R',
  'B-thighL': 'UpperLeg_L',
  'B-thighR': 'UpperLeg_R',
  'B-shinL': 'LowerLeg_L',
  'B-shinR': 'LowerLeg_R',
  'B-footL': 'Toes_L',
  'B-footR': 'Toes_R',
  // Idle MoCap MHuman_* (Mixamo-style with an MHuman_ prefix)
  'MHuman_Root': 'Root',
  'MHuman_Spine1': 'Spine_01',
  'MHuman_Spine2': 'Spine_02',
  'MHuman_Spine3': 'Spine_03',
  'MHuman_Chest': 'Spine_03',
  'MHuman_Neck': 'Neck',
  'MHuman_Head': 'Head',
  'MHuman_L_Clav': 'Clavicle_L',
  'MHuman_R_Clav': 'Clavicle_R',
  'MHuman_L_Shoulder': 'Shoulder_L',
  'MHuman_R_Shoulder': 'Shoulder_R',
  'MHuman_L_Elbow': 'Elbow_L',
  'MHuman_R_Elbow': 'Elbow_R',
  'MHuman_L_Hand': 'Hand_L',
  'MHuman_R_Hand': 'Hand_R',
  'MHuman_L_Femur': 'UpperLeg_L',
  'MHuman_R_Femur': 'UpperLeg_R',
  'MHuman_L_Knee': 'LowerLeg_L',
  'MHuman_R_Knee': 'LowerLeg_R',
  'MHuman_L_Ankle': 'Toes_L',
  'MHuman_R_Ankle': 'Toes_R',
  // Mixamo mixamorig:*
  'mixamorig:Hips': 'Hips',
  'mixamorig:Spine': 'Spine_01',
  'mixamorig:Spine1': 'Spine_02',
  'mixamorig:Spine2': 'Spine_03',
  'mixamorig:Neck': 'Neck',
  'mixamorig:Head': 'Head',
  'mixamorig:LeftShoulder': 'Clavicle_L',
  'mixamorig:RightShoulder': 'Clavicle_R',
  'mixamorig:LeftArm': 'Shoulder_L',
  'mixamorig:RightArm': 'Shoulder_R',
  'mixamorig:LeftForeArm': 'Elbow_L',
  'mixamorig:RightForeArm': 'Elbow_R',
  'mixamorig:LeftHand': 'Hand_L',
  'mixamorig:RightHand': 'Hand_R',
  'mixamorig:LeftUpLeg': 'UpperLeg_L',
  'mixamorig:RightUpLeg': 'UpperLeg_R',
  'mixamorig:LeftLeg': 'LowerLeg_L',
  'mixamorig:RightLeg': 'LowerLeg_R',
  'mixamorig:LeftFoot': 'Toes_L',
  'mixamorig:RightFoot': 'Toes_R',
  // generic humanoid (Blender etc.)
  Hips: 'Hips',
  Spine: 'Spine_01',
  Spine1: 'Spine_02',
  Spine2: 'Spine_03',
  Neck: 'Neck',
  Head: 'Head',
  LeftShoulder: 'Clavicle_L',
  RightShoulder: 'Clavicle_R',
  LeftArm: 'Shoulder_L',
  RightArm: 'Shoulder_R',
  LeftForeArm: 'Elbow_L',
  RightForeArm: 'Elbow_R',
  LeftHand: 'Hand_L',
  RightHand: 'Hand_R',
  LeftUpLeg: 'UpperLeg_L',
  RightUpLeg: 'UpperLeg_R',
  LeftLeg: 'LowerLeg_L',
  RightLeg: 'LowerLeg_R',
  LeftFoot: 'Toes_L',
  RightFoot: 'Toes_R',
  // identity (farm nicknames) so an already-bound clip round-trips harmlessly
  Root: 'Root',
  Spine_01: 'Spine_01',
  Spine_02: 'Spine_02',
  Spine_03: 'Spine_03',
  Clavicle_L: 'Clavicle_L',
  Clavicle_R: 'Clavicle_R',
  Shoulder_L: 'Shoulder_L',
  Shoulder_R: 'Shoulder_R',
  Elbow_L: 'Elbow_L',
  Elbow_R: 'Elbow_R',
  Hand_L: 'Hand_L',
  Hand_R: 'Hand_R',
  UpperLeg_L: 'UpperLeg_L',
  UpperLeg_R: 'UpperLeg_R',
  LowerLeg_L: 'LowerLeg_L',
  LowerLeg_R: 'LowerLeg_R',
  Toes_L: 'Toes_L',
  Toes_R: 'Toes_R',
}

/**
 * Merge an authored (per-game, human-edited) bone map over the HUMANOID_BONE_MAP
 * default so common packs map with zero config and the human's overrides win.
 * An authored `''` (empty) value explicitly DROPS that source bone (retargetClip
 * leaves those tracks out) even though the default maps it.
 * @param {{ [srcBone: string]: string }} [map]  authored source->target map.
 * @returns {{ [srcBone: string]: string }} combined effective map.
 */
export function resolveBoneMap(map = {}) {
  return { ...HUMANOID_BONE_MAP, ...(map || {}) }
}

/**
 * Map ONE track name through the resolved bone map. Returns the new track name
 * (`targetBone.property`), or `null` when the source bone is absent from the
 * map (or explicitly mapped to an empty string) — the caller drops that track.
 * @param {string} name        source track name (`Bone.property`).
 * @param {Record<string,string>} map  resolved bone map.
 * @returns {string|null}
 */
export function remapTrackName(name, map) {
  const [bone, prop] = splitTrackName(name)
  const target = map[bone]
  if (target === undefined || target === null || target === '') return null
  return prop ? `${target}.${prop}` : target
}

/**
 * Unique source bone names present in a clip's tracks, in first-seen order
 * (from the bone portion of each `Bone.property` track name). What the bone
 * mapper panel shows for the SOURCE side of the mapping.
 * @param {RetargetClip} clip
 * @returns {string[]}
 */
export function clipSourceBones(clip) {
  const seen = new Set()
  const out = []
  for (const t of (clip && clip.tracks) || []) {
    const [bone] = splitTrackName(t && t.name)
    if (bone && !seen.has(bone)) {
      seen.add(bone)
      out.push(bone)
    }
  }
  return out
}

/**
 * Retarget a clip onto a target rig. Returns a NEW clip (never mutates `clip`
 * or its tracks) whose track names are remapped `srcBone.property` ->
 * `targetBone.property` through `resolveBoneMap(boneMap)`; tracks whose source
 * bone is unknown or explicitly dropped are omitted. Duplicate target names
 * (two source bones mapping to the same target) keep only the LAST occurrence.
 * @param {RetargetClip} clip
 * @param {{ [srcBone: string]: string }} [boneMap]  authored map (merged over default).
 * @returns {RetargetClip} new clip with remapped tracks.
 */
export function retargetClip(clip, boneMap) {
  const map = resolveBoneMap(boneMap)
  const seenTarget = new Set()
  const tracks = []
  for (const t of (clip && clip.tracks) || []) {
    const newName = t && t.name ? remapTrackName(t.name, map) : null
    if (newName === null) continue
    // last occurrence wins for a duplicate target
    if (seenTarget.has(newName)) {
      const i = tracks.findIndex((x) => x.name === newName)
      if (i >= 0) tracks.splice(i, 1)
    }
    seenTarget.add(newName)
    const out = { name: newName, times: t.times.slice(), values: t.values.slice() }
    if (t.interpolation !== undefined) out.interpolation = t.interpolation
    if (t.valueSize !== undefined) out.valueSize = t.valueSize
    tracks.push(out)
  }
  return {
    name: (clip && clip.name) || '',
    duration: clip ? clip.duration : 0,
    tracks,
  }
}