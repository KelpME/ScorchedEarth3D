// Pure, DOM/WebGL-free ground-placement math for the declared groundY feature.
// Reuses existing pure exports from ./physics.js (shapeFromCollider, shapeBottom,
// colliderCenter, readRotation). Testable headlessly with vitest (TDD).

import { shapeFromCollider, shapeBottom, colliderCenter, readRotation } from './physics.js'

/**
 * The local-Y offset of the entity's ground-contact point from its transform
 * origin, POSITIVE = above the origin, NEGATIVE = below.
 *
 * 1. Declared `placement.groundY` wins when present (finite number).
 * 2. Else, for a primitive `collider` (box/sphere/cylinder/pill), derive it from
 *    geometry: the collider's local `center` Y minus its downward extent from
 *    center (`shapeBottom`) — the shapeBottomY-family result in local terms, so a
 *    centered box self-grounds (returns -hy). Render-collider MODELS/trees have no
 *    local primitive geometry to derive from -> they must declare `placement.groundY`.
 * 3. Neither -> returns null (caller places the origin on the surface; old behavior).
 *
 * @param {object} components an entity's `components` bag.
 * @param {{ scale?: *, rotation?: object|null }} [ctx]
 * @returns {number|null}
 */
export function groundAnchorLocalY(components = {}, ctx = {}) {
  const p = components.placement
  if (p && typeof p.groundY === 'number' && Number.isFinite(p.groundY)) return p.groundY
  const c = components.collider
  if (!c) return null
  const t = components.transform || {}
  const shape = shapeFromCollider(c, {
    render: components.render,
    scale: ctx.scale !== undefined ? ctx.scale : t.scale,
    rotation: ctx.rotation !== undefined ? ctx.rotation : readRotation(t),
  })
  const cy = colliderCenter(c)[1]
  return cy - shapeBottom(shape)
}

/**
 * The local transform.y that makes an entity's ground anchor rest on a world
 * surface: parentWorldY + y + anchor === surfaceTopY, so
 * y = surfaceTopY - parentWorldY - anchor.
 * @param {{ anchor: number, surfaceTopY: number, parentWorldY?: number }} p
 * @returns {number}
 */
export function placeY(p) {
  const anchor = p.anchor
  if (anchor === null || anchor === undefined || !Number.isFinite(anchor)) {
    throw new TypeError('placeY: anchor must be a finite number (call groundAnchorLocalY; null -> place origin, do not call placeY)')
  }
  const surfaceTopY = Number(p.surfaceTopY ?? 0)
  const parentWorldY = Number(p.parentWorldY ?? 0)
  if (!Number.isFinite(surfaceTopY) || !Number.isFinite(parentWorldY)) {
    throw new TypeError('placeY: surfaceTopY and parentWorldY must be finite')
  }
  return surfaceTopY - parentWorldY - anchor
}

/**
 * Top-surface world Y of a world-POSITIONED collider shape at world (x, z), or
 * null when (x, z) is not over the shape (surface miss / unsupported kind).
 * Boxes are flat -> maxY across their footprint; spheres/pills -> the curved
 * top at that point; mesh/terrain shapes -> null (Phase A: pass explicit
 * surfaceY for meshes).
 * @param {object|null} shape a collider shape (box/sphere/pill).
 * @param {number} x
 * @param {number} z
 * @returns {number|null}
 */
export function shapeTopAtY(shape, x, z) {
  if (!shape) return null
  if (shape.kind === 'box') {
    const b = shape.box
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return null
    return b.maxY
  }
  if (shape.kind === 'sphere') {
    const s = shape.sphere
    const dx = x - s.x, dz = z - s.z
    const r2 = s.radius * s.radius
    const d2 = dx * dx + dz * dz
    if (d2 > r2) return null
    return s.y + Math.sqrt(r2 - d2)
  }
  if (shape.kind === 'pill') {
    const cp = shape.capsule
    const dx = x - cp.x, dz = z - cp.z
    const r2 = cp.radius * cp.radius
    const d2 = dx * dx + dz * dz
    if (d2 > r2) return null
    return cp.y + cp.radius + Math.sqrt(r2 - d2)
  }
  return null // mesh (terrain/model): Phase A surfaceY must be explicit
}
