/**
 * Engine — terrain render mesh (browser; imports three).
 *
 * Builds a THREE.Mesh from a `terrain` component's heightfield: a plane grid in
 * the XZ plane whose vertex Y values come from the heightfield (centered on the
 * entity's transform). The engine Renderer registers this mesh as the terrain
 * entity's model so it renders like any model and provides the same mesh path
 * for the real-mesh collider.
 *
 * Pure heightfield math (sampling, triangles, validation) lives in
 * `terrain-math.js` (Node-testable); this module is only the three-object build.
 */
import * as THREE from 'three'
import { terrainVertexCount } from './terrain-math.js'

/**
 * Build a THREE.PlaneGeometry displaced by the terrain's heights, rotated into
 * the XZ plane (+Y up) and centered on the origin. Vertex Y comes from the
 * grid, so the surface matches `buildTerrainTriangles`/`sampleTerrainHeight`.
 * @param {object} terrain  a normalized terrain component.
 * @returns {THREE.PlaneGeometry}
 */
export function buildTerrainGeometry(terrain) {
  const { size, segments, heights } = terrain
  const n = terrainVertexCount(segments)
  const geo = new THREE.PlaneGeometry(size, size, segments, segments)
  geo.rotateX(-Math.PI / 2) // XY -> XZ plane, +Y up
  const pos = geo.attributes.position
  // PlaneGeometry's post-rotation local X maps to world X; local Y maps to
  // world MINUS Z (rotateX(-PI/2) sends +Y -> -Z), and uv.v runs opposite the
  // grid's +Z rows: v=1 sits at world z=-size/2 = physics grid row 0. The row
  // must therefore be (1-v)*segments — using v*segments put heights rows on the
  // wrong (z-mirrored) side, rendering the terrain as the Z-MIRROR of the
  // physics grid (sampleTerrainHeight/buildTerrainTriangles) and making the
  // correctly-baked navmesh drape look z-flipped against it.
  for (let i = 0; i < pos.count; i++) {
    // Normalized grid coords from the (post-rotation) plane UV of each vertex.
    // PlaneGeometry's own UV attribute maps 0..1 across the plane; derive the
    // row/col from u/v so the displaced height aligns with the physics grid.
    const u = geo.attributes.uv.getX(i)
    const v = geo.attributes.uv.getY(i)
    const c = Math.round(u * (segments)) // column (X index)
    const r = Math.round((1 - v) * (segments)) // row (Z index)
    pos.setY(i, heights[r * n + c] ?? 0)
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}

/**
 * Build a terrain THREE.Mesh (geometry + material).
 * @param {object} terrain  a normalized terrain component.
 * @param {THREE.Material} [material]  optional material; default a flat-green standard material.
 * @returns {THREE.Mesh}
 */
export function buildTerrainMesh(terrain, material) {
  const geo = buildTerrainGeometry(terrain)
  const mat = material || new THREE.MeshStandardMaterial({ color: 0x4a7a3a, roughness: 0.9, side: THREE.DoubleSide })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = false
  mesh.receiveShadow = true
  return mesh
}
