/**
 * Engine built-in component: `canvas`.
 *
 * Makes this entity a UI ROOT that holds child widget entities (parented via the
 * ECS `parent` field). `renderMode: 'screen'` renders the canvas as a
 * screen-space overlay (the HUD, normalized coords); `renderMode: 'world'`
 * renders the canvas as a world-space surface (a sign, monitor, scoreboard) —
 * its widgets are painted onto a textured plane at the entity's `transform`.
 *
 * Sizing (the standard design-resolution model): content is authored in
 * `resolution` (pixels, the reference space widgets are laid out in) and the
 * WORLD surface is `width` × `height` (world units). For a world canvas the
 * texture scales to fit `width` × `height`; for a screen canvas `resolution` is
 * the reference layout the screen HUD is authored against. The world plane is
 * bottom-left anchored at the entity's transform, extending +X (right) / +Y
 * (up). Child widgets each carry one typed widget component (text / image /
 * bar / shape / panel) + a `rect`.
 *
 * See render/ui-schema.js (pure, facade-exported) for the contract.
 */

export const name = 'canvas'

export const label = 'UI Canvas'

export const description =
  'A UI root. Holds child widget entities (text / image / bar / shape / panel). renderMode "screen" = HUD overlay, "world" = a positioned surface (sign/monitor).'

export const params = {
  renderMode: { type: 'string', default: 'screen', description: "'screen' = HUD overlay, 'world' = a surface positioned in the scene" },
  resolution: { type: 'array', default: [512, 512], description: 'Content resolution [w, h] px — the reference space widgets are laid out in' },
  width: { type: 'number', default: 8, description: 'World width in units (world renderMode; also the authoring proxy size for screen)' },
  height: { type: 'number', default: 4.5, description: 'World height in units (world renderMode; also the authoring proxy size for screen)' },
}

export default { name, label, description, params }
