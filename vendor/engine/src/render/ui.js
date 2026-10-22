/**
 * Engine — UI overlay DOM builder (browser, screen mode).
 *
 * Renders a canvas entity's widget tree (text / image / bar / shape / panel)
 * as a DOM layer positioned over the canvas. NO three import — pure DOM. The
 * Renderer resolves each widget's ABSOLUTE pixel rect (recursively through the
 * canvas + panels, see the engine `_resolveUiWidgets`) and calls this module
 * with a flat list of render descriptors `{ id, type, rect:{left,top,width,height},
 * data }. Widgets are reconciled by `data-ui-id` and only written when they
 * change; stale nodes are removed, so a live component edit reconciles without
 * flicker. pointer-events:none so the overlay never swallows input — EXCEPT
 * per-widget for INTERACTIVE widgets (WAVE-3 widget interaction seam): a widget
 * whose component declares `interactive: true` (panel / shape / image) gets
 * `pointer-events:auto` on ITS node only (the host layer stays none), and its
 * click dispatches to the entity's attached scripts via the generic
 * `onPointerClick` script hook (ScriptRegistry.pointerClick, exposed through
 * `api.scripts.pointerClick(id)`). An interactive widget with NO script
 * attached (or no scripts api wired) fails LOUD — never a dead element.
 */

/**
 * Create (or return the existing) UI overlay host inside `container`.
 * @param {HTMLElement} container  the element that hosts the canvas.
 * @returns {HTMLElement|null}  the overlay host, or null if no container.
 */
export function createUiOverlay(container) {
  if (!container || typeof document === 'undefined') return null
  let host = container.querySelector(':scope > .hf-ui-overlay')
  if (host) return host
  host = document.createElement('div')
  host.className = 'hf-ui-overlay'
  host.style.cssText =
    'position:absolute; inset:0; overflow:hidden; pointer-events:none; ' +
    'z-index:3; font-family:system-ui,-apple-system,sans-serif;'
  container.appendChild(host)
  return host
}

/**
 * Reconcile the overlay to match `widgets`. Reuses nodes by id, writes changed
 * ones, removes stale ones. Called by the Renderer each frame (cheap — few
 * widgets, diffed) and on size changes.
 * @param {HTMLElement} host  the overlay host (from createUiOverlay).
 * @param {Array<object>} widgets  flat render descriptors { id, type, rect, data }.
 * @returns {number}  number of visible widget nodes.
 */
export function renderUiElements(host, widgets, api) {
  if (!host) return 0
  const existing = new Map()
  for (const child of Array.from(host.children)) {
    if (child.dataset && child.dataset.uiId) existing.set(child.dataset.uiId, child)
  }
  const seen = new Set()
  for (const w of widgets) {
    if (!w || !w.id) continue
    const key = w.id
    seen.add(key)
    let node = existing.get(key)
    if (!node) {
      node = document.createElement('div')
      node.dataset.uiId = key
      host.appendChild(node)
    }
    applyWidget(node, w)
    // WAVE-3 interaction seam: ONLY interactive widgets open pointer-events
    // (the node itself; the host layer + every other widget stay none, so a
    // non-interactive widget is pointer-transparent and clicks fall through
    // to the canvas / elements beneath). The click dispatches to the entity's
    // attached scripts' onPointerClick hook — behavior lives on the SCRIPTS,
    // visible in the editor hierarchy + inspector.
    const interactive = !!(w.data && w.data.interactive)
    node.style.pointerEvents = interactive ? 'auto' : ''
    node.style.cursor = interactive ? 'pointer' : ''
    if (interactive && !node.dataset.hfUiInteractive) {
      node.dataset.hfUiInteractive = '1'
      node.addEventListener('click', (ev) => {
        ev.stopPropagation()
        dispatchUiWidgetClick(api, node.dataset.uiId)
      })
    }
  }
  for (const [key, child] of existing) {
    if (!seen.has(key)) child.remove()
  }
  return host.children.length
}

/**
 * Remove the UI overlay host from the DOM entirely (e.g. no canvas entities).
 * @param {HTMLElement} host
 */
export function destroyUiOverlay(host) {
  if (host && host.parentElement) host.parentElement.removeChild(host)
}

/**
 * WAVE-3 — dispatch a click on an interactive widget to its entity's scripts
 * (the generic `onPointerClick` script hook). FAIL-NOISY: no scripts api
 * wired, or no script attached to the widget entity, is a named console.error
 * — an interactive widget with no behavior is never a silent dead element.
 * @param {object|null} api  the game facade (renderer passes it into renderUiElements).
 * @param {string} id  the widget's entity id (data-ui-id).
 */
export function dispatchUiWidgetClick(api, id) {
  if (!api || typeof api.scripts?.pointerClick !== 'function') {
    console.error(`[ui] interactive widget "${id}" was clicked but no scripts api is wired (api.scripts.pointerClick missing) — cannot dispatch onPointerClick`)
    return
  }
  try {
    api.scripts.pointerClick(id)
  } catch (err) {
    console.error(`[ui] interactive widget "${id}" pointer-click dispatch failed: ${err}`)
  }
}

