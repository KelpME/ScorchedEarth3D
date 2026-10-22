// Engine built-in component: `placement`.
// Declares HOW an entity rests on the ground so an AI/scene author can place it
// by its ground point without arithmetic (see engine/src/physics/placement.js).
// `groundY` is the signed local-Y of the point of the entity that must touch the
// surface, measured from the transform origin (positive = above, negative =
// below). Absent = old center-origin placement. ONE field in Phase A; nodes/attach
// points are intentionally CUT.

export const name = 'placement'

export const label = 'Placement'

export const description = 'Declared ground-contact anchor. groundY = signed local-Y (from transform origin) of the point that should rest on a surface.'

export const params = {
  groundY: {
    type: 'number',
    description: 'Local-Y of the ground-contact point from the transform origin (positive = above origin, negative = below). Derive-aware: centered primitives may omit it (auto from collider).',
  },
}

export default { name, label, description, params }
