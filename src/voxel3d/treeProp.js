// W2-I (plan SE-COMPLETE-1012) — voxel tree prop mount: renders tree voxel
// grids (treeDebris.js pure model) into the voxel scene, ONE THREE.Group per
// tree under se.v3d.group (the voxel host's mount — the same surface the
// terrain chunks render into; a reseed swaps the host, and the lazy scatter
// below re-mounts on the new one).
//
// MATERIAL DECISION (pinned, host.js doctrine): MeshBasicMaterial({
// vertexColors:true }) — the face-shade bake IS the lighting model; no lights
// are added, ever. Leaf geometry is transparent (opacity from the archetype
// spec) with depthWrite:false so the crown reads see-through.
//
// Seams:
// - scatteredTrees(se, seed, density): deterministic landscape scatter —
//   spots via treeDebris.scatterTrees (mulberry32, ground-checked), one
//   api.spawnArchetype('tree') INSTANCE per spot (the archetype is the
//   editor-visible unit; scatter and editor spawn share it), registry on se.
// - stepTrees(se, api, dt): the per-step wiring — LAZY SCATTER when the live
//   field changed (boot, round reseed, map-size apply — se.treesField !==
//   se.field), archetype-instance sync (mount, spec-hash live rebuild,
//   despawn cleanup), debris advance + mesh sync. All callers come from the
//   projectiles3d system hook (2 guarded lines; no other main-repo edits).
// - treeBlast(se, api, point, rWorld): terrain/tree blast notify — trees in
//   radius carve (terrain damage rule, damageable trunk only) and every
//   surviving voxel detaches radially as tumble debris.
//
// Despawn discipline: debris meshes are pooled per record (acquire/release);
// a destroyed tree record is released only after its debris drains — zero
// leaked meshes, zero leaked records. No Math.random / wall-clock: tumble is
// hashed from cell coords in the pure model, so renders are deterministic.

import * as THREE from 'three'
import {
  buildTree, carveTree, treeHit, explode, stepDebris, scatterTrees,
  windPctOf, clumpSway, scorchLeaves, charTrunk, densityFor,
} from '../gameplay/treeDebris.js'
import { columnTop } from './field.js'
import { cellX, cellZ, cellTopWorldY, V, FIELD_X_MIN, FIELD_X_MAX, FIELD_Z_MIN, FIELD_Z_MAX } from './constants.js'
import { trenchExtent } from './aquarium.js'
import { SHADE_TOP, SHADE_SIDE, SHADE_BOTTOM } from './mesher.js'
import { SE_PX_TO_WORLD } from '../gameplay/settingsApply.js'
import treeData from '../../data/tree.json' with { type: 'json' }

// Foundation-loss tuning (data, NOT a settings row) — fail-loud at module load
// like systems/settle3d.js validates physics-presets.json. The per-step check
// in stepTrees collapses a standing tree when the LIVE ground under its fixed
// origin drops by more than this below the surface it was scattered on.
const FOUNDATION_DROP_THRESHOLD_DATA = treeData?.foundationDropThreshold
if (typeof FOUNDATION_DROP_THRESHOLD_DATA !== 'number' || !Number.isFinite(FOUNDATION_DROP_THRESHOLD_DATA) || FOUNDATION_DROP_THRESHOLD_DATA <= 0) {
  throw new TypeError(`[se/voxel3d] data/tree.json .foundationDropThreshold must be a positive finite number (got ${JSON.stringify(FOUNDATION_DROP_THRESHOLD_DATA)}) — fix the data file, no JS fallback exists`)
}
const FOUNDATION_DROP_THRESHOLD = FOUNDATION_DROP_THRESHOLD_DATA

const FACE_DIRS = [
  // [dx,dy,dz, shade, corner corners CCW seen from +normal] (mesher.js convention)
  { d: [1, 0, 0], shade: SHADE_SIDE },
  { d: [-1, 0, 0], shade: SHADE_SIDE },
  { d: [0, 1, 0], shade: SHADE_TOP },
  { d: [0, -1, 0], shade: SHADE_BOTTOM },
  { d: [0, 0, 1], shade: SHADE_SIDE },
  { d: [0, 0, -1], shade: SHADE_SIDE },
]

