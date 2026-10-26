/**
 * Model placement helpers — scale + feet-on-ground placement for imported
 * 3D models (Synty/Polygon, Mixamo, etc.).
 *
 * PROBLEM: imported FBX ships at its own baked origin and scale. Naively
 * centering the bounding box on the ORIGIN in all three axes places the model's
 * vertical CENTER at y=0, so the model straddles the ground — half below, half
 * above (the "models sitting in the ground" bug). The correct placement is:
 *   - scale by a UNIFORM factor (preserving the pack's natural proportions)
 *   - center on X and Z (so it's centered on its transform)
 *   - place the model's bbox MIN-Y at y=0 (feet-on-ground)
 *
 * Pure three.js math — Node-testable, no DOM/WebGL needed. Used by both the
 * game boot (main.js) and the editor viewport (loadModelAsset) so Play and the
 * editor agree on placement.
 */
import * as THREE from 'three'

/**
 * Place a loaded model on the ground plane: uniform scale + X/Z centering +
 * feet-on-ground (bbox.min.y -> 0). Wraps the model so the renderer's per-frame
 * wrapper repositioning (position from the entity transform) never clobbers it.
 *
 * @param {THREE.Object3D} model  the decoded model (mutated: scaled + re-centered)
 * @param {number} [scale]  uniform scale factor (1 = native baked size). Preserves
 *                          the pack's natural proportions (do NOT per-model normalize).
 * @param {number} [rotationY=0]  uniform rotation about Y (radians) applied BEFORE
 *                          scaling/centering, so a model whose nose points along an
 *                          axis other than +Z (the engine's yaw-forward convention)
 *                          can be normalized once per pack. E.g. a fish whose body
 *                          runs along X needs rotationY = Math.PI/2 so its nose faces
 *                          +Z and it leads with its nose when the renderer applies
 *                          the entity's `yaw`. Applied to the model's local rotation
 *                          before the placement bbox is computed, so X/Z centering
 *                          and feet-on-ground stay correct.
 * @returns {THREE.Group}  a wrapper Group whose origin is the ground point (x,z)
 *                         under the model's center, y=0 at the model's feet.
 */
export function placeModelOnGround(model, scale = 1, rotationY = 0) {
  if (rotationY) model.rotation.y += rotationY
  model.scale.setScalar(scale)
  model.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const min = box.min

  // Center X/Z (so the wrapper origin is the model's ground-center), and lift so
  // the model's BOTTOM (min.y) sits at y=0 (feet-on-ground), NOT its vertical
  // center. This is the fix for models sinking half into the ground.
  const wrap = new THREE.Group()
  wrap.add(model)
  model.position.set(
    -(min.x + size.x / 2),
    -min.y,
    -(min.z + size.z / 2),
  )
  wrap.updateMatrixWorld(true)
  return wrap
}

/**
 * Compute a uniform scale factor that lands a chosen anchor model at a target
 * size, keeping the WHOLE pack's natural proportions (one factor, not per-model).
 *
 * @param {THREE.Object3D} anchorModel  the pack's biggest/anchor model (e.g. farmhouse)
 * @param {number} [anchorLongest=1345] the anchor's raw baked longest-axis length.
 *        Pass the known baked size OR pass the raw model and it's measured.
 * @param {number} [targetLongest]  desired size for the anchor (e.g. 6 units).
 * @returns {number}  uniform scale factor for the whole pack.
 */
export function packScaleFor(anchorModel, targetLongest, anchorLongest) {
  if (anchorModel && !anchorLongest) {
    anchorModel.updateMatrixWorld(true)
    const size = new THREE.Box3().setFromObject(anchorModel).getSize(new THREE.Vector3())
    anchorLongest = Math.max(size.x, size.y, size.z) || 1
  }
  return targetLongest / (anchorLongest || 1)
}
