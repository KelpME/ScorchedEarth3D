// S3a — cluster behaviors (multiwarhead_*): MIRV (apogee split) and Leap Frog
// / Death's Head (sequential timed release). Each submunition is a plain
// p-like {x,y,z,vx,vy,vz} + behavior 'ballistic' + its own blastRadius,
// carried to the executor in a {type:'submunitions', list:[...]} event.
//
// Manual: docs/manuals/scorched-earth-1.5-manual.txt
//  - L1026-L1029 (MIRV): "contains five Missile warheads, which split apart
//    when the original missile reaches apogee. If the warhead hits something
//    before reaching apogee, it will not explode."
//  - L1031-L1033 (Death's Head): "Functionally equivalent to MIRVs, it
//    contains nine large scale explosive warheads."
//  - L1017-L1019 (Leapfrog): "has three warheads which launch one after
//    another. This is often very effective for penetrating shields."
//
// _placeholder_cluster_fan: +/-20 deg fan at apogee, 1s sequential interval —
// brief-pinned; the manual gives no angles or timing. COMB: BOTH are catalog
// data now (weapon.effect.splitAngleDeg / weapon.effect.seqIntervalS,
// data/weapons.json) — the constants below are fallbacks for synthetic test
// records only.
import { stepBallistic, flightSettingsFor } from '../ballistics3d.js';

const APEX_SUBS = 3;          // fallback count when effect.warheadCount is missing
const FAN_DEG = 20;           // fallback: effect.splitAngleDeg (_placeholder)
const SEQ_INTERVAL = 1;       // s, fallback: effect.seqIntervalS (_placeholder)
const SEQ_DEFAULT = 3;        // fallback count for scalar-radius records
// hop (leap_frog): fallback horizontal/vertical speed for the single-bullet
// ground-hopping mechanic — the catalog (data/weapons.json effect.hopSpeedU /
// hopHeightU) is the real source; these are synthetic-test-record fallbacks.
const HOP_SPEED = 12;         // world u/s horizontal per hop, fallback: effect.hopSpeedU
const HOP_HEIGHT = 6;         // world u/s upward for the arc, fallback: effect.hopHeightU

// Catalog param read: weapon.effect.<key> number, else LOUD fallback (no
// silent defaults — doctrine).
function effectNum(weapon, key, fallback) {
  const v = weapon && weapon.effect ? weapon.effect[key] : undefined;
  if (typeof v === 'number') return v;
  console.error(`[se/cluster] weapon "${weapon && weapon.id}" missing effect.${key} — using fallback ${fallback}`);
  return fallback;
}

// Warhead count: effect.warheadCount (mirv 5 / deaths_head 9 / leap_frog 3,
// data/weapons.json) wins; array-radius records fall back to the list length;
// scalar records to SEQ_DEFAULT. Manual: L1026-1029 (five), L1031-1033
// (nine), L1017-1019 (three) == OG weaponTable idx4-7.
function countFor(weapon, kind, radiiLen) {
  const wc = weapon && weapon.effect ? weapon.effect.warheadCount : undefined;
  if (typeof wc === 'number' && wc > 0) return wc;
  const fb = kind === 'apogee' ? APEX_SUBS : (radiiLen || SEQ_DEFAULT);
  console.error(`[se/cluster] weapon "${weapon && weapon.id}" missing effect.warheadCount — using fallback ${fb}`);
  return fb;
}

// Radius list for subs: array record -> per-sub radius; scalar -> all equal.
function radiusList(weapon, count) {
  const r = weapon && weapon.blastRadius;
  if (Array.isArray(r)) return r.slice();
  return new Array(count).fill(typeof r === 'number' ? r : 0);
}

function rotate(vx, vz, deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return { vx: vx * c - vz * s, vz: vx * s + vz * c };
}

