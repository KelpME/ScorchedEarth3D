// S3b — weapon behavior layer B: diggers, sandhog, dirt, liquid dirt, riot,
// earth disrupter, laser, plasma. PURE + DETERMINISTIC: no DOM, no engine
// imports beyond voxel3d constants/field/blast, no Math.random, no clock.
// Any randomness would come from an inline LCG (numerical-recipes constants,
// economy.js同款) seeded from shot.seed — none is currently needed, so all
// outputs are a deterministic function of ctx.
//
// Interface (pinned by S3a, foreman wires exports into dispatch AFTER merge):
//   Behavior = { launch(ctx), step(ctx, dt)->events[], onTerrainHit(ctx,hit)->events[], done(ctx) }
//   ctx = { shot, weapon, field, p:{x,y,z,vx,vy,vz}, se, api, t }
//   events = [{type:'blast',x,y,z,r}, {type:'spawn',...}]
// Per-behavior runtime state lives on ctx.shot.bh (created lazily) so the
// dispatch seam can reuse one ctx object across frames.
//
// Tunnel model (documented, brief-mandated simplification): the field is
// heights-only above ground, but a tunnel is modeled as EMPTY cells BELOW
// the pre-tunnel columnTop ("digY" row, 2 cells under the surface row) —
// blast craters only where columnTop lowered, so the surface stays intact
// over the corridor until the underground detonation lowers it.
import { H, V, cellX, cellY, cellZ, centerY, cellTopWorldY, inField } from '../../voxel3d/constants.js';
import { set, solidAt } from '../../voxel3d/field.js';
import { blast } from '../../voxel3d/blast.js';
import { coneCarve } from '../../voxel3d/cone.js';
import { stepBallistic, flightSettingsFor } from '../ballistics3d.js';
import { dirtDeposit, stamp, topCellOfFill } from '../earthAdd.js';

// Manual: "Baby Diggers ... tunnel when they hit ground." (manual:L1100-L1102)
// COMB: tunnel distance is CATALOG data — weapon.effect.digTravelU ==
// OG weaponTable idx19-21 blastRadiusParam magnitudes (-10/-20/-35; the OG
// sign encodes the digger's underground detonation profile). These maps are
// fallbacks for synthetic records only.
const DIGGER_TRAVEL = { baby_digger: 10, digger: 20, heavy_digger: 35 }; // fallback: effect.digTravelU (OG idx19-21)
// Sandhog: "alternate technology ... tunneling warhead contains a small but
// powerful charge" (manual:L1109-L1115). COMB: OG idx22-24 brp 10/20/35 —
// same magnitudes as the digger family, positive sign = sandhog SURFACES at
// the end (blast at/above ground, damage-capable) vs the digger's
// terrain-only underground carve.
const SANDHOG_TRAVEL = { baby_sandhog: 10, sandhog: 20, heavy_sandhog: 35 }; // fallback: effect.digTravelU (OG idx22-24)
const TUNNEL_SPEED = 1; // u/s (brief-pinned "~1 unit/s")
// FIX2 unit calibration (systems/projectiles3d.js boundary constant): record
// blast radii are OG PIXELS, the field works in world units -> 0.2.
const SE_PX_TO_WORLD = 0.2;

// Settle-seam stamp (shared by every DIRECT field-carve path in this file):
// the settle3d impact-announce reads se.lastImpact.rWorld to size its
// footprint; a direct carve (no dispatcher blast event) bypassed the executor
// stamp seam, so the main blast path was the only thing that stamped it, and
// the crater-edge avalanche smoothing was announced with the terrainCfg
// fallback r=2 for a ~17-cell crater. Stamp the ACTUAL carved WORLD radius
// here, monotone (max) so a later, larger carve on the same impact wins.
// Mirror the existing stamp guard (hit === 'terrain'); no stamp-match guard —
// the existing tunneling-off line never had one.
export function stampCarveWorldRadius(se, worldRadius) {
  if (se && typeof worldRadius === 'number' && Number.isFinite(worldRadius) && se.lastImpact && se.lastImpact.hit === 'terrain') {
    se.lastImpact.rWorld = Math.max(se.lastImpact.rWorld ?? 0, worldRadius);
  }
}

