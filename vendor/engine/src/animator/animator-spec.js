/**
 * character — the declarative character-assembly spec (Phase 1 of Animation Authoring).
 *
 * A `character` block is an OPTIONAL component inside an archetype's `components`
 * map (alongside `transform`/`render`/`collider`). Its presence declares "this
 * archetype is a character"; its absence means "not a character" — non-character
 * archetypes (props, tanks, scenery) omit the key entirely and never trigger
 * `buildAnimator`. It is an ASSEMBLY-TIME RECIPE consumed once at spawn to
 * produce the rig + clips; it is identical across all archetype instances
 * (unlike true per-instance runtime state).
 *
 * GENERALIZATION RULE: this schema and every consumer are specified by rig/asset
 * CHARACTERISTICS, never by any specific asset file or pack. Worked examples use
 * generic ids (`model/character`, `anim/character-idle`). Concrete assets are
 * TEST INPUTS ONLY, chosen at build time from the configured Assets folder.
 *
 * Shape (inside an archetype's `components`):
 * ```jsonc
 * "character": {
 *   "model": "model/characters",        // manifest id (multi-rig or single-rig)
 *   "subRig": "SM_Chr_Character_01",    // which rig to extract (multi-rig files); optional
 *   "scale": 6.0,                       // ONE uniform pack factor
 *   "textures": ["assets/textures/x.png"], // referenced external textures (grep the FBX)
 *   "tint": null,                       // fallback tint for untextured meshes
 *   "clips": {                          // canonical role -> clip manifest id
 *     "idle": "anim/character-idle",
 *     "run":  "anim/character-run",
 *     "walk": "anim/character-walk"
 *   },
 *   "boneMap": "auto",                  // "auto" | "humanoid" | "retarget/<group>.json"
 *   "retarget": {                       // retarget options
 *     "solver": "track-remap",          // only "track-remap" (upf-gti removed)
 *     "bindPose": false                 // optional bind-pose correction (cross-rest-pose)
 *   },
 *   "locomotion": {                     // blend-space spec (see render/blendTree.js)
 *     "params": ["velX", "velY"],       // 1-2 param names: 2 = 2D space, 1 = 1D strip
 *     "points": [                       // continuous blend space (all clips weighted)
 *       { "at": [0, 0], "clip": "idle" },
 *       { "at": [1, 0], "clip": "walk" },
 *       { "at": [0, 1], "clip": "strafe" }
 *     ],
 *     "states": [                       // OPTIONAL hard-select override layer
 *       { "name": "airborne", "clip": "jump" }   // (data-only in BT1)
 *     ],
 *     "default": "idle"                 // when params are missing/cannot evaluate
 *   },
 *   "locomotion": {                     // LEGACY shape (auto-migrates, warns on
 *     "states": [                       // unmigratable conditions — see
 *       { "when": "speed == 0", "clip": "idle" },  // migrateLocomotion)
 *       { "when": "speed > 0", "clip": "run" }
 *     ],
 *     "default": "idle"                 // a clip role, or { clip: "idle" }
 *   },
 *   "rootMotion": "entity",             // "entity" | "none"
 *   "onGround": true                    // place feet on y=0
 * }
 * ```
 */

/** Canonical clip roles. `clips` maps these to manifest ids; a spec may declare any
 * subset (roles are opt-in). The "recommended" locomotion trio below is what the
 * validator soft-warns about when missing. */
export const CLIP_ROLES = ['idle', 'run', 'walk', 'jump']

/** Recommended roles whose absence is a SOFT warning, never a hard failure. A
 * character that only has idle+run is valid and common; it just won't walk. */
export const RECOMMENDED_CLIP_ROLES = ['idle', 'run', 'walk']

/** Valid `boneMap` modes. */
export const BONE_MAP_MODES = ['auto', 'humanoid']

/** A persisted per-game bone map is referenced as "retarget/<group>.json". */
export const PERSISTED_BONE_MAP_PREFIX = 'retarget/'

/** The retarget solver. Only "track-remap" (pure, Node-testable) is supported —
 * the upf-gti bind-pose solver was REMOVED (broken on cross-pack rigs). */
export const RETARGET_SOLVERS = ['track-remap']

/** Valid `rootMotion` values. */
export const ROOT_MOTION_MODES = ['entity', 'none']

/** The skeleton roles a character's bone map must cover to be considered a usable
 * biped. Each entry matches classifyRig's output shape ({ group, side }) — limbs
 * carry a side, the axial chain does not. A hard validation gate checks a resolved
 * map against these (see validateAnimator / validateBoneMapCoverage). */
export const REQUIRED_BONE_ROLES = [
  { group: 'pelvis' },
  { group: 'spine' },
  { group: 'head' },
  { group: 'arm', side: 'L' },
  { group: 'arm', side: 'R' },
  { group: 'leg', side: 'L' },
  { group: 'leg', side: 'R' },
]

/** Defaults applied to an `animator` spec before validation/assembly. Scale /
 *  tint / textures are NOT here — they are model/render/transform concerns
 *  (render.material has color+map; transform.scale is the TRS owner), so the
 *  animator owns ONLY animation-assembly fields. */
export const ANIMATOR_DEFAULTS = {
  boneMap: 'auto',
  retarget: {
    solver: 'track-remap',
    bindPose: false,
  },
  rootMotion: 'entity',
  onGround: true,
}

/**
 * Return a spec with defaults applied (shallow merge; nested blocks replaced by
 * their defaults where absent). Leaves `model`/`subRig`/`clips`/`locomotion` as
 * authored — they carry required, non-defaultable content. Pure.
 * @param {object} [spec]
 * @returns {object} normalized spec (a copy; input never mutated)
 */
export function applyAnimatorDefaults(spec) {
  const s = (spec && typeof spec === 'object') ? { ...spec } : {}
  return {
    ...ANIMATOR_DEFAULTS,
    ...s,
    retarget: {
      ...ANIMATOR_DEFAULTS.retarget,
      ...(s.retarget && typeof s.retarget === 'object' ? s.retarget : {}),
    },
  }
}