// Per-cell quads vs empty neighbors (tiny grids — no greedy pass needed).
// Triangle soup with flat-shaded vertex colors, world-unit coordinates.
export function buildTreeGeometry(tree, kind, clumpIndex) {
  const pos = [], nor = [], col = []
  const v = tree.v
  const rgb = (m, shade) => [
    Math.min(1, (((m.color >> 16) & 255) / 255) * shade),
    Math.min(1, (((m.color >> 8) & 255) / 255) * shade),
    Math.min(1, ((m.color & 255) / 255) * shade),
  ]
  // W8-F: per-clump leaf split — a leaf cell belongs to its NEAREST clump
  // center (ragged noise never merges clumps, so nearest-center == membership).
  const cellClump = tree.clumps && tree.clumps.length > 1
    ? (i) => {
        const x = i % tree.nx
        const z = Math.floor(i / tree.nx) % tree.nz
        const y = Math.floor(i / (tree.nx * tree.nz))
        let best = 0, bestD = Infinity
        for (let c = 0; c < tree.clumps.length; c++) {
          const p = tree.clumps[c]
          const d = (x - p.x) ** 2 + (y - p.y) ** 2 + (z - p.z) ** 2
          if (d < bestD) { bestD = d; best = c }
        }
        return best
      }
    : null
  const idx = (x, y, z) => x + z * tree.nx + y * tree.nx * tree.nz
  const solid = (x, y, z) => x >= 0 && x < tree.nx && y >= 0 && y < tree.ny && z >= 0 && z < tree.nz && tree.cells[idx(x, y, z)] !== 0
  for (let x = 0; x < tree.nx; x++) {
    for (let z = 0; z < tree.nz; z++) {
      for (let y = 0; y < tree.ny; y++) {
        const m = tree.cells[idx(x, y, z)]
        if (m === 0 || tree.mats[m].kind !== kind) continue
        if (cellClump && clumpIndex !== undefined && cellClump(idx(x, y, z)) !== clumpIndex) continue
        const c = tree.cellCenter(idx(x, y, z))
        const lo = [c.x - v / 2, c.y - v / 2, c.z - v / 2]
        const hi = [c.x + v / 2, c.y + v / 2, c.z + v / 2]
        for (const f of FACE_DIRS) {
          const [dx, dy, dz] = f.d
          if (solid(x + dx, y + dy, z + dz)) continue
          const [r, g, b] = rgb(tree.mats[m], f.shade)
          const q = quadCorners(lo, hi, dx, dy, dz)
          for (const t of [q[0], q[1], q[2], q[0], q[2], q[3]]) {
            pos.push(t[0], t[1], t[2])
            nor.push(dx, dy, dz)
            col.push(r, g, b)
          }
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3))
  geo.computeBoundingSphere()
  return geo
}

// CCW quad corners on the face plane pointed out of the cell along (dx,dy,dz).
function quadCorners(lo, hi, dx, dy, dz) {
  if (dx !== 0) return dx > 0
    ? [[hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]], [hi[0], lo[1], lo[2]]]
    : [[lo[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [lo[0], hi[1], hi[2]], [lo[0], lo[1], hi[2]]]
  if (dy !== 0) return dy > 0
    ? [[lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]]]
    : [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], lo[1], hi[2]], [lo[0], lo[1], hi[2]]]
  return dz > 0
    ? [[lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]]
    : [[hi[0], lo[1], lo[2]], [lo[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]]]
}

