/**
 * engine/src/nav/navmesh.js — Recast/Detour navmesh BAKE + QUERY layer
 * (Phase P2.6 W6a/W6a2, plans/NAV-UX-REVISION.md D-8). Since W6a2 this IS the
 * core behind `api.nav` (nav.js is the thin contract handle over it).
 * Vehicle: `recast-navigation` (MIT wrapper over ZLib Recast/Detour — see
 * THIRD-PARTY-NOTICES.md at repo root).
 *
 * GEOMETRY SOURCE = THE COLLISION WORLD (human decision 2026-09-29):
 *   - bake triangles come from COLLIDER geometry via the existing physics
 *     shape helpers (physics/physics.js shapeFromCollider: box / sphere /
 *     pill / real-mesh incl. terrain heightfields tessellated by
 *     render/terrain-math.js). Visual render meshes are NOT bake input.
 *   - tags: `nav-surface`-tagged entities' collider geometry contributes
 *     WALKABLE surface; `nav-obstacle`-tagged geometry CARVES (it is fed to
 *     the voxelizer so it removes walkable ground beneath/around it, and its
 *     faces only become surface where they are ≤ maxSlope); terrain
 *     heightfields contribute walkable automatically. Entities with neither
 *     tag are ignored. Parented entities resolve world transforms through
 *     nav/world-position.js (THE one world-position helper — no fourth copy).
 *   - IMPLICIT GROUND (contract compatibility): a world with NO terrain and
 *     NO nav-surface geometry still bakes the historical implicit walkable
 *     ground plane at y=0 over the nav bounds (API.md: "zero colliders + no
 *     explicit bounds -> empty grid" implies a world WITH colliders has
 *     walkable ground). Scenes with authored ground (terrain / nav-surface)
 *     never get the plane — walkable ground there is real geometry.
 *
 * CLEARANCE CLASSES — AAA-BAKED TRAVERSAL ABILITIES (Phase 1 pivot; Recast/
 * Unreal/Unity semantics — plans/NAV-UX-REVISION.md D-8/D-9 history). ONE
 * bake PER DISTINCT ABILITY+BODY class — the (radius, height, maxSlope,
 * stepHeight) tuple — AUTO-DERIVED from the scene's nav-agent components/
 * scripts at rebuild (nothing configured — the untrained-AI rule), plus one
 * DEFAULT class (the nav-agent SCHEMA DEFAULTS, NAVMESH_CLASS_DEFAULT) for
 * queries that need one. Class key = 'r|h|slope|climb' (radius|height|maxSlope
 * |stepHeight rounded to 3 decimals — navmeshClassKey); lazy per-class bake on
 * first use, cached.
 * Traversal abilities are BAKED, not filtered at query time (the AAA model —
 * Recast walkableClimb/walkableSlopeAngle):
 *   (a) maxSlope   → cfg.walkableSlopeAngle: surfaces steeper than the class's
 *                    maxSlope are dropped AT BAKE (rcMarkWalkableTriangles);
 *                    the mesh contains no surface the ability cannot walk.
 *   (b) stepHeight → cfg.walkableClimb (bounded by the body height — a body
 *                    cannot step higher than itself): steps ≤ stepHeight
 *                    MERGE into one continuous walkable surface at bake
 *                    (rcFilterLowHangingWalkableObstacles + the rasterizer's
 *                    flag-merge threshold); ledges > stepHeight are dropped
 *                    (rcFilterLedgeSpans). Box stairs, curbs and terrain
 *                    steps flow into the surface — no query-time step gate.
 *   (c) jumpHeight — links bake UNFILTERED into every class mesh and are the
 *                    ONLY remaining per-query gate (the per-link |Δh| ≤
 *                    jumpHeight rule — jumping stays off-mesh links, per the
 *                    human directive).
 * THE HONEST TRADE: slope/step ability edits now RE-BAKE (the ability joins
 * the class key) — "tweak an ability, re-route instantly" becomes "re-bake on
 * ability edit"; jumpHeight edits still re-route with zero re-bake. The D-9
 * query-time filters (the per-poly slope flag mask, the corridor OR-gate step
 * rescue, the edge Δh gate) are RETIRED. Per-class erosion is unchanged
 * (walkableRadius = the agent radius EXACTLY — the pinned policy). Agent dims
 * are WORLD UNITS mapped onto Recast's walkableRadius/Height/Climb/Slope —
 * `cellSize` can no longer leak into agent semantics (the 0.5-break bug class
 * dies here).
 *
 * BAKE RESOLUTION (W6a2 — the cellSize-leak verdict matrix): cs/ch are
 * INTERNAL. ch = BAKE_CELL_HEIGHT (0.05 — P2.6 bake tuning). cs is the REQUESTED bake resolution
 * (BAKE_CELL_SIZE default 1.0, overridable via `bake.cellSize` for the
 * resolution matrix) CLAMPED to the PROFILE-SAFE maximum:
 *
 *     cs_eff = min(cs, stepHeight / (2·tan(min(maxSlope, 75°))))
 *
 * Why: Recast's rcFilterLedgeSpans drops a slope span when the traversable
 * neighbor floor range (≈ 2·cs·tanθ) exceeds walkableClimb (= stepHeight),
 * and compact-span connectivity needs cs·tanθ ≤ walkableClimb — both are
 * RESOLUTION LEAKS (a 32° hill dies at cs 1 for a stepHeight-1 agent and
 * disconnects at cs 2). Clamping cs keeps the rasterized staircase within
 * the profile's own step budget at ANY requested resolution, so verdicts
 * (hill crossing, ledge gates, link gates) are resolution-invariant — the
 * acceptance of the {2, 1, 0.5, 0.25} matrix. Effective cs never goes below
 * MIN_BAKE_CELL_SIZE. stepHeight 0 agents can only traverse flat ground
 * (the Recast climb/connectivity model cannot express "slope steps pass when
 * both cells' slope ≤ maxSlope" with zero climb — documented limitation;
 * every pinned verdict uses stepHeight > 0 or flat ground).
 *
 * LINKS: scene.nav.links [{from,to,cost,oneWay}] → Recast off-mesh connections
 * with the SAME traversal semantics as nav/profile.js linkTraversable:
 * jumpHeight gates each link PER QUERY by |Δh| between its endpoint surface
 * heights (W6c-1 D-9: links bake unfiltered into every class mesh and the
 * query's flag mask hides the ones this ability cannot jump — same verdict
 * rule, same verdicts, zero re-bake on ability edits). oneWay is honored via
 * bidirectional:false (UNWEAKENED). COST: implemented via Detour AREA costs
 * (W6a2 finding 3): each traversable link gets a UNIQUE area id whose
 * query-filter cost is (declared cost / 3D link length) × cost scale, so a
 * link hop is charged EXACTLY its declared `cost` in path-cost accounting
 * (proved by A/B in engine/test/navmesh-findings.test.js: an expensive link
 * loses to the ground detour, a cheap link wins). `cost` defaults to the
 * euclid XZ distance of the endpoints (normalizeNavLinks — the nav.js
 * contract semantics).
 *
 * PATH COST MODEL (W6a2 finding 1 — hill crossing): Detour costs edges as
 * 3D midpoint distance × areaCost[curPoly] and A*-ranks with a 0.999·3D
 * heuristic. Pure 3D distance inflates climbing corridors (a 32° hill
 * crossing measures longer than the flat detour even when it is shorter in
 * XZ), so walkable-but-steep polys get area cost sec(maxSlope)·cos(slope)
 * (bucketed per 10° of poly slope): the effective cost of a ground segment
 * becomes sec(maxSlope)·(its XZ length) — a UNIFORM scale of the documented
 * "grid-move units" XZ metric (identical argmin; the scale keeps every area
 * cost ≥ 1 so the heuristic stays admissible and Detour paths stay optimal).
 * A crossing therefore wins whenever it is shorter in XZ — the demo's
 * "scout over the crest" verdict — while a maxSlope-limited profile simply
 * never bakes the hill (skirt verdict unchanged).
 *
 * FINDING 2 (obstacle tops are not walkable islands): per-poly flags are
 * written into the poly mesh before Detour data creation — polys whose
 * surface lies ON a `nav-obstacle` top more than stepHeight above the ground
 * (or outside the resolved nav bounds) get flags 0 and are invisible to
 * every query (findNearestPoly/findPath skip them): isNavigable above a wall
 * top is false at every bake resolution, while `nav-surface` platform tops
 * keep flags 1 and stay walkable. Obstacle tops ≤ stepHeight above the
 * ground merge into the walkable surface (they are climbable curbs — the
 * documented Recast merge semantics).
 *
 * WASM LOADING: `recast-navigation`'s default `@recast-navigation/wasm`
 * export is the INLINE build (wasm-compat: embedded base64, no fetch).
 * W6a2: the module INITIALISES THE WASM AT IMPORT TIME (top-level await,
 * ~15 ms) so every API method below is SYNCHRONOUS — the api.nav contract
 * (findPath/isNavigable/… are sync) is preserved exactly. Node/vitest
 * resolve the package normally; the browser loads it through an import map
 * (engine/test/navmesh-browser.html) against test/serve.js.
 *
 * API (internal module; nav.js wraps it as the api.nav contract):
 *   createNavmesh({ world, scene, bake }) → {
 *     rebuild(), findPath(from, to, profile), isNavigable(x, z, profile),
 *     nearestWalkable(x, z, profile), meshes(), links(), version(), config()
 *   }
 * All methods are SYNCHRONOUS. findPath returns
 * { points: [{x,y,z}, …] } or null (no complete path — Detour partial paths
 * count as unreachable, matching A* semantics). Waypoints are DENSIFIED to
 * ~1 unit spacing (the historical cell-center waypoint density, now
 * resolution-free) with EXACT off-mesh link endpoints kept consecutive
 * (nav-agent-links semantics). meshes() returns the baked polygon geometry
 * per cached CLEARANCE class (D-9):
 *   [{ key, profile: { radius, height }, positions: Float32Array,
 *      indices: Uint32Array, polyCount, links,
 *      polySlopes: Float32Array, polyAreas: Uint8Array }]
 * (ground-poly fan triangulation; off-mesh polys skipped; polySlopes = the
 * MAX detail-triangle slope in DEGREES per ground poly (classifyPolys), the
 * D-9 slope annotation the editor renders green→red; polyAreas = its slope
 * bucket id (slopeAreaId of polySlopes — the annotation the bucketed cost
 * model uses); both indexed by ground poly in `indices` fan order).
 */

import * as recast from 'recast-navigation'
import * as generators from 'recast-navigation/generators'
import { shapeFromCollider, colliderCenter } from '../physics/physics.js'
import { terrainFootprintXZ } from './terrain-query.js'
import { linkTraversable } from './profile.js'
import { worldPositionOf } from './world-position.js'

/** Internal bake resolution — NOT agent semantics (see module doc).
 *  P2.6 BAKE TUNING (human directive, verbatim: 'drop ch to 0.05 if you want
 *  even tighter height.') — ch 0.1 -> 0.05: tighter vertical quantization. */
export const BAKE_CELL_SIZE = 1.0
export const BAKE_CELL_HEIGHT = 0.05
/** Contour simplification tolerance (Recast maxSimplificationError, VOXELS).
 *  P2.6 BAKE TUNING (human directive, verbatim: 'Cut maxSimplificationError
 *  from 1.3 -> ~0.6.') — 1.3 -> 0.6: tighter polygon edges; the chord-dip-
 *  into-footprint class dies here. The trade (MORE polygons) is measured in
 *  API.md 0.1.25. */
export const BAKE_MAX_SIMPLIFICATION_ERROR = 0.6
/** Floor for the profile-safe cs clamp (numerics only). */
export const MIN_BAKE_CELL_SIZE = 0.05

/** surfaceY's layer-pick window (world units): a yHint only selects a face
 *  within ONE step of the body's current ground contact — the layer the
 *  agent is ALREADY on. Matches the nav-agent default stepHeight (0.5). */
export const GROUND_HINT_WINDOW = 0.5

/** STEP 4A TILED BAKE: the class bake divides the scene's XZ bounds into a
 *  square tile grid of this many WORLD UNITS per side and runs the custom
 *  pipeline PER TILE; the per-tile Detour data combines into ONE multi-tile
 *  NavMesh (initTiled + addTile) — queries unchanged. 12 world units ≈ a
 *  street chunk at the bake's 1-unit base cell size; the only cost of
 *  tiling is the seam-overlap margin (agent radius + climb) paid twice per
 *  seam. Tiles stay addressable by grid index for the Step 4b dirty-tile
 *  rebuilds. */
// Env override for tiled-bake testing (Node only — the editor loads this
// module in the browser where `process` does not exist).
const navEnvSize = typeof process !== 'undefined' && process.env
  ? Number(process.env.BAKE_TILE_SIZE)
  : 0
export const BAKE_TILE_SIZE = Number.isFinite(navEnvSize) && navEnvSize > 0 ? navEnvSize : 12
/** Detour poly-id budget (dtNavMeshParams.maxPolys) for the tiled mesh: the
 *  poly-bit width of every polyRef. Any single tile's poly count stays far
 *  below this (a 12×12-world tile at the finest class cs 0.25 caps well
 *  under 1000). */
export const BAKE_NAVMESH_MAX_POLYS = 8192

/** Erosion distance in Recast VOXELS = the agent radius EXACTLY (world radius
 *  / cs), nothing else. EROSION POLICY PINNED (human directive, verbatim:
 *  'Keep erosion = agent radius. Don't fight that; it is the correct
 *  clearance.') — NO corner factor (the tempting sqrt(2) diagonal safety) and
 *  NO additive safety margin, ever. The bake calls ONLY this choke point and
 *  asserts the world-units round-trip (below); the constants + this policy are
 *  pinned in engine/test/navmesh-bake-config.test.js. */
export function erosionRadiusVoxels(radiusWorld, cs) {
  return radiusWorld / cs
}

/** Detour polygon flag kept for walkable polys; 0 = invisible to queries. */
export const POLY_FLAG_WALKABLE = 1
export const POLY_FLAG_DISABLED = 0
// W6c-1: slope-masked-but-real surface. Kept NON-ZERO so the snapping pass
// (nearest poly, unfiltered) still lands on the requested surface — a flags-0
// poly is unsnap-able and the query would teleport onto a rescue poly and
// smuggle the step past the gate (the nav-height 30/0.5 leak).
export const POLY_FLAG_STEEP = 2
/** Detour poly types (dtPolyType). */
const POLYTYPE_GROUND = 0
const POLYTYPE_OFFMESH = 1

/** Area-id budget: 0 = flat ground, 1..8 = slope buckets (10° each),
 *  9..63 = one unique area per declared link (55 links max; further links
 *  share area 63 with cost = cost scale — documented fallback). */
const SLOPE_BUCKET_DEG = 10
const SLOPE_AREA_COUNT = 8
const LINK_AREA_BASE = 9
const LINK_AREA_MAX = 63

/** The navmesh capability profile defaults (nav-agent schema: radius/height). */
export const NAVMESH_PROFILE_DEFAULTS = Object.freeze({
  radius: 0.5,
  height: 2,
  maxSlope: 45,
  stepHeight: 0.5,
  jumpHeight: 1,
})

/** Normalize a capability profile: absent/invalid fields fall back to schema
 *  defaults. Never throws; always returns a complete profile object. */
export function normalizeNavmeshProfile(p) {
  const pick = (v, d) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : d
  }
  const s = p && typeof p === 'object' && !Array.isArray(p) ? p : {}
  return {
    radius: pick(s.radius, NAVMESH_PROFILE_DEFAULTS.radius),
    height: pick(s.height, NAVMESH_PROFILE_DEFAULTS.height),
    maxSlope: pick(s.maxSlope, NAVMESH_PROFILE_DEFAULTS.maxSlope),
    stepHeight: pick(s.stepHeight, NAVMESH_PROFILE_DEFAULTS.stepHeight),
    jumpHeight: pick(s.jumpHeight, NAVMESH_PROFILE_DEFAULTS.jumpHeight),
  }
}

/** Cache key: normalized profile, rounded to 3 decimals (dedupe noise). */
export function navmeshProfileKey(p) {
  const n = normalizeNavmeshProfile(p)
  const r = (v) => Math.round(v * 1000) / 1000
  return `${r(n.radius)}|${r(n.height)}|${r(n.maxSlope)}|${r(n.stepHeight)}|${r(n.jumpHeight)}`
}

/** AAA-baked CLEARANCE CLASS key: 'r|h|slope|climb' — radius|height|maxSlope
 *  |stepHeight rounded to 3 decimals (dedupe noise). The BAKED abilities join
 *  the key (Phase 1 pivot): one bake per (body, slope, step) — an ability edit
 *  bakes a NEW class (re-bake). jumpHeight is NOT in the key: links bake
 *  unfiltered and are gated per query. */
export function navmeshClassKey(p) {
  const n = normalizeNavmeshProfile(p)
  const r = (v) => Math.round(v * 1000) / 1000
  return `${r(n.radius)}|${r(n.height)}|${r(n.maxSlope)}|${r(n.stepHeight)}`
}

/** The DEFAULT clearance class dims — the nav-agent SCHEMA DEFAULTS
 *  (NAVMESH_PROFILE_DEFAULTS.radius/height, 0.5/2): the body size a query gets
 *  when it asks for the schema defaults (an omitted/absent profile normalizes
 *  to these dims, incl. nav.js's permissive legacy profile). */
export const NAVMESH_CLASS_DEFAULT = Object.freeze({
  radius: NAVMESH_PROFILE_DEFAULTS.radius,
  height: NAVMESH_PROFILE_DEFAULTS.height,
})

/** RETIRED (Phase 1 pivot — AAA baked abilities): the D-9 loose bake slope.
 *  The class bake now uses cfg.walkableSlopeAngle = the class's maxSlope
 *  (steep surfaces drop at bake). Kept exported for legacy/permissive profile
 *  semantics (nav.js PERMISSIVE_MESH_PROFILE) and historical pins. Vertical
 *  faces (ny≈0) stay out at any threshold — they are not a surface. */
export const LOOSE_BAKE_SLOPE_DEG = 89.9

/** Staircase-survival reference angle for the class bake resolution clamp
 *  (classSafeCellSize): surfaces up to this slope are guaranteed to survive
 *  the rasterized-staircase/ledge-filter resolution leak at EVERY requested
 *  bake resolution. Steeper surfaces may be resolution-sensitive at coarse cs
 *  (documented limitation — every pinned steep-surface verdict is a REFUSAL,
 *  which holds whether the surface survives or not). */
export const BAKE_STAIRCASE_SLOPE_DEG = 60

/**
 * AUTO-DERIVED clearance classes (D-9 — nothing configured): the distinct
 * (radius, height) pairs the scene's nav-agent COMPONENTS
 * (`components['nav-agent']`) and legacy nav-agent SCRIPTS
 * (`components.scripts['nav-agent'].params`) declare. Absent/invalid dims fall
 * back to the schema defaults (normalizeNavmeshProfile). Sorted by class key,
 * deduped. Re-derived at every rebuild.
 */
export function collectNavAgentClasses({ world, scene } = {}) {
  const recs = []
  if (world && typeof world.query === 'function' && typeof world.entity === 'function') {
    for (const id of world.query({ has: ['transform'] })) {
      const rec = world.entity(id)
      if (rec) recs.push(rec)
    }
  } else if (scene && Array.isArray(scene.entities)) {
    for (const rec of scene.entities) recs.push(rec)
  }
  const byKey = new Map()
  for (const rec of recs) {
    const comp = (rec && rec.components) || {}
    const decl = comp['nav-agent'] ||
      (comp.scripts && comp.scripts['nav-agent'] && comp.scripts['nav-agent'].params) || null
    if (!decl || typeof decl !== 'object' || Array.isArray(decl)) continue
    const n = normalizeNavmeshProfile(decl)
    const key = navmeshClassKey(n)
    if (!byKey.has(key)) byKey.set(key, { radius: n.radius, height: n.height, maxSlope: n.maxSlope, stepHeight: n.stepHeight })
  }
  return [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, v]) => v)
}

/** Class-safe bake cs (the profile-safe clamp's D-9 successor): the requested
 *  resolution clamped so (1) the agent radius stays ≥ 1 voxel (walkableRadius/
 *  cs erosion is an integer voxel count — a sub-voxel radius would erode a
 *  whole extra layer and move the walkable boundary with cs) and (2) the
 *  rasterized staircase of any surface the BAKE KEEPS (≤ the class's maxSlope,
 *  capped at BAKE_STAIRCASE_SLOPE_DEG) fits the class's own BAKED climb
 *  (walkableClimb = min(stepHeight, height)): 2·cs·tanθ ≤ climb. Quantized to
 *  1/1024 (float-noise immunity — the cellSize-leak guard). */
