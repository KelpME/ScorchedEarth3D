// Navigation handle (P2-N1 → P2.6 W6a2): the api.nav CONTRACT over the
// Recast/Detour navmesh core (nav/navmesh.js). Since W6a2 the grid core
// (grid.js/astar.js) is RETIRED — every documented contract below is served
// by the navmesh layer, re-pinned in engine/test/nav-api.test.js.
//
// Contract (unchanged, documented in engine/docs/API.md):
//   findPath / isNavigable / cellStatus / obstacles / rebuild / markDirty /
//   dirty / version / autoTick / autoRebuildEnabled / links / config / rebind
//   (+ nearestWalkable(x, z, profile) — the snap seam the task pins;
//    meshes(profile) — the W6b viz/debug seam: the baked polygon geometry
//    per profile, draped world Y, rebuild-cached).
// All methods are SYNCHRONOUS (the navmesh module initialises its wasm at
// import time).
//
// P2-N4a: DYNAMIC OBSTACLE UPDATES (`markDirty`/`version`/`dirty` + the
// declared `autoRebuild`/`rebuildInterval` options fed by `autoTick(dt)`) and
// DECLARED OFF-MESH LINKS (`scene.nav.links` — jump/gate/ladder edges
// integrated into findPath as graph edges with exact-endpoint waypoints).
//
// SEMANTIC MAPPING grid → navmesh (the re-pin map lives with the tests):
//   - "walkable cell"            → a ground poly of the profile's mesh
//   - snap within 2 cells        → snap within 2 world units (the historical
//                                  2-cell radius at cellSize 1 — resolution
//                                  free; the cellSize leak class is dead)
//   - grid path = cell centers   → navmesh straight path DENSIFIED to ~1 unit
//                                  (same waypoint density), y stripped
//   - link edges with `cost`     → Detour off-mesh connections charged their
//                                  declared cost via per-link area costs
//   - profile slope/step gates   → per-profile bake (maxSlope→walkableSlope-
//                                  Angle, stepHeight→walkableClimb); a step
//                                  passes when ≤ stepHeight and a slope when
//                                  ≤ maxSlope — the historical rule, baked
//   - "the grid covers the       → resolved bounds clip the NAVMESH ITSELF
//      resolved bounds"            (polys outside are flagged off at bake)

import { createNavmesh, normalizeNavLinks } from './navmesh.js'
import {
  normalizeProfile, cellSlopeOk, DEFAULT_CAPABILITY_PROFILE,
} from './profile.js'

/** Legacy/XZ-only mesh: a null/absent profile means NO gates (the exact
 *  pre-P2.5-W3 behavior) — every slope/step/link passes. */
const PERMISSIVE_MESH_PROFILE = Object.freeze({
  radius: 0.5, height: 2, maxSlope: 89.9, stepHeight: 1e4, jumpHeight: 1e4,
})
// W6c-3: normalizeProfile KEEPS declared radius/height, so the mesh profile
// keys on its 'r|h' CLEARANCE CLASS (navmesh.js navmeshClassKey, rounded to 3
// decimals) and queries route to the caller's own class surface (lazy-baked
// on first use). Absent dims land on the DEFAULT class (0.5|2 —
// navmesh.js NAVMESH_CLASS_DEFAULT): legacy callers route exactly as before.
function meshProfile(profile) {
  return normalizeProfile(profile) || { ...PERMISSIVE_MESH_PROFILE }
}
import {
  collectTerrainSurfaces, sampleSurfaces, terrainFootprintXZ,
} from './terrain-query.js'
import {
  shapeFromCollider, shapeXZ, translateShape,
  readRotation, rotateOffset, colliderCenter,
} from '../physics/physics.js'

const DEFAULT_CELL_SIZE = 1
const DEFAULT_REBUILD_INTERVAL = 0.5 // sim seconds
/** World XZ distance around a query point for slope sampling (cellStatus) —
 *  the historical cellSize-1 neighborhood, now resolution-free. */
const SLOPE_SAMPLE_DIST = 1
/** P2-N4: derived-bounds margin — world units added on EACH side of the collider AABB. */
import { worldPositionOf } from './world-position.js'

export const BOUNDS_MARGIN = 2
/** P2-N4 stray-collider guard: max cells per axis for a DERIVED grid. */
export const MAX_GRID_AXIS_CELLS = 512

/** Validated bounds copy, or null. */
function validBounds(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null
  const { minX, minZ, maxX, maxZ } = b
  if (![minX, minZ, maxX, maxZ].every((v) => Number.isFinite(v))) return null
  if (!(minX < maxX) || !(minZ < maxZ)) return null
  return { minX, minZ, maxX, maxZ }
}

