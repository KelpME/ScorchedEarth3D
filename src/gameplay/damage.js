// S5 — damage.js PURE: blast proximity -> hull damage + kill flag. No DOM,
// no Math.random, no clock. Fails loud on missing data (engine doctrine).
//
// Scale constants (brief-pinned):
//   SE_PX_TO_WORLD = 0.2 — foreman calibration: world = px * 0.2. Defined
//   LOCALLY here with the same name + comment; S3d will centralize it.
//   Direct-hit core r = rPx * 0.2, falloff LINEAR to 0 at rPx * 1.0, both
//   factors applied to the WORLD-converted radius rWorld = rPx * SE_PX_TO_WORLD
//   (the only reading where the brief's core/edge factors AND the px->world
//   conversion are simultaneously consistent; documented per brief "cite or
//   _placeholder").
//   Damage cap per blast is weapon-independent: MAX_BLAST_DAMAGE = 100
//   (brief pin: "pin 100 hull"; tanks start at 100 hull unless config says
//   otherwise — the manual quantifies no per-tank damage curve: weapons
//   table manual:L961-L995 gives blastRadius only).
//   killed when hull <= 0 (brief pin). Post-death: a tank flagged dead takes
//   no further damage (idempotent — blast #2 on a corpse reports damage 0).

export const SE_PX_TO_WORLD = 0.2 // foreman-calibrated: world units = record px * 0.2
export const MAX_BLAST_DAMAGE = 100 // brief pin: weapon-independent per-blast cap, hull starts 100

/**
 * @param {object} p
 * @param {Array<{id:string,x:number,y:number,z:number,hull:number}>} p.tanks mutated: hull reduced, .dead set on kill
 * @param {{x:number,y:number,z:number,rPx:number}} p.blast center in world units + radius in RECORD PIXELS
 * @param {object} p.world reserved for the integration leaf (terrain occlusion etc.); unused here
 * @returns {Array<{id:string,damage:number,killed:boolean}>} one entry per input tank, input order
 */
export function applyBlast({ tanks, blast, world }) {
  if (!Array.isArray(tanks)) throw new Error('applyBlast: tanks must be an array')
  if (!blast || typeof blast.rPx !== 'number' || !Number.isFinite(blast.rPx)) {
    console.error('[se/damage] blast.rPx missing/non-numeric — skipping loudly, no silent fallback', blast)
    throw new Error(`applyBlast: blast.rPx required (number, record pixels), got ${JSON.stringify(blast && blast.rPx)}`)
  }
  const rWorld = blast.rPx * SE_PX_TO_WORLD // px -> world (foreman calibration)
  const core = rWorld * 0.2 // full-damage core radius (brief pin)
  const edge = rWorld * 1.0 // zero-damage edge radius (brief pin)

  const out = []
  for (const t of tanks) {
    if (t.dead) {
      // Idempotent post-death: a killed tank never takes damage again.
      out.push({ id: t.id, damage: 0, killed: false })
      continue
    }
    const dx = t.x - blast.x, dy = t.y - blast.y, dz = t.z - blast.z
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    let damage
    if (d <= core) {
      damage = MAX_BLAST_DAMAGE
    } else if (d >= edge) {
      damage = 0
    } else {
      // linear falloff: MAX at core -> 0 at edge
      damage = MAX_BLAST_DAMAGE * (edge - d) / (edge - core)
    }
    t.hull -= damage
    // fp-noise cleanup ONLY: exact boundary math (e.g. 55 - 55) can land at
    // ±1e-14; snap that to 0. Not a fallback — larger negatives (overkill)
    // are preserved (kill-boundary test pins killed at hull <= 0).
    if (Math.abs(t.hull) < 1e-9) t.hull = 0
    const killed = t.hull <= 0
    if (killed) t.dead = true
    out.push({ id: t.id, damage, killed })
  }
  return out
}
