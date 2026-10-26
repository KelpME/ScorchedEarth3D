/**
 * Engine built-in `flock` gameplay script — a REGION-based boids tool.
 *
 * The engine-owns-tools counterpart to camera-rig / audio-emitter. Attach it to
 * a GameObject (the "flock region") and ALL boid data + behavior live on that
 * entity's `scripts` component params — shape, size, count, member archetype,
 * and the
 * flocking weights — so the editor's Flock popup is just a SPAWNER and the human
 * edits everything in the inspector. Multiple regions = multiple GameObjects,
 * each driving its own children.
 *
 * Data model (all on the region entity):
 *   - `transform` = the volume CENTER (move the region with the translate gizmo).
 *     The region is a PURE CONTAINER: transform is position-only (scale is
 *     ALWAYS identity) and it carries NO collider — the flock params are the
 *     one and only containment/size authority.
 *   - `scripts: [{ name:'flock', params:{ shape, sizeX/Y/Z, count, archetypeId,
 *     axis, separation, alignment, cohesion, boundary, viewRadius, avoidRadius,
 *     cruiseSpeed, turnRate, wander } }]`
 *
 * The script SPAWNS `count` members as CHILDREN of the region entity (so they
 * nest in the hierarchy), each an ARCHETYPE INSTANCE of the archetype named by
 * `params.archetypeId` (spawned through `api.spawnArchetype` — the scene-load
 * hydration path: the member carries `archetypeId` on its entity record, the
 * archetype's declared components come WITH it, and the spawn point is the
 * placement transform override) + a `fish` component (region + velocity/
 * heading). Members whose archetype does NOT author a `collider` get one
 * DERIVED at spawn from the resolved model's actual bbox (so what you see = what
 * collides). On each fixed step it drives them with smooth-heading flocking in
 * REGION-LOCAL space (region center = origin) and keeps them inside the shape's
 * containment. onDetach destroys the region's members.
 *
 * THE DESIGN RULES (encoded, do not regress):
 *   1. SMOOTH HEADING — never derive yaw from a raw velocity vector (the
 *      "spinning in place" bug). Keep a persistent heading + cruise speed and
 *      turn toward the steering direction at `turnRate`.
 *   2. CROSS-REGION SEPARATION — fish avoid fish across ALL regions, not just
 *      their own. Regions commonly OVERLAP (e.g. 4 model-variant flocks in one
 *      tank), so separation must be computed against every fish in the scene in
 *      WORLD space (region center + local offset), while cohesion + alignment
 *      stay per-region (so each school stays a coherent, distinct school). A
 *      fish from another region is just another obstacle.
 *   3. COLLIDER — DECLARATION WINS, DERIVATION IS THE FALLBACK. A member is
 *      spawned as an archetype INSTANCE: if the member's archetype authors a
 *      `collider`, that DECLARED collider is used as-is (the scale/shape is
 *      visible in the archetype file — no hidden numbers). If the archetype
 *      does NOT author one, the member's collider half-extents are DERIVED
 *      AT SPAWN from the resolved model's measured bbox
 *      (`api.modelBounds(modelName)` — the renderer's registry, which already
 *      includes the manifest pack scale) × the member's transform.scale
 *      (which carries the archetype's DECLARED render scale after hydration).
 *      There are NO measured scale params on the schema — a measured number is
 *      never authored; the fallback keeps what-you-see-is-what-collides BY
 *      CONSTRUCTION. Until the renderer has measured the model (first frame
 *      after boot), the member has no collider yet; a later update derives it
 *      (see deriveFishColliders). Separation uses the resolved size.
 *   4. WANDER — a small slow heading drift so boids don't fall into perfect
 *      circles; they meander organically.
 *   5. MODEL FORWARD AXIS — the engine's yaw convention is +Z forward; a model
 *      whose nose isn't +Z must be rotated at import (rotationY). This script
 *      only sets yaw/pitch.
 *   6. AXIS-AWARE — xz keeps y fixed (fish/bees); xyz steers vertically (birds).
 *
 * Pure data + closure state; no DOM / no Three import — Node-vitestable.
 */
const GRID = 3.0 // spatial-hash cell size (neighbor lookup)
// Max heading turn rate (rad/s) at full speed. The actual turn is scaled by how
// fast the fish is moving, so a resting fish barely turns and a fast fish banks.
const TURN_RATE_DEFAULT = 2.2

import { worldPositionOf } from '../nav/world-position.js'

/** Per-region state: regionId -> { fish: Set<id>, archetypeId: string }. */
const flockState = new Map()

/** Reset per-region state (scene reload so stale ids never leak). */
export function resetFlockState() {
  flockState.clear()
}

