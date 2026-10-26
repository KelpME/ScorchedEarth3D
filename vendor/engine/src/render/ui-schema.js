/**
 * Engine — UI canvas + widget schema (pure, Node-testable).
 *
 * The ECS-first UI model: a `canvas` component on an entity makes it a UI root
 * that holds CHILD WIDGET ENTITIES (parented via the ECS `parent` field), each
 * carrying ONE typed widget component (text / image / bar / shape / panel) plus
 * a `rect` component. The same canvas renders as a screen-space overlay
 * (`renderMode: 'screen'`) OR as a world-space object (`renderMode: 'world'`).
 *
 * This module is the pure authoring contract for that data: widget type
 * vocabulary, per-type defaults, normalization, validation, anchor resolution,
 * and rect→world mapping. No DOM or three dependency, so it is unit-testable
 * under Node and usable by the editor to validate/apply defaults for a canvas.
 *
 * Coordinates are NORMALIZED fractions (0..1) relative to the parent (the
 * canvas, or a panel widget). `rect = { x, y, w, h, anchorX, anchorY }`:
 *   - `x`/`y`   — normalized offset from the anchor corner (0..1 of the parent).
 *   - `w`/`h`   — normalized size (0..1 of the parent); 0 = auto-size (text).
 *   - `anchorX`/`anchorY` — the corner of the parent the widget pins to, as a
 *     0..1 fraction (0 = left/top edge, 0.5 = center, 1 = right/bottom). The
 *     widget's own matching edge sits at that parent fraction, offset by x/y.
 *     So `leftFrac = anchorX + x`, `topFrac = anchorY + y` (a widget with the
 *     default anchor 0,0 positions at the absolute normalized x/y — the legacy
 *     HUD behavior). Anchors are CORNERS, not Unity stretch layouts — that
 *     (full-stretch anchors) is a documented follow-on.
 */

/** The widget types a canvas can hold (one per child entity). */
export const UI_WIDGET_TYPES = ['text', 'image', 'bar', 'shape', 'panel']

/** The canvas render modes. */
export const UI_RENDER_MODES = ['screen', 'world']

/**
 * The 9-way screen-space anchor names for a widget `rect.anchor`. When
 * `anchor` is set, the widget pins to that named region of its parent (the
 * VIEWPORT for a screen-mode canvas — the canvas covers the screen; the canvas
 * surface rect for a world-mode canvas) and `marginX`/`marginY` (parent units:
 * px on a screen canvas) push it in from the anchored edge(s). Corner anchors
 * apply both margins; side anchors center the cross axis; `center` centers
 * both. `x`/`y` remain a fine-tune normalized offset from the anchored
 * position. The default anchor 'top-left' with 0 margins is pixel-identical to
 * the legacy corner-anchor math.
 */
export const UI_RECT_ANCHORS = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]

/** Unknown `anchor` strings fail LOUD but only once per value per session
 * (resolveAnchorRect runs per widget per frame — a named console.error every
 * frame would flood the log). The widget still renders, visibly at top-left. */
const _badAnchorsReported = new Set()

/**
 * Defaults for one widget component of a given type. Returns null for an
 * unknown type.
 * @param {string} type  'text' | 'image' | 'bar' | 'shape' | 'panel'
 * @returns {object|null}
 */
export function uiWidgetDefaults(type) {
  switch (type) {
    case 'text':
      return {
        string: 'Text', color: '#ffffff', size: 20,
        font: 'system-ui, sans-serif', weight: 'normal', align: 'left',
        lineHeight: 1.2, wrap: false, maxWidth: 0,
      }
    case 'image':
      return { src: '', fit: 'stretch' }
    case 'bar':
      return {
        value: 0.5, color: '#4caf50', backColor: 'rgba(0,0,0,0.5)',
        borderColor: 'rgba(255,255,255,0.25)', borderWidth: 0, cornerRadius: 3,
      }
    case 'image':
      return { src: '', fit: 'stretch', interactive: false }
    case 'shape':
      return { color: '#4caf50', borderColor: 'rgba(255,255,255,0.25)', borderWidth: 0, cornerRadius: 0, interactive: false }
    case 'panel':
      return {
        backColor: 'rgba(20,22,28,0.55)', borderColor: 'rgba(255,255,255,0.18)',
        borderWidth: 1, cornerRadius: 6, interactive: false,
      }
    default:
      return null
  }
}

