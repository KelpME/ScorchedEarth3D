// DEEPEN-1015 L3b (2026-10-16) — INTRO FLYOVER RESTORED TO THE ORIGINAL
// GEOMETRY over the real field (user directives, authoritative order):
//
// (1) The flight TRAVELS AND LOOKS in the −z direction. The camera starts
// far out in FRONT of the play area — past the corridor far edge
// (FIELD_Z_MAX + cameraStartOffset) — and flies TERRAIN-FOLLOWING toward the
// gameplay start (battlePose, z ≈ 158). The camera is NEVER behind the play
// area in −z. (L3's mistake — flying +z from the back edge — is reverted.)
//
// (2) The FALLING VOXELS ARE RESTORED. The corridor is REAL field terrain
// now: the field chunk groups beyond the HAIRLINE trench carve (aquarium.js:
// carve stops at cellZ = CAGE_Z_MAX + trenchWorldDepth, corridor cells stay
// FILLED) mount HIDDEN at scene load — the menu idle shows the open cutaway,
// exactly like the old pre-strip state. On ACTIVATION all corridor chunks
// become visible AT THEIR NATURAL (up) position — seamless with the play
// terrain — and only THEN begin falling DOWN by fallDepth (the sunken-cliff
// look) FAR-TO-NEAR per the original C3 law:
//     fallStart(z) = fallLead + spread * ((zEnd - z) / span)
// — slabs at z > camera z LAND FIRST (the collapse sweeps −z with the
// camera's travel), every piece fully LANDED exactly when the camera
// ARRIVES. The fall translates each chunk group's mesh position.y ONLY —
// never field.cells (heights/collision stay cage-side; disclosed: shells
// over the corridor meet the un-dropped height field, same class as the old
// strip). On skip: immediate full drop + handoff.
//
// (3) cameraSpeed stays 45 (scene data): the corridor (FIELD_Z_MAX +
// cameraStartOffset → battlePose z ≈ 158) is ~336u ≈ ~7.5s of flight.
//
// KEPT: terrain-following sampling via surfaceHeight on the field's own
// lattice (clamped into the footprint at both edges — the start sits just
// past the FRONT edge now, clamping to the last row), pane choreography
// (panes hidden during flight, paneDropHeight drop from way above the
// frustum, fade-in, landing at the handoff), C4 camera-preset law (the
// script drives api.camera.setPreset AFTER the rig's own step; the rig's
// state is never mutated), any-key/click skip with immediate handoff, input
// parking via main.js, fail-noisy guards.
//
// DOCTRINE:
// - C1: every tunable is a script param (visible in the editor inspector).
//   Zero content literals in this file.
// - C2: the camera samples the REAL field's surfaceHeight lattice directly —
//   no second terrain. The lattice z row is derived from world z via the
//   live constants bindings (setMapSize reassigns them) and CLAMPED into the
//   field footprint [0, FIELD_Z_CELLS-1] so the follow law is continuous
//   past both edges (the start is just past the front edge; the last stretch
//   rides into the handoff blend inside the field).
// - C3 (restored): fallStart(z) staggers the corridor chunks FAR-TO-NEAR.
//   All fall windows fit inside [fallLead, arriveT - fallDuration] so every
//   chunk is fully LANDED by arrival (the ARRIVAL PIN; the chunks stay
//   mounted at origin - fallDepth — the sunken cliff, never despawned).
// - C4: see above; the handoff at arrival EXACTLY equals the published
//   battle cam_rig pose (no teleport).
//
// Status seam for specs + main.js keeps its shape:
// window.__se.introFlyover = { active, phase, t, cameraZ, surfaceY, landed,
// total, skipped } — landed/total are the corridor CHUNK counts (restored
// to the original slab-count semantics; 1/1 is NOT the pin anymore).

import {
  W as FIELD_W, Z as FIELD_Z_CELLS, V, CH,
  FIELD_X_MIN, FIELD_X_MAX, FIELD_Z_MIN, FIELD_Z_MAX,
  X_MIN, Z_MIN,
} from '../src/voxel3d/constants.js';
import { surfaceHeight } from '../src/voxel3d/generator.js';
import { trenchExtent } from '../src/voxel3d/aquarium.js';
import terrainData from '../data/voxel-terrain.json' with { type: 'json' };

