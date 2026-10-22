// W6 (SE-FIXUP-1012 items 5) — between-rounds store flow, PURE: no DOM, no
// engine imports; node --test-able.
//
// USER RULE ("never actually get the opportunity to shop"): after a round
// ends (scores tallied), the store ALWAYS opens for the human BEFORE the next
// round starts; computer buys happen per computersBuy at the same boundary
// (economy.roundBoundary); an explicit close/"next round" action proceeds.
// main.js consumes these helpers at the real round boundary
// (checkRoundEnd -> phase 'roundend').

/**
 * storeTargetPlayer(players): the HUMAN the between-rounds store opens for —
 * the first ALIVE non-computer player (createBattle sets isComputer from
 * p.kind). Returns null when no human is alive (computers only) — main.js
 * then resumes without opening a store nobody can use.
 */
export function storeTargetPlayer(players) {
  return (players ?? []).find((p) => p && p.alive && p.isComputer !== true) ?? null;
}

/**
 * storeQueue(players): the ordered list of players who take a MANUAL store
 * turn at the round boundary — every player EXCEPT computers (p.isComputer),
 * INCLUDING dead players (they respawn at the boundary: nextRound() inside
 * endRound() resets alive BEFORE the store opens), in battle.players order.
 * Computers keep their automatic roundBoundary computersBuy pass. An empty
 * result (computers only) means no store — main.js resumes fail-noisy.
 */
export function storeQueue(players) {
  return (players ?? []).filter((p) => p && p.isComputer !== true);
}

/**
 * resumeAllowed({ phase, storeOpen }): the round rollover resume gate. The
 * next round does NOT start while the between-rounds store is open — only an
 * explicit close/'next round' action (store DONE, or a click outside the
 * open panel) proceeds, and only from the parked 'roundend' phase.
 */
export function resumeAllowed({ phase, storeOpen } = {}) {
  return phase === 'roundend' && storeOpen !== true;
}