// The archetypes' spec for a tree component record (params ARE the spec —
// buildTree validates nothing here; unknown fields are ignored by the model).
export function treeSpecFromParams(params) {
  return {
    voxelSize: params.voxelSize, trunkHeight: params.trunkHeight, trunkRadius: params.trunkRadius,
    crownLayers: params.crownLayers, crownRadius: params.crownRadius, trunkColor: params.trunkColor,
    trunkHardness: params.trunkHardness, leafColors: params.leafColors, leafOpacity: params.leafOpacity,
    leafTransparent: params.leafTransparent, leafDamageable: params.leafDamageable, colorSeed: params.colorSeed,
    // W8-B: multi-clump crown, limbs, per-tree tint, idle sway — all data.
    // W8-F: wind-coupled per-clump sway + per-tree rotation (all data).
    crownClumps: params.crownClumps, limbCount: params.limbCount, limbLength: params.limbLength,
    tintDrift: params.tintDrift, swayAmp: params.swayAmp, swayHz: params.swayHz,
    swayIdleFloor: params.swayIdleFloor, swayWindCoupling: params.swayWindCoupling,
    swayClumpPhaseSeed: params.swayClumpPhaseSeed, swayClumpAmpJitter: params.swayClumpAmpJitter,
    rotationDeg: params.rotationDeg,
    // W8-G: charred-trunk color (editor-visible archetype data — no JS literal).
    charColor: params.charColor,
  }
}

// --- per-record visuals ----------------------------------------------------

// Mount root: a named 'treeProps' group in the SCENE (sibling of the voxel
// host's group — never inside se.v3d.group, whose children.length is the
// frozen T-G4 chunk-mesh gate in terrain-boot.spec). Created lazily once per
// scene; persists across reseeds (the scene outlives the per-round host).
function treeRoot(se) {
  if (se.treeRoot && se.treeRoot.parent) return se.treeRoot
  const g = new THREE.Group()
  g.name = 'treeProps'
  se.v3d.group.parent.add(g)
  se.treeRoot = g
  return g
}

function mountTree(rec, se) {
  const tree = rec.tree
  const group = new THREE.Group()
  group.name = `tree_${rec.entityId}`
  // W8-F pivot: rotates trunk + canopy about the tree origin (the entity
  // transform is flat t.x/y/z — no rotation field — so the yaw lives here).
  // Debris meshes stay OUTSIDE the pivot: debris integrates in world coords.
  const pivot = new THREE.Group()
  pivot.name = `tree_pivot_${rec.entityId}`
  pivot.position.set(tree.origin.x, tree.origin.y, tree.origin.z)
  pivot.rotation.y = tree.rotationRad || 0
  group.add(pivot)
  const localPos = { x: -tree.origin.x, y: -tree.origin.y, z: -tree.origin.z }
  if (tree.trunkCount > 0) {
    const geo = buildTreeGeometry(tree, 'trunk')
    rec.trunkMat = new THREE.MeshBasicMaterial({ vertexColors: true })
    rec.trunkMesh = new THREE.Mesh(geo, rec.trunkMat)
    rec.trunkMesh.position.set(localPos.x, localPos.y, localPos.z)
    pivot.add(rec.trunkMesh)
  }
  if (tree.leafCount > 0) {
    const leafSpec = tree.mats.find((m) => m && m.kind === 'leaf')
    rec.leafMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: !!leafSpec?.transparent,
      opacity: leafSpec?.opacity ?? 1, depthWrite: false,
    })
    // W8-F: ONE mesh per crown clump — each clump sways independently.
    // No-clump (layered) crowns stay a single leaf mesh (clumpIndex 0).
    rec.clumpMeshes = []
    const nClumps = tree.clumps && tree.clumps.length > 1 ? tree.clumps.length : 1
    for (let ci = 0; ci < nClumps; ci++) {
      const geo = buildTreeGeometry(tree, 'leaf', ci)
      if (!geo.attributes.position || geo.attributes.position.count === 0) { geo.dispose(); continue }
      const mesh = new THREE.Mesh(geo, rec.leafMat)
      mesh.position.set(localPos.x, localPos.y, localPos.z)
      pivot.add(mesh)
      rec.clumpMeshes.push({ mesh, geo, clumpIndex: ci })
    }
  }
  rec.debrisInst = null // instanced debris presentation builds on first debris sync
  rec.group = group
  rec.pivot = pivot
  treeRoot(se).add(group)
}

