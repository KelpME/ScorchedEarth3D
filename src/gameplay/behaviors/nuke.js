// S3a — nuke behavior: terrain hit = ONE single blast at weapon.blastRadius,
// PLUS a lingering glow marker (a small fx sphere via a {type:'spawn'} event;
// the system spawns it — systems/projectiles3d.js). NO radiation mechanic:
// the manual describes none (grep 'radiation' finds nothing in
// docs/manuals/scorched-earth-1.5-manual.txt).
// Manual: L1011-L1012 (Baby Nuke): "a nuclear explosive capable of
// destroying a large region." L1014-L1015 (Nuke): "a large-scale nuclear
// weapons capable of mass destruction." (data/weapons.json L7-L8: r 40/75.)
import { stepBallistic } from '../ballistics3d.js';

const GLOW_LIFE = 5; // seconds the glow lingers — fallback: effect.glowLifeS (_placeholder_glow_life, manual: none)

// COMB: fx magnitudes are CATALOG data (data/weapons.json weapon.effect).
function effectNum(weapon, key, fallback) {
  const v = weapon && weapon.effect ? weapon.effect[key] : undefined;
  if (typeof v === 'number') return v;
  console.error(`[se/nuke] weapon "${weapon && weapon.id}" missing effect.${key} — using fallback ${fallback}`);
  return fallback;
}

function radiusOf(weapon) {
  const r = weapon && weapon.blastRadius;
  return typeof r === 'number' ? r : 0;
}

export default {
  launch(ctx) {
    ctx.hit = null;
    ctx.state.glow = false;
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
    ctx.state.glow = true; // ctx flag for the lingering glow (brief)
    const r = radiusOf(ctx.weapon);
    return [
      { type: 'blast', x: hit.x, y: hit.y, z: hit.z, r },
      { type: 'spawn', fx: 'glow', x: hit.x, y: hit.y, z: hit.z, r, life: effectNum(ctx.weapon, 'glowLifeS', GLOW_LIFE) },
    ];
  },
  done(ctx) {
    return ctx.state.done === true || !!(ctx.hit && ctx.hit.hit === 'oob');
  },
};
