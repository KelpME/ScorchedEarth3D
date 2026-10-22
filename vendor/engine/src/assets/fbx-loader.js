/**
 * FBX runtime decoder (browser-bound) using three's built-in FBXLoader.
 *
 * HermesForge loads the source formats the Unity library actually contains
 * directly (no FBX->GLB conversion step). FBX files are decoded here with
 * `THREE.FBXLoader` from 'three/examples/jsm/loaders/FBXLoader.js'.
 *
 * This module is browser-bound in the sense that it decodes a real FBX buffer,
 * but it is safe to import in Node tests (no WebGL, no DOM) — the 'three'
 * import is kept lazy inside `fbxDecoder` so merely importing this module does
 * not pull in a WebGL context.
 */

/**
 * Decode an FBX asset from a fetch Response into a THREE.Group.
 *
 * FBX models often reference external PBR textures (baseColor/normal/metallic/
 * roughness/emissive/AO) by relative filename. three's FBXLoader resolves those
 * against a texture path; the default (empty) path resolves them to the page
 * root and 404s, leaving the model untextured. Pass `opts.texturePath` (e.g.
 * './assets/') so referenced textures load from the game's assets dir.
 *
 * @param {Response} resp  a Response with .arrayBuffer() (from a fetch of the .fbx)
 * @param {string} src     the source path (used in error messages only)
 * @param {{ texturePath?: string }} [opts]  texture base path for FBXLoader
 * @returns {Promise<THREE.Group>} the parsed FBX scene graph
 */
export async function fbxDecoder(resp, src, opts = {}) {
  let buffer
  try {
    buffer = await resp.arrayBuffer()
  } catch (err) {
    throw new Error(`fbxDecoder: failed to read arrayBuffer for "${src}": ${err.message}`)
  }

  // Lazy import so this module can be loaded under Node/vitest without a WebGL
  // context; FBXLoader only needs the buffer + parser for .parse().
  let FBXLoader
  try {
    ;({ FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js'))
  } catch (err) {
    throw new Error(`fbxDecoder: could not load FBXLoader for "${src}": ${err.message}`)
  }

  try {
    // FBXLoader resolves referenced textures against `resourcePath` (NOT `path`,
    // which is only used for loading the .fbx model file) — see FBXLoader.js
    // `new TextureLoader(...).setPath(this.resourcePath || path)`. So setResourcePath.
    // An optional `manager` (THREE.LoadingManager) is passed through so callers
    // can map FBX-internal texture references onto declared URLs (URL modifier).
    const loader = new FBXLoader(opts.manager)
    if (opts.texturePath) loader.setResourcePath(opts.texturePath)
    return loader.parse(buffer, '')
  } catch (err) {
    throw new Error(`fbxDecoder: failed to parse FBX "${src}": ${err.message}`)
  }
}
