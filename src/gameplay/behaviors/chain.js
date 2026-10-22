// S3a — chain behavior (Funky Bomb): fly ballistic; on the terrain hit the
// parent does NOT blast — instead it SPLASHES chainCount submunitions that
// BOUNCE OUT in RANDOM horizontal directions at RANDOM distances, each a new
// 'ballistic' projectile carrying its own RANDOM blast radius. The
// submunitions fly ballistically and carve their own blast on landing (the
// executor's submunitions -> spawnSub -> ballistic -> blast path). The parent
// is consumed by the splash (state.done = true); the chain IS the whole effect.
//
// Manual: docs/manuals/scorched-earth-1.5-manual.txt L1021-L1024 (Funky Bomb):
// "The Funky Bomb explodes in a multi-colored toxic chain reaction. Sometimes
// they don't explode exactly where you want them to, but they are generally
// confined to the area where they hit." The OG text gives no count/distance/
// radius — the chain params are CATALOG data (data/weapons.json effect.
// chainCount / chainMinDistU / chainMaxDistU / chainRadiusMinU / chainRadiusMaxU).
// USER DIRECTIVE (authoritative): on impact 5 projectiles bounce out at a random
// direction and distance, each with a random-sized destruction when it lands.
//
// Determinism: the splash pattern (angles, distances, radii) comes from an LCG
// seeded from the SHOT position (quantised to mm so float noise cannot fork the
// stream) — no Math.random, no wall clock. Same firing station + same shot =>
// the same chain. (lcg/seedFrom copied verbatim from napalm.js's doctrine so
// napalm.js stays untouched.)
import { stepBallistic, flightSettingsFor } from '../ballistics3d.js';
import { wallsConfigFor } from '../walls.js'; // W2-B — wall opts ride the shot seam

// Fallbacks for synthetic test records without the catalog effect fields (the
// catalog — data/weapons.json — is the real source; doctrine: fail loud).
const CHAIN_COUNT = 5;     // fallback: effect.chainCount — USER directive: 5 projectiles
const CHAIN_MIN_DIST = 3;  // world units — bounce-out distance floor ("confined to the area where they hit", L1021-L1024)
const CHAIN_MAX_DIST = 12; // world units — bounce-out distance ceiling (_placeholder; manual/OG silent)
const CHAIN_RMIN = 20;     // fallback: effect.chainRadiusMinU — record px -> submunition blastRadius (executor converts 0.2 -> world)
const CHAIN_RMAX = 40;     // fallback: effect.chainRadiusMaxU — smaller than the parent's 80px blast
const CHAIN_UP = 5;        // world u/s — the upward bounce so each submunition arcs (_placeholder; manual/OG silent)

// Catalog param read: weapon.effect.<key> number, else LOUD fallback (no
// silent defaults — doctrine; mirrors napalm/cluster's effectNum).
function effectNum(weapon, key, fallback) {
  const v = weapon && weapon.effect ? weapon.effect[key] : undefined;
  if (typeof v === 'number') return v;
  console.error(`[se/chain] weapon "${weapon && weapon.id}" missing effect.${key} — using fallback ${fallback}`);
  return fallback;
}

// mulberry-style LCG: 32-bit state, deterministic bit-for-bit (verbatim napalm).
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Seed from the shot position (quantised to mm so float noise cannot fork the
// stream): the same firing station always splashes the same chain pattern
// (verbatim napalm).
function seedFrom(shot) {
  const q = (v) => Math.round((v || 0) * 1000);
  return (Math.imul(q(shot && shot.x), 73856093)
    ^ Math.imul(q(shot && shot.y), 19349663)
    ^ Math.imul(q(shot && shot.z), 83492791)) >>> 0;
}

export default {
  launch(ctx) {
    ctx.hit = null;
    ctx.state.count = effectNum(ctx.weapon, 'chainCount', CHAIN_COUNT);
    ctx.state.done = false;
  },
  step(ctx, dt) {
    if (ctx.state.done) return [];
    const gravity = ctx.se?.gravity ?? 9.8;
    const wind = ctx.se?.wind ?? { x: 0, z: 0 };
    // Fly the parent ballistically (same flight path as ballistic/napalm).
    ctx.hit = stepBallistic(ctx.p, dt, ctx.field, { gravity, wind, walls: wallsConfigFor(ctx.se, ctx.shot), ...flightSettingsFor(ctx.se) });
    return []; // the splash happens in onTerrainHit
  },
  onTerrainHit(ctx, hit) {
    // The parent does NOT blast here — it SPLASHES chainCount submunitions that
    // bounce out in random directions/distances, each a new ballistic projectile
    // with its own random blast radius. The chain IS the effect (manual L1021-
    // L1024). The parent is consumed by the splash (executor destroys it).
    ctx.state.done = true;
    const count = ctx.state.count;
    const minD = effectNum(ctx.weapon, 'chainMinDistU', CHAIN_MIN_DIST);
    const maxD = effectNum(ctx.weapon, 'chainMaxDistU', CHAIN_MAX_DIST);
    const minR = effectNum(ctx.weapon, 'chainRadiusMinU', CHAIN_RMIN);
    const maxR = effectNum(ctx.weapon, 'chainRadiusMaxU', CHAIN_RMAX);
    // ONE seeded stream, fixed draw order (angle, distance, radius per sub) —
    // deterministic for a given shot position.
    const rnd = lcg(seedFrom(ctx.shot));
    const list = [];
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;           // random horizontal direction [0, 2π)
      const d = minD + rnd() * (maxD - minD);   // random bounce-out distance (world units)
      const r = minR + rnd() * (maxR - minR);   // random blast radius (record px -> submunition)
      const cx = Math.cos(a), sz = Math.sin(a);
      list.push({
        x: hit.x + cx * d,       // offset within [minD, maxD] of the impact
        y: hit.y,
        z: hit.z + sz * d,
        vx: cx * d,              // velocity TOWARD the offset (speed = distance -> lands near it)
        vy: CHAIN_UP,            // upward bounce so the submunition arcs
        vz: sz * d,
        behavior: 'ballistic',   // reuse the existing ballistic landing->blast path
        blastRadius: r,          // record px (executor converts 0.2 -> world); smaller than parent's 80
      });
    }
    return [{ type: 'submunitions', list }];
  },
  done(ctx) {
    // Consumed by the splash, or the parent flew off-world / into a wall.
    return ctx.state.done === true || !!(ctx.hit && (ctx.hit.hit === 'oob' || ctx.hit.hit === 'wall'));
  },
};
