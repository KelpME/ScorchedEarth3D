/**
 * Import IR — the intermediate representation every imported model resolves to
 * (plans/ASSET-IMPORT-UNIFICATION.md §Import IR contract).
 *
 * Pure module: takes a decoded THREE.Object3D, extracts a plain
 * JSON-serializable IR document, validates it, and round-trips it through
 * serialize/parse. No file I/O, no FBX logic, no editor/archetype writing.
 *
 * Lossless doctrine (3a18c06): authored material data is preserved verbatim —
 * materials are stored as descriptors (name, type, color, texture refs,
 * vertexColors), never silently re-typed, dropped, or embedded-and-hidden.
 *
 * Document shape:
 *   {
 *     nodes:     [{ id, name, position, quaternion, scale, meshIds, isBone, parentId }],
 *     meshes:    [{ id, name, geometryId, materialIds }],
 *     geometries:[{ id, kind, attributeCounts: {position, normal, uv, ...}, indexCount }],
 *     materials: [{ id, name, type, color, textureIds, vertexColors }],
 *     textures:  [{ id, name, mimeType | uri, width, height }],
 *     skeleton:  { boneIds, bindPose } | null,
 *     clips:     [{ name, duration, targetNodeIds }],
 *     provenance:{ sourcePath, sourceHash, importerVersion, normalization: [] },
 *   }
 *
 * All cross-references are by IR id (string). Nothing embedded-and-hidden:
 * every texture the materials reference appears in `textures` as a descriptor.
 */

let idCounter = 0
/** Stable-enough unique ids within one IR document. */
function nextId(prefix) {
  idCounter += 1
  return `${prefix}_${idCounter}`
}

function vec3(v) {
  return { x: v?.x ?? 0, y: v?.y ?? 0, z: v?.z ?? 0 }
}

function quat(q) {
  return { x: q?.x ?? 0, y: q?.y ?? 0, z: q?.z ?? 0, w: q?.w ?? 1 }
}

/** Extract a color descriptor from a material's `.color` (or null). */
function colorDescriptor(mat) {
  if (!mat || !mat.color) return null
  const c = mat.color
  if (typeof c.getHex === 'function') {
    return { hex: c.getHex(), r: c.r, g: c.g, b: c.b }
  }
  return null
}

/** Extract a texture descriptor — reference only, never embedded pixels. */
const texDescByUuid = new WeakMap()
function textureDescriptor(tex) {
  if (!tex) return null
  if (texDescByUuid.has(tex)) return texDescByUuid.get(tex)
  const image = tex.image
  const desc = {
    id: nextId('tex'),
    name: tex.name || '',
    mimeType: tex.mimeType || null,
    uri: tex.userData?.uri || tex.sourceFile || null,
    width: image?.width ?? null,
    height: image?.height ?? null,
  }
  // Nothing embedded-and-hidden: record that the source had pixels we only
  // reference, never serialize.
  desc.embeddedPixels = !!image
  texDescByUuid.set(tex, desc)
  return desc
}

function materialDescriptor(mat, texturesById) {
  const textureRefs = []
  for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
    const tex = mat[slot]
    if (!tex) continue
    const desc = textureDescriptor(tex)
    if (desc) {
      texturesById.set(desc.id, desc)
      textureRefs.push(desc.id)
    }
  }
  return {
    id: nextId('mat'),
    name: mat.name || '',
    type: mat.type || null,
    color: colorDescriptor(mat),
    textureIds: textureRefs,
    vertexColors: !!mat.vertexColors,
  }
}

function geometryDescriptor(geo) {
  const attributeCounts = {}
  for (const [name, attr] of Object.entries(geo.attributes || {})) {
    attributeCounts[name] = attr?.count ?? 0
  }
  return {
    id: nextId('geo'),
    kind: geo.type || 'BufferGeometry',
    attributeCounts,
    indexCount: geo.index?.count ?? null,
  }
}

/**
 * Build an IR document from a decoded THREE.Object3D model.
 *
 * @param {THREE.Object3D} root
 * @param {{ sourcePath: string, sourceHash: string, importerVersion: string }} meta
 * @returns {object} plain JSON-serializable IR document
 */