// DEEPEN-1015 R4 (hollow-intro fix): the corridor falls as WELDED SLABS of
// .corridorSolid.slabCells cells (the mesher emits interior boundary faces on
// exactly those slab planes — see host.js corridorSlabOpts — so every seam
// that can open mid-fall reads solid, never hollow). Same data key, one law.
const SLAB_CELLS = (() => {
  const c = terrainData ? terrainData.corridorSolid : undefined;
  if (!c || typeof c !== 'object' || !Number.isInteger(c.slabCells) || c.slabCells <= 0) {
    throw new TypeError(`[intro_flyover] data/voxel-terrain.json .corridorSolid.slabCells must be a positive integer (cells per welded fall slab): ${JSON.stringify(c)}`);
  }
  return c.slabCells;
})();

export const SCRIPT_NAME = 'intro_flyover';

// ============================================================================
// PURE LAW — unit-pinned in test/unit/intro_flyover.test.js. No DOM, no
// renderer, no THREE import in this file.
// ============================================================================

/**
 * Pure: the field's CENTER lattice x (the camera's follow column), derived
 * from the live field-extent bindings (size-agnostic, DEEPEN-1015).
 */
export function centerLatticeX() {
  const cx = Math.floor(((FIELD_X_MIN + FIELD_X_MAX) / 2 - X_MIN) / V);
  return Math.min(FIELD_W - 1, Math.max(0, cx));
}

/**
 * Pure: the REAL field's surface top (world y) under world z, sampled on the
 * center column through the SAME surfaceHeight lattice the field generates
 * from. The lattice z row is clamped into the field footprint so the follow
 * law is continuous past both edges (C2 — no second terrain, no seam).
 * The L3b flight starts just past the FRONT edge (z > FIELD_Z_MAX → clamps
 * to the LAST lattice row).
 * @param {object} a { seed, shape? } — shape is the optional generator shape
 *   override param (undefined = the identity shape).
 */
export function surfaceTopYAt({ seed, shape }, z) {
  const czRaw = Math.floor((z - Z_MIN) / V);
  const cz = Math.min(FIELD_Z_CELLS - 1, Math.max(0, czRaw));
  const cx = centerLatticeX();
  return surfaceHeight(seed, cx, cz, { shape: shape ?? undefined }) * V; // top face of a top-height column: top * V world y
}

/**
 * Pure: the W5 (C10) glass-pane drop law — the pane_drop tween pattern
 * (cubic ease-out) re-aimed at the flyover timeline. The panes hold hidden
 * until `arriveT - leadSec` (just before the handoff), then fall from
 * `restY + dropHeight` into `restY` over exactly `leadSec`, landing at the
 * handoff; a leadSec <= 0 degenerates to an instant land at dropT0 (skip).
 * @returns {{ started:boolean, progress:number, ease:number, y:number }}
 */
export function paneDropLaw(t, arriveT, leadSec, dropHeight, restY) {
  const dropT0 = arriveT - leadSec;
  const p = leadSec > 0 ? Math.min(1, Math.max(0, (t - dropT0) / leadSec)) : (t >= dropT0 ? 1 : 0);
  const ease = 1 - Math.pow(1 - p, 3);
  return { started: t >= dropT0, progress: p, ease, y: restY + dropHeight * (1 - ease) };
}

/**
 * Pure (C3 RESTORED): the corridor chunk FALL plan. fallStart(z) staggers
 * the chunks FAR-TO-NEAR: the fall front starts at the corridor's FAR end
 * (zEnd = FIELD_Z_MAX, under the camera's start) and sweeps −z WITH the
 * camera's travel toward the trench end — chunks UNDER/BEHIND the camera
 * (z > camera z) LAND FIRST, and the front finishes exactly as the camera
 * arrives at the gameplay start. All fall windows fit inside
 * [fallLead, arriveT - fallDuration] so every chunk is fully LANDED by
 * arrival; `clearOk` reports the pin (the caller fails noisy on false).
 * The camera moves at −cameraSpeed from camStartZ to zArrive (both with
 * camStartZ > zArrive), so arriveT = (camStartZ - zArrive) / cameraSpeed.
 * @param {object} p { zStart, zEnd, camStartZ, cameraSpeed, zArrive, fallLead, fallDuration }
 */
