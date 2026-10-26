/**
 * Import back-end — the SINGLE SOURCE OF RULES for the asset-import
 * unification (plans/ASSET-IMPORT-UNIFICATION.md §Architecture + §Import IR
 * contract). Pure functions over an Import IR document; NO file decoding, NO
 * three.js side effects (only the engine's THREE-exact eulerToQuat is read),
 * NO file writes. The editor consumes these outputs; it owns all actual I/O.
 *
 * Back-end outputs (from the IR, never from raw files):
 *  - canonical `render.model` paths (canonicalization semantics absorbed from
 *    the former editor/src/modelAssets.js: canonical = game-relative
 *    `assets/...` form; own-game `games/<game>/` prefix stripped, everything
 *    else — other games, already-canonical, absolute — passes through)
 *  - registration keys: BOTH the raw and the canonical form (dual-key rule)
 *  - nested archetype record trees (6da9305 rules: root render.model record +
 *    per-node children with render.node / render.nodePath, parent-linked,
 *    transforms LOCAL — the engine composes them)
 *  - material preservation decisions (3a18c06 lossless rules: embedded usable
 *    materials preserved VERBATIM as descriptors; fallback tint ONLY when the
 *    IR says the material is unusable)
 *  - validation report incl. decode-probe refusal criteria (the one good idea
 *    from the CS1 spike, absorbed via decode-check.js: refuse what cannot be
 *    trusted, with clear reasons — never silently proceed)
 *
 * MIG-2 generator extensions (MIG-1 audit EXT-1..3, EXT-5, EXT-6):
 *  - EXT-1 arbitrary components: `components` maps pass through VERBATIM —
 *    the generator ADDS import records, it never prunes or rewrites authored
 *    vocabulary (render.mesh, scripts, collider, per-game components…).
 *  - EXT-2 `offset`: when an IR node carries `offset` {x,y,z}, it is FOLDED
 *    per-axis into `components.transform.{x,y,z}` (exactly what
 *    mergeChildren/hydrateChild does at runtime → rendering-neutral); emitted
 *    records never carry an `offset` key. Persisted-file migration folds the
 *    same way and deletes the key (idempotent: post-fold files carry none).
 *  - EXT-3 `base`: a root-def-only `base: '<id>'` passthrough option on
 *    `archetypeRecord` (archetype-nesting chain resolver reads it; import
 *    archetypes never nest, so it is preserved verbatim, never generated).
 *  - EXT-5 texture `format`: manifest texture entries carry `format`, derived
 *    from the src extension (same rule as model entries).
 *  - EXT-6 `provenance` passthrough: optional `{ addedBy, addedAt }` attached
 *    to generated manifest entries (editor bookkeeping; `registerAsset` /
 *    `syncManifestFromDisk` write it).
 *
 * IR contract: the S2-1 module (import-ir.js) emits a FLAT node list
 * ({ id, index, name, position, quaternion, scale, meshIds, parentId(index) })
 * with meshes { id, geometryId, materialIds }, materials { id, name, type,
 * color, textureIds, vertexColors } and provenance { sourcePath, sourceHash }.
 * This back-end ALSO accepts the plan-doc nested form (nodes as a tree with
 * children/transform, mesh / meshRef single refs) — normalizeIR() folds both
 * into one internal shape so the rules below are written exactly once.
 */

import { eulerToQuat } from '../scene/scene.js'
import { kindForFormat } from './kinds.js'

/**
 * Canonical form of a render.model asset path: the game-relative manifest
 * src. `games/<gameName>/assets/...` → `assets/...`. A path under a DIFFERENT
 * game (or already-canonical) passes through untouched. With no gameName,
 * any `games/<any>/` prefix is stripped (byte-exact remainder).
 */
export function canonicalizeModelPath(path, gameName) {
  const p = String(path || '')
  if (gameName) {
    const prefix = `games/${gameName}/`
    if (p.startsWith(prefix)) return p.slice(prefix.length)
    return p
  }
  const m = /^games\/[^/]+\/(.+)$/.exec(p)
  return m ? m[1] : p
}

/**
 * Dual registration keys for an asset path (modelAssets.js rule): the model
 * must resolve under BOTH the raw form (editor `games/<game>/...`) and the
 * canonical form (game-relative manifest src). Returns { raw, canonical,
 * keys } where `keys` is the deduped array to register.
 */