/** Default `rect` component values. The default `anchor: 'top-left'` with 0
 * margins is pixel-identical to the legacy corner-anchor (anchorX/anchorY 0,0)
 * behavior. */
export function rectDefaults() {
  return { x: 0, y: 0, w: 0.25, h: 0.12, anchorX: 0, anchorY: 0, anchor: 'top-left', marginX: 0, marginY: 0 }
}

/** Default `canvas` component values. */
export function canvasDefaults() {
  return { renderMode: 'screen', resolution: [512, 512], width: 8, height: 4.5 }
}

/**
 * Resolve a widget `rect` against a parent size (the canvas or a panel) into
 * pixel (or world-unit) layout. Pure math.
 *
 * TWO modes:
 *  - NINE-WAY (`rect.anchor` is a string, one of UI_RECT_ANCHORS): the widget
 *    pins to that named region of the parent; `marginX`/`marginY` are parent-
 *    unit insets from the anchored edge(s) (px on a screen canvas). Corner
 *    anchors apply both margins; side anchors center the cross axis; 'center'
 *    centers both. `x`/`y` remain a normalized fine-tune offset from the
 *    anchored position. An UNKNOWN anchor string fails loud: a named
 *    console.error (once per value) and a visible fallback to 'top-left'.
 *  - LEGACY corner-anchor (no `anchor` string): `anchorX`/`anchorY` 0..1 pick
 *    the pinned corner; top-left sits at parent fraction `(anchorX+x, anchorY+y)`.
 *
 * @param {object} rect      { x, y, w, h, anchorX?, anchorY?, anchor?, marginX?, marginY? }
 * @param {number} parentW   parent width  (px or world units)
 * @param {number} parentH   parent height (px or world units)
 * @returns {{left:number, top:number, width:number, height:number}} layout in parent units.
 */
export function resolveAnchorRect(rect, parentW, parentH) {
  const r = rect || {}
  const x = num(r.x)
  const y = num(r.y)
  const w = Math.max(0, num(r.w))
  const h = Math.max(0, num(r.h))
  const width = w * parentW
  const height = h * parentH
  if (typeof r.anchor === 'string') {
    let anchor = r.anchor
    if (!UI_RECT_ANCHORS.includes(anchor)) {
      if (!_badAnchorsReported.has(anchor)) {
        _badAnchorsReported.add(anchor)
        console.error(
          `[hermesforge:ui] rect.anchor "${anchor}" is not one of ${UI_RECT_ANCHORS.join('|')} — ` +
          "falling back to 'top-left' (the widget still renders, at its top-left-anchored position)",
        )
      }
      anchor = 'top-left'
    }
    const parts = anchor.split('-')
    const ayName = parts[0]                 // 'top' | 'center' | 'bottom'
    const axName = parts[1] || 'center'     // 'left' | 'center' | 'right'  ('center' has no second part)
    const mx = Math.max(0, num(r.marginX))
    const my = Math.max(0, num(r.marginY))
    const left = axName === 'left'
      ? mx + x * parentW
      : axName === 'right'
        ? parentW - width - mx - x * parentW
        : (parentW - width) / 2 + x * parentW
    const top = ayName === 'top'
      ? my + y * parentH
      : ayName === 'bottom'
        ? parentH - height - my - y * parentH
        : (parentH - height) / 2 + y * parentH
    return { left, top, width, height }
  }
  const anchorX = clamp01(r.anchorX ?? 0)
  const anchorY = clamp01(r.anchorY ?? 0)
  return {
    left: (anchorX + x) * parentW,
    top: (anchorY + y) * parentH,
    width,
    height,
  }
}