export function buildImportIR(root, { sourcePath, sourceHash, importerVersion } = {}) {
  if (!root || typeof root.traverse !== 'function') {
    throw new TypeError('buildImportIR: root must be a THREE.Object3D')
  }
  const meshes = []
  const geometries = []
  const materials = []
  const texturesById = new Map()
  const geoByUuid = new Map()
  const meshByUuid = new Map()
  const matIdByUuid = new Map()

  // Pass 1: collect unique geometries, materials, textures (no duplication).
  root.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return
    const geo = node.geometry
    if (geo && !geoByUuid.has(geo.uuid)) {
      const desc = geometryDescriptor(geo)
      geoByUuid.set(geo.uuid, desc)
      geometries.push(desc)
    }
    const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : []
    for (const mat of mats) {
      if (!mat || matIdByUuid.has(mat.uuid)) continue
      const desc = materialDescriptor(mat, texturesById)
      matIdByUuid.set(mat.uuid, desc.id)
      materials.push(desc)
    }
    if (!meshByUuid.has(node.uuid)) meshByUuid.set(node.uuid, node)
  })

  // Pass 2: walk the tree depth-first recording nodes with parent indices.
  const nodes = []
  const visit = (node, parentId) => {
    const index = nodes.length
    nodes.push({
      id: nextId('node'),
      index,
      name: node.name || '',
      position: vec3(node.position),
      quaternion: quat(node.quaternion),
      scale: vec3(node.scale),
      meshIds: [],
      isBone: !!node.isBone,
      parentId,
    })
    if (node.isMesh || node.isSkinnedMesh) {
      const meshEntry = {
        id: nextId('mesh'),
        name: node.name || '',
        geometryId: geoByUuid.get(node.geometry?.uuid)?.id ?? null,
        materialIds: [],
      }
      const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : []
      for (const mat of mats) {
        if (matIdByUuid.get(mat?.uuid)) meshEntry.materialIds.push(matIdByUuid.get(mat.uuid))
      }
      meshes.push(meshEntry)
      nodes[index].meshIds.push(meshEntry.id)
    }
    for (const child of node.children || []) visit(child, index)
  }
  visit(root, null)

  // Skeleton: bone hierarchy + bind pose (world matrices at extract time).
  let skeleton = null
  const boneIndices = nodes
    .map((n, i) => [n, i])
    .filter(([n]) => n.isBone)
    .map(([, i]) => i)
  if (boneIndices.length > 0) {
    skeleton = {
      boneNodeIds: boneIndices.map((i) => nodes[i].id),
      bindPose: boneIndices.map((i) => ({
        nodeId: nodes[i].id,
        position: nodes[i].position,
        quaternion: nodes[i].quaternion,
        scale: nodes[i].scale,
      })),
    }
  }

  // Clips: animation takes on the root, targets resolved to node ids by name.
  const nodeByName = new Map(nodes.map((n) => [n.name, n.id]).filter(([name]) => name))
  const clips = (root.animations || []).map((clip) => ({
    name: clip.name || '',
    duration: clip.duration ?? 0,
    targetNodeIds: (clip.tracks || [])
      .map((t) => nodeByName.get(t.name?.split('.')[0] ?? ''))
      .filter((id) => id !== undefined),
  }))

  return {
    version: 1,
    nodes,
    meshes,
    geometries,
    materials,
    textures: [...texturesById.values()],
    skeleton,
    clips,
    provenance: {
      sourcePath: sourcePath ?? null,
      sourceHash: sourceHash ?? null,
      importerVersion: importerVersion ?? null,
      normalization: [],
    },
  }
}

/**
 * Structural validation — the decode-probe refusal contract. Returns
 * { ok, errors[], warnings[] }; errors are refusal reasons.
 *
 * Checks: required top-level arrays, duplicate ids, broken cross-references
 * (mesh->geometry/material, node->mesh, material->texture), non-serializable
 * values, missing provenance.
 */