export function classSafeCellSize(cls, requested) {
  const n = normalizeNavmeshProfile(cls)
  const tan = Math.tan(Math.min(Math.max(n.maxSlope, 0.5), BAKE_STAIRCASE_SLOPE_DEG) * Math.PI / 180)
  // The BAKED climb — same formula as bakeClass's climbWorld (incl. its
  // 1-voxel quantization floor): the clamp must budget the climb the bake
  // actually gets, or a zero stepHeight collapses cs to MIN and re-opens the
  // resolution leak the clamp exists to close.
  const climbWorld = Math.max(Math.min(n.stepHeight, n.height), BAKE_CELL_HEIGHT)
  let cap = climbWorld / (2 * tan)
  if (!(cap > 0)) cap = MIN_BAKE_CELL_SIZE
  cap = Math.max(Math.floor(cap * 1024) / 1024, MIN_BAKE_CELL_SIZE)
  const radiusCap = Math.max(Math.floor(n.radius * 1024) / 1024, MIN_BAKE_CELL_SIZE)
  return Math.floor(Math.min(requested, cap, radiusCap) * 1024) / 1024
}

/** The D-9 maxSlope mask rule (the reference the A/B pin checks the Detour
 *  flag mechanism against): a poly is walkable for maxSlope iff its annotated
 *  slope does not exceed it. */
export function slopeFilterOk(slopeDeg, maxSlope) {
  return !(slopeDeg > maxSlope)
}

/**
 * Normalize the off-mesh link list (the nav.js contract semantics — the
 * historical normalizeLinkEntry): valid entries kept, invalid dropped;
 * `cost` defaults to the euclid XZ distance of the endpoints (declared cost
 * must be finite > 0); `oneWay` defaults to false.
 */
export function normalizeNavLinks(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue
    const from = validPoint(e.from)
    const to = validPoint(e.to)
    if (!from || !to) continue
    if (from.x === to.x && from.z === to.z) continue
    let cost
    if (e.cost === undefined) cost = Math.hypot(to.x - from.x, to.z - from.z)
    else if (Number.isFinite(e.cost) && e.cost > 0) cost = e.cost
    else continue
    if (e.oneWay !== undefined && typeof e.oneWay !== 'boolean') continue
    out.push({ from, to, cost, oneWay: e.oneWay === true })
  }
  return out
}

function validPoint(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return null
  // Additive (ballistic jump): an authored endpoint `y` is PRESERVED as
  // metadata for the nav-agent's ballistic link-hop launch solver. The bake
  // only reads x/z (endpoints drape to the surface) — keeping y is inert for
  // routing and never feeds the jumpHeight gate.
  return Number.isFinite(p.y) ? { x: p.x, y: p.y, z: p.z } : { x: p.x, z: p.z }
}

// ---------------------------------------------------------------------------
// wasm one-time init at MODULE LOAD (top-level await) — every API method is
// synchronous after this line. ~15 ms in Node.
// ---------------------------------------------------------------------------
let _ready = null
function ensureWasm() {
  if (!_ready) {
    _ready = (async () => {
      if (typeof recast.init === 'function') await recast.init()
      else if (typeof generators.init === 'function') await generators.init()
      return true
    })()
  }
  return _ready
}
await ensureWasm()

// ---------------------------------------------------------------------------
// Bake geometry from the COLLISION world (pure-ish; no three import).
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

/** Flip a triangle so its normal points UP (cross(b-a, c-a).y ≥ 0). Recast's
 *  slope marking reads winding-derived normals: every bake triangle must be
 *  wound so top faces read walkable. Downward faces are flipped (a box's
 *  bottom face therefore also reads as a plane — documented: navmesh may
 *  appear under a floating collider; ground-mounted colliders are unaffected
 *  because the face coincides with existing spans). */
function orientUp(t) {
  const ux = t.bx - t.ax, uz = t.bz - t.az
  const vx = t.cx - t.ax, vz = t.cz - t.az
  const ny = uz * vx - ux * vz
  if (ny < 0) return { ax: t.ax, ay: t.ay, az: t.az, bx: t.cx, by: t.cy, bz: t.cz, cx: t.bx, cy: t.by, cz: t.bz }
  return t
}

function pushTri(out, ax, ay, az, bx, by, bz, cx, cy, cz) {
  out.push(orientUp({ ax, ay, az, bx, by, bz, cx, cy, cz }))
}

/** Axis-aligned box (min/max) → 12 triangles at offset (px,py,pz). */
function boxTris(box, px, py, pz, out) {
  const x0 = box.minX + px, x1 = box.maxX + px
  const y0 = box.minY + py, y1 = box.maxY + py
  const z0 = box.minZ + pz, z1 = box.maxZ + pz
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ]
  const quad = (a, b, cc, d) => {
    pushTri(out, ...c[a], ...c[b], ...c[cc])
    pushTri(out, ...c[a], ...c[cc], ...c[d])
  }
  quad(4, 5, 6, 7) // top-ish faces per quad; orientUp fixes normals
  quad(1, 0, 3, 2)
  quad(0, 4, 7, 3)
  quad(5, 1, 2, 6)
  quad(3, 7, 6, 2)
  quad(0, 1, 5, 4)
}

/** UV sphere tessellation (segments × rings) around (cx,cy,cz). */
function sphereTris(sphere, out, segments = 12, rings = 8) {
  const { x: cx, y: cy, z: cz, radius: r } = sphere
  const pt = (i, j) => {
    const phi = (j / rings) * Math.PI
    const theta = (i / segments) * TAU
    return [cx + r * Math.sin(phi) * Math.cos(theta), cy + r * Math.cos(phi), cz + r * Math.sin(phi) * Math.sin(theta)]
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1)
      if (j > 0) pushTri(out, ...a, ...b, ...c)
      if (j < rings - 1) pushTri(out, ...a, ...c, ...d)
    }
  }
}

/** Capsule (pill) tessellation: cylinder core + hemisphere caps. */
function capsuleTris(cap, out, segments = 12, rings = 6) {
  const { x: cx, y: cy, z: cz, radius: r } = cap
  const h = Number.isFinite(cap.coreHalf) ? cap.coreHalf : 0
  const pt = (i, j) => {
    // j in [0, 2*rings]: 0..rings = top hemisphere, rings..2rings = bottom.
    const phi = (j / (2 * rings)) * Math.PI
    const theta = (i / segments) * TAU
    const sinPhi = Math.sin(phi)
    let y = r * Math.cos(phi)
    if (j <= rings) y += h
    else y -= h
    return [cx + r * sinPhi * Math.cos(theta), cy + y, cz + r * sinPhi * Math.sin(theta)]
  }
  for (let j = 0; j < 2 * rings; j++) {
    for (let i = 0; i < segments; i++) {
      const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1)
      pushTri(out, ...a, ...b, ...c)
      pushTri(out, ...a, ...c, ...d)
    }
  }
}

/** A physics shape (centered at origin) → triangles translated to (px,py,pz). */
function shapeTriangles(shape, px, py, pz) {
  const out = []
  if (!shape) return out
  if (shape.kind === 'mesh' && Array.isArray(shape.tris)) {
    for (const t of shape.tris) {
      pushTri(out, t.ax + px, t.ay + py, t.az + pz, t.bx + px, t.by + py, t.bz + pz, t.cx + px, t.cy + py, t.cz + pz)
    }
    return out
  }
  if (shape.kind === 'box') return boxTris(shape.box, px, py, pz, out), out
  if (shape.kind === 'sphere') return sphereTris(shape.sphere, out), out
  if (shape.kind === 'pill') return capsuleTris(shape.capsule, out), out
  return out
}

// ---------------------------------------------------------------------------
// SOURCE-FAITHFUL SURFACE (Phase 2 — the drape REPLACEMENT).
// ---------------------------------------------------------------------------
/**
 * The navmesh surface IS the source geometry's surface — its REAL nodes and
 * vertices, not a draped approximation (human diagnosis 2026-10-01: 'we drape
 * surfaces down without considering the nodes that already exist on the
 * terrain or floor object'). The retired `drape` pulled every exported vertex
 * to a BILINEAR heightfield sample at its XZ, gated by a snap/keep heuristic;
 * it never consulted the source's actual triangles, so every class bake (its
 * polys at different XZ) sampled different interpolated heights and made
 * different snap/keep decisions — three drastically different draped surfaces
 * for one identical hill, none matching the terrain's node-based triangles
 * (holes + terrain through the mesh + jagged stairs).
 *
 * This sampler is the fix: the SOURCE TRIANGLE SOUP itself — the exact world
 * triangles the bake rasterizes (terrain heightfield GRID-NODE triangles,
 * primitive box/plane/ramp faces, tessellated sphere/pill faces — see
 * collectBakeGeometry). A surface point's Y is the barycentric Y of the
 * source triangle containing its XZ: for terrain that IS the triangulated
 * node surface (never bilinear), for a primitive it IS the real face plane
 * through its vertices. Where faces overlap (a box top over terrain) the
 * vertex's raw span-top Y selects the face the span was rasterized from
 * (nearest face). Points over no source face (the implicit y=0 ground ring)
 * keep their raw height.
 *
 * ONE sampler is shared by every class bake (source geometry is class-
 * independent), so ALL class meshes lie on ONE shared surface and differ ONLY
 * in the per-agent WALKABLE-AREA trim — the full walkableRadius erosion from
 * every non-walkable area (obstacles/objects AND drop-off edges alike). Slope
 * colors follow the shared surface: the viz export tessellates the walkable
 * polys against THESE triangles (each clipped piece rides ONE source face's
 * plane), so the slope at a point is the SOURCE slope in every class view —
 * identical by construction.
 *
 * @param {number[]} positions  flat world XYZ (the bake's source triangles).
 * @param {number[]} indices    triangle indices into `positions`.
 * @returns {{ faceAt: (x,z,yRaw) => {y,planeKey,id}|null,
 *            topAt: (x,z) => {y,planeKey,id}|null }}
 */
export function createSourceSurface(positions, indices) {
  const tris = []
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ia = indices[t] * 3, ib = indices[t + 1] * 3, ic = indices[t + 2] * 3
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2]
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2]
    const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2]
    // XZ barycentric denominator (meshYAt's formulation). A near-vertical
    // face has a degenerate XZ projection and can never contain a point.
    const d = (cz - bz) * (ax - bx) + (bx - cx) * (az - bz)
    if (!(Math.abs(d) > 1e-12)) continue
    const ux = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
    const uy = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
    const uz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    const len = Math.hypot(ux, uy, uz) || 1
    // Plane identity (normal + offset, quantized) — coplanar faces (a box
    // top's two triangles) share one key, which the surface samplers key off.
    const planeKey = `${Math.round(ux / len * 1e4)},${Math.round(uy / len * 1e4)},${Math.round(uz / len * 1e4)},${Math.round((ux * ax + uy * ay + uz * az) / len * 1e3)}`
    tris.push({
      ax, ay, az, bx, by, bz, cx, cy, cz, d, planeKey,
      minX: Math.min(ax, bx, cx), maxX: Math.max(ax, bx, cx),
      minZ: Math.min(az, bz, cz), maxZ: Math.max(az, bz, cz),
    })
  }
  // Uniform XZ bucket grid (per-query lookups must not scan the whole soup).
  let gMinX = Infinity, gMaxX = -Infinity, gMinZ = Infinity, gMaxZ = -Infinity
  for (const t of tris) {
    if (t.minX < gMinX) gMinX = t.minX
    if (t.maxX > gMaxX) gMaxX = t.maxX
    if (t.minZ < gMinZ) gMinZ = t.minZ
    if (t.maxZ > gMaxZ) gMaxZ = t.maxZ
  }
  const cell = Number.isFinite(gMinX) ? Math.min(4, Math.max(0.5, Math.max(gMaxX - gMinX, gMaxZ - gMinZ) / 64)) : 1
  const gw = Number.isFinite(gMinX) ? Math.max(1, Math.ceil((gMaxX - gMinX) / cell) + 1) : 1
  const gh = Number.isFinite(gMinZ) ? Math.max(1, Math.ceil((gMaxZ - gMinZ) / cell) + 1) : 1
  const grid = new Array(gw * gh)
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i]
    const x0 = Math.max(0, Math.floor((t.minX - gMinX) / cell)), x1 = Math.min(gw - 1, Math.floor((t.maxX - gMinX) / cell))
    const z0 = Math.max(0, Math.floor((t.minZ - gMinZ) / cell)), z1 = Math.min(gh - 1, Math.floor((t.maxZ - gMinZ) / cell))
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const k = gz * gw + gx
        ;(grid[k] || (grid[k] = [])).push(i)
      }
    }
  }
  const stamp = new Int32Array(tris.length)
  let stampN = 0
  /** Visit every face whose XZ triangle contains (x,z) — deterministic order. */
  function forEachFace(x, z, cb) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return
    const gx = Math.floor((x - gMinX) / cell), gz = Math.floor((z - gMinZ) / cell)
    if (gx < 0 || gz < 0 || gx >= gw || gz >= gh) return
    const list = grid[gz * gw + gx]
    if (!list) return
    const n = ++stampN
    for (let i = 0; i < list.length; i++) {
      const ti = list[i]
      if (stamp[ti] === n) continue
      stamp[ti] = n
      const t = tris[ti]
      const l1 = ((t.cz - t.bz) * (x - t.bx) + (t.bx - t.cx) * (z - t.bz)) / t.d
      const l2 = ((t.az - t.cz) * (x - t.cx) + (t.cx - t.ax) * (z - t.cz)) / t.d
      const l3 = 1 - l1 - l2
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue
      cb(ti, l1 * t.ay + l2 * t.by + l3 * t.cy)
    }
  }
  /** The face the raw span-top `yRaw` was rasterized from: the containing
   *  face whose Y is nearest to yRaw (ties -> lowest triangle index, fully
   *  deterministic). */
  function faceAt(x, z, yRaw) {
    let best = null, bestDev = Infinity, bestY = 0
    forEachFace(x, z, (ti, y) => {
      const dev = Math.abs(y - yRaw)
      if (best === null || dev < bestDev) {
        best = ti; bestDev = dev; bestY = y
      }
    })
    return best === null ? null : { y: bestY, planeKey: tris[best].planeKey, id: best }
  }
  /** Every face's plane key whose XZ triangle contains (x,z) AND whose
   *  surface Y matches `y` within EPS — for a vertex on a source crease this
   *  is BOTH adjacent faces (the crease lies on both planes), which keeps the
   *  refine's alignment test STABLE (no face-pick flapping at creases). */
  function facesAt(x, z, y) {
    const keys = []
    const EPS = 1e-5
    forEachFace(x, z, (ti, fy) => {
      if (Math.abs(fy - y) <= EPS && !keys.includes(tris[ti].planeKey)) keys.push(tris[ti].planeKey)
    })
    return keys
  }
  /** The topmost face at (x,z) — the walkable ground (span tops are column
   *  maxima). */
  function topAt(x, z) {
    let best = null, bestY = -Infinity
    forEachFace(x, z, (ti, y) => {
      if (best === null || y > bestY) { best = ti; bestY = y }
    })
    return best === null ? null : { y: bestY, planeKey: tris[best].planeKey, id: best }
  }
  /** Face tri ids (not just plane keys) whose XZ triangle contains (x,z) AND
   *  whose surface Y matches `y` — the faces a vertex actually rests on. */
  function trisAt(x, z, y) {
    const ids = []
    const EPS = 1e-5
    forEachFace(x, z, (ti, fy) => {
      if (Math.abs(fy - y) <= EPS) ids.push(ti)
    })
    return ids
  }
  /** All face tri ids whose XZ bbox overlaps the given rect (ascending id
   *  order — deterministic): every face a shape inside the rect can cover. */
  function trisInRect(minX, maxX, minZ, maxZ) {
    const x0 = Math.max(0, Math.floor((minX - gMinX) / cell)), x1 = Math.min(gw - 1, Math.floor((maxX - gMinX) / cell))
    const z0 = Math.max(0, Math.floor((minZ - gMinZ) / cell)), z1 = Math.min(gh - 1, Math.floor((maxZ - gMinZ) / cell))
    const seen = new Set()
    const ids = []
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const list = grid[gz * gw + gx]
        if (!list) continue
        for (const ti of list) {
          if (seen.has(ti)) continue
          seen.add(ti)
          const t = tris[ti]
          if (t.maxX < minX || t.minX > maxX || t.maxZ < minZ || t.minZ > maxZ) continue
          ids.push(ti)
        }
      }
    }
    ids.sort((a, b) => a - b)
    return ids
  }
  /** The plane identity of face tri `id` (coplanar faces share the key). */
  function planeKeyOf(id) {
    return tris[id].planeKey
  }
  /** The face-triangle `id`'s plane Y at (x,z) — exact surface height of that
   *  source face, even outside the face's own XZ triangle (plane extension). */
  function snapY(id, x, z) {
    const t = tris[id]
    const l1 = ((t.cz - t.bz) * (x - t.bx) + (t.bx - t.cx) * (z - t.bz)) / t.d
    const l2 = ((t.az - t.cz) * (x - t.cx) + (t.cx - t.ax) * (z - t.cz)) / t.d
    return l1 * t.ay + l2 * t.by + (1 - l1 - l2) * t.cy
  }
  /** The face-triangle `id`'s XZ region corners (convex, for clipping). */
  function triXZ(id) {
    const t = tris[id]
    return [t.ax, t.az, t.bx, t.bz, t.cx, t.cz]
  }
  return { faceAt, facesAt, topAt, trisAt, trisInRect, planeKeyOf, snapY, triXZ }
}

function readOffset(c) {
  let off = { x: 0, y: 0, z: 0 }
  try {
    const v = colliderCenter(c)
    if (Array.isArray(v)) off = { x: v[0] || 0, y: v[1] || 0, z: v[2] || 0 }
    else if (v && typeof v === 'object') off = { x: v.x || 0, y: v.y || 0, z: v.z || 0 }
  } catch { /* centered collider — the common case */ }
  return off
}

/**
 * Scene-record transform tolerance (the segment-clearance fixture's pillar
 * scene carries the transform at ENTITY level in the legacy array form —
 * `transform: { position: [x,y,z] }` — instead of `components.transform`):
 * normalize ONCE so the canonical resolver (worldPositionOf reads
 * `components.transform.{x,y,z}`) accepts every form the scene layer
 * tolerates. Records without a transform pass through untouched.
 */
function normBakeRec(rec) {
  if (!rec) return rec
  const comp = rec.components
  const tRaw = (comp && comp.transform) || rec.transform
  if (!tRaw) return rec
  const t = { ...tRaw }
  const pos = Array.isArray(tRaw.position) ? tRaw.position : null
  if (!Number.isFinite(t.x)) t.x = (pos && Number.isFinite(pos[0])) ? pos[0] : 0
  if (!Number.isFinite(t.y)) t.y = (pos && Number.isFinite(pos[1])) ? pos[1] : 0
  if (!Number.isFinite(t.z)) t.z = (pos && Number.isFinite(pos[2])) ? pos[2] : 0
  return { ...rec, components: { ...(comp || {}), transform: t } }
}

/**
 * Collect bake triangles from the collision world. Returns
 * { positions: number[], indices: number[], carve: tri[], terrain, counts }
 * where `carve` holds the ORIENTED triangles of `nav-obstacle` geometry
 * (needed for the finding-2 obstacle-top classification) and counts are the
 * entity-level tag audit {walkable, carve, ignored}.
 */
