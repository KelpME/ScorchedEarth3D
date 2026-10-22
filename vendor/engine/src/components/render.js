/**
 * Engine built-in component: `render`.
 *
 * What the object looks like: mesh, material, visibility. Consumed by the
 * engine Renderer (batches boxes). Scale is NOT here — it lives on `transform`
 * (the single TRS owner); the renderer reads `transform.scale`.
 */
export const name = 'render'

export const label = 'Renderer'

export const description = 'What the object looks like: mesh, material, visibility, shadows.'

export const params = {
  mesh: { type: 'string', default: 'box' },
  material: { type: 'string', default: '' },
  visible: { type: 'boolean', default: true },
  // Per-entity shadow control (default ON, matching the engine's historic
  // behavior). castShadow=false keeps this object OUT of lights' shadow maps
  // (it casts no shadow); receiveShadow=false stops it displaying shadows cast
  // onto it. For batched content these fold into the batch identity so
  // identical flags still batch together (see render/batching.js).
  castShadow: { type: 'boolean', default: true },
  receiveShadow: { type: 'boolean', default: true },
  // Optional per-entity material override: { color?, roughness?, metalness?,
  // emissive? } applied on top of the named material. Identical params share a
  // batch; different params separate it. Instanced tint remains the cheap
  // per-entity case.
  materialParams: { type: 'object', default: undefined },
}

export default { name, label, description, params }
