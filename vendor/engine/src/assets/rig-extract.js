/**
 * Multi-rig extraction — turn ONE skinned mesh out of a shared-skeleton file
 * (e.g. Characters.fbx with 6 rigs sharing one bone tree) into an INDEPENDENT,
 * self-contained rig.
 *
 * Each rig in such a file is a SkinnedMesh whose `skeleton.bones` reference the
 * SHARED bones. To drive one character on its own (so the player and boss are
 * separate rigs and can animate independently), we clone just the bones that
 * rig needs (preserving the ancestor chain) and re-bind a cloned SkinnedMesh to
 * a new Skeleton of those cloned bones.
 *
 * This is the SHARED sub-rig pipeline behind a reusable `modelName`
 * (e.g. `Characters.fbx:SM_Chr_FarmBoy_01`): both the game `main.js` and the
 * editor viewport resolve the same manifest `subRig` hint through this
 * function, so Play and the editor agree on the rig. Pure-ish (needs THREE);
 * does not touch the renderer.
 *
 * @param {THREE.Object3D} source  the decoded multi-rig model
 * @param {string} meshName  the SkinnedMesh to extract (its `name`)
 * @returns {THREE.Group|null}  an independent rig Group named `meshName`, or
 *   null if the mesh isn't found / isn't a skinned mesh with bones.
 */
import * as THREE from 'three'

export function extractRig(source, meshName) {
  let mesh = null
  source.traverse((o) => { if (o.isMesh && o.name === meshName) mesh = o })
  if (!mesh || !mesh.skeleton || !mesh.skeleton.bones.length) return null
  // Clone every bone this rig's skeleton needs, preserving the ancestor chain
  // up to (but not including) a non-bone root, so the rig is self-contained.
  const needed = new Map() // originalBone -> clonedBone
  const roots = []
  const chain = (b) => {
    if (needed.has(b)) return
    if (b.parent && b.parent.isBone) chain(b.parent)
    // SHALLOW clone the bone (copy properties, NOT children). A deep
    // `bone.clone()` drags in the whole shared subtree (all sibling rigs' bones
    // under a shared root) and inflates the extracted rig's bone count by
    // ~50x, collapsing the mesh into a ball. We rebuild children by parent
    // linkage ourselves below.
    const clone = new THREE.Bone()
    clone.name = b.name
    clone.position.copy(b.position)
    clone.quaternion.copy(b.quaternion)
    clone.scale.copy(b.scale)
    clone.rotation.copy(b.rotation)
    clone.matrix.copy(b.matrix)
    clone.matrixWorld.copy(b.matrixWorld)
    if (b.userData) clone.userData = { ...b.userData }
    needed.set(b, clone)
    const parent = b.parent && b.parent.isBone ? needed.get(b.parent) : null
    if (parent) parent.add(clone)
    else roots.push(clone)
  }
  for (const b of mesh.skeleton.bones) chain(b)
  // Rebuild the skeleton from the cloned bones + cloned inverses.
  const newBones = mesh.skeleton.bones.map((b) => needed.get(b))
  const newInverses = mesh.skeleton.boneInverses.map((m) => m.clone())
  const newSkeleton = new THREE.Skeleton(newBones, newInverses)
  const newMesh = mesh.clone()
  newMesh.skeleton = newSkeleton
  newMesh.bind(newSkeleton, mesh.bindMatrix ? mesh.bindMatrix.clone() : new THREE.Matrix4())
  const rig = new THREE.Group()
  rig.name = meshName
  for (const r of roots) rig.add(r)
  rig.add(newMesh)
  return rig
}

/**
 * Scale + ground an EXTRACTED rig uniformly, in place (the rig itself is the
 * mixer root — its `.animations` clips must stay attached, so unlike
 * `placeModelOnGround` we do NOT wrap it in a new group). This is the shared
 * placement step for sub-rigs: the game `main.js` and the editor viewport call
 * the same helper, so Play and the editor agree on footprint + feet-on-ground.
 *
 * @param {THREE.Group} rig  an extracted rig (from `extractRig`)
 * @param {number} [scale=1]  ONE uniform pack-scale factor (preserve natural proportions)
 * @returns {THREE.Group}  the same rig (mutated): uniform-scaled, X/Z centered,
 *   feet-on-ground (bbox.min.y = 0).
 */
export function placeRigOnGround(rig, scale = 1) {
  if (!rig) return rig
  rig.scale.setScalar(scale)
  rig.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(rig)
  rig.position.set(
    -(box.min.x + box.max.x) / 2,
    -box.min.y,
    -(box.min.z + box.max.z) / 2,
  )
  return rig
}
