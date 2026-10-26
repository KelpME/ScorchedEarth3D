/**
 * modelHealthCheck — model/asset decode health check (backlog M).
 *
 * "A model that decodes is not a model that renders correctly." This returns a
 * structured pass/fail report for a DECODED model (a THREE.Object3D — any
 * format three's loaders produce: FBX group, GLTF scene, ...) so a broken model
 * is rejected at IMPORT, not discovered mid-gameplay. It is tooling, not
 * genre-shaped gameplay — every game that imports models benefits from it.
 *
 * Checks (each with pass/fail + a human detail line):
 *   1. bounds   — does it render as a SANE bounding box (not collapsed to a
 *                 sliver / NaN)? A collapsed bbox means the skinning/rig baked
 *                 the mesh to nothing (the Rust Harvest sliver failure).
 *   2. clips    — does it carry animation clips (usable for skeletal animation)?
 *   3. materials— are the materials MAPPABLE by three's loaders, or does an
 *                 unknown type need a TINT fallback (the 3ds-Max PBR case)?
 *   4. textures — what textures are referenced (reported as src URLs)? An
 *                 optional `textureExists(url)` predicate marks unresolved ones
 *                 so referenced textures are confirmed to resolve under a
 *                 texturePath before import.
 *
 * `modelHealthCheck` is PURE (Node-testable; THREE geometry math only, no
 * WebGL/DOM). Decoding is separate — `fbxDecoder`/GLTFLoader (browser) produce
 * the model this inspects; a browser `decodeAndCheckModel` wrapper fetches +
 * decodes + checks in one call.
 */
import * as THREE from 'three'

const MAPTABLE_MATERIALS = new Set([
  'MeshStandardMaterial',
  'MeshPhysicalMaterial',
  'MeshLambertMaterial',
  'MeshPhongMaterial',
  'MeshBasicMaterial',
  'MeshNormalMaterial',
  'MeshToonMaterial',
  'MeshMatcapMaterial',
  'SpriteMaterial',
  'LineBasicMaterial',
  'LineDashedMaterial',
])

const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
  'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'specularMap',
]

/** All materials (handling arrays) of a mesh. */
function meshMaterials(o) {
  return Array.isArray(o.material) ? o.material : [o.material]
}

/**
 * @param {THREE.Object3D} model  a decoded model (THREE.Group/scene/mesh)
 * @param {{ minExtent?: number, textureExists?: (url:string)=>boolean }} [opts]
 *   minExtent: smallest bbox extent (per axis) that counts as "not collapsed"
 *   (default 0.05). textureExists: optional predicate to confirm referenced
 *   textures resolve (e.g. under a texturePath); when absent the texture check
 *   only reports.
 * @returns {{ ok:boolean, checks:Array<{name,pass,detail}>, bounds, clips, materials, textures, decodes:true }}
 */
export function modelHealthCheck(model, { minExtent = 0.05, textureExists } = {}) {
  const checks = []

  // 1. Bounds — sane, non-collapsed bbox.
  let box
  try {
    box = new THREE.Box3().setFromObject(model)
  } catch (err) {
    return {
      decodes: true, ok: false,
      bounds: { collapsed: true, sliver: true },
      checks: [{ name: 'bounds', pass: false, detail: `failed to compute bbox: ${err.message}` }],
    }
  }
  const size = box.getSize(new THREE.Vector3())
  const finite = [size.x, size.y, size.z].every(Number.isFinite)
  const zero = size.x === 0 && size.y === 0 && size.z === 0
  const collapsed = !finite || zero || (size.x <= minExtent && size.y <= minExtent && size.z <= minExtent)
  const sliver = !zero && size.x > 0 && size.y > 0 && size.z > 0 && (size.x <= minExtent || size.y <= minExtent || size.z <= minExtent)
  checks.push({
    name: 'bounds',
    pass: !collapsed,
    detail: `bbox ${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)}` +
      (zero ? ' (EMPTY — nothing to render)' : collapsed ? ' (COLLAPSED — likely a sliver/broken rig)' : ''),
  })

  // 2. Clips — animation clips present?
  const clipCount = Array.isArray(model.animations) ? model.animations.length : 0
  checks.push({
    name: 'clips',
    pass: clipCount > 0,
    detail: clipCount > 0 ? `${clipCount} animation clip(s)` : 'no animation clips (bind-pose only)',
  })

  // 3. Materials — mappable by three, or tint fallback needed?
  const seen = new Set()
  const unknown = new Set()
  let meshCount = 0
  model.traverse((o) => {
    if (!o.isMesh || !o.material) return
    meshCount++
    for (const m of meshMaterials(o)) {
      if (m && m.type) { seen.add(m.type); if (!MAPTABLE_MATERIALS.has(m.type)) unknown.add(m.type) }
    }
  })
  const mappable = unknown.size === 0
  checks.push({
    name: 'materials',
    pass: mappable,
    detail: unknown.size > 0
      ? `unknown material type(s): ${[...unknown].join(', ')} → TINT fallback needed`
      : `materials mappable (${[...seen].join(', ') || 'none'})`,
  })

  // 4. Textures — referenced + (optionally) resolvable.
  const referenced = new Set()
  model.traverse((o) => {
    if (!o.isMesh || !o.material) return
    for (const m of meshMaterials(o)) {
      for (const slot of TEXTURE_SLOTS) {
        const t = m[slot]
        if (!t) continue
        const url = t.image && (t.image.src || t.image.currentSrc)
        if (url) referenced.add(url)
      }
    }
  })
  let unresolved = []
  if (typeof textureExists === 'function' && referenced.size > 0) {
    unresolved = [...referenced].filter((u) => !textureExists(u))
  }
  checks.push({
    name: 'textures',
    pass: typeof textureExists !== 'function' || unresolved.length === 0,
    detail: referenced.size === 0
      ? 'no textures referenced'
      : unresolved.length > 0
        ? `${referenced.size} texture(s) referenced, ${unresolved.length} unresolved: ${unresolved.slice(0, 3).join(', ')}`
        : `${referenced.size} texture(s) referenced + resolved`,
  })

  return {
    decodes: true,
    ok: checks.every((c) => c.pass),
    checks,
    bounds: { min: box.min.toArray(), max: box.max.toArray(), size: size.toArray(), collapsed, sliver, zero },
    clips: { count: clipCount, has: clipCount > 0 },
    materials: { meshCount, types: [...seen], mappable, unknownTypes: [...unknown], tintFallback: unknown.size > 0 },
    textures: { count: referenced.size, referenced: [...referenced], unresolved },
  }
}