// --- multiwarhead_apogee (MIRV): split exactly when vy crosses zero ---
export const apogee = {
  launch(ctx) {
    ctx.hit = null;
    ctx.state.split = false;
  },
  step(ctx, dt) {
    if (ctx.state.done) return [];
    const prevVy = ctx.p.vy;
    const gravity = ctx.se?.gravity ?? 9.8;
    const wind = ctx.se?.wind ?? { x: 0, z: 0 };
    ctx.hit = stepBallistic(ctx.p, dt, ctx.field, { gravity, wind, ...flightSettingsFor(ctx.se) }); // W2-A settings seam
    if (ctx.hit && ctx.hit.hit) return []; // terrain before apogee: handled in onTerrainHit
    if (prevVy > 0 && ctx.p.vy <= 0) {
      // APOGEE: vy changed sign on this frame. Split into warheadCount subs
      // fanning +/-splitAngleDeg around the parent's horizontal heading
      // (manual L1026-L1029; count from the catalog, OG = 5). Parent is
      // consumed by the split.
      ctx.state.split = true;
      ctx.state.done = true;
      const count = countFor(ctx.weapon, 'apogee', Array.isArray(ctx.weapon.blastRadius) ? ctx.weapon.blastRadius.length : null);
      const radii = radiusList(ctx.weapon, count);
      const fan = effectNum(ctx.weapon, 'splitAngleDeg', FAN_DEG);
      const offs = [];
      const step = count > 1 ? (2 * fan) / (count - 1) : 0;
      for (let i = 0; i < count; i++) offs.push(-fan + i * step);
      const list = offs.map((deg, i) => {
        const rv = rotate(ctx.p.vx, ctx.p.vz, deg);
        return {
          x: ctx.p.x, y: ctx.p.y, z: ctx.p.z,
          vx: rv.vx, vy: ctx.p.vy, vz: rv.vz,
          behavior: 'ballistic',
          blastRadius: radii[i % radii.length],
        };
      });
      return [{ type: 'submunitions', list }];
    }
    return [];
  },
  onTerrainHit(ctx, hit) {
    // "If the warhead hits something before reaching apogee, it will not
    // explode." (manual L1028-L1029) — pure dud, no blast events.
    ctx.state.done = true;
    return [];
  },
  done(ctx) {
    return ctx.state.done === true || !!(ctx.hit && ctx.hit.hit === 'oob');
  },
};

// --- multiwarhead_sequential (Leap Frog / Death's Head) ---
// Subs released at t = 1s, 2s, 3s after launch while the parent keeps
// flying (manual L1017-L1019 "one after another"). Parent impact releases any
// unreleased subs at the impact point; the parent itself never blasts.
export const sequential = {
  launch(ctx) {
    ctx.hit = null;
    ctx.state.released = 0;
    ctx.state.nextT = effectNum(ctx.weapon, 'seqIntervalS', SEQ_INTERVAL);
  },
  _release(ctx, i, radii) {
    // Slight deterministic lateral stagger so the warheads don't retrace the
    // parent path exactly (shield-penetration spread, manual L1018-L1019).
    const speed = Math.hypot(ctx.p.vx, ctx.p.vz);
    const perpX = speed > 0 ? -ctx.p.vz / speed : 1;
    const perpZ = speed > 0 ? ctx.p.vx / speed : 0;
    const off = (i - 1) * 0.5;
    return {
      x: ctx.p.x + perpX * off, y: ctx.p.y, z: ctx.p.z + perpZ * off,
      vx: ctx.p.vx, vy: ctx.p.vy, vz: ctx.p.vz,
      behavior: 'ballistic',
      blastRadius: radii[i % radii.length],
    };
  },
  step(ctx, dt) {
    if (ctx.state.done) return [];
    const gravity = ctx.se?.gravity ?? 9.8;
    const wind = ctx.se?.wind ?? { x: 0, z: 0 };
    ctx.hit = stepBallistic(ctx.p, dt, ctx.field, { gravity, wind, ...flightSettingsFor(ctx.se) }); // W2-A settings seam
    const events = [];
    const count = countFor(ctx.weapon, 'sequential', Array.isArray(ctx.weapon.blastRadius) ? ctx.weapon.blastRadius.length : null);
    const radii = radiusList(ctx.weapon, count);
    const interval = effectNum(ctx.weapon, 'seqIntervalS', SEQ_INTERVAL);
    while (ctx.state.released < radii.length && ctx.t >= ctx.state.nextT - 1e-9) {
      events.push({ type: 'submunitions', list: [this._release(ctx, ctx.state.released, radii)] });
      ctx.state.released++;
      ctx.state.nextT += interval;
    }
    return events;
  },
  onTerrainHit(ctx, hit) {
    // Parent impact: dump any warheads not yet released at the impact point
    // (they launch from there); the carrier itself never explodes.
    const events = [];
    const count = countFor(ctx.weapon, 'sequential', Array.isArray(ctx.weapon.blastRadius) ? ctx.weapon.blastRadius.length : null);
    const radii = radiusList(ctx.weapon, count);
    while (ctx.state.released < radii.length) {
      events.push({ type: 'submunitions', list: [this._release(ctx, ctx.state.released, radii)] });
      ctx.state.released++;
    }
    ctx.state.done = true;
    return events;
  },
  done(ctx) {
    return ctx.state.done === true || !!(ctx.hit && ctx.hit.hit === 'oob');
  },
};