function disposeTreeMeshes(rec) {
  if (rec.trunkMesh) { rec.trunkMesh.geometry.dispose(); rec.trunkMat.dispose(); rec.pivot?.remove(rec.trunkMesh) }
  for (const c of rec.clumpMeshes || []) { c.geo.dispose(); rec.pivot?.remove(c.mesh) }
  if (rec.leafMat) rec.leafMat.dispose()
  rec.trunkMesh = rec.trunkMat = rec.leafMat = null
  rec.clumpMeshes = []
}

// FULL release (record death): tree meshes + instanced debris meshes + group.
function disposeTreeVisuals(rec) {
  disposeTreeMeshes(rec)
  for (const s of rec.debrisInst || []) s.mesh.material.dispose()
  rec.debrisGeo?.dispose()
  rec.debrisInst = []
  rec.debrisGeo = null
  if (rec.group && rec.group.parent) rec.group.parent.remove(rec.group)
  rec.group = null
}

// SETTLE-PACE P4 — debris presentation: ONE InstancedMesh per tree material
// (pooled per record, capacity = treeData.debris.maxDebris) driven by the
// debris record list — the P1 falling-dirt pattern. Physics/state stays in
// the pure records; rendering is instanced, so a full-crown detach costs ONE
// draw call per material instead of ~2000 Mesh objects in one frame
// (the measured tree-destroy lag spike). Unused meshes park at count 0.
function syncDebrisMeshes(rec, se) {
  const tree = rec.tree
  const db = treeData.debris
  if (!rec.debrisInst) {
    rec.debrisInst = []
    rec.debrisGeo = new THREE.BoxGeometry(tree.v, tree.v, tree.v)
    for (let m = 1; m < tree.mats.length; m++) {
      const mat = tree.mats[m]
      if (!mat) continue
      const im = new THREE.InstancedMesh(rec.debrisGeo, new THREE.MeshBasicMaterial({
        color: mat.color, transparent: !!mat.transparent,
        opacity: mat.transparent ? mat.opacity : 1, depthWrite: !mat.transparent,
      }), Math.max(1, db.maxDebris))
      im.count = 0
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false // count changes per step; culling reads a stale sphere
      rec.group.add(im)
      rec.debrisInst.push({ mesh: im, matIdx: m, cursor: 0 })
    }
  }
  for (const s of rec.debrisInst) s.cursor = 0
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), P = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1)
  for (let i = 0; i < tree.debris.length; i++) {
    const d = tree.debris[i]
    let s = null
    for (let k = 0; k < rec.debrisInst.length; k++) {
      if (rec.debrisInst[k].matIdx === d.mat) { s = rec.debrisInst[k]; break }
    }
    if (!s) continue
    E.set(d.ax, d.ay, d.az)
    Q.setFromEuler(E)
    P.set(d.x, d.y, d.z)
    M.compose(P, Q, S)
    s.mesh.setMatrixAt(s.cursor++, M)
  }
  for (const s of rec.debrisInst) {
    s.mesh.count = s.cursor
    s.mesh.instanceMatrix.needsUpdate = true
  }
}

// --- seams ------------------------------------------------------------------

// Ground plane under a world point from the LIVE field (null over a carved
// void column — debris there falls until the age timeout).
function groundYAt(se) {
  return (x, z) => {
    const t = columnTop(se.field, cellX(x), cellZ(z))
    return t < 0 ? null : cellTopWorldY(t)
  }
}

