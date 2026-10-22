/**
 * Engine built-in component: `nav-agent` (Phase P2.5, plans/NAV-UX-REVISION.md
 * D-2). The RECOMMENDED nav authoring surface: a per-agent capability PROFILE
 * as plain editable data. Movement behavior lives in the `nav-agent` SYSTEM
 * (engine/src/systems/nav-agent.js), which drives every entity carrying this
 * component through the shared core (engine/src/nav/agent-core.js) — the same
 * one the legacy `nav-agent` script shim uses.
 *
 * Attach this component AND add `{ name: 'nav-agent' }` to the scene's
 * `systems` list (the flock precedent: the system is engine-registered, the
 * scene's systems array is the visible activation switch).
 *
 * `maxSlope` (deg) / `stepHeight` / `jumpHeight` are the DECLARED capability
 * profile, ENFORCED on terrain (W3): slope > maxSlope blocks, ledges ≤
 * stepHeight pass, and off-mesh links gate on |Δh| ≤ jumpHeight.
 */
export const name = 'nav-agent'

export const label = 'Nav Agent'

export const description = 'Waypoint-following movement over the nav grid (driven by the nav-agent system): destination/follow goal, speed, agent radius/height, avoid + separation. maxSlope/stepHeight/jumpHeight are the enforced capability profile (W3 terrain walkability): slope limit, step-up, and link-jump gates. Add { name: "nav-agent" } to the scene systems list. Prefer this component over the nav-agent script.'

export const params = {
  destination: { type: 'object', label: 'Destination', description: 'World XZ point {x, z}, or null — ADVANCED fallback: used only when neither follow nor target resolves (goal precedence: follow > target > destination)', nullable: true, default: null },
  speed: { type: 'number', default: 3 },
  radius: { type: 'number', default: 0.5, description: 'Agent radius (world units) — declared capability data, reserved for terrain walkability (W3)' },
  height: { type: 'number', default: 2, description: 'Agent height (world units) — declared capability data, reserved for terrain walkability (W3)' },
  maxSlope: { type: 'number', default: 45, description: 'Max walkable slope in degrees — ENFORCED terrain walkability (W3): steeper cells block' },
  stepHeight: { type: 'number', default: 0.5, description: 'Max ledge/step the agent mounts — ENFORCED terrain walkability (W3): height deltas above this block the crossing' },
  jumpHeight: { type: 'number', default: 1, description: 'Max jump for off-mesh link traversal — ENFORCED terrain walkability (W3): link Δh above this refuses the edge' },
  target: { type: 'entity', default: '', nullable: true, label: 'Target point', description: 'Entity id of a world point (nav-point) to walk to — live position, resolved every re-path' },
  follow: { type: 'entity', default: '', label: 'Follow', description: 'Entity id to track (entity id), or empty', nullable: true },
  gravityY: { type: 'boolean', default: false, description: 'Physics gravity owns Y (nav drives XZ only): the terrain drape is disabled and the body falls/lands/rests ON surfaces via the physics dynamic-body (bottom = y − (coreHalf + radius) — a pill rests on its body anchor / total-height half, NOT its cap radius); off-mesh link hops fly as a BALLISTIC arc (projectile launch + gravity) instead of a flat traverse' },
  avoid: { type: 'boolean', default: false, description: 'Separation push away from nearby registered nav-agents' },
  separationRadius: { type: 'number', default: 1 },
  separationWeight: { type: 'number', default: 1 },
}

export default { name, label, description, params }