export const flockScript = {
  params: {
    shape: { type: 'string', default: 'box', label: 'Shape', options: ['box', 'cylinder', 'sphere', 'custom'] },
    // Shape-model + size fields are shape-aware: `visibleWhen` tells the
    // inspector to show a field only when another param matches (see
    // editor/src/inspectorScripts.js paramField). shapeModel is only for
    // `custom`; the size fields are hidden for `custom` because the size is
    // defined by the chosen shape model.
    shapeModel: { type: 'string', default: '', label: 'Shape model (custom)', model: true, visibleWhen: { shape: 'custom' } },
    sizeX: { type: 'number', default: 3.2, label: 'Size X (width / diameter)', visibleWhen: { shape: 'not:custom' } },
    sizeY: { type: 'number', default: 1.6, label: 'Size Y (height)', visibleWhen: { shape: 'not:custom' } },
    sizeZ: { type: 'number', default: 3.2, label: 'Size Z (depth)', visibleWhen: { shape: 'not:custom' } },
    count: { type: 'number', default: 20, label: 'Fish count' },
    // ARCHETYPE-FIRST members: every spawned member is an INSTANCE of this
    // archetype (its id in the game's archetype set — chosen from a real-data
    // picker, never free text). The archetype declares the member's render
    // (modelName + scale) and, when authored, its collider — visible in the
    // archetype file, inherited by every member. No model-name refs.
    archetypeId: { type: 'string', default: '', label: 'Member archetype', archetype: true },
    // NOTE: no measured fish-size params. A member's collider comes WITH the
    // archetype (when the archetype authors one) or is DERIVED at spawn from
    // the resolved model's measured bbox (the renderer's model registry, which
    // already carries the manifest pack scale) × the member's transform.scale
    // (the archetype's DECLARED scale, migrated onto the instance at
    // hydration) — never an authored number.
    axis: { type: 'string', default: 'xz', label: 'Axis', options: ['xz', 'xyz'] },
    separation: { type: 'number', default: 1.0, label: 'Separation' },
    alignment: { type: 'number', default: 1.0, label: 'Alignment' },
    cohesion: { type: 'number', default: 1.0, label: 'Cohesion' },
    boundary: { type: 'number', default: 2.5, label: 'Wall avoid' },
    viewRadius: { type: 'number', default: 2.2, label: 'View radius' },
    avoidRadius: { type: 'number', default: 1.1, label: 'Avoid radius' },
    cruiseSpeed: { type: 'number', default: 1.2, label: 'Min speed' },
    maxSpeed: { type: 'number', default: 1.8, label: 'Max speed' },
    maxSteerForce: { type: 'number', default: 3.0, label: 'Max steer force' },
    // Wander: slow random velocity drift so boids meander, not circle.
    wander: { type: 'number', default: 0.4, label: 'Wander (steer)' },
    // Activity model: only `activeCount` fish actively swim as a school; the
    // rest REST (near-stationary, drifting/turning occasionally) and yield out
    // of the way when the moving school swims past. The active subset rotates
    // every `activeSwapSecs` so different fish take turns schooling.
    activeCount: { type: 'number', default: 5, label: 'Active swimmers (max in school)' },
    restSpeed: { type: 'number', default: 0.2, label: 'Rest speed (max)' },
    yieldWeight: { type: 'number', default: 2.5, label: 'Yield (resting fish move aside)' },
    activeSwapSecs: { type: 'number', default: 6, label: 'Swap active school (s)' },
    // Obstacle avoidance: fish steer away from ANY scene entity tagged with
    // `obstacleTag`. Dynamically tag objects (props, rocks, pumps, plants) in
    // the editor and fish will avoid them — no code change needed. Empty tag
    // disables obstacle avoidance.
    obstacleTag: { type: 'string', default: '', label: 'Obstacle tag (avoid these)' },
    obstacleAvoidDist: { type: 'number', default: 0.8, label: 'Obstacle avoid distance' },
    obstacleWeight: { type: 'number', default: 6.0, label: 'Obstacle avoid weight' },
    // Vertical drift: in BOTH axis modes fish occasionally change elevation
    // within the region's Y band (minY..maxY), so a school isn't pinned to one
    // depth. `verticalDrift` (0-1) is how strongly they wander up/down.
    verticalDrift: { type: 'number', default: 0.3, label: 'Vertical drift (0-1)' },
  },

  onAttach(id) {
    if (!flockState.has(id)) flockState.set(id, { fish: new Set(), archetypeId: null, active: new Set(), activeTimer: 0 })
  },

  update(dt, api, id, p) {
    const st = flockState.get(id)
    if (!st) return
    const W = p || {}
    if (!st.fish) st.fish = new Set()

    // Reconcile the child count + archetype so inspector edits take effect live.
    reconcile(api, id, st, W)
    if (st.fish.size === 0) return
    // Derive any member collider still missing its model bbox (the archetype
    // authored none and spawn raced the renderer's first model registration —
    // the next update fills it).
    deriveFishColliders(api, st)

    const axis3 = W.axis === 'xyz'
    const bounds = computeBounds(api, id, W)
    const regionCenter = regionCenterOf(api, id)

    // Gather ALL fish in the scene (every region) with their WORLD positions.
    // Separation must see fish from other regions too — overlapping regions
    // (e.g. 4 model-variant flocks in one tank) would otherwise let fish from
    // different schools pass through each other.
    const all = gatherAll(api, regionCenterOf) // regionId -> its center resolve
    if (all.length < 2) return

    // Gather obstacles (entities tagged `W.obstacleTag`) once per update so fish
    // steer away from them. Empty tag → no obstacles.
    const obstacles = W.obstacleTag ? gatherObstacles(api, W.obstacleTag) : []

    // Spatial-hash grid over WORLD XZ for O(n) neighbor lookup.
    const grid = new Map()
    const key = (cx, cz) => cx * 100000 + cz
    for (const f of all) {
      const k = key(Math.floor(f.wx / GRID), Math.floor(f.wz / GRID))
      if (!grid.has(k)) grid.set(k, [])
      grid.get(k).push(f)
    }

    // Refresh the ACTIVE set (which fish are currently swimming as the school).
    // Only `activeCount` fish are active; the rest rest. The active subset
    // rotates every `activeSwapSecs` so different fish take turns schooling.
    refreshActive(id, st, all, W, dt)

    const limit = (av, max) => {
      const m = Math.abs(av)
      return m > max && m > 0 ? av * (max / m) : av
    }

    // Drive ONLY this region's own fish (each region owns its children).
    const members = st.fish
    for (const fid of members) {
      const rec = api.entity(fid)
      if (!rec) continue
      const tf = rec.components && rec.components.transform
      const fc = rec.components && rec.components.fish
      if (!tf) continue
      // A fish ALWAYS swims forward along its heading — it never moves sideways
      // or backwards. The heading is the single state; velocity is always
      // `cruiseSpeed * forward(heading)`. Steering picks a DESIRED heading and
      // the fish turns toward it at a bounded rate (smooth bank). Resting fish
      // swim forward slowly (restSpeed) along their heading, drifting gently.
      const heading = (fc && fc.heading != null) ? fc.heading : (tf.yaw || 0)
      const f = {
        id: fid,
        x: tf.x, y: tf.y, z: tf.z,
        wx: regionCenter.x + tf.x, wy: regionCenter.y + tf.y, wz: regionCenter.z + tf.z,
        heading,
        active: st.active.has(fid),
        // Per-fish avoidance radius from its collider (half-extent) — the body
        // size so fish don't overlap. Derived at spawn from the model bbox; 0
        // only while the model hasn't been measured yet.
        radius: (rec.components && rec.components.collider && rec.components.collider.hx) || 0,
      }
      const cruiseSpeed = W.cruiseSpeed
      const turnRate = TURN_RATE_DEFAULT

      // --- Neighbor accumulation (compute-shader equivalent) ---
      // Perceived flockmates: heading, centre, separation. Separation sees ALL
      // fish (cross-region); alignment + cohesion stay per-region.
      // `ax/az` = avoidance vs EVERY fish (used by active fish separation).
      // `mx/mz` = avoidance vs only ACTIVE (moving) fish (used by resting fish
      // yield — a resting fish yields out of the way of the swimming school,
      // but ignores other resting fish so they don't jostle each other).
      let fhx = 0, fhz = 0, nFlock = 0        // avg heading (same region)
      let ccx = 0, ccz = 0, nCoh = 0           // centre of flockmates
      let ax = 0, az = 0                        // avoidance (all)
      let mx = 0, mz = 0                        // avoidance (active movers only)
      // Nearest-neighbor heading (for resting fish): average heading of the
      // closest ~3 neighbors, regardless of region, within a small radius.
      let nhx = 0, nhz = 0, nNeigh = 0
      const r2 = W.viewRadius * W.viewRadius
      const avoidR = W.avoidRadius || (W.viewRadius * 0.5)
      const ar2 = avoidR * avoidR
      // Radius for "immediate neighbors" = min(avoidR, ~2.5x body radius).
      const neighR = Math.min(avoidR, f.radius * 2.5)
      const nr2 = neighR * neighR
      const minCx = Math.floor((f.wx - W.viewRadius) / GRID)
      const maxCx = Math.floor((f.wx + W.viewRadius) / GRID)
      const minCz = Math.floor((f.wz - W.viewRadius) / GRID)
      const maxCz = Math.floor((f.wz + W.viewRadius) / GRID)
      for (let gx = minCx; gx <= maxCx; gx++) {
        for (let gz = minCz; gz <= maxCz; gz++) {
          const cell = grid.get(key(gx, gz))
          if (!cell) continue
          for (const o of cell) {
            if (o.id === f.id) continue
            const dx = o.wx - f.wx
            const dz = o.wz - f.wz
            const sqrDst = dx * dx + dz * dz
            if (sqrDst > r2) continue
            // Nearest-neighbor heading (immediate neighbors, any region).
            if (sqrDst < nr2) {
              nhx += Math.sin(o.heading)
              nhz += Math.cos(o.heading)
              nNeigh++
            }
            // Perceived flockmate (any region): affects heading + centre (but
            // only counted for THIS region's cohesion below).
            if (sqrDst < ar2) {
              // Lague separation: -= offset / sqrDst (magnitude falls off).
              // offset = neighbor - me, so subtraction pushes AWAY.
              const inv = 1 / (sqrDst + 1e-4)
              ax -= dx * inv
              az -= dz * inv
              if (o.active) { mx -= dx * inv; mz -= dz * inv }
            }
            if (o.region === id) {
              // Alignment: avg neighbor heading.
              fhx += Math.sin(o.heading)
              fhz += Math.cos(o.heading)
              nFlock++
              // Cohesion: avg neighbor position.
              ccx += o.wx; ccz += o.wz; nCoh++
            }
          }
        }
      }

      // --- Steering: compute a DESIRED heading (angle) from the behaviors ---
      // The fish always swims forward; steering just picks which way. We sum
      // weighted direction vectors, then the desired heading is their angle.
      let dirX = 0, dirZ = 0
      // Resting-fish yield displacement (applied to position below).
      let yieldDX = 0, yieldDZ = 0
      if (f.active) {
        // ACTIVE FISH — full boids school.
        if (nCoh > 0) {
          let gx = ccx / nCoh - f.wx, gz = ccz / nCoh - f.wz
          const gm = Math.hypot(gx, gz) || 1
          dirX += gx / gm * W.cohesion; dirZ += gz / gm * W.cohesion
        }
        if (nFlock > 0) {
          const am = Math.hypot(fhx, fhz) || 1
          dirX += fhx / am * W.alignment; dirZ += fhz / am * W.alignment
        }
        // Separation (cross-region) — active fish avoid everyone.
        const sm = Math.hypot(ax, az) || 1
        dirX += ax / sm * W.separation; dirZ += az / sm * W.separation
      } else {
        // RESTING FISH — STILL (don't move), but they face the average heading
        // of their immediate neighbors (a natural resting posture). A resting
        // fish holds its current orientation for 6-13s, THEN picks a new target
        // (the average of its immediate neighbors right now) and rotates to it
        // over a few seconds, then holds again. So it mostly faces its neighbors
        // but only occasionally re-orients — never twitching frame-to-frame.
        if (fc.restHold == null) fc.restHold = 6 + Math.random() * 7
        fc.restTimer = (fc.restTimer || 0) + dt
        if (fc.restTimer >= fc.restHold) {
          // Time to decide a new orientation: lock the immediate-neighbor
          // average as the new resting target (or keep current if no neighbors).
          if (nNeigh > 0) {
            const nm = Math.hypot(nhx, nhz) || 1
            fc.restTarget = Math.atan2(nhx / nm, nhz / nm)
          } else {
            fc.restTarget = null // no reference — stay as-is
          }
          fc.restTimer = 0
          fc.restHold = 6 + Math.random() * 7
        }
        // Aim at the locked resting target (rotating slowly toward it), else
        // hold the current heading.
        if (fc.restTarget != null) {
          dirX += Math.sin(fc.restTarget)
          dirZ += Math.cos(fc.restTarget)
        } else {
          dirX += Math.sin(f.heading)
          dirZ += Math.cos(f.heading)
        }
      }

      // Obstacle avoidance (tagged scene objects) — both states. A near obstacle
      // adds a strong repulsion to the desired heading.
      if (obstacles.length) {
        const avoidD = (W.obstacleAvoidDist || 0.8) + f.radius
        let ox = 0, oz = 0
        for (const ob of obstacles) {
          const dx = f.wx - ob.wx
          const dz = f.wz - ob.wz
          const reach = avoidD + (ob.radius || 0)
          const d2 = dx * dx + dz * dz
          if (d2 > reach * reach || d2 === 0) continue
          const d = Math.sqrt(d2)
          const push = (reach - d) / reach
          ox += (dx / d) * push
          oz += (dz / d) * push
        }
        const om = Math.hypot(ox, oz)
        if (om > 0) { dirX += ox / om * (W.obstacleWeight || 6.0); dirZ += oz / om * (W.obstacleWeight || 6.0) }
      }

      // Wall avoidance (region containment) as a desired-heading force.
      const bsteer = { x: 0, z: 0, y: 0 }
      addBoundarySteer(bounds, W, { x: f.x, y: f.y, z: f.z }, bsteer)
      dirX += bsteer.x; dirZ += bsteer.z

      // Wander: a small slowly-evolving heading drift so fish meander. Resting
      // fish get a tiny wander (slow, gentle turn); active fish more.
      if (W.wander) {
        const w = Number(W.wander) || 0
        const wScale = f.active ? 1 : 0.25
        if (fc.headingDrift == null) fc.headingDrift = Math.random() * Math.PI * 2
        fc.headingDrift += (Math.random() - 0.5) * w * dt * 2
        dirX += Math.sin(fc.headingDrift) * w * wScale
        dirZ += Math.cos(fc.headingDrift) * w * wScale
      }

      // --- Turn heading toward the desired direction (smooth bank, never snap) ---
      let desiredHeading = f.heading
      const dm = Math.hypot(dirX, dirZ)
      if (dm > 1e-4) desiredHeading = Math.atan2(dirX, dirZ)
      let dh = desiredHeading - f.heading
      while (dh > Math.PI) dh -= Math.PI * 2
      while (dh < -Math.PI) dh += Math.PI * 2
      const maxTurn = turnRate * dt
      if (Math.abs(dh) > maxTurn) dh = Math.sign(dh) * maxTurn
      const newHeading = f.heading + dh

      // --- Move FORWARD along the new heading (always forward, never sideways) ---
      // Speed eases SMOOTHLY toward its target (cruise when active, 0 when
      // resting) — a fish that stops swimming decelerates over ~2 seconds
      // instead of snapping from cruise to 0. `fc.speed` is the persistent
      // per-fish speed; it ramps up on becoming active and coasts down on
      // becoming resting.
      const targetSpeed = f.active ? cruiseSpeed : 0
      const curSpeed = (fc.speed != null ? fc.speed : 0)
      const accel = f.active ? (cruiseSpeed / 1.5) : (cruiseSpeed / 2.0) // u/s^2
      let speed
      if (curSpeed < targetSpeed) speed = Math.min(targetSpeed, curSpeed + accel * dt)
      else speed = Math.max(targetSpeed, curSpeed - accel * dt)
      fc.speed = speed
      const vx = Math.sin(newHeading) * speed
      const vz = Math.cos(newHeading) * speed
      // Apply the resting-fish yield nudge (momentary, capped) alongside motion.
      let nwx = f.wx + vx * dt + (f.active ? 0 : yieldDX)
      let nwz = f.wz + vz * dt + (f.active ? 0 : yieldDZ)
      f.x = nwx - regionCenter.x
      f.z = nwz - regionCenter.z
      // Vertical drift (both modes): gently change depth within the band.
      const drift = Number(W.verticalDrift) || 0
      const yLo = bounds.cy !== undefined ? -bounds.cy : 0
      const yHi = bounds.cy !== undefined ? bounds.cy : 0
      if (drift > 0 && yHi > yLo) {
        if (fc.driftTargetY == null) { fc.driftTargetY = yLo + Math.random() * (yHi - yLo); fc.driftTimer = 0 }
        fc.driftTimer = (fc.driftTimer || 0) + dt
        if (fc.driftTimer > 4 + Math.random() * 4) { fc.driftTargetY = yLo + Math.random() * (yHi - yLo); fc.driftTimer = 0 }
        const dy = fc.driftTargetY - f.y
        f.y += Math.max(-0.3, Math.min(0.3, dy * 0.1 * drift)) * dt
      }
      clampPosition(bounds, f) // mutates f in place back inside the shape
      f.wx = regionCenter.x + f.x
      f.wz = regionCenter.z + f.z
      // Write back y (vertical drift; xz thin band keeps fish near center plane).
      if (tf) tf.y = f.y

      // Write back to the child entity.
      if (tf) {
        tf.x = f.x
        tf.y = f.y
        tf.z = f.z
        tf.yaw = newHeading
      }
      if (fc) {
        fc.vx = vx
        fc.vz = vz
        fc.heading = newHeading
      }
    }
  },

  onDetach(id, api) {
    destroyFish(id, api)
  },
}