// Deterministic landscape scatter (the registered seam): mulberry32 per seed,
// one api.spawnArchetype('tree') instance per spot. W2-A FIX (plan
// SE-FIXUP-1012, user-reported "trees are not on the 3D terrain"): the lazy
// scatter fires on every field swap (boot, reseed, map-size apply), but the
// PREVIOUS field's tree entities used to survive it — syncTreeEntities then
// re-mounted them at their OLD world origins, floating over valleys / buried
// in hills of the NEW terrain. Scatter-owned entities (the se_tree_ prefix)
// are now DESTROYED on every (re)scatter; every standing tree is freshly
// ground-sampled from the LIVE field (surfaceYAt below).
//
// Density: an explicit `density` argument wins (spec/back-compat path);
// undefined reads se.settings.treeDensity (W1's 0-100 row) through the C2
// mapping in data/tree.json via densityFor — an undefined setting reads as the
// DATA default pct. api defaults to the live game (window.__game.api) so the
// pinned signature scatteredTrees(se, seed, density) works from specs too.
export function scatteredTrees(se, seed, density, api) {
  const game = api ?? (typeof window !== 'undefined' ? window.__game?.api : null)
  if (!game || !se?.field || !se?.v3d) return []
  const dens = density ?? densityFor(se.settings?.treeDensity, treeData.scatter)
  for (const rec of se.trees || []) {
    disposeTreeVisuals(rec)
    // W2-A: reclaim the scatter-owned entity — the field it stood on is gone.
    if (typeof rec.entityId === 'string' && rec.entityId.startsWith('se_tree_')) {
      game.world?.destroy?.(rec.entityId)
    }
  }
  se.trees = []
  const sc = treeData.scatter
  // Extents fallback (node/no-boot contexts): derive from the LIVE constants
  // lets — the pre-X2 literals (-120..120 / -30..30) would scatter trees on a
  // field quadrant that no longer matches the world.
  const ext = se.extents ? se.extents() : { FIELD_X_MIN, FIELD_X_MAX, FIELD_Z_MIN, FIELD_Z_MAX }
  // DEEPEN-1015 R3 (user defect: trees left SITTING IN THE AIR when the intro
  // corridor drops): the scatter's zMax is CLAMPED to the bounded trench back
  // face (data/voxel-terrain.json .trench.trenchWorldDepth via trenchExtent()
  // — the data-declared boundary, fail-noisy in aquarium.js). Everything
  // beyond it is the intro corridor / the carved hairline moat — the old
  // strip had NO trees there, and a tree over the corridor floats when the
  // corridor chunk groups fall.
  const scatterZMax = Math.min(ext.FIELD_Z_MAX, trenchExtent().zMax)
  const spots = scatterTrees({
    seed, density: dens,
    xMin: ext.FIELD_X_MIN, xMax: ext.FIELD_X_MAX,
    zMin: ext.FIELD_Z_MIN, zMax: scatterZMax,
    maxTrees: sc.maxTrees, minSeparation: sc.minSeparation, margin: sc.margin, tries: sc.tries,
    surfaceYAt: groundYAt(se),
  })
  for (const s of spots) {
    const id = `se_tree_${(se.treeN = (se.treeN || 0) + 1)}`
    const eid = game.spawnArchetype('tree', { id, transform: { x: s.x, y: s.y, z: s.z } })
    if (!eid) console.error('[trees] tree archetype failed to hydrate — spot skipped', { id })
  }
  se.treesField = se.field
  se.treeSeed = seed
  return se.trees
}

// Per-step archetype-instance sync: mount scatter-spawned AND editor-spawned
// tree entities, live-rebuild on param/origin edits (spec hash), release
// destroyed records once their debris drained (no leaks).
function syncTreeEntities(se, api) {
  const reg = se.trees || []
  for (const id of api.query({ has: 'tree' })) {
    const ent = api.entity(id)
    if (!ent || !ent.components) continue
    const params = ent.components.tree || {}
    const specHash = JSON.stringify(params)
    const origin = {
      x: ent.components.transform?.x ?? 0,
      y: ent.components.transform?.y ?? 0,
      z: ent.components.transform?.z ?? 0,
    }
    let rec = reg.find((r) => r.entityId === id)
    if (!rec) {
      rec = { entityId: id, tree: null, specHash: null, origin, dead: false, debrisInst: null } // specHash null -> first sync builds
      reg.push(rec)
    }
    if (rec.dead) continue
    if (rec.specHash !== specHash || (rec.tree && (rec.origin.x !== origin.x || rec.origin.y !== origin.y || rec.origin.z !== origin.z))) {
      disposeTreeVisuals(rec)
      rec.tree = buildTree(treeSpecFromParams(params), origin, id)
      mountTree(rec, se)
      rec.specHash = specHash
      rec.origin = origin
    }
  }
  for (let i = reg.length - 1; i >= 0; i--) {
    const rec = reg[i]
    const gone = !api.entity(rec.entityId)
    if (!gone) continue
    const drained = !rec.tree || (rec.tree.debris.length === 0 && !(rec.tree.detach && rec.tree.detach.length > 0))
    if (drained) {
      disposeTreeVisuals(rec) // destroyed entity, nothing left to render — full release
      reg.splice(i, 1)
    } else {
      disposeTreeMeshes(rec) // debris still flying — release tree meshes, record waits to drain
    }
  }
}

