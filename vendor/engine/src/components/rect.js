/**
 * Engine built-in component: `rect`.
 *
 * A UI widget's position + size, relative to its parent (a canvas or a panel).
 * All normalized (0..1 fractions of the parent): `x`/`y` are the offset from
 * the anchor, `w`/`h` the size (0 = auto-size for text).
 *
 * Two anchoring modes:
 *  - `anchor` (9-way string, one of UI_RECT_ANCHORS) + `marginX`/`marginY`
 *    (px): screen-space pinning. A widget pins to that region of its parent —
 *    the VIEWPORT for a screen-mode canvas, the canvas surface rect for world
 *    mode — with margins pushing it in from the anchored edge(s). Corners
 *    apply both margins; side anchors center the cross axis; 'center' centers
 *    both. The default 'top-left' with 0 margins is pixel-identical to legacy.
 *  - `anchorX`/`anchorY` (0..1): the legacy pinned-corner fractions, still
 *    honored when `anchor` is absent. See render/ui-schema.js
 *    `resolveAnchorRect` for the resolution math.
 */

import { UI_RECT_ANCHORS } from '../render/ui-schema.js'

export const name = 'rect'

export const label = 'Rect'

export const description =
  'A UI widget layout: position + size relative to its parent, normalized (0..1). anchor pins to a 9-way screen-space region (margins inset from the edges); anchorX/anchorY are the legacy corner fractions.'

export const params = {
  x: { type: 'number', default: 0, description: 'Normalized horizontal offset from the anchor' },
  y: { type: 'number', default: 0, description: 'Normalized vertical offset from the anchor' },
  w: { type: 'number', default: 0.25, description: 'Normalized width (0 = auto)' },
  h: { type: 'number', default: 0.12, description: 'Normalized height (0 = auto)' },
  anchor: { type: 'enum', options: UI_RECT_ANCHORS, default: 'top-left', description: '9-way screen-space anchor (corner/side/center of the parent; margins inset from the edges)' },
  marginX: { type: 'number', default: 0, min: 0, description: 'Horizontal inset (px) from the anchored edge' },
  marginY: { type: 'number', default: 0, min: 0, description: 'Vertical inset (px) from the anchored edge' },
  anchorX: { type: 'number', default: 0, min: 0, max: 1, description: 'Legacy horizontal anchor corner (0 left .. 1 right), used when anchor is unset' },
  anchorY: { type: 'number', default: 0, min: 0, max: 1, description: 'Legacy vertical anchor corner (0 top .. 1 bottom), used when anchor is unset' },
}

export default { name, label, description, params }
