/**
 * Model importer — the ONE systematic procedure for turning a decoded model
 * asset into a ready-to-render object. Consolidates every hard-won placement /
 * material / texture fix so game `main.js` and the editor `loadModelAsset`
 * share a single path (no more per-model hacks).
 *
 * Pipeline (in order):
 *   1. decode      (FBX/GLTF already done by caller OR via fbxDecoder)
 *   2. textures    import + load the referenced external texture files
 *   3. materials   resolve: vertex-colored -> Basic vertexColors; textured ->
 *                  Lambert + loaded map; else flat tint
 *   4. scale       ONE uniform factor per pack (preserve natural proportions)
 *   5. ground      feet-on-ground (bbox.min.y = 0) + X/Z centered
 *   6. verify      returns a material/placement report for asserting
 *
 * Browser-bound (needs THREE + TextureLoader). Pure math (scale/ground) is in
 * model-placement.js and Node-testable separately.
 */
import * as THREE from 'three'
import { fbxDecoder } from './fbx-loader.js'
import { convertFbxMaterialsToPbr } from './fbx-adapter.js'
import { placeModelOnGround } from './model-placement.js'

/** Texture file extensions three's TextureLoader CANNOT load directly (must be
 * converted to PNG/JPG first — e.g. .tga needs the TGA loader, .psd unsupported). */
const TEXTURE_EXT = { '.png': 1, '.jpg': 1, '.jpeg': 1, '.webp': 1 }

/**
 * Resolve a decoded model's materials so it RENDERS correctly:
 *  - GLB/GLTF-embedded usable materials are KEPT VERBATIM (lossless import:
 *    the asset is the source of truth — names, colors, type preserved exactly;
 *    three's GLTFLoader already emits fully-resolved MeshStandardMaterials).
 *    The fallbacks below apply ONLY to meshes with no material or with a
 *    material the pipeline genuinely cannot use (the FBX cases below).
 *  - meshes WITH a loaded texture  -> MeshLambertMaterial with the EXPLICITLY
 *    loaded map (three's FBXLoader assigns a map but does NOT load the image
 *    even with texturePath — map.image stays null and the model renders black)
 *  - textured meshes that ALSO have baked vertex colors STILL use the texture —
 *    a referenced texture is the authored intent; vertex colors are only a
 *    fallback for UNTEXTURED meshes. (This is the fix for polygon characters
 *    like the farmboy whose FBX carries both vertex colors AND a farm atlas:
 *    the old heuristic let vertex colors win and ignored the texture, rendering
 *    the character black.)
 *  - untextured vertex-colored meshes -> unlit MeshBasicMaterial({vertexColors:true})
 *    (three's FBXLoader Lambert renders vertex-colored FBX as BLACK)
 *  - else                   -> unlit MeshBasicMaterial with a flat tint
 *
 * @param {THREE.Object3D} model
 * @param {string[]} textureUrls  absolute URLs of the model's referenced textures
 * @param {object} [opts]
 * @param {number} [opts.tint]  hex color for non-textured, non-vertex meshes
 * @param {(url:string)=>Promise<THREE.Texture>} [opts.loadTexture]  injectable
 *        texture loader (defaults to THREE.TextureLoader)
 * @returns {Promise<{ materials: string[], mapsLoaded: string[], tints: string[] }>}
 */
export async function resolveModelMaterials(model, textureUrls = [], {
  tint, loadTexture,
} = {}) {
  const load = loadTexture || ((url) => new Promise((res, rej) => new THREE.TextureLoader().load(url, res, undefined, rej)))
  const loaded = {}
  for (const url of textureUrls) {
    const dot = (url.split('?')[0].split('.').pop() || '').toLowerCase()
    const ext = '.' + dot
    if (!TEXTURE_EXT[ext]) {
      console.warn(`[model-importer] skipping unsupported texture ext ${ext} for ${url} (convert to PNG/JPG)`)
      continue
    }
    try { loaded[url] = await load(url) } catch (err) {
      // NOISY (never silent): a declared texture that fails to load means the
      // model renders with fallback tint — loud error names the URL + fix.
      console.error(`[model-importer] declared texture failed to load: ${url} — material falls back to tint/vertex colors; check the manifest textures entry / file presence`, err)
    }
  }
  const maps = Object.values(loaded).filter((t) => t && t.image)
  const report = { materials: [], mapsLoaded: [], tints: [] }
  // A decoded mesh material is USABLE when the decoder already emitted a
  // fully-resolved PBR material we can render as-is. three's GLTFLoader emits
  // MeshStandardMaterial (MeshPhysicalMaterial subclasses it) with embedded
  // texture images loaded; three's FBXLoader never does (it emits
  // Phong/Lambert/Basic, which is why the tint/vertex-color fallbacks exist).
  // Lossless rule: if the mesh carries one, KEEP IT VERBATIM — the asset is
  // the source of truth (names + colors + type preserved exactly).
  const isUsableEmbedded = (m) => !!m && !!m.isMaterial && !!m.isMeshStandardMaterial
    && !(m.map && !m.map.image) // a referenced texture whose image never loaded is NOT usable
  model.traverse((o) => {
    if (!o.isMesh) return
    const existing = o.material
    if (Array.isArray(existing) ? existing.every(isUsableEmbedded) : isUsableEmbedded(existing)) {
      report.materials.push(`embedded:${(Array.isArray(existing) ? existing[0] : existing).name || '(unnamed)'}`)
      return // lossless: keep the authored material exactly as decoded
    }
    const attr = o.geometry && o.geometry.getAttribute && o.geometry.getAttribute('color')
    const hasVC = !!attr
    // Vertex colors that are ALL WHITE carry no useful baked color (common on
    // rigs whose material is really a texture or flat tint). Treat them as
    // "no color" so the caller's tint (or the grey default) applies — otherwise
    // such a model renders a featureless white silhouette.
    const allWhiteVC = hasVC && (() => {
      const a = attr.array; const n = a.length / attr.itemSize
      for (let i = 0; i < n; i++) {
        const oi = i * attr.itemSize
        const r = a[oi], g = a[oi + 1], b = a[oi + 2]
        if (Math.abs(r - 1) > 0.02 || Math.abs(g - 1) > 0.02 || Math.abs(b - 1) > 0.02) return false
      }
      return true
    })()
    if (maps.length > 0) {
      // A loaded texture is the authored look and wins over baked vertex colors.
      o.material = new THREE.MeshLambertMaterial({ map: maps[0] })
      report.materials.push('MeshLambertMaterial:texture')
      report.mapsLoaded.push(maps[0].image?.currentSrc || maps[0].image?.src || 'texture')
    } else if (hasVC && !allWhiteVC) {
      o.material = new THREE.MeshBasicMaterial({ vertexColors: true })
      report.materials.push('MeshBasicMaterial:vertexColors')
    } else {
      o.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(tint ?? 0x9a9a9a) })
      report.materials.push(allWhiteVC ? 'MeshBasicMaterial:tint(allWhiteVC)' : 'MeshBasicMaterial:tint')
      report.tints.push((tint ?? 0x9a9a9a).toString(16))
    }
  })
  return report
}

