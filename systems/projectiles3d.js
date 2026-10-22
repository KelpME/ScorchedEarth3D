// X3c — live 3D ballistics system: voxel3d battlefield integration.
// S3a — behavior-driven: the shot's weapon record picks a behavior via
// behaviorFor(weapon); the behavior OBJECT decides, this system EXECUTES.
// While the director is in 'flight' and a shot is pending, spawn the shell
// with a projectile3d component (launchVelocity3 — bearing arrives in
// RADIANS on the shot seam, aim.js takes DEGREES, so convert here). Every
// step: behavior.step(ctx, dt); terrain hits route to behavior.onTerrainHit;
// emitted events are applied here — blast events run blast + IN-FAME remesh
// (this is THE gate — the crater is visible the very frame of impact) and
// the blast ring, spawn events create fx entities, submunitions events spawn
// additional warheads. The turn finishes via director.impact() when the
// behavior is done AND no projectile3d entity is live (so rollers/cluster
// subs keep the turn open until they land). On oob: destroy and fail-noisy —
// a shell leaving the world is a bug, not a state.
//
// Weapon seam (S3a): weapon = se.weaponOverride?.() ?? the 'baby_missile'
// record from data/weapons.json (no scene/data changes needed; S3b replaces
// the override with the real chosen-weapon wiring). The baby_missile path
// keeps the identical spawn math, step math, ring recipe, lastImpact seam
// and oob fail-noisy contract — turn3d.spec is the unmodified regression
// gate.
import { stepBallistic } from '../src/gameplay/ballistics3d.js';
import { launchVelocity3 } from '../src/gameplay/aim.js';
import { behaviorFor } from '../src/gameplay/behaviors/index.js';
import { blast } from '../src/voxel3d/blast.js';
import { resolveRiotFiringMode, instantRiotCone } from '../src/gameplay/behaviors/heavy.js';
import { cellX, cellZ, cellTopWorldY, V } from '../src/voxel3d/constants.js';
import { columnTop } from '../src/voxel3d/field.js';
import weaponsData from '../data/weapons.json' with { type: 'json' };
// SE-FX: blast-series colors/timing are DATA (data/blast-fx.json) — the
// spawner reads them here; engine code carries no color literals.
import blastFxData from '../data/blast-fx.json' with { type: 'json' };
import { fxSeconds } from '../src/gameplay/fx_pacing.js';
import weaponsOptionsData from '../data/weapons-options.json' with { type: 'json' };
// W2-I (plan SE-COMPLETE-1012): voxel trees — lazy scatter + debris sim + the
// blast notify (treeBlast) are the ONLY tree lines here; see src/voxel3d/treeProp.js.
import { stepTrees, treeBlast } from '../src/voxel3d/treeProp.js';
// W2-C-sibling (plan SE-COMPLETE-1012): armor damage absorption — PURE model,
// hooked at the single blast seam; the spill call stays intact.
import { applyArmorAbsorption } from '../src/gameplay/accessories.js';

const WEAPONS = Object.fromEntries((weaponsData.weapons || []).map((w) => [w.id, w]));
const DEFAULT_WEAPON_ID = 'baby_missile';

// FIX2 unit calibration: data/weapons.json blastRadius values are ORIGINAL-SE
// PIXEL radii (baby_missile 10 ... nuke 75), not world units. Mapping: 40-world
// map / ~200-px blast scale -> 0.2. Anchor: baby_missile 10px * 0.2 = 2.0 world
// == the old terrainCfg.blastRadius 2.0 the pre-S3a specs were written against
// (collapse.spec's "r=2u blast footprint (20 cells)" comment is that pin);
// nuke 75px -> 15 world, plausibly map-crippling as the manual implies.
// ALL blast events convert HERE, at the executor boundary — behavior r fields
// stay record-pixels.
const SE_PX_TO_WORLD = 0.2;

