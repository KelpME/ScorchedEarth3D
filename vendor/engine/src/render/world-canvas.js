/**
 * Engine — world-space UI canvas (browser; imports three).
 *
 * Renders a `renderMode: 'world'` canvas entity's widget tree as a textured
 * plane in the 3D scene. The widgets are painted onto an offscreen 2D canvas
 * (resolution-sized) which becomes a THREE.CanvasTexture on a PlaneGeometry
 * (a flat screen in the XY plane, facing +Z). The engine Renderer registers the
 * plane as the canvas entity's model, so the entity's `transform` positions and
 * orients it in the world.
 *
 * Widget layout math (rect → px in the resolution space) lives in the pure
 * `ui-schema.js`; this module is only the three-object build. `redraw(widgets)`
 * re-paints the SAME canvas/texture in place, so live widget edits update the
 * world surface without re-creating the mesh.
 */
import * as THREE from 'three'
import { composeFontString, wrapTextLines, paintStyledRect } from './ui-schema.js'

const DEFAULT_RES = [512, 512]

/**
 * Build a world-canvas plane mesh + an in-place `redraw(widgets)`.
 *
 * The plane is sized `width` × `height` (world units) and BOTTOM-LEFT anchored
 * at the entity's transform, extending +X (right) / +Y (up). Content is
 * authored in `resolution` px and scales to fit the world size — so a widget at
 * rect.x=0.1 sits 10% across the width regardless of resolution.
 * @param {Array<object>} widgets  flat render descriptors { id, type, rect:{left,top,width,height}, data }
 * @param {number[]} [resolution]  [w, h] px of the render target (default 512x512).
 * @param {number} [width]  world width in units (default 8).
 * @param {number} [height] world height in units (default 4.5, 16:9).
 * @returns {{ mesh: THREE.Mesh, redraw: (widgets)=>void, dispose: ()=>void }}
 */
