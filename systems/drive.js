/**
 * X3b — live drive system: runs the pure drive model (src/gameplay/drive.js)
 * on the active tank every fixed step and publishes the frozen seams:
 *
 *   window.__se.activeTank = { x, y, z, bearingRad, angleDeg, drive, budget }
 *     — owned here; created ONCE and its fields mutated every frame the active
 *     tank exists (READ by the follow camera).
 *   window.__drive = { setBearing, setDrive, setBudget, setPosition, get }
 *     — input surface. get() returns a COPY, so setBudget/setPosition are the
 *     documented test seams for forcing state.
 *
 * Movement is legal only while the director phase is 'aim'. Rotation persists
 * across turns; the per-turn distance budget does NOT (reset on turn change).
 * Scenes without tanks (dev scenes) skip silently — scene-conditional
 * presence, not a silent data fallback — and publish nothing.
 */
import { tryDrive, wrapBearing, TURN_BUDGET, MAX_SPEED, MAX_SLOPE_DEG } from '../src/gameplay/drive.js'
import { makeDirector } from '../src/gameplay/director.js'
import { V, cellX, cellZ, cellTopWorldY, X_MIN, Z_MIN, CAGE_X_MIN, CAGE_X_MAX, CAGE_Z_MIN, CAGE_Z_MAX, mapSize, turnBudgetFor } from '../src/voxel3d/constants.js'
import { columnTop } from '../src/voxel3d/field.js'
// W2-B (plan SE-FIXUP-1012 item 2): drive-over tree destruction — the ONLY
// tree line here; the blast/debris path itself lives in src/voxel3d/treeProp.js.
import { treeDriveOver } from '../src/voxel3d/treeProp.js'
// SETTLE-PACE-1015 (user directive, option 1): dirt BURIES a tank — a buried
// tank cannot drive (budget NOT consumed) but can aim/fire. isBuried is the
// pure gate (src/gameplay/buried.js); minCoverU is DATA (physics-presets
// .buried), validated at module load like impactParams/lightning — a broken
// data file is a crash at boot, never a silent buried-bypass.
import { isBuried, buriedParams } from '../src/gameplay/buried.js'

const BURIED = buriedParams()

const DEG = Math.PI / 180

// voxel3d column surface in world units; out-of-cage clamps to the cage edge
// columns — aquarium cage (T-G4): the tank lives inside CAGE_*, so the ground
// read clamps to the cage cell range, never to the exterior buffer ring.
// SE-EXPANSION-1012 A1: cage cell bounds derive from the LIVE bindings at call
// time — a module-level capture would pin the default size (map size is data).
function cageCellBounds() {
  return {
    cxMin: Math.round((CAGE_X_MIN - X_MIN) / V),
    cxMax: Math.round((CAGE_X_MAX - X_MIN) / V),
    czMin: Math.round((CAGE_Z_MIN - Z_MIN) / V),
    czMax: Math.round((CAGE_Z_MAX - Z_MIN) / V),
  };
}
function voxelTop(field, x, z) {
  const b = cageCellBounds();
  const cx = Math.min(b.cxMax, Math.max(b.cxMin, cellX(x)))
  const cz = Math.min(b.czMax, Math.max(b.czMin, cellZ(z)))
  return cellTopWorldY(columnTop(field, cx, cz))
}

/**
 * @param {{ game: object | (() => object) }} opts game handle (or getter — the
 *   factory runs before createGame returns, the accessors run after).
 */
