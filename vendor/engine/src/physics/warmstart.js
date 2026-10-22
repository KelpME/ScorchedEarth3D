/**
 * Warm-start impulse store for the physics solver (pure, deterministic).
 *
 * Caches accumulated contact impulses per contact-pair across steps so the
 * next iteration can seed from the previous solution. Internals are a single
 * Map keyed by the canonical pair key `${a}|${b}` (a < b, same convention as
 * solver.js sortPairs). No Map iteration is used to produce outputs — prune
 * receives the alive keys directly, in the caller's order.
 *
 * prune(aliveKeys) means "these pairs still exist after the step": the store
 * is replaced wholesale with only those keys (stale pairs are dropped). If
 * aliveKeys.length exceeds maxEntries, the FIRST maxEntries of the sorted
 * array are kept — deterministic eviction, no Map iteration for ordering.
 * Fetching previous impulses before pruning is the CALLER's job.
 */

/**
 * Canonical contact-pair key: sorted ids joined by `|` (a < b).
 * @param {string} idA
 * @param {string} idB
 * @returns {string}
 */
export function pairKey(idA, idB) {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`
}

/**
 * @param {{ maxEntries?: number }} [opts]
 * @returns {{
 *   key: (idA: string, idB: string) => string,
 *   store: (k: string, impulses: { jn: number, jtx: number, jty: number, jtz: number }) => void,
 *   fetch: (k: string) => { jn: number, jtx: number, jty: number, jtz: number } | null,
 *   prune: (aliveKeys: string[]) => void,
 *   clear: () => void,
 *   size: () => number,
 * }}
 */
export function createWarmStart(opts = {}) {
  const maxEntries = opts.maxEntries | 0 || 4096
  /** @type {Map<string, { jn: number, jtx: number, jty: number, jtz: number }>} */
  const map = new Map()

  return {
    key(idA, idB) {
      return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`
    },

    store(k, impulses) {
      map.set(k, {
        jn: impulses.jn >= 0 ? impulses.jn : 0,
        jtx: impulses.jtx,
        jty: impulses.jty,
        jtz: impulses.jtz,
      })
    },

    fetch(k) {
      const hit = map.get(k)
      if (hit === undefined) return null
      // COPY — callers may mutate the returned impulses freely.
      return { jn: hit.jn, jtx: hit.jtx, jty: hit.jty, jtz: hit.jtz }
    },

    prune(aliveKeys) {
      if (aliveKeys.length > maxEntries) {
        aliveKeys = [...aliveKeys].sort().slice(0, maxEntries)
      }
      const next = new Map()
      for (let i = 0; i < aliveKeys.length; i++) {
        const hit = map.get(aliveKeys[i])
        if (hit !== undefined) next.set(aliveKeys[i], hit)
      }
      map.clear()
      for (const [k, v] of next) map.set(k, v)
      next.clear()
    },

    clear() {
      map.clear()
    },

    size() {
      return map.size
    },
  }
}