/* ── Child reconciliation ─────────────────────────────────────────────── */

/** Ensure the region has exactly `count` member children of the archetype. */
function reconcile(api, regionId, st, W) {
  const target = Math.max(0, Math.min(1000, Math.floor(Number(W.count) || 0)))
  const archetypeId = String(W.archetypeId || '')
  // Drop children whose archetype changed (re-spawn with the new archetype).
  if (st.archetypeId !== archetypeId && st.archetypeId != null) {
    destroyFish(regionId, api)
    st.archetypeId = null
  }
  if (st.fish.size === 0) {
    for (let i = 0; i < target; i++) {
      spawnFish(api, regionId, i, W, archetypeId)
    }
    st.archetypeId = archetypeId
    return
  }
  // Grow/shrink to the target count.
  const list = [...st.fish]
  while (st.fish.size > target) {
    const id = list.pop()
    if (id) { destroyOne(api, regionId, id) }
  }
  let i = st.fish.size
  while (st.fish.size < target) {
    spawnFish(api, regionId, i, W, archetypeId)
    i++
  }
}

/** A random spawn point (region-local) inside the shape's containment. */
function fishBase(regionId, W) {
  const b = computeBounds(null, regionId, W)
  const rnd = (lo, hi) => lo + Math.random() * (hi - lo)
  const y = rnd(-b.cy, b.cy)
  if (W.shape === 'sphere') {
    const r = b.radius || 1
    // uniform-ish point in the sphere: random direction scaled by ∛(rand)*r.
    const rr = Math.cbrt(Math.random()) * r
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    return { x: rr * Math.sin(phi) * Math.cos(theta), y: rr * Math.cos(phi), z: rr * Math.sin(phi) * Math.sin(theta) }
  }
  if (W.shape === 'cylinder') {
    const r = b.radius || 1
    const rr = Math.sqrt(Math.random()) * r
    const a = Math.random() * Math.PI * 2
    return { x: Math.cos(a) * rr, y: rnd(-b.cy, b.cy), z: Math.sin(a) * rr }
  }
  return { x: rnd(-b.hx, b.hx), y, z: rnd(-b.hz, b.hz) }
}