function bh(ctx) {
  if (!ctx.shot.bh) ctx.shot.bh = {};
  return ctx.shot.bh;
}
function travelFor(map, weapon) {
  // Catalog first (data/weapons.json effect.digTravelU == OG brp magnitude).
  const og = weapon.effect && typeof weapon.effect.digTravelU === 'number' ? weapon.effect.digTravelU : undefined;
  if (og !== undefined) return og;
  const d = map[weapon.id];
  if (d === undefined) {
    console.error(`[se/heavy] no ${Object.keys(map)[0]}-style travel pinned for weapon id "${weapon.id}" — skipping`);
    return null;
  }
  return d;
}
// Record blastRadius; diggers/sandhogs carry null in weapons.json (manual
// table L982-L987 "N/A") -> fallback per brief: r at detonation uses the
// record value when present; null -> console.error names the gap, 0 r.
function recordRadius(weapon, fallback, what) {
  const r = weapon.blastRadius;
  if (typeof r === 'number') return r;
  if (r === null || r === undefined) {
    console.error(`[se/heavy] weapon "${weapon.id}" has blastRadius ${JSON.stringify(r)} for ${what}; using fallback ${fallback}`);
    return fallback;
  }
  console.error(`[se/heavy] weapon "${weapon.id}" blastRadius shape unexpected for ${what}: ${JSON.stringify(r)}`);
  return fallback;
}

// Riot turret-local CONE geometry (riot_charge / riot_blast, firingMode
// 'turret_wedge'): the cone is DERIVED from the catalog blastRadius so the
// Charge stays STRICTLY SMALLER than the Blast (same single source of size as
// the old sphere carve — blastRadius 36 < 60), plus a forward reach. The cone
// mouth radius equals the blast radius (the carve footprint the settle cascade
// sizes off), and the forward reach is a catalog coneLength (effect.coneLength,
// world units apex->base). coneHalfAngleDeg then follows:
//   tan(half) = mouthRadius / coneLength.
// Read with the same fail-loud doctrine as recordRadius: a null blastRadius
// logs console.error naming the weapon (the settle-cascade stamp can't size
// without it) and falls back to the historical sphere radius; a missing
// coneLength falls back to a pinned forward reach.
export function riotConeParams(weapon) {
  const rPx = recordRadius(weapon, 30, 'riot instant cone'); // blastRadius (record-PIXELS)
  const rWorld = rPx * SE_PX_TO_WORLD;                        // mouth radius, world u
  const len = weapon && weapon.effect && typeof weapon.effect.coneLength === 'number'
    ? weapon.effect.coneLength
    : (console.error(`[se/heavy] weapon "${weapon ? weapon.id : '?'}" missing effect.coneLength — using fallback 12`), 12);
  const tanHalf = len > 0 ? rWorld / len : 1;
  const halfDeg = Math.atan(tanHalf) * 180 / Math.PI;
  return { halfDeg, mouthRWorld: rWorld, len };
}