// Per-step wiring (projectiles3d hook): lazy scatter on field change, entity
// sync, debris advance. No-ops cleanly with no trees and in the editor
// viewport (no se/field/host).
export function stepTrees(se, api, dt) {
  if (!se?.field || !se?.v3d || !api) return
  if (se.treesField !== se.field) {
    // W2-C2: density resolves inside scatteredTrees from se.settings.treeDensity
    // (data/tree.json mapping) — no density literal here.
    scatteredTrees(se, se.terrainSeed?.value ?? 1234, undefined, api)
  }
  syncTreeEntities(se, api)
  // FOUNDATION-LOSS (user defect: a tree floats above the new lower ground once
  // a blast/settle carves-and-settles the terrain UNDER it). scatteredTrees
  // samples the ground ONCE and mountTree locks the pivot to that fixed origin
  // forever; a field-SWAP re-scatter never fires because a blast/settle mutates
  // the field IN PLACE (se.treesField === se.field). So this per-step pass:
  // for each standing tree, read the LIVE surface under its fixed x/z — if the
  // ground has DROPPED by more than FOUNDATION_DROP_THRESHOLD below the surface
  // the tree was scattered on (origin.y), OR the column is a carved void (null
  // surface), collapse it via the SAME teardown the blast path uses (explode
  // power 0 = at-rest collapse: debris drops straight down to the new ground,
  // no blast impulse), then disposeTreeMeshes + destroy the entity. The existing
  // per-tree loop's stepDebris then falls the debris; the drained-release line
  // below frees the record. Idempotent: rec.dead guards re-checks.
  const groundUnder = groundYAt(se)
  for (const rec of se.trees || []) {
    if (!rec.tree || rec.dead) continue
    const gy = groundUnder(rec.tree.origin.x, rec.tree.origin.z)
    const foundationLost = gy === null || gy < rec.tree.origin.y - FOUNDATION_DROP_THRESHOLD
    if (!foundationLost) continue
    const tree = rec.tree
    const ccy = tree.origin.y + (tree.ny * tree.v) / 2 // treeBlast's center formula
    explode(tree, { x: tree.origin.x, y: ccy, z: tree.origin.z }, 0, {
      speedScale: treeData.debris.speedScale, falloffDist: treeData.debris.falloffDist,
      tumbleScale: treeData.debris.tumbleScale, debrisPerStep: treeData.debris.debrisPerStep,
    })
    disposeTreeMeshes(rec) // remove the standing trunk/leaf meshes NOW (they'd
    // otherwise keep rendering at the fixed origin = floating, the very defect)
    // — disposeTreeMeshes leaves rec.group intact, so the per-tree loop below
    // still renders the falling debris into the same group and the drained
    // disposeTreeVisuals releases it. The entity is destroyed; rec.dead guards
    // the re-check. The existing per-tree loop + drained-release handle the rest.
    api.world?.destroy(rec.entityId)
    rec.dead = true
  }
  const db = treeData.debris
  for (const rec of se.trees || []) {
    // W8-F sway: PER-CLUMP, wind-coupled (render-only, deterministic in sim
    // time). windPct = |se.wind.x| relative to maxWind (SE-px -> world anchor
    // SE_PX_TO_WORLD from settingsApply.js); amplitude = swayAmp *
    // (idleFloor + coupling * windPct), per-clump phase/jitter from the model.
    // Each clump is its own mesh, so offsets are per-mesh, not per-canopy.
    if (rec.clumpMeshes?.length && rec.tree && rec.tree.sway) {
      rec.swayT = (rec.swayT || 0) + dt
      const maxWind = se.windCfg?.maxWind
      const windPct = windPctOf(se.wind?.x ?? 0, typeof maxWind === 'number' ? maxWind : 0, SE_PX_TO_WORLD)
      const rot = rec.tree.rotationRad || 0
      // W8-F2 FIX (user-reported leaf detach): clumpSway returns a WORLD-axis
      // horizontal delta (pinned: the pure model is space-free; render treats
      // it as world). The clump MESH lives in PIVOT space, where mountTree
      // placed it at localPos = −origin (clump geometry is built in unrotated
      // WORLD coords). So the offset must be (1) counter-rotated into pivot
      // space via R_y(−rot) — x' = dx·cos − dz·sin, z' = dx·sin + dz·cos — and
      // (2) added to localPos (−origin). The old line added +origin (mesh
      // displaced by 2×origin ≈ 40u -> leaves floating in the air) and its
      // cos/sin pair (Math.cos(−rot), Math.sin(−rot)) actually computed the
      // FORWARD R_y(+rot), not the counter-rotation its comment claimed.
      const cos = Math.cos(rot), sin = Math.sin(rot)
      const ox = -rec.tree.origin.x, oy = -rec.tree.origin.y, oz = -rec.tree.origin.z
      for (const c of rec.clumpMeshes) {
        const o = clumpSway(rec.tree, c.clumpIndex, rec.swayT, windPct)
        c.mesh.position.set(o.dx * cos - o.dz * sin + ox, oy, o.dx * sin + o.dz * cos + oz)
      }
    }
    if (!rec.tree || (rec.tree.debris.length === 0 && !(rec.tree.detach && rec.tree.detach.length > 0))) continue
    stepDebris(rec.tree, dt, {
      gravity: db.gravity, restSpeed: db.restSpeed, restSeconds: db.restSeconds,
      timeoutSeconds: db.timeoutSeconds, groundYAt: groundYAt(se),
      debrisPerStep: db.debrisPerStep, // SETTLE-PACE P4: data budget — full crowns stream, never spike
    })
    syncDebrisMeshes(rec, se)
    if (rec.dead && rec.tree.debris.length === 0 && !(rec.tree.detach && rec.tree.detach.length > 0)) disposeTreeVisuals(rec)
  }
}

