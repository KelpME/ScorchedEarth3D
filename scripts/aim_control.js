import { clampDeg, barrelRotX, shellWorldOrigin, shellBearingRad, effectivePower } from '../src/gameplay/aim.js';
export default {
  name: 'aim_control', label: 'Aim control',
  description: 'Reads the tank aim component and rotates the Barrel child within the 180° arc; publishes shot requests for the active tank.',
  params: { stepDeg: { type: 'number', default: 2 }, minDeg: { type: 'number', default: 0 }, maxDeg: { type: 'number', default: 180 } },
  update(state, dt, api, entityId, params) {
    const rec = api.entity(entityId); if (!rec || !rec.components) return;
    const aim = rec.components.aim; if (!aim) return;

    const dir = rec.components.director || api.entity('camera_anchor')?.components?.director;
    const active = dir && dir.turn === entityId;
    const facing = entityId === 'tank1' ? 1 : -1;
    // Mechanism-first barrel resolution (tankV3 doctrine: no model-derived node
    // names hardcoded): the barrel is the entity whose id is this tank's subtree
    // node ending in '_Barrel', shortest wins (skips '..._Barrel_Barrel001'
    // wrapper nodes). A model rename must not silently kill the barrel.
    let barrelId = null;
    {
      const prefix = `${entityId}_`;
      const cands = api.query({}).filter((id) => id.startsWith(prefix) && id.endsWith('_Barrel'));
      if (cands.length) barrelId = cands.sort((a, b) => a.length - b.length)[0];
      else console.error(`[aim_control] ${entityId}: no barrel node found in subtree (looked for '${prefix}*_Barrel') — barrel will not rotate`);
    }
    const brec = api.entity(barrelId);
    if (brec && brec.components && brec.components.transform) {
      // Post-break clamp RETIRED (user 2026-10-15: the damaged barrel must track
      // ANGLE like an intact one — the damage penalty lives in the maxPower law
      // alone; brokenBarrelMaxAngleDeg tombstoned in data/physics-presets).
      const a = clampDeg(aim.angleDeg ?? 45, params.minDeg, params.maxDeg);
      brec.components.transform.rot = { x: barrelRotX(a * Math.PI / 180), y: 0, z: 0 };
    }
    if (active && aim.fire) {
      aim.fire = false;
      try {
      // ShellSpawn doctrine (tankV5): the shot ORIGIN is the model's own
      // ShellSpawn empty (child of Barrel, so its world position rides the
      // barrel's live elevation). Mechanism-first lookup, same pattern as the
      // barrel: subtree node ending in '_ShellSpawn', shortest wins.
      // Missing → console.error (fail-noisy) + legacy tank+1.4 fallback so an
      // older model still shoots (named, never silent).
      const t = rec.components.transform;
      const yaw = t.yaw ?? 0;
      let shot;
      const spawnCands = api.query({}).filter((id) => id.startsWith(prefix) && id.endsWith('_ShellSpawn'));
      const spawnId = spawnCands.length ? spawnCands.sort((a, b) => a.length - b.length)[0] : null;
      const srec = spawnId ? api.entity(spawnId) : null;
      if (srec && srec.components && srec.components.transform && brec && brec.components && brec.components.transform) {
        // Shared derivation (aim.js) — same helper the Space-key path uses.
        const origin = shellWorldOrigin(t, brec.components.transform, srec.components.transform);
        shot = { tank: entityId, ...origin,
                 angleDeg: aim.angleDeg,
                 // W2-Cb: the fire path carries the EFFECTIVE power —
                 // min(aim.power, maxPower) (damage->maxPower law).
                 power: effectivePower(aim.power,
                   (typeof window !== 'undefined' && window.__se?.battle?.players?.find((p) => p.id === entityId)?.maxPower)),
                 facing,
                 bearingRad: shellBearingRad(yaw) };
      } else {
        console.error(`[aim_control] ${entityId}: no ShellSpawn node (looked for '${prefix}*_ShellSpawn') — shell spawns from legacy tank+1.4 origin`);
        shot = { tank: entityId, x: t.x ?? 0, y: (t.y ?? 0) + 1.4,
                 angleDeg: aim.angleDeg,
                 power: effectivePower(aim.power,
                   (typeof window !== 'undefined' && window.__se?.battle?.players?.find((p) => p.id === entityId)?.maxPower)),
                 facing,
                 bearingRad: shellBearingRad(yaw) };
      }
      if (typeof window !== 'undefined' && window.__se && window.__se.director) {
        window.__se.director.requestFire(entityId, shot);
      }
      } catch (err) { console.error(`[aim_control] ${entityId}: fire branch THREW — ${err && err.stack ? err.stack.split('\n')[0] : err}`); }
    }
  },
};