export function buildWorldCanvasMesh(widgets, resolution, width = 8, height = 4.5, { resolveImage } = {}) {
  const [resW, resH] = Array.isArray(resolution) ? resolution : DEFAULT_RES
  const worldW = width
  const worldH = height

  const canvas = document.createElement('canvas')
  canvas.width = resW
  canvas.height = resH
  const ctx = canvas.getContext('2d')

  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const geo = new THREE.PlaneGeometry(worldW, worldH)
  // Bottom-left anchor: shift the plane so its bottom-left corner is at the
  // entity origin, extending +X/+Y (matching the authoring proxy convention).
  geo.translate(worldW / 2, worldH / 2, 0)
  const mesh = new THREE.Mesh(geo, material)
  mesh.name = 'hf-world-canvas'

  function redraw(widgetsList) {
    ctx.clearRect(0, 0, resW, resH)
    // Reference-px scale: corner radii + border widths are authored against a
    // 512-height content resolution (the default), so they scale consistently.
    const refScale = resH / 512
    for (const w of widgetsList || []) {
      if (!w || !w.rect) continue
      const r = w.rect
      // Rects are normalized (0..1 fractions of the canvas) — scale into px.
      const x = r.left * resW
      const y = r.top * resH
      const wpx = r.width * resW
      const hpx = r.height * resH
      const data = w.data || {}
      try {
        switch (w.type) {
          case 'text': {
            // Font scales with the content resolution (size is authored in the
            // reference space where the resolution default makes 20px ≈ 512px/25).
            const fontPx = Math.max(1, (data.size ?? 20) * (resH / 512))
            ctx.font = composeFontString(data, fontPx)
            ctx.fillStyle = data.color || '#ffffff'
            ctx.textBaseline = 'top'
            const align = ['left', 'center', 'right'].includes(data.align) ? data.align : 'left'
            ctx.textAlign = align
            const lh = typeof data.lineHeight === 'number' && data.lineHeight > 0 ? data.lineHeight : 1.2
            // Wrap width: an explicit maxWidth (0..1 fraction of the canvas) or,
            // when wrap is on without one, the widget's own rect width.
            let wrapPx = 0
            if (data.wrap) {
              wrapPx = (typeof data.maxWidth === 'number' && data.maxWidth > 0)
                ? data.maxWidth * resW
                : wpx
            }
            const lines = wrapTextLines(data.string ?? '', (s) => ctx.measureText(s).width, wrapPx)
            const x0 = align === 'center' ? x + wpx / 2 : align === 'right' ? x + wpx : x
            lines.forEach((line, i) => {
              ctx.fillText(line, x0, y + i * fontPx * lh)
            })
            break
          }
          case 'bar': {
            paintStyledRect(ctx, x, y, wpx, hpx, {
              fill: data.backColor || 'rgba(0,0,0,0.5)',
              borderColor: data.borderColor, borderWidth: data.borderWidth, cornerRadius: data.cornerRadius,
              refScale,
            })
            const v = Math.max(0, Math.min(1, Number(data.value) || 0))
            // The fill re-clips inside the rounded track: same corner style,
            // width scaled by the fill value.
            paintStyledRect(ctx, x, y, Math.max(0, wpx * v), hpx, {
              fill: data.color || '#4caf50', cornerRadius: data.cornerRadius, refScale,
            })
            break
          }
          case 'shape': {
            paintStyledRect(ctx, x, y, wpx, hpx, {
              fill: data.color || '#4caf50',
              borderColor: data.borderColor, borderWidth: data.borderWidth, cornerRadius: data.cornerRadius,
              refScale,
            })
            break
          }
          case 'panel': {
            paintStyledRect(ctx, x, y, wpx, hpx, {
              fill: data.backColor || 'rgba(20,22,28,0.55)',
              borderColor: data.borderColor, borderWidth: data.borderWidth, cornerRadius: data.cornerRadius,
              refScale,
            })
            break
          }
          case 'image': {
            if (data.src && typeof data.src === 'object' && data.src.drawImage) {
              ctx.drawImage(data.src, x, y, wpx, hpx)
            } else if (typeof data.src === 'string' && data.src && resolveImage) {
              // Logical manifest id (e.g. 'texture/farm'): resolve to a loaded
              // texture image and draw with the fit mode. Unresolved/never-loaded
              // ids paint nothing (lenient — never throws).
              const tex = resolveImage(data.src)
              const img = tex && (tex.image || (tex.isCanvasTexture ? tex.image : null))
              if (img && (img.width || img.videoWidth || img.naturalWidth)) {
                const iw = img.naturalWidth || img.videoWidth || img.width
                const ih = img.naturalHeight || img.videoHeight || img.height
                const fit = ['contain', 'cover'].includes(data.fit) ? data.fit : 'stretch'
                if (fit === 'stretch' || !iw || !ih) {
                  ctx.drawImage(img, x, y, wpx, hpx)
                } else {
                  // Letterbox math: scale to cover the box, crop the overflow
                  // (cover) or fit inside and center the rest (contain).
                  const scale = data.fit === 'cover'
                    ? Math.max(wpx / iw, hpx / ih)
                    : Math.min(wpx / iw, hpx / ih)
                  const dw = iw * scale
                  const dh = ih * scale
                  ctx.save()
                  ctx.beginPath()
                  ctx.rect(x, y, wpx, hpx)
                  ctx.clip()
                  ctx.drawImage(img, x + (wpx - dw) / 2, y + (hpx - dh) / 2, dw, dh)
                  ctx.restore()
                }
              }
            }
            break
          }
          default: break
        }
      } catch (err) {
        /* never take down the frame */
      }
    }
    texture.needsUpdate = true
  }
  redraw(widgets)

  function dispose() {
    geo.dispose()
    material.dispose()
    texture.dispose()
  }

  return { mesh, redraw, dispose }
}