export function corridorFallPlan({ zStart, zEnd, camStartZ, cameraSpeed, zArrive, fallLead, fallDuration }) {
  const arriveT = (camStartZ - zArrive) / cameraSpeed;
  const span = Math.max(1e-6, zEnd - zStart);
  // Stagger window: all falls fit in [fallLead, arriveT - fallDuration] so
  // every chunk is LANDED by arrival (the far end — under the camera's
  // start — lands first; the trench-end chunk lands last, exactly at arrival).
  const spread = Math.max(0, arriveT - fallDuration - fallLead);
  const fallStartAt = (z) => {
    const u = Math.min(1, Math.max(0, (zEnd - z) / span)); // 0 at the far end, 1 at the trench end
    return fallLead + spread * u;
  };
  const finishT = fallStartAt(zStart) + fallDuration; // the LAST chunk to land
  const lateBy = finishT - arriveT;
  return {
    arriveT,
    span,
    spread,
    fallStartAt,
    finishT,
    clearOk: lateBy <= 1e-9,
    lateBy,
    offender: lateBy > 1e-9 ? zStart : null,
  };
}

/**
 * Pure: the per-chunk fall tween — the chunk is REVEALED AT ACTIVATION at
 * its natural (up) position (position.y = 0, seamless with the play terrain)
 * and translates DOWN by fallDepth over fallDuration once its window opens
 * (starting at startAt), landing at origin - fallDepth and STAYING there
 * (the sunken cliff). Before startAt dy = 0 — the chunk sits at its natural
 * position. A fallDuration <= 0 degenerates to an instant drop (skip).
 * @returns {{ started:boolean, progress:number, dy:number }}
 */
export function chunkFallLaw(t, startAt, fallDuration, fallDepth) {
  const p = fallDuration > 0 ? Math.min(1, Math.max(0, (t - startAt) / fallDuration)) : (t >= startAt ? 1 : 0);
  return { started: t >= startAt, progress: p, dy: -fallDepth * p };
}

/**
 * Pure: the flyover camera law (L3b — the flight travels AND looks −z). The
 * camera glides at cameraHeight ABOVE THE REAL FIELD SURFACE (terrain-
 * following — surfaceTopYAt samples the center column of the field's own
 * lattice) from camStartZ (just past the corridor's far FRONT edge) toward
 * the gameplay start, LEVEL: its look point is the camera's OWN height at
 * lookAhead units ahead along −z (look = pos + (0, 0, -lookAhead)) — zero
 * pitch, the horizon stays put. Within `handoffDist` above the gameplay-
 * start z the pose eases (linear in the remaining gap) into the published
 * battle cam_rig pose (`endPose` — main.js applyOrbit's
 * window.__se.battlePose), so at arrival the pose EQUALS the battle orbit
 * exactly and the handoff is seamless (no teleport, C4). Returned in the
 * engine orbit-preset form the cam_rig family uses (engine/src/render/
 * camera.js orbit: pos = target + radius·sin(phi)·cos(theta), cos(phi),
 * sin(phi)·sin(theta) — the args below reproduce that exactly when b = 1).
 * @param {object} a { camStartZ, cameraSpeed, cameraHeight, lookAhead, fov,
 *   seed, shape?, centerX, endPose, handoffDist, zArrive }
 * @returns {{ pos:{x,y,z}, look:{x,y,z}, surfaceY:number, preset:'orbit', args:object }}
 */
export function cameraPose({ camStartZ, cameraSpeed, cameraHeight, lookAhead, fov, seed, shape, centerX, endPose, handoffDist, zArrive }, t) {
  const camZ = camStartZ - cameraSpeed * t; // front -> gameplay start: the flight travels −z
  const surfaceY = surfaceTopYAt({ seed, shape }, camZ);
  const followPos = {
    x: centerX,
    y: surfaceY + cameraHeight,
    z: camZ,
  };
  // C8: LEVEL forward gaze — the look point rides the camera's own height,
  // AHEAD along −z (the flight direction).
  const followLook = { x: centerX, y: followPos.y, z: camZ - lookAhead };
  // Handoff blend: 0 while flying (camZ far above zArrive), easing to
  // exactly 1 at the gameplay start — the last stretch eases the follow
  // pose onto the battle pose.
  const b = handoffDist > 0
    ? Math.min(1, Math.max(0, (zArrive + handoffDist - camZ) / handoffDist))
    : 1;
  const pos = {
    x: followPos.x + (endPose.pos.x - followPos.x) * b,
    y: followPos.y + (endPose.pos.y - followPos.y) * b,
    z: followPos.z + (endPose.pos.z - followPos.z) * b,
  };
  const look = {
    x: followLook.x + (endPose.target.x - followLook.x) * b,
    y: followLook.y + (endPose.target.y - followLook.y) * b,
    z: followLook.z + (endPose.target.z - followLook.z) * b,
  };
  const dx = pos.x - look.x, dy = pos.y - look.y, dz = pos.z - look.z;
  const r = Math.hypot(dx, dy, dz);
  return {
    pos, look,
    surfaceY, // the raw field surface line the follow law rides (post-blend camY is always ABOVE it)
    preset: 'orbit',
    args: {
      target: look,
      radius: r,
      theta: Math.atan2(dz, dx),
      phi: Math.acos(dy / r),
      fov,
    },
  };
}