// Terrain/tree blast notify (projectiles3d hook): trees in radius carve with
// the terrain damage rule (damageable trunk only), then every SURVIVING voxel
// detaches radially as tumble debris (the pure model). The tree entity is
// destroyed; its record releases once the debris despawns.
export function treeBlast(se, api, point, rWorld, opts = {}) {
  const reg = se?.trees
  if (!reg || !reg.length) return
  const db = treeData.debris
  const powerScale = opts.powerScale ?? 1
  for (const rec of reg) {
    if (!rec.tree || rec.dead) continue
    // broad-phase notify: tree center within rWorld + bound radius
    const ccy = rec.tree.origin.y + (rec.tree.ny * rec.tree.v) / 2
    const reach = rWorld + rec.tree.boundRadius
    const broad = (rec.tree.origin.x - point.x) ** 2 + (ccy - point.y) ** 2 + (rec.tree.origin.z - point.z) ** 2 <= reach * reach
    if (!broad) continue
    const hit = treeHit(rec.tree, point, rWorld)
    if (!hit) continue
    const res = carveTree(rec.tree, point, rWorld)
    const n = explode(rec.tree, point, rWorld * powerScale, {
      speedScale: db.speedScale, falloffDist: db.falloffDist, tumbleScale: db.tumbleScale,
      debrisPerStep: db.debrisPerStep, // SETTLE-PACE P4: data budget — streaming detach queue
    })
    rec.carved = (rec.carved || 0) + res.removed
    rec.explodedN = (rec.explodedN || 0) + n
    rec.dead = true
    disposeTreeMeshes(rec) // tree meshes gone; the group stays for the debris meshes (next step)
    api.world?.destroy(rec.entityId)
  }
}

