/**
 * Engine built-in `nav-agent` SCRIPT — COMPAT SHIM over the shared core
 * (Phase P2.5). The `nav-agent` COMPONENT + `nav-agent` SYSTEM are the
 * recommended surface; this script stays fully working so existing scenes and
 * scripts (e.g. the game `patrol` script, which writes this attachment's
 * `params.destination`) keep behaving identically — prefer the nav-agent
 * component for new work.
 *
 * Behavior is NOT here: `update` delegates to engine/src/nav/agent-core.js,
 * the ONE movement implementation shared with the system (see its header for
 * the design rules: composed stepToward, deterministic re-path triggers,
 * atomic link hops, arrive ring, separation). When the entity ALSO carries a
 * `nav-agent` component, this attachment is a PARAM BRIDGE only — its raw
 * params (what legacy writers mutate) are copied onto the component and
 * movement is left to the `nav-agent` system (exactly one movement source).
 *
 * Pure data + closure state; no DOM / no Three import — Node-vitestable.
 */
import { navAgentUpdate, navAgentAttach, navAgentDetach, resetNavAgentState, REPATH_INTERVAL_S } from '../nav/agent-core.js'

// Scene-load reset + the deterministic repath throttle: re-exported from the
// shared core so existing imports of this module keep working (builtins.js,
// tests).
export { resetNavAgentState, REPATH_INTERVAL_S }

const SHARED_FIELDS = ['destination', 'target', 'speed', 'follow', 'avoid', 'separationRadius', 'separationWeight']

export const navAgentScript = {
  params: {
    destination: { type: 'object', label: 'Destination', description: 'World XZ point {x, z}, or null — ADVANCED fallback: used only when neither follow nor target resolves (goal precedence: follow > target > destination)', nullable: true },
    speed: { type: 'number', default: 3 },
    target: { type: 'entity', default: '', nullable: true, label: 'Target point', description: 'Entity id of a world point (nav-point) to walk to — live position, resolved every re-path' },
    follow: { type: 'entity', default: '', label: 'Follow', description: 'Entity id to track (entity id), or empty', nullable: true },
    avoid: { type: 'boolean', default: true },
    separationRadius: { type: 'number', default: 1 },
    separationWeight: { type: 'number', default: 1 },
    // P2.5 W3 capability profile — ENFORCED terrain walkability (same
    // defaults as the nav-agent component; sent on every findPath/isNavigable).
    maxSlope: { type: 'number', default: 45, description: 'Max walkable slope in degrees (W3 capability profile — enforced on terrain)' },
    stepHeight: { type: 'number', default: 0.5, description: 'Max ledge/step the agent mounts (W3 capability profile — enforced on terrain)' },
    jumpHeight: { type: 'number', default: 1, description: 'Max jump for off-mesh link traversal (W3 capability profile — enforced on terrain)' },
  },

  onAttach(id) {
    navAgentAttach(id)
  },

  update(dt, api, id, p) {
    const rec = typeof api.entity === 'function' ? api.entity(id) : null
    const comp = rec && rec.components && rec.components['nav-agent']
    if (comp) {
      // Param bridge: the component + `nav-agent` system own this entity's
      // movement; legacy writers mutate THIS attachment's params, so mirror
      // the shared fields (only those PRESENT in the raw params) onto the
      // component. The capability profile stays component-only.
      const scripts = (rec.components && rec.components.scripts) || []
      const legacy = scripts.find((s) => s && s.name === 'nav-agent')
      const src = (legacy && legacy.params) || p || {}
      for (const k of SHARED_FIELDS) {
        if (src[k] !== undefined) comp[k] = src[k]
      }
      return
    }
    navAgentUpdate(dt, api, id, p)
  },

  onDetach(id) {
    navAgentDetach(id)
  },
}
