/**
 * Engine — name-free STRUCTURAL bone auto-mapper (auto-retarget mapping).
 *
 * When an animation clip's skeleton is named differently from the target model's
 * (Kevin `B-*`, MoCap `MHuman_*`, Mixamo `mixamorig:*`, generic), the human can
 * remap bones in the editor panel. This module AUTOMATES that map WITHOUT reading
 * any names: it classifies each skeleton into a canonical biped by its topology
 * and 3D geometry (pelvis, spine, neck, head, and the arm/leg chains with their
 * left/right mirror side), then maps source role -> target role.
 *
 * The two skeletons never need matching bone names, matching coordinate axes, or
 * even the same number of bones — only the SHAPE of a biped. It is PURE (no `three`
 * import; inline 3-vector math) so it unit-tests under Node/vitest like the other
 * engine math. The editor panel's Auto-guess calls `autoMapRigs` first and falls
 * back to fuzzy name-matching only when the structural pass yields nothing.
 *
 * Coordinate/up-axis independence: the classifier derives the body's "up" from
 * the feet->pelvis direction itself, never assumes +Y, so a Z-up or differently
 * rotated asset works unchanged. Left/right is assigned by the mirror symmetry
 * side (world +X = left in the canonical loader orientation of the packs in play),
 * consistently within each skeleton.
 *
 * @module auto-map
 */

/**
 * @typedef {{name:string, pos:{x:number,y:number,z:number}, parent:any}} SkeletonBone
 * @typedef {{[srcName:string]:string}} BoneMap
 */

// ---- minimal 3-vector math (pure, no three) ----
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const len = (v) => Math.hypot(v.x, v.y, v.z)
const norm = (v) => { const n = len(v); return n > 1e-9 ? { x: v.x / n, y: v.y / n, z: v.z / n } : { x: 0, y: 1, z: 0 } }
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z

/**
 * Normalize a raw bone list into a node tree: Map name -> node with resolved
 * parent (object-ref, name-string, or null) and a `children` array.
 * @param {SkeletonBone[]} bones
 * @returns {Map<string,any>}
 */
function buildTree(bones) {
  const N = new Map()
  for (const b of bones || []) N.set(b.name, { ...b, children: [], _name: b.name })
  for (const b of N.values()) {
    let p = b.parent
    if (p && typeof p === 'object' && p.name) p = N.get(p.name)
    else if (typeof p === 'string') p = N.get(p)
    if (p && p !== b) { b.parent = p; p.children.push(b) }
    else b.parent = null
  }
  return N
}

/**
 * Classify a biped bone tree into canonical roles. Returns a map of
 * `name -> {group, idx, side}`:
 *   group: 'pelvis' | 'spine' | 'neck' | 'head' | 'arm' | 'leg'
 *   idx:   position within the chain (spine/arm/leg index from the torso outward)
 *   side:  'L' | 'R' | null (arms/legs)
 * @param {SkeletonBone[]} bones
 * @returns {{[name:string]:{group:string,idx:number,side:string|null}}}
 */
