// SETTLE — engine system: live per-frame terrain settling on the voxel3d
// field. Thin browser shell over the pure model (src/gameplay/settle3d.js).
//
// Every update(dt, api):
//  - impact watch: when the director transitions into 'settling', announce
//    the blast footprint (lastImpact.cell +/- blastRadius-in-cells + rim) via
//    bumpColumns — this is why projectiles3d needs no settle hook: the blast
//    changes the field AND the phase, the scanner catches it the same frame.
//  - rolling instability sweep (bounded, autonomous): re-stacks unsupported
//    ledges nothing announced; avalanche stays disturbance-scoped (see the
//    pure module's SCAN SCOPING note).
//  - stepSettle loop: PACED BY DATA (P1, plan SETTLE-PACE-1015) — the whole
//    update spends at most settleSequence.movesPerStep cell-moves (summed
//    across the internal iterations; ITER_CAP/BUDGET_MS stay as internal
//    safety caps). Consequence: a big crater drains across many frames and
//    se.settling.active stays true — the director's dirt stage lasts the
//    full visible cascade instead of teleporting the dirt.
//  - falling-dirt presentation: a pooled InstancedMesh of dirt boxes, one per
//    movedCell from the settle results, dropping fromY -> toY over
//    settleSequence.fallSeconds (sim-stepped dt, scrub-safe — presentation
//    reads sim, never mutates). Pool size is data (fallPool).
//  - CRATER-DRAIN: the render mesh is now DEFERRED — impacts/heavy-carves
//    enqueue their dirtyChunks (v3d.enqueueRemesh) and settle3d's per-sim-step
//    drain builds queued chunks ONE AT A TIME (v3d.drainRemesh(field,1)) while
//    accumulating wall time, bounded by REMESH_BUDGET_MS (data:
//    settleSequence.remeshBudgetMs) EVERY frame (behind the blast-sphere VFX
//    window ≈ 65 sim steps), so the old one-frame ~120ms crater build is gone
//    AND a full queue can never spike the frame (the idle->0FPS killer — a
//    count-bounded drainRemesh(field,32) spent ~64-96ms in ONE frame). The
//    voxel COLLIDER is field-based (columnTop off field.cells, mutated
//    synchronously by blast()), so ONLY the visual mesh is deferred — collision
//    is immediate. The cascade's own union changes are enqueued too (drained
//    within a few frames).
//  - window.__se.settling = {active}: moved>0 or work still queued. The
//    __se.host.settled() shim (main.js) reads it, so turn_director genuinely
//    waits for the slump before handing over the turn.
//
// Fail-noisy ONCE: if window.__se exists but the field (or v3d) is missing
// while this system is enabled, console.error names what was skipped.
import * as THREE from 'three';
import { stepSettle, sweepInstability, bumpColumns, pendingColumns, makeStepGate } from '../src/gameplay/settle3d.js';
import { V, W, Z, X_MIN, Z_MIN, chunkKey } from '../src/voxel3d/constants.js';
import { columnTop } from '../src/voxel3d/field.js';
import { hardwarePacing } from './turn_director.js';
import settlePreset from '../data/physics-presets.json' with { type: 'json' };

const ITER_CAP = 20
const BUDGET_MS = 30
const SWEEP_COLUMNS_PER_FRAME = 1024 // whole grid re-audited every ~39 frames (~0.65s), ~1ms/frame

