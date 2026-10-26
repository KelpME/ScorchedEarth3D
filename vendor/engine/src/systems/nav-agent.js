/**
 * `nav-agent` SYSTEM (Phase P2.5) — drives every entity carrying a `nav-agent`
 * COMPONENT. The flock precedent exactly: an engine built-in global system,
 * auto-registered by createGame (game.js registers it into the SystemRegistry
 * like `flock`), activated by a scene's `systems` list:
 *
 *   systems: [ { name: 'nav-agent' } ]
 *
 * Per-agent data (destination/follow/speed/avoid + the capability profile) is
 * DECLARED on the component; all movement logic is the shared core
 * (engine/src/nav/agent-core.js) — the same code path the legacy `nav-agent`
 * script shim uses, so component-form and script-form agents behave
 * identically. A bare component takes the schema defaults (componentDefaults).
 *
 * Editor-convention descriptor: { name, label, description, params, init, update }.
 */
import { navAgentUpdate, navAgentAttach, navAgentDetach } from '../nav/agent-core.js'
import { componentDefaults } from '../components/index.js'

const SHARED_FIELDS = ['destination', 'target', 'speed', 'follow', 'avoid', 'separationRadius', 'separationWeight']

/**
 * Component data with the declared schema defaults filled in for ABSENT
 * fields (component values always win). The legacy `nav-agent` script
 * attachment, when present on the same entity, is a live PARAM BRIDGE for
 * legacy writers (the game `patrol` script writes
 * `components.scripts[nav-agent].params.destination`): fields PRESENT in that
 * script entry's raw params override the component each step. The capability
 * profile (radius/height/maxSlope/stepHeight/jumpHeight) is component-only.
 */
function resolveParams(rec) {
  const comp = (rec && rec.components && rec.components['nav-agent']) || {}
  const out = { ...componentDefaults('nav-agent') }
  for (const k of Object.keys(comp)) out[k] = comp[k]
  const scripts = (rec && rec.components && rec.components.scripts) || []
  const legacy = scripts.find((s) => s && s.name === 'nav-agent')
  const src = (legacy && legacy.params) || {}
  for (const k of SHARED_FIELDS) {
    if (src[k] !== undefined) out[k] = src[k]
  }
  return out
}

export const navAgentSystem = {
  name: 'nav-agent',
  label: 'Nav Agent',
  description: 'Drives every entity carrying a `nav-agent` component: waypoint-following over the nav grid (findPath + unit-move stepToward), deterministic re-pathing, optional separation. Per-agent data + capability profile live on the component. Needs api.nav.',
  params: {},

  init() {
    this._seen = new Set()
  },

  update(dt, api) {
    if (!this._seen) this._seen = new Set()
    const seen = this._seen
    const ids = typeof api.query === 'function' ? api.query({ has: 'nav-agent' }) : []
    const alive = new Set()
    for (const id of ids) {
      const rec = typeof api.entity === 'function' ? api.entity(id) : null
      const comp = rec && rec.components && rec.components['nav-agent']
      if (!comp) continue
      alive.add(id)
      seen.add(id)
      navAgentAttach(id)
      navAgentUpdate(dt, api, id, resolveParams(rec))
    }
    // Component removed mid-run -> drop the agent's state (the script-shim
    // onDetach mirror). Scene loads reset everything via resetNavAgentState.
    for (const id of [...seen]) {
      if (!alive.has(id)) {
        seen.delete(id)
        navAgentDetach(id)
      }
    }
  },

  onDetach() {
    for (const id of (this._seen || [])) navAgentDetach(id)
    this._seen = new Set()
  },
}

/** Built-in nav-agent system registry entry: { 'nav-agent': navAgentSystem }. */
export const BUILTIN_NAV_AGENT_SYSTEMS = { 'nav-agent': navAgentSystem }
/** Metadata for the editor Systems picker. */
export const BUILTIN_NAV_AGENT_SYSTEM_METAS = [navAgentSystem]