/**
 * Map a widget `rect` to a WORLD-space rect on a canvas plane centered at
 * `canvas.position`, sized `canvas.width` x `canvas.height` (world units, +Y
 * up). Returns the widget's center offset + size in world units, so a caller
 * can position a quad/texture region. Pure math.
 * @param {object} rect     { x, y, w, h, anchorX?, anchorY?, anchor?, marginX?, marginY? }
 * @param {object} canvas   { width, height, x?, y?, z? } canvas plane size + center position
 * @returns {{x:number, y:number, z:number, width:number, height:number}} world-space center + size.
 */
export function rectToWorld(rect, canvas) {
  const r = rect || {}
  const W = num(canvas && canvas.width) || 1
  const H = num(canvas && canvas.height) || 1
  // Delegates to resolveAnchorRect so the 9-way screen-space anchors + margins
  // resolve identically on the world-canvas path (against the canvas surface
  // rect; margins are in canvas world units there).
  const res = resolveAnchorRect(r, W, H)
  // Screen-style normalized fraction of the widget's center (0..1, 0=left/top).
  const centerXFrac = (res.left + res.width / 2) / W
  const centerYFrac = (res.top + res.height / 2) / H
  // Convert to world offsets from the plane center (plane center is at 0.5,0.5).
  // World Y is UP, so screen-top (frac 0) is +Y (top edge of the plane).
  return {
    x: (num(canvas && canvas.x) || 0) + (centerXFrac - 0.5) * W,
    y: (num(canvas && canvas.y) || 0) + (0.5 - centerYFrac) * H,
    z: num(canvas && canvas.z) || 0,
    width: res.width,
    height: res.height,
  }
}

/**
 * Validate a `canvas` component. Returns [] when valid (or when undefined).
 * @param {object|undefined} canvas
 * @returns {Array<string>}
 */
export function validateCanvas(canvas) {
  const errors = []
  if (canvas === undefined) return errors
  if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas)) {
    errors.push('canvas must be an object')
    return errors
  }
  if (canvas.renderMode !== undefined && !UI_RENDER_MODES.includes(canvas.renderMode)) {
    errors.push(`canvas.renderMode must be one of ${UI_RENDER_MODES.join('|')}`)
  }
  if (canvas.resolution !== undefined) {
    const res = canvas.resolution
    if (Array.isArray(res)) {
      if (res.length !== 2 || res.some((v) => typeof v !== 'number' || !(v > 0))) {
        errors.push('canvas.resolution must be [width, height] of positive numbers')
      }
    } else if (typeof res === 'number' && !(res > 0)) {
      errors.push('canvas.resolution must be a positive number or [w, h]')
    }
  }
  for (const f of ['width', 'height']) {
    if (canvas[f] !== undefined && (typeof canvas[f] !== 'number' || !(canvas[f] > 0))) {
      errors.push(`canvas.${f} must be a positive number`)
    }
  }
  return errors
}

/**
 * Validate a widget component for a known widget type. Returns [] when valid
 * (or undefined). Checks only the type-specific fields.
 * @param {string} type   one of UI_WIDGET_TYPES
 * @param {object|undefined} comp
 * @returns {Array<string>}
 */