function spawnFish(api, regionId, i, W, archetypeId) {
  const id = `fish_${regionId}_${i}`
  if (api.entity(id)) return // already exists
  // ARCHETYPE-FIRST: the member is an INSTANCE of the archetype named by
  // params.archetypeId, spawned through `api.spawnArchetype` — the engine's
  // runtime instantiation of the SAME hydration path scene load uses. The
  // instance carries `archetypeId` on its entity record, the archetype's
  // declared components (render modelName + scale; collider when authored)
  // come WITH it, and the spawn point is the PLACEMENT transform override
  // (x/y/z — scale/rot default to identity per the placement doctrine).
  // Legacy bare model-name params (`params.model`) do NOT spawn: authored
  // data is migrated to `archetypeId` by
  // tools/migration/2026-10-04-flock-model-to-archetype.mjs.
  if (typeof api.spawnArchetype !== 'function') return // no host support
  const base = fishBase(regionId, W)
  const heading = Math.random() * Math.PI * 2
  const root = api.spawnArchetype(archetypeId, {
    id,
    parent: regionId,
    transform: { x: base.x, y: base.y, z: base.z },
  })
  if (!root) return // missing archetype / hydration error — no member
  // The member's boid state (the Lague model: a velocity vector seeded along
  // the random heading at cruise speed) + its persistent heading. The
  // archetype provided the render + (maybe) collider; the fish component is
  // the spawner's own runtime state on the instance root.
  const seedVx = Math.sin(heading) * (Number(W.cruiseSpeed) || 1)
  const seedVz = Math.cos(heading) * (Number(W.cruiseSpeed) || 1)
  const rec = api.entity(root)
  if (rec && rec.components) {
    rec.components.fish = { region: regionId, heading, vx: seedVx, vz: seedVz, cruise: Number(W.cruiseSpeed) || 1 }
    if (rec.components.transform) rec.components.transform.yaw = heading
  }
  // If the archetype does NOT author a collider, seed the derived one now
  // when the model is already measured (a later update fills it otherwise —
  // see deriveFishColliders). Declaration wins: a declared collider stays.
  if (rec && rec.components && !rec.components.collider) {
    const bounds = memberBoundsOf(api, rec)
    if (bounds) rec.components.collider = colliderFromBounds(bounds, rec.components.transform && rec.components.transform.scale)
  }
  let st = flockState.get(regionId)
  if (!st) { st = { fish: new Set(), archetypeId: null }; flockState.set(regionId, st) }
  st.fish.add(id)
}