// P1 (plan SETTLE-PACE-1015): the drain is PACED BY DATA — movesPerStep is
// the per-SIM-STEP cell-move budget (the pacing authority; ITER_CAP/BUDGET_MS
// stay as internal safety caps). Fail loud at module load — no JS literals,
// no silent defaults (the turn_director holdSteps precedent).
const settleSeqData = settlePreset?.settleSequence;
const rawMovesPerStep = settleSeqData?.movesPerStep;
const rawFallSeconds = settleSeqData?.fallSeconds;
const rawFallPool = settleSeqData?.fallPool;
const rawFallColor = settleSeqData?.fallColor;
if (typeof rawMovesPerStep !== 'number' || !Number.isFinite(rawMovesPerStep) || rawMovesPerStep <= 0) {
  throw new Error(`[settle3d] data/physics-presets.json: settleSequence.movesPerStep must be a positive finite number (got ${JSON.stringify(rawMovesPerStep)}) — fix the data file`);
}
if (typeof rawFallSeconds !== 'number' || !Number.isFinite(rawFallSeconds) || rawFallSeconds <= 0) {
  throw new Error(`[settle3d] data/physics-presets.json: settleSequence.fallSeconds must be a positive finite number (got ${JSON.stringify(rawFallSeconds)}) — fix the data file`);
}
if (typeof rawFallPool !== 'number' || !Number.isFinite(rawFallPool) || rawFallPool <= 0) {
  throw new Error(`[settle3d] data/physics-presets.json: settleSequence.fallPool must be a positive finite number (got ${JSON.stringify(rawFallPool)}) — fix the data file`);
}
// CRATER-DRAIN: the render-mesh drain budget per sim step. A shell impact
// enqueues its dirtyChunks (projectiles3d/heavy.js) instead of building the
// whole render mesh in one frame; this is the per-step slice the drain builds.
// Fail loud at module load — no JS literals, no silent default. The crater
// build hides behind the blast-sphere VFX window (growSeconds×fxTimeScale≈65
// sim steps; ~2000-chunk crater / 65 ≈ 32 chunks/step).
const rawRemeshPerStep = settleSeqData?.remeshPerStep;
if (typeof rawRemeshPerStep !== 'number' || !Number.isFinite(rawRemeshPerStep) || rawRemeshPerStep <= 0) {
  throw new Error(`[settle3d] data/physics-presets.json: settleSequence.remeshPerStep must be a positive finite number (got ${JSON.stringify(rawRemeshPerStep)}) — fix the data file`);
}
// CRATER-DRAIN TIME BUDGET: the per-sim-step drain is bounded by WALL TIME, not
// chunk count. remeshBudgetMs is the max milliseconds this frame's drain may
// spend building queued chunks — so a full pending queue can NEVER spike the
// frame (the idle->0FPS killer: 32 chunks × ~2-3ms = ~64-96ms in ONE frame).
// The queued crater still drains across successive steps (bounded, deferred,
// collision-immediate); only the pacing law changed (wall-time, not count).
// Fail loud at module load — no JS literals, no silent default. The object
// shape (label/range/default) is the editor physics-menu descriptor; the
// module consumes its .default (the only coherent read for an editor object).
const rawRemeshBudget = settleSeqData?.remeshBudgetMs;
const remeshBudgetMs = rawRemeshBudget?.default;
if (typeof remeshBudgetMs !== 'number' || !Number.isFinite(remeshBudgetMs) || remeshBudgetMs <= 0) {
  throw new Error(`[settle3d] data/physics-presets.json: settleSequence.remeshBudgetMs.default must be a positive finite number (got ${JSON.stringify(rawRemeshBudget)}) — fix the data file`);
}
export const SETTLE_MOVES_PER_STEP = Math.floor(rawMovesPerStep);
export const SETTLE_FALL_SECONDS = rawFallSeconds;
export const SETTLE_FALL_POOL = Math.floor(rawFallPool);
export const REMESH_PER_STEP = Math.floor(rawRemeshPerStep);
export const REMESH_BUDGET_MS = remeshBudgetMs;
if (typeof rawFallColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(rawFallColor)) {
  throw new Error(`[settle3d] data/physics-presets.json: settleSequence.fallColor must be a #rrggbb string (got ${JSON.stringify(rawFallColor)}) — fix the data file`);
}
export const SETTLE_FALL_COLOR = rawFallColor;

// Pure watch latch (FIX2): every terrain blast that sets se.lastImpact gets
// its footprint announced EXACTLY ONCE regardless of system order or
// phase-transition timing. Announce fires on a CHANGE of the monotone impact
// stamp (primary) OR the legacy settling-phase edge. Same stamp twice -> one
// announce. The stamp is only consumed when a cell is present, so an
// impact-less frame never eats the edge state.
export function announceWatch(prev, impact) {
  const phase = impact ? impact.phase ?? null : null
  const stamp = impact ? impact.stamp : undefined
  const hasCell = !!(impact && impact.cell)
  const newStamp = hasCell && stamp != null && stamp !== prev.prevStamp
  const phaseEdge = hasCell && phase === 'settling' && prev.prevPhase !== 'settling'
  return {
    announce: newStamp || phaseEdge,
    next: {
      prevPhase: phase,
      prevStamp: hasCell && stamp != null ? stamp : prev.prevStamp,
    },
  }
}