// ============================================================================
// SCRIPT DEF — editor descriptor shape (adapter.js toEngineDef converts).
// Every tunable below is a param; the scene authors the values.
// ============================================================================

const introDef = {
  name: SCRIPT_NAME,
  label: 'Intro flyover',
  description: 'Cinematic new-game intro (DEEPEN-1015 R3 — the ORIGINAL geometry over the real field): the camera starts far out in FRONT of the play area (FIELD_Z_MAX + cameraStartOffset) and flies TERRAIN-FOLLOWING in the −z direction (height ABOVE the field surface, sampled via surfaceHeight on the field\'s own lattice) toward the gameplay start, ending exactly on the battle cam_rig pose (seamless handoff). The corridor field chunk groups beyond the hairline trench carve mount HIDDEN at scene load (menu idle = open cutaway); on ACTIVATION they APPEAR at their natural (up) position — seamless with the play terrain — and only then fall DOWN by fallDepth far-to-near (C3 law — chunks near/under the camera land first, every piece landed exactly at arrival), staying mounted as the sunken cliff. Flight time = corridor / cameraSpeed (~336u ≈ ~7.5s at 45). Any key/click skips (immediate full drop + handoff). Trigger: params.enabled OR state introFlyover === "play".',
  params: {
    enabled: { type: 'boolean', default: false },
    seed: { type: 'number', default: 2026 },
    cameraSpeed: { type: 'number', default: 45, label: 'Camera speed (u/s)', description: 'Flight speed toward the gameplay start (−z) — the scene data sets this so the corridor (~336u: FIELD_Z_MAX + offset down to the battle pose) takes ~7.5s' },
    cameraHeight: { type: 'number', default: 20, label: 'Camera height above surface', description: 'Flyover altitude ABOVE the REAL field terrain surface (world y = surface top + this) — the camera never clips into the terrain' },
    cameraStartOffset: { type: 'number', default: 14, label: 'Start offset past front edge', description: 'How far past the corridor\'s far edge (FIELD_Z_MAX) the flight starts — roughly a look-ahead margin so the first frames already show real corridor terrain' },
    lookAhead: { type: 'number', default: 14 },
    fov: { type: 'number', default: 40 },
    handoffDist: { type: 'number', default: 30, label: 'Handoff blend distance', description: 'World units above the gameplay-start z over which the pose eases onto the battle cam_rig pose (seamless handoff)' },
    // C3 RESTORED (DEEPEN-1015 L3b): the corridor chunk-group fall law.
    fallLead: { type: 'number', default: 0.5, label: 'Fall lead (s)', description: 'Seconds after activation before the FIRST (farthest, under the camera\'s start) corridor chunk begins to fall — the flight gets airborne before the collapse opens' },
    fallDuration: { type: 'number', default: 1, label: 'Fall duration (s)', description: 'How long ONE corridor chunk\'s fall takes (origin -> origin - fallDepth). The stagger spreads the falls across [fallLead, arriveT - fallDuration] so every chunk is fully landed at arrival' },
    fallDepth: { type: 'number', default: 48, label: 'Fall depth (u)', description: 'How far each corridor chunk group falls DOWN (the sunken-cliff look) — the chunks stay mounted at origin - fallDepth, never despawned' },
    // W5 (C10, user correction 2026-10-14: "it's NOT the hud panels, it's the
    // GLASS panels") — the aquarium GLASS PANES are hidden while the flyover
    // flies, then drop out of the air from WAY above the frustum into their
    // docked positions during the last paneDropLeadSec of the flight (or on
    // skip), fading in as they fall (pane_drop tween law, cubic ease-out).
    paneIds: { type: 'array', default: [], label: 'Glass pane entity ids', description: 'The aquarium glass_pane entities this flyover choreographs (C10): hidden during the flight, dropped from paneDropHeight above their rest position over the last paneDropLeadSec, fade-in via paneFadeMaterial' },
    paneDropLeadSec: { type: 'number', default: 1.2, label: 'Pane drop lead (s)', description: 'The pane drop starts this many seconds before the camera arrives (just before the handoff) and tweens for exactly this long, landing at the handoff; skip drops immediately' },
    paneDropHeight: { type: 'number', default: 600, label: 'Pane drop height', description: 'How far above their docked position the panes start falling from — a fall from far above the frustum (C10)' },
    paneFadeMaterial: { type: 'string', default: '', label: 'Pane fade material', description: 'Scene material name whose opacity fades 0 -> authored while the panes fall (all panes sharing it fade together); empty = visibility flip only' },
    skipOnAny: { type: 'boolean', default: true },
    skipKeys: { type: 'array', default: ['Escape'] },
    terrainShape: { type: 'object', default: null },
  },

  update(state, dt, api, id, params) {
    if (state.phase === 'done' || state.phase === 'building') return;
    if (!state.phase) state.phase = 'idle';

    if (state.phase === 'idle') {
      // L3b: the corridor chunks mount HIDDEN at scene load — the menu idle
      // shows the open cutaway, exactly like the old pre-strip state.
      // Boot-ordering tolerant: the field host may not exist yet; retry
      // silently until it does (never once the phase leaves idle).
      if (!state.corridorHidden) hideCorridor(state, id);
      const play = params.enabled === true ||
        (typeof api.state?.get === 'function' && api.state.get()?.introFlyover === 'play');
      if (!play) return;
      start(state, api, id, params);
      return;
    }

    // phase === 'flying'
    state.t += dt;

    // SKIP (C4): any key/click when skipOnAny (params.skipKeys extend the set
    // for a restricted mapping). Immediate full drop + handoff.
    if (state.skipRequested) { finish(state, params, true); return; }

    // Drive the camera AFTER the rig's step (script updates run last — the
    // pose below wins before render; the rig's own state is never mutated).
    const pose = cameraPose({
      camStartZ: state.camStartZ, cameraSpeed: params.cameraSpeed,
      cameraHeight: params.cameraHeight, lookAhead: params.lookAhead,
      fov: params.fov, seed: Math.round(params.seed),
      shape: params.terrainShape ?? undefined, centerX: state.centerX,
      endPose: state.endPose, handoffDist: params.handoffDist,
      zArrive: state.zArrive,
    }, state.t);
    try {
      api.camera.setPreset(pose.preset, pose.args);
    } catch (e) {
      console.error(`[intro_flyover] camera preset failed on ${id}:`, e);
    }
    publish(state, params, pose.pos.z, pose.surfaceY);

    // C3 RESTORED: the corridor chunks fall far-to-near under the flight.
    tickCorridor(state, params);
    // W5 (C10): glass-pane choreography — hidden during the flight, dropped
    // from way above the frustum over the last paneDropLeadSec (fading in).
    tickPanes(state, params);

    // ARRIVAL: at the gameplay-start position the handoff completes.
    if (pose.pos.z <= state.zArrive) finish(state, params, false);
  },
};