/** Validated world XZ point copy, or null. */
function validPoint(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return null
  return { x: p.x, z: p.z }
}

/**
 * Validate/normalize a nav config block ({ cellSize, bounds, autoRebuild,
 * rebuildInterval, links }) — the pure normalizeLayers-style seam.
 * `scene.nav` is the authoring truth. Defaults: cellSize 1, autoRebuild false,
 * rebuildInterval 0.5 sim-seconds, links []. Returns null for malformed input
 * (absent, non-object, INVALID GIVEN bounds, or non-positive/non-finite
 * cellSize); MISSING bounds is VALID (P2-N4: `bounds: null` = derive at rebuild
 * from the collider extents).
 * INVALID optional fields fall back to their defaults and each dropped link
 * entry is reported by `validateNav` (never silent).
 * @param {object} [raw]
 * @returns {{ cellSize: number, bounds: {minX,minZ,maxX,maxZ}|null, autoRebuild: boolean, rebuildInterval: number, links: Array }|null}
 */
export function normalizeNav(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  // P2-N4: bounds are OPTIONAL — missing means "derive at rebuild from the
  // world's collider extents"; an INVALID GIVEN bounds block still nulls.
  const bounds = raw.bounds === undefined ? null : validBounds(raw.bounds)
  if (raw.bounds !== undefined && !bounds) return null
  const cellSize = raw.cellSize === undefined ? DEFAULT_CELL_SIZE : raw.cellSize
  if (!Number.isFinite(cellSize) || cellSize <= 0) return null
  return {
    cellSize,
    bounds,
    autoRebuild: typeof raw.autoRebuild === 'boolean' ? raw.autoRebuild : false,
    rebuildInterval: Number.isFinite(raw.rebuildInterval) && raw.rebuildInterval > 0
      ? raw.rebuildInterval : DEFAULT_REBUILD_INTERVAL,
    links: normalizeNavLinks(raw.links),
  }
}

/**
 * Pure validation report for a nav block: one error line per invalid field /
 * per DROPPED link entry (the removed navmesh validate precedent). An absent block
 * (undefined/null) is legal -> [].
 * @param {object} [raw]
 * @returns {string[]}
 */
export function validateNav(raw) {
  if (raw === undefined || raw === null) return []
  if (typeof raw !== 'object' || Array.isArray(raw)) return ['nav: expected an object']
  const errs = []
  if (raw.bounds !== undefined && !validBounds(raw.bounds)) errs.push('nav.bounds: must be { minX, minZ, maxX, maxZ } with finite min < max')
  if (raw.cellSize !== undefined && (!Number.isFinite(raw.cellSize) || raw.cellSize <= 0)) {
    errs.push('nav.cellSize: must be a finite number > 0')
  }
  if (raw.autoRebuild !== undefined && typeof raw.autoRebuild !== 'boolean') {
    errs.push('nav.autoRebuild: must be a boolean')
  }
  if (raw.rebuildInterval !== undefined && (!Number.isFinite(raw.rebuildInterval) || raw.rebuildInterval <= 0)) {
    errs.push('nav.rebuildInterval: must be a finite number > 0')
  }
  if (raw.links !== undefined) {
    if (!Array.isArray(raw.links)) {
      errs.push('nav.links: must be an array')
    } else {
      raw.links.forEach((e, i) => {
        if (!e || typeof e !== 'object' || Array.isArray(e)) errs.push(`nav.links[${i}]: must be an object`)
        else if (!validPoint(e.from)) errs.push(`nav.links[${i}]: from must be a finite {x, z} point`)
        else if (!validPoint(e.to)) errs.push(`nav.links[${i}]: to must be a finite {x, z} point`)
        else if (e.from.x === e.to.x && e.from.z === e.to.z) errs.push(`nav.links[${i}]: from and to must differ`)
        else if (e.cost !== undefined && (!Number.isFinite(e.cost) || e.cost <= 0)) {
          errs.push(`nav.links[${i}]: cost must be a finite number > 0`)
        } else if (e.oneWay !== undefined && typeof e.oneWay !== 'boolean') {
          errs.push(`nav.links[${i}]: oneWay must be a boolean`)
        }
      })
    }
  }
  return errs
}