/**
 * P1 SETTLE-PACE-1015 — falling-dirt presentation. A pooled THREE.InstancedMesh
 * of dirt-colored boxes: each movedCell ({x, z, fromY, toY}) reported by the
 * settle results spawns one visual at fromY that drops to toY over fallSeconds
 * (sim-stepped via accumulated dt — no wall-clock, scrub-safe), then frees.
 * Pre-allocated pool (no per-frame allocs); overflow recycles the OLDEST
 * visual with ONE console.warn. Presentation reads sim results, never
 * mutates them; the mesh mounts lazily (scene-dependent) and disposes clean.
 */
export function createFallingDirtOverlay(poolMax, fallSeconds) {
  if (typeof poolMax !== 'number' || !(poolMax > 0)) throw new Error(`[settle3d] falling-dirt poolMax must be a positive number (got ${JSON.stringify(poolMax)})`);
  if (typeof fallSeconds !== 'number' || !(fallSeconds > 0)) throw new Error(`[settle3d] falling-dirt fallSeconds must be a positive number (got ${JSON.stringify(fallSeconds)})`);
  const entries = [];
  for (let i = 0; i < poolMax; i++) entries.push({ active: false, t: 0, wx: 0, wy: 0, wz: 0, toY: 0 });
  let mesh = null, geo = null, mat = null, warned = false;
  const dummy = new THREE.Object3D();
  const HIDDEN_Y = -10000;

  function ensure(scene) {
    if (mesh) return true;
    if (!scene) return false; // scene not mounted yet: visuals wait silently
    geo = new THREE.BoxGeometry(V, V, V);
    mat = new THREE.MeshLambertMaterial({ color: SETTLE_FALL_COLOR }); // dirt — data fallColor (settleSequence)
    mesh = new THREE.InstancedMesh(geo, mat, poolMax);
    mesh.frustumCulled = false;
    mesh.name = 'settle_falling_dirt';
    dummy.position.set(0, HIDDEN_Y, 0);
    dummy.updateMatrix();
    for (let i = 0; i < poolMax; i++) mesh.setMatrixAt(i, dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = 0;
    scene.add(mesh);
    return true;
  }

  return {
    /** Active (visible) visual count — the PW/foreman seam. */
    get active() {
      let n = 0;
      for (const e of entries) if (e.active) n++;
      return n;
    },
    /**
     * Spawn one visual per movedCell. field: the live voxel field (its
     * X_MIN/Z_MIN extents map cells to world; falls back to the module
     * constants read at call time — live bindings).
     */
    spawn(cells, field, scene) {
      if (!Array.isArray(cells) || cells.length === 0) return;
      if (!ensure(scene)) return;
      const fx = (field && typeof field.X_MIN === 'number') ? field.X_MIN : X_MIN;
      const fz = (field && typeof field.Z_MIN === 'number') ? field.Z_MIN : Z_MIN;
      // Y anchor: cell 0 sits at field.Y_MIN (DEEPEN-1015 deep floor, mesher.js:130 law)
      const fy = (field && typeof field.Y_MIN === 'number') ? field.Y_MIN : 0;
      for (const c of cells) {
        let e = entries.find((en) => !en.active);
        if (!e) {
          if (!warned) {
            warned = true;
            console.warn(`[settle3d] falling-dirt pool full (${poolMax}) — recycling the oldest visual (warned once)`);
          }
          e = entries.reduce((a, b) => (a.t > b.t ? a : b)); // oldest = furthest along
        }
        e.active = true;
        e.t = 0;
        e.wx = fx + (c.x + 0.5) * V;
        e.wz = fz + (c.z + 0.5) * V;
        e.wy = fy + (c.fromY + 0.5) * V;
        e.toY = fy + (c.toY + 0.5) * V;
      }
    },
    /** Sim-step the visuals by dt (seconds). Frees finished ones. */
    step(dt) {
      if (!mesh) return;
      // advance all active entries by the sim dt, free the finished
      for (const e of entries) {
        if (!e.active) continue;
        e.t += dt;
        if (e.t >= fallSeconds) e.active = false; // landed: freed (recycled on demand)
      }
      // write matrices dense-packed (count = visible)
      let n = 0;
      for (const e of entries) {
        if (!e.active) continue;
        const p = Math.min(1, e.t / fallSeconds);
        dummy.position.set(e.wx, e.wy + (e.toY - e.wy) * p, e.wz);
        dummy.updateMatrix();
        mesh.setMatrixAt(n++, dummy.matrix);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose(scene) {
      if (mesh) { scene?.remove(mesh); mesh.dispose?.(); geo?.dispose(); mat?.dispose(); mesh = null; }
      for (const e of entries) e.active = false;
    },
  };
}

export default {
  name: 'settle3d', label: 'Terrain settling',
  description: 'Per-frame gravity slump + avalanche smoothing after blasts; the director waits on it.',
  params: {
    angle: { type: 'number', default: 3 },
    maxColumns: { type: 'number', default: 8192 },
  },

  init(p) {
    this.angle = p.angle
    this.maxColumns = p.maxColumns
    this.prevPhase = null
    this.prevStamp = null
    this.warned = false
    this.gate = makeStepGate(0) // W3-A: replaced at every settling edge
    this.falls = createFallingDirtOverlay(SETTLE_FALL_POOL, SETTLE_FALL_SECONDS)
    this.fallsMounted = false
  },

  update(dt, api) {
    const se = typeof window !== 'undefined' && window.__se
    if (!se) return // editor viewport without SE state: scene-conditional, silent
    const field = se.field
    const v3d = se.v3d
    if (!field || !v3d) {
      // window.__se exists but the battlefield is incomplete: real corruption.
      if (!this.warned) {
        this.warned = true
        console.error(`[settle3d] enabled but ${!field ? 'window.__se.field' : 'window.__se.v3d'} is missing — settling skipped (warned once)`)
      }
      return
    }

    // Impact watch: announce the blast footprint when lastImpact CHANGES
    // (monotone stamp — robust to system order and same-tick phase churn) or
    // on the legacy settling-phase edge. Exactly once per blast.
    const st = se.director?.state()
    const phase = st ? st.phase : null
    const li = se.lastImpact
    const watch = announceWatch({ prevPhase: this.prevPhase, prevStamp: this.prevStamp },
      li ? { phase, cell: li.cell, stamp: li.stamp, rWorld: li.rWorld } : null)
    // W3-A fallingDelay (manual:L1746-L1748): a fresh step gate at every
    // settling edge (blast announce OR the phase edge — computed BEFORE the
    // prevPhase reassignment below). While it holds, the shell/dirt falls
    // before the slump continues: sweep + drain are skipped, so the terrain
    // visibly freezes for the delay, then settles. Delay 0 (unset — boot
    // never pre-applies JSON defaults) = always open, the pre-W3A behavior
    // byte-identical.
    const settlingEdge = watch.announce || (phase === 'settling' && this.prevPhase !== 'settling')
    if (settlingEdge) this.gate = makeStepGate(hardwarePacing(se).fallingDelay)
    const holding = phase === 'settling' && !this.gate.step()
    this.prevPhase = watch.next.prevPhase
    this.prevStamp = watch.next.prevStamp
    if (watch.announce) {
      // Radius: the ACTUAL converted blast world-radius projectiles3d stamped
      // into lastImpact. Fallback (legacy/no stamp) keeps the old terrainCfg
      // read but fails noisy — a silent wrong-size announce is what broke the
      // footprint after S3a.
      let rWorld = li.rWorld
      if (typeof rWorld !== 'number') {
        rWorld = se.terrainCfg?.blastRadius ?? 2
        console.error(`[settle3d] lastImpact has no rWorld — announcing with terrainCfg fallback r=${rWorld} (stamp=${li.stamp})`)
      }
      const rCells = Math.ceil(rWorld / V) + 2 // + rim
      const cols = []
      const { x: cx, z: cz } = li.cell
      // T-G1: clamp to the LIVE field extents (was hardcoded 399/99 = old
      // W=400/Z=100 — impacts past x=399 were silently never announced).
      for (let x = Math.max(0, cx - rCells); x <= Math.min(W - 1, cx + rCells); x++) {
        for (let z = Math.max(0, cz - rCells); z <= Math.min(Z - 1, cz + rCells); z++) cols.push([x, z])
      }
      bumpColumns(field, cols)
    }

    let movedTotal = 0
    const movedCells = [] // P1: presentation feed (pure stepSettle reports, additive)
    const union = new Set() // changed columns 'x,z'
    const chunks = new Set() // remesh union

    const t0 = performance.now() // covers sweep + settle loop + remesh = this system's frame cost
    // W3-A fall hold: while the gate closes the settling phase, NEITHER the
    // rolling instability sweep NOR the slump drain runs — settling has not
    // started yet (the announce above still queues the blast footprint, so
    // se.settling.active stays true and the director genuinely waits).
    if (!holding) {
      const sweep = sweepInstability(field, SWEEP_COLUMNS_PER_FRAME)
      for (const c of sweep.changedColumns) union.add(c)
      for (const k of sweep.dirtyChunks) chunks.add(k)
      movedTotal += sweep.moved
      for (const c of sweep.movedCells) movedCells.push(c)

      // P1 DATA PACED drain: the update spends at most movesPerStep cell-moves
      // (sweep + settle summed). Each stepSettle call gets only the REMAINING
      // budget as its own maxColumns cap, so no single call overshoots; the
      // unscanned tail stays pending in the pure module's dirty queue, so
      // se.settling.active stays true and the cascade continues next frame.
      let iters = 0
      while (iters < ITER_CAP && performance.now() - t0 < BUDGET_MS && movedTotal < SETTLE_MOVES_PER_STEP) {
        const room = SETTLE_MOVES_PER_STEP - movedTotal
        const r = stepSettle(field, { angle: this.angle, maxColumns: Math.min(this.maxColumns, room) })
        iters++
        for (const c of r.changedColumns) union.add(c)
        for (const k of r.dirtyChunks) chunks.add(k)
        movedTotal += r.moved
        for (const c of r.movedCells) movedCells.push(c)
        if (r.moved === 0) break
      }
    }

    // CRATER-DRAIN: the per-sim-step render-mesh drain, now TIME-bounded. Runs
    // EVERY frame regardless of the settle hold (the impact enqueues the crater
    // render mesh behind the blast-sphere VFX). Builds queued chunks ONE AT A
    // TIME (drainRemesh(field,1)) while accumulating wall time, stopping once
    // REMESH_BUDGET_MS (data: settleSequence.remeshBudgetMs) is spent or the
    // queue empties — so the drain can NEVER spike the frame regardless of how
    // deep the pending queue is (the idle->0FPS killer: a count-bounded
    // drainRemesh(field,32) spent ~64-96ms in ONE frame; a wall-time budget caps
    // it at ~6ms). The queued crater still drains across successive steps
    // (bounded, deferred, collision-immediate) — only the pacing law changed.
    // NOT gated on union.size>0 — the queued crater must drain even while
    // `holding` skips the sweep/settle block above. The cascade's own small
    // changes are enqueued below and drained within a few frames (idempotent).
    if (v3d && typeof v3d.drainRemesh === 'function') {
      const t1 = performance.now()
      while (v3d.pendingCount > 0 && performance.now() - t1 < REMESH_BUDGET_MS) {
        if (!v3d.drainRemesh(field, 1)) break // queue emptied (or nothing built) — stop
      }
    }

    if (union.size > 0) {
      // Literal seam too: every changed column's TOP-cell chunk key (the
      // dirtyChunks marks are already a superset per blast.js doctrine —
      // belt and braces, Set-adds are free).
      for (const c of union) {
        const i = c.indexOf(',')
        const x = Number(c.slice(0, i)), z = Number(c.slice(i + 1))
        chunks.add(chunkKey(x, Math.max(0, columnTop(field, x, z)), z))
      }
      v3d.enqueueRemesh(chunks) // CRATER-DRAIN: route the cascade's own changes through the queue (drained next step)
    }

    // P1 falling-dirt presentation: sim-stepped, scrub-safe. The mesh mounts
    // lazily into the same scene the v3d group lives in (the voxel3d host's
    // parent — one scene child outside v3d.group, mirroring the under-field
    // precedent, so chunk-count pins stay untouched).
    const scene = v3d.group?.parent ?? null
    this.falls.step(dt)
    if (!holding && movedCells.length > 0) this.falls.spawn(movedCells, field, scene)
    se.settleFalls = { active: this.falls.active, poolMax: SETTLE_FALL_POOL, fallSeconds: SETTLE_FALL_SECONDS, movesPerStep: SETTLE_MOVES_PER_STEP }

    se.settling = { active: movedTotal > 0 || pendingColumns(field) > 0 }
    // Frame-budget seam (specs + foreman read it): cost of THIS update().
    const ms = performance.now() - t0
    const stats = (se.settleStats ??= { frames: 0, settleFrames: 0, lastMs: 0, maxMs: 0, totalMoved: 0 })
    stats.frames++
    stats.lastMs = ms
    if (ms > stats.maxMs) stats.maxMs = ms
    if (movedTotal > 0) { stats.settleFrames++; stats.totalMoved += movedTotal }
  },
}
