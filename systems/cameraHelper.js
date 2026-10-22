/**
 * cameraHelper — EDITOR TOOLING (W8-D, plan SE-COMPLETE-1012).
 *
 * THREE.CameraHelper visualization for camera entities. CameraHelper draws the
 * camera's frustum (frustum lines, cone, up vector, target, cross) directly
 * from the camera's projection matrix; three docs: call helper.update() after
 * any projection change, setColors() to re-tint, dispose() when done.
 *
 * HARD DOCTRINE: this is opt-in editor tooling — NOTHING in this module ever
 * touches a scene graph on its own. The only mount path is the seam main.js
 * installs as window.__se.cameraHelper (createCameraHelperSeam): enable()
 * parents the helper into the live renderer scene, disable() removes it and
 * disposes geometry+material. Plain game boot mounts the seam object but never
 * calls enable() — the scene graph at boot contains NO helper (pinned in
 * test/camera-visualizer.spec.js and test/unit/camera_helper.test.js).
 *
 * Editor-side mount point: the HermesForge engine renderer owns the selection
 * outline (engine/src/render/renderer.js — selection volume/Box3 floor reads
 * entity world matrices), but the editor app exposes no selection-helper hook
 * a game repo can reach, so the game-side seam is the mount (gap reported).
 *
 * Accent: #a8651a — the HermesForge editor bronze (--hf-accent,
 * hermesforge/theme/design-tokens.css:46), fed through CameraHelper.setColors.
 */

/** The HermesForge editor accent (bronze) — all five helper parts take it. */
export const CAMERA_HELPER_ACCENT = '#a8651a';

export const CAMERA_HELPER_NAME = 'se-camera-helper';

/**
 * Construct a CameraHelper for `camera`, tinted to the editor accent.
 * Never parents into any scene — pure construction.
 * @returns {{ helper: THREE.CameraHelper, camera: object, color: string, disposed: boolean,
 *             update(): void, dispose(): void }}
 */
export function createCameraHelper(THREE, camera, { color = CAMERA_HELPER_ACCENT } = {}) {
  const helper = new THREE.CameraHelper(camera);
  helper.name = CAMERA_HELPER_NAME;
  // Editor accent on every part: frustum, cone, up, target, cross. setColors
  // writes the per-vertex color attribute (single LineBasicMaterial).
  helper.setColors(new THREE.Color(color), new THREE.Color(color), new THREE.Color(color), new THREE.Color(color), new THREE.Color(color));
  const handle = {
    helper,
    camera,
    color,
    disposed: false,
    update() {
      // three docs: re-sync after projection-matrix changes.
      helper.update();
    },
    dispose() {
      if (handle.disposed) return; // idempotent — a double dispose is a no-op
      handle.disposed = true;
      if (helper.parent) helper.parent.remove(helper); // out of the scene graph FIRST
      helper.geometry.dispose();
      if (helper.material) helper.material.dispose();
      if (typeof helper.dispose === 'function') helper.dispose(); // newer three: helper's own teardown
    },
  };
  return handle;
}

/**
 * The game-side seam main.js installs as window.__se.cameraHelper.
 * enable(camera?) → handle (defaults to the getCamera() provider, i.e. the
 * live renderer camera the battlefield rig drives); disable() → disposed.
 * @param {{ THREE: object, scene: THREE.Scene, getCamera: () => THREE.Camera, color?: string }} deps
 */
export function createCameraHelperSeam({ THREE, scene, getCamera, color = CAMERA_HELPER_ACCENT }) {
  const seam = {
    enabled: false,
    handle: null,
    enable(camera) {
      if (seam.handle) return seam.handle; // idempotent — never a second helper
      const cam = camera || (typeof getCamera === 'function' ? getCamera() : null);
      if (!cam) throw new Error('[cameraHelper] enable() needs a camera (arg or getCamera provider)');
      const handle = createCameraHelper(THREE, cam, { color });
      scene.add(handle.helper); // THE only scene-graph write in this module
      seam.handle = handle;
      seam.enabled = true;
      return handle;
    },
    disable() {
      if (!seam.handle) return; // idempotent
      seam.handle.dispose(); // removes from parent + disposes geometry/material
      seam.handle = null;
      seam.enabled = false;
    },
  };
  return seam;
}
