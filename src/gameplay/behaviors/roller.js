// S3a — roller behavior: fly ballistic; after the FIRST terrain contact the
// warhead does NOT stop — it becomes a roller: keeps moving along the surface
// (ground-follow y = column surface, speed decay 0.98/frame, pinned) for the
// run length, blasting small craters r = blastRadius*0.6 every 1.5 units of
// travel (crater placed exactly at the 1.5u mark), then detonates with a
// final full-r blast. No flight bounces after contact.
// Manual: docs/manuals/scorched-earth-1.5-manual.txt L1060-L1064 (Baby
// Rollers): "When they hit ground, they roll downhill until reaching a valley
// or a tank. They then explode with the force of a baby missile." L1065-L1066
// (Rollers): "functionally the same as baby rollers... standard missile"
// warhead. L1068-L1069 (Heavy Rollers).
// _placeholder_roller_runLength: the manual gives NO travel distance, so run
// = weapon.rollRun ?? 12 world units (brief-pinned).
// _placeholder_roller_period: craters every 1.5u traveled — brief-pinned
// cadence, manual has none.
import { stepBallistic } from '../ballistics3d.js';
import { cellX, cellZ, cellTopWorldY, V, FIELD_X_MIN, FIELD_X_MAX, FIELD_Z_MIN, FIELD_Z_MAX } from '../../voxel3d/constants.js';
import { columnTop } from '../../voxel3d/field.js';

const RUN = 12;               // world units, fallback: effect.rollRunU (_placeholder_roller_runLength)
const CRATER_EVERY = 1.5;     // world units, fallback: effect.craterEveryU (_placeholder_roller_period)
const DECAY = 0.98;           // per frame (brief-pinned ~0.98/frame)
const STALL = 0.05;           // u/s — below this the roller dies (final blast)

// COMB: run length + crater cadence are CATALOG data (weapon.effect,
// data/weapons.json; _placeholder values — manual L1060-1069 pins neither).
function effectNum(weapon, key, fallback) {
  const v = weapon && weapon.effect ? weapon.effect[key] : undefined;
  if (typeof v === 'number') return v;
  console.error(`[se/roller] weapon "${weapon && weapon.id}" missing effect.${key} — using fallback ${fallback}`);
  return fallback;
}

function radiusOf(weapon) {
  const r = weapon && weapon.blastRadius;
  return typeof r === 'number' ? r : 0;
}
const lerp = (a, b, f) => a + (b - a) * f;

// World surface y of the column under (x,z); -1 top (carved column) -> fall
// through (oob logic in the fly phase owns it; while rolling, keep y).
function surfaceY(field, x, z) {
  const t = columnTop(field, cellX(x), cellZ(z));
  return cellTopWorldY(t);
}

export default {
  launch(ctx) {
    ctx.hit = null;
    ctx.state.rolling = false;
    ctx.state.traveled = 0;
    ctx.state.craterEvery = effectNum(ctx.weapon, 'craterEveryU', CRATER_EVERY);
    ctx.state.nextCrater = ctx.state.craterEvery;
  },
  step(ctx, dt) {
    if (ctx.state.done) return [];
    if (ctx.hit && ctx.hit.hit) return []; // terrain hit pending — onTerrainHit drives the roll
    if (!ctx.state.rolling) {
      const gravity = ctx.se?.gravity ?? 9.8;
      const wind = ctx.se?.wind ?? { x: 0, z: 0 };
      ctx.hit = stepBallistic(ctx.p, dt, ctx.field, { gravity, wind });
      return [];
    }
    // --- rolling phase: ground-follow, decayed speed, periodic craters ---
    const p = ctx.p;
    const events = [];
    const speed = Math.hypot(p.vx, p.vz);
    const run = effectNum(ctx.weapon, 'rollRunU', typeof ctx.weapon.rollRun === 'number' ? ctx.weapon.rollRun : RUN);
    if (speed <= STALL) {
      ctx.state.done = true;
      events.push({ type: 'blast', x: p.x, y: surfaceY(ctx.field, p.x, p.z), z: p.z, r: radiusOf(ctx.weapon) });
      return events;
    }
    const ux = p.vx / speed, uz = p.vz / speed;
    const px = p.x, pz = p.z;
    const prevTravel = ctx.state.traveled;
    const d = speed * dt;
    let nx = p.x + p.vx * dt, nz = p.z + p.vz * dt;
    if (nx < FIELD_X_MIN || nx >= FIELD_X_MAX || nz < FIELD_Z_MIN || nz >= FIELD_Z_MAX) {
      // Reached the world edge while rolling: detonate where we are (blast
      // clamps to the field), never an oob shell.
      ctx.state.done = true;
      events.push({ type: 'blast', x: p.x, y: surfaceY(ctx.field, p.x, p.z), z: p.z, r: radiusOf(ctx.weapon) });
      return events;
    }
    ctx.state.traveled = prevTravel + d;
    // Craters land EXACTLY on the 1.5u grid (interpolated between frames).
    while (ctx.state.nextCrater <= ctx.state.traveled && ctx.state.nextCrater < run) {
      const f = (ctx.state.nextCrater - prevTravel) / (ctx.state.traveled - prevTravel);
      const cxp = lerp(px, nx, f), czp = lerp(pz, nz, f);
      events.push({ type: 'blast', x: cxp, y: surfaceY(ctx.field, cxp, czp), z: czp, r: radiusOf(ctx.weapon) * 0.6 });
      ctx.state.nextCrater += ctx.state.craterEvery;
    }
    if (ctx.state.traveled >= run) {
      // Run complete: detonate at the pinned run mark with the full radius.
      const f = (run - prevTravel) / (ctx.state.traveled - prevTravel);
      const cxp = lerp(px, nx, f), czp = lerp(pz, nz, f);
      ctx.state.done = true;
      events.push({ type: 'blast', x: cxp, y: surfaceY(ctx.field, cxp, czp), z: czp, r: radiusOf(ctx.weapon) });
      return events;
    }
    p.x = nx; p.z = nz;
    p.y = surfaceY(ctx.field, nx, nz);
    p.vx *= DECAY; p.vz *= DECAY;
    p.vy = 0;
    return events;
  },
  onTerrainHit(ctx, hit) {
    // First contact is NOT an explosion — it starts the roll (manual L1062:
    // "When they hit ground, they roll downhill").
    if (ctx.state.rolling || ctx.state.done) return [];
    ctx.state.rolling = true;
    ctx.hit = null;
    const p = ctx.p;
    p.y = surfaceY(ctx.field, p.x, p.z);
    p.vy = 0;
    return [];
  },
  done(ctx) {
    return ctx.state.done === true || !!(ctx.hit && ctx.hit.hit === 'oob');
  },
};
