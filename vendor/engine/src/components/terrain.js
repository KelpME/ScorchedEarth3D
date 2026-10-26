/**
 * Engine built-in component: `terrain`.
 *
 * A data-driven heightfield. `{ size, segments, heights[] }`:
 *   - `size`      — the square width/depth of the terrain (default 10).
 *   - `segments`  — grid resolution per side (default 8); the grid has
 *                   `(segments+1)²` vertices.
 *   - `heights`   — row-major vertex heights over that grid (row 0 = the -size/2
 *                   Z edge, column 0 = the -size/2 X edge); missing -> 0.
 *
 * The engine Renderer builds a terrain mesh from the component (rendered as the
 * entity's model, replacing any render placeholder) and the physics real-mesh
 * collider uses the heightfield surface, so a `collider: { shape: 'render' }` +
 * `floor` tag makes the terrain WALKABLE (a body stands on the actual surface).
 * Pure heightfield math + validation live in `render/terrain-math.js`.
 */

export const name = 'terrain'

export const label = 'Terrain'

export const description =
  'A data-driven heightfield (size / segments / heights) rendered as a terrain mesh and walkable as a real-mesh collider.'

export const params = {
  size: { type: 'number', default: 10 },
  segments: { type: 'number', default: 8 },
  heights: { type: 'array', default: [] },
}

export default { name, label, description, params }