/** Apply one widget to a positioned node. Pure DOM writes; never throws. */
function applyWidget(node, w) {
  try {
    const r = w.rect || {}
    node.style.position = 'absolute'
    node.style.left = `${Math.round(r.left ?? 0)}px`
    node.style.top = `${Math.round(r.top ?? 0)}px`
    node.style.boxSizing = 'border-box'
    const data = w.data || {}
    switch (w.type) {
      case 'text': {
        node.textContent = data.string ?? ''
        node.style.color = data.color || '#ffffff'
        node.style.fontSize = `${data.size ?? 20}px`
        node.style.fontFamily = typeof data.font === 'string' && data.font.trim() ? data.font : 'system-ui, sans-serif'
        node.style.fontWeight = typeof data.weight === 'string' && data.weight.trim() ? data.weight : 'normal'
        const align = ['left', 'center', 'right'].includes(data.align) ? data.align : 'left'
        node.style.textAlign = align
        const lh = typeof data.lineHeight === 'number' && data.lineHeight > 0 ? data.lineHeight : 1.2
        node.style.lineHeight = String(lh)
        if (data.wrap) {
          // Wrap width: an explicit maxWidth (0..1 of the overlay host) or the
          // widget's own rect width — mirroring the world-canvas paint.
          const hostW = node.parentElement ? node.parentElement.clientWidth : 0
          const maxPx = (typeof data.maxWidth === 'number' && data.maxWidth > 0)
            ? data.maxWidth * hostW
            : (r.width ?? 0)
          node.style.maxWidth = `${Math.round(maxPx)}px`
          node.style.whiteSpace = 'pre-wrap'
          node.style.wordBreak = 'break-word'
        } else {
          node.style.maxWidth = ''
          // PARITY with the world-canvas paint: the canvas painter splits the
          // string on '\n' (wrapTextLines), so the DOM must honor newlines
          // too — 'normal' collapses them (the lineHeight live-edit bug
          // report's root visual mismatch). 'pre' preserves '\n' without
          // wrapping; 'pre-wrap' preserves '\n' AND wraps at maxWidth.
          node.style.whiteSpace = 'pre'
        }
        node.style.width = 'auto'
        node.style.height = 'auto'
        node.style.background = 'none'
        node.style.padding = '0'
        break
      }
      case 'bar': {
        const width = Math.round(r.width ?? 0)
        const height = Math.round(r.height ?? 14)
        node.textContent = ''
        node.style.width = `${width}px`
        node.style.height = `${height}px`
        node.style.background = data.backColor || 'rgba(0,0,0,0.5)'
        node.style.borderRadius = `${Math.max(0, Number(data.cornerRadius) || 0)}px`
        node.style.border = (Number(data.borderWidth) > 0 && data.borderColor)
          ? `${Number(data.borderWidth)}px solid ${data.borderColor}`
          : 'none'
        node.style.overflow = 'hidden'
        node.style.whiteSpace = 'normal'
        let fill = node.querySelector(':scope > .hf-ui-fill')
        if (!fill) {
          fill = document.createElement('div')
          fill.className = 'hf-ui-fill'
          node.appendChild(fill)
        }
        const v = Math.max(0, Math.min(1, Number(data.value) || 0))
        fill.style.width = `${Math.round(v * 100)}%`
        fill.style.height = '100%'
        fill.style.background = data.color || '#4caf50'
        break
      }
      case 'shape': {
        node.textContent = ''
        node.style.width = `${Math.round(r.width ?? 0)}px`
        node.style.height = `${Math.round(r.height ?? 0)}px`
        node.style.background = data.color || '#4caf50'
        node.style.borderRadius = `${Math.max(0, Number(data.cornerRadius) || 0)}px`
        node.style.border = (Number(data.borderWidth) > 0 && data.borderColor)
          ? `${Number(data.borderWidth)}px solid ${data.borderColor}`
          : 'none'
        break
      }
      case 'panel': {
        node.textContent = ''
        node.style.width = `${Math.round(r.width ?? 0)}px`
        node.style.height = `${Math.round(r.height ?? 0)}px`
        node.style.background = data.backColor || 'rgba(20,22,28,0.55)'
        node.style.borderRadius = `${Math.max(0, Number(data.cornerRadius) || 0)}px`
        node.style.border = (Number(data.borderWidth) > 0 && data.borderColor)
          ? `${Number(data.borderWidth)}px solid ${data.borderColor}`
          : 'none'
        break
      }
      case 'image': {
        node.textContent = ''
        node.style.width = `${Math.round(r.width ?? 0)}px`
        node.style.height = `${Math.round(r.height ?? 0)}px`
        const fit = ['contain', 'cover'].includes(data.fit) ? data.fit : 'stretch'
        node.style.backgroundSize = fit === 'stretch' ? '100% 100%' : fit
        node.style.backgroundRepeat = 'no-repeat'
        node.style.backgroundImage = data.src ? `url("${data.src}")` : 'none'
        node.style.backgroundPosition = 'center'
        break
      }
      default: {
        // Unknown type: leave the node empty.
        node.textContent = ''
      }
    }
  } catch (err) {
    /* UI rendering must never take down a scene frame. */
  }
}