// T-UI-3 Scale option (manual:L2107-L2114): "Scale up so weapons are more
// destructive than usual." Consumer = the blast-radius conversion below (the
// single destructive boundary). W5 purge (plan SE-COMPLETE-1012 §4): the old
// JS literal table is GONE — magnitudes are DATA
// (data/weapons-options.json options.scale.magnitudes). Malformed data fails
// LOUD naming the file — no JS fallback exists.
const SCALE_MULT = (() => {
  const m = weaponsOptionsData && weaponsOptionsData.options && weaponsOptionsData.options.scale && weaponsOptionsData.options.scale.magnitudes;
  if (!m || !['NORMAL', 'MEDIUM', 'LARGE'].every((k) => typeof m[k] === 'number')) {
    throw new TypeError(`[se/projectiles3d] data/weapons-options.json options.scale.magnitudes missing/incomplete — fix the data file, no JS fallback exists: ${JSON.stringify(m && Object.keys(m))}`);
  }
  return m;
})();

// Resolve the firing weapon: se.weaponOverride?.() may return a record or an
// id; anything unknown fails loud (doctrine) and falls back to baby_missile.
function weaponForShot(se) {
  const o = se.weaponOverride && typeof se.weaponOverride === 'function' ? se.weaponOverride() : null;
  if (!o) return WEAPONS[DEFAULT_WEAPON_ID];
  if (typeof o === 'object' && o.behavior) return o;
  const id = typeof o === 'string' ? o : o.id;
  if (WEAPONS[id]) return WEAPONS[id];
  console.error(`[projectiles3d] unknown weapon id "${id}" from weaponOverride — using ${DEFAULT_WEAPON_ID}`);
  return WEAPONS[DEFAULT_WEAPON_ID];
}

// SE-EXPANSION-1012 A3 — per-weapon projectile MODELS (DATA, not literals):
// the mapping lives in data/weapons.json (`model` field per weapon);
// projectiles3d only RESOLVES: weapon.model must name a TOP-LEVEL node of the
// loaded projectiles.glb scene (se.projectileNodes, read at runtime from the
// glb — never hardcoded here). Unknown/missing name → 'fallback' + a
// console.info NAMING the fallback (fail-noisy, never silent); the 'fallback'
// node itself is the normal path and stays silent. Name-based selection means
// the embedded Hull tank subtree can never be mounted (not a top-level node).
export function resolveProjectileNode(weapon, nodes) {
  const name = weapon && typeof weapon.model === 'string' ? weapon.model : null;
  if (name && (!nodes || nodes.includes(name))) return name;
  const id = weapon && weapon.id ? weapon.id : '(unknown)';
  console.info(`[projectiles3d] weapon "${id}" model ${JSON.stringify(name ?? null)} is not a projectiles.glb node — mounting the 'fallback' node`);
  return 'fallback';
}

// Mount the resolved node on the shell entity: render.model + render.node —
// the renderer's node-proxy path CLONES the subtree per projectile (shared
// geometry/materials). Scale interplay: the glb mounts 1:1 (import doctrine,
// MODEL_SCALE.projectiles = 1 in main.js); the settings scale option
// (SCALE_MULT below) multiplies only the BLAST rWorld, never the visual.
function mountProjectileModel(se, rec, weapon) {
  const node = resolveProjectileNode(weapon, se.projectileNodes);
  rec.components.render = {
    model: se.projectileModelSrc ?? 'assets/models/projectiles.glb',
    node,
    visible: true,
  };
}

