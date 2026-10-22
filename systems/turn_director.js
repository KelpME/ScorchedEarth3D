import { makeDirector } from '../src/gameplay/director.js';

// W3-A (plan SE-COMPLETE-1012) — HARDWARE PACING resolution (manual:L1739-L1748).
// Precedence (armsLevel doctrine: consumers read the persisted store per key):
//   1. live se.settings (the applySettings store — a mid-battle APPLY lands
//      here and takes effect the next frame),
//   2. localStorage 'se.settings' (survives a reload until the first APPLY
//      re-populates se.settings; guarded — node --test has no localStorage),
//   3. unset -> 0 steps = the pre-W3A behavior, byte-identical (boot never
//      pre-applies JSON defaults).
// Values are sim STEPS (frame counts), sanitized: finite, floored, >= 0.
let lsCache = null; // read-once localStorage 'se.settings' parse (see hardwarePacing)
// W1 (plan SETTLE-SEQUENCE-1014): the settle hold is DATA, never a JS literal
// and never settings/localStorage — fail-loud module-load validation, the
// impact.js precedent (src/gameplay/impact.js reads physics-presets.json the
// same way and throws naming the file when its block is bad).
import settlePreset from '../data/physics-presets.json' with { type: 'json' };
const settleSeq = settlePreset?.settleSequence;
const settleHold = settleSeq?.holdSteps;
if (typeof settleHold !== 'number' || !Number.isFinite(settleHold) || settleHold < 0) {
  throw new Error(`[se/turn_director] data/physics-presets.json: settleSequence.holdSteps must be a non-negative finite number (got ${JSON.stringify(settleHold)}) — fix the data file`);
}
const SETTLE_HOLD_STEPS = Math.floor(settleHold);
// P1 (plan SETTLE-PACE-1015): the per-stage breathing minimums are DATA too —
// same fail-loud module-load gate as holdSteps (no JS literals, no defaults).
const settleStageMin = settleSeq?.stageMinSteps;
const SETTLE_STAGE_MIN_KEYS = ['hold', 'dirt', 'tanks', 'fallDamage', 'deaths'];
if (typeof settleStageMin !== 'object' || settleStageMin === null) {
  throw new Error(`[se/turn_director] data/physics-presets.json: settleSequence.stageMinSteps must be an object (got ${JSON.stringify(settleStageMin)}) — fix the data file`);
}
for (const k of SETTLE_STAGE_MIN_KEYS) {
  const v = settleStageMin[k];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error(`[se/turn_director] data/physics-presets.json: settleSequence.stageMinSteps.${k} must be a non-negative finite number (got ${JSON.stringify(v)}) — fix the data file`);
  }
}
const SETTLE_STAGE_MIN_STEPS = Object.fromEntries(SETTLE_STAGE_MIN_KEYS.map((k) => [k, Math.floor(settleStageMin[k])]));
export function hardwarePacing(se) {
  let s = se?.settings;
  const missing = !s || (s.firingDelay === undefined && s.fallingDelay === undefined);
  if (missing && typeof localStorage !== 'undefined') {
    try {
      if (lsCache === null) lsCache = JSON.parse(localStorage.getItem(['se', 'settings'].join('.')) || '{}') || {};
      // parse ONCE per session (the store only changes through APPLY, which
      // also populates se.settings — the live path above takes over)
      s = { ...(s || {}), ...lsCache };
    } catch {
      lsCache = {}; // unreadable store = unset (0) — boot logs its own failures
    }
  }
  const frame = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return { firingDelay: frame(s?.firingDelay), fallingDelay: frame(s?.fallingDelay), holdSteps: SETTLE_HOLD_STEPS, stageMinSteps: SETTLE_STAGE_MIN_STEPS };
}

export default {
  name: 'turn_director', label: 'Turn director',
  description: 'Alternates the active tank: aim -> firing (hold) -> flight -> settling (fall hold) -> next tank.',
  params: { settleTimeout: { type: 'number', default: 600 } },
  update(dt, api) {
    const se = typeof window !== 'undefined' && window.__se; if (!se) return;
    if (!se.director) {
      se.director = makeDirector({ settleTimeout: se.directorParams?.settleTimeout ?? 600, settleHoldSteps: SETTLE_HOLD_STEPS, ...hardwarePacing(se) });
    }
    // W3-A: push the resolved pacing EVERY frame — a settings APPLY (se.settings
    // live) or a reload restore (localStorage fallback) takes effect on the
    // next fire/impact without rebuilding the director mid-shot.
    se.director.setPacing?.(hardwarePacing(se));
    // W4-A: in simultaneous mode, a pending volley shot is popped into
    // 'flight' each frame (projectiles3d's existing seam spawns st.shot);
    // impact() returns to 'resolving' until nextResolveShot drains it.
    if (se.director.state().phase === 'resolving') se.director.nextResolveShot?.()
    // W1: 2nd arg gates the tanks/fallDamage/deaths stages — main.js (W2)
    // sets se.settleStageDone each frame; undefined = legacy passthrough.
    se.director.settleTick(se.host ? se.host.settled() : true, se.settleStageDone === true);
    const anchor = api.entity('camera_anchor');
    if (anchor) {
      const s = se.director.state();
      anchor.components.director = { turn: s.turn, phase: s.phase, settleSteps: s.settleSteps };
    }
  },
};
