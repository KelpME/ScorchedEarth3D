// P1 (plan SETTLE-PACE-1015) — fx TIME SCALE, one data-backed constant.
// The user verdict: explosions rush — blast + death fx must LINGER. The scale
// is DATA (data/physics-presets.json .settleSequence.fxTimeScale) and this is
// the SINGLE consumption site: projectiles3d.js (blast series) and
// src/gameplay/deaths.js (death ring/spheres/debris) multiply their grow /
// life / delay timings by FX_TIME_SCALE here. Fail loud at module load — no
// JS literal, no silent default (the turn_director / impact.js precedent).
import presets from '../../data/physics-presets.json' with { type: 'json' };

const seq = presets?.settleSequence;
const raw = seq?.fxTimeScale;
if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
  throw new Error(`[se/fx_pacing] data/physics-presets.json: settleSequence.fxTimeScale must be a positive finite number (got ${JSON.stringify(raw)}) — fix the data file`);
}
export const FX_TIME_SCALE = raw;

/** Scale one fx duration (growSeconds / life / delay) by the data time scale. */
export const fxSeconds = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0) * FX_TIME_SCALE;
