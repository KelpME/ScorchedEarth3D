// S3a — ballistic behavior: the current shell path refactored behind the
// behavior interface. Fly via stepBallistic; a terrain hit is ONE blast event
// at weapon.blastRadius (data/weapons.json L5-L6: baby_missile "Earliest
// developed weapon", missile "larger blast radius and damage" — manual:
// docs/manuals/scorched-earth-1.5-manual.txt L1004-L1009 Baby Missile /
// Missile: plain launch-and-explode). null/non-numeric radius -> r = 0 pure
// impact: tracer/smoke pass their radius through as given (data/weapons.json
// L15-L16 blastRadius 0; manual L1046-L1048 "no destructive capability").
import { stepBallistic, flightSettingsFor } from '../ballistics3d.js';
import { wallsConfigFor } from '../walls.js'; // W2-B — wall opts ride the shot seam

/** Record radius as a number; null/absent -> 0 (pure impact). */
function radiusOf(weapon) {
  const r = weapon && weapon.blastRadius;
  return typeof r === 'number' ? r : 0;
}

export default {
  launch(ctx) {
    ctx.hit = null;
  },
  step(ctx, dt) {
    if (ctx.state.done) return [];
    const gravity = ctx.se?.gravity ?? 9.8;
    const wind = ctx.se?.wind ?? { x: 0, z: 0 };
    // W2-A: airViscosity + bordersExtend ride the settings seam (flightSettingsFor).
    ctx.hit = stepBallistic(ctx.p, dt, ctx.field, { gravity, wind, walls: wallsConfigFor(ctx.se, ctx.shot), ...flightSettingsFor(ctx.se) });
    return [];
  },
  onTerrainHit(ctx, hit) {
    ctx.state.done = true;
    return [{ type: 'blast', x: hit.x, y: hit.y, z: hit.z, r: radiusOf(ctx.weapon) }];
  },
  done(ctx) {
    // W2-B: hit:'wall' (CONCRETE absorb) ends the flight like oob — the
    // executor destroys the shell on either.
    return ctx.state.done === true || (!!ctx.hit && (ctx.hit.hit === 'oob' || ctx.hit.hit === 'wall'));
  },
};