/** Resolve the engine's entity-destroy callable. The engine exposes it as
 * `api.world.destroy(id)` (the World facade), NOT `api.destroy` — so resolve
 * both to keep the script working in tests/hosts that use either. */
function destroyEntity(api, id) {
  try {
    if (api && typeof api.world?.destroy === 'function') { api.world.destroy(id); return }
    if (api && typeof api.destroy === 'function') { api.destroy(id); return }
  } catch { /* best-effort */ }
}

function destroyOne(api, regionId, id) {
  destroyEntity(api, id)
  const st = flockState.get(regionId)
  if (st && st.fish) st.fish.delete(id)
}

/** Destroy every fish owned by a region (and clear its state). */
function destroyFish(regionId, api) {
  const st = flockState.get(regionId)
  if (st) {
    for (const id of st.fish) destroyEntity(api, id)
    st.fish.clear()
  }
}

/* ── Derived fish colliders (what-you-see-is-what-collides) ──────────── */

/** A member's measured LOCAL model size from the host's registry — the
 *  renderer's model registry (the SAME `modelBounds(name)` numbers the physics
 *  'render' collider and the editor's match-render-mesh path use, so there is
 *  ONE math source) — resolved from the member's OWN `render.modelName` (the
 *  archetype's declared model). Null when the host hasn't measured it yet. */