// --- digger / sandhog ------------------------------------------------------
// COMB damage split (manual): diggers are TERRAIN-ONLY ("Removes small
// amounts of dirt; tunnels on impact, fizzles on a tank", data/weapons.json
// notes) — the terminal detonation carves DIRECTLY on the field, no
// dispatcher blast event, so the executor's damage seam never fires.
// Sandhogs detonate a real charge ("can destroy a tank from beneath",
// manual:L1109-1115) — a proper blast event (carve + damage).
function makeTunnelBehavior(TRAVEL, surfaceAtEnd, damages) {
  return {
    launch() { return []; },
    onTerrainHit(ctx, hit) {
      const st = bh(ctx);
      // COMB FIX: the executor routes onTerrainHit EVERY frame while ctx.hit
      // stays 'terrain' (stepBallistic only overwrites it during flight).
      // Re-entry must be a no-op — the old code reset st.dug = 0 on every
      // re-route, so the tunnel never completed and the shell never
      // detonated (live hang, exposed by the comb matrix).
      if (st.travel !== undefined) return [];
      const hp = hit ?? ctx.p;
      // T-UI-3 Tunneling option (manual:L2095-L2105): "OFF: weapons explode on
      // hitting dirt." se.settings.tunneling is the typed boolean applySettings
      // stores (enum on/off); default 'on' (undefined) keeps tunneling.
      if (ctx.se?.settings?.tunneling === false) {
        st.done = true;
        // Catalog detonation radius first (mirrors the normal detonation path
        // below) so weapons.json effect.detonationRadius is the SINGLE source
        // of truth; records without it stay LOUD (recordRadius names the gap).
        const catR = ctx.weapon.effect && typeof ctx.weapon.effect.detonationRadius === 'number' ? ctx.weapon.effect.detonationRadius : null;
        const r = catR ?? recordRadius(ctx.weapon, surfaceAtEnd ? 20 : 15, 'tunneling-off detonation');
        if (!damages) {
          const res = blast(ctx.field, { x: hp.x, y: hp.y, z: hp.z }, r * SE_PX_TO_WORLD);
          if (ctx.se?.v3d) ctx.se.v3d.enqueueRemesh(res.dirtyChunks); // CRATER-DRAIN: defer the render mesh
          // Terrain-only carve still stamps the ACTUAL carved world radius on
          // the impact seam (the executor only stamps its own blast events —
          // the direct path bypassed it, leaving lastImpact.rWorld unset).
          stampCarveWorldRadius(ctx.se, r * SE_PX_TO_WORLD);
          return [];
        }
        return [{ type: 'blast', x: hp.x, y: hp.y, z: hp.z, r }];
      }
      st.hit = { x: hp.x, y: hp.y, z: hp.z };
      // heading: horizontal flight direction at contact, normalized
      const hx = ctx.p.vx, hz = ctx.p.vz;
      const m = Math.hypot(hx, hz);
      if (m < 1e-9) { st.heading = { x: 1, z: 0 }; } else { st.heading = { x: hx / m, z: hz / m }; }
      st.travel = travelFor(TRAVEL, ctx.weapon);
      st.dug = 0;
      // dig row: 2 cells below the contact row (the shell contacts the
      // surface; the corridor sits just under it). Heights-only violation is
      // legal mid-tunnel (field.js doctrine) and is finished by the
      // detonation blast + compaction.
      st.digY = Math.max(0, cellY(hp.y) - 2);
      return [];
    },
    step(ctx, dt) {
      const st = bh(ctx);
      if (!st || st.done) return [];
      if (st.travel === undefined) {
        // FLIGHT (pre-contact): the executor delegates stepping to behaviors
        // (earth_disrupter comment), but this step() never integrated the
        // ballistic flight — diggers/sandhogs hung mid-air forever in the live
        // system (S3b gap, exposed by the T-UI-3 tunneling wiring pin).
        // Integrate exactly like dirtStep: gravity + wind, ctx.hit routes to
        // onTerrainHit in projectiles3d.
        const gravity = ctx.se?.gravity ?? 9.8;
        const wind = ctx.se?.wind ?? { x: 0, z: 0 };
        ctx.hit = stepBallistic(ctx.p, dt, ctx.field, { gravity, wind, ...flightSettingsFor(ctx.se) }); // W2-A settings seam
        return [];
      }
      const advance = TUNNEL_SPEED * dt;
      const room = Math.max(0, st.travel - st.dug);
      const move = Math.min(advance, room);
      // Carve at half-cell granularity along the centerline (corridor
      // half-width < 1 cell => 1 cell wide, per brief).
      const steps = Math.max(1, Math.ceil(move / (V * 0.5)));
      for (let i = 1; i <= steps; i++) {
        const wx = st.hit.x + st.heading.x * (st.dug + move * (i / steps));
        const wz = st.hit.z + st.heading.z * (st.dug + move * (i / steps));
        const cxi = cellX(wx), czi = cellZ(wz);
        if (inField(cxi, st.digY, czi) && solidAt(ctx.field, cxi, st.digY, czi)) {
          set(ctx.field, cxi, st.digY, czi, 0);
        }
      }
      st.dug += move;
      st.tunnelX = st.hit.x + st.heading.x * st.dug;
      st.tunnelZ = st.hit.z + st.heading.z * st.dug;
      if (st.dug >= st.travel - 1e-9) {
        st.done = true;
        // Detonation: diggers bang UNDERGROUND (blast center at the dig-row
        // world height -> crater lowers columnTop there); sandhogs surface
        // first (blast at the original surface plane).
        const by = surfaceAtEnd ? st.hit.y : centerY(st.digY); // DEEPEN-1015 R6: dig-row cell -> world via the offset-aware seam
        // Catalog detonation radius first (sandhog effect.detonationRadius);
        // records without it stay LOUD (recordRadius names the gap).
        const catR = ctx.weapon.effect && typeof ctx.weapon.effect.detonationRadius === 'number' ? ctx.weapon.effect.detonationRadius : null;
        const r = catR ?? recordRadius(ctx.weapon, surfaceAtEnd ? 20 : 15, 'detonation');
        if (!damages) {
          // Terrain-only terminal carve (digger): direct blast on the field,
          // no dispatcher event -> zero tank damage (earth_disrupter doctrine).
          const res = blast(ctx.field, { x: st.tunnelX, y: by, z: st.tunnelZ }, r * SE_PX_TO_WORLD);
          if (ctx.se?.v3d) ctx.se.v3d.enqueueRemesh(res.dirtyChunks); // CRATER-DRAIN: defer the render mesh
          // Stamp the ACTUAL carved world radius so settle3d announces the
          // crater-edge avalanche footprint at the real size, not the r=2
          // terrainCfg fallback (direct carve bypasses the executor stamp seam).
          stampCarveWorldRadius(ctx.se, r * SE_PX_TO_WORLD);
          return [];
        }
        return [{ type: 'blast', x: st.tunnelX, y: by, z: st.tunnelZ, r }];
      }
      return [];
    },
    done(ctx) { return !!(ctx.shot.bh && ctx.shot.bh.done); },
  };
}

const digger = makeTunnelBehavior(DIGGER_TRAVEL, false, false); // terrain-only (fizzles on a tank)
const sandhog = makeTunnelBehavior(SANDHOG_TRAVEL, true, true); // real charge, damage-capable