export function collectBakeGeometry({ world, scene } = {}) {
  const recs = []
  if (world && typeof world.query === 'function' && typeof world.entity === 'function') {
    for (const id of world.query({ has: ['transform'] })) {
      const rec = world.entity(id)
      if (rec) recs.push({ id, rec: normBakeRec(rec) })
    }
  } else if (scene && Array.isArray(scene.entities)) {
    for (const rec of scene.entities) recs.push({ id: rec.id, rec: normBakeRec(rec) })
  }
  const byId = new Map(recs.map((r) => [r.id, r.rec]))
  const seam = {
    entity: (id) => {
      if (world && typeof world.entity === 'function') {
        const live = world.entity(id)
        if (live) return live
      }
      return byId.get(id) || null
    },
    getParent: world && typeof world.getParent === 'function' ? (id) => world.getParent(id) : undefined,
  }

  const positions = []
  const indices = []
  const carve = []
  const counts = { walkable: 0, carve: 0, ignored: 0 }
  const terrains = []
  let navSurfaceTris = 0 // authored nav-surface geometry (the implicit-ground gate)
  const add = (tris, toCarve) => {
    let base = positions.length / 3
    for (const t of tris) {
      positions.push(t.ax, t.ay, t.az, t.bx, t.by, t.bz, t.cx, t.cy, t.cz)
      indices.push(base, base + 1, base + 2)
      base += 3
      if (toCarve) carve.push(t)
    }
  }

  for (const { id, rec } of recs) {
    const comp = (rec && rec.components) || {}
    const t = comp.transform || {}
    const tags = Array.isArray(rec.tags) ? rec.tags : Array.isArray(comp.tags) ? comp.tags : []
    const isTerrain = !!comp.terrain
    const walkableTag = tags.includes('nav-surface')
    // `nav-obstacle` is MARKER-tolerant like the segment-clearance checker:
    // the tag form (the live schema) or a present `nav-obstacle` COMPONENT.
    const carveTag = tags.includes('nav-obstacle') || comp['nav-obstacle'] !== undefined
    if (!isTerrain && !walkableTag && !carveTag) { counts.ignored++; continue }
    if (!isTerrain && !comp.collider) { counts.ignored++; continue }

    const ctx = {
      render: comp.render,
      terrain: comp.terrain,
      scale: t.scale,
      rotation: t.rot || t.rotation || null,
    }
    let shape
    try {
      shape = shapeFromCollider(isTerrain ? { shape: 'render' } : comp.collider, ctx)
    } catch { counts.ignored++; continue }
    const p = worldPositionOf(seam, id)
    const off = isTerrain ? { x: 0, y: 0, z: 0 } : readOffset(comp.collider)
    const tris = shapeTriangles(shape, p.x + off.x, p.y + off.y, p.z + off.z)
    if (carveTag) {
      // nav-obstacle geometry is NOT rasterized: its whole voxel column is
      // nulled at bake (nullSpansOverCarve) — the rasterized-grid blocked
      // column semantics. Rasterizing it too would only add walkable ramps
      // up obstacle sides (span flag-merge artifacts).
      for (const t of tris) carve.push(t)
      counts.carve++
      continue
    }
    add(tris, false)
    if (isTerrain) {
      terrains.push({ terrain: comp.terrain, transform: t })
      counts.walkable++
    } else {
      counts.walkable++
      if (walkableTag) navSurfaceTris += tris.length
    }
  }
  return { positions, indices, carve, terrains, terrain: terrains[0] || null, counts, navSurfaceTris }
}

// ---------------------------------------------------------------------------
// Profile-safe bake resolution + cost model (module doc).
// ---------------------------------------------------------------------------

function clampSlopeRad(maxSlope) {
  return Math.min(Math.max(Number(maxSlope) || 0, 0), 75) * Math.PI / 180
}

/** Profile-safe bake cs: the requested resolution clamped so the rasterized
 *  staircase stays within the profile's step budget AND the agent radius
 *  stays ≥ 1 voxel (walkableRadius/cs — Recast's erosion distance is an
 *  integer voxel count: a sub-voxel radius would erode a whole extra voxel
 *  layer and move the walkable boundary with cs — another cellSize leak).
 *  Quantized to 1/1024 so two requests that SHOULD share an effective
 *  resolution can never diverge on float noise (a tan(45°)=0.9999… artifact
 *  must not move the mesh — that is the cellSize-leak bug class through the
 *  back door). */
export function profileSafeCellSize(profile, requested) {
  const p = normalizeNavmeshProfile(profile)
  const tan = Math.tan(clampSlopeRad(p.maxSlope))
  // Vacuous staircase constraint (maxSlope 0 = flat-only): tan 0 means NO cs
  // can create a disallowed staircase, so the cap is Infinity (unconstrained),
  // NOT the minimum — collapsing to MIN here would silently bake maxSlope-0
  // profiles at 10× resolution and desync their corridors from every other
  // profile (the exact cellSize-leak bug class in reverse).
  let cap = Number.isFinite(tan) && tan > 0 ? p.stepHeight / (2 * tan) : Infinity
  if (cap <= 0) cap = MIN_BAKE_CELL_SIZE // stepHeight 0 + slope > 0: no cs is safe, go finest
  cap = Number.isFinite(cap) ? Math.max(Math.floor(cap * 1024) / 1024, MIN_BAKE_CELL_SIZE) : Infinity
  const radiusCap = Math.max(Math.floor(p.radius * 1024) / 1024, MIN_BAKE_CELL_SIZE)
  return Math.floor(Math.min(requested, cap, radiusCap) * 1024) / 1024
}

/** Uniform cost scale sec(maxSlope): keeps every area cost ≥ 1 (A*
 *  admissibility) while effective ground cost ∝ XZ length. */
function costScale(profile) {
  return 1 / Math.max(Math.cos(clampSlopeRad(profile.maxSlope)), 1e-6)
}

/** Area cost for a poly of slope θ: the XZ-equivalent 1/cos(θ) expressed as
 *  scale·cos(bucketMax) (10° buckets). bucketMax is clamped to maxSlope so
 *  cost ≥ scale·cos(maxSlope) = 1 ALWAYS — Detour's A* heuristic assumes
 *  cost ≥ 1 per unit; a sub-1 area cost makes the heuristic inadmissible and
 *  findPath returns partial corridors on perfectly connected meshes (the
 *  maxSlope < 10° failure mode). */
function slopeAreaCost(scale, slopeDeg, maxSlope) {
  const k = Math.min(SLOPE_AREA_COUNT - 1, Math.max(0, Math.floor(slopeDeg / SLOPE_BUCKET_DEG)))
  const bucketMax = Math.min((k + 1) * SLOPE_BUCKET_DEG, Math.max(maxSlope, 0))
  return scale * Math.cos(bucketMax * Math.PI / 180)
}

function slopeAreaId(slopeDeg) {
  const k = Math.min(SLOPE_AREA_COUNT - 1, Math.max(0, Math.floor(slopeDeg / SLOPE_BUCKET_DEG)))
  return slopeDeg > 0.5 ? 1 + k : 0
}

// ---------------------------------------------------------------------------
// createNavmesh
// ---------------------------------------------------------------------------

/** recast-navigation array wrappers expose length as a `size` getter (and raw
 *  typed arrays as `length`); accept either. */
function arrLen(a) {
  if (!a) return 0
  if (typeof a.count === 'function') return a.count()
  if (Number.isFinite(a.size)) return a.size
  return Number.isFinite(a.length) ? a.length : 0
}

/**
 * @param {{ world?: object, scene?: object, bake?: object }} deps `scene` is
 *   the authoring truth ({entities, nav:{links}}); `world` (optional) supplies
 *   live entity records + parent resolution. `bake` (W6a2 diagnostics/matrix)
 *   may override { cellSize, cellHeight, bounds } — bounds is the resolved
 *   nav bounds (object or getter); polys outside it are flagged off. All
 *   methods are SYNCHRONOUS (wasm is initialised at module load).
 */