function memberBoundsOf(api, rec) {
  const name = rec && rec.components && rec.components.render && rec.components.render.modelName
  return boundsOf(api, name)
}
function boundsOf(api, modelName) {
  if (!api || typeof api.modelBounds !== 'function' || !modelName) return null
  const b = api.modelBounds(modelName)
  return (b && b.x > 0 && b.y > 0 && b.z > 0) ? b : null
}

/** Normalize transform.scale (array or {x,y,z}) to a plain multiplier array. */
function readScaleLocal(scale) {
  if (Array.isArray(scale)) return [(Number(scale[0]) || 1), (Number(scale[1]) || 1), (Number(scale[2]) || 1)]
  if (scale && typeof scale === 'object') return [(Number(scale.x) || 1), (Number(scale.y) || 1), (Number(scale.z) || 1)]
  return [1, 1, 1]
}

/** Half-extents = measured full LOCAL size × the entity scale multiplier, / 2. */
function colliderFromBounds(bounds, scale) {
  const [sx, sy, sz] = readScaleLocal(scale)
  return {
    hx: (bounds.x * sx) / 2,
    hy: (bounds.y * sy) / 2,
    hz: (bounds.z * sz) / 2,
  }
}

/** Fill in any of the region's members whose collider is still missing its
 *  size (the archetype authored no collider and spawn raced the renderer's
 *  first model registration). The value is DERIVED from the member's OWN
 *  model's measured bbox × its transform.scale (the archetype's DECLARED
 *  scale, migrated onto the instance at hydration) each time — a measured
 *  number is never authored or cached in params. DECLARED colliders (authored
 *  on the archetype) are never touched. */