// --- dirt curtain ----------------------------------------------------------
// "Dirt Clods are small warheads which explode into a sphere of dirt when
// hitting something." (manual:L1136-L1137) S3c: the dirt class ADDS terrain
// ("compacted earth that explodes into a much larger amount of dirt ...
// build fortifications, or bury enemy tanks", manual:L1125-L1128). The
// deposition model lives in earthAdd.js (radii pinned + cited there).
// DUPLICATION, TEMPORARY (S3d unifies): the behavior emits
// {type:'earth_add', x, y, z, r, kind} for the future unified event pipeline,
// AND applies fillSphere directly on ctx.field + remeshes through ctx.se.v3d
// (systems/projectiles3d.js is owned elsewhere — it logs 'unknown behavior
// event type — skipped' for earth_add meanwhile, loud and benign). Works
// dispatched and standalone; missing ctx.se?.v3d fails loud once.
// DEGRADED-MARKER RULE: a record without dispatch info (no weapon.behavior —
// only ever a hand-built synthetic; production records from weapons.json
// always carry it) fails loud in dirtDeposit and keeps the old visual-only
// spawn-marker behavior instead of touching cells (S3b gate compat).
// Flight: dirt shells fly ballistic (stepBallistic) until terrain contact —
// without this the shell never reaches onTerrainHit in the live system.
const CURTAIN_SPREAD = [2.0, 0.0, -2.0]; // world-u perpendicular offsets (_placeholder spread width; no manual number; columns per brief "3 columns perpendicular spread")
function curtainColumns(ctx, count, spread) {
  // DEGRADED-MARKER PATH ONLY (see above): pick `count` of the symmetric
  // spread, centered; perpendicular to heading.
  const hx = ctx.p.vx, hz = ctx.p.vz;
  const m = Math.hypot(hx, hz);
  const px = m < 1e-9 ? 1 : -hz / m, pz = m < 1e-9 ? 0 : hx / m; // perpendicular
  const off = spread.slice(0, count);
  return off.map((o) => ({
    type: 'spawn',
    kind: 'dirt_column',
    x: ctx.p.x + px * o,
    y: ctx.p.y,
    z: ctx.p.z + pz * o,
    tall: true, // tall dark sphere column (visual-only marker; persists — no decay system, brief-blessed)
    dark: true,
  }));
}
function earthHit(ctx, hit) {
  const st = bh(ctx);
  const hp = hit ?? ctx.p;
  // T-UI-3 Extra Dirt (manual:L2131-L2136): "Controls how much dirt Dirt
  // Charges let out." Scope = the Dirt Charge itself (dirt_charge, behavior
  // liquid_dirt); magnitude unpinned by the manual -> _placeholder 2x ridge
  // radius (same placeholder doctrine as MOUND_R/RIDGE).
  const scale = ctx.weapon.id === 'dirt_charge' && ctx.se?.settings?.extraDirt === true ? 2 : 1;
  const dep = dirtDeposit(ctx.field, { x: hp.x, y: hp.y, z: hp.z }, ctx.weapon, { scale });
  if (!dep.kind) {
    // dirtDeposit already console.error'd the incomplete record — degraded
    // visual-only mode (no cell changes; the CALLER decides done/ooze).
    return null;
  }
  st.done = true;
  if (ctx.se?.v3d) {
    ctx.se.v3d.enqueueRemesh(dep.dirtyChunks); // CRATER-DRAIN: defer the render mesh
  } else if (!earthHit._warnedNoV3d) {
    earthHit._warnedNoV3d = true;
    console.error('[se/heavy] earth_add: ctx.se?.v3d missing — terrain filled but NOT remeshed (warned once)');
  }
  // Settle seam: same lastImpact shape projectiles3d publishes (cell = fill
  // top of the impact column) so the merged announce-stamp latch picks the
  // mound rim up. S3d unifies this via the event.
  stamp(ctx.se, { x: hp.x, y: hp.y, z: hp.z }, topCellOfFill(ctx.field, { x: hp.x, y: hp.y, z: hp.z }), dep.added, dep.r);
  return [{ type: 'earth_add', x: hp.x, y: hp.y, z: hp.z, r: dep.r, kind: dep.kind, added: dep.added }];
}
function dirtStep(ctx, dt) {
  const st = bh(ctx);
  if (st.done) return [];
  const gravity = ctx.se?.gravity ?? 9.8;
  const wind = ctx.se?.wind ?? { x: 0, z: 0 };
  ctx.hit = stepBallistic(ctx.p, dt, ctx.field, { gravity, wind, ...flightSettingsFor(ctx.se) }); // W2-A settings seam
  return [];
}
const dirt = {
  launch() { return []; },
  step: dirtStep,
  onTerrainHit(ctx, hit) {
    const ev = earthHit(ctx, hit);
    if (ev) return ev; // mound deposited
    bh(ctx).done = true; // degraded single-shot marker burst (old curtain behavior)
    return curtainColumns(ctx, 3, CURTAIN_SPREAD);
  },
  done(ctx) { return !!(ctx.shot.bh && ctx.shot.bh.done) || !!(ctx.hit && ctx.hit.hit === 'oob'); },
};

