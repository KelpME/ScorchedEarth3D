/**
 * Engine built-in component: `camera`.
 *
 * Camera placement (fov / near / far) for the viewport preview or as the focus
 * of a `camera-rig`. Consumed by the editor's camera preview.
 */

export const name = 'camera'

export const label = 'Camera'

export const description = 'Camera placement for a preview or the camera-rig focus (fov / near / far).'

export const params = {
  fov: { type: 'number', default: 60 },
  near: { type: 'number', default: 0.1 },
  far: { type: 'number', default: 1000 },
  preview: { type: 'boolean', default: false },
}

export default { name, label, description, params }