export function classifyRig(bones) {
  const N = buildTree(bones)
  if (!N.size) return {}
  const leavesOf = (n) => { const o = []; const w = (x) => (x.children.length ? x.children.forEach(w) : o.push(x)); w(n); return o }
  let mn = { x: 1e9, y: 1e9, z: 1e9 }, mx = { x: -1e9, y: -1e9, z: -1e9 }
  for (const b of N.values()) { mn.x = Math.min(mn.x, b.pos.x); mn.y = Math.min(mn.y, b.pos.y); mn.z = Math.min(mn.z, b.pos.z); mx.x = Math.max(mx.x, b.pos.x); mx.y = Math.max(mx.y, b.pos.y); mx.z = Math.max(mx.z, b.pos.z) }
  const diag = Math.hypot(mx.x - mn.x, mx.y - mn.y, mx.z - mn.z) || 1
  const chainLen = (n) => (n.children.length === 0 ? 0 : 1 + Math.max(...n.children.map(chainLen)))
  const endpointDist = (n) => { let leaf = n, best = 0; const w = (x, d) => { if (d > best) { best = d; leaf = x } x.children.forEach((c) => w(c, d + len(sub(c.pos, x.pos)))) }; w(n, 0); return len(sub(leaf.pos, n.pos)) }
  const parentChain = (n) => { const o = []; for (let x = n; x; x = x.parent) o.push(x); return o }
  const isAnc = (a, b) => parentChain(b).includes(a)
  const lca = (a, b) => { const sb = new Set(parentChain(b).map((x) => x._name)); for (const x of parentChain(a)) if (sb.has(x._name)) return x; return null }
  const out = {}
  const set = (b, g, idx, side) => { if (b) out[b._name] = { group: g, idx, side } }
  // A LEG = a pure chain to a foot (<=2 leaves), >=2 bones, physically LONG
  // (>=15% of the skeleton diagonal). Fingers are short chains; legs are a LONG
  // MIRROR PAIR. pelvis = the DEEPEST node (root allowed) with EXACTLY 2 legs.
  // Handles named-pelvis rigs (Hips) AND root-is-pelvis rigs (legs + spine branch
  // from the root, e.g. MoCap).
  const legChild = (c) => leavesOf(c).length <= 2 && chainLen(c) >= 2 && endpointDist(c) >= 0.15 * diag
  let pelvis = null
  for (const b of N.values()) { const lk = b.children.filter(legChild); if (lk.length === 2 && (!pelvis || parentChain(b).length > parentChain(pelvis).length)) pelvis = b }
  // No node has a long mirror-pair of leg chains -> NOT a recognizable biped
  // (incomplete/degenerate input). Return {} so the caller falls back to name
  // matching instead of emitting a garbage role map. Real humanoids always hit
  // the primary branch above, so this only fires on inputs we can't trust.
  if (!pelvis) return out

  const pc = pelvis.children
  const legs = pc.filter(legChild)
  const spineRoot = pc.filter((c) => !legs.includes(c)).sort((a, b) => leavesOf(b).length - leavesOf(a).length)[0]
  const legSet = new Set(legs)
  set(pelvis, 'pelvis', 0, null)

  // up axis = pelvis -> feet centroid (legs point down)
  const feet = legs.map((r) => leavesOf(r).slice(-1)[0]).filter(Boolean)
  const fcen = { x: 0, y: 0, z: 0 }; feet.forEach((f) => { fcen.x += f.pos.x; fcen.y += f.pos.y; fcen.z += f.pos.z })
  if (feet.length) { fcen.x /= feet.length; fcen.y /= feet.length; fcen.z /= feet.length }
  const up = norm(sub(pelvis.pos, fcen))
  const sideOf = (p) => (p.x >= 0 ? 'L' : 'R')

  // arm tips per side = max-|x| non-leg leaf; chest = LCA of the two tips
  const nonLeg = leavesOf(pelvis).filter((l) => ![...legSet].some((lr) => isAnc(lr, l)))
  const bySide = { L: [], R: [] }
  for (const l of nonLeg) bySide[l.pos.x >= 0 ? 'L' : 'R'].push(l)
  const sideTips = { L: bySide.L.sort((a, b) => b.pos.x - a.pos.x)[0], R: bySide.R.sort((a, b) => a.pos.x - b.pos.x)[0] }
  const tips = ['L', 'R'].map((s) => sideTips[s]).filter(Boolean)
  const chest = tips.length === 2 ? lca(tips[0], tips[1]) || spineRoot : spineRoot

  // arm chains: from each tip, walk to chest, DROP the finger bones (everything
  // outward of the first branching node = the hand). A bare-leaf hand (fingers
  // collapsed/deduped) has no branch, so nothing is dropped.
  const armChains = tips.map((tip) => {
    const pcN = parentChain(tip)
    const iChest = pcN.indexOf(chest)
    const armUp = (iChest < 0 ? pcN.slice(0, -1) : pcN.slice(0, iChest))
    const handIdx = armUp.findIndex((n) => n.children.length >= 2)
    const chain = (handIdx >= 0 ? armUp.slice(handIdx) : armUp).reverse()
    const side = sideOf(tip.pos)
    chain.forEach((b, j) => set(b, 'arm', j, side))
    return { chain, side }
  })

  // neck = chest's non-arm child; head = neck's midline child
  const armChildNames = new Set(armChains.map((a) => (a.chain[0] ? a.chain[0]._name : null)).filter(Boolean))
  const chestChildren = (chest && chest.children || []).filter((c) => !armChildNames.has(c._name))
  const neck = chestChildren.sort((a, b) => dot(sub(b.pos, chest.pos), up) - dot(sub(a.pos, chest.pos), up))[0]
  const head = neck && neck.children.filter((c) => c !== neck).sort((a, b) => Math.abs(a.pos.x) - Math.abs(b.pos.x))[0]
  set(neck, 'neck', 0, null)
  set(head, 'head', 0, null)

  // spine = path spineRoot -> chest inclusive, ordered spineRoot->chest
  const spinePath = []
  { let x = chest; while (x) { spinePath.unshift(x); if (x === spineRoot) break; x = x.parent } }
  spinePath.forEach((b, i) => { if (b._name in out && out[b._name].group === 'arm') return; set(b, 'spine', i, null) })

  // legs: chains thigh->toe
  for (const lr of legs) {
    const tip = leavesOf(lr).slice(-1)[0]
    const pcN = parentChain(tip)
    const i = pcN.indexOf(pelvis)
    const chain = (i < 0 ? pcN.slice(0, -1) : pcN.slice(0, i)).reverse()
    const side = sideOf(chain[0].pos)
    chain.forEach((b, j) => set(b, 'leg', j, side))
  }

  return out
}

/** Map a leg chain position to a category (for side-preserving role matching). */
function legCat(idx) {
  if (idx === 0) return 'thigh'
  if (idx === 1) return 'shin'
  if (idx === 2) return 'foot'
  return 'toe'
}

/**
 * Build a source->target bone-name map from two role classifications.
 * @param {{[name:string]:{group:string,idx:number,side:string|null}}} src
 * @param {{[name:string]:{group:string,idx:number,side:string|null}}} tgt
 * @returns {BoneMap}
 */
function buildMap(src, tgt) {
  const catOf = (r) => (r.group === 'leg' ? legCat(r.idx) : (r.group === 'arm' || r.group === 'spine') ? r.group + r.idx : r.group)
  const key = (r) => `${r.group}|${r.side || ''}|${catOf(r)}`
  const t = {}
  for (const [name, r] of Object.entries(tgt)) { const k = key(r); if (!(k in t)) t[k] = name }
  const map = {}
  for (const [name, r] of Object.entries(src)) { const m = t[key(r)]; if (m && m !== name) map[name] = m }
  return map
}

/**
 * Name-free structural auto-map: produce a `{ srcBone: targetBone }` map that
 * drives `retargetClip` (or the editor panel), from the source clip's skeleton
 * and the target model's skeleton. PURE. Never reads bone names.
 * @param {SkeletonBone[]} srcBones   the clip's bone tree (name/pos/parent).
 * @param {SkeletonBone[]} targetBones the model's bone tree.
 * @returns {BoneMap}
 */
export function autoMapRigs(srcBones, targetBones) {
  return buildMap(classifyRig(srcBones), classifyRig(targetBones))
}