export default {
  name: 'projectiles3d', label: '3D projectiles',
  description: 'Ballistic shells on the voxel3d field: fly, crater, remesh in-frame.',
  params: { gravity: { type: 'number', default: 9.8 } },
  update(dt, api) {
    const se = typeof window !== 'undefined' && window.__se;
    if (!se || !se.field || !se.director) return; // editor viewport: no-op
    // W2-I trees: lazy scatter (field changed), archetype-instance sync, debris
    // advance — no-op with no trees (src/voxel3d/treeProp.js stepTrees).
    stepTrees(se, api, dt)
    // W2-Cb BARREL-BREAK TRIGGER ONLY (no blast-impulse changes here): the
    // maxPower law drains battle players on every damage event (main.js
    // wrapper); a player at/below the data floor detaches their front barrel
    // segment via the lightning system (idempotent, one-time per tank).
    if (se.battle && se.damagePowerRule && se.lightning) {
      for (const p of se.battle.players) {
        if (p.alive && typeof p.maxPower === 'number' && p.maxPower <= se.damagePowerRule.floor) {
          se.lightning.detachBarrel(p.id);
        }
      }
    }
    const field = se.field;
    const gravity = se.gravity ?? 9.8;
    const wind = se.wind ?? { x: 0, z: 0 };
    const st = se.director.state();

    if (st.phase === 'flight' && st.shot && !se.liveShot) {
      // Shot seam (main.js SPACE): bearingRad in RADIANS; aim.js takes DEGREES.
      const weapon = weaponForShot(se);
      // Riot turret-local INSTANT BLAST (riot_charge / riot_blast, effect.firingMode
      // 'turret_wedge'): NO projectile — a BIG INSTANT explosion carves a CONE
      // out of the barrel (apex at the turret origin, opening forward in the aim
      // direction) DIRECTLY on the field (no shell entity, no dispatcher blast
      // event -> no tank damage, manual L1094) and stamps the carved world radius
      // on the impact seam so settle3d triggers the cascade that collapses the
      // surrounding dirt to the ground, then end the round exactly like an
      // impact (director.impact) so the turn advances. The Riot Bomb / Heavy
      // Riot Bomb keep the projectile path below (no firingMode -> projectile+
      // sphere, unchanged).
      if (resolveRiotFiringMode(weapon) === 'turret_wedge') {
        const ctx = { shot: st.shot, weapon, field, p: { x: st.shot.x, y: st.shot.y, z: st.shot.z ?? 0, vx: 0, vy: 0, vz: 0 }, se, api, t: 0, state: {} };
        instantRiotCone(ctx);
        st.shot = null;
        se.director.impact();
        return;
      }
      const bearingDeg = (st.shot.bearingRad ?? 0) * 180 / Math.PI;
      const v = launchVelocity3(st.shot.angleDeg ?? 45, st.shot.power ?? 0.5, bearingDeg);
      const id = 'shell_1'
      const eid = api.spawnArchetype('shell', { id: 'shell_1', transform: { x: st.shot.x, y: st.shot.y, z: st.shot.z ?? 0 } })
      if (!eid) { console.error('[projectiles3d] shell archetype failed to hydrate — shot cannot fly'); se.director.impact(); return }
      const rec = api.entity(eid)
      rec.components.projectile3d.x = st.shot.x; rec.components.projectile3d.y = st.shot.y; rec.components.projectile3d.z = st.shot.z ?? 0
      rec.components.projectile3d.vx = v.vx; rec.components.projectile3d.vy = v.vy; rec.components.projectile3d.vz = v.vz
      rec.components.projectile3d.tank = st.shot.tank
      rec.components.projectile3d.weapon = weapon
      rec.components.projectile3d.shot = st.shot
      rec.components.projectile3d.state = null
      rec.components.projectile3d.t = 0
      // W3-B flight-sound feed: POS/VEL drives the flightSounds loop (no-op
      // unless the audio system is mounted and flightSounds is on).
      window.__se?.audio?.flight?.({ pos: { x: st.shot.x, y: st.shot.y, z: st.shot.z ?? 0 }, vel: { x: v.vx, y: v.vy, z: v.vz } })
      rec.components.projectile3d.parent = true
      mountProjectileModel(se, rec, weapon)
      // USER-BUG 2026-10-11 (MIRV fires forever): st.shot stayed in director
      // state after spawn — a flight that ends OOB (MIRV subs clear liveShot)
      // re-spawned the ORIGINAL shot endlessly: split -> subs OOB -> re-spawn
      // -> split... The shot is CONSUMED the moment it materializes here; the
      // live projectile carries its own copy (p.shot above). Clear it.
      st.shot = null
      se.liveShot = eid;
    }

    for (const id of api.query({ has: 'projectile3d' })) {
      const rec = api.entity(id);
      if (!rec) continue;
      const p = rec.components.projectile3d;
      const weapon = p.weapon;
      if (!weapon) {
        // Fail-noisy: a projectile without a weapon record cannot be flown.
        api.world.destroy(id);
        console.error('[projectiles3d] projectile3d without a weapon record — destroyed', { id, tank: p.tank });
        continue;
      }
      const behavior = behaviorFor(weapon);
      if (!p.state) { p.state = {}; behavior.launch({ shot: p.shot, weapon, field, p, se, api, t: 0, state: p.state }); }
      p.t += dt;
      const ctx = { shot: p.shot, weapon, field, p, se, api, t: p.t, state: p.state };

      const events = behavior.step(ctx, dt);
      if (ctx.hit && ctx.hit.hit === 'terrain') {
        // Publish the impact seam BEFORE events run (specs read lastImpact).
        // FIX2: monotone stamp (no clock reads) so settle3d's impact-watch can
        // latch on lastImpact CHANGE, not only the settling-phase edge.
        se.lastImpact = { x: ctx.hit.x, y: ctx.hit.y, z: ctx.hit.z, hit: 'terrain', cell: ctx.hit.cell,
          stamp: (se.impactN = (se.impactN || 0) + 1) };
        events.push(...behavior.onTerrainHit(ctx, ctx.hit));
        // W2-G napalm pooling: the catalog's spill amount (data/weapons.json)
        // flows into the weather system's liquid sim — the OG behavior where
        // napalm pools in low points. Fire-on-ignite comes from the same seam.
        if (p.weapon?.spill && window.__se?.weather?.spill) {
          window.__se.weather.spill(ctx.hit.x, ctx.hit.z, p.weapon.spill)
        }
      } else if (ctx.hit && (ctx.hit.hit === 'oob' || ctx.hit.hit === 'wall')) {
        // W2-B: hit:'wall' = CONCRETE absorbed the shell at the border — a
        // legitimate miss, destroyed WITHOUT the oob fail-noisy error.
        api.world.destroy(id);
        if (p.parent) se.liveShot = null;
        if (ctx.hit.hit !== 'wall') console.error('[projectiles3d] shell left the world', { x: ctx.hit.x, y: ctx.hit.y, z: ctx.hit.z, tank: p.tank });
        if (api.query({ has: 'projectile3d' }).length === 0) se.director.impact();
        continue;
      }

      for (const ev of events) {
        if (ev.type === 'blast') {
          // FIX2 unit calibration: behavior r fields are record-PIXELS; the
          // executor is the single boundary that converts to world units
          // (SE_PX_TO_WORLD, see above — baby_missile 10 -> 2.0 world).
          const rWorld = (typeof ev.r === 'number' ? ev.r : 0) * SE_PX_TO_WORLD * (SCALE_MULT[se.settings?.scale] ?? 1);
          if (rWorld > 0) {
            const res = blast(field, { x: ev.x, y: ev.y, z: ev.z }, rWorld);
            if (se.v3d) se.v3d.enqueueRemesh(res.dirtyChunks); // CRATER-DRAIN: defer the render mesh — the crater builds behind the blast VFX (field cells already carved, collision immediate)
            // CRATER-DRAIN seam: stamp the impact's own dirty-chunk count so
            // specs can pin the crater render-mesh chunk count the drain mounts.
            if (se.lastImpact && se.lastImpact.hit === 'terrain') se.lastImpact.dirtyChunks = res.dirtyChunks.size;
            // Stamp the ACTUAL carved world radius onto the impact seam so
            // settle3d's announce covers the true crater + rim (foreman FIX2).
            if (se.lastImpact && se.lastImpact.hit === 'terrain') {
              se.lastImpact.rWorld = Math.max(se.lastImpact.rWorld ?? 0, rWorld);
            }
            // INT — tank damage seam: hand the battle loop the blast point +
            // RECORD-PIXEL radius + the firing tank (p.tank, set at spawn).
            // Thin on purpose: the loop mirrors live tank transforms itself
            // (se.readTankPositions), applies damage.js and scores. Loud ONLY
            // when a battle exists — legacy no-battle boots stay silent.
            if (se.battle && !se.battleLoop) {
              console.error('[projectiles3d] battle exists but se.battleLoop is missing — tank damage/score skipped for this blast');
            }
            const blastResults = se.battleLoop?.onBlast({ x: ev.x, y: ev.y, z: ev.z, rPx: ev.r, attackerTank: p.tank });
            // ==== W2-C-sibling ARMOR absorption hook (plan SE-COMPLETE-1012)
            // — BEGIN ========================================================
            // The blast path above already reduced hulls; owned + toggled-ON
            // armor restores the absorbed fraction (ARMOR_ABSORB, data/
            // accessories.json _placeholder) via the PURE accessories model.
            // The napalm spill call below is INTENTIONALLY untouched.
            if (se.battle && Array.isArray(blastResults)) applyArmorAbsorption(blastResults, se.battle.players);
            // ==== W2-C-sibling ARMOR absorption hook — END ==================
            // W2-I trees: trees in radius carve (terrain damage rule, damageable
            // trunk only) + survivors detach radially as debris (treeProp.treeBlast).
            treeBlast(se, api, { x: ev.x, y: ev.y, z: ev.z }, rWorld);
          }
          // SE-FX: the old single ring is replaced by the expanding-sphere
          // blast series (orange/yellow/red, staggered, fade-to-zero), sized
          // to THIS blast's rWorld — same mechanism for every weapon.
          spawnBlastSpheres(se, api, ev.x, ev.y, ev.z, rWorld);
        } else if (ev.type === 'spawn') {
          spawnFx(se, api, ev);
        } else if (ev.type === 'submunitions') {
          for (const s of ev.list || []) spawnSub(se, api, p, s);
        } else {
          console.error('[projectiles3d] unknown behavior event type — skipped', ev);
        }
      }

      if (behavior.done(ctx)) {
        api.world.destroy(id);
        if (p.parent) se.liveShot = null;
        // Turn ends only when the LAST live warhead is gone (cluster subs,
        // roller after-images keep the flight phase open).
        if (api.query({ has: 'projectile3d' }).length === 0) se.director.impact();
      } else {
        rec.components.transform.x = p.x;
        rec.components.transform.y = p.y;
        rec.components.transform.z = p.z;
      }
    }
  },
};

