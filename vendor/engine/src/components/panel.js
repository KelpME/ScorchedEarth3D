/**
 * Engine built-in component: `panel`.
 *
 * A UI widget that is a CONTAINER for child widgets (the nesting piece). Its
 * own rect defines the child-layout region (children position relative to the
 * panel's rect). Renders a translucent bordered backdrop. WS3-Pro: the
 * backdrop look is now DATA — `backColor`, `borderColor`, `borderWidth`,
 * `cornerRadius` — with defaults matching the previously hardcoded look (the
 * world-canvas stroke unifies on the DOM's border alpha; documented).
 */

export const name = 'panel'

export const label = 'Panel'

export const description = 'A UI panel widget: a container for child widgets rendering a bordered backdrop (all colors/widths editable).'

export const params = {
  backColor: { type: 'string', default: 'rgba(20,22,28,0.55)' },
  borderColor: { type: 'string', default: 'rgba(255,255,255,0.18)' },
  borderWidth: { type: 'number', default: 1, min: 0, description: 'Border width in reference px (0 = none)' },
  cornerRadius: { type: 'number', default: 6, min: 0, description: 'Corner radius in reference px' },
  interactive: { type: 'boolean', default: false, description: 'Declares this widget CLICKABLE: the runtime overlay opens pointer-events for its node and clicks dispatch to the entity scripts\' onPointerClick hook (WAVE-3 widget interaction seam).' },
}

export default { name, label, description, params }
