/**
 * Engine built-in component: `transform`.
 *
 * Local position / rotation / scale of an object (full TRS). Every entity has
 * one; it is excluded from the Add-Component list because it is always present.
 *
 * Position is schema-declared (x/y/z). Rotation is read from `rot` ({x,y,z}
 * radians), legacy `rotation` ({x,y,z}), or legacy `yaw` (number, about Y).
 * Scale is read from `scale` — an array [sx,sy,sz] or object {x,y,z}; a bare
 * number is uniform. Scale lives HERE (not on `render`) so there is exactly one
 * scale, and it composes through the hierarchy like Unity/Godot/Unreal.
 */
export const name = 'transform'

export const label = 'Transform'

export const description = 'Local position / rotation / scale of the object.'

export const params = {
  x: { type: 'number', default: 0 },
  y: { type: 'number', default: 0 },
  z: { type: 'number', default: 0 },
}

export default { name, label, description, params }
