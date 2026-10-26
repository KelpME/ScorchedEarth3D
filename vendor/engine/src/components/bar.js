/**
 * Engine built-in component: `bar`.
 *
 * A UI widget that renders a fill bar. `value` (0..1) is the fill fraction,
 * `color` the fill color, `backColor` the track behind it. WS3-Pro: optional
 * border (`borderColor`/`borderWidth`) and `cornerRadius` (in reference px of
 * the 512-height content resolution — both paint paths scale consistently).
 */

export const name = 'bar'

export const label = 'Bar'

export const description = 'A UI bar widget: a value (0..1) fill bar with a track, optional border + corner radius.'

export const params = {
  value: { type: 'number', default: 0.5, min: 0, max: 1 },
  color: { type: 'string', default: '#4caf50' },
  backColor: { type: 'string', default: 'rgba(0,0,0,0.5)' },
  borderColor: { type: 'string', default: 'rgba(255,255,255,0.25)', description: 'Border color (only drawn when borderWidth > 0)' },
  borderWidth: { type: 'number', default: 0, min: 0, description: 'Border width in reference px (0 = none)' },
  cornerRadius: { type: 'number', default: 3, min: 0, description: 'Corner radius in reference px' },
}

export default { name, label, description, params }
