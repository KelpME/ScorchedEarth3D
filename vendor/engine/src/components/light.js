/**
 * Engine built-in component: `light`.
 *
 * A light placed on a GAMEOBJECT (a scene entity) so it can be positioned with
 * the transform / gizmo like any other object. The renderer builds THREE lights
 * from every entity carrying a `light` component, positioned at the entity's
 * WORLD transform. Position is the transform — NOT stored here. Params are the
 * light's look + shadow behavior.
 *
 * Consumed by the engine Renderer (buildLights via the entity's light component
 * + transform). Editing these params in the inspector edits the light live.
 */

export const name = 'light'

export const label = 'Light'

export const description = 'A scene light on this gameobject (directional / point / spot / hemisphere / ambient). Position = the object\'s transform.'

export const params = {
  type: { type: 'string', default: 'point' },
  color: { type: 'string', default: '#ffffff' },
  intensity: { type: 'number', default: 1 },
  distance: { type: 'number', default: 0 },
  decay: { type: 'number', default: 2 },
  angle: { type: 'number', default: 0.5 },
  penumbra: { type: 'number', default: 0.2 },
  castShadow: { type: 'boolean', default: false },
  shadowMapSize: { type: 'number', default: 1024 },
  target: { type: 'array', default: [0, 0, 0] },
  // Direction a DIRECTIONAL light points (a unit-ish [x,y,z] vector). Absent on
  // spot (which aims at `target`) and on omni lights. Defaults to [0,0,-1]; the
  // renderer points the light along it (position + direction).
  direction: { type: 'array', default: [0, 0, -1] },
}

export default { name, label, description, params }
