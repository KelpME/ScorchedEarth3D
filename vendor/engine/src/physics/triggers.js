/**
 * P4a T2: trigger overlap events — pure helpers.
 *
 * Trigger-overlap keys are canonical sorted pair strings ('a|b', a < b) —
 * the same canonicalization as contact pair keys. Determinism contract:
 * every returned array is SORTED lexicographically (no Map iteration drives
 * any ordering decision).
 */

/** Sort an array of pair keys lexicographically (returns a new array). */
function sortedKeys(keys) {
  return [...keys].sort()
}

/**
 * Pure set diff between the previous and current trigger-overlap key sets.
 * @param {Iterable<string>} prevKeys previous step's overlap keys
 * @param {Iterable<string>} curKeys  this step's overlap keys
 * @returns {{ enter: string[], stay: string[], exit: string[] }} each sorted
 */
export function diffTriggerSets(prevKeys, curKeys) {
  const prev = new Set(sortedKeys(prevKeys))
  const cur = new Set(sortedKeys(curKeys))
  const enter = [], stay = [], exit = []
  for (const k of prev) if (!cur.has(k)) exit.push(k)
  for (const k of cur) (prev.has(k) ? stay : enter).push(k)
  // Built by iteration over sorted inputs — already sorted.
  return { enter, stay, exit }
}

/**
 * Stateful tracker: holds the previous step's key set, diffs on update.
 * @returns {{ update(curKeys: Iterable<string>): { enter: string[], stay: string[], exit: string[] } }}
 */
export function createTriggerTracker() {
  let prev = new Set()
  return {
    /** @param {Iterable<string>} curKeys this step's overlap keys (sorted internally) */
    update(curKeys) {
      const d = diffTriggerSets(prev, curKeys)
      prev = new Set(curKeys)
      return d
    },
  }
}
