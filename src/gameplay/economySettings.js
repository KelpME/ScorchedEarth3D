// resolveCashAtStart — PURE boot resolver for a player's starting money.
//
// WHY: The settings-UI source of truth is data/economy.json
// (options.cashAtStart.default / .range.max). The boot path in src/main.js
// startBattle reads ONLY localStorage 'se.settings' and never consulted the
// descriptor default, so a fresh install (empty localStorage) got the grant
// seed ($20,000) and a stale persisted cashAtStart:0 (the pre-migration
// degenerate default) gave an UNPLAYABLE $0 start. This resolver makes the
// boot path fall back to the descriptor default and migrates the stale 0 up.
//
// Pure + testable on purpose: main.js is a browser entry point (can't be
// unit-tested), so all decision logic lives here. main.js only does the
// console.error logging + localStorage write around this call.
//
// Returns { cash: number, migrated: string[], settings: object }.
//   cash       — the starting money to hand createBattle.
//   migrated   — keys the CALLER should persist back to localStorage (e.g.
//                ['cashAtStart'] when a stale 0 was migrated up to the default).
//   settings   — the (possibly migrated) stored settings object; all other
//                keys are preserved untouched (spread the raw object).
export function resolveCashAtStart(storedSettings, econDoc) {
  const opt = econDoc.options.cashAtStart;
  const def = opt.default; // descriptor default (OG INITIAL_CASH = 1000000)
  const max = opt.range.max; // range max (1000000)

  // Guard: never trust junk — only a plain non-array object is real settings.
  // (Mirrors the localStorage JSON.parse guard in main.js.)
  const raw = (storedSettings && typeof storedSettings === 'object' && !Array.isArray(storedSettings))
    ? storedSettings
    : {};

  const cas = raw.cashAtStart;

  // Absent -> fresh install now gets the descriptor default (not the grant seed).
  if (cas == null) {
    return { cash: def, migrated: [], settings: raw };
  }

  // A finite number within [0, max] is a valid stored value.
  if (typeof cas === 'number' && Number.isFinite(cas) && cas >= 0 && cas <= max) {
    if (cas === 0) {
      // MIGRATE: the stale 0 was the pre-migration degenerate default — no
      // player deliberately chose a $0 start; it's unplayable. Lift it to the
      // descriptor default and return the migrated settings so the caller can
      // persist it (UI + boot then agree, and it never re-migrates).
      return { cash: def, migrated: ['cashAtStart'], settings: { ...raw, cashAtStart: def } };
    }
    // A deliberate non-zero choice is respected.
    return { cash: cas, migrated: [], settings: raw };
  }

  // Invalid (out of range / non-number) -> descriptor default. The caller logs
  // the invalid value loudly (main.js keeps the fail-NOISY message).
  return { cash: def, migrated: [], settings: raw };
}
