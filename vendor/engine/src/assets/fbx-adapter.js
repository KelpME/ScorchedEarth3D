/**
 * FBX adapter — customer #2 of the import pipeline
 * (plans/ASSET-IMPORT-UNIFICATION.md §'FBX adapter specifics' + §Import IR contract).
 *
 * `fbxToIR(buffer, opts)` decodes a real FBX buffer (via fbxDecoder, browser-bound
 * lazy three import — Node tests can still import this module and, with a minimal
 * `document` stub for texture loads, decode REAL fixture bytes), records the
 * file's DECLARED conventions, and assembles the Import IR with skeleton +
 * clips. 1:1 doctrine (plans/ASSET-IMPORT-UNIFICATION.md §'FBX adapter
 * specifics'): NO unit/axis transformation is ever applied — geometry passes
 * through byte-exact. Declared units (UnitScaleFactor) and axis are recorded
 * in `provenance.normalization` as DATA ({ op: 'units-declared', ...,
 * applied: false }) — informational, never an operation. Material
 * classification (Phong/Lambert→PBR, S3-4) is the one exception: it changes
 * material TYPES, never geometry, and stays recorded. Findings that are not
 * transformations (silent-loader drops, ambiguity) are recorded in
 * `provenance.warnings` — no silent best-effort.
 *
 * What the real fixtures + three's source established (r1xx FBXLoader):
 *  - three's FBXLoader does NOT apply UnitScaleFactor — it only stashes
 *    `sceneGraph.userData.unitScaleFactor` (FBXLoader.js, GlobalSettings branch).
 *    A tank.fbx with UnitScaleFactor=1 decodes with a ~253-unit bbox: centimeters,
 *    landed 1:1 by doctrine (absolute-size display is a consumer concern).
 *  - Both fixtures are UpAxis=Y / FrontAxis=+Z / CoordAxis=+X — three's native
 *    convention, recorded as `already-native`; a Z-up or X-up file is RECORDED,
 *    never rotated — no conversion is applied (1:1 doctrine).
 *  - Silent drops in FBXLoader: blend shapes (BlendShape deformers are ignored —
 *    no morph targets are built), NURBS/Patch geometry (non-triangulated
 *    geometry is skipped), constraints. The adapter scans the binary FBX record
 *    tree for these and records warnings; they do not refuse the import by
 *    themselves (refusal stays with validateIR/validateImport errors).
 *  - Duplicate node names are legal and common (Characters.fbx: two rigs, 38
 *    duplicated bone names). buildImportIR resolves clip targets last-wins by
 *    name; this adapter re-resolves each track prefix to the UNION of matching
 *    node ids and records the ambiguity as a warning (the IR gap: tracks carry
 *    node names, not references — a fuller fix belongs to import-ir.js).
 *
 * IR contract note: buildImportIR's flat node list is the DFS order of the
 * decoded graph — this adapter relies on that to map Object3D -> IR node index
 * (clip targets, per-node `visible`). IR nodes additionally carry `visible`
 * (adapter-side enrichment; backendFromIR reads it for render.visible).
 */

import * as THREE from 'three'
import { buildImportIR, validateIR } from './import-ir.js'
import { validateImport } from './import-backend.js'

/**
 * Phong shininess → PBR roughness curve (documented + tested, never silent):
 *   roughness = clamp(1 - sqrt(shininess / 100), 0, 1)
 * Rationale: Phong's specular exponent ~ perceptual gloss. sqrt keeps the
 * mid-range readable (shininess 25 → roughness 0.5, the common authored FBX
 * value), while the clamp bounds legacy files that encode shininess > 100
 * (e.g. 400) to a mirror-smooth roughness 0 instead of a negative. shininess
 * 0 / missing → fully rough (1). MeshLambertMaterial carries no shininess
 * term at all → roughness 1.
 * Phong's `specular` color has NO PBR equivalent without an env map — it is
 * DROPPED (metalness stays 0) and recorded in the op's `dropped` list.
 */
export function shininessToRoughness(shininess) {
  const s = Number(shininess)
  if (!Number.isFinite(s) || s <= 0) return 1
  return Math.min(1, Math.max(0, 1 - Math.sqrt(s / 100)))
}

