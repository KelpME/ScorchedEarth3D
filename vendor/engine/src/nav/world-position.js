/**
 * THE parent-chain world-position resolver (extracted Phase P2.5 W5).
 *
 * world = local + parent.world, recursively. This ONE helper replaces the
 * private copies that nav/nav.js, physics/system.js and nav/agent-core.js each
 * carried (the "don't third-duplicate the worldPositionOf pattern" rule) —
 * all call sites re-pointed here. Defensively handles cycles + dangling
 * parents (resolves to local). Pure; no DOM / no Three import.
 *
 * @param {{ entity: (id: string) => object|null, getParent?: (id: string) => any }} seam
 *   `entity` resolves a record (`rec.components.transform`, `rec.parent`);
 *   an optional `getParent` wins over `rec.parent` (the world seam). A seam
 *   without `entity` resolves to the origin.
 * @returns {{ x: number, y: number, z: number }}
 */
export function worldPositionOf(seam, id) {
  if (!seam || typeof seam.entity !== 'function') return { x: 0, y: 0, z: 0 }
  let x = 0, y = 0, z = 0
  let cur = id
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    // NOTE: called as METHODS (seam.entity(cur)) — `entity`/`getParent` are
    // instance methods (ecs World); detaching them loses `this`.
    const rec = seam.entity(cur)
    const t = rec && rec.components && rec.components.transform
    x += t && Number.isFinite(t.x) ? t.x : 0
    y += t && Number.isFinite(t.y) ? t.y : 0
    z += t && Number.isFinite(t.z) ? t.z : 0
    const parent = typeof seam.getParent === 'function' ? seam.getParent(cur) : rec && rec.parent
    if (parent === undefined || parent === null || parent === '' || parent === cur) break
    cur = parent
  }
  return { x, y, z }
}
