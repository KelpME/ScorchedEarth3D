// Persistent contact cache for the physics solver.
//
// A TEMPORAL cache, not world state: no entry survives maxAgeSteps of
// absence. A re-contact after expiry starts cold (zero impulses — no
// energy injection). All state lives on the instance created by
// createContactCache; there is no module-level state.
//
// Determinism contract: `store` inserts points in exactly the order the
// caller supplies. Ordering of the points array is the CALLER's
// responsibility; this module never reorders, dedupes, or sorts it.
// Pruning iterates a sorted snapshot of keys so deletion order is
// deterministic regardless of Map insertion order.

/**
 * @typedef {{ id: string, normalImpulse: number, lt1: number, lt2: number }} CachedPoint
 */

/**
 * Create a persistent contact cache.
 * @param {{ maxAgeSteps?: number }} [opts]
 * @returns contact cache api
 */
export function createContactCache({ maxAgeSteps = 8 } = {}) {
  if (!Number.isFinite(maxAgeSteps) || maxAgeSteps < 0) {
    throw new Error(`createContactCache: invalid maxAgeSteps: ${maxAgeSteps}`);
  }

  /** @type {Map<string, { points: CachedPoint[], lastSeenStep: number }>} */
  const entries = new Map();

  return {
    /**
     * Return the cached entry for pairKey, or undefined.
     * @param {string} pairKey
     * @returns {{ points: CachedPoint[], lastSeenStep: number } | undefined}
     */
    lookup(pairKey) {
      return entries.get(pairKey);
    },

    /**
     * Store (replace) the entry for pairKey at the given step.
     * Points are inserted in caller-supplied order (see module docs).
     * @param {string} pairKey
     * @param {CachedPoint[]} points
     * @param {number} step finite integer (negative allowed)
     * @throws {TypeError} when step is not a finite number
     */
    store(pairKey, points, step) {
      if (!Number.isFinite(step)) {
        throw new TypeError(
          `createContactCache.store: invalid step: ${step}`,
        );
      }
      entries.set(pairKey, {
        points: points.map((p) => ({
          id: p.id,
          normalImpulse: p.normalImpulse,
          lt1: p.lt1,
          lt2: p.lt2,
        })),
        lastSeenStep: step,
      });
    },

    /**
     * Match old points to new ids by exact id string equality.
     * Never positional/index matching. Ids not present in oldPoints
     * get no warm start (absent from the returned Map).
     * @param {CachedPoint[]} oldPoints
     * @param {string[]} newIds
     * @returns {Map<string, CachedPoint>} newId -> old point
     */
    match(oldPoints, newIds) {
      const byId = new Map();
      for (const p of oldPoints) byId.set(p.id, p);
      const out = new Map();
      for (const id of newIds) {
        const old = byId.get(id);
        if (old !== undefined) out.set(id, old);
      }
      return out;
    },

    /**
     * Existence probe only: reports whether pairKey is known. The step
     * argument is accepted for signature consistency but IGNORED —
     * staleness is purely temporal via lastSeenStep, and lastSeenStep is
     * left unchanged. The entry keeps its last known impulses; warmStartOf
     * only returns them while (step - lastSeenStep) <= maxAgeSteps.
     * @param {string} pairKey
     * @param {number} step unused (finite integer); see note above
     * @throws {TypeError} when step is not a finite number
     */
    markStale(pairKey, step) {
      // The entry keeps its last known impulses and lastSeenStep is
      // unchanged — staleness is purely temporal: the window since the
      // pair was last actually seen governs warm-starting and pruning.
      if (!Number.isFinite(step)) {
        throw new TypeError(
          `createContactCache.markStale: invalid step: ${step}`,
        );
      }
      const entry = entries.get(pairKey);
      if (entry === undefined) return false;
      return true; // pair is known; caller treats it as absent this frame
    },

    /**
     * Remove entries expired at `step`. Iterates a sorted key
     * snapshot for deterministic deletion order.
     * @param {number} step
     */
    prune(step) {
      const keys = [...entries.keys()].sort();
      for (const key of keys) {
        const entry = entries.get(key);
        if (step - entry.lastSeenStep > maxAgeSteps) entries.delete(key);
      }
    },

    /**
     * Warm-start points for pairKey, or null when absent or
     * stale beyond maxAgeSteps. Stale impulses are NEVER applied
     * beyond the window.
     * @param {string} pairKey
     * @param {number} step
     * @returns {CachedPoint[] | null}
     */
    warmStartOf(pairKey, step) {
      const entry = entries.get(pairKey);
      if (entry === undefined) return null;
      if (step - entry.lastSeenStep > maxAgeSteps) return null;
      return entry.points;
    },

    /** @returns {number} */
    size() {
      return entries.size;
    },

    clear() {
      entries.clear();
    },
  };
}