function deriveFishColliders(api, st) {
  for (const fid of st.fish) {
    const rec = api.entity(fid)
    if (!rec || !rec.components) continue
    const col = rec.components.collider
    if (col && col.hx > 0 && col.hy > 0 && col.hz > 0) continue
    const bounds = memberBoundsOf(api, rec)
    if (!bounds) continue
    const tf = rec.components.transform || {}
    const next = colliderFromBounds(bounds, tf.scale)
    if (col) Object.assign(col, next)
    else rec.components.collider = next
  }
}

/* ── Containment helpers ──────────────────────────────────────────────── */

/** Resolve the region's containment bounds (region-local: center = origin). */
function computeBounds(api, regionId, W) {
  const shape = W.shape || 'box'
  if (shape === 'cylinder') {
    const r = Math.max(0.1, Number(W.sizeX) / 2 || 0.5)
    const cy = Math.max(0.1, Number(W.sizeY) / 2 || 0.5)
    return { shape: 'cylinder', radius: r, cy, hx: r, hz: r }
  }
  if (shape === 'sphere') {
    const r = Math.max(0.1, Number(W.sizeX) / 2 || 0.5)
    return { shape: 'sphere', radius: r, cy: r, hx: r, hz: r }
  }
  // box (or custom): the size params are the ONLY containment authority. A
  // flock region is a PURE container — transform + flock params, no collider
  // component (children would inherit nothing from it, and a dormant duplicate
  // of sizeX/Y/Z/2 is a drift hazard). `custom` is sized by the gizmo's
  // shapeModel measurement written into sizeX/Y/Z.
  let hx = Math.max(0.05, Number(W.sizeX) / 2 || 0.5)
  let hy = Math.max(0.05, Number(W.sizeY) / 2 || 0.5)
  let hz = Math.max(0.05, Number(W.sizeZ) / 2 || 0.5)
  return { shape: 'box', hx, hy, hz, cy: hy }
}

/** Add shape-aware wall-avoidance steering into the accumulator object. */
function addBoundarySteer(bounds, W, f, acc) {
  const m = 0.8
  const b = W.boundary
  if (bounds.shape === 'cylinder' || bounds.shape === 'sphere') {
    const r = bounds.radius
    const dxy = Math.hypot(f.x, f.z)
    if (dxy > 0 && r - dxy < m) { const k = (1 - (r - dxy) / m) * b; acc.x += f.x / dxy * k; acc.z += f.z / dxy * k }
    if (bounds.shape === 'cylinder') {
      if (f.y - (-bounds.cy) < m) acc.y += b * (1 - (f.y + bounds.cy) / m)
      if (bounds.cy - f.y < m) acc.y -= b * (1 - (bounds.cy - f.y) / m)
    }
    return
  }
  // box
  if (f.x - (-bounds.hx) < m) acc.x += b * (1 - (f.x + bounds.hx) / m)
  if (bounds.hx - f.x < m) acc.x -= b * (1 - (bounds.hx - f.x) / m)
  if (f.z - (-bounds.hz) < m) acc.z += b * (1 - (f.z + bounds.hz) / m)
  if (bounds.hz - f.z < m) acc.z -= b * (1 - (bounds.hz - f.z) / m)
  if (f.y - (-bounds.cy) < m) acc.y += b * (1 - (f.y + bounds.cy) / m)
  if (bounds.cy - f.y < m) acc.y -= b * (1 - (bounds.cy - f.y) / m)
}

/** Clamp a fish position back inside the shape after integration. */
function clampPosition(bounds, f) {
  if (bounds.shape === 'cylinder') {
    const r = bounds.radius
    const dxy = Math.hypot(f.x, f.z)
    if (dxy > r && dxy > 0) { f.x *= r / dxy; f.z *= r / dxy }
    f.y = Math.max(-bounds.cy, Math.min(bounds.cy, f.y))
  } else if (bounds.shape === 'sphere') {
    const r = bounds.radius
    const d = Math.hypot(f.x, f.y, f.z)
    if (d > r && d > 0) { f.x *= r / d; f.y *= r / d; f.z *= r / d }
  } else {
    f.x = Math.max(-bounds.hx, Math.min(bounds.hx, f.x))
    f.y = Math.max(-bounds.cy, Math.min(bounds.cy, f.y))
    f.z = Math.max(-bounds.hz, Math.min(bounds.hz, f.z))
  }
  return f
}

