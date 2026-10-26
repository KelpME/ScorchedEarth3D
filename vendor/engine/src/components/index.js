/**
 * Engine built-in components (plans/PHYSICS.md, "components as tools").
 *
 * The engine owns the definition of every built-in per-entity component so a
 * project "imports" the tools it needs instead of the editor hardcoding them.
 * This mirrors the built-in scripts (camera-rig / audio-emitter / dynamic-body)
 * and the physics system: pure data + metadata, no behavior of their own.
 *
 * One file per component lives in this folder (transform.js, render.js,
 * collider.js, playback.js, audio.js, camera.js). Adding a new component = add a
 * file here that exports { name, label, description, params } and register it
 * in `BUILTIN_COMPONENTS` below — it then appears in the editor's Add-Component
 * list automatically (no editor changes).
 *
 * Each `params` is a field schema ({ field: { type, default?, required? } }) —
 * the same shape scripts use, so the editor can validate, apply defaults, and
 * render editable fields for any component without a bespoke card.
 *
 * Components that ALSO have engine behavior (render -> Renderer, collider ->
 * physics, playback -> AnimationMixer, camera -> viewport preview, audio -> preview)
 * keep that behavior where it already lives; this registry is the declarative
 * "what the tool is and how to attach it" surface, exported for the editor and
 * available to any project.
 *
 * Beyond the built-ins, a GAME can register its own component metas (pure
 * metadata — game-local gameplay data like `health`/`projectile`/`enemy`) into
 * a ComponentRegistry so they surface in the editor too, without becoming
 * engine built-ins (the six-primitives decision). `COMPONENT_REGISTRY` below is
 * the shared default instance (seeded with the built-ins) the editor registers
 * game-local metas into; `componentDefaults` consults it, so attach-defaults
 * work for built-in AND game-local components alike.
 */

import transform from './transform.js'
import render from './render.js'
import collider from './collider.js'
import placement from './placement.js'
import playback from './playback.js'
import audio from './audio.js'
import camera from './camera.js'
import light from './light.js'
import animator from './animator.js'
import canvas from './canvas.js'
import rect from './rect.js'
import text from './text.js'
import image from './image.js'
import bar from './bar.js'
import shape from './shape.js'
import panel from './panel.js'
import terrain from './terrain.js'
import navAgent from './nav-agent.js'
import navPoint from './nav-point.js'
import rigidBody from './rigid-body.js'
import characterController from './character-controller.js'
import joint from './joint.js'
import velocity from './velocity.js'
import positionalAudio from './positional-audio.js'
import { ComponentRegistry, createComponentsApi } from './registry.js'

/**
 * Engine-owned component metadata, keyed by component name. Register a new
 * built-in component here (from a file in this folder) to surface it.
 */
export const BUILTIN_COMPONENTS = {
  [transform.name]: transform,
  [render.name]: render,
  [collider.name]: collider,
  [placement.name]: placement,
  [playback.name]: playback,
  [audio.name]: audio,
  [camera.name]: camera,
  [light.name]: light,
  [animator.name]: animator,
  [canvas.name]: canvas,
  [rect.name]: rect,
  [text.name]: text,
  [image.name]: image,
  [bar.name]: bar,
  [shape.name]: shape,
  [panel.name]: panel,
  [terrain.name]: terrain,
  [navAgent.name]: navAgent,
  [navPoint.name]: navPoint,
  [rigidBody.name]: rigidBody,
  [characterController.name]: characterController,
  [joint.name]: joint,
  [velocity.name]: velocity,
  [positionalAudio.name]: positionalAudio,
}

/**
 * Metadata list (for the editor's Add-Component picker), mirroring the script
 * metas shape. Excludes `transform` (every object already has one).
 */
export const BUILTIN_COMPONENT_METAS = Object.keys(BUILTIN_COMPONENTS)
  .filter((name) => name !== 'transform')
  .map((name) => ({ name, ...BUILTIN_COMPONENTS[name] }))

/**
 * The shared default component registry, seeded with the engine built-ins. The
 * editor (and any game host) registers game-local component metas into this so
 * they merge into the same picker + defaults path as the built-ins.
 */
export const COMPONENT_REGISTRY = new ComponentRegistry({ metas: BUILTIN_COMPONENTS })

/**
 * Default component data for a component name, with schema defaults applied
 * ({}, plus required/typed defaults). Consults the shared registry (built-ins +
 * any runtime-registered game-local metas). Unknown names -> {}.
 * @param {string} name
 * @returns {object}
 */
export function componentDefaults(name) {
  return COMPONENT_REGISTRY.defaults(name)
}

export { ComponentRegistry, createComponentsApi }