/**
 * The createGame `nav` option merged OVER scene.nav (authoring truth),
 * FIELD-WISE (API.md: "each valid option field wins"): per key {cellSize,
 * bounds, autoRebuild, rebuildInterval, links} the override's value wins when
 * valid, else scene.nav's, else the default (cellSize 1, autoRebuild false,
 * rebuildInterval 0.5, links []; bounds has no default -> null without valid
 * bounds). A {bounds}-only override must NOT reset a scene-authored cellSize.
 */
function resolveConfig(sceneNav, override) {
  const scene = (sceneNav && typeof sceneNav === 'object' && !Array.isArray(sceneNav)) ? sceneNav : {}
  const over = (override && typeof override === 'object' && !Array.isArray(override)) ? override : {}
  const pickBounds = (o) => validBounds(o.bounds)
  const pickCellSize = (o) => (Number.isFinite(o.cellSize) && o.cellSize > 0 ? o.cellSize : null)
  const pickAutoRebuild = (o) => (typeof o.autoRebuild === 'boolean' ? o.autoRebuild : null)
  const pickInterval = (o) => (Number.isFinite(o.rebuildInterval) && o.rebuildInterval > 0 ? o.rebuildInterval : null)
  const pickLinks = (o) => (Array.isArray(o.links) ? normalizeNavLinks(o.links) : null)
  // P2-N4: bounds has NO default — absent/invalid everywhere -> null, which
  // rebuild() DERIVES from the collider extents (+BOUNDS_MARGIN).
  const bounds = pickBounds(over) || pickBounds(scene) || null
  return {
    cellSize: pickCellSize(over) ?? pickCellSize(scene) ?? DEFAULT_CELL_SIZE,
    bounds,
    autoRebuild: pickAutoRebuild(over) ?? pickAutoRebuild(scene) ?? false,
    rebuildInterval: pickInterval(over) ?? pickInterval(scene) ?? DEFAULT_REBUILD_INTERVAL,
    links: pickLinks(over) ?? pickLinks(scene) ?? [],
  }
}

/**
 * XZ WORLD footprint of one entity's collider — via the existing physics
 * shape helpers (shapeFromCollider honors rotation; rotateOffset carries the
 * local center offset; translateShape positions; shapeXZ reads the footprint).
 * Position is the parent-chain-resolved WORLD position (a parented obstacle
 * rasterizes where it actually stands, not at its local transform).
 * Returns { id, minX, minZ, maxX, maxZ }.
 */
function footprintOf(world, id, rec) {
  const comps = (rec && rec.components) || {}
  const c = comps.collider
  const t = comps.transform || {}
  const rot = readRotation(t)
  const shape = shapeFromCollider(c, { render: comps.render, scale: t.scale, rotation: rot })
  const [ccx, ccy, ccz] = colliderCenter(c)
  const off = rotateOffset(ccx, ccy, ccz, rot)
  const w = worldPositionOf(world, id)
  translateShape(shape, w.x + off.x, w.y + off.y, w.z + off.z)
  const xz = shapeXZ(shape)
  return { id, minX: xz.minX, minZ: xz.minZ, maxX: xz.maxX, maxZ: xz.maxZ }
}

/**
 * Create the nav handle.
 * @param {{ world: object, scene?: object, nav?: object|true }} p
 *   `nav` (the createGame option) merges over `scene.nav`; `true` = scene.nav
 *   only. P2-N4: when neither yields EXPLICIT bounds the nav bounds are
 *   DERIVED at every rebuild from the XZ AABB of ALL collider entities
 *   (deterministic: stable sorted entity ids) + BOUNDS_MARGIN per side, clipped
 *   to MAX_GRID_AXIS_CELLS per axis around the derived center (stray-collider
 *   guard, warned ONCE). Only zero colliders + no explicit bounds -> EMPTY nav
 *   (isNavigable -> false, findPath -> null, obstacles() still lists
 *   footprints; warned ONCE). Explicit bounds are always honored and win.
 * @returns {{ findPath, obstacles, isNavigable, nearestWalkable, meshes, rebuild, markDirty, dirty, version, autoTick, autoRebuildEnabled, links, config }}
 */