// W2-B (plan SE-FIXUP-1012 item 2, user-directed) — DRIVE-OVER TREE
// DESTRUCTION. Driving the tank into a tree destroys it EXACTLY like a shot:
// the same treeBlast path (carve + explode + entity destroy + pooled debris).
// Trigger lives in systems/drive.js movement: after tryDrive moves the tank,
// it reports the tank position and its speed (moved/dt). The data threshold
// (data/tree.json .driveOver.speedThreshold) gates it — a slow touch is a
// no-op — and impulseScale feeds treeBlast's powerScale. Deterministic: the
// debris velocities are hashed in the pure model, never random.
// Returns { entityId, point, speed } for the first tree hit, else null.
export function treeDriveOver(se, api, tank, speed) {
  const cfg = treeData.driveOver
  if (!cfg || !se?.trees) return null
  if (!(typeof speed === 'number' && speed > cfg.speedThreshold)) return null
  for (const rec of se.trees) {
    if (!rec.tree || rec.dead) continue
    const o = rec.tree.origin
    const d2 = (o.x - tank.x) ** 2 + (o.z - tank.z) ** 2
    if (d2 > cfg.radius * cfg.radius) continue
    // impact at the trunk base — the same blast shape a shot at the trunk takes
    const point = { x: o.x, y: o.y + rec.tree.v, z: o.z }
    treeBlast(se, api, point, cfg.radius, { powerScale: cfg.impulseScale })
    return { entityId: rec.entityId, point, speed }
  }
  return null
}

// W8-G (plan SE-COMPLETE-1012, user-directed) — LIGHTNING TREE STRIKE seam.
// A bolt landing within a tree's radius (the same treeHit voxel-overlap test
// the blast path uses — a NEW trigger, the blast path itself is untouched):
//   (a) ignite — READ-ONLY use of the weather fire producer seam
//       (se.weather.ignite / events queue; weather.js consumes it);
//   (b) leaves scorch — a data fraction (data/tree.json .strike) of the
//       in-radius leaf voxels detach through the EXISTING debris path
//       (scorchLeaves records -> stepDebris + syncDebrisMeshes);
//   (c) trunk chars — the trunk material swaps to the archetype's
//       editor-visible charColor (charTrunk) and the tree meshes rebuild so
//       the blackened trunk renders — the tree REMAINS STANDING (entity
//       alive, rec.dead untouched).
// All tuning is data (data/tree.json .strike + archetype charColor).
export function treeStrike(se, api, point, opts = {}) {
  const reg = se?.trees
  if (!reg || !reg.length) return []
  const st = treeData.strike || {}
  const rWorld = opts.radius ?? st.fireRadius ?? 4
  const fraction = st.scorchFraction ?? 0.4
  const out = []
  for (const rec of reg) {
    if (!rec.tree || rec.dead) continue
    if (!treeHit(rec.tree, point, rWorld)) continue
    // (a) fire at the strike point — the existing weather ignite seam
    if (typeof se.weather?.ignite === 'function') se.weather.ignite(point.x, point.z, 'tree-strike')
    else se.weather?.events?.push({ type: 'ignite', x: point.x, z: point.z })
    // (c) char FIRST, then rebuild (mountTree resets the debris-mesh list;
    // records created after the rebuild sync on the next step — no leaks)
    const charred = charTrunk(rec.tree)
    if (charred && rec.group) {
      disposeTreeVisuals(rec)
      mountTree(rec, se)
    }
    // (b) scorch: partial leaf detach via the existing debris path
    const res = scorchLeaves(rec.tree, point, rWorld, fraction, opts.seed ?? 0)
    if (charred && rec.group) syncDebrisMeshes(rec, se)
    out.push({ entityId: rec.entityId, scorched: res.detached, charred, fire: { x: point.x, z: point.z } })
  }
  return out
}