export function registrationKeys(path, gameName) {
  const raw = String(path || '')
  const canonical = canonicalizeModelPath(raw, gameName)
  const keys = canonical === raw ? [raw] : [raw, canonical]
  return { raw, canonical, keys }
}

const slug = (name) => String(name || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()

/**
 * Fold the two accepted IR shapes into one internal form:
 *   { roots: [tree nodes], meshByRef, materialOf, provenance, textures,
 *     nodeCount }
 * A tree node is { name, position, rotation?, quaternion?, scale, visible?,
 * meshRef?, children }. Accepts:
 *  - flat nodes (import-ir.js): parentId = numeric index, meshIds array
 *  - nested nodes (plan doc): children arrays, transform { position, rotation,
 *    scale }, mesh / meshRef single refs
 */
function normalizeIR(ir) {
  const flat = Array.isArray(ir.nodes) && ir.nodes.length > 0 && ir.nodes[0] && !('children' in ir.nodes[0])
  const meshByRef = new Map()
  for (const mesh of ir.meshes || []) meshByRef.set(mesh.id ?? mesh.ref, mesh)

  let roots
  if (flat) {
    const groups = new Map() // parentId (numeric index | null) -> children in array order
    ir.nodes.forEach((node, index) => {
      const parentKey = typeof node.parentId === 'number' ? node.parentId : null
      if (!groups.has(parentKey)) groups.set(parentKey, [])
      groups.get(parentKey).push({ ...node, _index: index })
    })
    const toTree = (entry) => ({
      name: entry.name,
      position: entry.position,
      quaternion: entry.quaternion,
      scale: entry.scale,
      visible: entry.visible,
      meshRef: (entry.meshIds && entry.meshIds[0]) ?? entry.mesh ?? entry.meshRef ?? null,
      children: (groups.get(entry._index) || []).map(toTree),
    })
    roots = (groups.get(null) || []).map(toTree)
  } else {
    roots = ir.nodes || []
  }

  const materialOf = (mesh) => {
    const ref = (mesh.materialIds && mesh.materialIds[0]) ?? mesh.material ?? mesh.materialRef
    const mat = ref != null
      ? (ir.materials || []).find((m) => (m.id ?? m.ref ?? m.name) === ref) || null
      : null
    return { ref: ref ?? null, mat }
  }

  return {
    roots,
    meshByRef,
    materialOf,
    provenance: {
      source: ir.provenance?.sourcePath ?? ir.provenance?.source ?? '',
      hash: ir.provenance?.sourceHash ?? ir.provenance?.hash ?? null,
      format: ir.provenance?.format
        || String(ir.provenance?.sourcePath ?? ir.provenance?.source ?? '').split('?')[0].split('.').pop(),
      decodeError: ir.provenance?.decodeError ?? null,
    },
    textures: ir.textures || [],
    nodeCount: flat
      ? ir.nodes.length
      : (() => { let n = 0; const visit = (node) => { n++; for (const c of node?.children || []) visit(c) }; for (const r of roots) visit(r); return n })(),
  }
}

/**
 * Local transform record from a normalized tree node. A quaternion from the
 * IR is kept verbatim; an euler rot derives its quat with the engine's
 * THREE-exact XYZ eulerToQuat. EXT-2: an `offset` {x,y,z} on the node (or its
 * transform) is FOLDED per-axis into the position — the emitted record never
 * carries an `offset` key.
 */
function nodeTransform(node) {
  const src = node?.transform ?? node ?? {}
  const pos = src.position || {}
  const off = src.offset ?? node?.offset ?? {}
  const transform = {
    x: (pos.x ?? 0) + (off.x ?? 0),
    y: (pos.y ?? 0) + (off.y ?? 0),
    z: (pos.z ?? 0) + (off.z ?? 0),
  }
  const r = src.rotation || src.rot
  if (r && (r.x || r.y || r.z)) {
    const rot = { x: r.x || 0, y: r.y || 0, z: r.z || 0 }
    transform.rot = rot
    transform.quat = eulerToQuat(rot.x, rot.y, rot.z)
  } else if (src.quaternion && typeof src.quaternion === 'object' && (src.quaternion.x || src.quaternion.y || src.quaternion.z)) {
    const q = src.quaternion
    transform.quat = { x: q.x ?? 0, y: q.y ?? 0, z: q.z ?? 0, w: q.w ?? 1 }
  }
  const s = src.scale
  if (s && (s.x !== 1 || s.y !== 1 || s.z !== 1)) {
    transform.scale = [s.x ?? 1, s.y ?? 1, s.z ?? 1]
  }
  return transform
}

/**
 * Material preservation decision for one mesh-bearing node, per the 3a18c06
 * lossless rules:
 *  - usable (IR does not mark it unusable): the material is preserved
 *    VERBATIM — decision 'preserve', descriptor byte-exact.
 *  - unusable (IR says so: usable === false or unusable === true) or no
 *    material ref: fallback only — vertex-color material when the IR flags
 *    vertexColors, else a neutral gray tint (0x9a9a9a, the model-importer's
 *    fallback tint).
 */
function materialDecision(mesh, node, materialOf) {
  const { ref, mat } = materialOf(mesh || {})
  const name = node.name || null
  if (mat && mat.usable !== false && mat.unusable !== true) {
    return {
      node: name,
      materialRef: ref,
      decision: 'preserve',
      descriptor: JSON.parse(JSON.stringify(mat.descriptor ?? mat)),
    }
  }
  const reason = mat ? 'ir-marked-unusable' : 'no-material-ref'
  if (mat && mat.vertexColors) {
    return {
      node: name, materialRef: ref, decision: 'fallback', reason,
      material: 'MeshBasicMaterial:vertexColors',
    }
  }
  return {
    node: name, materialRef: ref, decision: 'fallback', reason,
    material: 'MeshBasicMaterial:color', tint: 0x9a9a9a,
  }
}

/**
 * Turn an Import IR document into the downstream artifacts.
 *
 * @param {object} ir  Import IR document (S2-1 import-ir.js flat form, or the
 *   plan-doc nested tree — both accepted via normalizeIR).
 * @param {{ gameName?: string, stem?: string, modelPath?: string }} [opts]
 *   gameName: editor game folder name for canonicalization. modelPath: the
 *   asset path the IR came from (raw form; defaults to provenance source).
 * @returns {{ modelPath, canonicalModelPath, registrationKeys: string[],
 *   records: object[], materials: object[], report: object }}
 */
export function backendFromIR(ir, { gameName, stem, modelPath } = {}) {
  if (!ir || typeof ir !== 'object') throw new Error('backendFromIR: ir document required')
  const norm = normalizeIR(ir)
  const rawPath = modelPath || norm.provenance.source
  const canonical = canonicalizeModelPath(rawPath, gameName)
  const keys = registrationKeys(rawPath, gameName)

  const rootId = slug(stem || 'asset') || 'asset'

  // Root record: renders the whole model, NO node field (expandModelTree rule).
  const rootRecord = {
    id: rootId,
    name: stem || rootId,
    components: {
      transform: { x: 0, y: 0, z: 0 },
      render: { model: canonical },
    },
    children: [],
  }

  // Per-node children: mesh-bearing nodes carry render { model, node,
  // nodePath } (nodePath = numeric index path from the model root, the
  // duplicate-name tiebreaker); empty/bone nodes are transform-only
  // (lossless mirror — animation targets are never dropped).
  // Duplicate-name rule (Phase S3-6): when two DIFFERENT nodes slug to the
  // same id base (e.g. two rigs sharing bone names), the LATER node in
  // traversal order gets the smallest free `_N` suffix (`_2`, `_3`, …) —
  // the same deterministic rule the editor glue historically applied.
  // Non-colliding inputs are byte-identical to the unsuffixed form.
  const materials = []
  let hidden = 0
  const usedIds = new Set([rootId])

  const walk = (node, parentRecord, path) => {
    const children = Array.isArray(node.children) ? node.children : []
    children.forEach((child, i) => {
      const childPath = path ? `${path}/${i}` : `${i}`
      const name = child.name || `node${i}`
      let id = `${rootId}_${slug(name) || `node${i}`}`
      if (usedIds.has(id)) {
        let suffix = 2
        while (usedIds.has(`${id}_${suffix}`)) suffix++
        id = `${id}_${suffix}`
      }
      usedIds.add(id)
      // EXT-1: authored components on the IR node pass through VERBATIM —
      // authored keys win; the generator only ADDS its assembly records
      // (transform / render) and never prunes or rewrites authored vocabulary.
      const generated = { transform: nodeTransform(child) }
      const meshRef = child.meshRef ?? child.mesh
      if (meshRef != null && norm.meshByRef.has(meshRef)) {
        const render = { model: canonical, node: name, nodePath: childPath }
        if (child.visible === false) { render.visible = false; hidden++ }
        generated.render = render
        materials.push(materialDecision(norm.meshByRef.get(meshRef), child, norm.materialOf))
      }
      // authored passthrough first; the generator's assembly keys (transform /
      // render) are never overwritten. With no authored components the output
      // is byte-identical to the pre-MIG-2 shape.
      const components = { ...(child.components || {}), ...generated }
      const rec = { id, name, parent: parentRecord.id, components, children: [] }
      parentRecord.children.push(rec)
      walk(child, rec, childPath)
    })
  }
  for (const rootNode of norm.roots) walk(rootNode, rootRecord, '')

  return {
    modelPath: rawPath,
    canonicalModelPath: canonical,
    registrationKeys: keys.keys,
    records: [rootRecord],
    materials,
    report: {
      stem: rootId,
      nodes: norm.nodeCount,
      meshes: norm.meshByRef.size,
      materialsPreserved: materials.filter((m) => m.decision === 'preserve').length,
      materialsFallback: materials.filter((m) => m.decision === 'fallback').length,
      hidden,
      textures: norm.textures.length,
    },
  }
}

/**
 * Validation report for an IR document + its backend output. Absorbs the
 * decode-probe refusal criteria (CS1's one good idea, via decode-check.js):
 * refuse what cannot be trusted, with clear reasons — a decode failure
 * recorded in provenance, missing IR essentials, or broken node→mesh /
 * mesh→material refs all REFUSE the import ({ refused: true, reasons[] })
 * rather than producing a half-registered asset.
 */
export function validateImport(ir, backend) {
  const checks = []
  const reasons = []
  const add = (name, pass, detail) => {
    checks.push({ name, pass: Boolean(pass), detail: detail || (pass ? 'ok' : 'failed') })
    if (!pass) reasons.push(`${name}: ${detail || 'failed'}`)
  }

  add('ir-shape', Boolean(ir) && typeof ir === 'object' && Array.isArray(ir.nodes) && Array.isArray(ir.meshes) && Array.isArray(ir.materials), 'ir must carry nodes/meshes/materials arrays')
  add('ir-nonempty', Array.isArray(ir?.nodes) && ir.nodes.length > 0, 'ir.nodes is empty — nothing to import')

  const prov = ir?.provenance
  add('provenance', Boolean(prov) && typeof prov === 'object', 'missing provenance (source file, hash, importer version)')

  const decodeError = prov?.decodeError
  const format = prov?.format
    || String(prov?.sourcePath ?? prov?.source ?? '').split('?')[0].split('.').pop()
  if (decodeError) {
    add('decode-probe', false, `source did not decode: ${decodeError}`)
  } else if (format) {
    const supported = ['glb', 'gltf', 'fbx']
    add('decode-probe', supported.includes(String(format).toLowerCase()), `unsupported source format .${format}`)
  } else {
    add('decode-probe', true, 'no decode failure recorded')
  }

  // Broken refs: node.meshIds / node.mesh → meshes; mesh.materialIds /
  // mesh.material → materials.
  const meshRefs = new Set((ir?.meshes || []).map((m) => m.id ?? m.ref))
  const matRefs = new Set((ir?.materials || []).map((m) => m.id ?? m.ref ?? m.name))
  let brokenMesh = 0
  let brokenMat = 0
  const visit = (node) => {
    for (const ref of [].concat(node?.meshIds || [], node?.mesh != null ? [node.mesh] : [], node?.meshRef != null ? [node.meshRef] : [])) {
      if (ref != null && !meshRefs.has(ref)) brokenMesh++
    }
    for (const c of node?.children || []) visit(c)
  }
  for (const n of ir?.nodes || []) visit(n)
  for (const m of ir?.meshes || []) {
    for (const ref of [].concat(m.materialIds || [], m.material != null ? [m.material] : [], m.materialRef != null ? [m.materialRef] : [])) {
      if (ref != null && !matRefs.has(ref)) brokenMat++
    }
  }
  add('node-mesh-refs', brokenMesh === 0, `${brokenMesh} node(s) reference missing meshes`)
  add('mesh-material-refs', brokenMat === 0, `${brokenMat} mesh(es) reference missing materials`)

  const refused = reasons.length > 0
  return {
    ok: !refused,
    refused,
    reasons,
    checks,
    summary: backend?.report || null,
  }
}

/**
 * Pure manifest-entry generator: the JSON shapes the editor would write into
 * assets/manifest.json — the model itself plus any extracted textures. NO
 * file writing happens here (editor scope).
 *
 * EXT-5: texture entries carry `format`, derived from the src extension with
 * the same rule as model entries. EXT-6: an optional `provenance`
 * ({ addedBy, addedAt }) — from `opts.provenance` or `ir.provenance` — is
 * passed through onto every generated entry (editor bookkeeping; no reader
 * today, preserved so `addedBy:'auto-sync'` provenance is not lost).
 *
 * @param {object} ir
 * @param {object} [backend]  backendFromIR output (canonical src reused)
 * @param {{ provenance?: { addedBy?: string, addedAt?: string } }} [opts]
 */
export function manifestEntries(ir, backend, { provenance } = {}) {
  const prov = provenance
    ?? (ir?.provenance && (ir.provenance.addedBy != null || ir.provenance.addedAt != null)
      ? { addedBy: ir.provenance.addedBy, addedAt: ir.provenance.addedAt }
      : null)
  const entries = []
  const src = backend?.canonicalModelPath
    || canonicalizeModelPath(ir?.provenance?.sourcePath ?? ir?.provenance?.source ?? '', undefined)
  const format = ir?.provenance?.format || String(src).split('?')[0].split('.').pop()
  entries.push({
    kind: kindForFormat(format) === 'sfx' ? 'model' : kindForFormat(format),
    src,
    format: String(format || '').toLowerCase(),
    hash: ir?.provenance?.sourceHash ?? ir?.provenance?.hash ?? null,
  })
  for (const tex of ir?.textures || []) {
    const texSrc = tex.path ?? tex.src ?? tex.id
    const texFormat = String(String(texSrc).split('?')[0].split('.').pop() || '').toLowerCase()
    entries.push({
      kind: 'texture',
      src: texSrc,
      format: texFormat,
      hash: tex.hash ?? null,
    })
  }
  // AUDIO (kinds registry): extracted/referenced audio sources become
  // first-class `audio` entries, exactly like textures.
  for (const snd of ir?.audio || ir?.sounds || []) {
    const sndSrc = snd.path ?? snd.src ?? snd.id
    const sndFormat = String(String(sndSrc).split('?')[0].split('.').pop() || '').toLowerCase()
    entries.push({
      kind: 'audio',
      src: sndSrc,
      format: sndFormat,
      hash: snd.hash ?? null,
    })
  }
  if (prov) for (const entry of entries) entry.provenance = { ...prov }
  return entries
}

/**
 * Pure archetype-record generator: the JSON shape the editor would save as an
 * archetype file — the back-end's nested record tree, ready to serialize.
 * Transforms stay LOCAL (engine composes through `parent`); render.model is
 * the canonical game-relative path.
 *
 * EXT-1: `opts.components` (authored arbitrary vocabulary) is merged into the
 * ROOT record additively — everything the generator does not assemble passes
 * through verbatim; the generator's assembly records (transform / render) are
 * never overwritten, and nothing authored is pruned.
 * EXT-3: `opts.base` ('<id>') is preserved VERBATIM on the ROOT record only
 * (root-def-only; the archetype-nesting chain resolver reads it — import
 * archetypes never nest, so it is passthrough, never generated).
 *
 * @param {object} ir
 * @param {object} [backend]
 * @param {{ stem?: string, dropPoint?: {x,y,z}, components?: object, base?: string }} [opts]
 */
export function archetypeRecord(ir, backend, { stem, dropPoint, components, base } = {}) {
  const tree = backend && !stem
    ? backend.records
    : backendFromIR(ir, { stem }).records
  const root = JSON.parse(JSON.stringify(tree[0]))
  if (components && typeof components === 'object') {
    root.components = { ...components, ...root.components }
  }
  if (dropPoint) {
    root.components.transform = {
      ...root.components.transform,
      x: dropPoint.x ?? 0,
      y: dropPoint.y ?? 0,
      z: dropPoint.z ?? 0,
    }
  }
  if (base != null) root.base = base
  return root
}