// --- liquid dirt -----------------------------------------------------------
// "Liquid Dirt oozes out wherever it lands, filling holes and smoothing the
// terrain." (manual:L1144-L1146) S3c: LOW WIDE ridge — fillSphere r=4
// flattened to half-height (earthAdd.RIDGE; _placeholder shape, prose pins no
// geometry). dirt_charge (behavior liquid_dirt, manual:L1148-L1149 "cloud of
// dirt") shares the model. Full hole-filling/smoothing convergence is
// settle3d's job once the stamp latch announces the rim.
// DEGRADED-MARKER RULE same as dirt: no weapon.behavior -> loud + the old
// 5-column ooze-marker behavior with 2s of extra spawns (S3b gate compat).
const LIQUID_SPREAD = [2.0, -2.0, 4.0, -4.0, 0.0]; // _placeholder (manual gives no geometry; 5 per brief)
const liquid_dirt = {
  launch() { return []; },
  step(ctx, dt) {
    const st = bh(ctx);
    if (!st || st.oozeStart === undefined || st.done) return dirtStep(ctx, dt);
    const el = ctx.t - st.oozeStart;
    const want = Math.min(4, Math.floor(el / 0.5)); // one extra per 0.5s for 2s -> 4 extra
    const out = [];
    while (st.oozeTicks < want) {
      st.oozeTicks++;
      // deterministic ooze column: spiral offsets, no rng
      const a = st.oozeTicks * 1.2566370614359172; // 2*pi/5 radians/tick (_placeholder golden-free fixed angle)
      out.push({ type: 'spawn', kind: 'dirt_column', ooze: true, tall: false, dark: true,
        x: ctx.p.x + Math.cos(a) * 1.0, y: ctx.p.y, z: ctx.p.z + Math.sin(a) * 1.0 });
    }
    if (el >= 2.0) st.done = true;
    return out;
  },
  onTerrainHit(ctx, hit) {
    const ev = earthHit(ctx, hit);
    if (ev) return ev; // ridge deposited; the earth is in the terrain, done
    const st = bh(ctx);
    st.oozeStart = ctx.t;
    st.oozeTicks = 0;
    return curtainColumns(ctx, 5, LIQUID_SPREAD);
  },
  done(ctx) { return !!(ctx.shot.bh && ctx.shot.bh.done) || !!(ctx.hit && ctx.hit.hit === 'oob'); },
};

// --- riot ------------------------------------------------------------------
// Riot weapons destroy terrain ("destroy a spherical section of dirt",
// manual:L1093; "wedge-shaped section ... from around your turret",
// manual:L1084-L1087; "Riot Blasts ... larger version", L1089-L1091;
// "Heavy Riot Bombs ... scaled up", L1098). Manual L1094: "They do no damage
// to tanks." STUN semantics DO NOT exist in this codebase yet — grep 'stun'
// over the manual returns nothing; stun/damage is S5-scope (damage system).
// Encoded: blast at weapon.blastRadius + smoke spawn marker. Wedge shape for
// charges/blasts is S-later (dispatch is generic onTerrainHit today).
const riot = {
  launch(ctx) { ctx.hit = null; return []; },
  // COMB FIX (flight gap — same class as the S3b digger/sandhog gap): the
  // executor delegates flight integration to the behavior (riot.step used to
  // return [] forever, so riot shells hung mid-air and never impacted).
  step(ctx, dt) {
    const st = bh(ctx);
    if (st.done) return [];
    if (ctx.hit && ctx.hit.hit) return []; // impact pending — onTerrainHit drives the carve
    const gravity = ctx.se?.gravity ?? 9.8;
    const wind = ctx.se?.wind ?? { x: 0, z: 0 };
    ctx.hit = stepBallistic(ctx.p, dt, ctx.field, { gravity, wind, ...flightSettingsFor(ctx.se) });
    return [];
  },
  onTerrainHit(ctx, hit) {
    const st = bh(ctx);
    if (st.done) return [];
    st.done = true;
    const rPx = recordRadius(ctx.weapon, 30, 'riot blast');
    // Manual L1094: "They do no damage to tanks." -> the carve is applied
    // DIRECTLY on the field (earth_disrupter doctrine) with the FIX2 px->world
    // calibration; NO dispatcher blast event, so the executor's damage seam
    // never fires for riot weapons.
    const res = blast(ctx.field, { x: ctx.p.x, y: ctx.p.y, z: ctx.p.z }, rPx * SE_PX_TO_WORLD);
    if (ctx.se?.v3d) ctx.se.v3d.enqueueRemesh(res.dirtyChunks); // CRATER-DRAIN: defer the render mesh
    else if (!riot._warnedNoV3d) {
      riot._warnedNoV3d = true;
      console.error('[se/heavy] riot: ctx.se?.v3d missing — dirt carved but NOT remeshed (warned once)');
    }
    // Stamp the ACTUAL carved world radius on the impact seam so settle3d's
    // announce footprint matches the real crater, not the terrainCfg r=2
    // fallback (direct carve, no dispatcher blast event).
    stampCarveWorldRadius(ctx.se, rPx * SE_PX_TO_WORLD);
    return [{ type: 'spawn', kind: 'smoke', x: ctx.p.x, y: ctx.p.y, z: ctx.p.z }];
  },
  done(ctx) { return !!(ctx.shot.bh && ctx.shot.bh.done); },
};

