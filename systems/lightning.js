// W2-Cb (plan SE-COMPLETE-1012) — hostile-sky LIGHTNING system: engine shell
// over the pure core (src/gameplay/lightning.js). Thin by doctrine: reads
// window.__se, dispatches strikes through the ONE damage path
// (battleLoop.onBlast), spawns the minimal data-driven VFX (bolt + flash),
// detaches broken barrels and steps their debris.
//
// Per update(dt, api):
//  - debris step: gravity drop of every `debris` entity, ground-snap on the
//    voxel surface, despawn on rest/timeout (no leaks).
//  - break watch: battle players whose maxPower reached the data floor get
//    their front barrel segment detached (idempotent, one-time per tank).
//  - strike roll: on a DIRECTOR TURN CHANGE (per-turn law) resolve strikes for
//    the hostile sky from DATA (physics-presets .lightning) deterministically
//    per (battle seed, turn index) and apply each through battleLoop.onBlast
//    (hostile:true — damage, never score; the struck tank cannot earn points
//    for the sky striking it).
//
// window.__se.lightning = { strikes, rollTurn, forceStrike, detachBarrel }
// — the seam specs drive (rollTurn resolves WITHOUT applying: pure determinism
// probe; forceStrike applies one strike deterministically).
import {
  rollTurnStrikes, isBarrelBreak, barrelWorldSnapshot, strikePoint as strikePointFor, hash2,
} from '../src/gameplay/lightning.js';
import { boltPath, segmentOrientation } from './boltPath.js';
import { treeStrike } from '../src/voxel3d/treeProp.js';
import presets from '../data/physics-presets.json' with { type: 'json' };

// W2-Cb system state is MODULE-LOCAL: the engine calls def.update(dt, api)
// UNBOUND (no `this` — runSystems contract), so methods close over `S` and
// mutable per-run state lives in LS (init'd fresh per module load).
const LS = { prevTurn: null, vfx: [] }
const LIGHTNING = presets.lightning

// P5 (plans/SETTLE-PACE-1015.md): LIVE lightning VFX params — the mounted
// weather_storm_lightning entity's stormLightning component is read PER
// STRIKE (edited fields win, merged over the presets.lightning.vfx base),
// replacing the module-load snapshot this file previously pinned. Exported
// pure so the unit test pins the merge without a DOM.
export function liveLightningVfx(api) {
  const rec = api && typeof api.entity === 'function' ? api.entity('weather_storm_lightning') : null
  const comp = rec && rec.components ? rec.components.stormLightning : null
  const out = { ...(LIGHTNING.vfx || {}) }
  // Empty-string fields (component-meta defaults) never override the preset base.
  for (const k of Object.keys(comp || {})) if (comp[k] !== '') out[k] = comp[k]
  return out
}
const DAMAGE_POWER = presets.damagePower
const RULE = {
  maxPower: DAMAGE_POWER.maxPower, maxHull: DAMAGE_POWER.maxHull,
  reductionPerHullFraction: DAMAGE_POWER.reductionPerHullFraction, floor: DAMAGE_POWER.floor,
}

/** The tank's front barrel segment + its parent Barrel node (mechanism-first:
 * subtree ids ending _Barrel_Barrel001 / shortest _Barrel under the tank). */
function resolveBarrelIds(api, tankId) {
  const prefix = `${tankId}_`
  const ids = api.query({})
  const segId = ids.filter((id) => id.startsWith(prefix) && id.endsWith('_Barrel_Barrel001')).sort((a, b) => a.length - b.length)[0] ?? null
  const barrelId = ids.filter((id) => id.startsWith(prefix) && id.endsWith('_Barrel') && !id.endsWith('_Barrel_Barrel001')).sort((a, b) => a.length - b.length)[0] ?? null
  return { segId, barrelId }
}

