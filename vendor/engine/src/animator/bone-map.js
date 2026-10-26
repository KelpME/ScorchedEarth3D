/**
 * bone-map — resolve a character's `boneMap` setting into an effective authored
 * map for `retargetClip`.
 *
 * The `character` spec's `boneMap` field controls HOW source clip bones map to
 * the target rig's bones. Precedence (per the character-assembly plan):
 *
 *   1. `retarget/<group>.json`  — an explicit PER-GAME PERSISTED map (hand-
 *      authored, e.g. by a legacy game's tooling). Highest priority — the
 *      human's tuning always wins.
 *   2. `auto` (default)         — the structural NAME-FREE auto-map
 *      (`autoMapRigs`): classify both skeletons by topology + geometry, so the
 *      mapping is correct regardless of naming. Falls back to the name-based
 *      default only if the structural pass yields nothing.
 *   3. `humanoid`               — the curated name-based `HUMANOID_BONE_MAP`
 *      (Kevin `B-*`, Mixamo `mixamorig:*`, MoCap `MHuman_*`, generic). Zero
 *      config for known packs.
 *
 * `retargetClip` merges an authored map over `HUMANOID_BONE_MAP` (its default),
 * so returning `null` means "use the engine default name map". Returning a map
 * means "the human's / structural map, merged over the name default".
 *
 * GENERALIZATION RULE: no specific asset names here — only bone CHARACTERISTICS
 * and the spec's declared mode.
 */

import { PERSISTED_BONE_MAP_PREFIX } from './animator-spec.js'

/**
 * Resolve the effective bone map for a character spec.
 * @param {object} spec  the `character` spec (boneMap may be undefined → 'auto')
 * @param {object} opts
 * @param {Array}  opts.srcBones      source clip bone tree (for autoMapRigs)
 * @param {Array}  opts.targetBones   target rig bone tree (for autoMapRigs)
 * @param {Function} [opts.autoMapRigs]  (srcBones, targetBones) => {src:target}
 * @param {Function} [opts.getPersistedMap]  (group) => authored map for
 *        `retarget/<group>.json`; only called when boneMap uses that form.
 * @returns {{ map: object|null, mode: string, persistedGroup?: string }}
 *   `map` is the authored map to pass to retargetClip (null = use engine default
 *   name map). `mode` is the resolved mode ('auto'|'humanoid'|'persisted').
 */
export function resolveCharacterBoneMap(spec = {}, opts = {}) {
  const mode = (spec.boneMap === undefined || spec.boneMap === null) ? 'auto' : String(spec.boneMap)
  const { autoMapRigs, getPersistedMap } = opts

  // 1. Persisted per-game map — human tuning wins.
  if (mode.startsWith(PERSISTED_BONE_MAP_PREFIX)) {
    const group = mode.slice(PERSISTED_BONE_MAP_PREFIX.length)
    const authored = (typeof getPersistedMap === 'function') ? getPersistedMap(group) : null
    return { map: authored && typeof authored === 'object' ? authored : null, mode: 'persisted', persistedGroup: group }
  }

  // 2. Structural auto-map (default).
  if (mode === 'auto') {
    if (typeof autoMapRigs === 'function' && Array.isArray(opts.srcBones) && Array.isArray(opts.targetBones)) {
      const map = autoMapRigs(opts.srcBones, opts.targetBones)
      if (map && typeof map === 'object' && Object.keys(map).length > 0) {
        return { map, mode: 'auto' }
      }
    }
    // Structural pass yielded nothing — fall back to the name default.
    return { map: null, mode: 'auto' }
  }

  // 3. Named humanoid default (zero-config).
  if (mode === 'humanoid') {
    return { map: null, mode: 'humanoid' }
  }

  // Unknown mode (validateAnimator should have caught it) — safest: name default.
  return { map: null, mode }
}