// --- earth disrupter -------------------------------------------------------
// "Earth Disrupters force all dirt to settle to the ground if dirt is being
// suspended in the air" (manual:L1151-L1152) — no suspension sim yet (S-later
// settles it); per brief we model the beam: it flies flat and low (launch
// zeroes vy), and while active carves a SMALL blast every 0.25s at the ground
// point beneath it. Manual gives no travel time -> _placeholder 3s.
// blastRadius is null in the record (manual table L993 "N/A") -> pinned small
// carve r _placeholder = 4 world u.
const DISRUPTER_TIME = 3; // fallback: effect.carveDurationS (_placeholder; manual:L1151-L1155 gives no duration)
const DISRUPTER_CARVE_R = 4; // fallback carve radius, world u (record blastRadius null; manual:L993)
// COMB: beam params are CATALOG data (data/weapons.json weapon.effect).
function effectNum(weapon, key, fallback) {
  const v = weapon && weapon.effect ? weapon.effect[key] : undefined;
  if (typeof v === 'number') return v;
  console.error(`[se/heavy] weapon "${weapon && weapon.id}" missing effect.${key} — using fallback ${fallback}`);
  return fallback;
}

// --- riot turret-local INSTANT BLAST (riot_charge / riot_blast) --------------
// The Charge + Blast are a BIG INSTANT EXPLOSION at the turret that carves a
// CONE out of the barrel (apex at the turret, opening forward in the aim
// direction) and TRIGGERS THE SETTLE CASCADE so the surrounding dirt collapses
// to the ground — the OG riot mechanic (manual L1084-1091: "destroy a spherical
// section of dirt ... wedge-shaped section ... from around your turret"). The
// cone is the barrel-shaped carve the user asked for (2026-10-21): a cone whose
// APEX is at the barrel spawn point (ctx.shot) opening forward along the aim
// bearing, NOT a sphere. They do NOT fire a projectile (the manual calls the
// Riot BOMB "a projectile weapon", manual L1093, implying Charge/Blast are not;
// the Riot Bomb / Heavy Riot Bomb keep the spherical projectile carve below).
// Manual L1094: "They do no damage to tanks" — the carve is applied DIRECTLY on
// the field (like riot onTerrainHit), no dispatcher blast event, so the damage
// seam never fires.
//
// The two paths are picked by the CATALOG flag weapon.effect.firingMode:
//   'turret_wedge' -> instantRiotCone (Charge/Blast, NO projectile)
//   (absent/'projectile') -> the existing projectile+sphere riot (Bomb/Heavy).
// The cone SIZE comes from the catalog blastRadius (riot_charge 36 < riot_blast
// 60 — the Charge's cone is STRICTLY SMALLER than the Blast's), converted
// record-PIXELS -> world via SE_PX_TO_WORLD; the cone's mouth radius equals the
// blast radius and its forward reach is the catalog effect.coneLength.
// instantRiotCone carves the cone + stamps the carved world radius on the
// impact seam (settle3d sizes the avalanche from it) so the surrounding dirt
// settles to the ground.
export function resolveRiotFiringMode(weapon) {
  const fm = weapon && weapon.effect ? weapon.effect.firingMode : undefined;
  return fm === 'turret_wedge' ? 'turret_wedge' : 'projectile';
}
// Instant turret cone: carve a CONE out of the barrel (apex at the turret
// origin, ctx.shot) opening forward along the aim bearing DIRECTLY on the field
// (no shell entity, no dispatcher blast event -> no tank damage). Returns the
// coneCarve() result shape { removed, byMaterial, touchedColumns, dirtyChunks }
// — the SAME shape blast() returns, so the instant-riot path is a drop-in swap
// of the old sphere carve. The turn advance is driven by the caller
// (projectiles3d.js calls se.director.impact()).
export function instantRiotCone(ctx) {
  const st = bh(ctx);
  if (st.done) return null;
  st.done = true;
  // Center = the turret origin (the barrel spawn point carried on the shot).
  const origin = ctx.shot || ctx.p;
  // Cone geometry from the catalog blastRadius (riot_charge 36 < riot_blast 60)
  // + effect.coneLength; the mouth radius = blast radius (record-PIXELS -> world),
  // the forward reach = coneLength. The Charge's cone is strictly smaller.
  const { halfDeg, mouthRWorld, len } = riotConeParams(ctx.weapon);
  const bearing = ctx.shot && typeof ctx.shot.bearingRad === 'number' ? ctx.shot.bearingRad
    : (ctx.p && typeof ctx.p.vx === 'number' && typeof ctx.p.vz === 'number' ? Math.atan2(ctx.p.vx, ctx.p.vz) : 0);
  const res = coneCarve(ctx.field, { x: origin.x, y: origin.y, z: origin.z }, bearing, halfDeg, len);
  if (ctx.se?.v3d) ctx.se.v3d.enqueueRemesh(res.dirtyChunks); // CRATER-DRAIN: defer the render mesh
  else if (!riot._warnedNoV3d) {
    riot._warnedNoV3d = true;
    console.error('[se/heavy] riot instant cone: ctx.se?.v3d missing — dirt carved but NOT remeshed (warned once)');
  }
  // PUBLISH THE IMPACT SEAM so settle3d's announceWatch latches onto the NEW
  // monotone stamp (the primary cascade trigger) and sizes the avalanche
  // footprint at the REAL cone's extent centered on the turret origin. coneCarve
  // never sets lastImpact, and this is a direct carve with NO dispatcher blast
  // event, so the executor's own impact publish (projectiles3d.js) never ran for
  // this path — WITHOUT this the settle cascade never announced and the dirt
  // around the carve never collapsed to the ground. REPLACE (don't bump) exactly
  // like the projectile impact path: the turret cone IS the current impact. The
  // stamp is monotone (se.impactN) so announceWatch's `stamp !== prev.prevStamp`
  // latches it. The rWorld is the cone's mouth radius (its widest extent), so
  // the cascade footprint covers the whole carve.
  if (ctx.se) {
    ctx.se.lastImpact = {
      x: origin.x, y: origin.y, z: origin.z, hit: 'terrain',
      cell: { x: cellX(origin.x), y: cellY(origin.y), z: cellZ(origin.z) },
      stamp: (ctx.se.impactN = (ctx.se.impactN || 0) + 1),
      rWorld: mouthRWorld,
    };
  }
  return res;
}