// ---- lifecycle helpers (per-entity closure state via adapter.js) -----------

/** The host seam: window.__se.v3d (main.js) exposes the field's voxel3d host. */
function fieldHost() {
  return (typeof window !== 'undefined' && window.__se) ? window.__se.v3d : null;
}

/**
 * L3b: hide the CORRIDOR chunk groups (beyond the bounded trench carve) so
 * the menu idle shows the open cutaway. Fail-noisy: a missing host or an
 * empty corridor logs (once) and leaves the chunks mounted — the intro is
 * pointless without its falling voxels, so a broken corridor must be visible
 * in the console.
 */
function corridorChunks(id, { quiet = false } = {}) {
  const host = fieldHost();
  if (!host || typeof host.chunkGroups !== 'function') {
    if (!quiet) console.error(`[intro_flyover] ${id}: window.__se.v3d has no chunkGroups() — the field host seam is missing (main.js not booted or stale) — corridor unavailable, fail-noisy`);
    return null;
  }
  let groups;
  try {
    groups = host.chunkGroups(); // throws fail-noisy when nothing is mounted
  } catch (e) {
    if (!quiet) console.error(`[intro_flyover] ${id}: ${e.message}`);
    return null;
  }
  // The corridor = every FULLY-corridor chunk z bucket: its first cell sits
  // at/after the bounded trench back face (aquarium.js derivation).
  const depth = trenchExtent().zMax; // world z of the trench's bounded back face
  const trenchEndCell = Math.ceil((depth - Z_MIN) / V - 1e-9);
  const corridor = groups.filter((g) => g.cz * CH >= trenchEndCell);
  if (corridor.length === 0) {
    if (!quiet) console.error(`[intro_flyover] ${id}: no corridor chunk groups found beyond the trench back face (cellZ ${trenchEndCell}) — the bounded trench carve consumed the whole corridor? — fail-noisy`);
    return null;
  }
  // DEEPEN-1015 R4: the corridor chunk z-buckets are WELDED into fall slabs of
  // .corridorSolid.slabCells cells (the mesher emits boundary faces on exactly
  // those slab planes) — chunks inside one slab always translate together, so
  // seams never open inside a slab; seams between slabs carry real faces on
  // both sides. Chunk mid z (world) per slab, clamped into [trench end,
  // FIELD_Z_MAX] for the C3 law.
  const slabs = [];
  for (const g of corridor) {
    const slab = Math.floor((g.cz * CH) / SLAB_CELLS);
    const last = slabs[slabs.length - 1];
    if (last && last.slab === slab) last.meshes.push(...g.meshes);
    else slabs.push({ slab, meshes: [...g.meshes] });
  }
  if (slabs.length === 0) {
    if (!quiet) console.error(`[intro_flyover] ${id}: corridor chunk welding produced no slabs — fail-noisy`);
    return null;
  }
  return slabs.map((s) => ({
    cz: s.slab,
    meshes: s.meshes,
    zMid: Math.min(FIELD_Z_MAX, Math.max(depth, Z_MIN + (s.slab * SLAB_CELLS + SLAB_CELLS / 2) * V)),
  }));
}

