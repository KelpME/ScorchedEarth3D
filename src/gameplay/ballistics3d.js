// X3c — pure 3D ballistics against a voxel3d field. No DOM, no engine imports.
//
// stepBallistic(p, dt, field, opts) advances the shell {x,y,z,vx,vy,vz}
// (mutated in place, like the 2.5D stepProjectile it replaces) with fixed
// substeps of semi-implicit Euler: v first, then position. Default substep
// 1/240 keeps max displacement (20 u/s * 1/240 = 0.083u) under the 0.1u cell
// edge — no tunneling.
//
// Terrain: after each substep, cellX/cellY/cellZ (voxel3d/constants.js) ->
// solidAt. On a solid cell the substep is rolled back: the hit is reported at
// the PRE-step position and the shell is left where it was before the
// penetrating step.
//
// Out of bounds: cellY < 0 (fell below the deep floor plane, world
// FLOOR_WORLD_Y — DEEPEN-1015 R6) or cellX/cellZ
// outside [0,W)/[0,Z) -> {hit:'oob'} at the current position.
//
// opts.wind is a horizontal ACCELERATION in world u/s^2 ({x,z} or 0) — the
// manual's px/s wind maps onto it later (S-later). Fully deterministic: no
// Math.random, no wall-clock reads; same inputs => bit-identical outputs.

import { W, Z, cellX, cellY, cellZ, FIELD_X_MIN, FIELD_X_MAX, FIELD_Z_MIN, FIELD_Z_MAX } from '../voxel3d/constants.js';
import { solidAt } from '../voxel3d/field.js';
import { resolveWall } from './walls.js'; // W2-B — the single walls seam (oob hook below)
import presetsData from '../../data/physics-presets.json' with { type: 'json' };
import { SE_PX_TO_WORLD } from './settingsApply.js'; // W2-A — SE px -> world anchor

// W2-A (plan SE-COMPLETE-1012) — air viscosity drag coefficient from DATA
// (physics-presets.json physics.airViscosity.dragK). Fail loud when missing —
// no in-code default (doctrine). dv/dt = -viscosity * dragK * v.
function viscosityDragK() {
  const k = presetsData?.physics?.airViscosity?.dragK;
  if (typeof k !== 'number' || !(k > 0)) {
    throw new Error('[ballistics3d] physics-presets.json physics.airViscosity.dragK missing/invalid — fail loud, no in-code drag default');
  }
  return k;
}

/**
 * W2-A settings seam: the live flight knobs from se.settings (typed store,
 * applySettings-backed) with DATA fallbacks to the descriptor defaults when
 * no settings have been applied yet. viscosity = raw 0..20 setting;
 * borderExtend converted to WORLD units via the SE_PX_TO_WORLD anchor.
 */
export function flightSettingsFor(se) {
  const s = se?.settings ?? {};
  const phys = presetsData.physics;
  if (!phys?.airViscosity?.dragK || !phys?.bordersExtend) {
    throw new Error('[ballistics3d] physics-presets.json physics section incomplete — fail loud');
  }
  const viscosity = typeof s.airViscosity === 'number' ? s.airViscosity : phys.airViscosity.default;
  const bPx = typeof s.bordersExtend === 'number' ? s.bordersExtend : phys.bordersExtend.default;
  return { viscosity, borderExtend: bPx * SE_PX_TO_WORLD };
}