export function createNavmesh({ world, scene, bake } = {}) {
  // Internal bake resolution (overridable for the W6a2 resolution matrix —
  // never agent semantics; see module doc).
  const CELL = {
    size: Number(bake && bake.cellSize) > 0 ? Number(bake.cellSize) : BAKE_CELL_SIZE,
    height: Number(bake && bake.cellHeight) > 0 ? Number(bake.cellHeight) : BAKE_CELL_HEIGHT,
  }
  const boundsGetter = bake && typeof bake.bounds === 'function' ? bake.bounds : () => (bake && bake.bounds) || null
  // D-9: ONE cache entry per CLEARANCE class ('r|h'), lazily baked on first
  // use. Abilities never enter the key — an ability edit re-routes with ZERO
  // re-bake (version() unchanged).
  const cache = new Map() // classKey -> { cls, navMesh, query, polySlopes, ... }
  let versionCounter = 1
  // The AUTO-DERIVED class list (nav-agents) — derived at create and re-derived
  // at every rebuild; reported by config().classes.
  let derivedClasses = collectNavAgentClasses({ world, scene })

  const linksRaw = (scene && scene.nav && Array.isArray(scene.nav.links)) ? scene.nav.links : []
  const links = normalizeNavLinks(linksRaw)

  const geomCache = { value: null }
  function geometry() {
    if (!geomCache.value) geomCache.value = collectBakeGeometry({ world, scene })
    return geomCache.value
  }

  /** SOURCE-FAITHFUL SURFACE (Phase 2) — ONE shared sampler over the bake's
   *  source triangles, built lazily and shared by every class bake (the
   *  source geometry is class-independent). Every exported surface vertex's
   *  Y comes from here; all class meshes therefore lie on ONE surface. */
  const surfaceCache = { geom: null, value: null }
  function sourceSurface() {
    const geom = geometry()
    if (surfaceCache.geom !== geom) {
      surfaceCache.geom = geom
      surfaceCache.value = createSourceSurface(geom.positions, geom.indices)
    }
    return surfaceCache.value
  }

  /** Derived-bounds margin (world units per side) — mirrors nav.js's P2-N4
   *  BOUNDS_MARGIN so direct core use resolves the same nav bounds the wrapper
   *  derives from the outside. */
  const DERIVE_MARGIN = 2

  /** P2-N4 derive for DIRECT core use (tests / W6a2 matrix / diagnostics):
   *  when no `bake.bounds` override is given, resolve nav bounds from the
   *  bake-geometry XZ AABB + DERIVE_MARGIN. The implicit ground plane and the
   *  outside-bounds poly cull both key off these bounds — without them the
   *  core silently baked NO ground at all (open ground unnavigable). nav.js
   *  always passes its own entity-level derive via bake.bounds, so production
   *  bounds are unchanged; this only makes bounds-less direct use honest. */
  function derivedBounds() {
    const geom = geometry()
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    // ALL bake geometry joins the derive — walkable positions (terrain +
    // nav-surface) AND carve triangles (nav-obstacle footprints are NOT in
    // positions; nav.js's entity-level derive counts every collider).
    const xs = []
    for (let i = 0; i < geom.positions.length; i += 3) xs.push(geom.positions[i], geom.positions[i + 2])
    for (const t of geom.carve) xs.push(t.ax, t.az, t.bx, t.bz, t.cx, t.cz)
    for (let i = 0; i < xs.length; i += 2) {
      const x = xs[i], z = xs[i + 1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
    if (!Number.isFinite(minX)) return null
    return {
      minX: minX - DERIVE_MARGIN, minZ: minZ - DERIVE_MARGIN,
      maxX: maxX + DERIVE_MARGIN, maxZ: maxZ + DERIVE_MARGIN,
    }
  }

  /** World Y of the walkable ground under (x,z) — the SOURCE surface's Y at
   *  that XZ (Phase 2: source-faithful, not bilinear): the topmost real face
   *  (terrain GRID-NODE triangles, primitive box/plane/ramp faces) covering
   *  the point, else 0 (the implicit ground). */
  function groundY(x, z) {
    const hit = sourceSurface().topAt(x, z)
    return hit ? hit.y : 0
  }

  /** Implicit y=0 ground over the bounds MINUS the terrain footprints — the
   *  contract's implicit walkable ground (module doc): the grid covered the
   *  whole resolved bounds with height-0 ground outside the heightfields
   *  (the derived-bounds margin ring is walkable surface). Subtracting the
   *  terrain rects keeps the plane from surfacing UNDER hills. The plane
   *  extends `expand` past the bounds so walkableArea erosion (the agent
   *  radius) lands OUTSIDE the nav area — otherwise every nav-bounds edge
   *  (and terrain edge) loses its outer ring to erosion and edge points
   *  stop being navigable (another cellSize leak). */
  function implicitGroundTris(bounds, cutRects, expand = 0) {
    if (!bounds) return []
    let rects = [{
      minX: bounds.minX - expand, maxX: bounds.maxX + expand,
      minZ: bounds.minZ - expand, maxZ: bounds.maxZ + expand,
    }]
    for (const cut of cutRects) rects = subtractRect(rects, cut)
    const out = []
    for (const r of rects) {
      if (!(r.maxX > r.minX) || !(r.maxZ > r.minZ)) continue
      pushTri(out, r.minX, 0, r.minZ, r.maxX, 0, r.minZ, r.maxX, 0, r.maxZ)
      pushTri(out, r.minX, 0, r.minZ, r.maxX, 0, r.maxZ, r.minX, 0, r.maxZ)
    }
    return out
  }

  /** Subtract an axis-aligned cut rect from a list of rects (piecewise). */
  function subtractRect(rects, cut) {
    const out = []
    for (const r of rects) {
      if (cut.maxX <= r.minX || cut.minX >= r.maxX || cut.maxZ <= r.minZ || cut.minZ >= r.maxZ) { out.push(r); continue }
      if (r.minZ < cut.minZ) out.push({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: Math.min(r.maxZ, cut.minZ) })
      if (r.maxZ > cut.maxZ) out.push({ minX: r.minX, maxX: r.maxX, minZ: Math.max(r.minZ, cut.maxZ), maxZ: r.maxZ })
      const z0 = Math.max(r.minZ, cut.minZ), z1 = Math.min(r.maxZ, cut.maxZ)
      if (r.minX < cut.minX) out.push({ minX: r.minX, maxX: Math.min(r.maxX, cut.minX), minZ: z0, maxZ: z1 })
      if (r.maxX > cut.maxX) out.push({ minX: Math.max(r.minX, cut.maxX), maxX: r.maxX, minZ: z0, maxZ: z1 })
    }
    return out
  }

  /** STEP 4A TILED BAKE — the custom pipeline over ONE tile's rect. The exact
   *  stages the former solo bake ran, with the SAME pinned constants (ch
   *  0.05, maxSimplificationError 0.6, erosion = radius exactly, per-class
   *  csEff, region/contour/poly limits, flagMerge, detail sampling) — only
   *  the input bounds and triangle set differ (the triangles intersecting
   *  this tile's expanded rect). Returns the per-tile Detour NavMesh data,
   *  the per-poly slope annotations and the per-tile walkable-span truth
   *  (merged scene-wide by bakeClass). */
  function bakeTileNavMeshData({ cls, cfg, flagMerge, border, bmin, bmax, positions, indices, offMeshConnections, bounds, geom, csEff, tileX, tileY }) {
    const grid = recast.calcGridSize(bmin, bmax, cfg.cs)
    cfg.width = grid.width
    cfg.height = grid.height
    // SEAM MECHANISM (Recast's own borderSize): the heightfield covers the
    // tile rect EXPANDED by exactly `border` voxels (the caller's tileMargin
    // = border*cs); regions touching the border band become RC_BORDER_REG
    // regions, buildPolyMesh drops their contours, and the remaining mesh
    // edges lie EXACTLY on the tile boundary — dtCreateNavMeshData marks
    // them DT_EXT_LINK portal edges and Detour's findConnectingPolys (0.01
    // slab tolerance) connects the tiles. A free-form overlap band can never
    // connect: the two sides' portal edges sit 2·margin apart, far beyond
    // the 0.01 tolerance.
    cfg.borderSize = border

    const ctx = new recast.RecastBuildContext()
    const heightfield = recast.allocHeightfield()
    if (!recast.createHeightfield(ctx, heightfield, cfg.width, cfg.height, bmin, bmax, cfg.cs, cfg.ch)) {
      throw new Error('navmesh bake failed: createHeightfield')
    }

    const numVerts = positions.length / 3
    const numTris = indices.length / 3
    const vertsArr = new recast.VerticesArray(); vertsArr.resize(positions.length)
    for (let i = 0; i < positions.length; i++) vertsArr.set(i, positions[i])
    const trisArr = new recast.TrianglesArray(); trisArr.resize(indices.length)
    for (let i = 0; i < indices.length; i++) trisArr.set(i, indices[i])
    const areasArr = new recast.TriangleAreasArray(); areasArr.resize(numTris)
    // Source-surface triangles for the D-9 slope annotation (with their
    // measured slopes) — the same geometry fed to the rasterizer.
    const sourceTris = []
    for (let i = 0; i < indices.length; i += 3) {
      const ia = indices[i]
      const ib = indices[i + 1]
      const ic = indices[i + 2]
      const t = {
        ax: positions[ia * 3], ay: positions[ia * 3 + 1], az: positions[ia * 3 + 2],
        bx: positions[ib * 3], by: positions[ib * 3 + 1], bz: positions[ib * 3 + 2],
        cx: positions[ic * 3], cy: positions[ic * 3 + 1], cz: positions[ic * 3 + 2],
      }
      const ux = t.bx - t.ax, uy = t.by - t.ay, uz = t.bz - t.az
      const wx = t.cx - t.ax, wy = t.cy - t.ay, wz = t.cz - t.az
      const ny = uz * wx - ux * wz
      const len = Math.hypot(uy * wz - uz * wy, ny, ux * wy - uy * wx)
      t.slopeDeg = len > 0 ? Math.acos(Math.min(1, Math.abs(ny) / len)) * 180 / Math.PI : 0
      sourceTris.push(t)
    }
    recast.markWalkableTriangles(ctx, cfg.walkableSlopeAngle, vertsArr, numVerts, trisArr, numTris, areasArr)
    // D-9 slope annotations: carry each source triangle's SLOPE BUCKET as its
    // rasterized AREA so the region builder keeps separate surface patches as
    // separate polys — a poly's polySlopes then measures ONE patch (flat yard
    // and steep face never share a poly; without this the class bake's merged
    // regions poison flat corridors with the face's slope and the maxSlope
    // gate over-blocks). Area 0 stays RC_NULL_AREA; classifyPolys rewrites the
    // poly-mesh areas afterwards (the cost model is unchanged).
    for (let i = 0; i < numTris; i++) {
      if (areasArr.get(i)) {
        // INVERTED bucket id: the rasterizer's span merge (flagMerge) keeps the
        // MAX area id on collision, so flat (the highest id here) must win —
        // otherwise every sub-0.1 micro-bump poisons its whole cell with a
        // steep bucket and fragments the flat region (the a30-skirt leak).
        areasArr.set(i, 1 + (SLOPE_AREA_COUNT - 1 - slopeAreaId(sourceTris[i].slopeDeg)))
      }
    }
    if (!recast.rasterizeTriangles(ctx, vertsArr, numVerts, trisArr, areasArr, numTris, heightfield, flagMerge)) {
      throw new Error('navmesh bake failed: rasterizeTriangles')
    }
    areasArr.destroy(); vertsArr.destroy(); trisArr.destroy()
    recast.filterLowHangingWalkableObstacles(ctx, cfg.walkableClimb, heightfield)
    recast.filterLedgeSpans(ctx, cfg.walkableHeight, cfg.walkableClimb, heightfield)
    recast.filterWalkableLowHeightSpans(ctx, cfg.walkableHeight, heightfield)

    // FINDING 2 + the contract's blocked COLUMN: no walkable span anywhere
    // over a `nav-obstacle` footprint (any height, any profile, any bake
    // resolution) — the rasterized grid blocked the whole cell column.
    nullSpansOverCarve(heightfield, geom.carve, bmin, cfg)

    const compactHeightfield = recast.allocCompactHeightfield()
    if (!recast.buildCompactHeightfield(ctx, cfg.walkableHeight, cfg.walkableClimb, heightfield, compactHeightfield)) {
      throw new Error('navmesh bake failed: buildCompactHeightfield')
    }
    // WALKABLE-SPAN TRUTH (viz export): capture the compact heightfield's
    // walkable span tops PER COLUMN right after buildCompactHeightfield (the
    // heightfield's own walkableHeight filter has already nulled every
    // no-headroom span, and erosion has NOT yet trimmed agent-radius margins).
    // This is the bake's ground truth for which columns hold a walkable
    // surface at which Y — the viz export keeps a source face only where the
    // bake kept a walkable span at the face's plane Y in the face's centroid
    // column, so faces the bake dropped (e.g. a no-headroom cave floor) never
    // re-materialize in the export.
    const walkTruth = captureWalkableSpanTops(compactHeightfield)
    if (!recast.erodeWalkableArea(ctx, cfg.walkableRadius, compactHeightfield)) {
      throw new Error('navmesh bake failed: erodeWalkableArea')
    }
    if (!recast.buildDistanceField(ctx, compactHeightfield)) {
      throw new Error('navmesh bake failed: buildDistanceField')
    }
    if (!recast.buildRegions(ctx, compactHeightfield, cfg.borderSize, cfg.minRegionArea, cfg.mergeRegionArea)) {
      throw new Error('navmesh bake failed: buildRegions')
    }
    const contourSet = recast.allocContourSet()
    if (!recast.buildContours(ctx, compactHeightfield, cfg.maxSimplificationError, cfg.maxEdgeLen, contourSet, recast.Recast.RC_CONTOUR_TESS_WALL_EDGES)) {
      throw new Error('navmesh bake failed: buildContours')
    }
    const pm = recast.allocPolyMesh()
    if (!recast.buildPolyMesh(ctx, contourSet, cfg.maxVertsPerPoly, pm)) {
      throw new Error('navmesh bake failed: buildPolyMesh')
    }
    // EMPTY TILE: erosion can clear a sliver tile's interior entirely (edge
    // tiles narrower than the erosion radius) — that tile contributes no
    // Detour data and is skipped by the caller (its grid slot stays unused),
    // exactly like a tile with no triangles. dtCreateNavMeshData itself
    // returns failure for zero-polys/zero-connections input.
    if (pm.npolys() === 0 && offMeshConnections.length === 0) {
      recast.freeContourSet(contourSet); recast.freeCompactHeightfield(compactHeightfield)
      recast.freePolyMesh(pm); recast.freeHeightfield(heightfield)
      return null
    }
    const pmd = recast.allocPolyMeshDetail()
    if (!recast.buildPolyMeshDetail(ctx, pm, compactHeightfield, cfg.detailSampleDist, cfg.detailSampleMaxError, pmd)) {
      throw new Error('navmesh bake failed: buildPolyMeshDetail')
    }
    const ann = classifyPolys(pm, pmd, sourceTris, geom.carve, bounds)
    const params = new recast.NavMeshCreateParams()
    params.setPolyMeshCreateParams(pm)
    params.setPolyMeshDetailCreateParams(pmd)
    params.setTileX(tileX)
    params.setTileY(tileY)
    params.setTileLayer(0)
    params.setWalkableHeight(cls.height)
    params.setWalkableRadius(cls.radius)
    params.setWalkableClimb(cls.height)
    params.setCellSize(csEff)
    params.setCellHeight(CELL.height)
    params.setBuildBvTree(true)
    if (offMeshConnections.length) params.setOffMeshConnections(offMeshConnections)
    const data = recast.createNavMeshData(params)
    // The Recast intermediates are consumed — return the wasm heap.
    recast.freePolyMeshDetail(pmd); recast.freePolyMesh(pm)
    recast.freeContourSet(contourSet); recast.freeCompactHeightfield(compactHeightfield)
    recast.freeHeightfield(heightfield)
    if (!data || !data.success) {
      throw new Error('navmesh bake failed: createNavMeshData')
    }
    return { navMeshData: data.navMeshData, ann, walkTruth }
  }

  /** STEP 4B CLASS SETUP — the per-class part of the bake (shared by the full
   *  bake and the dirty-tile re-bake): geometry collection, declared links,
   *  the Recast config, raster bounds and the tile grid. Everything ONE
   *  tile's bake needs rides the returned setup object. Throws when the
   *  scene has no bake geometry (same message the solo-era bake threw). */
  function classSetup(cls) {
    const geom = geometry()
    const bounds = boundsGetter() ?? derivedBounds()
    const terrainRects = geom.terrains.map((t) => terrainFootprintXZ(t))
    const planeTris = implicitGroundTris(bounds, terrainRects, cls.radius + CELL.size)
    if (geom.positions.length === 0 && planeTris.length === 0) {
      throw new Error('navmesh bake: no bake geometry (no terrain, nav-surface or nav-obstacle colliders)')
    }
    const positions = geom.positions.slice()
    const indices = geom.indices.slice()
    const geomIndexCount = indices.length // the plane tris appended below are NOT source-geometry selection candidates
    let base = positions.length / 3
    for (const t of planeTris) {
      positions.push(t.ax, t.ay, t.az, t.bx, t.by, t.bz, t.cx, t.cy, t.cz)
      indices.push(base, base + 1, base + 2)
      base += 3
    }

    // D-9 (c): links bake UNFILTERED — jumpHeight gates PER QUERY (the link
    // poly's Detour flags are rewritten from linkTraversable before every
    // query), so an ability edit re-routes with zero re-bake.
    const offMeshConnections = []
    const bakedLinks = [] // W6b viz seam: draped endpoints of the BAKED links
    const linkAreas = [] // parallel to offMeshConnections: { areaId, unitCost }
    const linkHeights = [] // |Δh| per baked link — the per-query jump gate
    let li = 0
    for (const l of links) {
      const yFrom = groundY(l.from.x, l.from.z)
      const yTo = groundY(l.to.x, l.to.z)
      // W6b: the link's DRAPED endpoints ride the meshGeometry `links` seam
      // (world Y from the bake — the viz draws them on the surface).
      bakedLinks.push({
        from: { x: l.from.x, y: yFrom, z: l.from.z },
        to: { x: l.to.x, y: yTo, z: l.to.z },
        cost: l.cost,
        oneWay: l.oneWay,
      })
      const areaId = li < (LINK_AREA_MAX - LINK_AREA_BASE + 1) ? LINK_AREA_BASE + li : LINK_AREA_MAX
      const len3d = Math.max(1e-4, Math.hypot(l.to.x - l.from.x, yTo - yFrom, l.to.z - l.from.z))
      offMeshConnections.push({
        startPosition: { x: l.from.x, y: yFrom, z: l.from.z },
        endPosition: { x: l.to.x, y: yTo, z: l.to.z },
        radius: Math.max(cls.radius, 0.3),
        bidirectional: !l.oneWay,
        area: areaId,
        flags: 1,
        userId: li,
      })
      // cost model (W6a2 finding 3): unit cost per 3D length — multiplied by
      // the per-query cost scale in filterFor (the cost scale is ability-
      // dependent; the class bake is not).
      linkAreas.push({ areaId, unitCost: l.cost / len3d })
      linkHeights.push(Math.abs(yFrom - yTo))
      li++
    }

    const csEff = classSafeCellSize(cls, CELL.size)
    // Phase 1 pivot (AAA BAKED CLIMB): walkableClimb = the class's
    // stepHeight (bounded by its height — a body cannot step higher than
    // itself). walkableClimb is ALSO rasterizeTriangles'
    // flagMergeThreshold — spans within the climb merge into one surface —
    // so it can never be the permissive 1e4 (that would flatten every
    // obstacle into a walkable ramp). Carved (nav-obstacle) geometry is never
    // rasterized (nullSpansOverCarve) so no ramp can form over a blocker.
    // AAA BAKED CLIMB (Phase 1 pivot): cfg.walkableClimb = the class's
    // stepHeight (BAKE climb — Recast's walkableClimb: "allows the mesh to
    // flow over ... up/down stairways"; steps ≤ climb merge into the walkable
    // surface at bake, ledges > climb are dropped by rcFilterLedgeSpans).
    // Bounded by the class height: a body cannot step higher than itself (the
    // D-9 loose-climb bound, now the hard ceiling of the baked climb).
    // Quantization floor (like flagMerge below): a zero climb would break
    // compact-span connectivity even on FLAT ground (voxel floors quantize to
    // ±1 voxel); floor at 1 voxel (0.05 world at the tuned ch) — a pure
    // quantization tolerance, not a step grant ("stepHeight 0 agents can only
    // traverse flat ground" holds).
    const climbWorld = Math.max(Math.min(cls.stepHeight, cls.height), CELL.height)
    const climbVoxels = climbWorld / CELL.height
    // The rasterizer's flag-merge threshold is what gives a span thickness:
    // at exactly 0 a flat surface on a voxel y-boundary rasterizes [n, n] and
    // the bake comes out empty. Floor at 1 voxel (0.05 world at the tuned ch —
    // below the old grid's own 0.1 ch quantization: sub-0.1 steps were
    // invisible there too).
    // Phase 1 pivot: it tracks the BAKED climb (stepHeight) — steps ≤
    // stepHeight merge into ONE walkable surface at bake (the AAA stairs
    // flow); the annotations measure the source triangles and are
    // merge-independent.
    const flagMerge = Math.max(1, Math.round(climbVoxels))
    // EROSION POLICY PIN (human directive, verbatim: 'Keep erosion = agent
    // radius. Don't fight that; it is the correct clearance.') — the erosion
    // distance the bake ASKS for is the agent radius EXACTLY (world units; no
    // corner factor, no safety inflation). Asserted at this choke point so the
    // policy cannot drift silently (pinned in
    // engine/test/navmesh-bake-config.test.js). Recast keeps its own INTEGER-
    // voxel quantization of the ask (walkableRadius is an int field — 5.6
    // voxels truncate to 5): that quantization is the documented implementation
    // detail; the POLICY is the un-inflated ask.
    const erosionRadius = erosionRadiusVoxels(cls.radius, csEff)
    const erosionWorld = erosionRadius * csEff
    if (!(Math.abs(erosionWorld - cls.radius) <= 1e-6 * Math.max(1, cls.radius))) {
      throw new Error(`navmesh bake: erosion ${erosionWorld} drifted from the agent radius ${cls.radius} (policy pin: erosion = agent radius)`)
    }
    const cfg = recast.createRcConfig({
      cs: csEff,
      ch: CELL.height,
      // recast-navigation's RecastConfig is RAW Recast units: agent dims are
      // VOXELS (the package multiplies by cs/ch on the way out — e.g.
      // setWalkableClimb(walkableClimb * ch)). World-unit profile → voxels.
      walkableRadius: erosionRadius, // erosion = agent radius EXACTLY (policy pin above)
      walkableHeight: cls.height / CELL.height,
      walkableClimb: climbWorld / CELL.height,
      // AAA BAKED SLOPE (Phase 1 pivot): cfg.walkableSlopeAngle = the class's
      // maxSlope — steep surfaces DROP at bake (rcMarkWalkableTriangles), the
      // mesh contains no surface this class cannot walk. The D-9 loose bake
      // (LOOSE_BAKE_SLOPE_DEG + per-query slope mask) is RETIRED.
      walkableSlopeAngle: Math.max(cls.maxSlope, 0.5),
      maxEdgeLen: 12,
      maxSimplificationError: BAKE_MAX_SIMPLIFICATION_ERROR,
      minRegionArea: 2,
      mergeRegionArea: 8,
      maxVertsPerPoly: 6,
      // P2.6 surface fidelity: detail-mesh candidate grid (cs units, scaled to
      // world below). RE-PIN NOTE (2026-10-01): tuning this finer (1) was
      // REJECTED — the denser detail changes the baked query Y/annotations and
      // broke 12 pinned behaviors (slope gates, link Δh gates, the a/b/c
      // verdict matrix). Fidelity instead comes from the EXPORT-side terrain
      // refinement in meshGeometry (viz-only). maxError stays tight at ch*1.
      detailSampleDist: 6,
      detailSampleMaxError: 1,
      buildBvTree: true,
    })
    cfg.minRegionArea = cfg.minRegionArea * cfg.minRegionArea
    cfg.mergeRegionArea = cfg.mergeRegionArea * cfg.mergeRegionArea
    cfg.detailSampleDist = cfg.detailSampleDist < 0.9 ? 0 : cfg.cs * cfg.detailSampleDist
    cfg.detailSampleMaxError = cfg.ch * cfg.detailSampleMaxError

    // EROSION POLICY PIN, read-back: Recast truncates walkableRadius to an
    // integer voxel count — the drift from the exact ask must stay WITHIN ONE
    // VOXEL (quantization only; an inflated ask — corner factor or safety
    // margin — would exceed it and throw).
    if (!(Math.abs(cfg.walkableRadius - erosionRadius) < 1)) {
      throw new Error(`navmesh bake: configured erosion ${cfg.walkableRadius} voxels drifted from the ask ${erosionRadius} (policy pin: erosion = agent radius)`)
    }

    // Bounds: geometry+plane bbox with a ±2·ch y margin — a surface lying
    // exactly at bmax.y rasterizes to a zero-height span and is dropped
    // (the y-range bug class that made the hill peak vanish).
    let bmin = [Infinity, Infinity, Infinity]
    let bmax = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = positions[i + k]
        if (v < bmin[k]) bmin[k] = v
        if (v > bmax[k]) bmax[k] = v
      }
    }
    if (!Number.isFinite(bmin[0])) { bmin = [0, -1, 0]; bmax = [1, 1, 1] }
    bmin = [bmin[0], bmin[1] - 2 * cfg.ch, bmin[2]]
    bmax = [bmax[0], bmax[1] + 2 * cfg.ch, bmax[2]]

    // STEP 4A TILED BAKE: the scene's XZ bounds divide into a square tile
    // grid (BAKE_TILE_SIZE world units per side) anchored at the FULL raster
    // origin; the pipeline runs PER TILE over the source triangles whose XZ
    // bbox intersects the tile rect EXPANDED by exactly `border` voxels —
    // Recast's cfg.borderSize seam mechanism (see bakeTileNavMeshData): the
    // border band keeps erosion identical to the global bake AND is clipped
    // out of the poly mesh, leaving portal edges exactly on the tile
    // boundary for Detour's external tile links. Empty tiles are skipped
    // (their Detour slots stay unused). Tiles are addressable by their grid
    // index (the Detour header's tileX/tileY) — the Step 4b dirty-tile
    // rebuild hook.
    const borderVoxels = Math.ceil((cls.radius + climbWorld) / csEff)
    const tileMargin = borderVoxels * csEff
    // SEAM-EXACT TILE SIZE: the tile size is ROUNDED to whole class voxels.
    // The interior portal edges a tile emits are voxel-quantized (Recast
    // contours live on the tile raster's own lattice, anchored at the tile's
    // expanded bmin): an interior edge lands EXACTLY on a shared boundary
    // only when the boundary is a lattice point of BOTH adjacent rasters —
    // i.e. the boundary offset from the raster origin is border voxels on
    // the min side (exact by construction) and (2*border + tileVoxels)
    // voxels on the max side, which requires the tile span to be a whole
    // voxel count. A raw 12-world-unit span at a per-class cs (e.g. the
    // 60°-slope class's csEff 0.14355: 14.0097 world span / cs = 97.58
    // voxels) is NOT: ceil() stretches the raster, the max-side border band
    // then starts ceil-slack voxels PAST the true boundary, the last
    // interior edge overshoots the boundary by up to 1 voxel (measured 0.058
    // on the stairs fixture's 56.3° flank — beyond Detour's 0.01 portal slab
    // tolerance, the two sides never ext-link, and the seam is a silent
    // wall). Rounding BAKE_TILE_SIZE to tileVoxels = round(12 / csEff) voxels
    // makes every interior boundary a lattice point of both sides → slack 0,
    // portal verts coincide exactly. Per-class tileW (≈12, within 1 voxel) is
    // safe: the Detour params grid (orig + tileWidth below) uses the SAME
    // per-class tileW, so calcTileLoc stays consistent.
    const tileVoxels = Math.max(1, Math.round(BAKE_TILE_SIZE / csEff))
    const tileW = tileVoxels * csEff
    const tileCountX = Math.max(1, Math.ceil((bmax[0] - bmin[0]) / tileW))
    const tileCountZ = Math.max(1, Math.ceil((bmax[2] - bmin[2]) / tileW))
    // Each baked link's off-mesh poly lives in exactly ONE tile (the tile its
    // start point maps to) — a link must not duplicate across tiles.
    const linksByTile = new Map()
    for (const oc of offMeshConnections) {
      const tx = Math.min(tileCountX - 1, Math.max(0, Math.floor((oc.startPosition.x - bmin[0]) / tileW)))
      const tz = Math.min(tileCountZ - 1, Math.max(0, Math.floor((oc.startPosition.z - bmin[2]) / tileW)))
      const k = `${tx}|${tz}`
      if (!linksByTile.has(k)) linksByTile.set(k, [])
      linksByTile.get(k).push(oc)
    }
    return {
      cls: { radius: cls.radius, height: cls.height, maxSlope: cls.maxSlope, stepHeight: cls.stepHeight },
      geom, bounds, planeTris,
      positions, indices, geomIndexCount,
      offMeshConnections, bakedLinks, linkAreas, linkHeights,
      csEff, climbWorld, flagMerge, cfg,
      bmin, bmax, borderVoxels, tileMargin, tileVoxels, tileW, tileCountX, tileCountZ,
      linksByTile,
    }
  }

  /** STEP 4B — bake ONE tile of a class setup (the per-tile pipeline, the
   *  exact body of the Step 4a loop): returns { navMeshData, ann, walkTruth }
   *  or null for an empty tile (its Detour slot stays unused). */
  function bakeTileAt(s, tx, tz) {
    const { positions, indices, geomIndexCount, planeTris, bmin, bmax, tileMargin, tileW, cls, cfg, flagMerge, borderVoxels, bounds, geom, csEff, linksByTile } = s
    const x0 = bmin[0] + tx * tileW
    const x1 = Math.min(bmax[0], bmin[0] + (tx + 1) * tileW)
    const z0 = bmin[2] + tz * tileW
    const z1 = Math.min(bmax[2], bmin[2] + (tz + 1) * tileW)
    const tx0 = x0 - tileMargin
    const tx1 = x1 + tileMargin
    const tz0 = z0 - tileMargin
    const tz1 = z1 + tileMargin
    // Per-tile triangle set: source-geometry tris whose XZ bbox overlaps
    // the expanded rect + the implicit plane clipped to it (the plane's
    // own rects are axis-aligned, so a clip is exact).
    const tPos = []
    const tIdx = []
    let tb = 0
    for (let i = 0; i < geomIndexCount; i += 3) {
      const ia = indices[i] * 3
      const ib = indices[i + 1] * 3
      const ic = indices[i + 2] * 3
      const triMinX = Math.min(positions[ia], positions[ib], positions[ic])
      const triMaxX = Math.max(positions[ia], positions[ib], positions[ic])
      const triMinZ = Math.min(positions[ia + 2], positions[ib + 2], positions[ic + 2])
      const triMaxZ = Math.max(positions[ia + 2], positions[ib + 2], positions[ic + 2])
      if (triMaxX <= tx0 || triMinX >= tx1 || triMaxZ <= tz0 || triMinZ >= tz1) continue
      tPos.push(positions[ia], positions[ia + 1], positions[ia + 2], positions[ib], positions[ib + 1], positions[ib + 2], positions[ic], positions[ic + 1], positions[ic + 2])
      tIdx.push(tb, tb + 1, tb + 2)
      tb += 3
    }
    for (const t of planeTris) {
      // The plane tri's b/c corners may be SWAPPED by orientUp — clip by
      // the triangle's XZ bbox, not by assumed corner roles.
      const pMinX = Math.min(t.ax, t.bx, t.cx)
      const pMaxX = Math.max(t.ax, t.bx, t.cx)
      const pMinZ = Math.min(t.az, t.bz, t.cz)
      const pMaxZ = Math.max(t.az, t.bz, t.cz)
      const cMinX = Math.max(pMinX, tx0)
      const cMaxX = Math.min(pMaxX, tx1)
      const cMinZ = Math.max(pMinZ, tz0)
      const cMaxZ = Math.min(pMaxZ, tz1)
      if (!(cMaxX > cMinX) || !(cMaxZ > cMinZ)) continue
      // Y-UP WINDING: these quads are pushed in Recast's ny>0 (CCW seen
      // from +Y) order — markWalkableTriangles drops down-facing tris, so
      // a down-facing ground quad erases the tile's only walkable surface
      // (the flat-grounds-tile-empty failure).
      tPos.push(cMinX, 0, cMinZ, cMinX, 0, cMaxZ, cMaxX, 0, cMinZ)
      tIdx.push(tb, tb + 1, tb + 2)
      tb += 3
      tPos.push(cMaxX, 0, cMinZ, cMinX, 0, cMaxZ, cMaxX, 0, cMaxZ)
      tIdx.push(tb, tb + 1, tb + 2)
      tb += 3
    }
    if (tIdx.length === 0) return null
    // Tile bounds: the EXPANDED RECT exactly (the generator's rule —
    // tileConfig.bmin = tile.bmin - borderSize*cs). The triangle-bbox
    // bounds the earlier draft used made the border band ragged per tile:
    // the interior region then runs past the shared boundary and contour
    // simplification displaces the portal verts by up to
    // maxSimplificationError in DIFFERENT directions on the two sides
    // (zero displacement on flat edges, real displacement on terrain
    // edges — the terrain-tile ext-link failure). With exact expanded
    // bounds the interior edge lands EXACTLY on the tile boundary and the
    // two sides emit identical verts there.
    const tbmin = [x0 - tileMargin, bmin[1], z0 - tileMargin]
    const tbmax = [x1 + tileMargin, bmax[1], z1 + tileMargin]
    return bakeTileNavMeshData({
      cls, cfg, flagMerge, border: borderVoxels,
      bmin: tbmin, bmax: tbmax,
      positions: tPos, indices: tIdx,
      offMeshConnections: linksByTile.get(`${tx}|${tz}`) || [],
      bounds, geom, csEff, tileX: tx, tileY: tz,
    })
  }

  /** STEP 4B — merge the per-tile walkable-span truths into ONE scene-wide
   *  truth grid (the exact remap the Step 4a loop ran, now usable by the
   *  dirty re-bake: re-merge from ALL stored per-tile truths instead of
   *  deleting columns, so neighbor border-band contributions survive). */
  function mergeTruth(s, tileMeta) {
    const truth = {
      width: Math.ceil((s.bmax[0] - s.bmin[0]) / s.cfg.cs) + 1,
      height: Math.ceil((s.bmax[2] - s.bmin[2]) / s.cfg.cs) + 1,
      bminX: s.bmin[0], bminZ: s.bmin[2], cs: s.cfg.cs, ch: s.cfg.ch,
      tops: new Map(),
    }
    for (const m of tileMeta.values()) {
      const t = m.walkTruth
      for (const [key, list] of t.tops.entries()) {
        const lgx = key % t.width
        const lgz = (key - lgx) / t.width
        const gx = Math.round((t.bminX + lgx * t.cs - truth.bminX) / truth.cs)
        const gz = Math.round((t.bminZ + lgz * t.cs - truth.bminZ) / truth.cs)
        if (gx < 0 || gx >= truth.width || gz < 0 || gz >= truth.height) continue
        const gk = gz * truth.width + gx
        const cur = truth.tops.get(gk)
        if (cur) { for (const y of list) cur.push(y); cur.sort((a, b) => a - b) }
        else truth.tops.set(gk, list.slice().sort((a, b) => a - b))
      }
    }
    return truth
  }

  /** STEP 4B — (re)derive the entry's per-poly annotation seam from TILE
   *  IDENTITY: the concatenated annotation arrays are rebuilt from the
   *  per-tile ann maps (keyed by the Detour header's tileX|tileY, never the
   *  tile SLOT), in slot order, together with polyRefs/linkRefs/polyIndexOf —
   *  so removeTile+addTile slot reuse can never desync the positional
   *  pairing. applyQueryFlags and meshGeometry resolve every poly's
   *  annotation through polyIndexOf (poly ref → annotation index) — the
   *  identity-safe seam. */
  function finalizeEntry(entry) {
    const navMesh = entry.navMesh
    const annByTile = new Map()
    for (const [k, m] of entry.tileMeta) annByTile.set(k, m.ann)
    const annSlopes = []
    const annYMin = []
    const annYMax = []
    const annDisabled = []
    const polyRefs = []
    const linkRefs = []
    const tilePolyRefs = new Map()
    const maxTiles = typeof navMesh.getMaxTiles === 'function' ? navMesh.getMaxTiles() : 0
    for (let ti = 0; ti < maxTiles; ti++) {
      const tile = navMesh.getTile(ti)
      const header = tile && typeof tile.header === 'function' ? tile.header() : null
      if (!header) continue
      const a = annByTile.get(`${header.x()}|${header.y()}`)
      if (!a) continue // slot without a baked tile (never happens: 1:1)
      const base = typeof navMesh.getPolyRefBase === 'function' ? navMesh.getPolyRefBase(tile) : 0
      const pc = header.polyCount()
      const slotRefs = []
      for (let p = 0; p < pc; p++) {
        const poly = tile.polys(p)
        const ref = base + p
        const isOff = typeof poly.getType === 'function' && poly.getType() === POLYTYPE_OFFMESH
        if (!isOff) { polyRefs.push(ref); slotRefs.push(ref); continue }
        const va = vertOfTile(tile, poly.verts(0))
        const vb = vertOfTile(tile, poly.verts(1))
        let best = -1
        let bestD = Infinity
        for (let i = 0; i < entry.bakedLinks.length; i++) {
          const l = entry.bakedLinks[i]
          const dA = Math.hypot(l.from.x - va.x, l.from.z - va.z) + Math.hypot(l.to.x - vb.x, l.to.z - vb.z)
          const dB = Math.hypot(l.to.x - va.x, l.to.z - va.z) + Math.hypot(l.from.x - vb.x, l.from.z - vb.z)
          const d = Math.min(dA, dB)
          if (d < bestD) { bestD = d; best = i }
        }
        linkRefs.push({ ref, linkIndex: best })
      }
      tilePolyRefs.set(`${header.x()}|${header.y()}`, slotRefs)
      annSlopes.push(a.polySlopes)
      annYMin.push(a.polyYMin)
      annYMax.push(a.polyYMax)
      annDisabled.push(a.polyDisabled)
    }
    const polyTotal = annSlopes.reduce((n, a) => n + a.length, 0)
    if (polyRefs.length !== polyTotal) {
      throw new Error(`navmesh bake failed: poly ref map mismatch (${polyRefs.length} vs ${polyTotal})`)
    }
    const ann = {
      polySlopes: new Float64Array(polyTotal),
      polyYMin: new Float64Array(polyTotal),
      polyYMax: new Float64Array(polyTotal),
      polyDisabled: new Uint8Array(polyTotal),
    }
    for (let k = 0, off = 0; k < annSlopes.length; k++) {
      ann.polySlopes.set(annSlopes[k], off)
      ann.polyYMin.set(annYMin[k], off)
      ann.polyYMax.set(annYMax[k], off)
      ann.polyDisabled.set(annDisabled[k], off)
      off += annSlopes[k].length
    }
    entry.polySlopes = ann.polySlopes
    entry.polyYMin = ann.polyYMin
    entry.polyYMax = ann.polyYMax
    entry.polyDisabled = ann.polyDisabled
    entry.polyRefs = polyRefs
    entry.linkRefs = linkRefs
    entry.polyIndexOf = new Map(polyRefs.map((r, i) => [r, i]))
    entry.tilePolyRefs = tilePolyRefs
  }

  /** Bake one CLEARANCE class (D-9): the custom pipeline runs PER TILE
   *  (Step 4a tiled bake — bakeTileNavMeshData) and the per-tile Detour data
   *  combines into ONE multi-tile NavMesh; queries unchanged. Per-poly AREA
   *  ids (slope buckets + one per link) and per-poly FLAGS (obstacle columns
   *  / out-of-bounds polys disabled) are assigned per tile and concatenated
   *  in tile order — the polyRefs map below iterates the tiles in the same
   *  order. Thresholds do NOT enter the bake (loose slope + class-height
   *  climb). STEP 4B: per-tile ann + walkTruth are KEPT in entry.tileMeta
   *  (keyed 'tx|tz', tile-identity addressable) with a bake version counter,
   *  so a dirty re-bake can re-bake single tiles in place. */
  function bakeClass(cls) {
    const s = classSetup(cls)
    const tileMeta = new Map()
    for (let tz = 0; tz < s.tileCountZ; tz++) {
      for (let tx = 0; tx < s.tileCountX; tx++) {
        const built = bakeTileAt(s, tx, tz)
        if (!built) continue // empty sliver tile — its grid slot stays unused
        tileMeta.set(`${tx}|${tz}`, {
          data: built.navMeshData, ann: built.ann, walkTruth: built.walkTruth,
          version: 1, ref: 0,
        })
      }
    }
    const truth = mergeTruth(s, tileMeta)
    // ONE multi-tile Detour NavMesh (initTiled + addTile): the params' grid
    // (origin/tile size) matches the tile rects exactly, so Detour's tile
    // location math (calcTileLoc → getTilesAt in the queries) is consistent.
    const navMesh = new recast.NavMesh()
    if (!navMesh.initTiled(recast.NavMeshParams.create({
      orig: { x: s.bmin[0], y: s.bmin[1], z: s.bmin[2] },
      tileWidth: s.tileW,
      tileHeight: s.tileW,
      maxTiles: s.tileCountX * s.tileCountZ,
      maxPolys: BAKE_NAVMESH_MAX_POLYS,
    }))) {
      throw new Error('navmesh bake failed: initTiled')
    }
    let addedTiles = 0
    for (const m of tileMeta.values()) {
      const res = navMesh.addTile(m.data, 0, 0)
      if (!(res.status & recast.Detour.DT_SUCCESS)) {
        throw new Error('navmesh bake failed: addTile')
      }
      m.ref = res.tileRef
      addedTiles++
    }
    const polyTotal = [...tileMeta.values()].reduce((n, m) => n + m.ann.polySlopes.length, 0)
    if (addedTiles === 0 && polyTotal === 0) {
      throw new Error('navmesh bake failed: every tile came out empty')
    }
    const surf = sourceSurface()
    const entry = {
      cls: { radius: s.cls.radius, height: s.cls.height, maxSlope: s.cls.maxSlope, stepHeight: s.cls.stepHeight },
      profile: { radius: s.cls.radius, height: s.cls.height },
      // SOURCE-FAITHFUL SURFACE (Phase 2 — the drape REPLACEMENT). The
      // exported surface Y at (x,z) is the source geometry's REAL surface
      // there: the barycentric Y of the source triangle containing the XZ
      // (terrain grid-node triangles = the rendered node surface; primitive
      // faces = their real vertex planes). The raw heightfield span-top
      // `yRaw` only SELECTS which face the span was rasterized from where
      // faces overlap (a box top over terrain); points over no source face
      // (the implicit y=0 ground ring) keep their raw height. ONE shared
      // sampler for every class bake — all class meshes lie on the same
      // surface and differ only in the walkableRadius area trim.
      surfaceY: (x, z, yRaw) => {
        const hit = Number.isFinite(yRaw) ? surf.faceAt(x, z, yRaw) : surf.topAt(x, z)
        return hit ? hit.y : yRaw
      },
      // Plane identities of the source faces under (x,z) matching this
      // vertex's Y (the y selects the face where faces overlap; a vertex on a
      // crease carries BOTH adjacent planes) — the export's face-to-poly
      // selection and any plane-identity consumer key off this.
      surfacePlanes: (x, z, y) => {
        const keys = Number.isFinite(y) ? surf.facesAt(x, z, y) : []
        return keys.length ? keys : ['implicit-ground']
      },
      // The source surface itself, for the export's source-face tessellation.
      surfaceClip: surf,
      navMesh,
      // A* SEARCH-NODE BUDGET scales with the tile count: the default
      // maxNodes 2048 is a solo-bake budget — on a 441-tile (256x256-world)
      // mesh a long diagonal corridor's A* exhausts 2048 nodes and Detour
      // returns a PARTIAL corridor, which findPath discards (null) even
      // though the mesh is fully connected (the nav-perf worst-case). The
      // per-tile poly budget caps every tile at 8192 polys, but corridor
      // length scales with TILES crossed; give the node pool headroom for
      // the full cross-tile search (uint16 node index caps the pool at
      // 65535).
      query: new recast.NavMeshQuery(navMesh, { maxNodes: Math.min(65535, Math.max(2048, s.tileCountX * s.tileCountZ * 64)) }),
      linkCount: s.offMeshConnections.length,
      bakedLinks: s.bakedLinks,
      linkAreas: s.linkAreas,
      linkHeights: s.linkHeights,
      csEff: s.csEff,
      // The scene has authored TERRAIN — the implicit y=0 ground ring beyond
      // the terrain footprints is then compat filler (the contract's implicit
      // ground is sanctioned as viz surface only in obstacle-only worlds, the
      // "historical implicit walkable ground plane" case), not viz truth.
      hasTerrain: s.geom.terrains.length > 0,
      walkTruth: truth,
      tileMeta,
      tileGrid: {
        bmin0: s.bmin[0], bmin2: s.bmin[2], bmax0: s.bmax[0], bmax2: s.bmax[2],
        tileW: s.tileW, tileCountX: s.tileCountX, tileCountZ: s.tileCountZ,
      },
    }
    finalizeEntry(entry)
    return entry
  }

  /** STEP 4B DIRTY-TILE RE-BAKE — re-bake ONLY the tiles whose rect EXPANDED
   *  by the tile margin (border = agent radius + climb voxels: a change
   *  within that margin can move this tile's interior polys via erosion)
   *  intersect the dirty rect. Re-baked tiles are removeTile'd + addTile'd in
   *  place; UNTOUCHED tiles keep their EXACT Detour data (same poly refs —
   *  identity-assertable). Returns false (caller falls back to a full re-bake)
   *  when the re-rasterized tile grid is no longer compatible with the cached
   *  one (bounds/tile-size drift) or a tile bake fails mid-way. */
  function reBakeClassRegion(entry, rect) {
    // The world changed — the geometry cache must NOT serve the stale scene.
    geomCache.value = null
    let s
    try {
      s = classSetup(entry.cls)
    } catch {
      return false
    }
    const g = entry.tileGrid
    if (!g
      || s.tileCountX !== g.tileCountX || s.tileCountZ !== g.tileCountZ
      || Math.abs(s.tileW - g.tileW) > 1e-9
      || Math.abs(s.bmin[0] - g.bmin0) > 1e-9 || Math.abs(s.bmin[2] - g.bmin2) > 1e-9
      || Math.abs(s.bmax[0] - g.bmax0) > 1e-9 || Math.abs(s.bmax[2] - g.bmax2) > 1e-9) {
      return false
    }
    const navMesh = entry.navMesh
    const margin = s.tileMargin
    let touched = false
    for (let tz = 0; tz < s.tileCountZ; tz++) {
      for (let tx = 0; tx < s.tileCountX; tx++) {
        const x0 = s.bmin[0] + tx * s.tileW
        const x1 = Math.min(s.bmax[0], s.bmin[0] + (tx + 1) * s.tileW)
        const z0 = s.bmin[2] + tz * s.tileW
        const z1 = Math.min(s.bmax[2], s.bmin[2] + (tz + 1) * s.tileW)
        if (x1 + margin <= rect.minX || x0 - margin >= rect.maxX || z1 + margin <= rect.minZ || z0 - margin >= rect.maxZ) continue
        touched = true
        const key = `${tx}|${tz}`
        const old = entry.tileMeta.get(key)
        if (old && old.ref && typeof navMesh.removeTile === 'function') navMesh.removeTile(old.ref)
        let built = null
        try {
          built = bakeTileAt(s, tx, tz)
        } catch {
          return false
        }
        if (built) {
          let res
          try {
            res = navMesh.addTile(built.navMeshData, 0, 0)
          } catch {
            return false
          }
          if (!res || !(res.status & recast.Detour.DT_SUCCESS)) return false
          entry.tileMeta.set(key, {
            data: built.navMeshData, ann: built.ann, walkTruth: built.walkTruth,
            version: old ? old.version + 1 : 1, ref: res.tileRef,
          })
        } else if (old) {
          entry.tileMeta.delete(key)
        }
      }
    }
    if (!touched) return true // the rect covers no tile — nothing to re-bake
    entry.walkTruth = mergeTruth(s, entry.tileMeta)
    finalizeEntry(entry)
    entry.meshGeom = null // the viz export must re-extract the changed tiles
    return true
  }

  /** Per-QUERY QueryFilter (Phase 1 pivot — AAA baked abilities): the ONLY
   *  per-query mask left is the jumpHeight link gate (applyQueryFlags); the
   *  ground mask is BAKED (steep drops, steps merge). The SNAP pass walks
   *  everything non-disabled so the query starts/ends on the REQUESTED
   *  surface. Area costs = slope buckets + per-link declared cost (module doc
   *  cost model; the cost scale stays ability-dependent). */
  function filterFor(entry, p, { snap = false } = {}) {
    const f = new recast.QueryFilter()
    try {
      f.includeFlags = snap ? 0xffff : POLY_FLAG_WALKABLE
      f.excludeFlags = 0
    } catch { /* older wrapper */ }
    const scale = costScale(p)
    f.setAreaCost(0, scale)
    for (let k = 0; k < SLOPE_AREA_COUNT; k++) {
      f.setAreaCost(1 + k, slopeAreaCost(scale, (k + 1) * SLOPE_BUCKET_DEG - 1, p.maxSlope))
    }
    for (const la of entry.linkAreas) f.setAreaCost(la.areaId, la.unitCost * scale)
    return f
  }

  /**
   * Phase 1 pivot — the ONLY per-query flag mask left (jumpHeight): link polys
   * are walkable iff linkTraversable(|Δh|, profile); ground polys carry their
   * BAKED flags (finding-2 disabled/obstacle + walkable — steep surfaces and
   * unclimbable ledges never enter the mesh). The D-9 slope flag mask, the
   * corridor OR-gate step rescue and the edge Δh gate (corridorOk/edgeGateOk)
   * are RETIRED — walkableSlopeAngle/walkableClimb bake those verdicts.
   * Queries are synchronous and single-threaded — rewriting the link flags
   * per query is safe.
   */
  function applyQueryFlags(entry, p) {
    for (const [ref, i] of entry.polyIndexOf) {
      entry.navMesh.setPolyFlags(ref, entry.polyDisabled[i] ? POLY_FLAG_DISABLED : POLY_FLAG_WALKABLE)
    }
    for (const lr of entry.linkRefs) {
      const h = lr.linkIndex >= 0 ? entry.linkHeights[lr.linkIndex] : 0
      const ok = linkTraversable(h, p)
      entry.navMesh.setPolyFlags(lr.ref, ok ? POLY_FLAG_WALKABLE : POLY_FLAG_DISABLED)
    }
  }

  /** Segment vs one carve triangle (XZ projection) via the Cyrus-Beck clip:
   *  true when the segment shares any point with the triangle's footprint. */
  function segHitsTri(ax, az, bx, bz, t) {
    const dx = bx - ax
    const dz = bz - az
    const vs = [[t.ax, t.az], [t.bx, t.bz], [t.cx, t.cz]]
    const area2 = (vs[1][0] - vs[0][0]) * (vs[2][1] - vs[0][1]) - (vs[2][0] - vs[0][0]) * (vs[1][1] - vs[0][1])
    if (Math.abs(area2) < 1e-12) return false
    const sgn = area2 > 0 ? 1 : -1
    let t0 = 0
    let t1 = 1
    for (let e = 0; e < 3; e++) {
      const p = vs[e]
      const q = vs[(e + 1) % 3]
      const ex = q[0] - p[0]
      const ez = q[1] - p[1]
      // inward normal (left normal for CCW)
      const nx = -ez * sgn
      const nz = ex * sgn
      const denom = nx * dx + nz * dz
      // num = n·(p − a); with n INWARD, a point of the segment is inside the
      // edge's half-plane iff −num + t·denom ≥ 0. The clip therefore bounds
      // t by num/denom (NOT −num/denom — the sign bug that made this test
      // reject EVERY intersection and silently disabled the corner repair).
      const num = nx * (p[0] - ax) + nz * (p[1] - az)
      if (Math.abs(denom) < 1e-12) {
        if (num > 0) return false // parallel and outside
        continue
      }
      const tHit = num / denom
      if (denom > 0) {
        if (tHit > t0) t0 = tHit
      } else {
        if (tHit < t1) t1 = tHit
      }
      if (t0 > t1) return false
    }
    return true
  }

  /** Output-clearance margin: emitted points/segments stay at least this far
   *  outside every nav-obstacle footprint (the blocked-column pin checks its
   *  points INCLUSIVELY — a waypoint resting exactly ON a footprint edge is
   *  inside the blocked column). */
  const CORNER_EPS = 1e-3
  const CORNER_EPS2 = CORNER_EPS * CORNER_EPS

  /** Squared 2D distance point (x,z) → segment (p→q). */
  function distPointSeg2(x, z, px, pz, qx, qz) {
    const dx = qx - px
    const dz = qz - pz
    const L2 = dx * dx + dz * dz
    if (L2 < 1e-18) return (x - px) * (x - px) + (z - pz) * (z - pz)
    let t = ((x - px) * dx + (z - pz) * dz) / L2
    if (t < 0) t = 0
    else if (t > 1) t = 1
    const ex = x - (px + dx * t)
    const ez = z - (pz + dz * t)
    return ex * ex + ez * ez
  }

  /** Squared 2D distance segment (a→b) ↔ segment (p→q); 0 on intersection. */
  function distSegSeg2(ax, az, bx, bz, px, pz, qx, qz) {
    const d1x = bx - ax, d1z = bz - az
    const d2x = qx - px, d2z = qz - pz
    const den = d1x * d2z - d1z * d2x
    if (Math.abs(den) > 1e-15) {
      const t = ((px - ax) * d2z - (pz - az) * d2x) / den
      const u = ((px - ax) * d1z - (pz - az) * d1x) / den
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0
    }
    return Math.min(
      distPointSeg2(ax, az, px, pz, qx, qz),
      distPointSeg2(bx, bz, px, pz, qx, qz),
      distPointSeg2(px, pz, ax, az, bx, bz),
      distPointSeg2(qx, qz, ax, az, bx, bz),
    )
  }

  /** Segment touches — or grazes within CORNER_EPS of — the tri's XZ
   *  footprint (contact counts as a hit, exactly like the pin's checker). */
  function segNearTri(ax, az, bx, bz, t) {
    if (segHitsTri(ax, az, bx, bz, t)) return true
    return Math.min(
      distSegSeg2(ax, az, bx, bz, t.ax, t.az, t.bx, t.bz),
      distSegSeg2(ax, az, bx, bz, t.bx, t.bz, t.cx, t.cz),
      distSegSeg2(ax, az, bx, bz, t.cx, t.cz, t.ax, t.az),
    ) < CORNER_EPS2
  }

  /** Point stands inside — or within CORNER_EPS of — the tri's XZ footprint. */
  function pointNearTri(x, z, t) {
    if (pointInTriXZ(x, z, t)) return true
    return Math.min(
      distPointSeg2(x, z, t.ax, t.az, t.bx, t.bz),
      distPointSeg2(x, z, t.bx, t.bz, t.cx, t.cz),
      distPointSeg2(x, z, t.cx, t.cz, t.ax, t.az),
    ) < CORNER_EPS2
  }

  /** Unique carve tris the segment can interact with: ≤ 2-unit samples over
   *  the 3×3 hash-cell neighbourhood of each (a thin footprint grazed
   *  between coarse hash cells can never be missed). */
  function carveTrisNear(hash, ax, az, bx, bz) {
    const out = []
    const seen = new Set()
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const x = ax + (bx - ax) * t
      const z = az + (bz - az) * t
      const ci = Math.floor(x / hash.CELLX)
      const cj = Math.floor(z / hash.CELLX)
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (let j = cj - 1; j <= cj + 1; j++) {
          const arr = hash.map.get(`${i}|${j}`)
          if (!arr) continue
          for (const tri of arr) {
            if (seen.has(tri)) continue
            seen.add(tri)
            out.push(tri)
          }
        }
      }
    }
    return out
  }

  /** First carve triangle the segment clips (or grazes within CORNER_EPS). */
  function segmentHitsCarve(hash, ax, az, bx, bz) {
    if (!hash) return null
    for (const tri of carveTrisNear(hash, ax, az, bx, bz)) {
      if (segNearTri(ax, az, bx, bz, tri)) return tri
    }
    return null
  }

  /**
   * CORNER-SAFE output — the SEGMENT-CLEARANCE mechanism (foreman steer
   * 2026-09-29: "patrol-1 ignores all navigation obstacles" — string-pulling
   * corner-cutting; pinned by navmesh-classes.test.js "path SEGMENT clearance"
   * and the (5.5, −4.8) pillar-corner regression):
   *
   *   GUARANTEE — no straight segment between consecutive WALKED path points
   *   touches a `nav-obstacle` footprint, and no emitted point rests inside
   *   one or within CORNER_EPS of its boundary. Off-mesh hop segments are
   *   exempt (a jump may legally cross a footprint) and the requested
   *   endpoints keep their exact world coords.
   *
   * WHY IT IS NEEDED: the corridor is eroded topology (agent-radius
   * clearance) but Detour's contour SIMPLIFICATION lets a poly boundary chord
   * dip into a carved footprint — worse at the D-9 class bake's coarser
   * cellSize (the corner-cutting regression this commit closes: the class
   * clamp bakes cs 0.5 where the per-profile clamp baked 0.25, so the chord
   * may cut up to ~half a cell into a footprint) — so funnel apexes can land
   * inside a footprint and funnel segments can clip corners even though every
   * corridor poly is legal. The funnel output is repaired BEFORE densify
   * (inserted points then ride clear segments):
   *   1. ESCAPE — an apex inside a footprint (or within CORNER_EPS of one)
   *      moves to the nearest clear spot (ring search; link-hop joins keep
   *      their exact coords),
   *   2. CLAMP — every walked segment that still touches a footprint gets a
   *      detour waypoint inserted around the clip: candidates are the hit
   *      triangle's footprint corners pushed outward (8-way) plus
   *      perpendicular offsets of the segment itself (the edge-GRAZE case —
   *      a corner push there slides along the footprint face and re-clips;
   *      the perpendicular leaves the face). A candidate is accepted only
   *      when it is itself clear AND both child segments are clear (the same
   *      segment-clearance rule), so the repair converges to the guarantee
   *      instead of trading one clip for another. Bounded: 24 insertions.
   */
  function cornerSafe(entry, p, raw, hopAfter) {
    const geom = geometry()
    const hash = buildCarveHash(geom.carve)
    if (!hash) return { pts: raw, hops: new Set([...(hopAfter || [])]) }
    const pts = raw.map((q) => ({ ...q }))
    let hops = new Set([...(hopAfter || [])])
    const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]]
    const clearOf = (x, z) => {
      const ci = Math.floor(x / hash.CELLX)
      const cj = Math.floor(z / hash.CELLX)
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (let j = cj - 1; j <= cj + 1; j++) {
          const arr = hash.map.get(`${i}|${j}`)
          if (!arr) continue
          for (const ct of arr) if (pointNearTri(x, z, ct)) return false
        }
      }
      return true
    }
    const segClear = (ax, az, bx, bz) => {
      for (const ct of carveTrisNear(hash, ax, az, bx, bz)) {
        if (segNearTri(ax, az, bx, bz, ct)) return false
      }
      return true
    }
    // PASS 1 — ESCAPE interior/boundary apexes (the requested endpoints and
    // both sides of an off-mesh hop join keep their EXACT coords). The probe
    // steps a little further along the push direction too: a point ON the
    // footprint edge is still within the clearance margin.
    for (let i = 1; i < pts.length - 1; i++) {
      if (hops.has(i) || hops.has(i - 1)) continue
      const q = pts[i]
      if (clearOf(q.x, q.z)) continue
      let moved = null
      for (const d of [0.2, 0.4, 0.65, 1.0, 1.5]) {
        for (const [dx, dz] of DIRS8) {
          const w = { x: q.x + dx * d, z: q.z + dz * d }
          if (clearOf(w.x, w.z) && clearOf(w.x + dx * 0.08, w.z + dz * 0.08)) { moved = w; break }
        }
        if (moved) break
      }
      if (moved) {
        moved.y = surfaceYAt(entry, moved.x, moved.z)
        pts[i] = moved
      }
    }
    // PASS 2 — CLAMP clipping segments around the footprint corner.
    for (let iter = 0; iter < 24; iter++) {
      let repaired = false
      for (let i = 0; i < pts.length - 1; i++) {
        if (hops.has(i)) continue // the link hop may cross a footprint
        const a = pts[i]
        const b = pts[i + 1]
        const tri = segmentHitsCarve(hash, a.x, a.z, b.x, b.z)
        if (!tri) continue
        const mx = (a.x + b.x) / 2
        const mz = (a.z + b.z) / 2
        const push = Math.max(p.radius, 0.3) + 0.15 + iter * 0.05
        const cands = []
        for (const v of [[tri.ax, tri.az], [tri.bx, tri.bz], [tri.cx, tri.cz]]) {
          for (const [dx, dz] of DIRS8) cands.push({ x: v[0] + dx * push, z: v[1] + dz * push, dx, dz })
        }
        const sx = b.x - a.x, sz = b.z - a.z
        const sl = Math.hypot(sx, sz) || 1
        for (const s of [1, -1]) {
          const nx = (-sz / sl) * s, nz = (sx / sl) * s
          for (const [ox, oz] of [[mx, mz], [a.x, a.z], [b.x, b.z]]) {
            cands.push({ x: ox + nx * push, z: oz + nz * push, dx: nx, dz: nz })
          }
        }
        // FIRST the fully verified detour (min extra length), else the clear
        // candidate with the fewest remaining child clips (later iterations
        // clean those up — bounded above).
        let best = null
        let fallback = null
        for (const c of cands) {
          if (!clearOf(c.x, c.z) || !clearOf(c.x + c.dx * 0.08, c.z + c.dz * 0.08)) continue
          const hits = (segClear(a.x, a.z, c.x, c.z) ? 0 : 1) + (segClear(c.x, c.z, b.x, b.z) ? 0 : 1)
          const d = Math.hypot(c.x - mx, c.z - mz)
          if (hits === 0 && (!best || d < best.d)) best = { d, c }
          if (!fallback || hits < fallback.hits || (hits === fallback.hits && d < fallback.d)) fallback = { hits, d, c }
        }
        const pick = best || fallback
        if (!pick) continue
        const w = { x: pick.c.x, z: pick.c.z }
        w.y = surfaceYAt(entry, w.x, w.z)
        pts.splice(i + 1, 0, w)
        hops = new Set([...hops].map((j) => (j > i ? j + 1 : j)))
        repaired = true
        break
      }
      if (!repaired) break
    }
    return { pts, hops }
  }

  /**
   * Per-poly AREA + FLAGS assignment (W6a2 findings 2 and 3 + the cost model)
   * AND the D-9 slope annotations: slope from the detail-mesh triangles
   * (area-weighted → the bucketed cost model; MAX → the polySlopes
   * annotation), polys over a `nav-obstacle` footprint or outside the resolved
   * nav bounds disabled (finding 2 + the contract's blocked-column semantics:
   * NO walkable surface above, on, or below a nav-obstacle — at any class, any
   * bake resolution), area ids 0 = flat / 1..8 slope buckets / 9.. reserved
   * for links (assigned at bake). Returns { polySlopes (max detail-triangle
   * slope in DEGREES), polyYMin, polyYMax (the poly's height span — the D-9
   * edge-gate Δh source), polyDisabled } indexed by pm poly order == the
   * solo-tile ground poly order (meshGeometry's `indices` fan order).
   */
  function classifyPolys(pm, pmd, sourceTris, carveTris, bounds) {
    const nPolys = pm.npolys()
    const hash = buildCarveHash(carveTris)
    const polySlopes = new Float64Array(nPolys)
    const polyYMin = new Float64Array(nPolys)
    const polyYMax = new Float64Array(nPolys)
    const polyDisabled = new Uint8Array(nPolys)
    // D-9 slope annotation: the MAX slope of the SOURCE surface triangles (the
    // bake geometry — the same triangles fed to the rasterizer) under the poly.
    // The raw detail-triangle max is NOT the surface's slope: the detail mesh
    // smooths a step into a shallow ramp (measured 22.3° for the 0.8/1u ledge
    // face's true 38.7°) and would smuggle steps past the maxSlope gate — the
    // historical grid sampled the terrain gradient, i.e. the SOURCE surface.
    // Coverage is bidirectional (detail samples → source tris; source-tri
    // centroids → their poly) so no source patch is missed.
    const srcHash = buildCarveHash(sourceTris)
    const polyDetailXZ = [] // per poly: detail sample points (verts + centroids)
    const polyDetailTris = [] // per poly: detail tris' XZ (containment tests)
    for (let p = 0; p < nPolys; p++) {
      // Detail triangles of this poly: slope + centroid classification.
      const meshBase = p * 4
      const vertBase = pmd.meshes(meshBase)
      const vertCount = pmd.meshes(meshBase + 1)
      const triBase = pmd.meshes(meshBase + 2)
      const triCount = pmd.meshes(meshBase + 3)
      let areaSum = 0
      let slopeSum = 0
      let slopeMax = 0
      let yMin = Infinity
      let yMax = -Infinity
      let overObstacle = 0
      let outside = 0
      const samples = []
      const detailTris = []
      for (let t = 0; t < triCount; t++) {
        const ti = (triBase + t) * 4
        const a = pmd.tris(ti), b = pmd.tris(ti + 1), c = pmd.tris(ti + 2)
        const va = vert3(pmd, vertBase + a), vb = vert3(pmd, vertBase + b), vc = vert3(pmd, vertBase + c)
        const ux = vb.x - va.x, uy = vb.y - va.y, uz = vb.z - va.z
        const wx = vc.x - va.x, wy = vc.y - va.y, wz = vc.z - va.z
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
        const len = Math.hypot(nx, ny, nz)
        if (!(len > 0)) continue
        const angle = Math.acos(Math.min(1, Math.abs(ny) / len)) * 180 / Math.PI
        areaSum += len / 2
        slopeSum += angle * (len / 2)
        if (angle > slopeMax) slopeMax = angle
        for (const v of [va, vb, vc]) {
          if (v.y < yMin) yMin = v.y
          if (v.y > yMax) yMax = v.y
          samples.push([v.x, v.z])
        }
        samples.push([(va.x + vb.x + vc.x) / 3, (va.z + vb.z + vc.z) / 3])
        detailTris.push([[va.x, va.z], [vb.x, vb.z], [vc.x, vc.z]])
        const cx = (va.x + vb.x + vc.x) / 3
        const cz = (va.z + vb.z + vc.z) / 3
        if (bounds && (cx < bounds.minX || cx > bounds.maxX || cz < bounds.minZ || cz > bounds.maxZ)) outside++
        if (hash && overCarve(hash, cx, cz)) overObstacle++
      }
      const slopeDeg = areaSum > 0 ? slopeSum / areaSum : 0
      const disable = overObstacle > 0 || (triCount > 0 && outside === triCount)
      pm.setAreas(p, slopeAreaId(slopeDeg))
      pm.setFlags(p, disable ? POLY_FLAG_DISABLED : POLY_FLAG_WALKABLE)
      polySlopes[p] = slopeMax // fallback when no source tri lands inside
      polyYMin[p] = Number.isFinite(yMin) ? yMin : 0
      polyYMax[p] = Number.isFinite(yMax) ? yMax : 0
      polyDisabled[p] = disable ? 1 : 0
      polyDetailXZ.push(samples)
      polyDetailTris.push(detailTris)
    }
    // Every source tri's CENTROID assigns it to the poly that contains it —
    // a per-poly max of the surface patches actually under the poly. Sample-
    // point matching (the natural-looking forward pass) over-marks boundary
    // polys with their steep NEIGHBOR's slope (edge samples hit both sides),
    // which masked flat corridors away — the a30-skirt leak. Centroids are
    // strictly interior: each source tri counts for exactly one patch.
    for (const t of sourceTris) {
      const cx = (t.ax + t.bx + t.cx) / 3
      const cz = (t.az + t.bz + t.cz) / 3
      for (let p = 0; p < nPolys; p++) {
        if (!pointInTriXZList(cx, cz, polyDetailTris[p])) continue
        if (t.slopeDeg > polySlopes[p]) polySlopes[p] = t.slopeDeg
      }
    }
    return { polySlopes, polyYMin, polyYMax, polyDisabled }
  }

  /** XZ point-in-triangle (barycentric, small tolerance for edge samples). */
  function pointInTriXZ(x, z, t) {
    const d = (t.bz - t.cz) * (t.ax - t.cx) + (t.cx - t.bx) * (t.az - t.cz)
    if (Math.abs(d) < 1e-9) return false
    const l1 = ((t.bz - t.cz) * (x - t.cx) + (t.cx - t.bx) * (z - t.cz)) / d
    const l2 = ((t.cz - t.az) * (x - t.cx) + (t.ax - t.cx) * (z - t.cz)) / d
    const l3 = 1 - l1 - l2
    return l1 >= -0.01 && l2 >= -0.01 && l3 >= -0.01
  }

  /** Point-in-poly-XZ via its detail tris ([[x,z],[x,z],[x,z]] entries). */
  function pointInTriXZList(x, z, tris) {
    for (const tri of tris) {
      const a = tri[0]
      const b = tri[1]
      const c = tri[2]
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
      if (Math.abs(d) < 1e-9) continue
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (z - c[1])) / d
      const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (z - c[1])) / d
      const l3 = 1 - l1 - l2
      if (l1 >= -0.01 && l2 >= -0.01 && l3 >= -0.01) return true
    }
    return false
  }

  function vert3(pmd, idx) {
    return { x: pmd.verts(idx * 3), y: pmd.verts(idx * 3 + 1), z: pmd.verts(idx * 3 + 2) }
  }

  /** XZ spatial hash of carve triangles for the obstacle-footprint test. */
  function buildCarveHash(tris) {
    if (!tris || tris.length === 0) return null
    const CELLX = 4
    const map = new Map()
    const key = (i, j) => `${i}|${j}`
    for (const t of tris) {
      const minX = Math.min(t.ax, t.bx, t.cx), maxX = Math.max(t.ax, t.bx, t.cx)
      const minZ = Math.min(t.az, t.bz, t.cz), maxZ = Math.max(t.az, t.bz, t.cz)
      for (let i = Math.floor(minX / CELLX); i <= Math.floor(maxX / CELLX); i++) {
        for (let j = Math.floor(minZ / CELLX); j <= Math.floor(maxZ / CELLX); j++) {
          const k = key(i, j)
          let arr = map.get(k)
          if (!arr) map.set(k, arr = [])
          arr.push(t)
        }
      }
    }
    return { map, CELLX }
  }

  /** True when (x, z) lies inside the XZ projection of a carve triangle —
   *  i.e. the point stands above/below `nav-obstacle` geometry (the old
   *  grid's blocked COLUMN semantics, which also guarantees no walkable
   *  island survives on an obstacle top). */
  function overCarve(hash, x, z) {
    const arr = hash.map.get(`${Math.floor(x / hash.CELLX)}|${Math.floor(z / hash.CELLX)}`)
    if (!arr) return false
    for (const t of arr) {
      const d = (t.bz - t.cz) * (t.ax - t.cx) + (t.cx - t.bx) * (t.az - t.cz)
      if (Math.abs(d) < 1e-9) continue
      const l1 = ((t.bz - t.cz) * (x - t.cx) + (t.cx - t.bx) * (z - t.cz)) / d
      const l2 = ((t.cz - t.az) * (x - t.cx) + (t.ax - t.cx) * (z - t.cz)) / d
      const l3 = 1 - l1 - l2
      if (l1 >= -0.01 && l2 >= -0.01 && l3 >= -0.01) return true
    }
    return false
  }

  /** Finding 2 + the blocked-COLUMN contract at SPAN level: nuke every
   *  heightfield span whose voxel center stands over a carve triangle's XZ
   *  footprint (any height). Span-level (not poly-level) so a ground poly
   *  that merely spans past a footprint keeps working: the voxel column is
   *  simply never walkable, exactly like the rasterized grid's blocked cell
   *  column. Resolution-tolerant: the semantic points (footprint centers,
   *  obstacle tops) fall inside nulled voxels at every cs the clamp allows. */
  function nullSpansOverCarve(hf, carveTris, bmin, cfg) {
    const hash = buildCarveHash(carveTris)
    if (!hash) return 0
    const w = hf.width(), h = hf.height()
    let n = 0
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const wx = bmin[0] + (x + 0.5) * cfg.cs
        const wz = bmin[2] + (z + 0.5) * cfg.cs
        if (!overCarve(hash, wx, wz)) continue
        let s = hf.spans(z * w + x)
        while (s) { s.raw.area = 0; n++; s = s.next() }
      }
    }
    return n
  }

  /** The clearance class of a normalized profile = its (radius, height,
   *  maxSlope, stepHeight) — abilities are BAKED per class (Phase 1 pivot). */
  function classDimsOf(p) {
    const n = normalizeNavmeshProfile(p)
    return { radius: n.radius, height: n.height, maxSlope: n.maxSlope, stepHeight: n.stepHeight }
  }

  function ensure(profile) {
    const cls = classDimsOf(profile)
    const key = navmeshClassKey(cls)
    if (!cache.has(key)) {
      try { cache.set(key, bakeClass(cls)) } catch (e) {
        throw e
      }
    }
    return cache.get(key)
  }

  function polyRefOk(res) {
    return !!(res && (res.nearestRef || res.polyRef))
  }
  function refOf(res) {
    return (res && (res.nearestRef ?? res.polyRef ?? (res.nearest && res.nearest.polyRef))) || 0
  }

  /**
   * The SHARED standability predicate — the EXACT isNavigable test (tight
   * 0.25-corridor findNearestPoly + XZ distance gate) under the canonical
   * query flags. isNavigable IS this; nearestWalkable POST-VALIDATES every
   * snap point with it so the two are true inverses (every returned snap
   * point stands — the api.nav seam contract).
   */
  function standableAt(entry, p, x, z) {
    applyQueryFlags(entry, p)
    const gy = groundY(x, z)
    const res = entry.query.findNearestPoly({ x, y: gy + 1, z }, { halfExtents: { x: 0.25, y: 8, z: 0.25 } })
    if (!polyRefOk(res)) return false
    const np = res.nearestPoint || {}
    if (!Number.isFinite(np.x) || !Number.isFinite(np.y)) return false
    return Math.abs(np.x - x) <= 0.25 && Math.abs(np.z - z) <= 0.25
  }

  /**
   * Deterministic standable-point search ring around a snapped candidate
   * (Detour 'never return an edge point'): the candidate itself first, then
   * away-from-query, toward-query, then the 8 compass offsets at CORNER_EPS —
   * FIRST PASS WINS. Exact poly-edge / hole-corner vertices (the knife points
   * isNavigable rejects) are nudged toward the poly interior here.
   */
  function nudgeRing(qx, qz, x, z) {
    const out = [{ x, z }]
    let dx = x - qx
    let dz = z - qz
    const len = Math.hypot(dx, dz)
    if (len > 1e-12) {
      dx /= len
      dz /= len
      out.push({ x: x + dx * CORNER_EPS, z: z + dz * CORNER_EPS }) // away from query
      out.push({ x: x - dx * CORNER_EPS, z: z - dz * CORNER_EPS }) // toward query
    }
    const e = CORNER_EPS
    out.push(
      { x: x + e, z }, { x: x - e, z }, { x, z: z + e }, { x, z: z - e },
      { x: x + e, z: z + e }, { x: x + e, z: z - e },
      { x: x - e, z: z + e }, { x: x - e, z: z - e },
    )
    return out
  }

  /** Resolve the declared link a traversal through off-mesh poly `ref`
   *  corresponds to, in TRAVERSAL order (entry, exit) — exact authored
   *  endpoints (the nav-agent-links waypoint semantics). */
  function linkEndpointsFor(entry, ref, prevPoint) {
    const nav = entry.navMesh
    const t = nav.getTileAndPolyByRef(ref)
    if (!t || !t.poly) return null
    const va = vertOfTile(t.tile, t.poly.verts(0))
    const vb = vertOfTile(t.tile, t.poly.verts(1))
    // Match the declared link by endpoint proximity (bake endpoints ARE the
    // declared from/to, quantization may nudge the poly verts slightly).
    let best = null
    for (const l of links) {
      const dA = Math.hypot(l.from.x - va.x, l.from.z - va.z) + Math.hypot(l.to.x - vb.x, l.to.z - vb.z)
      const dB = Math.hypot(l.to.x - va.x, l.to.z - va.z) + Math.hypot(l.from.x - vb.x, l.from.z - vb.z)
      const d = Math.min(dA, dB)
      if (!best || d < best.d) best = { d, l, forward: dA <= dB }
    }
    if (!best || best.d > 1.0) return null
    const l = best.l
    const yFrom = groundY(l.from.x, l.from.z)
    const yTo = groundY(l.to.x, l.to.z)
    const A = { x: l.from.x, y: yFrom, z: l.from.z }
    const B = { x: l.to.x, y: yTo, z: l.to.z }
    // Direction of THIS traversal: the entry is the endpoint nearer the
    // previous path point (oneWay links can only ever be traversed from→to,
    // so this just recovers the direction the corridor used).
    const dPrevA = prevPoint ? Math.hypot(prevPoint.x - A.x, prevPoint.z - A.z) : Infinity
    const dPrevB = prevPoint ? Math.hypot(prevPoint.x - B.x, prevPoint.z - B.z) : Infinity
    return dPrevA <= dPrevB ? { enter: A, exit: B, link: l } : { enter: B, exit: A, link: l }
  }

  function vertOfTile(tile, vi) {
    return { x: tile.verts(vi * 3), y: tile.verts(vi * 3 + 1), z: tile.verts(vi * 3 + 2) }
  }

  /** Straight path over one ground-ref run, as points. */
  function straightPathFor(entry, start, end, refs) {
    if (!refs.length) return [start, end]
    const straight = entry.query.findStraightPath(start, end, refs, { maxStraightPathPoints: 4096 })
    const sp = straight && straight.straightPath
    const count = (straight && Number.isFinite(straight.straightPathCount))
      ? straight.straightPathCount
      : Math.floor(arrLen(sp) / 3)
    const points = []
    for (let i = 0; i < count; i++) {
      points.push({
        x: typeof sp.get === 'function' ? sp.get(i * 3) : sp[i * 3],
        y: typeof sp.get === 'function' ? sp.get(i * 3 + 1) : sp[i * 3 + 1],
        z: typeof sp.get === 'function' ? sp.get(i * 3 + 2) : sp[i * 3 + 2],
      })
    }
    for (const arr of [straight && straight.straightPath, straight && straight.straightPathFlags, straight && straight.straightPathRefs]) {
      if (arr && arr.destroy) arr.destroy()
    }
    return points.length ? points : [start, end]
  }

  /** Densify a polyline to ~1 unit XZ spacing (the historical cell-center
   *  waypoint density — resolution-free); `noDensify` marks joins that are
   *  off-mesh hops (link endpoints must stay consecutive). */
  function densify(points, entry, noDensify) {
    const SPACING = 1.0
    const out = []
    for (let i = 0; i < points.length; i++) {
      if (i > 0) {
        const a = points[i - 1], b = points[i]
        const d = Math.hypot(b.x - a.x, b.z - a.z)
        // noDensify holds the index of the segment START (i-1): an off-mesh
        // hop's endpoints must stay consecutive (usesLink pin).
        const skip = noDensify && noDensify.has(i - 1)
        if (!skip && d > SPACING * 1.25) {
          const n = Math.max(1, Math.ceil(d / SPACING))
          for (let k = 1; k < n; k++) {
            const t = k / n
            const px = a.x + (b.x - a.x) * t
            const pz = a.z + (b.z - a.z) * t
            out.push({ x: px, y: surfaceYAt(entry, px, pz, a.y), z: pz })
          }
        }
      }
      out.push({ ...points[i] })
    }
    return out
  }

  /** Surface Y at (x,z) via the navmesh detail height (fallback: y of the
   *  nearest poly point, then 0). STACKED-SURFACE AWARE: the y=0 tall-box
   *  nearest query lands on the walkable surface CLOSEST to y=0 (the ground
   *  layer a standing request means), not an arbitrary stacked layer. The
   *  getPolyHeight verdict is HONORED: on failure the wrapper returns an
   *  UNINITIALIZED height (a denormal garbage value that passes
   *  Number.isFinite — probe: status 0x80000008, height 2.59e-41 on the cave
   *  roof), so a false verdict must fall through to the nearest-point Y. */
  function surfaceYAt(entry, x, z, yHint) {
    // CORRIDOR RIDE (walkTruth follow-up pin): with a Y hint (the densifier's
    // segment start — the corridor level the midpoint must ride), the
    // walkable span top of the column nearest the hint IS the surface Y. The
    // y=0 nearest-poly pick below lands on the GROUND layer — on a roof
    // corridor over floor-covered XZ it would drag the densified midpoints
    // down to the floor the corridor flies over. No hint (standing requests)
    // keeps the y=0 ground-layer pick. Within one voxel of a walkable span
    // top; the hint only RAISES fidelity, findPath semantics unchanged.
    if (Number.isFinite(yHint) && entry.walkTruth) {
      const t = entry.walkTruth
      const gx = Math.floor((x - t.bminX) / t.cs)
      const gz = Math.floor((z - t.bminZ) / t.cs)
      const list = t.tops.get(gz * t.width + gx)
      if (list) {
        let best = null, bestDev = Infinity
        for (let i = 0; i < list.length; i++) {
          const dev = Math.abs(list[i] - yHint)
          if (dev < bestDev) { bestDev = dev; best = list[i] }
        }
        if (best != null && bestDev <= t.ch + 1e-4) return best
      }
    }
    const res = entry.query.findNearestPoly({ x, y: 0, z }, { halfExtents: { x: 0.6, y: 1e6, z: 0.6 } })
    const ref = refOf(res)
    if (ref) {
      try {
        const h = entry.query.getPolyHeight(ref, { x, y: (res.nearestPoint && res.nearestPoint.y) || 0, z })
        if (h && h.success !== false && Number.isFinite(h.height)) return h.height
        if (res.nearestPoint && Number.isFinite(res.nearestPoint.y)) return res.nearestPoint.y
      } catch { /* fall through */ }
    }
    return groundY(x, z)
  }

  /**
   * The historical findPath body EXTRACTED (snap + Detour corridor + funnel
   * with exact link-hop endpoints). Returns { raw, noDensify, refs } or null
   * (no complete path — Detour partial paths → null, the A* semantics).
   */
  function corridorRaw(entry, p, from, to) {
    const SNAP = { x: 2, y: 8, z: 2 } // 2 world units (the historical 2-cell
    // snap at cellSize 1, now resolution-free)
    const filter = filterFor(entry, p)
    // STACKED-SURFACE SNAP (Y-aware, two-pass). A bare {x,z} request stands
    // at the walkable surface AT ITS OWN XZ, ground layer preferred:
    //   pass 1 — tight XZ box (0.25, the exact-cell stand tolerance) with a
    //   tall Y box: the surface the point is actually ON; when layers stack,
    //   Detour's nearest-to-(x,0,z) pick takes the LOWEST one (a cave-floor
    //   request routes the cave floor, not the roof over it), and a
    //   roof-only point (floor absent under the box) stays on the roof.
    //   pass 2 — only when NOTHING covers the point: the historical wide
    //   2-unit walk (topmost anchor), the off-mesh/endpoint repair seam.
    // XZ routing is unchanged: a pass-1 point is within 0.25 XZ of the
    // request, well inside the 2-world-unit seam bound.
    const snapFilter = filterFor(entry, p, { snap: true })
    const yAwareSnap = (req) => {
      const tight = entry.query.findNearestPoly(
        { x: Number(req.x), y: 0, z: Number(req.z) },
        { halfExtents: { x: 0.25, y: 1e6, z: 0.25 }, filter: snapFilter },
      )
      if (refOf(tight)) return tight
      return entry.query.findNearestPoly(
        { x: Number(req.x), y: groundY(req.x, req.z) + 1, z: Number(req.z) },
        { halfExtents: SNAP, filter: snapFilter },
      )
    }
    const s = yAwareSnap(from)
    const e = yAwareSnap(to)
    const sRef = refOf(s), eRef = refOf(e)
    if (!sRef || !eRef) return null
    const sPos = (s && s.nearestPoint) || from
    const ePos = (e && e.nearestPoint) || to
    // SNAP SEAM (the api.nav contract, resolution-free): the snapped
    // endpoints must lie within 2 world units (XZ) of the requested ones.
    const withinSeam = (pt, req) => Math.hypot(pt.x - req.x, pt.z - req.z) <= SNAP.x + 1e-6
    if (!withinSeam(sPos, from) || !withinSeam(ePos, to)) return null
    // Detour's findPath fills a preallocated ref array (trailing slots stay
    // 0) — the filled length is the run of leading non-zero refs.
    const res = entry.query.findPath(sRef, eRef, sPos, ePos, { maxPathPolys: 2048, filter })
    const polys = res && res.polys
    const cap = arrLen(polys)
    let n = 0
    while (n < cap) {
      const r = typeof polys.get === 'function' ? polys.get(n) : polys[n]
      if (!r) break
      n++
    }
    if (!res || !res.success || !n) { if (polys && polys.destroy) polys.destroy(); return null }
    const refs = []
    for (let i = 0; i < n; i++) refs.push(typeof polys.get === 'function' ? polys.get(i) : polys[i])
    const complete = refs[n - 1] === eRef
    if (polys && polys.destroy) polys.destroy()
    if (!complete) return null

    // Split the corridor at off-mesh polys: ground runs get a straight path
    // each; every link hop contributes its EXACT endpoints, consecutive.
    const noDensify = new Set()
    const raw = []
    const pushRaw = (pt) => {
      const last = raw[raw.length - 1]
      if (last && Math.abs(last.x - pt.x) < 1e-6 && Math.abs(last.z - pt.z) < 1e-6) return
      raw.push({ ...pt })
    }
    let prevPt = sPos
    let runStart = 0
    pushRaw(sPos)
    const flushRun = (endIdx, endPt) => {
      const run = refs.slice(runStart, endIdx)
      const seg = straightPathFor(entry, prevPt, endPt, run)
      for (let i = raw.length ? 1 : 0; i < seg.length; i++) pushRaw(seg[i])
      prevPt = endPt
    }
    for (let i = 0; i < refs.length; i++) {
      if (polyTypeOf(entry, refs[i]) !== POLYTYPE_OFFMESH) continue
      const ep = linkEndpointsFor(entry, refs[i], prevPt)
      if (!ep) continue // unmatched link metadata — keep the ground walk
      flushRun(i, ep.enter) // ground run ends at the link's entry point
      pushRaw(ep.enter) // in case the run's straight path stopped short
      noDensify.add(raw.length - 1) // the hop join stays exact
      pushRaw(ep.exit)
      prevPt = ep.exit
      runStart = i + 1
    }
    flushRun(refs.length, ePos)
    return { raw, noDensify, refs }
  }

  return {
    /** Rebuild everything: bump version, drop all cached profile bakes. */
    rebuild() {
      versionCounter++
      for (const entry of cache.values()) {
        if (entry.navMesh && typeof entry.navMesh.destroy === 'function') entry.navMesh.destroy()
      }
      cache.clear()
      geomCache.value = null
      // D-9: clearance classes are AUTO-DERIVED from the scene's nav-agents at
      // every rebuild (nothing configured).
      derivedClasses = collectNavAgentClasses({ world, scene })
      return versionCounter
    },

    /** STEP 4B DIRTY-TILE REBUILD — partial re-bake of the CURRENT region:
     *  every cached class re-bakes ONLY the tiles whose (margin-expanded)
     *  rects intersect `rect` ({minX, minZ, maxX, maxZ}); untouched tiles
     *  keep their exact Detour data (same poly refs). Returns true when the
     *  partial path applied (or nothing needed re-baking), false when the
     *  caller must fall back to a full rebuild() (raster-grid drift — e.g.
     *  the change moved the derived nav bounds — or a failed tile bake).
     *  With no cached class bakes yet there is nothing to re-bake in place:
     *  returns true (the next lazy bake sees the current world anyway). */
    rebuildRegion(rect) {
      const r = rect && typeof rect === 'object' && !Array.isArray(rect)
        && [rect.minX, rect.minZ, rect.maxX, rect.maxZ].every(Number.isFinite)
        && rect.minX < rect.maxX && rect.minZ < rect.maxZ
        ? { minX: rect.minX, minZ: rect.minZ, maxX: rect.maxX, maxZ: rect.maxZ } : null
      if (!r) return false
      if (cache.size === 0) return true
      for (const entry of cache.values()) {
        if (!reBakeClassRegion(entry, r)) return false
      }
      versionCounter++
      return true
    },

    /** STEP 4B TEST/DIAGNOSTIC SEAM (read-only, documented): per cached class
     *  (or just `profile`'s class), the baked tile list
     *  [{ x, y, version, ref, polyRefs }] — `version` starts at 1 on the
     *  initial bake and increments each time the dirty-tile re-bake re-bakes
     *  that tile; `polyRefs` are the tile's current Detour poly refs
     *  (identity — untouched tiles keep theirs). Not part of the api.nav
     *  contract; the dirty-tile specs pin on it. */
    debugTileVersions(profile) {
      const out = []
      for (const [key, entry] of cache) {
        if (profile !== undefined && profile !== null && navmeshClassKey(classDimsOf(normalizeNavmeshProfile(profile))) !== key) continue
        const tiles = []
        for (const [k, m] of entry.tileMeta) {
          const [x, y] = k.split('|').map(Number)
          tiles.push({ x, y, version: m.version, ref: m.ref, polyRefs: entry.tilePolyRefs.get(k) || [] })
        }
        tiles.sort((a, b) => a.x - b.x || a.y - b.y)
        out.push({ key, tiles })
      }
      return out
    },

    /**
     * @returns {null|{points: Array<{x,y,z}>}} null unless a COMPLETE path
     *   exists (Detour partial paths → null, matching A* no-path semantics).
     *   Waypoints are densified ~1 unit; exact off-mesh link endpoints appear
     *   as consecutive waypoints (usesLink semantics).
     */
    findPath(from, to, profile) {
      const p = normalizeNavmeshProfile(profile)
      // Invalid endpoints (missing/non-finite) -> null, never throw.
      if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(from.z) ||
        !Number.isFinite(to.x) || !Number.isFinite(to.z)) return null
      let entry
      try { entry = ensure(p) } catch { return null }
      // Phase 1 pivot (AAA baked abilities): ONE pass — the slope/step
      // verdicts are IN the bake (walkableSlopeAngle drops steep, walkable-
      // Climb merges steps); only the jumpHeight link mask is per query.
      applyQueryFlags(entry, p)
      const run = corridorRaw(entry, p, from, to)
      if (run) entry.lastRefs = run.refs
      if (!run) return null
      // Foreman steer (2026-09-29, corner-cutting): the funnel's straight
      // segments must never clip a nav-obstacle footprint — repair around the
      // corner, THEN densify (inserted points ride the clear segments).
      const fixed = cornerSafe(entry, p, run.raw, run.noDensify)
      const points = densify(fixed.pts, entry, fixed.hops)
      return points.length ? { points } : null
    },

    /**
     * True when (x,z) stands ON the navmesh for the profile: a ground poly
     * within a tight corridor (0.25 horizontally — the exact-cell
     * standability the api.nav isNavigable contract pins; the loose 2-unit
     * radius is only for PATH endpoint snapping). No terrain-height gate —
     * walkable `nav-surface` platforms more than 1 unit above the terrain
     * are navigable (W6a2 finding 2 keeps OBSTACLE tops off the mesh
     * instead). The test itself lives in standableAt — nearestWalkable's
     * post-validation runs the SAME predicate (true-inverse seam).
     */
    isNavigable(x, z, profile) {
      const p = normalizeNavmeshProfile(profile)
      let entry
      try { entry = ensure(p) } catch { return false }
      return standableAt(entry, p, x, z)
    },

    /** T7a GROUNDING SEAM — the SHARED source-faithful surface Y at (x, z):
     *  the real source face covering the point whose Y is nearest `yHint`
     *  (terrain GRID-NODE triangles + primitive box/plane/ramp face-plane
     *  tops — the SAME surface entries every class bake lies on), else null.
     *  `yHint` = the body's current ground-contact Y estimate: stacked
     *  surfaces (caves/overhangs) pick the layer the agent is ALREADY on —
     *  never a roof above, and never a face FAR from the body's current
     *  layer (e.g. a box underside when the body is nowhere near it): faces
     *  outside the one-step window around the hint are not candidates and
     *  the query falls back to the TOPMOST face (T7a back-compat).
     *  No hint (undefined/non-finite) = the topmost face, unchanged.
     *  Null is NOT the implicit y=0 ground: callers ground bodies only where
     *  real geometry is (a body over no surface keeps its y — the legacy
     *  drape contract). */
    surfaceY(x, z, yHint) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return null
      const src = sourceSurface()
      const top = () => {
        const t = src.topAt(x, z)
        return t ? t.y : null
      }
      if (!Number.isFinite(yHint)) return top()
      const near = src.faceAt(x, z, yHint)
      // Layer window: the body's ground contact can only rest on a face it is
      // ALREADY standing on/near (within one step). Anything further is a
      // different layer the body has not reached (a roof above, or a box
      // underside when the body is nowhere near it) — topmost wins
      // (T7a back-compat).
      if (near && Math.abs(near.y - yHint) <= GROUND_HINT_WINDOW) return near.y
      return top()
    },

    /** The nearest walkable world point to (x,z) within 2 units (the
     *  historical 2-cell snap radius at cellSize 1), or null. TRUE INVERSE
     *  of isNavigable (W6a2 seam fix): the snapped point is POST-VALIDATED
     *  with the exact standability predicate isNavigable uses; an exact
     *  poly-edge / hole-corner knife point is deterministically nudged
     *  toward the poly interior (the nudgeRing order) and re-checked.
     *  First pass wins; else null. The 2-world-unit seam bound holds for
     *  the RETURNED point (<= 2.001). */
    nearestWalkable(x, z, profile) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return null
      const p = normalizeNavmeshProfile(profile)
      let entry
      try { entry = ensure(p) } catch { return null }
      applyQueryFlags(entry, p)
      const gy = groundY(x, z)
      const res = entry.query.findNearestPoly({ x, y: gy + 1, z }, { halfExtents: { x: 2, y: 8, z: 2 } })
      if (!polyRefOk(res)) return null
      const np = res.nearestPoint
      if (!np || !Number.isFinite(np.x) || !Number.isFinite(np.z)) return null
      for (const c of nudgeRing(x, z, np.x, np.z)) {
        if (Math.hypot(c.x - x, c.z - z) > 2.001) continue
        if (standableAt(entry, p, c.x, c.z)) return { x: c.x, z: c.z }
      }
      return null
    },

    /** Baked polygon geometry (W6b viz/debug seam). `profile` given ->
     *  EXACTLY that profile's entry (lazily baked); omitted -> every cached
     *  profile (lazily baking the default capability mesh when the cache is
     *  empty). Each entry: [{key, profile, positions, indices, polyCount,
     *  links}] — Float32 WORLD positions carrying the bake's REAL world Y
     *  (the draped surface over terrain) + Uint32 fan-triangulated indices;
     *  `links` = the off-mesh connections baked into this profile's mesh
     *  [{from:{x,y,z}, to:{x,y,z}, cost, oneWay}] with draped endpoint Y.
     *  REBUILD-CACHED: geometry is extracted ONCE per bake and the same
     *  READ-ONLY entry objects (stable identity — zero per-call allocation)
     *  are returned until rebuild(). */
    meshes(profile) {
      const out = []
      if (profile !== undefined && profile !== null) {
        const entry = ensure(profile)
        if (!entry.meshGeom) entry.meshGeom = meshGeometry(entry)
        out.push(entry.meshGeom)
        return out
      }
      if (cache.size === 0) ensure(null)
      for (const entry of cache.values()) {
        if (!entry.meshGeom) entry.meshGeom = meshGeometry(entry)
        out.push(entry.meshGeom)
      }
      return out
    },

    /** Normalized off-mesh links: [{ from, to, cost, oneWay }] (cost defaults
     *  to the euclid XZ distance; invalid entries dropped — see
     *  normalizeNavLinks). */
    links() {
      return links.map((l) => ({ from: { ...l.from }, to: { ...l.to }, cost: l.cost, oneWay: l.oneWay }))
    },

    version() {
      return versionCounter
    },

    /**
     * READ-ONLY diagnostic seam (D-9 tests + the flags/polySlopes A/B pin):
     * per cached class, the ground poly table (slopeMax, slopeWeighted, yMin,
     * yMax, disabled) and the CURRENT Detour flags after the last applied
     * query mask, plus the last corridor's poly indices. Not part of the
     * api.nav contract.
     */
    debugPolyState() {
      const out = {}
      for (const [key, e] of cache) {
        const flags = new Uint8Array(e.polyRefs.length)
        for (let i = 0; i < e.polyRefs.length; i++) {
          // getPolyFlags returns a { status, flags } RESULT OBJECT
          // (recast-navigation) — read the numeric flags; storing the object
          // itself in a Uint8Array coerces to 0 (the A/B pin's blind spot).
          const g = typeof e.navMesh.getPolyFlags === 'function' ? e.navMesh.getPolyFlags(e.polyRefs[i]) : 0
          flags[i] = typeof g === 'number' ? g : (g && typeof g.flags === 'number' ? g.flags : 0)
        }
        out[key] = {
          polySlopes: e.polySlopes,
          polyYMin: e.polyYMin,
          polyYMax: e.polyYMax,
          polyDisabled: e.polyDisabled,
          polyFlags: flags,
          linkHeights: e.linkHeights,
          lastRefs: e.lastRefs || [],
          polyIndexOf: e.polyIndexOf,
          polyRefs: e.polyRefs,
        }
      }
      return out
    },

    config() {
      return {
        cellSize: CELL.size,
        cellHeight: CELL.height,
        profileDefaults: { ...NAVMESH_PROFILE_DEFAULTS },
        linkCount: links.length,
        classes: derivedClasses.map(navmeshClassKey),
        bakedProfiles: [...cache.keys()],
        bounds: boundsGetter() ?? derivedBounds(),
        source: geometry().counts,
      }
    },
  }
}