// Spawn a submunition warhead: plain p-like from the behavior event + its own
// behavior id + blast radius (the executor gives it a synthetic weapon record
// so behaviorFor dispatches it, S3a brief's event contract).
function spawnSub(se, api, parent, s) {
  const id = `sub_${(se.subN = (se.subN || 0) + 1)}`;
  const weapon = { id: `${parent.weapon.id}#sub`, behavior: s.behavior || 'ballistic', blastRadius: s.blastRadius, model: parent.weapon.model };
  const eid = api.spawnArchetype('shell', { id, transform: { x: s.x, y: s.y, z: s.z } });
  if (!eid) { console.error('[projectiles3d] shell archetype failed to hydrate — submunition cannot fly', { id }); return }
  const rec = api.entity(eid);
  rec.components.projectile3d.x = s.x; rec.components.projectile3d.y = s.y; rec.components.projectile3d.z = s.z
  rec.components.projectile3d.vx = s.vx; rec.components.projectile3d.vy = s.vy; rec.components.projectile3d.vz = s.vz
  rec.components.projectile3d.tank = parent.tank
  rec.components.projectile3d.weapon = weapon
  rec.components.projectile3d.shot = parent.shot
  rec.components.projectile3d.state = null
  rec.components.projectile3d.t = parent.t
  rec.components.projectile3d.parent = false
  mountProjectileModel(se, rec, weapon)
}