/** Props copied VERBATIM from the Phong/Lambert source to the PBR material. */
const PBR_PASSTHROUGH = [
  'name', 'color', 'map', 'normalMap', 'normalScale', 'aoMap', 'aoMapIntensity',
  'alphaMap', 'emissive', 'emissiveMap', 'emissiveIntensity', 'transparent',
  'opacity', 'alphaTest', 'side', 'vertexColors', 'userData',
]

/**
 * Convert MeshPhongMaterial / MeshLambertMaterial found on the decoded FBX
 * graph to MeshStandardMaterial so the render path's `isUsableEmbedded` rule
 * (model-importer.js) keeps them instead of collapsing every mesh to one flat
 * tint. MeshStandardMaterial / MeshPhysicalMaterial / MeshBasicMaterial are
 * left untouched (the latter is unlit intent); the conversion is IDEMPOTENT —
 * a graph with no Phong/Lambert yields no ops. Records one
 * { op: 'material-phong-to-pbr', count, dropped } entry, never silent.
 *
 * Mapping (each preserved verbatim unless noted): color, map, normalMap +
 * normalScale, aoMap + aoMapIntensity, alphaMap, emissive, emissiveMap,
 * emissiveIntensity, transparent, opacity, alphaTest, side, vertexColors,
 * name, userData. shininess → roughness via shininessToRoughness (above);
 * Lambert → roughness 1. metalness = 0 (Phong/Lambert carry no metalness
 * term); specular dropped + recorded.
 *
 * @param {THREE.Object3D} root  decoded graph (mutated in place)
 * @returns {object[]} normalization entries (empty when nothing to convert)
 */
export function convertFbxMaterialsToPbr(root) {
  const ops = []
  if (!root || typeof root.traverse !== 'function') return ops
  let specularDropped = 0
  const converted = new Map() // source material -> converted Standard (shared instances stay shared)
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return
    const existing = o.material
    const mats = Array.isArray(existing) ? existing : [existing]
    let touched = false
    const next = mats.map((m) => {
      const isPhong = !!m && m.isMeshPhongMaterial
      const isLambert = !!m && m.isMeshLambertMaterial
      if (!isPhong && !isLambert) return m
      if (converted.has(m)) { touched = true; return converted.get(m) }
      if (isPhong && m.specular && typeof m.specular.getHex === 'function' && m.specular.getHex() !== 0) {
        specularDropped++
      }
      const std = new THREE.MeshStandardMaterial()
      for (const k of PBR_PASSTHROUGH) {
        if (m[k] !== undefined) std[k] = m[k]
      }
      std.roughness = isPhong ? shininessToRoughness(m.shininess) : 1
      std.metalness = 0
      converted.set(m, std)
      touched = true
      return std
    })
    if (touched) o.material = Array.isArray(existing) ? next : next[0]
  })
  const phongCount = [...converted.keys()].filter((m) => m.isMeshPhongMaterial).length
  const lambertCount = converted.size - phongCount
  if (converted.size > 0) {
    const op = {
      op: 'material-phong-to-pbr',
      from: `MeshPhongMaterial×${phongCount} + MeshLambertMaterial×${lambertCount}`,
      to: 'MeshStandardMaterial',
      count: converted.size,
      applied: true,
      shininessToRoughness: 'roughness = clamp(1 - sqrt(shininess/100), 0, 1)',
    }
    if (specularDropped > 0) {
      op.dropped = [`specular on ${specularDropped} material(s) — no PBR equivalent without an env map; metalness stays 0`]
    }
    ops.push(op)
  }
  return ops
}

/** Read a typed property sequence at `off`; returns [values, nextOffset]. */
function readProps(view, buf, off, numProps) {
  const props = []
  for (let i = 0; i < numProps; i++) {
    const type = String.fromCharCode(buf[off]); off += 1
    if (type === 'C') { props.push(view.getUint8(off) !== 0); off += 1 }
    else if (type === 'I') { props.push(view.getInt32(off, true)); off += 4 }
    else if (type === 'F') { props.push(view.getFloat32(off, true)); off += 4 }
    else if (type === 'D') { props.push(view.getFloat64(off, true)); off += 8 }
    else if (type === 'L') { props.push(view.getBigInt64(off, true)); off += 8 }
    else if (type === 'S' || type === 'R') {
      const len = view.getUint32(off, true); off += 4
      // Chunked decode: String.fromCharCode(...spread) with a huge subarray
      // (embedded media in multi-MB FBX files) overflows V8's argument limit
      // ("Maximum call stack size exceeded") — never spread unbounded.
      let s = ''
      for (const end2 = off + len; off < end2; ) {
        const step = Math.min(0x8000, end2 - off)
        s += String.fromCharCode(...buf.subarray(off, off + step))
        off += step
      }
      props.push(s)
    } else break // arrays and unknown types: not needed for the header
  }
  return [props, off]
}

