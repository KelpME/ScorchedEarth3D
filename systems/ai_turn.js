/**
 * COMPUTER OPPONENTS — AI turn driver (plan SE-COMPLETE-1012).
 *
 * Editor-visible system (same mount pattern as drive/settle3d): every fixed
 * step it watches the turn director; when the ACTIVE tank belongs to a
 * 'computer' player (battle players carry kind + personalityId from the setup
 * config), it runs the plan/act machine:
 *
 *   think (thinkDelayFrames from data/ai-personalities.json .ai)
 *     -> drive (driveAffinity-scaled ticks toward/away via window.__aim.setDrive
 *        — the SAME drive seam humans key into)
 *     -> plan (src/gameplay/ai.js planShot — pure, seeded by the battle seed
 *        chain: terrainSeed + round + a per-tank act counter, so same seed =
 *        same AI decisions)
 *     -> act: chooseWeapon through battle.chooseWeapon (ammo + arms legality),
 *        set bearing/angle/power via window.__aim (setBearing +180 because the
 *        shot leaves along shellBearingRad(yaw) = yaw + PI — aim.js doctrine),
 *        then window.__aim.requestFire() — the SHARED fire path (ShellSpawn
 *        origin, director.requestFire, ammo burn, battle-loop shot register).
 *        The editor-visible tank script stays the only shot builder.
 *
 * Turn end is the normal settle path (director settleTick) — nothing here
 * touches phases. Simultaneous mode: phase 'planning' commits through the
 * same requestFire (the commit IS the fire, per the W4-A director contract).
 *
 * It never forks the fire path: no direct director.requestFire, no projectile
 * spawns — only the window.__aim seams.
 */
import { planShot, hashSeed } from '../src/gameplay/ai.js'
import { shellWorldOrigin } from '../src/gameplay/aim.js'

const FALLBACK_AI = { angleErrorDeg: 5, powerError: 0.05, thinkDelayFrames: 12, driveAffinity: 0.2, heavyCloserId: 'baby_nuke', heavyRange: 40, farWeaponId: 'missile' }
const DEG2 = 180 / Math.PI
let fallbackWarned = false
// Machine state at MODULE level: the engine may invoke update() unbound (the
// def object is not the dispatch `this`), so `this._machine` is not reliable.
const machine = { key: null, stage: 'idle', frames: 0, plan: null, driveLeft: 0, driveValue: 0 }
if (typeof window !== 'undefined') window.__aiMachine = machine // test/debug seam

function personalityOf(se, player) {
  const doc = se.aiPersonalities
  const list = doc && Array.isArray(doc.personalities) ? doc.personalities : null
  const found = list && list.find((p) => p.id === player.personalityId)
  if (!found && !fallbackWarned) {
    fallbackWarned = true
    console.error(`[se/ai] personality ${JSON.stringify(player.personalityId)} missing from data/ai-personalities.json — FALLBACK_AI knobs applied (fail-noisy)`)
  }
  return found || { id: player.personalityId, ai: FALLBACK_AI }
}

function buildState(se, api, turn, player, tr, battle) {
  const enemies = battle.players
    .filter((p) => p.alive && p.id !== turn)
    .map((p) => {
      const t = api.entity(p.id)?.components?.transform
      return t ? { id: p.id, x: t.x, y: t.y, z: t.z ?? 0, hull: p.hull, alive: true } : null
    })
    .filter(Boolean)
  // Muzzle origin = the EXACT ShellSpawn world derivation the shared fire path
  // uses (aim.js shellWorldOrigin over the live Barrel/ShellSpawn nodes) — the
  // sim must launch where the real shell launches, or gale winds amplify the
  // few-units offset into tens of units of landing error.
  let ox = tr.x, oy = (tr.y ?? 0) + 1.4, oz = tr.z ?? 0
  const prefix = `${turn}_`
  const ids = api.query({})
  const barrelId = ids.filter((id) => id.startsWith(prefix) && id.endsWith('_Barrel')).sort((a, b) => a.length - b.length)[0]
  const spawnId = ids.filter((id) => id.startsWith(prefix) && id.endsWith('_ShellSpawn')).sort((a, b) => a.length - b.length)[0]
  const bRec = barrelId ? api.entity(barrelId) : null
  const sRec = spawnId ? api.entity(spawnId) : null
  if (bRec?.components?.transform && sRec?.components?.transform) {
    const o = shellWorldOrigin(tr, bRec.components.transform, sRec.components.transform)
    ox = o.x; oy = o.y; oz = o.z
  }
  return {
    state: {
      shooter: { x: ox, y: oy, z: oz, bearingDeg: window.__drive?.get()?.bearingDeg ?? 0 },
      enemies,
      wind: { x: se.wind?.x ?? 0, z: se.wind?.z ?? 0 },
      gravity: se.gravity ?? 9.8,
      surfaceAt: (x, z) => se.host.surface(x, z),
      inventory: player.inventory?.weapons ?? {},
      weaponCatalog: battle.weaponCatalog ?? [],
      armsLevel: battle.armsLevel,
      maxPower: player.maxPower,
    },
    enemies,
  }
}