// --- hop (Leap Frog, single-bullet ground-hopping) ---------------------------
// ONE bullet that HOPS across the ground: it flies ballistically, carves a
// blast at the landing (the 'blast' event path does the carve + tank damage +
// treeBlast + VFX — the behavior returns the event, it never carves itself),
// then HOPS forward: relaunches the SAME entity with a new forward+up velocity
// and arcs to the next landing, repeating warheadCount times. NO submunitions
// are spawned (no spawnSub) — ctx.p is mutated in place.
// Manual L1017-L1019: "has three warheads which launch one after another" —
// the OG text is the sequential-launch reading; OUR interpretation of the user
// brief ("hop across the ground, destroying at each landing") is the hop
// mechanic below. Per-hop radius + hop speed/height/count are CATALOG data
// (data/weapons.json: blastRadius[] + effect.hopSpeedU / hopHeightU /
// warheadCount). Fail loud when missing (doctrine, effectNum).
export const hop = {
  launch(ctx) {
    ctx.hit = null;
    ctx.state.hops = 0;
    ctx.state.count = countFor(ctx.weapon, 'hop', Array.isArray(ctx.weapon.blastRadius) ? ctx.weapon.blastRadius.length : null);
    ctx.state.radii = radiusList(ctx.weapon, ctx.state.count);
    ctx.state.done = false;
  },
  step(ctx, dt) {
    if (ctx.state.done) return [];
    const gravity = ctx.se?.gravity ?? 9.8;
    const wind = ctx.se?.wind ?? { x: 0, z: 0 };
    ctx.hit = stepBallistic(ctx.p, dt, ctx.field, { gravity, wind, ...flightSettingsFor(ctx.se) }); // W2-A settings seam
    return []; // the landing carve + relaunch happen in onTerrainHit
  },
  onTerrainHit(ctx, hit) {
    // The bullet landed: carve a blast HERE (the 'blast' event path handles
    // carve + tank damage + treeBlast + VFX — do NOT re-implement the carve).
    const events = [{ type: 'blast', x: ctx.p.x, y: ctx.p.y, z: ctx.p.z, r: ctx.state.radii[ctx.state.hops % ctx.state.radii.length] }];
    ctx.state.hops++;
    if (ctx.state.hops < ctx.state.count) {
      // HOP: relaunch the SAME entity forward along its current horizontal
      // heading + an upward arc. Re-read the catalog speeds each hop (data).
      const hopSpeed = effectNum(ctx.weapon, 'hopSpeedU', HOP_SPEED);
      const hopHeight = effectNum(ctx.weapon, 'hopHeightU', HOP_HEIGHT);
      const hx = ctx.p.vx, hz = ctx.p.vz;
      const hlen = Math.hypot(hx, hz);
      if (hlen > 0) {
        ctx.p.vx = (hx / hlen) * hopSpeed;
        ctx.p.vz = (hz / hlen) * hopSpeed;
      }
      ctx.p.vy = hopHeight;
      ctx.hit = null; // clear the just-handled hit so step() flies the new arc
    } else {
      // warheadCount hops done: stop hopping, the loop destroys the entity.
      ctx.state.done = true;
    }
    return events;
  },
  done(ctx) {
    return ctx.state.done === true || !!(ctx.hit && ctx.hit.hit === 'oob');
  },
};
