/**
 * Engine built-in component: `animator`.
 *
 * The declarative character-assembly recipe (Animation Authoring Phase 1).
 * An OPTIONAL component on an archetype: its presence declares "this is a
 * character"; absence = "not a character" (props/tanks/scenery omit it). It is
 * an assembly-time recipe consumed ONCE by `buildAnimator` to produce the rig
 * + clips, IDENTICALLY in the game `main.js` and the editor.
 *
 * The `animator` block is NOT simulated per frame — it's the recipe. After
 * assembly the result (a skinned rig + clips on the renderer) is what matters.
 *
 * GENERALIZATION RULE: fields describe rig/asset CHARACTERISTICS, never
 * specific asset files — worked examples use generic ids.
 */
export const name = 'animator'

export const label = 'Character Rig'

export const description = 'Build-once recipe: assembles this object as an animated character (model + rig + clips) via buildAnimator when its model loads. Per-frame playback state lives on the separate `playback` component.'

export const params = {
  subRig: { type: 'string', label: 'SubRig', description: 'Which rig to extract from a multi-rig file (optional). The model itself comes from render.modelName.' },
  clips: { type: 'object', label: 'Clips', description: 'Canonical role -> clip manifest id (e.g. idle -> anim/character-idle).' },
  // `retarget` removed from the card (2026-09-19): zero games author it; the
  // `solver` option died with track-remap-only. buildAnimator still honors a
  // hand-authored `retarget.bindPose` if present in the scene data (undeclared
  // fields pass through), it just isn't a card row anymore.
  locomotion: { type: 'object', label: 'Locomotion', description: 'blend-space spec (see blendTree.js): { params: ["velX","velY"], points: [{ at: [x, y], clip }], default, states?: [{ name, clip }] }. The legacy { states: [{ when, clip }], default } form auto-migrates.' },
  rootMotion: { type: 'string', label: 'Root motion', default: 'entity', description: 'entity | none' },
  onGround: { type: 'boolean', label: 'On ground', default: true, description: 'Place feet on y=0.' },
}

export default { name, label, description, params }
