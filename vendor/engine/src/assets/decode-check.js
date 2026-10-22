/**
 * decodeAndCheckModel — browser wrapper for backlog M.
 *
 * Fetches + decodes a model (FBX or GLTF/GLB via three's loaders) and runs
 * `modelHealthCheck` on the result, returning ONE structured pass/fail report.
 * A decode error becomes `{ decodes:false, ok:false, error, checks:[decode fail] }`
 * so the importer/editor can reject a broken model at import. Browser-bound
 * (fetch + loaders); the pure `modelHealthCheck` is Node-testable on its own.
 */
import { modelHealthCheck } from './model-health.js'
import { fbxDecoder } from './fbx-loader.js'

/**
 * @param {string} src  model URL/path (.fbx | .glb | .gltf)
 * @param {{ fetchFn?: (url:string)=>Promise<Response>, texturePath?: string }} [opts]
 * @returns {Promise<{ok, decodes, checks, ...}>}  modelHealthCheck report + { src, format }
 */
export async function decodeAndCheckModel(src, { fetchFn = fetch, texturePath } = {}) {
  const format = (src.split('?')[0].split('.').pop() || '').toLowerCase()
  let model
  try {
    const resp = await fetchFn(src)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const buffer = await resp.arrayBuffer()
    if (format === 'fbx') {
      model = await fbxDecoder({ arrayBuffer: async () => buffer }, src, { texturePath })
    } else if (format === 'glb' || format === 'gltf') {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
      const loader = new GLTFLoader()
      if (texturePath) loader.setResourcePath(texturePath)
      const gltf = await loader.parseAsync(buffer, '')
      model = gltf.scene
      model.animations = gltf.animations || []
    } else {
      throw new Error(`unsupported model extension: .${format || '(none)'}`)
    }
  } catch (err) {
    return {
      decodes: false, ok: false, src, format,
      error: String(err && err.message || err),
      checks: [{ name: 'decode', pass: false, detail: String(err && err.message || err) }],
    }
  }
  const report = modelHealthCheck(model)
  return { ...report, src, format }
}