export function validateWidget(type, comp) {
  const errors = []
  if (!UI_WIDGET_TYPES.includes(type)) {
    errors.push(`widget type must be one of ${UI_WIDGET_TYPES.join('|')}`)
    return errors
  }
  if (comp === undefined) return errors
  if (!comp || typeof comp !== 'object' || Array.isArray(comp)) {
    errors.push(`${type} widget must be an object`)
    return errors
  }
  if (type === 'bar' && comp.value !== undefined) {
    const v = comp.value
    if (typeof v !== 'number' || v < 0 || v > 1) errors.push('bar.value must be a number in 0..1')
  }
  if (type === 'image') {
    if (comp.src !== undefined && typeof comp.src !== 'string') errors.push('image.src must be a string')
    if (comp.fit !== undefined && !['stretch', 'contain', 'cover'].includes(comp.fit)) {
      errors.push('image.fit must be stretch|contain|cover')
    }
  }
  // WAVE-3 widget interaction seam: `interactive` is declared data on the
  // clickable widget types (panel/shape/image). text is intentionally NOT
  // interactive — labels sit OVER interactive panels and must stay
  // pointer-transparent so the click reaches the panel beneath.
  if (['panel', 'shape', 'image'].includes(type)) {
    if (comp.interactive !== undefined && typeof comp.interactive !== 'boolean') {
      errors.push(`${type}.interactive must be a boolean`)
    }
  }
  if (type === 'text') {
    if (comp.font !== undefined && typeof comp.font !== 'string') errors.push('text.font must be a string')
    if (comp.weight !== undefined && typeof comp.weight !== 'string') errors.push('text.weight must be a string')
    if (comp.align !== undefined && !['left', 'center', 'right'].includes(comp.align)) {
      errors.push('text.align must be left|center|right')
    }
    if (comp.lineHeight !== undefined && (typeof comp.lineHeight !== 'number' || comp.lineHeight <= 0)) {
      errors.push('text.lineHeight must be a positive number')
    }
    if (comp.wrap !== undefined && typeof comp.wrap !== 'boolean') errors.push('text.wrap must be a boolean')
    if (comp.maxWidth !== undefined && (typeof comp.maxWidth !== 'number' || comp.maxWidth < 0 || comp.maxWidth > 1)) {
      errors.push('text.maxWidth must be a number in 0..1')
    }
  }
  // Paint-parity fields (WS3-Pro): string color fields + non-negative numbers
  // on bar/shape/panel. `backColor` applies to bar/panel only.
  if (type === 'bar' || type === 'shape' || type === 'panel') {
    for (const f of (type === 'shape' ? ['borderColor'] : ['borderColor', 'backColor'])) {
      if (comp[f] !== undefined && typeof comp[f] !== 'string') errors.push(`${type}.${f} must be a string`)
    }
    for (const f of ['borderWidth', 'cornerRadius']) {
      if (comp[f] !== undefined && (typeof comp[f] !== 'number' || comp[f] < 0)) errors.push(`${type}.${f} must be a non-negative number`)
    }
  }
  return errors
}

/**
 * Validate a `rect` component. Returns [] when valid (or when undefined).
 * @param {object|undefined} rect
 * @returns {Array<string>}
 */
export function validateRect(rect) {
  const errors = []
  if (rect === undefined) return errors
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) {
    errors.push('rect must be an object')
    return errors
  }
  for (const f of ['x', 'y', 'w', 'h']) {
    if (rect[f] !== undefined && typeof rect[f] !== 'number') errors.push(`rect.${f} must be a number`)
  }
  for (const f of ['anchorX', 'anchorY']) {
    if (rect[f] !== undefined) {
      const v = rect[f]
      if (typeof v !== 'number' || v < 0 || v > 1) errors.push(`rect.${f} must be a number in 0..1`)
    }
  }
  if (rect.anchor !== undefined && (typeof rect.anchor !== 'string' || !UI_RECT_ANCHORS.includes(rect.anchor))) {
    errors.push(`rect.anchor must be one of ${UI_RECT_ANCHORS.join('|')}`)
  }
  for (const f of ['marginX', 'marginY']) {
    if (rect[f] !== undefined && (typeof rect[f] !== 'number' || rect[f] < 0)) {
      errors.push(`rect.${f} must be a non-negative number`)
    }
  }
  return errors
}

/* ── helpers ────────────────────────────────────────────────────────────── */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

/**
 * Compose a canvas `ctx.font` string from a text widget's data (pure). The
 * weight is omitted when 'normal' (the canvas default), so legacy data with no
 * new fields renders byte-identical to the old `${fontPx}px system-ui…`.
 * @param {object} data  a text widget component ({ weight?, font? }).
 * @param {number} fontPx  the resolved pixel size.
 * @returns {string}
 */
export function composeFontString(data, fontPx) {
  const d = data || {}
  const weight = typeof d.weight === 'string' && d.weight.trim() && d.weight !== 'normal' ? `${d.weight.trim()} ` : ''
  const font = typeof d.font === 'string' && d.font.trim() ? d.font.trim() : 'system-ui, sans-serif'
  return `${weight}${fontPx}px ${font}`
}

