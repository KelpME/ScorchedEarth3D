// S3a — napalm behavior: fly ballistic; on terrain hit the primary blast + 3
// secondary blasts at random-but-DETERMINISTIC offsets, emitted after the
// primary in the SAME frame (event order = execution order).
// Manual: docs/manuals/scorched-earth-1.5-manual.txt L1035-L1040 (Napalm):
// "Napalm splashes around wherever it hits and then bursts into hot flame...
// more heat... if it forms deep pools." L1042-L1044 (Hot Napalm): "otherwise
// it functions pretty much like Napalm" -> same behavior, hotter via record.
// Secondary r = blastRadius * 0.5 (brief-pinned spread model).
// Determinism: the spread offsets come from an LCG seeded from the SHOT
// position — no Math.random, no wall clock (same as ballistics3d's doctrine).
import { stepBallistic } from '../ballistics3d.js';

// COMB: the burn radius is CATALOG data — OG weaponTable idx8/9
// blastRadiusParam 15/20 (manual table says N/A). Fallback 0 + loud for
// synthetic records without effect.burnRadius.
const SECONDARIES = 3;      // fallback: effect.secondaries (brief-pinned spread)
const MIN_SPREAD = 0.4;     // world units — "splashes around wherever it hits" (L1035)
const MAX_SPREAD = 2.0;

function effectNum(weapon, key, fallback) {
  const v = weapon && weapon.effect ? weapon.effect[key] : undefined;
  if (typeof v === 'number') return v;
  console.error(`[se/napalm] weapon "${weapon && weapon.id}" missing effect.${key} — using fallback ${fallback}`);
  return fallback;
}

function radiusOf(weapon) {
  return effectNum(weapon, 'burnRadius', 0); // no catalog burn radius -> 0 + loud (no invented damage)
}

// mulberry-style LCG: 32-bit state, deterministic bit-for-bit.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Seed from the shot position (quantised to mm so float noise cannot fork the
// stream): the same firing station always paints the same splash pattern.
function seedFrom(shot) {
  const q = (v) => Math.round((v || 0) * 1000);
  return (Math.imul(q(shot && shot.x), 73856093)
    ^ Math.imul(q(shot && shot.y), 19349663)
    ^ Math.imul(q(shot && shot.z), 83492791)) >>> 0;
}

export default {
  launch(ctx) {
    ctx.hit = null;
  },
  step(ctx, dt) {
    if (ctx.state.done) return [];
    const gravity = ctx.se?.gravity ?? 9.8;
    const wind = ctx.se?.wind ?? { x: 0, z: 0 };
    ctx.hit = stepBallistic(ctx.p, dt, ctx.field, { gravity, wind });
    return [];
  },
  onTerrainHit(ctx, hit) {
    ctx.state.done = true;
    const r = radiusOf(ctx.weapon);
    const secondaries = effectNum(ctx.weapon, 'secondaries', SECONDARIES);
    const minS = effectNum(ctx.weapon, 'spreadMinU', MIN_SPREAD);
    const maxS = effectNum(ctx.weapon, 'spreadMaxU', MAX_SPREAD);
    const events = [{ type: 'blast', x: hit.x, y: hit.y, z: hit.z, r }];
    const rnd = lcg(seedFrom(ctx.shot));
    for (let i = 0; i < secondaries; i++) {
      const a = rnd() * Math.PI * 2;
      const d = minS + rnd() * (maxS - minS);
      events.push({
        type: 'blast',
        x: hit.x + Math.cos(a) * d,
        y: hit.y,
        z: hit.z + Math.sin(a) * d,
        r: r * 0.5,
      });
    }
    return events;
  },
  done(ctx) {
    return ctx.state.done === true || !!(ctx.hit && ctx.hit.hit === 'oob');
  },
};
