/**
 * Engine built-in component: `nav-point` (Phase P2.5 W5, plans/NAV-UX-REVISION.md
 * D-7). A MOVABLE WORLD POINT other systems reference — the antidote to baked
 * coordinates ("moveable points in the world … instead of hard coding x and z
 * values"). An entity with `nav-point` + `transform` IS a point: place it, name
 * it, move it — referrers follow. First consumer: `nav-agent.target` (the goal
 * is the point's parent-chain WORLD position, resolved live every re-path, so
 * moving the point re-routes the agent through the goalDrift trigger).
 *
 * Pure data + metadata, no behavior of its own (the components doctrine).
 */
export const name = 'nav-point'

export const label = 'Nav Point'

export const description = 'A movable world point other systems reference (e.g. a Nav Agent target). Move it — referrers follow.'

export const params = {
  label: { type: 'string', default: '' },
}

export default { name, label, description, params }
