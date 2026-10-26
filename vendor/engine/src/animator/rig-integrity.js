/**
 * rig-integrity — deterministic rig health assessment for animated characters.
 *
 * THE missing verification surface: before judging a character visually, this
 * gives a programmatic, objective read on whether a rig is even sane. It answers
 * the questions that were only answerable by squinting at screenshots:
 *
 *   1. Is the rig's BONE COUNT sane?  (a collapsed/corrupted rig shows a huge
 *      or degenerate bone tree — e.g. a deep-clone explosion pulling in
 *      thousands of duplicate bones, or a bare skeleton with almost none)
 *   2. Is the MESH SKINNED and bound to its skeleton?  (a mesh with no
 *      skinIndex/weights, or bound to a different skeleton than the tree,
 *      can't animate and may collapse)
 *   3. Is the BIND/REST POSE a sane upright humanoid?  (head above hips, spine
 *      pointing up, limbs roughly perpendicular — catches the "ball of parts"
 *      where a retargeted clip or a wrong bind leaves the rig horizontal)
 *
 * PURE and Node-testable (THREE only, no DOM/WebGL). This is the "rig is
 * broken" gate that runs at assembly time so we never have to discover it by
 * looking at a render.
 *
 * GENERALIZATION RULE: describes rigs by CHARACTERISTICS (bone count sanity,
 * skinned+bound, upright bind pose), never by specific asset names.
 */

import * as THREE from 'three'

/** Collect a rig's bone tree + mesh skinning facts. */
export function analyzeRig(rig) {
  const result = {
    boneCount: 0,
    uniqueBoneNames: 0,
    meshCount: 0,
    skinnedMeshCount: 0,
    unskinnedMeshCount: 0,
    meshBoneCount: null,       // skeleton bones on the (first) skinned mesh
    meshBonesMatchTree: null,  // does the mesh skeleton reference the same bone objects as the tree?
    bind: null,                // { spineUp, headAboveHips, headY, hipsY, rootY }
    bounds: null,              // { size: [x,y,z], volume }
  }
  if (!rig) return result

  const bones = []
  const boneNames = new Set()
  let skelBones = null
  let skelMesh = null
  rig.traverse((o) => {
    if (o.isBone) { bones.push(o); boneNames.add(o.name) }
    if (o.isMesh) {
      result.meshCount++
      if (o.isSkinnedMesh) {
        result.skinnedMeshCount++
        if (!skelMesh && o.skeleton) { skelMesh = o; skelBones = o.skeleton.bones }
      } else {
        result.unskinnedMeshCount++
      }
    }
  })
  result.boneCount = bones.length
  result.uniqueBoneNames = boneNames.size

  if (skelBones) {
    result.meshBoneCount = skelBones.length
    result.meshBonesMatchTree = skelBones.every((b) => bones.includes(b))
  }

  // Bind pose: measure the skeleton at REST (no animation applied). Use the
  // bone tree's world positions as-is (the bind state).
  if (bones.length > 0) {
    rig.updateMatrixWorld(true)
    const pos = {}
    for (const b of bones) {
      const v = b.getWorldPosition(new THREE.Vector3())
      pos[b.name] = v
    }
    // Find head/hips: prefer KNOWN humanoid role names, else fall back to a
    // STRUCTURAL guess (topmost bone = head-ish, its deepest ancestor with a
    // mirror pair = hips-ish). Structural fallback lets non-standard-named rigs
    // (kevin `B-*`, protofactor, etc.) still get a bind-pose read.
    const nameHead = pos['Head'] || pos['mixamorig:Head'] || pos['mixamorig6Head'] || pos['head'] || pos['B-head'] || pos['B-Head']
    const nameHips = pos['Hips'] || pos['mixamorig:Hips'] || pos['mixamorig6Hips'] || pos['pelvis'] || pos['B-hips'] || pos['B-Hips']
    let hips, head, spine, root
    if (nameHead && nameHips) {
      hips = nameHips; head = nameHead
      spine = pos['Spine_02'] || pos['Spine_01'] || pos['mixamorig:Spine2'] || pos['mixamorig6Spine2'] || pos['B-spine']
      root = pos['Root'] || pos['mixamorig:Hips'] || pos['mixamorig6Hips'] || pos['B-root'] || pos['B-hips']
    } else {
      // Structural fallback: the head-ish bone is the bone whose world Y is
      // HIGHEST and is a leaf/deepest; hips-ish is the LOWEST non-foot ancestor.
      // For a sane upright humanoid, the highest bone is the head and the
      // lowest (above the feet) is near the hips.
      let maxY = -Infinity, maxBone = null
      for (const b of bones) { const p = pos[b.name]; if (p && p.y > maxY) { maxY = p.y; maxBone = b.name } }
      // hips-ish = the bone at the bottom of the torso: the one whose y is
      // closest to the feet but is NOT a foot/toe. Approximate as the bone at
      // ~25-35% of the total height above the lowest point.
      let minY = Infinity
      for (const b of bones) { const p = pos[b.name]; if (p && p.y < minY) minY = p.y }
      const totalH = maxY - minY
      let bestHip = null, bestScore = Infinity
      for (const b of bones) {
        const p = pos[b.name]; if (!p) continue
        const frac = (p.y - minY) / Math.max(totalH, 1e-6)
        const score = Math.abs(frac - 0.3)
        if (score < bestScore && !/toe|foot|ball|ankle/i.test(b.name)) { bestScore = score; bestHip = b.name }
      }
      head = maxBone ? pos[maxBone] : null
      hips = bestHip ? pos[bestHip] : null
      root = pos['Root'] || pos['B-root'] || pos['mixamorig:Hips'] || pos['mixamorig6Hips']
      spine = null
    }
    if (hips && head) {
      result.bind = {
        spineUp: [head.x - hips.x, head.y - hips.y, head.z - hips.z],
        headAboveHips: head.y > hips.y,
        headY: head.y,
        hipsY: hips.y,
        rootY: root ? root.y : null,
        // ratio of vertical rise (head-hips) to horizontal drift — a healthy
        // humanoid rises mostly vertically (ratio >> 1)
        uprightRatio: Math.abs(head.y - hips.y) / Math.max(Math.hypot(head.x - hips.x, head.z - hips.z), 1e-6),
        // record which bones were used, for diagnostics
        headBone: head === nameHead ? (nameHead ? 'name' : 'structural') : 'structural',
        hipsBone: hips === nameHips ? (nameHips ? 'name' : 'structural') : 'structural',
      }
    }
  }

  // World bounds (sane non-collapsed volume). Guard: a skinned mesh with a
  // skeleton whose bone indices don't resolve can throw in computeBoundingBox —
  // bounds are informational, not a hard gate, so never let that fail analysis.
  try {
    const box = new THREE.Box3().setFromObject(rig)
    if (!box.isEmpty()) {
      const size = box.getSize(new THREE.Vector3())
      result.bounds = { size: size.toArray(), volume: size.x * size.y * size.z }
    }
  } catch { /* bounds unavailable — skip (informational) */ }

  return result
}