export function validateIR(ir) {
  const errors = []
  const warnings = []
  const seenIds = new Map() // id -> collection it appeared in

  const checkId = (id, collection, label) => {
    if (typeof id !== 'string' || id.length === 0) {
      errors.push(`${collection}: entry has missing/invalid id`)
      return false
    }
    const prev = seenIds.get(id)
    if (prev) {
      errors.push(`duplicate id "${id}" in ${collection} (already in ${prev})`)
      return false
    }
    seenIds.set(id, collection)
    return true
  }

  const isPlain = (v) => v === null
    || ['string', 'number', 'boolean'].includes(typeof v)
    || (Array.isArray(v) && v.every(isPlain))
    || (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && Object.values(v).every(isPlain))

  const checkPlain = (v, label) => {
    if (!isPlain(v)) errors.push(`${label}: non-serializable value`)
  }

  const nodeIds = new Set()
  if (!ir || typeof ir !== 'object') {
    return { ok: false, errors: ['IR must be an object'], warnings }
  }
  if (!Array.isArray(ir.nodes)) errors.push('nodes: missing array')
  if (!Array.isArray(ir.meshes)) errors.push('meshes: missing array')
  if (!Array.isArray(ir.materials)) errors.push('materials: missing array')
  if (!Array.isArray(ir.textures)) errors.push('textures: missing array')
  if (errors.length > 0) return { ok: false, errors, warnings }

  const nodes = ir.nodes ?? []
  const meshes = ir.meshes ?? []
  const geometries = ir.geometries ?? []
  const materials = ir.materials ?? []
  const textures = ir.textures ?? []

  const geoIds = new Set()
  for (const g of geometries) {
    if (checkId(g?.id, 'geometries', 'geometry')) geoIds.add(g.id)
    checkPlain(g?.attributeCounts, 'geometry.attributeCounts')
  }

  const matIds = new Set()
  for (const m of materials) {
    if (!checkId(m?.id, 'materials', 'material')) continue
    matIds.add(m.id)
    checkPlain(m?.name, 'material.name')
    checkPlain(m?.color, 'material.color')
    if (m.type == null) warnings.push(`material "${m.id}": missing type descriptor (lossless doctrine)`)
    for (const tid of m.textureIds ?? []) {
      if (!textures.some((t) => t?.id === tid)) errors.push(`material "${m.id}": broken texture ref "${tid}"`)
    }
  }

  const texIds = new Set()
  for (const t of textures) {
    if (checkId(t?.id, 'textures', 'texture')) texIds.add(t.id)
  }

  const meshIds = new Set()
  for (const mesh of meshes) {
    if (!checkId(mesh?.id, 'meshes', 'mesh')) continue
    meshIds.add(mesh.id)
    if (mesh.geometryId == null || !geoIds.has(mesh.geometryId)) {
      errors.push(`mesh "${mesh.id}": broken geometry ref "${mesh.geometryId}"`)
    }
    if (!Array.isArray(mesh.materialIds) || mesh.materialIds.length === 0) {
      warnings.push(`mesh "${mesh.id}": no material refs`)
    }
    for (const mid of mesh.materialIds ?? []) {
      if (!matIds.has(mid)) errors.push(`mesh "${mesh.id}": broken material ref "${mid}"`)
    }
  }

  nodes.forEach((node, i) => {
    if (!checkId(node?.id, 'nodes', 'node')) return
    nodeIds.add(node.id)
    if (node.parentId != null) {
      const parent = nodes[node.parentId]
      if (!parent) {
        errors.push(`node "${node.id}": parentId ${node.parentId} out of range`)
      } else if (node.parentId >= i) {
        errors.push(`node "${node.id}": parent must precede child (tree order)`)
      }
    }
    checkPlain(node?.position, 'node.position')
    checkPlain(node?.quaternion, 'node.quaternion')
    checkPlain(node?.scale, 'node.scale')
    for (const mid of node.meshIds ?? []) {
      if (!meshIds.has(mid)) errors.push(`node "${node.id}": broken mesh ref "${mid}"`)
    }
  })

  // Reused ids across nodes and the seenIds map already flag duplicates.
  for (const clip of ir.clips ?? []) {
    checkPlain(clip?.name, 'clip.name')
    if (typeof clip?.duration !== 'number') warnings.push(`clip "${clip?.name ?? '?'}": missing numeric duration`)
    for (const nid of clip.targetNodeIds ?? []) {
      if (!nodeIds.has(nid) && !nodes.some((n) => n.id === nid)) {
        errors.push(`clip "${clip.name ?? '?'}": broken node ref "${nid}"`)
      }
    }
  }

  if (!ir.provenance || typeof ir.provenance !== 'object') {
    errors.push('provenance: missing')
  } else {
    if (ir.provenance.sourcePath == null) warnings.push('provenance.sourcePath: missing')
    if (ir.provenance.importerVersion == null) warnings.push('provenance.importerVersion: missing')
    if (!Array.isArray(ir.provenance.normalization)) warnings.push('provenance.normalization: not an array')
  }

  if (seenIds.size === 0 && nodes.length + meshes.length > 0) {
    warnings.push('no ids recorded despite nodes/meshes present')
  }
  if (nodeIds.size === 0) warnings.push('IR has no nodes (empty document?)')

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Serialize the IR to a JSON string. IR is plain data; anything THREE-flavored
 * that slipped in is caught here (fail loud, never silently embed).
 */
export function serializeIR(ir) {
  const scan = (v, path) => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function') throw new TypeError(`serializeIR: function value at "${path}"`)
      return
    }
    if (v.isObject3D || typeof v.toJSON === 'function') {
      throw new TypeError(`serializeIR: non-serializable THREE object at "${path}"`)
    }
    for (const k of Object.keys(v)) scan(v[k], path ? `${path}.${k}` : k)
  }
  scan(ir, '')
  return JSON.stringify(ir, (key, value) => {
    if (typeof value === 'function') {
      throw new TypeError(`serializeIR: function value at "${key}"`)
    }
    return value
  })
}

/**
 * Parse an IR JSON string back into an IR document. Round-trip fidelity with
 * serializeIR is deep-equal (float epsilon ~1e-6 acceptable per contract).
 */
export function parseIR(json) {
  const ir = typeof json === 'string' ? JSON.parse(json) : JSON.parse(String(json))
  return ir
}