/** Depth-first binary FBX record scan collecting named nodes we care about. */
function scanBinaryRecords(view, buf, off, end, depth, found) {
  if (depth > 32) return
  while (off + 13 < end) {
    const recEnd = view.getUint32(off, true)
    const numProps = view.getUint32(off + 4, true)
    let p = off + 12
    const nameLen = buf[p]; p += 1
    const name = String.fromCharCode(...buf.subarray(p, p + nameLen)); p += nameLen
    if (recEnd <= off || recEnd > end) break
    if (name === 'P') {
      const [props] = readProps(view, buf, p, numProps)
      if (typeof props[0] === 'string' && props[0].startsWith('UnitScaleFactor')) found.unitScaleFactor = Number(props[4])
      else if (typeof props[0] === 'string' && props[0].startsWith('UpAxis') && !props[0].includes('Sign')) found.upAxis = Number(props[4])
    } else if (name === 'BlendShape' || name === 'BlendShapeChannel') found.blendShapes++
    else if (name === 'NurbsSurface' || name === 'NurbsCurve' || name === 'Patch') found.nurbsOrPatch++
    else if (name === 'Constraint') found.constraints++
    const [ , after] = readProps(view, buf, p, numProps)
    if (after < recEnd) scanBinaryRecords(view, buf, after, recEnd, depth + 1, found)
    off = recEnd
  }
}

/**
 * Scan an FBX buffer for the GlobalSettings facts the adapter normalizes with
 * (unit scale factor, up axis) and for content three's FBXLoader silently
 * drops (blend shapes, NURBS/Patch geometry, constraints). Works on binary
 * FBX (record-tree walk) and falls back to a text scan for ASCII FBX.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{ binary: boolean, version: number|null, unitScaleFactor: number|null,
 *   upAxis: number|null, blendShapes: number, nurbsOrPatch: number, constraints: number }}
 */
export function scanFbxHeader(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const magic = String.fromCharCode(...u8.subarray(0, 20))
  const found = { binary: magic.startsWith('Kaydara FBX Binary'), version: null, unitScaleFactor: null, upAxis: null, blendShapes: 0, nurbsOrPatch: 0, constraints: 0 }
  if (found.binary) {
    found.version = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(23, true)
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    scanBinaryRecords(view, u8, 27, u8.length, 0, found)
  } else {
    const text = String.fromCharCode(...u8.subarray(0, Math.min(u8.length, 4 << 20)))
    const v = /FBXVersion\s*:\s*(\d+)/.exec(text); found.version = v ? Number(v[1]) : null
    const usf = /UnitScaleFactor\s*:\s*([\d.]+)/.exec(text); found.unitScaleFactor = usf ? Number(usf[1]) : null
    const up = /UpAxis\s*:\s*(\d+)/.exec(text); found.upAxis = up ? Number(up[1]) : null
    found.blendShapes = (text.match(/BlendShape\s*:/g) || []).length
    found.nurbsOrPatch = (text.match(/(NurbsSurface|NurbsCurve|Patch)\s*:/g) || []).length
    found.constraints = (text.match(/Constraint\s*:/g) || []).length
  }
  return found
}

/** Image extensions an FBX texture reference can name. Only the browser-loadable
 * set (png/jpg/webp) can actually be auto-assigned; the rest surface as
 * unresolved references so the caller can tell the human to convert them. */
const FBX_TEXTURE_REF_RE = /[A-Za-z0-9_\-.]+\.(?:png|jpe?g|tga|dds|psd|bmp|tiff?)\b/gi

/**
 * Scan an FBX buffer for the EXTERNAL texture FILENAMES its materials reference
 * (the strings three's FBXLoader fetches against `resourcePath`). Works on both
 * binary (string-table scan) and ASCII FBX — pure, Node-testable. Returns
 * unique lowercase BASENAMES, in first-appearance order. This is the reliable
 * source for auto-resolution: the import IR's texture descriptors carry the
 * FBX-internal slot names (e.g. 'base_color_texture'), NOT the referenced file.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string[]} e.g. ['polypackfish.png']
 */