/**
 * Full model import pipeline (decode -> materials -> scale -> ground).
 * @param {Response|THREE.Object3D} input  a fetch Response (.fbx/.glb) OR an
 *        already-decoded THREE.Object3D (then `format` is unused)
 * @param {object} [opts]
 * @param {string} [opts.format]  'fbx' | 'glb' | 'gltf' (for Response input)
 * @param {string} [opts.src]     model path (errors + texturePath base)
 * @param {string} [opts.texturePath]  base path for FBXLoader texture resolution
 * @param {string[]} [opts.textures]   absolute URLs of referenced textures to load
 * @param {number} [opts.scale=1]      UNIFORM pack scale factor
 * @param {number} [opts.rotationY=0]  uniform rotation about Y (radians) to normalize a
 *        model whose nose doesn't point along +Z (the engine's yaw-forward convention),
 *        e.g. rotationY = Math.PI/2 for a fish whose body runs along X.
 * @param {number} [opts.tint]         flat tint for non-textured meshes
 * @returns {Promise<{ group: THREE.Group, report: object }>}  ready-to-register group + report
 */
export async function importModel(input, opts = {}) {
  const {
    format, src = '', texturePath, textures = [], scale = 1, rotationY = 0, tint,
  } = opts
  let model
  let fmt = ''
  if (input instanceof THREE.Object3D) {
    model = input
  } else {
    fmt = String(format || '').replace(/^\./, '').toLowerCase() // strip leading dot
    if (fmt === 'fbx') {
      // Route FBX-internal texture references through the DECLARED texture list:
      // three's FBXLoader resolves a referenced texture (by relative filename)
      // at PARSE time — with no resourcePath that resolves to the page root
      // (e.g. /editor/PolyPackFish.png -> 404 per model parse, per fish). A
      // LoadingManager URL modifier maps each requested texture whose basename
      // matches a declared texture to that declared URL, so the internal ref
      // and the declared texture are the SAME fetch (no 404, one decode).
      const opts2 = { texturePath }
      if (Array.isArray(textures) && textures.length) {
        const byBase = new Map(textures.map((u) => [String(u).split('?')[0].split('/').pop().toLowerCase(), u]))
        const manager = new THREE.LoadingManager()
        manager.setURLModifier((url) => {
          const base = (String(url).split('?')[0].split('/').pop() || '').toLowerCase()
          return byBase.get(base) || url
        })
        opts2.manager = manager
      }
      model = await fbxDecoder(input, src, opts2)
    }
    else if (fmt === 'glb' || fmt === 'gltf') {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
      const loader = new GLTFLoader()
      if (texturePath) loader.setResourcePath(texturePath)
      const buffer = await input.arrayBuffer()
      const gltf = await loader.parseAsync(buffer, '')
      model = gltf.scene
    } else throw new Error(`importModel: unsupported format '${format}'`)
  }
  // FBX only (S3-4): convert FBXLoader's Phong/Lambert to MeshStandardMaterial
  // BEFORE resolveModelMaterials, so the converted materials pass the
  // isUsableEmbedded rule and are KEPT VERBATIM (3 distinct authored materials
  // survive instead of one flat tint). GLB/GLTF decoding already emits
  // Standard materials — this branch is keyed to fmt === 'fbx' and never runs
  // for them. Recorded (op list returned in report + on group.userData so the
  // editor glue can stamp it into the IR provenance) — never silent.
  const materialNormalization = (fmt === 'fbx' && model && typeof model.traverse === 'function')
    ? convertFbxMaterialsToPbr(model)
    : []
  const report = await resolveModelMaterials(model, textures, { tint })
  report.materialNormalization = materialNormalization
  const group = placeModelOnGround(model, scale, rotationY)
  group.userData.materialNormalization = materialNormalization
  return { group, report }
}