/**
 * Word-wrap a text string into lines no wider than `maxPx` (pure; the width
 * measure is injected so it is testable under Node). Used by the world-canvas
 * paint path; the DOM overlay wraps natively via CSS.
 * @param {string} text
 * @param {(s: string) => number} measure  width of a string in px.
 * @param {number} maxPx  wrap width in px (<= 0 → no wrap, single line).
 * @returns {string[]}
 */
export function wrapTextLines(text, measure, maxPx) {
  const str = String(text ?? '')
  if (!(maxPx > 0)) return str.split('\n')
  const out = []
  for (const paragraph of str.split('\n')) {
    const words = paragraph.split(' ')
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (line && measure(candidate) > maxPx) {
        out.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    out.push(line)
  }
  return out
}

/**
 * Paint a (possibly rounded, optionally bordered) rect onto a 2D context —
 * the SHARED paint primitive for bar/shape/panel on the world-canvas path
 * (the DOM overlay maps the same data to CSS). Pure DOM-canvas; try/catch at
 * the call site keeps a paint failure from taking down the frame.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x  left, px
 * @param {number} y  top, px
 * @param {number} w  width, px
 * @param {number} h  height, px
 * @param {object} style  { fill, borderColor?, borderWidth?, cornerRadius? }
 *   cornerRadius is in REFERENCE px (authored against a 512-height content
 *   resolution); `refScale` converts reference px → content px.
 */
export function paintStyledRect(ctx, x, y, w, h, style) {
  const s = style || {}
  const radius = Math.max(0, Math.min(Number(s.cornerRadius) || 0, w / 2, h / 2))
  ctx.beginPath()
  if (radius > 0) {
    // Rounded-rect path (manual arcTo — no ctx.roundRect dependency).
    ctx.moveTo(x + radius, y)
    ctx.arcTo(x + w, y, x + w, y + h, radius)
    ctx.arcTo(x + w, y + h, x, y + h, radius)
    ctx.arcTo(x, y + h, x, y, radius)
    ctx.arcTo(x, y, x + w, y, radius)
    ctx.closePath()
  } else {
    ctx.rect(x, y, w, h)
  }
  if (s.fill) {
    ctx.fillStyle = s.fill
    ctx.fill()
  }
  const bw = Math.max(0, Number(s.borderWidth) || 0) * (s.refScale || 1)
  if (bw > 0 && s.borderColor) {
    ctx.strokeStyle = s.borderColor
    ctx.lineWidth = Math.max(1, bw)
    ctx.stroke()
  }
}

/**
 * Pure UI animation tween math. A game animates a widget live by driving a
 * value from `from` to `to` over `t` (0..1) with an easing, then writing it via
 * `api.hud.set(id, { ... })`.
 */

/** Easing functions keyed by name. Each maps normalized progress t (0..1) -> eased 0..1. */
export const UI_EASINGS = {
  linear: (t) => t,
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
  easeIn: (t) => t * t * t,
  easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
}

/** Normalize a `t` (0..1) and an easing name -> an eased 0..1 progress. Unknown
 * easing names fall back to linear (lenient, never throws). */
export function uiEase(t, easing) {
  const e = (UI_EASINGS[easing] || UI_EASINGS.linear)(typeof t === 'number' ? t : 0)
  return Math.max(0, Math.min(1, e))
}

/** Linearly interpolate a number from a to b by normalized progress t (0..1). */
export function uiLerp(a, b, t) {
  return a + (b - a) * (typeof t === 'number' ? t : 0)
}

/**
 * Evaluate a tween: interpolate `from` -> `to` by eased progress `t` (0..1).
 * @param {number} from
 * @param {number} to
 * @param {number} t        normalized 0..1 progress
 * @param {string} [easing] one of UI_EASINGS keys (default 'linear')
 */
export function uiTween(from, to, t, easing) {
  return uiLerp(from, to, uiEase(t, easing))
}