/** poly type of a ref for a specific entry (0 ground, 1 off-mesh). */
function polyTypeOf(entry, ref) {
  try {
    const t = entry.navMesh.getTileAndPolyByRef(ref)
    return t && t.poly && typeof t.poly.getType === 'function' ? t.poly.getType() : POLYTYPE_GROUND
  } catch { return POLYTYPE_GROUND }
}

/** Extract Detour ground-poly geometry as flat arrays — the TERRAIN-CONFORMING
 *  DETAIL triangulation (Recast per-poly height detail; human directive:
 *  'Fix the surface to use the terrain-conforming detail mesh (kills the float
 *  + holes) -> matches AAA'). Each ground poly contributes its detailMesh's
 *  Step 1 viz export — SOURCE TESSELLATION (replaces the refineToSurface
 *  face-pure subdivision, the 1.3 M-triangle perf bug): each walkable GROUND
 *  poly's XZ region is tessellated against the SOURCE triangles themselves
 *  (terrain grid-node / primitive face triangles via entry.surfaceClip).
 *  Per candidate source face the face's XZ triangle is clipped against the
 *  poly's convex XZ polygon (Sutherland–Hodgman; both convex -> convex -> fan
 *  from vertex 0) and emitted with each clipped vertex Y = surf.snapY(face,
 *  x, z) — the face's EXACT plane Y, so the export IS the source surface at
 *  the source's natural resolution (identical slope-color by construction).
 *  FACE-TO-POLY SELECTION (stacked-surface correctness): a face belongs to
 *  the poly only if its clipped region is non-empty AND at the clipped
 *  region's centroid surf.trisAt(cx, cz, faceYatCentroid) contains the face —
 *  a roof face and a cave-floor face each pass at their own Y, so stacked
 *  layers both export (topmost wins Y/slope queries; coplanar overlaps keep
 *  both). The poly's own verts and the Recast detail mesh are no longer
 *  emitted at all — the clipped source faces alone cover every walkable
 *  poly's XZ region (the old detail-tri fans and their no-detail-mesh fan
 *  fallback are gone, disclosed). `polySlopes` (max detail-triangle slope
 *  in DEGREES) and `polyAreas` (its slope bucket id) stay indexed by ground
 *  poly in THIS function's iteration order (UNCHANGED — poly order is the
 *  annotation order); links carry DRAPED endpoints (bakeClass) — the
 *  viz/debug seam. */
