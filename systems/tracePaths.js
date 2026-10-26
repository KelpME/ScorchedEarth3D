// W2-E (plan SE-COMPLETE-1012) — trace-path system. Pure model + engine
// system factory. NO main.js / projectiles3d.js edits: the system is
// registered AT RUNTIME (weaponVisuals.ensureTracePathsSystem) onto the live
// game (window.__game): SystemRegistry entry + a scene.systems entry — the
// engine dispatches scene.systems per frame (runSystems, core/game.js), so a
// late registration flies without touching boot files.
//
// Semantics (manual:L2120-L2129 via data/weapons-options.json tracePaths):
//   setting ON  -> every airborne projectile3d entity spawns throttled trace
//                  fx entities (one per TRACE_SPACING world units of flight),
//                  color = DATA (data/weapons.json visual.traceColor, one per
//                  weapon class), decay via the fx_decay script pattern.
//   setting OFF -> ZERO trace entities (and any live ones are swept — the
//                  transition pin: entities exist ONLY when on).
// Editor-visible: trace entities are plain ECS entities (transform + render +
// fx + fx_decay script) visible in the editor viewport like every other fx.

export const TRACE_SPACING = 0.35; // world units between trail puffs (pinned)

/** Strictly the descriptor's ON value (booleans accepted like settingsApply). */
export function traceOn(settings) {
  const v = settings?.tracePaths;
  return v === 'on' || v === true;
}

/** Trace color from the weapon record's DATA; fail loud on missing data. */
export function traceColorFor(weapon) {
  const c = weapon?.visual?.traceColor;
  if (typeof c !== 'string' || !/^#[0-9a-f]{6}$/i.test(c)) {
    throw new Error(`[se/tracePaths] weapon ${weapon?.id ?? JSON.stringify(weapon)} has no visual.traceColor — fix data/weapons.json (fail loud, no color literals)`);
  }
  return c;
}

/** Distance-throttled spawn decision: dist <= 0 = never sampled -> trace. */
export function shouldSpawnTrace({ dist }) {
  return dist <= 0 || dist >= TRACE_SPACING;
}

/**
 * Engine system factory. opts.settingsOf() -> the live settings object
 * (se.settings or a test double). The system:
 *  - OFF: destroys any live trace_ entities and returns (none may exist).
 *  - ON:  for each projectile3d entity, accumulates flight distance and
 *         spawns a trace puff every TRACE_SPACING world units, colored by the
 *         projectile's weapon data, decayed by fx_decay.
 */
export function createTracePathsSystem({ settingsOf } = {}) {
  if (typeof settingsOf !== 'function') {
    throw new Error('[se/tracePaths] createTracePathsSystem needs settingsOf() — fail loud');
  }
  let n = 0;
  return {
    name: 'trace_paths',
    update(dt, api) { // engine convention: runSystems calls def.update(dt, api)
      const on = traceOn(settingsOf());
      if (!on) {
        // OFF: entities exist ONLY when on — sweep any stragglers.
        for (const id of api.query({ has: 'fx' })) {
          if (String(id).startsWith('trace_')) api.world.destroy(id);
        }
        return;
      }
      for (const id of api.query({ has: 'projectile3d' })) {
        const rec = api.entity(id);
        if (!rec?.components?.projectile3d) continue;
        const p = rec.components.projectile3d;
        p.state ??= {};
        const st = p.state;
        // Distance flown this frame (last known position -> current).
        const dx = p.x - (st.traceX ?? p.x);
        const dy = p.y - (st.traceY ?? p.y);
        const dz = p.z - (st.traceZ ?? p.z);
        st.traceDist = (st.traceDist ?? 0) + Math.hypot(dx, dy, dz);
        st.traceX = p.x; st.traceY = p.y; st.traceZ = p.z;
        if (!shouldSpawnTrace({ dist: st.traceDist })) continue;
        st.traceDist = 0;
        const color = traceColorFor(p.weapon);
        const tid = `trace_${(n = (n + 1) % 1e9)}`;
        api.spawn(tid, {
          name: tid,
          components: {
            transform: { x: p.x, y: p.y, z: p.z, scale: [0.12, 0.12, 0.12] },
            render: { mesh: 'sphere', material: 'fx', materialParams: { color }, visible: true },
            fx: { age: 0, life: 0.7 },
            scripts: [{ name: 'fx_decay', params: { maxScale: 0.12, life: 0.7 } }],
          },
        });
      }
    },
  };
}

/**
 * Runtime registration onto a LIVE game (no boot-file edits): register the
 * system def once and append the scene.systems entry once. Idempotent.
 * Returns true when a NEW scene entry was appended.
 */
export function ensureTracePathsSystem(game, settingsOf) {
  if (!game?.api || !game.scene) return false; // editor viewport / not booted
  const def = createTracePathsSystem({ settingsOf });
  try { game.api.systems.register(def.name, def); } catch { /* already registered */ }
  game.scene.systems ??= [];
  if (game.scene.systems.some((s) => s && s.name === def.name)) return false;
  game.scene.systems.push({ name: def.name });
  return true;
}