const S = {
  name: 'lightning', label: 'Hostile-sky lightning',
  description: 'Per-turn deterministic strikes on hostile skies (STORMY) + barrel break debris.',
  params: {},



  update(dt, api) {
    const se = typeof window !== 'undefined' && window.__se
    if (!se) return // editor viewport: scene-conditional no-op
    S.stepDebris(dt, api, se)
    S.watchBreaks(api, se)
    const d = se.director
    if (!d) return
    const st = d.state()
    if (LS.prevTurn === null) { LS.prevTurn = st.turn; return }
    if (st.turn === LS.prevTurn) return
    LS.prevTurn = st.turn
    const turnIndex = (se.lightningTurn = (se.lightningTurn ?? 0) + 1)
    S.applyStrikes(api, se, S.resolveTurn(se, turnIndex))
  },

  /** Pure determinism probe: resolve (no apply) for a turn index. */
  resolveTurn(se, turnIndex) {
    const battle = se.battle
    if (!battle) return []
    const tanks = battle.players.map((p) => {
      const tr = window.__game?.api?.entity(p.id)?.components?.transform
      return { id: p.id, dead: !p.alive, x: tr?.x ?? 0, y: tr?.y ?? 0, z: tr?.z ?? 0 }
    })
    return rollTurnStrikes({
      seed: se.terrainSeed?.value ?? 0, turnIndex,
      sky: se.sky?.style ?? null, params: LIGHTNING, tanks,
    })
  },

  /** Spec seam: apply ONE deterministic strike directly at `tankId` (bypasses
   * the chance roll; VFX + damage path identical to a rolled strike). */
  forceStrike(api, se, tankId) {
    const skyP = LIGHTNING.hostileSkies[se.sky?.style]
    if (!skyP) return false
    const tr = api.entity(tankId)?.components?.transform
    if (!tr) return false
    const pos = { x: tr.x ?? 0, y: tr.y ?? 0, z: tr.z ?? 0 }
    S.applyStrikes(api, se, [{ tankId, tankPos: pos, ...strikePointFor(pos, skyP) }])
    return true
  },

  applyStrikes(api, se, strikes) {
    let i = 0
    for (const s of strikes) {
      const skyP = LIGHTNING.hostileSkies[se.sky?.style]
      if (!skyP) continue
      // W8-G: per-strike bolt seed — deterministic per (battle seed, turn,
      // strike index); the pure boltPath output is a pure function of it.
      const seed = hash2(se.terrainSeed?.value ?? 0, ((se.lightningTurn ?? 0) + 1) * 131 + i)
      S.spawnVfx(api, se, s.tankPos, skyP.blastRpx, seed)
      // W8-G tree fire/char: a bolt landing within a tree's radius ignites
      // it (weather fire seam), scorches crown leaves (existing debris
      // path) and chars the trunk (recolor, standing). New trigger — the
      // strike/damage contract below is UNTOUCHED.
      S.treeFire(se, s.tankPos)
      // ONE DAMAGE PATH: the same onBlast tank shots take. hostile:true =
      // damage applies, scoring skipped (the sky is nobody's attacker; a null
      // attacker would trip the loop's fail-noisy error for a LEGITIMATE case).
      se.battleLoop?.onBlast({ x: s.x, y: s.y, z: s.z, rPx: skyP.blastRpx, hostile: true })
      se.lightning.strikes.push({ ...s, turn: se.lightningTurn ?? 0 })
      i++
    }
  },

  /** W8-G: tree fire/char for a bolt landing at `pos` (best-effort — no
   * trees / no registry = silent no-op). */
  treeFire(se, pos) {
    try { treeStrike(se, null, { x: pos.x, y: pos.y ?? 0, z: pos.z }, { seed: se.terrainSeed?.value ?? 0 }) }
    catch { /* tree strike must never break the damage path */ }
  },

  /** Detach the tank's front barrel segment: world snapshot -> destroy the
   * segment entity -> spawn a falling debris entity. One-time per tank
   * (se.barrelBroken). NO repair rule is pinned by the manual — _placeholder:
   * the barrel stays detached for the battle (maxPower resets with hull at
   * the round boundary, handled in main.js). */
  detachBarrel(api, se, tankId) {
    if (!se.barrelBroken) se.barrelBroken = {}
    if (se.barrelBroken[tankId]) return false
    const { segId, barrelId } = resolveBarrelIds(api, tankId)
    if (!segId) return false // nothing to detach (already gone / no rig)
    const tank = api.entity(tankId)?.components?.transform
    const barrel = barrelId ? api.entity(barrelId)?.components?.transform : null
    const seg = api.entity(segId)?.components?.transform
    if (!seg) return false
    const snap = barrelWorldSnapshot(tank, barrel, seg)
    api.world.destroy(segId)
    const id = `barrel_debris_${(se.barrelDebrisN = (se.barrelDebrisN || 0) + 1)}`
    api.spawn(id, { name: id, components: {
      transform: { x: snap.x, y: snap.y, z: snap.z, rot: { x: snap.rotX, y: 0, z: 0 } },
      render: { model: 'assets/models/tank.glb', node: 'Barrel001', visible: true },
      debris: { vy: 0, age: 0, rest: false, life: 6 },
    } })
    se.barrelBroken[tankId] = true
    const p = se.battle?.players?.find((pl) => pl.id === tankId)
    if (p) p.barrelBroken = true
    return true
  },

  /** Break watch (idempotent): alive players at/below the data floor break. */
  watchBreaks(api, se) {
    if (!se.battle || !se.damagePowerRule) return
    for (const p of se.battle.players) {
      if (p.alive && isBarrelBreak(p.maxPower, se.damagePowerRule)) S.detachBarrel(api, se, p.id)
    }
  },

  spawnVfx(api, se, pos, blastRpx, seed) {
    // P5 (SETTLE-PACE-1015): vfx params read LIVE per strike from the mounted
    // weather_storm_lightning entity (editor edits apply to the NEXT strike),
    // falling back to the presets.lightning.vfx base when the entity/api is
    // absent (node runs, editor viewport).
    const v = liveLightningVfx(api)
    const flashScale = Math.max(0.4, (blastRpx ?? 10) * 0.2)
    // Flash sphere at the strike point (same skinned route as the blast series).
    const flashId = `flash_${(se.flashN = (se.flashN || 0) + 1)}`
    api.spawn(flashId, { name: flashId, components: {
      transform: { x: pos.x, y: pos.y, z: pos.z, scale: [flashScale, flashScale, flashScale] },
      render: { mesh: 'sphere', material: 'fx_blast', skinned: true, materialParams: { color: v.flashColor ?? '#eaf4ff', nonce: flashId }, visible: true },
      fx: { age: 0, life: v.life ?? 0.35, opacity: 1 },
    } })
    LS.vfx = LS.vfx.concat([flashId])
    // W8-G Lichtenberg channel: the jagged bolt geometry is built ONCE per
    // strike (pure boltPath math — no per-frame regen) and rendered as ONE
    // thin box per segment through the SAME fx life/color/opacity path. Each
    // segment is a Y-axis box at its midpoint, oriented by Euler(0, ry, rz)
    // (segmentOrientation) so its long axis lies along the channel.
    const h = v.boltHeight ?? 30
    const path = boltPath({
      from: { x: pos.x, y: (pos.y ?? 0) + h, z: pos.z },
      to: { x: pos.x, y: pos.y ?? 0, z: pos.z },
      levels: v.levels, roughness: v.roughness, branchChance: v.branchChance,
      branchDecay: v.branchDecay, segmentMinLen: v.segmentMinLen, seed,
      bias: v.bias, branchWidthFrac: v.branchWidthFrac, maxSegments: v.maxSegments,
    })
    for (const seg of path.segments) {
      const dx = seg.bx - seg.ax, dy = seg.by - seg.ay, dz = seg.bz - seg.az
      const len = Math.hypot(dx, dy, dz)
      if (len < 1e-9) continue
      const { ry, rz } = segmentOrientation(dx, dy, dz)
      const w = (v.boltWidth ?? 0.12) * seg.w
      const boltId = `bolt_${(se.boltN = (se.boltN || 0) + 1)}`
      api.spawn(boltId, { name: boltId, components: {
        transform: {
          x: (seg.ax + seg.bx) / 2, y: (seg.ay + seg.by) / 2, z: (seg.az + seg.bz) / 2,
          rot: { x: 0, y: ry, z: rz }, scale: [w, len, w],
        },
        render: { mesh: 'box', material: 'fx_blast', skinned: true, materialParams: { color: v.boltColor ?? '#cfe8ff', nonce: boltId }, visible: true },
        fx: { age: 0, life: v.life ?? 0.35, opacity: 1 },
      } })
      LS.vfx = LS.vfx.concat([boltId]) // stepped below, despawned at life
    }
  },

  /** Fade this system's VFX (fx.opacity drives main.js's additive hook) and
   * destroy at end of life — no leaks. Debris: gravity drop + surface snap +
   * despawn on rest/timeout. */
  stepDebris(dt, api, se) {
    // VFX fade/destroy
    if (LS.vfx.length) {
      const keep = []
      for (const id of LS.vfx) {
        const fx = api.entity(id)?.components?.fx
        if (!fx) continue // destroyed elsewhere
        fx.age += dt
        fx.opacity = Math.max(0, 1 - fx.age / (fx.life || 0.35))
        if (fx.age < fx.life) keep.push(id)
        else api.world.destroy(id)
      }
      LS.vfx = keep
    }
    // Debris physics
    const gravity = se.gravity ?? 9.8
    for (const id of api.query({ has: 'debris' })) {
      const rec = api.entity(id)
      const d = rec?.components?.debris
      const tr = rec?.components?.transform
      if (!d || !tr) continue
      d.age += dt
      if (!d.rest) {
        d.vy -= gravity * dt
        tr.y += d.vy * dt
        const surface = se.host?.surface?.(tr.x ?? 0, tr.z ?? 0)
        if (typeof surface === 'number' && tr.y <= surface) { tr.y = surface; d.rest = true; d.restAge = 0 }
      } else {
        d.restAge = (d.restAge ?? 0) + dt
      }
      if (d.age >= d.life || (d.rest && d.restAge > 0.5)) api.world.destroy(id)
    }
  },
}

export default S