function meshGeometry(entry) {
  const navMesh = entry.navMesh
  const key = navmeshClassKey(entry.cls)
  const profile = { radius: entry.cls.radius, height: entry.cls.height }
  // BAKED abilities ride the class too (the class key includes them)
  const bakedLinks = entry.bakedLinks
  const surf = entry.surfaceClip
  const positions = []
  const indices = []
  let polyCount = 0
  const maxTiles = typeof navMesh.getMaxTiles === 'function' ? navMesh.getMaxTiles() : 0
  for (let i = 0; i < maxTiles; i++) {
    const tile = navMesh.getTile(i)
    const header = tile && typeof tile.header === 'function' ? tile.header() : null
    if (!header) continue
    const pc = header.polyCount()
    for (let p = 0; p < pc; p++) {
      const poly = tile.polys(p)
      if (typeof poly.getType === 'function' && poly.getType() !== POLYTYPE_GROUND) continue // off-mesh poly
      const n = poly.vertCount()
      if (n < 3) continue
      polyCount++
      // STACKED POLY: the poly's own Y annotation spans >= the baked climb —
      // a region that climb-merged a lower surface with the one above (the
      // margin ring under a roof edge merges at delta exactly = climb). Its
      // fan (partial-coverage fallback) would mix the levels, so it is
      // suppressed; the truth-backed clipped faces already carry the surface.
      const climbW = Math.min(entry.cls.stepHeight, entry.cls.height)
      const chT = entry.walkTruth ? entry.walkTruth.ch : 0.05
      const annIdx = entry.polyIndexOf ? entry.polyIndexOf.get(navMesh.getPolyRefBase(tile) + p) : -1
      const yMinP = annIdx !== undefined && entry.polyYMin ? entry.polyYMin[annIdx] : NaN
      const yMaxP = annIdx !== undefined && entry.polyYMax ? entry.polyYMax[annIdx] : NaN
      let stackedPoly = Number.isFinite(yMinP) && Number.isFinite(yMaxP) && yMaxP - yMinP >= climbW - 2 * chT
      // The poly's XZ polygon (its verts, already Y-snapped at bake) — only
      // the XZ footprint drives the source-face tessellation.
      const px = [], pz = []
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (let v = 0; v < n; v++) {
        const vi = poly.verts(v) * 3
        const x = tile.verts(vi), z = tile.verts(vi + 2)
        px.push(x); pz.push(z)
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
      // The poly's OWN walkable span-top band: the walkable span tops of the
      // truth columns under the poly's XZ footprint (bake truth per column,
      // not the detail-mesh annotation — the annotation smooths slopes).
      // STEP 4B FIX (per-tile Y-range offsets): resolve the poly's annotation
      // index BY IDENTITY — per-tile poly index `p` against the scene-wide
      // poly refs via the tile's polyRefBase; the old positional
      // entry.polyYMin[p] read the concatenated array with the per-TILE index,
      // misaligned for every tile after the first.
      let bandLo = Infinity, bandHi = -Infinity
      if (entry.walkTruth) {
        const t = entry.walkTruth
        const g0x = Math.max(0, Math.floor((minX - t.bminX) / t.cs))
        const g1x = Math.min(t.width - 1, Math.floor((maxX - t.bminX) / t.cs))
        const g0z = Math.max(0, Math.floor((minZ - t.bminZ) / t.cs))
        const g1z = Math.min(t.height - 1, Math.floor((maxZ - t.bminZ) / t.cs))
        for (let gz = g0z; gz <= g1z; gz++) {
          for (let gx = g0x; gx <= g1x; gx++) {
            const list = t.tops.get(gz * t.width + gx)
            if (!list) continue
            if (list[0] < bandLo) bandLo = list[0]
            const last = list[list.length - 1]
            if (last > bandHi) bandHi = last
          }
        }
      }
      // Footprint-truth stacked: the poly's own footprint columns hold
      // walkable span tops spanning >= the baked climb — the region
      // climb-merged a lower surface with the one above (the ground margin
      // ring under a roof edge merges at delta exactly = climb), even when
      // the detail-mesh annotation (yMinP/yMaxP) missed it.
      if (bandLo < Infinity && bandHi > -Infinity && bandHi - bandLo >= climbW - 2 * chT) stackedPoly = true
      // COVERAGE INVARIANT: the selected source faces must tile the poly's XZ
      // region. Polys over NO source face (implicit flat ground — W6b's
      // obstacle-only scenes) or only partially covered ones fall back to the
      // historical poly fan (verts Y-snapped via surfaceY) so coverage never
      // drops (disclosed).
      let polyArea2 = 0
      for (let v = 0; v < n; v++) {
        const f = (v + 1) % n
        polyArea2 += px[v] * pz[f] - px[f] * pz[v]
      }
      polyArea2 = Math.abs(polyArea2)
      let covered2 = 0
      for (const id of surf.trisInRect(minX, maxX, minZ, maxZ)) {
        const tri = surf.triXZ(id)
        const clipped = clipTriInPolyXZ(tri, px, pz)
        // SEAM SLIVERS: a clip along an edge that passes (near-)exactly
        // through a source-face vertex can emit the SAME intersection point
        // twice; the fan then emits a near-degenerate sliver whose float32
        // verts collapse — a zero-area triangle with a garbage normal that
        // ties for topmost in Y queries and reports a junk slope. Dedupe
        // consecutive (and last-vs-first) identical XZ points before fanning.
        const dedup = []
        for (let k = 0; k < clipped.length; k += 2) {
          const nx = clipped[k], nz = clipped[k + 1]
          const lastK = dedup.length - 2
          if (lastK >= 0 && Math.abs(dedup[lastK] - nx) < 1e-9 && Math.abs(dedup[lastK + 1] - nz) < 1e-9) continue
          dedup.push(nx, nz)
        }
        if (dedup.length >= 4 && Math.abs(dedup[0] - dedup[dedup.length - 2]) < 1e-9 && Math.abs(dedup[1] - dedup[dedup.length - 1]) < 1e-9) dedup.length -= 2
        const clipped2 = dedup
        const m2 = clipped2.length / 2
        if (m2 < 3) continue
        // Vertex average of a convex polygon lies inside it — the probe point.
        let cx = 0, cz = 0
        for (let k = 0; k < clipped2.length; k += 2) { cx += clipped2[k]; cz += clipped2[k + 1] }
        cx /= m2; cz /= m2
        // The face must be THE surface at its own plane Y here (stacked
        // layers each pass at their own Y — both export; topmost wins).
        const faceY = surf.snapY(id, cx, cz)
        if (!surf.trisAt(cx, cz, faceY).includes(id)) continue
        // WALKABLE-SPAN TRUTH gate: the bake must hold a walkable span at the
        // face plane Y in the face's centroid column — a face the bake dropped
        // (no-headroom cave floor) never re-materializes in the export.
        if (!walkSpanAtY(entry.walkTruth, cx, cz, faceY, entry.cls.maxSlope)) continue
        let a2 = 0
        for (let k = 0; k < clipped2.length; k += 2) {
          const f = k + 2 < clipped2.length ? k + 2 : 0
          a2 += clipped2[k] * clipped2[f + 1] - clipped2[f] * clipped2[k + 1]
        }
        covered2 += Math.abs(a2)
        const vbase = positions.length / 3
        for (let k = 0; k < clipped2.length; k += 2) {
          positions.push(clipped2[k], surf.snapY(id, clipped2[k], clipped2[k + 1]), clipped2[k + 1])
        }
        for (let k = 1; k < m2 - 1; k++) {
          const i0 = vbase * 3, i1 = (vbase + k) * 3, i2 = (vbase + k + 1) * 3
          // skip degenerate XZ slivers (zero/near-zero area pieces emit
          // garbage-normal triangles that pollute topmost-Y queries)
          const ax = positions[i0], az = positions[i0 + 2]
          const bx = positions[i1], bz = positions[i1 + 2]
          const cx2 = positions[i2], cz2 = positions[i2 + 2]
          if (Math.abs((bx - ax) * (cz2 - az) - (cx2 - ax) * (bz - az)) < 1e-6) continue
          indices.push(vbase, vbase + k, vbase + k + 1)
        }
      }
      // 1e-6: relative-area slack — the shoelace sums accumulate float error,
      // so coverage counts as full unless it falls short by a relative 1e-6.
      if (polyArea2 > 1e-12 && covered2 < polyArea2 * (1 - 1e-6)) {
        // PARTIAL COVERAGE (disclosed): the poly's walkable region spans BOTH
        // a source-face footprint AND source-free implicit ground (the bake's
        // stepHeight merge — e.g. a box top stepped up from the ground ring,
        // W6b's obstacle-only scenes). The exact clipped pieces stay emitted;
        // the historical poly fan (verts Y-snapped via surfaceY) is ADDED on
        // top for the uncovered remainder: over source-face footprints the
        // exact piece wins the topmost-Y read (the fan rides at the ring's
        // raw Y below it); over the ring the fan IS the surface.
        // Fan base captured AFTER the pieces: vbStart (pre-piece) would index
        // the pieces' verts when any piece was emitted — garbage triangles.
        const fanBase = positions.length / 3
        for (let v = 0; v < n; v++) {
          const vi = poly.verts(v) * 3
          positions.push(tile.verts(vi), entry.surfaceY(tile.verts(vi), tile.verts(vi + 2), tile.verts(vi + 1)), tile.verts(vi + 2))
        }
        // WALKABLE-SPAN TRUTH fan gate: the fan (the historical fallback for
        // polys whose walkable region is NOT fully covered by source faces)
        // fires only where it is truth-backed:
        //   - the poly has PARTIAL source coverage (a mixed poly — e.g. a box
        //     top merged into its ground ring): a PURE implicit-ground poly
        //     (covered2 === 0) has no source-truth surface at all — its fan
        //     would re-materialize the plane the spec's viz truth excludes;
        //   - the poly is NOT stacked (its own Y annotation does not span >=
        //     the baked climb — a region that climb-merged a lower surface
        //     with the one above, e.g. the ground margin ring under a roof
        //     edge at delta exactly = climb): the fan's Y-snapped verts mix
        //     the levels there;
        //   - every fan triangle vertex's own column holds a walkable span
        //     top at that vertex's plane Y (bake truth per column).
        for (let k = 1; k < n - 1; k++) {
          const i0 = (fanBase) * 3, i1 = (fanBase + k) * 3, i2 = (fanBase + k + 1) * 3
          if (stackedPoly || (covered2 === 0 && entry.hasTerrain)) continue
          if (walkSpanAtY(entry.walkTruth, positions[i0], positions[i0 + 2], positions[i0 + 1]) &&
            walkSpanAtY(entry.walkTruth, positions[i1], positions[i1 + 2], positions[i1 + 1]) &&
            walkSpanAtY(entry.walkTruth, positions[i2], positions[i2 + 2], positions[i2 + 1])) {
            indices.push(fanBase, fanBase + k, fanBase + k + 1)
          }
        }
      }
    }
  }
  const n2 = Math.min(polyCount, entry.polySlopes.length)
  const polySlopes = new Float32Array(polyCount)
  const polyAreas = new Uint8Array(polyCount)
  for (let i = 0; i < n2; i++) {
    polySlopes[i] = entry.polySlopes[i]
    polyAreas[i] = slopeAreaId(entry.polySlopes[i])
  }
  return {
    key,
    profile,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    polyCount,
    links: bakedLinks,
    polySlopes,
    polyAreas,
  }
}

/**
 * WALKABLE-SPAN TRUTH (viz export): capture the compact heightfield's walkable
 * span tops per column, before the intermediates are freed. A span is
 * WALKABLE iff its compact area is non-zero (buildCompactHeightfield already
 * nulled every no-headroom span via the heightfield's walkableHeight filter,
 * and the pre-erosion capture keeps slope faces + agent-margin columns
 * intact). Column key -> sorted list of walkable span-top Ys (world units).
 */
function captureWalkableSpanTops(compactHeightfield) {
  const width = compactHeightfield.width()
  const depth = compactHeightfield.height()
  const bmin = compactHeightfield.bmin()
  const cs = compactHeightfield.cs()
  const ch = compactHeightfield.ch()
  const tops = new Map()
  for (let gz = 0; gz < depth; gz++) {
    const rowBase = gz * width
    for (let gx = 0; gx < width; gx++) {
      const cell = compactHeightfield.cells(rowBase + gx)
      const count = cell.count()
      if (count === 0) continue
      const list = []
      for (let s = 0; s < count; s++) {
        const si = cell.index() + s
        if (compactHeightfield.areas(si) === 0) continue // eroded / non-walkable
        const sp = compactHeightfield.spans(si)
        // compact span: y = TOP of the solid column (the walkable surface
        // level), h = the open clearance above it — so the surface Y is
        // bmin.y + y*ch, NOT (y+h)*ch.
        list.push(bmin.y + sp.y() * ch)
      }
      if (list.length) tops.set(rowBase + gx, list.sort((a, b) => a - b))
    }
  }
  return { width, height: depth, bminX: bmin.x, bminZ: bmin.z, cs, ch, tops }
}

/** Does the column under (x,z) hold a WALKABLE span top within ONE voxel
 *  (ch + epsilon) of plane Y? The viz-export face/fan gate: bake truth, not
 *  shelf algebra — a face survives only where the bake kept a walkable span. */
function walkSpanAtY(truth, x, z, y, maxSlopeDeg) {
  if (!truth) return true // no truth captured (should not happen) — keep
  const gx = Math.floor((x - truth.bminX) / truth.cs)
  const gz = Math.floor((z - truth.bminZ) / truth.cs)
  const list = truth.tops.get(gz * truth.width + gx)
  if (!list) return false
  // ONE bake voxel + the column's own slope stair-step: the compact span top
  // in a slope column is the stair level the face's plane reaches at the
  // column's edge, up to tan(maxSlope) * cs above/below the plane at the
  // face's centroid. Slope faces keep (their column's span is theirs); a
  // plane the bake dropped stays > one stair-step from any span top.
  const stair = maxSlopeDeg == null ? 0 : Math.tan((maxSlopeDeg * Math.PI) / 180) * truth.cs
  const tol = truth.ch + stair + 1e-4
  for (let i = 0; i < list.length; i++) {
    if (Math.abs(list[i] - y) <= tol) return true
    if (list[i] - y > tol) break
  }
  return false
}

/** Sutherland–Hodgman clip of a convex subject XZ triangle against a convex
 *  XZ polygon (each side's orientation normalized via its signed-area sign;
 *  result convex, flat [x0,z0,x1,z1,...], possibly empty). Deterministic. */
function clipTriInPolyXZ(tri, px, pz) {
  const n = px.length
  let a2 = 0
  for (let e = 0; e < n; e++) {
    const f = (e + 1) % n
    a2 += px[e] * pz[f] - px[f] * pz[e]
  }
  const s = a2 >= 0 ? 1 : -1 // inside = left of each edge, sign-corrected
  let cur = [[tri[0], tri[1]], [tri[2], tri[3]], [tri[4], tri[5]]]
  for (let e = 0; e < n; e++) {
    const f = (e + 1) % n
    const x0 = px[e], z0 = pz[e], x1 = px[f], z1 = pz[f]
    const next = []
    for (let i = 0; i < cur.length; i++) {
      const j = (i + 1) % cur.length
      const ax = cur[i][0], az = cur[i][1], bx = cur[j][0], bz = cur[j][1]
      const da = s * ((x1 - x0) * (az - z0) - (z1 - z0) * (ax - x0))
      const db = s * ((x1 - x0) * (bz - z0) - (z1 - z0) * (bx - x0))
      if (da >= -1e-12) next.push([ax, az])
      if ((da > 1e-12 && db < -1e-12) || (da < -1e-12 && db > 1e-12)) {
        const t = da / (da - db)
        next.push([ax + (bx - ax) * t, az + (bz - az) * t])
      }
    }
    if (next.length === 0) return []
    cur = next
  }
  const out = []
  for (const pt of cur) out.push(pt[0], pt[1])
  return out
}