// A solve is only "fireable" when its simulated miss is inside the damage
// envelope (missile blastRadius 10 + margin). Beyond that the shot is a
// wasted OOB marathon: keep CLOSING instead, and only when no closer approach
// is possible fire the best effort anyway (a stalemate never ends the round).
const HIT_MISS = 12
const MIN_SEP = 25

export default {
  name: 'ai_turn', label: 'AI turn driver',
  description: "Computer opponents: plan/act on a computer tank's turn through the shared aim+fire seams (synchronous + simultaneous planning).",
  params: {},
  update(dt, api) {
    if (typeof window !== 'undefined' && window.__aiDbg !== false) window.__aiDbg = true;
    const se = typeof window !== 'undefined' && window.__se
    const m = machine
    if (!se?.battle?.players || !se.director || !window.__aim) return
    const st = se.director.state()
    if (st.phase !== 'aim' && st.phase !== 'planning') {
      m.key = null
      m.stage = 'idle'
      return
    }
    const turn = st.turn
    if (!turn) return
    const player = se.battle.players.find((p) => p.id === turn)
    if (!player || player.kind !== 'computer' || player.alive === false) {
      m.key = null
      m.stage = 'idle'
      return
    }
    // One act per (turn, phase-context): the key changes whenever the director
    // hands the pointer to another tank or the volley grows (simultaneous).
    const key = `${st.phase}|${turn}|${Array.isArray(st.shots) ? st.shots.length : 0}|${se.battle.round ?? 1}`
    // Dead-state guard: a machine left 'idle' while its key still matches the
    // live planning context (an act that never fired) must re-key — otherwise
    // the turn stalls forever. After a REAL fire the phase has already left
    // aim/planning, so this can never double-fire.
    if (m.stage === 'idle' && m.key === key) {
      console.error(`[se/ai] ${turn}: driver dead-idle — re-keying (fail-noisy)`)
      m.key = null
      return
    }
    if (key !== m.key) {
      m.key = key
      const pers = personalityOf(se, player)
      m.stage = 'think'
      m.frames = Math.max(0, Math.round(Number(pers.ai?.thinkDelayFrames ?? FALLBACK_AI.thinkDelayFrames)))
      m.plan = null
      m.driveLeft = 0
      m.driveValue = 0
      m.forceDud = false
      m.seed = 0
      return
    }
    const tr = api.entity(turn)?.components?.transform
    if (!tr) return
    const battle = se.battle
    const cur = battle.players.findIndex((p) => p.id === turn)

    if (m.stage === 'think') {
      m.frames--
      if (m.frames > 0) return
      // PLAN FIRST (pre-drive): whether this turn can produce a hittable shot
      // decides the drive — a hopeless solve means CLOSE THE DISTANCE instead
      // of wasting the turn (and the round) on OOB marathons.
      const pers = personalityOf(se, player)
      const enemies = battle.players.filter((p) => p.alive && p.id !== turn)
      let nearest = null
      let nd = Infinity
      for (const e of enemies) {
        const et = api.entity(e.id)?.components?.transform
        if (!et) continue
        const d = Math.hypot(et.x - tr.x, (et.z ?? 0) - (tr.z ?? 0))
        if (d < nd) { nd = d; nearest = { e, et, d } }
      }
      const built = buildState(se, api, turn, player, tr, battle)
      // Determinism: battle seed chain (terrainSeed) + round + per-tank act
      // counter — same seed = same AI decisions, no Math.random anywhere.
      se.aiActCount = { ...(se.aiActCount || {}), [turn]: (se.aiActCount?.[turn] ?? 0) + 1 }
      m.seed = hashSeed(se.terrainSeed?.value ?? 0, battle.round ?? 1, turn, se.aiActCount[turn])
      const plan = enemies.length ? planShot(built.state, pers, m.seed) : null
      const hittable = plan && plan._solve?.miss != null && plan._solve.miss <= HIT_MISS
      m.forceDud = !hittable && nd > MIN_SEP // can't hit from here -> close in
      // Stall-breaker: if closing made NO progress for 3 straight turns (slope
      // block, wall), fire the best effort anyway — a perpetual dud loop never
      // ends the round.
      if (m.forceDud) {
        if (Math.abs(nd - (m.lastNd ?? nd)) < 1.5) m.stallCount = (m.stallCount ?? 0) + 1
        else m.stallCount = 0
        m.lastNd = nd
        if (m.stallCount >= 3) { m.forceDud = false; m.stallCount = 0 }
      } else m.stallCount = 0
      const dx = nearest ? nearest.et.x - tr.x : 0
      const dz = nearest ? (nearest.et.z ?? 0) - (tr.z ?? 0) : 0
      const toTarget = Math.atan2(dx, dz) * DEG2
      const affinity = Number(pers.ai?.driveAffinity ?? 0)
      m.driveLeft = 0
      m.driveValue = 0
      if (nearest) {
        if (m.forceDud || nd > Number(pers.ai?.approachRange ?? 110)) {
          m.driveLeft = 240 // close the gap at full speed: ~24u/turn (budget cap)
          m.driveValue = 1
        } else if (affinity > 0) {
          m.driveLeft = Math.round(affinity * 60)
          m.driveValue = nd > 60 ? 0.6 : nd < 20 ? -0.6 : 0
        }
      }
      if (m.driveLeft > 0 && m.driveValue !== 0) {
        // Face the drive direction FIRST (the drive model moves along bearing).
        window.__aim.setBearing(m.driveValue > 0 ? toTarget : toTarget + 180)
        window.__aim.setDrive(m.driveValue)
        m.stage = 'drive'
      } else {
        m.stage = 'act-entry'
      }
      return
    }
    if (m.stage === 'drive') {
      m.driveLeft--
      if (m.driveLeft <= 0) {
        window.__aim.setDrive(0) // throttle back — the drive model persists it
        m.stage = 'act-entry'
      }
      return
    }
    if (m.stage === 'act-entry') {
      // PLAN: observe the LIVE world (post-drive positions), decide once.
      const pers = personalityOf(se, player)
      const built = buildState(se, api, turn, player, tr, battle)
      const { enemies, state } = built
      if (enemies.length === 0) { m.stage = 'idle'; return }
      const nearestDist = enemies.reduce((best, e) => {
        const d = Math.hypot(e.x - tr.x, e.z - (tr.z ?? 0))
        return d < best ? d : best
      }, Infinity)
      const approachRange = Number(pers.ai?.approachRange ?? 110)
      // Out of effective range (spawns can exceed the 163u flat max range):
      // drop a short dud lob through the SAME shared fire path — the turn
      // advances cheaply (~1s flight instead of a ~5s OOB marathon) and the
      // NEXT turn keeps closing. Never a phase fork: the director sees a shot.
      if (m.forceDud || nearestDist > approachRange) {
        m.plan = { weapon: 'baby_missile', angleDeg: 10, power: 0.05, bearingDeg: 0, driveTicks: 0, taunt: null, _solve: { miss: null, targetId: enemies[0].id, dud: true } }
        m.stage = 'act'
        return
      }
      const plan = planShot(state, pers, m.seed)
      if (!plan) { m.stage = 'idle'; m.key = null; return }
      m.plan = plan
      m.stage = 'act'
      return
    }
    if (m.stage === 'act') {
      const plan = m.plan
      if (!plan) { m.stage = 'act-entry'; return } // plan vanished — replan, never idle-out
      // Weapon: through the battle's legality gate (ammo + arms level) — the
      // picker's own path, so the HUD/picker mirrors the computer's choice.
      const chosen = battle.chooseWeapon(cur, plan.weapon)
      if (!chosen.ok) {
        console.error(`[se/ai] ${turn}: chooseWeapon ${JSON.stringify(plan.weapon)} rejected (${chosen.reason}) — firing with the current selection`)
      }
      // Aim through the SAME seams humans key: bearing +180 (the shot leaves
      // along shellBearingRad(yaw) = yaw + PI, aim.js doctrine), then the
      // SHARED fire path (ShellSpawn origin, director requestFire, ammo burn).
      window.__aim.setBearing(plan.bearingDeg + 180)
      window.__aim.setAngle(plan.angleDeg)
      window.__aim.setPower(plan.power)
      m.stage = 'fire'
      m.frames = 3 // let the barrel elevation/yaw land before the shot spawns
      return
    }
    if (m.stage === 'fire') {
      m.frames--
      if (m.frames > 0) return
      const accepted = window.__aim.requestFire()
      if (!accepted) {
        // Phase raced (round end, simultaneous pointer moved): stand down;
        // the next planning context re-keys the machine.
        console.info(`[se/ai] ${turn}: requestFire rejected (phase ${st.phase}) — standing down`)
      }
      m.stage = 'idle'
      m.plan = null
      return
    }
  },
}