export function createNav({ world, scene, nav: navOverride } = {}) {
  // LIVE-WORLD BINDING: world + config are MUTABLE — `rebind()` re-points them
  // at the current scene's world/config after a loadScene scene swap, so
  // api.nav never silently serves the previous world.
  let activeWorld = world
  let activeScene = scene
  let config = resolveConfig(scene && scene.nav, navOverride)
  let navmesh = null
  let footprints = []
  // P2.5 W3: terrain heightfield surfaces under the nav area (refreshed at
  // every rebuild — the source of cellStatus slopes, link Δh gates (baked by
  // the navmesh layer), and the derived-bounds terrain extents).
  let terrainSurfaces = []
  // P2-N4 derive state: the RESOLVED nav bounds of the last rebuild + whether
  // they were derived (config() reports both); warns fire ONCE per handle.
  let resolvedBounds = null
  let derivedFlag = false
  let clipWarned = false
  let emptyWarned = false
  // P2-N4a dynamic-rebuild state: `version` bumps on EVERY rebuild (manual
  // included); `dirty` marks the cached navmesh stale; `autoElapsed` accumulates
  // sim-seconds for the DECLARED autoRebuild option.
  let versionCount = 0
  let dirtyFlag = false
  let autoElapsed = 0
  // STEP 4B region state: rects queued by markDirty(rect) ride the next
  // rebuild; prevAllFootprints is the LAST rebuild's ALL-collider XZ
  // footprints (id -> rect) — the diff source for the entity-diff dirty rect.
  let pendingRects = []
  let prevAllFootprints = null
  /** Dirty-diff margin (world units): a changed footprint's rect is expanded
   *  by this on each side (a fixed 1-unit heuristic — NOT the agent radius +
   *  climb margin; the tile re-bake adds its own border-voxel margin on top,
   *  and a radius>1 profile under-covered at a tile edge is caught by the
   *  tile-grid drift guard / full rebuilds). */
  const DIRTY_DIFF_MARGIN = 1

  const rectValid = (r) => !!validBounds(r)
  function expandRect(r, m) {
    return { minX: r.minX - m, minZ: r.minZ - m, maxX: r.maxX + m, maxZ: r.maxZ + m }
  }
  /** Bounding-box union of valid rects (invalid entries skipped). */
  function unionRects(rects) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (const r of rects) {
      if (!rectValid(r)) continue
      if (r.minX < minX) minX = r.minX
      if (r.minZ < minZ) minZ = r.minZ
      if (r.maxX > maxX) maxX = r.maxX
      if (r.maxZ > maxZ) maxZ = r.maxZ
    }
    return Number.isFinite(minX) ? { minX, minZ, maxX, maxZ } : null
  }
  /** The entity-diff dirty rects: for every collider entity whose XZ
   *  footprint changed/appeared/disappeared since the last rebuild, its
   *  footprint expanded by DIRTY_DIFF_MARGIN (a changed object erodes
   *  walkability in its neighborhood). */
  function diffRects(cur) {
    const out = []
    if (!prevAllFootprints) return out
    for (const [id, f] of cur) {
      const p = prevAllFootprints.get(id)
      if (!p || p.minX !== f.minX || p.minZ !== f.minZ || p.maxX !== f.maxX || p.maxZ !== f.maxZ) {
        out.push(expandRect(f, DIRTY_DIFF_MARGIN))
      }
    }
    for (const f of prevAllFootprints.values()) {
      if (!cur.has(f.id)) out.push(expandRect(f, DIRTY_DIFF_MARGIN))
    }
    return out
  }

  /**
   * The SHARED scene-block predicate — the EXACT checks isNavigable applies
   * before the navmesh query: outside the resolved bounds, or inside an
   * INCLUSIVE nav-obstacle footprint column (a point exactly ON a footprint
   * edge is inside the blocked column — the rasterized-grid semantics the
   * isNavigable pin asserts). isNavigable, cellStatus and nearestWalkable's
   * post-validation all route through this (true-inverse seam: every snap
   * point this handle returns clears the SAME scene gate isNavigable uses).
   */
  function blockedByScene(x, z) {
    if (x < resolvedBounds.minX || x > resolvedBounds.maxX || z < resolvedBounds.minZ || z > resolvedBounds.maxZ) return true
    for (const f of footprints) {
      if (x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ) return true
    }
    return false
  }

  /** Deterministic standable-point search ring (mirrors navmesh.js
   *  nudgeRing — same order, same CORNER_EPS): the candidate itself first,
   *  then away-from-query, toward-query, then the 8 compass offsets at 1e-3.
   *  First pass wins. */
  function nudgeRing(qx, qz, x, z) {
    const out = [{ x, z }]
    let dx = x - qx
    let dz = z - qz
    const len = Math.hypot(dx, dz)
    if (len > 1e-12) {
      dx /= len
      dz /= len
      out.push({ x: x + dx * 1e-3, z: z + dz * 1e-3 })
      out.push({ x: x - dx * 1e-3, z: z - dz * 1e-3 })
    }
    const e = 1e-3
    out.push(
      { x: x + e, z }, { x: x - e, z }, { x, z: z + e }, { x, z: z - e },
      { x: x + e, z: z + e }, { x: x + e, z: z - e },
      { x: x - e, z: z + e }, { x: x - e, z: z - e },
    )
    return out
  }

  const handle = {
    /**
     * Path between two world points ({x,z}), snapped to walkable surface
     * within 2 world units. `profile` (P2.5 W3, optional) is the declared
     * agent capability { radius, height, maxSlope, stepHeight, jumpHeight }:
     * radius/height (W6c-3, documented fields) select the agent's CLEARANCE
     * CLASS — the path rides that body size's own surface (lazy-baked); when
     * omitted the query lands on the DEFAULT class (radius 0.5, height 2).
     * Adjacent-surface steps pass when BOTH sides' slope ≤ maxSlope OR |Δh| ≤
     * stepHeight, and links are gated on |Δh| ≤ jumpHeight. Omitted/null
     * profile = the permissive legacy mesh (the exact legacy XZ-only behavior
     * on flat ground) on the DEFAULT class. Returns [{x, z}, …] waypoints
     * (~1 unit spacing) or null (no complete path). Exact off-mesh link
     * endpoints appear as consecutive waypoints.
     */
    findPath(from, to, profile) {
      if (!navmesh || !resolvedBounds) return null
      // Invalid endpoints (missing/non-finite from/to) -> null, never throw.
      if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(from.z) ||
        !Number.isFinite(to.x) || !Number.isFinite(to.z)) return null
      const res = navmesh.findPath(from, to, meshProfile(profile))
      if (!res || !Array.isArray(res.points)) return null
      return res.points.map((p) => ({ x: p.x, z: p.z }))
    },
    /** Cached nav-obstacle footprints: [{ id, minX, minZ, maxX, maxZ }]. */
    obstacles: () => footprints.map((f) => ({ ...f })),
    /**
     * True when world (x, z) stands on walkable navmesh surface (P2.5 W3:
     * with a `profile`, the surface must also pass the slope gate — slope ≤
     * maxSlope). W6c-3: the profile's radius/height route the query to the
     * caller's CLEARANCE CLASS (a narrow gap can be standable for a thin
     * agent and blocked for a fat one); omitted dims = the DEFAULT class
     * (0.5|2). Outside the resolved nav bounds is always false. No
     * terrain-height gate: walkable `nav-surface` platforms above the terrain
     * are navigable (W6a2 finding 2 keeps OBSTACLE tops off the mesh).
     */
    isNavigable(x, z, profile) {
      if (!navmesh || !resolvedBounds) return false
      if (!Number.isFinite(x) || !Number.isFinite(z)) return false
      // Blocked COLUMN over any nav-obstacle footprint (the rasterized-grid
      // semantics the isNavigable pin asserts): not standable at ANY height.
      if (blockedByScene(x, z)) return false
      return navmesh.isNavigable(x, z, meshProfile(profile))
    },
    /**
     * The nearest walkable world point ({x, z}) within 2 world units of
     * (x, z), or null (W6a2: the api.nav snap seam — the historical
     * nearestWalkable-grid scan re-pinned onto the navmesh). W6c-3: snaps on
     * the caller's CLEARANCE CLASS (profile.radius/height; omitted dims = the
     * DEFAULT class). TRUE INVERSE of isNavigable: the navmesh snap is
     * POST-VALIDATED against the SAME checks isNavigable applies (bounds +
     * inclusive obstacle footprints via blockedByScene + navmesh standability)
     * — a hole-corner point exactly ON a footprint edge is deterministically
     * nudged clear (nudgeRing order, first pass wins) and the returned point
     * keeps the 2-world-unit seam bound (<= 2.001).
     */
    nearestWalkable(x, z, profile) {
      if (!navmesh || !resolvedBounds) return null
      const p = meshProfile(profile)
      const snap = navmesh.nearestWalkable(x, z, p)
      if (!snap) return null
      for (const c of nudgeRing(x, z, snap.x, snap.z)) {
        if (Math.hypot(c.x - x, c.z - z) > 2.001) continue
        if (blockedByScene(c.x, c.z)) continue
        if (!navmesh.isNavigable(c.x, c.z, p)) continue
        return { x: c.x, z: c.z }
      }
      return null
    },
    /**
     * P2.5 W3 viz/diagnostic classification of the point under world (x, z):
     *   'walkable'        — stands fine for the profile,
     *   'blocked-collider'— outside the nav bounds or blocked by a nav-obstacle,
     *   'blocked-slope'   — terrain slope > profile.maxSlope (reachable only
     *                       via a ≤ stepHeight step from a neighbor).
     * `profile` accepts the documented { radius, height, maxSlope, stepHeight,
     * jumpHeight } fields (W6c-3): radius/height are validated/carried (the
     * clearance class they select governs the mesh queries — findPath/
     * isNavigable/nearestWalkable); this terrain classification is
     * class-independent. Omitted `profile` classifies against the DEFAULT
     * capability profile (the nav-agent component defaults, 45°/0.5/1); pass
     * null for the permissive legacy classification (never 'blocked-slope').
     */
    cellStatus(x, z, profile) {
      const prof = profile === undefined ? { ...DEFAULT_CAPABILITY_PROFILE } : normalizeProfile(profile)
      if (!navmesh || !resolvedBounds) return 'blocked-collider'
      if (!Number.isFinite(x) || !Number.isFinite(z)) return 'blocked-collider'
      if (blockedByScene(x, z)) return 'blocked-collider'
      const slope = surfaceSlopeAt(x, z)
      if (prof && !cellSlopeOk(slope, prof)) return 'blocked-slope'
      return 'walkable'
    },
    /** Re-query nav-obstacle colliders and rebuild the cached navmesh. */
    rebuild,
    /**
     * Flag the cached navmesh STALE (an obstacle moved/appeared). STEP 4B
     * REGION FORM: an optional world-XZ rect ({ minX, minZ, maxX, maxZ })
     * records WHERE the change happened — the next rebuild then re-bakes
     * only the tiles the (margin-expanded) region touches. No argument =
     * the legacy whole-scene stale flag. A rebuild — manual, auto
     * (`autoTick` while `autoRebuild` is declared), or rebind — clears the
     * flag (and the queued rects).
     */
    markDirty(rect) {
      const r = validBounds(rect)
      if (r) pendingRects.push(r)
      dirtyFlag = true
      return handle
    },
    /** True while the cached navmesh is flagged stale (see markDirty). */
    dirty: () => dirtyFlag,
    /** Integer, +1 on EVERY successful rebuild (manual rebuild() included). */
    version: () => versionCount,
    /**
     * Sim-time feed for the DECLARED `scene.nav.autoRebuild` option: while
     * dirty, re-scans + rebuilds at most every `rebuildInterval` sim
     * seconds (ONE rebuild per interval, never per tick). Inert without the
     * declared option (the P2-N1 no-auto-rebuild guard stands otherwise).
     */
    autoTick(dt) {
      if (!config || !config.autoRebuild || !dirtyFlag) {
        autoElapsed = 0
        return handle
      }
      autoElapsed += Number.isFinite(dt) && dt > 0 ? dt : 0
      if (autoElapsed >= config.rebuildInterval) {
        autoElapsed = 0
        rebuild()
      }
      return handle
    },
    /** True when the resolved config declared autoRebuild (game.js's cheap gate). */
    autoRebuildEnabled: () => !!(config && config.autoRebuild),
    /** The normalized off-mesh links: [{ from, to, cost, oneWay }] (cost
     *  defaults to the euclid XZ distance of the endpoints). */
    links: () => (config ? config.links.map((l) => ({ from: { ...l.from }, to: { ...l.to }, cost: l.cost, oneWay: l.oneWay })) : []),
    /**
     * W6b VIZ/DEBUG SEAM — the baked polygon geometry:
     *   [{ key, profile, positions: Float32Array, indices: Uint32Array,
     *      polyCount, links: [{ from:{x,y,z}, to:{x,y,z}, cost, oneWay }] }]
     * `positions` are WORLD XYZ carrying the bake's REAL world Y (the draped
     * surface — terrain heights baked in); `links` are the off-mesh
     * connections baked into THAT profile's mesh with draped endpoint Y.
     * `profile` given -> exactly the mesh findPath uses for it (meshProfile
     * normalization — W6c-3: its radius/height select the CLEARANCE CLASS,
     * keyed 'r|h'; a null/absent profile = the permissive legacy mesh on the
     * DEFAULT class); NO argument -> every cached bake (lazily baking the
     * default capability mesh when nothing is baked yet). REBUILD-CACHED: the
     * same READ-ONLY objects (stable identity, zero per-call allocation)
     * until the next rebuild()/rebind(). Never throws ([] on an empty nav
     * area).
     */
    meshes(profile) {
      if (!navmesh) return []
      try {
        return navmesh.meshes(profile === undefined ? undefined : meshProfile(profile))
      } catch {
        return []
      }
    },
    /**
     * T7a GROUNDING SEAM — the shared source-faithful surface Y at (x, z):
     * the real source face covering the point whose Y is nearest `yHint`
     * (the body's ground-contact Y estimate — stacked surfaces pick the
     * layer the agent is ALREADY on); no hint = the topmost face
     * (back-compat). terrain grid-node triangles AND primitive face-plane
     * tops — box platforms ground agents too. else null (a body over no
     * surface keeps its y — legacy).
     */
    surfaceY(x, z, yHint) {
      if (!navmesh || !Number.isFinite(x) || !Number.isFinite(z)) return null
      try {
        return navmesh.surfaceY(x, z, yHint)
      } catch {
        return null
      }
    },
    /**
     * Re-point the handle at a NEW world/scene/config (scene swap): clears the
     * cached navmesh + footprints, re-resolves the config (scene.nav with the
     * createGame override merged over it) and rebuilds against the new world.
     */
    rebind({ world: w, scene: s, nav: override } = {}) {
      if (w) activeWorld = w
      if (s !== undefined) activeScene = s
      if (s !== undefined || override !== undefined) config = resolveConfig(s && s.nav, override)
      navmesh = null
      footprints = []
      return rebuild()
    },
    /**
     * The resolved config: { cellSize, bounds, derived } — `bounds` is the
     * RESOLVED nav bounds (explicit or derived/clipped), null only on an empty
     * nav area (zero colliders + no explicit bounds); `derived` is true iff
     * the bounds were derived at the last rebuild. `cellSize` is the
     * AUTHORING knob (the bake resolution is internal + profile-safe — see
     * nav/navmesh.js; verdicts never depend on it).
     */
    config: () => (config ? { cellSize: config.cellSize, bounds: resolvedBounds ? { ...resolvedBounds } : null, derived: derivedFlag } : null),
  }

  /**
   * P2-N4 AAA-style derive: the XZ AABB of ALL collider entities (deterministic
   * — stable sorted entity ids) grown by BOUNDS_MARGIN on each side. A derived
   * extent over MAX_GRID_AXIS_CELLS * cellSize clips symmetrically around the
   * derived center (warned ONCE per handle). Zero colliders -> null (empty
   * grid, warned ONCE per handle).
   */
  function deriveBounds() {
    const ids = [...activeWorld.query({ has: ['collider'] })].sort()
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (const id of ids) {
      const f = footprintOf(activeWorld, id, activeWorld.entity(id))
      if (f.minX < minX) minX = f.minX
      if (f.minZ < minZ) minZ = f.minZ
      if (f.maxX > maxX) maxX = f.maxX
      if (f.maxZ > maxZ) maxZ = f.maxZ
    }
    // P2.5 W3: terrain heightfield extents join the coverage derivation —
    // hills are walkable surface and must sit INSIDE the nav area.
    for (const t of terrainSurfaces) {
      const f = terrainFootprintXZ(t)
      if (f.minX < minX) minX = f.minX
      if (f.minZ < minZ) minZ = f.minZ
      if (f.maxX > maxX) maxX = f.maxX
      if (f.maxZ > maxZ) maxZ = f.maxZ
    }
    if (ids.length === 0 && terrainSurfaces.length === 0) {
      if (!emptyWarned) {
        emptyWarned = true
        console.warn('[nav] no colliders and no explicit nav.bounds — empty nav grid')
      }
      return null
    }
    const b = {
      minX: minX - BOUNDS_MARGIN, minZ: minZ - BOUNDS_MARGIN,
      maxX: maxX + BOUNDS_MARGIN, maxZ: maxZ + BOUNDS_MARGIN,
    }
    // Stray-collider guard: clip each oversized axis symmetrically around the
    // derived center to MAX_GRID_AXIS_CELLS * cellSize.
    const maxExtent = MAX_GRID_AXIS_CELLS * (config ? config.cellSize : DEFAULT_CELL_SIZE)
    const cx = (b.minX + b.maxX) / 2
    const cz = (b.minZ + b.maxZ) / 2
    let clipped = false
    if (b.maxX - b.minX > maxExtent) { b.minX = cx - maxExtent / 2; b.maxX = cx + maxExtent / 2; clipped = true }
    if (b.maxZ - b.minZ > maxExtent) { b.minZ = cz - maxExtent / 2; b.maxZ = cz + maxExtent / 2; clipped = true }
    if (clipped && !clipWarned) {
      clipWarned = true
      console.warn(`[nav] derived nav bounds exceed ${MAX_GRID_AXIS_CELLS} cells per axis — clipped around the derived center (stray collider?)`)
    }
    return b
  }

  /**
   * Terrain slope at world (x, z) in degrees — the steepest gradient over the
   * 8-neighborhood at SLOPE_SAMPLE_DIST (the historical cellSize-1 formula,
   * resolution-free). 0 with no terrain under the point.
   */
  function surfaceSlopeAt(x, z) {
    const h0 = sampleSurfaces(terrainSurfaces, x, z)
    const base = h0.inside ? h0.y : 0
    let g = 0
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        const s = sampleSurfaces(terrainSurfaces, x + dx * SLOPE_SAMPLE_DIST, z + dz * SLOPE_SAMPLE_DIST)
        const dist = SLOPE_SAMPLE_DIST * (dx !== 0 && dz !== 0 ? Math.SQRT2 : 1)
        const grad = Math.abs((s.inside ? s.y : 0) - base) / dist
        if (grad > g) g = grad
      }
    }
    return Math.atan(g) * 180 / Math.PI
  }

  /**
   * Rebuild the cached navmesh. STEP 4B REGION FORM: an optional dirty rect
   * ({minX, minZ, maxX, maxZ}) — or rects queued by markDirty(rect), or the
   * entity-footprint diff against the last rebuild — drives a PARTIAL
   * dirty-tile re-bake (only the touched tiles re-bake; untouched tiles keep
   * their Detour data). A full re-bake runs when no region can be determined
   * (the safe fallback) or when the navmesh core rejects the region (raster
   * grid drift — e.g. the change moved the derived nav bounds). Both paths
   * refresh terrain + obstacle footprints + resolved bounds and bump version.
   * @param {{minX,minZ,maxX,maxZ}} [rect] optional dirty region
   */
  function rebuild(rect) {
    terrainSurfaces = collectTerrainSurfaces(activeWorld)
    const ids = activeWorld.query({ has: ['collider'], tags: ['nav-obstacle'] })
    footprints = ids.map((id) => footprintOf(activeWorld, id, activeWorld.entity(id)))
    // P2-N4: explicit bounds are honored and win; otherwise DERIVE.
    let bounds = config ? config.bounds : null
    derivedFlag = false
    if (!bounds) {
      bounds = deriveBounds()
      derivedFlag = true
    }
    resolvedBounds = bounds ? { ...bounds } : null
    // STEP 4B: ALL-collider XZ footprints for the entity-diff dirty rect.
    // TOLERANT: an unshapable collider (unknown shape etc.) contributes no
    // diff rect — the test suite pins unknown shapes never throwing.
    const curAll = new Map()
    for (const id of activeWorld.query({ has: ['collider'] })) {
      try {
        curAll.set(id, footprintOf(activeWorld, id, activeWorld.entity(id)))
      } catch { /* not footprintable — no diff rect from it */ }
    }
    const diff = diffRects(curAll)
    // Region determination: explicit rect > queued markDirty(rect) rects >
    // the entity diff. No region (or none needed) = the full-rebuild fallback.
    const region = unionRects([
      validBounds(rect) || null,
      ...pendingRects,
      ...((dirtyFlag || validBounds(rect) || pendingRects.length) ? diff : []),
    ])
    // PARTIAL PATH: only when a region is determined AND the navmesh core
    // accepts it (grid-compatible). Never on the first build (prevAllFootprints
    // is null → diff empty; navmesh null anyway).
    if (navmesh && region && (validBounds(rect) || pendingRects.length || (dirtyFlag && diff.length))) {
      try {
        if (navmesh.rebuildRegion(region)) {
          versionCount++
          dirtyFlag = false
          autoElapsed = 0
          pendingRects = []
          prevAllFootprints = curAll
          return handle
        }
      } catch {
        // fall through to the full rebuild
      }
    }
    // Fresh navmesh layer against the CURRENT world + resolved bounds (the
    // bake itself is lazy per profile).
    navmesh = resolvedBounds ? createNavmesh({
      world: activeWorld,
      scene: { ...(activeScene || {}), nav: { links: config ? config.links : [] } },
      bake: {
        cellSize: config ? config.cellSize : DEFAULT_CELL_SIZE,
        bounds: () => resolvedBounds,
      },
    }) : null
    versionCount++
    dirtyFlag = false
    autoElapsed = 0
    pendingRects = []
    prevAllFootprints = curAll
    return handle
  }

  rebuild()
  return handle
}