const earth_disrupter = {
  launch(ctx) {
    const st = bh(ctx);
    st.start = ctx.t;
    st.nextCarve = ctx.t; // carve immediately, then every 0.25s
    st.duration = effectNum(ctx.weapon, 'carveDurationS', DISRUPTER_TIME);
    st.carveR = effectNum(ctx.weapon, 'carveRadiusU', DISRUPTER_CARVE_R); // world units (direct carve)
    ctx.p.vy = 0; // flies flat and low (brief)
    return [];
  },
  step(ctx, dt) {
    const st = bh(ctx);
    if (!st || st.done) return [];
    // The beam flies flat and low: advance the pinned flight path (vx/vz
    // frozen, vy = 0). Gravity flight belongs to the dispatcher, but the
    // disrupter's path is flat by definition (launch zeroes vy).
    ctx.p.x += ctx.p.vx * dt;
    ctx.p.z += ctx.p.vz * dt;
    const out = [];
    while (ctx.t >= st.nextCarve && (ctx.t - st.start) <= st.duration + 1e-9) {
      const cxi = cellX(ctx.p.x), czi = cellZ(ctx.p.z);
      if (inField(cxi, 0, czi)) {
        // ground point beneath the flight path = top of the column
        const top = (() => { for (let y = H - 1; y >= 0; y--) if (solidAt(ctx.field, cxi, y, czi)) return y; return -1; })();
        if (top >= 0) {
          const gy = cellTopWorldY(top);
          // Brief: carve blast(field, p_on_surface, r) directly — the beam's
          // damage IS terrain excavation, no dispatcher blast needed.
          blast(ctx.field, { x: ctx.p.x, y: gy, z: ctx.p.z }, st.carveR);
          // Stamp the carved world radius (st.carveR is already world units) so
          // settle3d announces each carve's footprint at the real size, not the
          // terrainCfg r=2 fallback. Idempotent: max() over the beam's carves.
          stampCarveWorldRadius(ctx.se, st.carveR);
          out.push({ type: 'spawn', kind: 'beam', x: ctx.p.x, y: gy, z: ctx.p.z });
        }
      }
      st.nextCarve += 0.25;
    }
    if ((ctx.t - st.start) >= st.duration) st.done = true;
    return out;
  },
  onTerrainHit() { return []; },
  done(ctx) { return !!(ctx.shot.bh && ctx.shot.bh.done); },
};

