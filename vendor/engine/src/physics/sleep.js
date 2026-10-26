// Sleeping state machine — pure, deterministic.
//
// P3.5 ISLAND-LEVEL SLEEPING (2026-09-14, external-review direction, human
// approved): a body never decides to sleep alone. The unit of sleep is the
// CONTACT ISLAND — the connected set of bodies joined by support edges (and
// every body joined to it). The island's timer advances only when EVERY
// dynamic body in the island is simultaneously quiet in three measures:
//   1. linear speed ≤ linearThreshold
//   2. angular speed ≤ angularThreshold
//   3. solver-correction load ≤ correctionThreshold (the max accumulated
//      normal impulse the solver needed this step, normalized by mass —
//      "is the solver still fighting to hold this body up?")
// When the island's timer reaches timeUntilSleep, the ENTIRE island sleeps.
// One moving body keeps the whole stack awake; a settled stack sleeps as a
// unit; nothing is declared asleep while its neighbors are still correcting.
//
// Determinism: islands are identified by canonical sorted-id group keys; the
// manager holds no iteration-order-dependent state. Wake resets the island's
// timer and sleeping flags for all members.

export function createSleepManager(opts = {}) {
  const linearThreshold = opts.linearThreshold ?? 0.05;
  const angularThreshold = opts.angularThreshold ?? 0.05;
  const timeUntilSleep = opts.timeUntilSleep ?? 0.5;
  const correctionThreshold = opts.correctionThreshold ?? 0.5;

  const bodies = new Map(); // id -> { timer (island-shared view), sleeping, islandKey }

  const ensure = (id) => {
    let b = bodies.get(id);
    if (!b) {
      b = { timer: 0, sleeping: false, islandKey: null };
      bodies.set(id, b);
    }
    return b;
  };

  const markAwake = (id) => {
    const b = bodies.get(id);
    if (b) {
      // Wake one body → reset its island's timer (the island is no longer
      // demonstrably settled) and clear the sleeping flags of the island
      // members that were put to sleep with it.
      const key = b.islandKey;
      if (key) {
        for (const [, other] of bodies) {
          if (other.islandKey === key) {
            other.timer = 0;
            other.sleeping = false;
          }
        }
      } else {
        b.timer = 0;
        b.sleeping = false;
      }
    }
    return manager;
  };

  const manager = {
    markAwake,
    wake: markAwake,
    /**
     * Island-level sleep evaluation (P3.5). `islands` is an array of
     * { key, bodies: [{ id, speed, angSpeed, correction }] } — one entry per
     * connected contact island, deterministic order. Solo bodies (no
     * contacts) are islands of one. Each island's timer advances only when
     * ALL of its members are quiet; reaching timeUntilSleep sleeps every
     * member. Returns the manager.
     */
    markIslandCandidate(islands, dt) {
      for (const island of islands) {
        const quiet = island.bodies.every(
          (m) => m.speed <= linearThreshold && m.angSpeed <= angularThreshold && m.correction <= correctionThreshold
        );
        const first = bodies.get(island.bodies[0].id);
        const alreadyAllAsleep = island.bodies.every((m) => {
          const b = bodies.get(m.id);
          return b && b.sleeping;
        });
        if (alreadyAllAsleep) continue; // sleeping island stays asleep
        let timer = first ? first.timer : 0;
        // Preserve continuity: use the max member timer (they share the island
        // key, so they carry the same value; a newly-seen body starts at 0 —
        // adopt the island's established timer so a settled stack doesn't
        // restart because one member was freshly registered).
        for (const m of island.bodies) {
          const b = bodies.get(m.id);
          if (b && b.timer > timer) timer = b.timer;
        }
        if (quiet) {
          timer += dt;
          if (timer >= timeUntilSleep - 1e-9) {
            for (const m of island.bodies) {
              const b = ensure(m.id);
              b.timer = timer;
              b.sleeping = true;
              b.islandKey = island.key;
            }
            continue;
          }
        } else if (!alreadyAllAsleep) {
          timer = 0;
        }
        for (const m of island.bodies) {
          const b = ensure(m.id);
          b.timer = timer;
          b.islandKey = island.key;
          // An island member that was sleeping but whose island went unquiet
          // (shouldn't happen — waking resets — but defensive) wakes here.
          if (!quiet) b.sleeping = false;
        }
      }
      return manager;
    },
    isSleeping(id) {
      const b = bodies.get(id);
      return b ? b.sleeping : false;
    },
    sleepingIds() {
      const out = [];
      for (const [id, b] of bodies) {
        if (b.sleeping) out.push(id);
      }
      out.sort();
      return out;
    },
    reset() {
      bodies.clear();
      return manager;
    },
    stats() {
      let sleeping = 0;
      for (const b of bodies.values()) {
        if (b.sleeping) sleeping++;
      }
      return { sleeping, candidates: bodies.size };
    },
  };

  return manager;
}