function hideCorridor(state, id) {
  const corridor = corridorChunks(id, { quiet: true });
  if (!corridor) return; // boot ordering — retry next idle tick
  for (const c of corridor) for (const m of c.meshes) m.visible = false;
  state.corridorHidden = true;
}

/**
 * C3 RESTORED + R3 reveal-at-activation: all corridor chunks were revealed
 * AT ACTIVATION (in start — visible at their natural position, seamless with
 * the play terrain); this per-frame pass only translates them DOWN by
 * fallDepth per the far-to-near stagger (dy = 0 until a chunk's window
 * opens, so it sits at its natural position until its fall starts).
 */
function tickCorridor(state, params) {
  if (!state.corridor || state.corridor.length === 0) return;
  let landed = 0;
  for (const c of state.corridor) {
    const startAt = state.plan.fallStartAt(c.zMid);
    const law = chunkFallLaw(state.t, startAt, params.fallDuration, params.fallDepth);
    for (const m of c.meshes) m.position.y = law.dy; // translate the GROUP ONLY — never field.cells
    if (law.progress >= 1) landed++;
  }
  state.landed = landed;
}

/**
 * W5 (C10) per-frame glass-pane choreography. The panes hold hidden until
 * `arriveT - paneDropLeadSec`, then the paneDropLaw tween drops them from
 * paneDropHeight above their dock into `restY` while the shared fade material
 * ramps its authored opacity back (invisible -> visible as they fall/land).
 * NOTE: the pane entities are declared BEFORE intro_flyover in the scene, so
 * their own pane_drop scripts run first each step and this write (the
 * flyover's cinematography) is the last write before render.
 */
function tickPanes(state, params) {
  if (!state.panes || state.panes.length === 0) return;
  const law = paneDropLaw(state.t, state.arriveT, params.paneDropLeadSec, params.paneDropHeight, 0);
  if (!law.started) return;
  for (const pane of state.panes) {
    if (pane.dropped) continue;
    const rec = pane.rec;
    rec.components.render.visible = true; // invisible -> visible at the drop start (it is still way above the frustum)
    rec.components.transform.y = pane.restY + params.paneDropHeight * (1 - law.ease);
    pane.dropped = law.progress >= 1;
  }
  if (state.fadeMat) state.fadeMat.opacity = state.fadeTarget * law.ease;
}

export default introDef;

