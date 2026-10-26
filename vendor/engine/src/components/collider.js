/**
 * Engine built-in component: `collider`.
 *
 * The physical shape an entity collides with. Carries a `shape` field —
 * box (half-extents hx/hy/hz), sphere (radius), cylinder (radius + height,
 * collides as its bounding AABB), or pill (radius + height — a vertical
 * capsule). Paired with the `floor` tag it becomes a static body. Physics
 * (gravity/floor/raycast/overlap) honors the shape: a sphere or pill rests on
 * its radius, not a box half-extent.
 *
 * `center` is the shape's LOCAL offset from the entity's transform origin —
 * `[x, y, z]` — so a collider can be moved around on the object (e.g. a
 * capsule under a model's feet, or a trigger poking out of the front) without
 * moving the object itself. Default `[0, 0, 0]` keeps the shape centered on
 * the transform. Physics positions the shape at `transform + center`, and the
 * editor draws the debug wireframe at that offset too.
 *
 * `debugVisible` is the EDITOR-ONLY debug-wireframe visibility for this
 * collider (`true` by default). It has NO effect on physics — the shape still
 * collides either way. The editor composes it with the global collider-debug
 * overlay: a collider's box is drawn only when the global toggle is on AND
 * this flag is true. It is stored on the component so the per-object choice
 * persists with the scene.
 */
export const name = 'collider'

export const label = 'Collider'

export const description = 'Physical shape: box (half-extents), sphere (radius), cylinder or pill (radius + height), or any render primitive (cone/torus/torusKnot/icosahedron/dodecahedron/octahedron/tetrahedron/ring/circle/lathe — collides as its real render geometry). Floor tag = static body.'

export const params = {
  shape: { type: 'string', default: 'box' },
  center: { type: 'array', default: [0, 0, 0] },
  hx: { type: 'number', default: 0.5 },
  hy: { type: 'number', default: 0.5 },
  hz: { type: 'number', default: 0.5 },
  radius: { type: 'number', default: 0.5 },
  height: { type: 'number', default: 1 },
  debugVisible: { type: 'boolean', default: true },
  // P4a T1: physics layers. `layer` is this collider's layer name; `mask` is
  // the array of layer names it collides with. NO schema default — an absent
  // layer means 'default' and an absent mask means ALL layers (resolved at
  // step time), so scenes authored before P4a stay byte-identical.
  layer: { type: 'string' },
  mask: { type: 'array' },
}

export default { name, label, description, params }