// SE-FX blast series (user brief): one EXPANDING sphere per data/blast-fx.json
// entry, staggered by .delay (lead orange, then yellow, then red), each
// growing ~0 -> rWorld while fx.opacity fades 1 -> 0 (scripts/fx_blast_sphere
// animates; main.js's render hook applies opacity + additive blending to the
// per-entity material clone). Sizes are per-weapon runtime data (rWorld);
// colors/timing are DATA. Each sphere renders individually (render.skinned —
// the documented per-entity Mesh route) so its material clone is unique
// (materialParams.nonce) and can fade independently of every other sphere.
function spawnBlastSpheres(se, api, x, y, z, rWorld) {
  const spheres = blastFxData.spheres || [];
  if (!spheres.length) { console.error('[projectiles3d] blast-fx.json .spheres missing/empty — blast series skipped'); return; }
  for (const s of spheres) {
    const id = `blast_${(se.blastN = (se.blastN || 0) + 1)}`;
    api.spawn(id, { name: id, components: {
      transform: { x, y, z, scale: [0.001, 0.001, 0.001] },
      render: {
        mesh: 'sphere',
        material: blastFxData.rendering?.material || 'fx_blast',
        skinned: true, // per-entity Mesh + unique material clone (fade is per-sphere)
        materialParams: { color: s.color, nonce: id },
        visible: true,
      },
      fx: {
        age: 0, color: s.color, opacity: 1, maxScale: rWorld,
        delay: fxSeconds(s.delay ?? 0), growSeconds: fxSeconds(blastFxData.growSeconds), minScale: blastFxData.minScale,
      },
      scripts: [{ name: 'fx_blast_sphere', params: { maxScale: rWorld, delay: fxSeconds(s.delay ?? 0), growSeconds: fxSeconds(blastFxData.growSeconds), minScale: blastFxData.minScale } }],
    } });
  }
}