function start(state, api, id, params) {
  state.phase = 'building';
  // W4 (C4 seamless handoff): the end pose is the battle cam_rig's LIVE boot
  // orbit pose, published by main.js applyOrbit — no content literals here.
  // Missing pose = fail-noisy (flyover skipped): a handoff without the target
  // pose would teleport the camera.
  const endPose = window.__se?.battlePose;
  if (!endPose || !endPose.pos || !Number.isFinite(endPose.pos.z) || !endPose.target) {
    console.error(`[intro_flyover] ${id}: window.__se.battlePose missing/incomplete — the cam_rig handoff pose is unavailable (main.js not booted?) — flyover skipped, fail-noisy`);
    state.phase = 'done';
    return;
  }
  // L3b: the flight starts just past the corridor's far FRONT edge and lands
  // on the battle pose — read the live bindings at use time (setMapSize
  // reassigns them).
  state.camStartZ = FIELD_Z_MAX + params.cameraStartOffset;
  state.zArrive = endPose.pos.z;
  state.centerX = (FIELD_X_MIN + FIELD_X_MAX) / 2;
  if (state.camStartZ - state.zArrive <= 0) {
    console.error(`[intro_flyover] ${id}: flight distance non-positive (camStartZ=${state.camStartZ} <= gameplay start z=${state.zArrive}) — the corridor is too short for the current battle pose — flyover skipped, fail-noisy`);
    state.phase = 'done';
    return;
  }
  state.arriveT = (state.camStartZ - state.zArrive) / params.cameraSpeed;
  state.endPose = endPose;
  // C3 RESTORED + R3 reveal-at-activation: collect the corridor chunk groups.
  // They mounted HIDDEN at scene load (menu idle = open cutaway); AT
  // ACTIVATION every chunk is revealed AT ITS NATURAL (up) position —
  // seamless with the play terrain — and only THEN begins the C3 staggered
  // fall (dy starts at 0, tickCorridor lowers each chunk when its window opens).
  state.corridor = corridorChunks(id);
  if (!state.corridor) {
    console.error(`[intro_flyover] ${id}: the corridor is unavailable — the intro is pointless without its falling voxels — flyover skipped, fail-noisy`);
    state.phase = 'done';
    return;
  }
  for (const c of state.corridor) {
    for (const m of c.meshes) { m.visible = true; m.position.y = 0; }
    c.shown = true;
  }
  state.total = state.corridor.length;
  const trenchZMax = trenchExtent().zMax;
  state.plan = corridorFallPlan({
    zStart: trenchZMax, zEnd: FIELD_Z_MAX,
    camStartZ: state.camStartZ, cameraSpeed: params.cameraSpeed,
    zArrive: state.zArrive, fallLead: params.fallLead, fallDuration: params.fallDuration,
  });
  if (!state.plan.clearOk) {
    console.error(`[intro_flyover] ${id}: C3 arrival pin violated — the last corridor chunk lands ${state.plan.lateBy.toFixed(3)}s AFTER arrival (offender z=${state.plan.offender}, finishT=${state.plan.finishT.toFixed(2)} > arriveT=${state.plan.arriveT.toFixed(2)}) — shortening the stagger window (fail-noisy)`);
    // Clamp: pull fallLead down so the pin holds rather than leaving chunks
    // airborne at the handoff.
    params.fallLead = Math.max(0, params.fallLead - state.plan.lateBy);
    state.plan = corridorFallPlan({
      zStart: trenchZMax, zEnd: FIELD_Z_MAX,
      camStartZ: state.camStartZ, cameraSpeed: params.cameraSpeed,
      zArrive: state.zArrive, fallLead: params.fallLead, fallDuration: params.fallDuration,
    });
  }
  // W5 (C10): collect + hide the glass panes for the flight. Missing ids are
  // named (fail-noisy) and skipped; restY is the pane's live docked y.
  state.panes = [];
  for (const pid of params.paneIds || []) {
    const rec = api.entity(pid);
    if (!rec || !rec.components || !rec.components.transform) {
      console.error(`[intro_flyover] ${id}: pane id "${pid}" not found (or has no transform) — pane excluded from the C10 drop choreography (scene data gap, fail-noisy)`);
      continue;
    }
    if (!rec.components.render) rec.components.render = {};
    rec.components.render.visible = false; // hidden for the whole flight
    // restY = the DOCKED position — read the pane's own pane_drop param (the
    // authored data), NEVER the live transform (pane_drop's own header lesson:
    // the boot drop tween may still be mid-fall when the flyover arms).
    const dropScript = (rec.components.scripts || []).find((s) => s && s.name === 'pane_drop');
    const paramRest = dropScript?.params?.restY;
    const restY = typeof paramRest === 'number' && Number.isFinite(paramRest)
      ? paramRest
      : rec.components.transform.y;
    state.panes.push({ id: pid, rec, restY, dropped: false });
  }
  // Fade material (scene data): the shared glass material fades 0 -> authored
  // opacity while the panes fall. Missing material = named, no fade.
  state.fadeMat = null;
  state.fadeTarget = 0;
  if (params.paneFadeMaterial) {
    const renderer = typeof window !== 'undefined' ? window.__renderer : null;
    const mat = renderer && typeof renderer._resolveMaterial === 'function'
      ? renderer._resolveMaterial(params.paneFadeMaterial)
      : null;
    if (mat) { state.fadeMat = mat; state.fadeTarget = mat.opacity ?? 1; mat.opacity = 0; }
    else console.error(`[intro_flyover] ${id}: paneFadeMaterial "${params.paneFadeMaterial}" did not resolve to a renderer material — the pane fade-in is disabled (fail-noisy)`);
  }
  state.t = 0;
  state.landed = 0;
  state.skipRequested = false;
  state.phase = 'flying';

  // C4: skip = any key/click. Listeners are capture-phase, added on start,
  // removed on finish — never leak past the handoff.
  state.onSkip = (e) => {
    const k = e && e.key ? String(e.key) : '';
    if (params.skipOnAny || (params.skipKeys || []).includes(k)) state.skipRequested = true;
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', state.onSkip, true);
    window.addEventListener('pointerdown', state.onSkip, true);
  }
  console.info(`[intro_flyover] ${id}: flying the REAL field FRONT corridor (z ${state.camStartZ.toFixed(0)} -> ${state.zArrive.toFixed(0)}, arrival t=${state.arriveT.toFixed(2)}s, ${state.total} corridor chunks falling far-to-near, fallDepth ${params.fallDepth}) — any ${params.skipOnAny ? 'key/click' : `key in [${(params.skipKeys || []).join(', ')}]`} skips`);
  publish(state, params, state.camStartZ);
}