/** Resolve a region entity's WORLD transform (its center) via the FULL parent
 *  chain — the shared `worldPositionOf` resolver (translation-only; parent
 *  rotation/scale don't affect positions). Regions are commonly PARENTED (a
 *  flock volume nested under a tank/building), so reading only the region's own
 *  transform misses the ancestor offset and every world-space computation
 *  (cross-region separation, cohesion, obstacle avoidance) lands in the wrong
 *  place. Exported for tests. */
export function regionCenterOf(api, regionId) {
  return worldPositionOf(api, regionId)
}

/**
 * Maintain the ACTIVE set — the subset of this region's fish that are currently
 * swimming as a school. Only `activeCount` fish are active; the rest rest.
 * The set is (re)built from a random pick of the region's fish, and re-randomized
 * every `activeSwapSecs` so different fish take turns schooling (a fish isn't
 * permanently active or permanently resting). Ids that no longer exist are
 * dropped so a reconcile/count-change never leaves a stale active id.
 */
function refreshActive(regionId, st, all, W, dt) {
  const activeCount = Math.max(1, Math.min(500, Math.floor(Number(W.activeCount) || 0)))
  // This region's live fish ids.
  const mine = all.filter((f) => f.region === regionId).map((f) => f.id)
  // Prune stale ids.
  const live = new Set(mine)
  for (const id of st.active) if (!live.has(id)) st.active.delete(id)
  // Rotate on the swap timer (or when the set is short).
  st.activeTimer = (st.activeTimer || 0) + dt
  const swapSecs = Math.max(0.5, Number(W.activeSwapSecs) || 6)
  if (st.active.size < Math.min(activeCount, mine.length) || st.activeTimer >= swapSecs) {
    st.activeTimer = 0
    // Random subset of size activeCount (shuffled pick) from live fish.
    const pool = mine.slice()
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    st.active = new Set(pool.slice(0, Math.min(activeCount, pool.length)))
  }
}

/** Gather EVERY fish in the scene (all regions) with world position + region. */
function gatherAll(api, centerOf) {
  const out = []
  const ids = (typeof api.query === 'function') ? api.query({ has: 'fish' }) : []
  for (const id of ids) {
    const rec = api.entity(id)
    if (!rec) continue
    const tf = rec.components && rec.components.transform
    const fc = rec.components && rec.components.fish
    if (!tf || !fc) continue
    const c = centerOf(api, fc.region)
    // World-space radius = the fish's DERIVED collider half-extent (the model
    // bbox at spawn) — 0 only while the model hasn't been measured yet.
    const radius = (rec.components && rec.components.collider && rec.components.collider.hx) || 0
    // Whether this fish is an ACTIVE swimmer right now (in its region's active
    // set) — resting fish yield only from active (moving) fish, so a resting
    // fish doesn't get jostled by other resting fish.
    const st = flockState.get(fc.region)
    out.push({
      id,
      region: fc.region,
      radius,
      active: !!(st && st.active && st.active.has(id)),
      x: tf.x, y: tf.y, z: tf.z, // region-local
      wx: c.x + tf.x, wy: c.y + tf.y, wz: c.z + tf.z, // world
      heading: (fc.heading != null ? fc.heading : (tf.yaw || 0)), // for alignment
    })
  }
  return out
}

/** Gather obstacle entities (tagged `obstacleTag`) with their world positions,
 *  for the boids to steer away from. An obstacle is any entity carrying the tag
 *  AND a transform; its radius comes from its collider half-extent if present
 *  (so a big rock/plant body is honored), else 0. */
function gatherObstacles(api, tag) {
  const out = []
  const ids = (typeof api.query === 'function') ? api.query({ tags: tag }) : []
  for (const id of ids) {
    const rec = api.entity(id)
    if (!rec) continue
    const tf = rec.components && rec.components.transform
    if (!tf) continue
    const col = rec.components && rec.components.collider
    const radius = (col && col.hx) || 0.5
    // WORLD position via the full parent chain (obstacles are commonly parented
    // too — a rock under a prop group, a pump under a tank).
    const w = worldPositionOf(api, id)
    out.push({ id, wx: w.x, wy: w.y, wz: w.z, radius })
  }
  return out
}

/**
 * GLOBAL collision resolution — REMOVED.
 *
 * The reference Lague model does NOT use positional collision resolution; it
 * relies on strong separation STEERING at the velocity level (SteerTowards),
 * which pushes boids apart without ever teleporting them. Earlier drafts used a
 * positional pass that caused twitching/darting/clumping — see git history. The
 * velocity-based separation in `update` is the anti-clipping mechanism now.
 */

/** All engine built-in flock scripts (keyed by name) — exported for createGame. */
export const BUILTIN_FLOCK_SCRIPTS = { flock: flockScript }

/** Editor-facing metadata for the Script picker. */
export const BUILTIN_FLOCK_SCRIPT_METAS = [
  {
    name: 'flock',
    label: 'Flock (region boids)',
    description: 'Turn a GameObject into a flock region: spawns members as archetype instances (children) and drives them with boids inside a box/cylinder/sphere/custom volume. Fish avoid fish across all regions; each school stays coherent. Edit shape, size, count, member archetype + weights here.',
    params: flockScript.params,
  },
]