// --- laser -----------------------------------------------------------------
// "The Laser shoots a high-intensity beam of light in a straight line,
// cutting through mountains, shields, and anything else in its way."
// (manual:L1176-L1178) Instant ray, no gravity flight: launch() casts along
// the shot heading (muzzle dir from p velocity) and marks done immediately.
// blastRadius null (manual table L995 "N/A") -> small pinned r _placeholder
// = 2 world u (cutting beam, not a crater).
export const LASER_R = 2; // _placeholder (manual:L995 N/A)
export const LASER_MAX_DIST = 400; // world u, covers the full field diagonal-ish
export function rayHit(field, origin, dir, maxDist) {
  const m = Math.hypot(dir.x, dir.y, dir.z);
  if (!(m > 1e-9)) {
    console.error('[se/heavy] rayHit: zero-length direction — no hit');
    return null;
  }
  const dx = dir.x / m, dy = dir.y / m, dz = dir.z / m;
  const stepLen = 0.5 * V; // brief-pinned sampling granularity
  for (let d = stepLen; d <= maxDist; d += stepLen) {
    const x = origin.x + dx * d, y = origin.y + dy * d, z = origin.z + dz * d;
    const cxi = cellX(x), cyi = cellY(y), czi = cellZ(z);
    if (!inField(cxi, cyi, czi)) return null; // left the field: no hit
    if (solidAt(field, cxi, cyi, czi)) return { x, y, z, cell: { x: cxi, y: cyi, z: czi }, dist: d };
  }
  return null;
}
const laser = {
  launch(ctx) {
    const st = bh(ctx);
    st.done = true; // no gravity flight (brief)
    const hit = rayHit(ctx.field, { x: ctx.p.x, y: ctx.p.y, z: ctx.p.z }, { x: ctx.p.vx, y: ctx.p.vy, z: ctx.p.vz }, LASER_MAX_DIST);
    if (!hit) return []; // beam into the sky: nothing detonates (loud already if dir was degenerate)
    // COMB: cut radius is CATALOG data (effect.cutRadius, record-PIXELS — the
    // executor converts at the FIX2 boundary).
    const rPx = ctx.weapon.effect && typeof ctx.weapon.effect.cutRadius === 'number'
      ? ctx.weapon.effect.cutRadius
      : recordRadius(ctx.weapon, LASER_R, 'laser cut');
    // COMB FIX (live-drop gap): the executor only executes step() events —
    // emit the instant blast from the first step (see plasma).
    st.blast = { type: 'blast', x: hit.x, y: hit.y, z: hit.z, r: rPx };
    return [];
  },
  step(ctx) {
    const st = bh(ctx);
    if (st.blast) { const e = st.blast; st.blast = null; return [e]; }
    return [];
  },
  onTerrainHit() { return []; },
  done(ctx) { return !!(ctx.shot.bh && ctx.shot.bh.done); },
};

// --- plasma ----------------------------------------------------------------
// Manual Plasma Blast, verbatim (manual:L1171-L1173):
//   "The Plasma Blast allows you to expel radioactive energy from your tank
//    to kill neighboring enemies. Your turret direction has no effect on the
//    Plasma Blast."
// The manual prose says NOTHING about power vs radius; the weapons table
// shows radius range "10-75" (manual:L994) and the energy section says you
// pick how many BATTERIES to expend (manual:L1160-L1168) but pins no formula.
// => AMBIGUOUS per the brief -> pinned rule (marked _placeholder):
//      r = min + power * (max - min)     (power in [0,1], shot.power)
// Turret direction has no effect: launch blasts at the tank position itself.
const plasma = {
  launch(ctx) {
    const st = bh(ctx);
    st.done = true;
    const br = ctx.weapon.blastRadius;
    if (!br || typeof br.min !== 'number' || typeof br.max !== 'number') {
      console.error(`[se/heavy] plasma: weapon "${ctx.weapon.id}" blastRadius must be {min,max}, got ${JSON.stringify(br)} — skipping`);
      return [];
    }
    const power = ctx.shot && typeof ctx.shot.power === 'number' ? Math.min(1, Math.max(0, ctx.shot.power)) : 1;
    const r = br.min + power * (br.max - br.min); // _placeholder rule (manual:L1171-L1173 silent on power->radius; range from manual:L994)
    // COMB FIX (live-drop gap): the executor only executes events from step()
    // — launch() return values never reach the dispatcher, so the live plasma
    // blast never fired. Compute at launch (turret direction irrelevant,
    // manual L1172-1173), emit from the first step.
    st.blast = { type: 'blast', x: ctx.p.x, y: ctx.p.y, z: ctx.p.z, r };
    return [];
  },
  step(ctx) {
    const st = bh(ctx);
    if (st.blast) { const e = st.blast; st.blast = null; return [e]; }
    return [];
  },
  onTerrainHit() { return []; },
  done(ctx) { return !!(ctx.shot.bh && ctx.shot.bh.done); },
};

export const HEAVY_BEHAVIORS = { riot, digger, sandhog, dirt, liquid_dirt, earth_disrupter, laser, plasma };
