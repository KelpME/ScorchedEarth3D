// W5 (plan SE-COMPLETE-1012) — Impact Damage (manual:L2156-L2161, Archaic
// Options) + the tank-fall damage path. PURE: no DOM, no engine imports, no
// Math.random, no clock.
//
// Manual semantics, verbatim: "If this is on, tanks take damage from a fall
// when they hit the ground. If it is off, tanks take damage as they are
// falling. This isn't an important distinction, just a matter of preference.
// Total damage done is the same in either case."
//   -> the setting picks the BOOKING LABEL ('landing' | 'falling'); the total
//      is identical. Our sim is a discrete re-ground (a fall snaps the tank to
//      the new surface in one frame), so both labels book the same single
//      damage event — the manual explicitly blesses that equivalence.
//
// The fall itself is gated by the Tanks Fall setting (manual:L1853): off = the
// tank rides its column and no impact path exists at all (legacy float).
//
// All magnitudes are DATA: data/physics-presets.json `.impact` (manual pins no
// numbers — _placeholder provenance documented there). A malformed block
// fails LOUD naming the file — no JS fallback exists (doctrine).

import ppData from '../../data/physics-presets.json' with { type: 'json' };

// settingsApply anchor (same brief pin): world units <-> SE pixels.
export const SE_PX_TO_WORLD = 0.2;

/**
 * impactParams(doc?): validate + return the .impact block from
 * data/physics-presets.json (or an injected doc for tests). Fails loud
 * naming the file on any missing/non-numeric field — a broken data file is
 * a crash at boot, never a silent zero-damage fall.
 */
export function impactParams(doc = ppData) {
  const b = doc && doc.impact;
  const need = ['minDropPx', 'damagePerPx', 'maxDamage', 'blastRpx'];
  const bad = !b || need.some((k) => typeof b[k] !== 'number' || !Number.isFinite(b[k]));
  if (bad) {
    throw new TypeError(
      `[se/impact] data/physics-presets.json .impact missing/non-numeric ` +
      `${need.join('/')} — fix the data file, no JS fallback exists: ${JSON.stringify(b && Object.keys(b))}`,
    );
  }
  return { minDropPx: b.minDropPx, damagePerPx: b.damagePerPx, maxDamage: b.maxDamage, blastRpx: b.blastRpx };
}

/**
 * planFall({ fromY, toY, tanksFall, impactDamage, params }) ->
 *   null  — no fall this frame (tanksFall off, no drop, or sub-threshold
 *           jitter). The caller does nothing.
 *   { dropPx, damage, timing } — a fall DID happen:
 *     dropPx  — fall distance in SE px (world / 0.2)
 *     damage  — hull points to book, 0 below the data minDropPx, linear
 *               damagePerPx above, capped at maxDamage (Math.round: hull
 *               books whole points like every applyBlast event)
 *     timing  — 'landing' (impactDamage on) | 'falling' (off) — the manual's
 *               booking-label distinction; the TOTAL is identical either way.
 * PURE. tanksFall/impactDamage come from se.settings (typed booleans via
 * applySettings; undefined = descriptor default ON — documented, matches the
 * data defaults).
 */
export function planFall({ fromY, toY, tanksFall, impactDamage, params } = {}) {
  if (tanksFall === false) return null; // manual:L1853 off — no fall, no damage
  if (typeof fromY !== 'number' || typeof toY !== 'number' || !params) return null;
  const dropWorld = fromY - toY; // positive = the surface dropped under the tank
  if (!(dropWorld > 0)) return null;
  const dropPx = dropWorld / SE_PX_TO_WORLD;
  if (dropPx <= params.minDropPx) return null; // sub-threshold: quantization jitter, not a fall
  const raw = (dropPx - params.minDropPx) * params.damagePerPx;
  const damage = Math.min(params.maxDamage, Math.max(0, Math.round(raw)));
  return { dropPx, damage, timing: impactDamage === false ? 'falling' : 'landing' };
}

/**
 * tanksStageDone(surfs) -> boolean — the W2 settle 'tanks' stage signal.
 * surfs: one { snapped, atRest } entry per ALIVE tank this tick (snapped =
 * the tank rode down to its new surface this tick; atRest = NO pending fall
 * — either already grounded or planFall returned null, e.g. a buried tank
 * (y < surf: it can never fall UP) or the legacy Tanks-Fall-Off float).
 * Requiring raw tr.y === surf instead DEADLOCKS the stage on those tanks
 * (observed live: a boot-grounded tank below its column surface never
 * satisfies equality and tanks stageDone stays false forever). Done only
 * when NO tank snapped this tick AND every entry is at rest (vacuously true
 * with zero alive tanks). PURE.
 */
export function tanksStageDone(surfs = []) {
  return surfs.every((s) => s && !s.snapped && s.atRest === true);
}

/**
 * settleStageSignal({ phase, settleStage, tanksDone, fallDamageDone, deathRuns, pendingDeaths })
 *   -> boolean — the W2 per-frame se.settleStageDone value, from main.js.
 * W1 machine: exactly one stage advances per tick via settleTick's 2nd arg.
 *   tanks      -> tanksDone (from tanksStageDone)
 *   fallDamage -> fallDamageDone (plans booked)
 *   deaths     -> W3: the kill QUEUE is drained (pendingDeaths === 0) AND no
 *                 unfinished death runs (deathsStageSignal) — the turn
 *                 advances only after every queued death animation has been
 *                 PLAYED and finished ticking.
 *   hold/dirt/other settle stages, or any non-settling phase -> false. PURE.
 */
export function settleStageSignal({ phase, settleStage, tanksDone, fallDamageDone, deathRuns, pendingDeaths } = {}) {
  if (phase !== 'settling') return false;
  if (settleStage === 'tanks') return tanksDone === true;
  if (settleStage === 'fallDamage') return fallDamageDone === true;
  if (settleStage === 'deaths') return deathsStageSignal({ pending: pendingDeaths ?? 0, runs: deathRuns });
  return false;
}

/**
 * W3 — deathsStageSignal({ pending, runs }) -> boolean — the settle 'deaths'
 * stage gate. Done ONLY when the kill queue is drained (pending === 0 —
 * every queued kill has been handed to playDeath this stage) AND every death
 * run has finished ticking (r.done). Empty queue + zero runs signals done on
 * the first tick (the machine's 1-tick passthrough: no deaths this turn must
 * not stall the settle). Malformed run entries count as not-done (fail-loud,
 * never vacuous). PURE.
 */
export function deathsStageSignal({ pending = 0, runs = [] } = {}) {
  return pending === 0 && runs.every((r) => r && r.done === true);
}

/**
 * W3 — queueKillDeath(queue, { tankId, seedBase, deathN }) -> next deathN.
 * The kill-time QUEUE append (replaces the W2-J immediate playDeath): the
 * entry { tankId, seed } is pushed in KILL ORDER; the seed formula is
 * preserved EXACTLY from the W2-J immediate path —
 *   seed = (seedBase | 0) + deathN * 101, deathN = 1-based kill ordinal
 * — so the same kill sequence rolls the same death cases as before, just
 * deferred to the settle 'deaths' stage. The caller stores the returned
 * deathN back on se. PURE (no playDeath here — the impure drain lives in
 * main.js's tickTankFalls).
 */
export function queueKillDeath(queue, { tankId, seedBase, deathN } = {}) {
  const n = (deathN | 0) + 1;
  queue.push({ tankId, seed: (seedBase | 0) + n * 101 });
  return n;
}