export default function createDriveSystem(opts = {}) {
  const gameOf = () => (typeof opts.game === 'function' ? opts.game() : opts.game)
  // SE-EXPANSION-1012 A1: turnBudget null = LIVE scale from the map-size state
  // (24 x factor -> 24/60/120). A scene/system param override still wins.
  const cfg = { maxSpeed: MAX_SPEED, maxSlopeDeg: MAX_SLOPE_DEG, turnBudget: null }
  const budgetNow = () => cfg.turnBudget ?? turnBudgetFor(mapSize())
  const records = new Map() // tankId -> { bearingDeg, drive, budget } — persists across turns
  let lastTurn = null

  function turnName() {
    const anchor = gameOf()?.api.entity('camera_anchor')
    return anchor?.components?.director?.turn || 'tank1'
  }

  function activeRecord() {
    const turn = turnName()
    let rec = records.get(turn)
    if (!rec) {
      const yaw = gameOf()?.api.entity(turn)?.components?.transform?.yaw ?? 0
      rec = { bearingDeg: yaw / DEG, drive: 0, budget: budgetNow() }
      records.set(turn, rec)
    }
    if (lastTurn !== turn) {   // rotation + aim.power persist across turns (user
      rec.budget = budgetNow() // corrected 2026-10-11: power stays as the player
      rec.drive = 0            // left it last turn; only the stale THROTTLE resets —
      lastTurn = turn          // drive 0 (auto-move fix) + budget refill (budgetNow,
    }                          // NOT cfg.turnBudget — that is the null live-scale)
    return rec
  }

  if (typeof window !== 'undefined') {
    window.__drive = {
      setBearing(d) { activeRecord().bearingDeg = wrapBearing(d) },
      setDrive(d) { activeRecord().drive = Math.max(-1, Math.min(1, d)) },
      setBudget(b) { activeRecord().budget = Math.max(0, b) },
      // W6-scrub run-reset seam: the records Map is module-closure state the
      // scene re-hydrate cannot see — a bearingDeg captured BEFORE a battle
      // reposition would overwrite the tank's restored yaw every step after
      // a scrub/controller reset. Round rollovers deliberately KEEP facing
      // (user rule: rotation persists across turns) — only the RUN reset
      // clears; the next update re-creates records from the live transforms.
      resetRecords() { records.clear(); lastTurn = null },
      setPosition(x, y, z) {
        const tr = gameOf()?.api.entity(turnName())?.components?.transform
        if (!tr) return
        tr.x = x; tr.y = y; tr.z = z
      },
      get() {
        const r = activeRecord()
        return { bearingDeg: r.bearingDeg, drive: r.drive, budget: r.budget }
      },
    }
  }

  return {
    name: 'drive', label: 'Drive',
    description: 'Aim+drive model: bearing, per-turn distance budget, slope gate, activeTank seam.',
    params: {
      maxSpeed: { type: 'number', default: MAX_SPEED },
      maxSlopeDeg: { type: 'number', default: MAX_SLOPE_DEG },
      turnBudget: { type: 'number', default: TURN_BUDGET },
    },
    init(p) { Object.assign(cfg, p) },
    update(dt, api) {
      const se = typeof window !== 'undefined' && window.__se
      if (!se) return
      if (!se.director) se.director = makeDirector({ settleTimeout: se.directorParams?.settleTimeout ?? 600 })
      const st = se.director.state()
      const rec = activeRecord()

      const tankRec = api.entity(st.turn)
      const tr = tankRec?.components?.transform
      if (!tr) return // dev scenes have no tanks: skip silently, publish nothing

      // groundAt seam: injectable for tests; X3c re-homed the default to the
      // voxel3d columnTop (se.field). Fallback keeps the old 2.5D host path
      // for the editor viewport where no voxel field is mounted.
      const groundAt = (x, z) => (se.groundAt ? se.groundAt(x, z) : (se.field ? voxelTop(se.field, x, z) : (window.__terrain ? window.__terrain.surface(x) : 0)))
      // SETTLE-PACE-1015: the BURIAL check reads the RAW field column — the
      // tank's actual support surface, the same semantics as the fall path's
      // voxelSurfaceWorld (main.js). groundAt CAGE-clamps its cells (the W10
      // pane wall), so an edge column reads high and a tank parked near the
      // panes would misread as buried. The DOCUMENTED groundAt test seam wins
      // over the raw field (DEEPEN-1015 R6: the voxel field now mounts in
      // EVERY battle scene — a spec's flat stub must ground AND bury-check
      // with the SAME surface, or the stub-driven tank sinks under the raw
      // column and reads buried on its next step). No field → groundAt.
      const supportSurf = (x, z) => {
        if (se.groundAt) return se.groundAt(x, z)
        if (!se.field) return groundAt(x, z)
        const f = se.field
        const cx = Math.min(f.W - 1, Math.max(0, cellX(x)))
        const cz = Math.min(f.Z - 1, Math.max(0, cellZ(z)))
        return cellTopWorldY(columnTop(f, cx, cz)) // DEEPEN-1015 R6: one seam (cellTop+1-FLOOR)*V
      }

      if (st.phase === 'aim') {
        // SETTLE-PACE-1015 (user directive, option 1): a BURIED tank (surface
        // − tank.y >= BURIED.minCoverU, data/physics-presets.json .buried)
        // grinds NOTHING: skip tryDrive ENTIRELY — budget NOT consumed,
        // tr.x/tr.y/tr.z/yaw unchanged — while aim/fire still work. The
        // buried tank digs itself free by FIRING (its blast carves the
        // column; the tanks-stage fall path rides it down to the carved
        // surface), at which point driving resumes.
        const surf = supportSurf(tr.x ?? 0, tr.z ?? 0)
        const buried = isBuried({ tankY: tr.y ?? 0, surf, minCoverU: BURIED.minCoverU })
        if (!buried) {
          const res = tryDrive(
          { x: tr.x ?? 0, z: tr.z ?? 0, bearingDeg: rec.bearingDeg, drive: rec.drive, budget: rec.budget },
          dt, groundAt, { maxSpeed: cfg.maxSpeed, maxSlopeDeg: cfg.maxSlopeDeg },
        )
        if (!res.blocked) rec.budget = Math.max(0, rec.budget - res.moved)
        // W10 (plan SE-FIXUP-1012 item 4, user: "the tank should not be able to
        // move through the panes"): the tryDrive output is clamped at the live
        // CAGE_* bounds — the panes are the play-area wall. The attempted move
        // is NOT refunded (the budget deduction above still fires) so driving
        // into a pane grinds the budget away instead of being free.
        tr.x = Math.min(CAGE_X_MAX, Math.max(CAGE_X_MIN, res.x))
        tr.z = Math.min(CAGE_Z_MAX, Math.max(CAGE_Z_MIN, res.z))
        tr.y = res.y
        tr.yaw = rec.bearingDeg * DEG // hull faces the bearing (barrel is a hull child)
        // W2-B drive-over tree destruction: actual speed = moved/dt (world
        // u/s); the data threshold in data/tree.json .driveOver gates it —
        // a slow touch is a no-op, a fast hit runs the shot blast path.
        if (res.moved > 0 && dt > 0) treeDriveOver(se, api, { x: tr.x, z: tr.z }, res.moved / dt)
        }
      }

      if (!se.activeTank) se.activeTank = { x: 0, y: 0, z: 0, bearingRad: 0, angleDeg: 0, drive: 0, budget: 0 }
      const at = se.activeTank
      at.x = tr.x ?? 0; at.y = tr.y ?? 0; at.z = tr.z ?? 0
      at.bearingRad = rec.bearingDeg * DEG
      at.angleDeg = tankRec.components.aim?.angleDeg ?? 45
      at.drive = rec.drive
      at.budget = rec.budget
    },
  }
}