function finish(state, params, skipped) {
  // C3 RESTORED: on skip every corridor chunk drops FULLY immediately
  // (visible, sunken to origin - fallDepth, staying mounted).
  for (const c of state.corridor || []) {
    for (const m of c.meshes) { m.visible = true; m.position.y = -params.fallDepth; }
  }
  state.landed = (state.corridor || []).length;
  // W5 (C10): on skip the panes land immediately — docked, visible, fade done.
  for (const pane of state.panes || []) {
    if (pane.dropped) continue;
    pane.rec.components.render.visible = true;
    pane.rec.components.transform.y = pane.restY;
    pane.dropped = true;
  }
  if (state.fadeMat) state.fadeMat.opacity = state.fadeTarget;
  if (typeof window !== 'undefined' && state.onSkip) {
    window.removeEventListener('keydown', state.onSkip, true);
    window.removeEventListener('pointerdown', state.onSkip, true);
  }
  state.phase = 'done';
  publish(state, params, state.zArrive);
  console.info(`[intro_flyover] handoff to cam_rig (${skipped ? 'SKIPPED' : 'arrival'}, t=${(state.t ?? 0).toFixed(2)}s, corridor chunks landed ${state.landed}/${state.total})`);
}

function publish(state, params, cameraZ, surfaceY) {
  if (typeof window === 'undefined') return;
  window.__se = window.__se || {};
  window.__se.introFlyover = {
    active: state.phase === 'flying',
    phase: state.phase,
    t: state.t ?? 0,
    cameraZ,
    surfaceY: surfaceY ?? null,
    landed: state.landed ?? 0,
    total: state.total ?? 0,
    skipped: state.phase === 'done' && state.skipRequested,
  };
}

// ---- W2 wiring (plan SE-CINEMATIC-1013) ------------------------------------
// main.js imports this default def into the createGame scripts map; the engine
// natively wraps 5-arg game-script defs (per-entity closure state), so the
// descriptor registers raw. Activation: params.enabled === true (inspector
// toggle) OR game state introFlyover === 'play' (armed by main.js on every
// real new game; skipSetup boots never arm it, so their corridor stays
// hidden = the old no-strip state). Status seam for specs + main.js:
// window.__se.introFlyover = { active, phase, t, cameraZ, surfaceY, landed,
// total, skipped }.
