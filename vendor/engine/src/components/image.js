/**
 * Engine built-in component: `image`.
 *
 * A UI widget that renders a texture by its manifest id (`src` — a logical
 * `texture/<stem>` manifest id, never a guessed path). Screen mode (DOM
 * overlay) sets it as a background image; world mode paints the RESOLVED
 * texture image into the world canvas texture. WS3-Pro: `fit` — stretch
 * (default, back-compat with the old stretch-only look), contain, or cover.
 */

export const name = 'image'

export const label = 'Image'

export const description = 'A UI image widget: renders a manifest texture by logical id (src), with a fit mode.'

export const params = {
  src: { type: 'string', default: '', description: 'Logical manifest texture id (texture/<stem>)' },
  fit: { type: 'string', default: 'stretch', description: 'stretch | contain | cover' },
  interactive: { type: 'boolean', default: false, description: "Declares this widget CLICKABLE: the runtime overlay opens pointer-events for its node and clicks dispatch to the entity scripts' onPointerClick hook (WAVE-3 widget interaction seam)." },
}

export default { name, label, description, params }