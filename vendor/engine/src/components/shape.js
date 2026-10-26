/**
 * Engine built-in component: `shape`.
 *
 * A UI widget that renders a solid colored rectangle filling its rect.
 * WS3-Pro: optional border (`borderColor`/`borderWidth`) and `cornerRadius`.
 * Defaults keep the historical look EXACTLY: border off (width 0), radius 0.
 */

export const name = 'shape'

export const label = 'Shape'

export const description = 'A UI shape widget: a solid colored rect filling its rect, optional border + corner radius.'

export const params = {
  color: { type: 'string', default: '#4caf50' },
  borderColor: { type: 'string', default: 'rgba(255,255,255,0.25)', description: 'Border color (only drawn when borderWidth > 0)' },
  borderWidth: { type: 'number', default: 0, min: 0, description: 'Border width in reference px (0 = none)' },
  cornerRadius: { type: 'number', default: 0, min: 0, description: 'Corner radius in reference px' },
  interactive: { type: 'boolean', default: false, description: "Declares this widget CLICKABLE: the runtime overlay opens pointer-events for its node and clicks dispatch to the entity scripts' onPointerClick hook (WAVE-3 widget interaction seam)." },
}

export default { name, label, description, params }