// Lingering fx marker (nuke glow, S3a {type:'spawn'} event). T-FX: the glow
// decays and dies via fx_decay like every other fx; the next-shot clear below
// is only a backstop.
function spawnFx(se, api, ev) {
  // Lingering marker: one glow at a time — the previous one is cleared when
  // a new shot spawns its marker (S3a scope; a decay script is S-later).
  if (se.glowId && api.entity(se.glowId)) api.world.destroy(se.glowId);
  const id = `fx_${(se.fxN = (se.fxN || 0) + 1)}`;
  api.spawn(id, { name: id, components: {
    transform: { x: ev.x, y: (ev.y ?? 0) + 0.3, z: ev.z, scale: [0.8, 0.8, 0.8] },
    render: { mesh: 'sphere', material: 'fx' },
    fx: { age: 0, life: ev.life ?? 5 },
    glow: { fx: ev.fx || 'glow', r: ev.r ?? 0 },
    // T-FX: the glow decays via fx_decay like every other fx (life comes from
    // the fx component, which fx_decay prefers). The next-shot clear below is
    // now only a backstop.
    scripts: [{ name: 'fx_decay', params: { maxScale: 0.8, life: 5 } }],
  } });
  se.glowId = id; // replaced/cleared on the next spawn — simple lingering marker
}

// Referenced for the crater-height readers in specs (documented seam):
// surface world-y of column (x,z) — DEEPEN-1015 R6: through the ONE seam.
export function surfaceWorldY(field, x, z) {
  const t = columnTop(field, cellX(x), cellZ(z));
  return cellTopWorldY(t);
}
