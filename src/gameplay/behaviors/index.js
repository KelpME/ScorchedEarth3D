// S3a — behavior dispatch seam. A behavior is a plain object
// { launch(ctx), step(ctx, dt) -> events[], onTerrainHit(ctx, hit) -> events[],
// done(ctx) } over ctx = { shot, weapon, field, p, se, api, t, state } (state:
// per-shot scratch object owned by the projectile record, added in S3a).
// events = [{type:'blast', x,y,z, r}, {type:'spawn', ...},
// {type:'submunitions', list:[sub...]}] — systems/projectiles3d.js EXECUTES
// them (blast + remesh, fx spawns, sub spawns) and finishes the turn via
// director.impact() when the behavior is done and nothing is live.
//
// Doctrine: NO silent fallbacks. An unknown behavior id logs console.error
// naming the id and the weapon, then falls back to ballistic (loud, not
// silent). Ids come from data/weapons.json ("behavior" field, L5-L37).
import ballistic from './ballistic.js';
import napalm from './napalm.js';
import nuke from './nuke.js';
import roller from './roller.js';
import { apogee, sequential, hop } from './cluster.js';
import chain from './chain.js';
import { HEAVY_BEHAVIORS } from './heavy.js';

const BEHAVIORS = {
  ballistic,                    // data/weapons.json L5-L6, L10
  napalm,                       // L13-L14
  nuke,                         // L7-L8
  roller,                       // L17-L19
  multiwarhead_apogee: apogee,      // L11 (mirv)
  multiwarhead_sequential: sequential, // L12 (deaths_head)
  hop,                              // L9 (leap_frog) — single-bullet ground hop
  chain,                            // L8 (funky_bomb) — splash chain reaction
  // S3b heavy set (foreman wiring, post-merge): digger, sandhog, dirt,
  // liquid_dirt, riot, earth_disrupter, laser, plasma. NOTE (S3b report):
  // earth_disrupter advances ctx.p inside its own step() — ballistic must
  // not double-integrate it; the system delegates stepping to the behavior.
  ...HEAVY_BEHAVIORS,
  // Tracers (data/weapons.json L15-L16): plain flight, blastRadius 0 ->
  // ballistic's null/0 path IS the tracer semantics ("no destructive
  // capability", manual L1046-L1048). Smoke visual spawn is S-later; mapping
  // explicitly here keeps behaviorFor silent for known ids (doctrine: only
  // truly-unknown ids log).
  tracer: ballistic,
  smoke_tracer: ballistic,
};

export function behaviorFor(weapon) {
  const id = weapon && weapon.behavior;
  const b = id != null ? BEHAVIORS[id] : undefined;
  if (!b) {
    console.error(`[behaviors] unknown behavior "${id}" for weapon ${weapon && weapon.id} — using ballistic`);
    return ballistic;
  }
  return b;
}