/**
 * Assess a rig's integrity, returning { ok, problems, report }.
 * `ok` is false if ANY problem is found.
 */
export function checkRigIntegrity(rig, opts = {}) {
  const report = analyzeRig(rig)
  const problems = []
  const { requireUpright = true, boneRatioMax = 12 } = opts

  // 1. Bone count sanity. A multi-rig extraction should be ~1-2x the mesh's
  //    skeleton bones, BUT rigs legitimately carry many non-skinning control
  //    bones (IK targets, poles, weapon attachments) that don't influence the
  //    mesh skeleton — so only a GROSS inflation (>20x, e.g. the deep-clone
  //    explosion that was 2669:49 = 54x) is a collapse signal. A few extra
  //    control bones (61:8) is a normal rig, not a collapse.
  if (report.meshBoneCount && report.boneCount > report.meshBoneCount * boneRatioMax) {
    problems.push(`bone tree (${report.boneCount}) >> mesh skeleton (${report.meshBoneCount}) — collapsed/inflated rig`)
  } else if (report.meshBoneCount && report.boneCount < report.meshBoneCount) {
    problems.push(`bone tree (${report.boneCount}) < mesh skeleton (${report.meshBoneCount}) — missing bones`)
  }
  if (report.boneCount === 0) {
    problems.push('no bones — not a rig')
  }

  // 2. Skinning.
  if (report.skinnedMeshCount === 0) {
    problems.push('no skinned mesh — cannot animate')
  }
  if (report.meshBonesMatchTree === false) {
    problems.push('mesh skeleton bones do not match the rig bone tree')
  }

  // 3. Bind pose uprightness — SOFT (informational), never a hard block.
  //    A genuinely non-humanoid rig (a frog, quadruped, creature) legitimately
  //    isn't "upright", so this is a diagnostic note, not a failure.
  const soft = []
  if (requireUpright && report.bind) {
    if (!report.bind.headAboveHips) {
      soft.push(`bind pose NOT upright (head y=${report.bind.headY.toFixed(2)} <= hips y=${report.bind.hipsY.toFixed(2)})`)
    } else if (report.bind.uprightRatio < 1) {
      soft.push(`bind pose horizontal (uprightRatio ${report.bind.uprightRatio.toFixed(2)} — spine drifts sideways more than it rises)`)
    }
  } else if (requireUpright && !report.bind) {
    soft.push('no head/hips found to assess bind pose')
  }

  // 4. Non-degenerate bounds.
  if (report.bounds && report.bounds.volume < 1e-4) {
    problems.push('collapsed bounds (near-zero volume)')
  }

  return { ok: problems.length === 0, problems, soft, report }
}
