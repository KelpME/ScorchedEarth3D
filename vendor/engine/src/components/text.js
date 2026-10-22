/**
 * Engine built-in component: `text`.
 *
 * A UI widget that renders text. `string` is the content, `color` a CSS color,
 * `size` the font size in px (screen mode; scaled by resolution in world mode).
 * Typography is data-driven (WS3-Pro): `font` is a CSS font-family string
 * (system fonts — type `Georgia` or `monospace` and it renders), `weight` a
 * CSS font-weight, `align` the text alignment within its rect, `lineHeight` a
 * multiplier for multi-line text, and `wrap` + `maxWidth` (a 0..1 fraction of
 * the canvas) enable word-wrap. The DOM overlay (`render/ui.js`) and the world
 * canvas paint (`render/world-canvas.js`) honor the SAME fields with the SAME
 * defaults.
 */

export const name = 'text'

export const label = 'Text'

export const description = 'A UI text widget: string, color, size, font, weight, align, wrap.'

export const params = {
  string: { type: 'string', default: 'Text' },
  color: { type: 'string', default: '#ffffff' },
  size: { type: 'number', default: 20 },
  font: { type: 'string', default: 'system-ui, sans-serif', description: 'CSS font-family (system fonts)' },
  weight: { type: 'string', default: 'normal', description: 'CSS font-weight: normal, bold, 600…' },
  align: { type: 'string', default: 'left', description: 'left | center | right' },
  lineHeight: { type: 'number', default: 1.2, description: 'Line height multiplier' },
  wrap: { type: 'boolean', default: false, description: 'Word-wrap at maxWidth' },
  maxWidth: { type: 'number', default: 0, description: 'Wrap width as a 0..1 fraction of the canvas (0 = unlimited)' },
}

export default { name, label, description, params }