export function scanFbxTextureRefs(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  // latin1 ('windows-1252') maps every byte — never throws on binary junk.
  const text = new TextDecoder('latin1').decode(u8)
  const out = []
  const seen = new Set()
  for (const m of String(text).matchAll(FBX_TEXTURE_REF_RE)) {
    const base = m[0].trim().split(/[\\/]/).pop().toLowerCase()
    if (base && !seen.has(base)) { seen.add(base); out.push(base) }
  }
  return out
}

/**
 * Record an FBX graph's DECLARED conventions as provenance DATA. 1:1 doctrine:
 * NO transformation is applied — the root is never scaled, never rotated;
 * geometry passes through byte-exact. Returns the provenance entries
 * ({ op, ..., applied: false }) for what was DECLARED, never silent.
 *
 * @param {THREE.Object3D} root  decoded FBX scene graph (NOT mutated —
 *   materials classification below is the only mutation, and it changes
 *   material types, never geometry)
 * @param {{ unitScaleFactor?: number|null, upAxis?: number|null }} header  scanFbxHeader output
 * @returns {object[]} provenance entries
 */
export function normalizeFbx(root, header) {
  const ops = []
  const usf = header.unitScaleFactor ?? 1
  ops.push({
    op: 'units-declared',
    unitScaleFactor: usf,
    sourceUnit: Math.abs(usf - 100) < 1e-9 ? 'm' : 'cm',
    applied: false,
  })
  if (header.upAxis === 1) {
    ops.push({ op: 'axis-check', upAxis: 1, from: 'FBX UpAxis=Y (front=+Z, right=+X)', to: 'three Y-up (already-native)', applied: false, note: 'already-native' })
  } else if (header.upAxis === 2) {
    ops.push({ op: 'axis-check', upAxis: 2, from: 'FBX UpAxis=Z', to: 'three Y-up', applied: false, note: 'declared axis recorded as data; NO rotation applied (1:1 doctrine)' })
  } else if (header.upAxis === 0) {
    ops.push({ op: 'axis-check', upAxis: 0, from: 'FBX UpAxis=X', to: 'three Y-up', applied: false, note: 'X-up FBX is rare; recorded as data, never silent — no conversion applied (1:1 doctrine)' })
  }
  // Material normalization (S3-4): FBXLoader emits Phong/Lambert, which the
  // render path's isUsableEmbedded rule rejects (flat-tint fallback). Convert
  // to MeshStandardMaterial HERE — in fbxToIR BEFORE buildImportIR (so the IR
  // material descriptors carry the Standard type), and in the editor glue's
  // re-run BEFORE resolveModelMaterials — and RECORD it, never silent.
  ops.push(...convertFbxMaterialsToPbr(root))
  return ops
}

/** DFS-order Object3D -> IR node index map (mirrors buildImportIR's visit). */
function dfsNodeIndex(root) {
  const map = new Map()
  const visit = (node) => {
    map.set(node, map.size)
    for (const child of node.children || []) visit(child)
  }
  visit(root)
  return map
}

/**
 * Decode an FBX buffer and resolve it to one Import IR document (decode →
 * recorded normalization → skeleton + clips). Throws a refusal Error if the
 * assembled IR fails validateIR or validateImport (decode-probe gate).
 *
 * @param {ArrayBuffer|Uint8Array} buffer  the raw .fbx bytes
 * @param {{ sourcePath?: string, sourceHash?: string, importerVersion?: string,
 *           texturePath?: string }} [opts]
 * @returns {Promise<object>} the Import IR document (provenance.normalization
 *   records every applied transform; provenance.warnings records silent drops
 *   and ambiguity)
 */