export function stepBallistic(p, dt, field, opts = {}) {
  const gravity = opts.gravity ?? 9.8;
  const wind = opts.wind ?? { x: 0, z: 0 };
  const wx = wind ? (wind.x ?? 0) : 0;
  const wz = wind ? (wind.z ?? 0) : 0;
  const substep = opts.substep ?? 1 / 240;
  // W2-A — air viscosity (manual:L1834-L1839): linear drag on the shell while
  // airborne. opts.viscosity is the RAW 0..20 setting; the magnitude is DATA
  // (dragK). Guarded on k > 0: viscosity 0 (the default) executes the exact
  // pre-W2A arithmetic — byte-identical trajectory (pinned).
  const viscosity = opts.viscosity ?? 0;
  const dragK = viscosity > 0 ? viscosity * viscosityDragK() : 0;
  // W2-A — bordersExtend (manual:L1858-L1868): how far BEYOND the border a
  // shell is tracked before it counts as a miss, in WORLD units (the caller
  // converts the SE-px setting via SE_PX_TO_WORLD). 0 = the legacy border.
  const borderExtend = opts.borderExtend ?? 0;

  let remaining = dt;
  while (remaining > 1e-6) {
    const h = Math.min(substep, remaining);
    remaining -= h;

    const px = p.x, py = p.y, pz = p.z; // pre-step position (rollback anchor)
    if (dragK > 0) {
      // Linear drag, explicit Euler on v BEFORE the position update (same
      // v-then-x doctrine as gravity/wind). Deterministic: pure arithmetic.
      const decay = 1 - dragK * h;
      p.vx *= decay; p.vy *= decay; p.vz *= decay;
    }
    p.vy -= gravity * h;
    p.vx += wx * h;
    p.vz += wz * h;
    p.x += p.vx * h;
    p.y += p.vy * h;
    p.z += p.vz * h;

    const cx = cellX(p.x), cy = cellY(p.y), cz = cellZ(p.z);
    if (cy < 0 || cx < 0 || cx >= W || cz < 0 || cz >= Z) {
      // W2-B (plan SE-COMPLETE-1012) — the ONE walls.resolve call site. With
      // walls active (opts.walls, built by walls.wallsConfigFor) a side
      // crossing is resolved by the pure model: reflect/wrap rewrite the
      // shell and the substep loop continues; CONCRETE terminates as
      // hit:'wall'. y<0 (below the floor plane) stays oob — the manual's
      // walls are the screen edges (L1875-L1879), not the ground. No walls
      // opts => the legacy 'oob' contract is untouched.
      if (opts.walls && cy >= 0) {
        const side = cx < 0 ? '-x' : cx >= W ? '+x' : cz < 0 ? '-z' : '+z';
        const res = resolveWall({
          side, x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz,
          mode: opts.walls.mode, roundSeed: opts.walls.roundSeed,
          shotSeed: opts.walls.shotSeed, params: opts.walls.params,
        });
        if (res.action === 'reflect') {
          p.x = res.x; p.y = res.y; p.z = res.z;
          p.vx = res.vx; p.vy = res.vy; p.vz = res.vz;
          continue;
        }
        if (res.action === 'wrap') {
          p.x = res.x; p.y = res.y; p.z = res.z; // velocity untouched
          continue;
        }
        if (res.action === 'terminate') {
          return { hit: 'wall', x: p.x, y: p.y, z: p.z, side, mode: res.mode };
        }
        // action 'pass' (NONE): falls through to the legacy oob return.
      }
      // W2-A — bordersExtend: when inside the tracked margin (beyond the
      // border by < borderExtend world units) the shell keeps flying — the
      // manual's "tracked before being counted as a miss" (L1858-L1868).
      // cy < 0 (below the floor plane) is ALWAYS a miss. borderExtend 0 =>
      // the strict condition can never hold out-of-cells => legacy oob
      // contract byte-identical (pinned in physics-rest.test.js).
      if (cy >= 0 && borderExtend > 0 &&
          p.x > FIELD_X_MIN - borderExtend && p.x < FIELD_X_MAX + borderExtend &&
          p.z > FIELD_Z_MIN - borderExtend && p.z < FIELD_Z_MAX + borderExtend) {
        continue;
      }
      return { hit: 'oob', x: p.x, y: p.y, z: p.z };
    }
    if (solidAt(field, cx, cy, cz)) {
      p.x = px; p.y = py; p.z = pz; // roll back the penetrating substep
      return { hit: 'terrain', x: px, y: py, z: pz, cell: { x: cx, y: cy, z: cz } };
    }
  }
  return { hit: null };
}