export async function fbxToIR(buffer, opts = {}) {
  const header = scanFbxHeader(buffer)
  // fbxDecoder takes a Response; wrap the raw buffer in one.
  const resp = new Response(buffer instanceof Uint8Array
    ? buffer.slice().buffer
    : buffer)
  const { fbxDecoder } = await import('./fbx-loader.js')
  const decoded = await fbxDecoder(resp, opts.sourcePath || 'model.fbx', { texturePath: opts.texturePath })

  const normalization = normalizeFbx(decoded, header)

  // IR references nodes by DFS index; buildImportIR visits in the same order.
  const nodeIndexByObject = dfsNodeIndex(decoded)

  const ir = buildImportIR(decoded, {
    sourcePath: opts.sourcePath,
    sourceHash: opts.sourceHash,
    importerVersion: opts.importerVersion || 'fbx-adapter@1',
  })

  // Adapter-side enrichment on the flat node list: visibility per node and a
  // `nodeIndex` for unambiguous traceability back to the decoded graph.
  for (const [obj, index] of nodeIndexByObject) {
    const irNode = ir.nodes[index]
    if (irNode && obj.visible === false) irNode.visible = false
  }

  // Clips: re-resolve track targets to the UNION of nodes sharing the track's
  // node name (FBX tracks are name-keyed; duplicate names are legal). Track
  // names come straight from the decoded graph's AnimationClips — the raw
  // names are what FBX stores; buildImportIR's name-map resolution is replaced
  // here. Records the ambiguity instead of silently picking a last-wins winner.
  const warnings = []
  const nodesByName = new Map()
  for (const n of ir.nodes) {
    if (!n.name) continue
    if (!nodesByName.has(n.name)) nodesByName.set(n.name, [])
    nodesByName.get(n.name).push(n.id)
  }
  let ambiguousNames = 0
  const decodedClips = decoded.animations || []
  for (const clip of ir.clips || []) {
    const decodedClip = decodedClips.find((c) => c.name === clip.name) || decodedClips[0]
    const prefixes = [...new Set((decodedClip?.tracks || []).map((t) => String(t.name || '').split('.')[0]).filter(Boolean))]
    const targets = new Set()
    for (const prefix of prefixes) {
      const matches = nodesByName.get(prefix) || []
      for (const id of matches) targets.add(id)
      if (matches.length > 1) ambiguousNames++
      if (matches.length === 0) warnings.push(`clip "${clip.name}": track target "${prefix}" matches no IR node`)
    }
    clip.targetNodeIds = [...targets]
  }
  if (ambiguousNames > 0) {
    warnings.push(`clips: ${ambiguousNames} track target name(s) match multiple nodes (duplicate names across rigs); targetNodeIds is the union of matches`)
  }

  // Multi-rig check: duplicate bone names mean more than one rig's skeleton
  // folded into ir.skeleton (Characters.fbx: 2 rigs sharing 38 bone names).
  const boneNames = ir.skeleton
    ? ir.nodes.filter((n) => n.isBone).map((n) => n.name)
    : []
  const dupBones = boneNames.length - new Set(boneNames).size
  if (dupBones > 0) {
    warnings.push(`skeleton: ${dupBones} duplicated bone name(s) — multi-rig skeleton folded into one IR skeleton (per-rig extraction stays with extractRig)`)
  }

  // Silent-drop warnings from the header scan (no silent best-effort).
  if (header.blendShapes > 0) {
    warnings.push(`source carries ${header.blendShapes} blend shape record(s) — three's FBXLoader does not import them; corrective shapes are dropped`)
  }
  if (header.nurbsOrPatch > 0) {
    warnings.push(`source carries ${header.nurbsOrPatch} NURBS/Patch record(s) — non-triangulated FBX geometry is skipped by FBXLoader`)
  }
  if (header.constraints > 0) {
    warnings.push(`source carries ${header.constraints} constraint record(s) — FBXLoader ignores constraints`)
  }
  if (header.unitScaleFactor == null && header.binary) {
    warnings.push('binary FBX: UnitScaleFactor not found in GlobalSettings — assumed 1 (cm)')
  }

  ir.provenance.warnings = warnings
  ir.provenance.format = 'fbx'
  ir.provenance.normalization = normalization

  // Refusal gate: decode-probe + validateIR + validateImport, reasons surfaced.
  const structural = validateIR(ir)
  const probe = validateImport(ir)
  const reasons = [
    ...structural.errors.map((e) => `validateIR: ${e}`),
    ...probe.reasons.map((r) => `validateImport: ${r}`),
  ]
  if (reasons.length > 0) {
    const err = new Error(`fbxToIR: import refused (${reasons.join('; ')})`)
    err.refusalReasons = reasons
    err.warnings = warnings
    throw err
  }
  return ir
}
