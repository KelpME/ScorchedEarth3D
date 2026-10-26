// W2-J (plan SE-COMPLETE-1012) — DEATH SEQUENCES: every OG death case rebuilt
// as a DATA-described stage script (data/deaths.json); this module is the pure
// MECHANISM. No THREE, no DOM in the core: createDeathRun steps stages over
// sim ticks and emits declarative EVENTS (flash / spawnFx / spawnDebris) plus
// pose deltas; the mount (playDeath + tickDeaths) is the only impure side and
// runs against the engine api. Doctrine:
//   - pickCaseId is deterministic per battle seed (mulberry32, no Math.random)
//   - every stage primitive/param arrives from data (no content literals in JS)
//   - cleanup destroys every spawned fx and hides the corpse — no leaks
//   - tank entities are HIDDEN, never destroyed: reseedRound() repositions the
//     existing tankN entities between rounds (destroying them breaks rollover)
// All loops ITERATIVE (plain for-loops, no recursion — treeDebris doctrine).

import deathsData from '../../data/deaths.json' with { type: 'json' };
// W4-C (plan SE-COMPLETE-1012): the die line rides the same kill seam — the
// talk handle self-mounts on se (window.__se.talk) on first death.
import { createTalk } from '../../systems/talk.js';
import { fxSeconds } from './fx_pacing.js';

// mulberry32 — seeded PRNG (deterministic per battle seed), same shape as
// treeDebris.js's scatter rng.
export function mulberry32(seed) {
  let a = seed | 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function deathCases(data = deathsData) {
  return data.cases
}

/** OG death roulette: rand(N) over the case table — deterministic per seed. */
export function pickCaseId(seed, data = deathsData) {
  const cases = data.cases
  const rng = mulberry32(seed)
  const c = cases[Math.floor(rng() * cases.length)]
  if (!c) throw new Error(`[se/deaths] pickCaseId roll missed the case table (n=${cases.length})`)
  return c.id
}

/** Fail-loud lookup: an id without a data stage script is a data-file bug. */
export function sequenceFor(caseId, data = deathsData) {
  const c = data.cases.find((x) => x.id === caseId)
  if (!c) throw new Error(`[se/deaths] no death case "${caseId}" in data/deaths.json — parity gap`)
  if (!Array.isArray(c.stages) || c.stages.length === 0) {
    throw new Error(`[se/deaths] death case "${caseId}" has no stages`)
  }
  return c.stages
}

// ---- primitive executors ----------------------------------------------------
// Each receives (stage, ctx) where ctx = { first, dt, t, rng, pose, events,
// blast(key) }. first = this tick is the stage's first (emit-once hooks).
// pose.dy / pose.dyaw accumulate the corpse-relative transform deltas.

function blastParams(params, data) {
  if (params.blasts) {
    const b = data.blasts?.[params.blasts]
    if (!b) throw new Error(`[se/deaths] blasts key "${params.blasts}" missing from data/deaths.json .blasts`)
    return { rWorld: b.rWorld, color: params.color, growSeconds: params.growSeconds }
  }
  return { rWorld: params.rWorld, color: params.color, growSeconds: params.growSeconds }
}

const PRIMITIVES = {
  flash(stage, ctx) {
    const rateHz = stage.params.rateHz ?? 20
    ctx.events.push({ op: 'flash', visible: Math.floor(ctx.t * rateHz) % 2 === 0 })
  },
  blastSphere(stage, ctx) {
    if (!ctx.first) return
    const p = blastParams(stage.params, ctx.data)
    ctx.events.push({
      op: 'spawnFx', kind: 'sphere',
      dx: 0, dy: stage.params.offsetY ?? 0.5, dz: 0,
      rWorld: p.rWorld, color: p.color, growSeconds: p.growSeconds ?? 0.6, delay: 0,
    })
  },
  ring(stage, ctx) {
    if (!ctx.first) return
    const p = blastParams(stage.params, ctx.data)
    ctx.events.push({
      op: 'spawnFx', kind: 'ring',
      dx: 0, dy: stage.params.offsetY ?? 0.15, dz: 0,
      rWorld: p.rWorld, color: p.color, growSeconds: p.growSeconds ?? stage.duration, delay: 0,
      flat: stage.params.flat ?? 0.12,
    })
  },
  lift(stage, ctx) {
    ctx.pose.dy += (stage.params.riseSpeed ?? 2) * ctx.dt
  },
  spin(stage, ctx) {
    ctx.pose.dyaw += (stage.params.degPerSec ?? 360) * ctx.dt
  },
  sink(stage, ctx) {
    ctx.pose.dy -= (stage.params.sinkSpeed ?? 1.5) * ctx.dt
  },
  sparkle(stage, ctx) {
    const perSecond = stage.params.perSecond ?? 12
    const radius = stage.params.radius ?? 1.5
    if (ctx.rng() >= perSecond * ctx.dt) return
    const a = ctx.rng() * Math.PI * 2
    const r = ctx.rng() * radius
    ctx.events.push({
      op: 'spawnFx', kind: 'sphere',
      dx: Math.cos(a) * r, dy: 0.4 + ctx.rng() * radius, dz: Math.sin(a) * r,
      rWorld: stage.params.rWorld ?? 0.4, growSeconds: 0.25, delay: 0,
    })
  },
  fireworks(stage, ctx) {
    if (!ctx.first) return
    const n = stage.params.count ?? 6
    const stagger = stage.params.stagger ?? 0.15
    const spread = stage.params.spread ?? 1.2
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      ctx.events.push({
        op: 'spawnFx', kind: 'sphere',
        dx: Math.cos(a) * spread, dy: stage.params.offsetY ?? 2, dz: Math.sin(a) * spread,
        rWorld: stage.params.rWorld ?? 0.9, growSeconds: 0.5, delay: i * stagger,
      })
    }
  },
  debrisBurst(stage, ctx) {
    if (!ctx.first) return
    ctx.events.push({
      op: 'spawnDebris', count: stage.params.count ?? 10,
      speed: stage.params.speed ?? 5, upBias: stage.params.upBias ?? 0.6,
      life: stage.params.life ?? 2.5, origin: { x: ctx.pose.x, y: ctx.pose.y + 0.5, z: ctx.pose.z },
    })
  },
}

PRIMITIVES.cookoff = PRIMITIVES.debrisBurst // same mechanism, data sets the fury

export function primitiveNames() {
  return Object.keys(PRIMITIVES)
}

/**
 * Pure stage runner for one dead tank. step(dt) advances the CURRENT stage,
 * returning {events, done, pose}. pose.x/y/z is the corpse world anchor (fixed
 * at death); dy/dyaw are the per-stage-script deltas the mount applies.
 */
export function createDeathRun({ caseId, x, y, z, seed, data = deathsData } = {}) {
  const stages = sequenceFor(caseId, data)
  const rng = mulberry32((seed | 0) ^ 0x9e3779b9) // per-run rng: sparkle scatter etc.
  const pose = { x, y, z, dy: 0, dyaw: 0 }
  let si = 0
  let t = 0
  let first = true
  const run = {
    caseId,
    stages,
    get pose() { return pose },
    get stageIndex() { return si },
    get stageT() { return t },
    get done() { return si >= stages.length },
    step(dt) {
      const events = []
      if (run.done) return { events, done: true, pose }
      if (!Number.isFinite(dt) || dt <= 0) return { events, done: false, pose }
      const stage = stages[si]
      const ctx = { first, dt, t, rng, pose, events, data }
      const ex = PRIMITIVES[stage.primitive]
      if (!ex) throw new Error(`[se/deaths] unknown primitive "${stage.primitive}" in case "${caseId}"`)
      ex(stage, ctx)
      t += dt
      first = false
      if (t >= stage.duration - 1e-9) { // epsilon: float dt sums must not overshoot a stage
        t = 0
        si++
        first = true
      }
      return { events, done: run.done, pose }
    },
  }
  return run
}

// ---- mount (impure side: engine api only) -----------------------------------

let fxSeq = 0

/** Kill seam: pick the roulette case for seed and register a run on se. */
export function playDeath(se, api, tankId, seed, data = deathsData) {
  const rec = api.entity(tankId)
  if (!rec || !rec.components?.transform) {
    console.error(`[se/deaths] playDeath(${tankId}): no live tank entity — death sequence skipped`)
    return null
  }
  const tr = rec.components.transform
  const caseId = pickCaseId(seed, data)
  // W4-C DIE LINE (plan SE-COMPLETE-1012): the dead tank speaks — deterministic
  // per battle seed + death index (the SAME seed the stage sequencer rolled),
  // cooldown/skip + no-repeat rules are data (data/talk.json .pick). The
  // ATTACK side is the documented 1-line main.js hook (fire path), not here.
  se.talk = se.talk || createTalk(se)
  se.talk.play('die', tankId, { seed })
  const run = createDeathRun({ caseId, x: tr.x, y: tr.y, z: tr.z, seed, data })
  se.deathRuns = se.deathRuns || []
  se.deathRuns.push({ run, tankId, fxIds: [], done: false, baseYaw: tr.yaw ?? 0 })
  return run
}

function spawnDeathFx(api, r, ev) {
  const id = `deathfx_${++fxSeq}`
  const isRing = ev.kind === 'ring'
  const grow = fxSeconds(ev.growSeconds ?? 0.6) // P1 SETTLE-PACE-1015: death fx lingers (data fxTimeScale)
  const rec = api.entity(r.tankId)
  const tr = rec?.components?.transform ?? { x: 0, y: 0, z: 0, yaw: 0 }
  const color = ev.color ?? '#ffb347'
  api.spawn(id, { name: id, components: {
    transform: { x: tr.x + (ev.dx ?? 0), y: tr.y + (ev.dy ?? 0), z: tr.z + (ev.dz ?? 0), scale: [0.001, 0.001, 0.001] },
    render: {
      mesh: 'sphere',
      material: 'fx_blast',
      skinned: true, // per-entity Mesh + unique material clone (independent fade)
      materialParams: { color, nonce: id },
      visible: true,
    },
    fx: { age: 0, color, opacity: 1, maxScale: ev.rWorld, delay: ev.delay ?? 0, growSeconds: grow, minScale: 0.05 },
    scripts: [isRing
      ? { name: 'fx_death_ring', params: { maxScale: ev.rWorld, delay: ev.delay ?? 0, growSeconds: grow, minScale: 0.05, flat: ev.flat ?? 0.12 } }
      : { name: 'fx_blast_sphere', params: { maxScale: ev.rWorld, delay: ev.delay ?? 0, growSeconds: grow, minScale: 0.05 } }],
  } })
  r.fxIds.push(id)
}

function spawnDeathDebris(api, r, ev) {
  const rng = mulberry32((r.run.caseId.length * 7919 + Math.round(r.run.pose.x * 13) + r.fxIds.length) | 0)
  for (let i = 0; i < ev.count; i++) {
    const id = `deathdeb_${++fxSeq}`
    const a = rng() * Math.PI * 2
    const s = ev.speed * (0.5 + rng() * 0.5)
    const p = r.run.pose
    api.spawn(id, { name: id, components: {
      transform: { x: p.x, y: ev.origin?.y ?? p.y, z: p.z, scale: [0.18, 0.18, 0.18] },
      render: { mesh: 'box', material: 'fx', materialParams: { color: '#8a7a5a', nonce: id }, visible: true },
      debris: { vx: Math.cos(a) * s, vy: ev.upBias * s * (0.5 + rng()), vz: Math.sin(a) * s, age: 0 },
      scripts: [{ name: 'fx_death_debris', params: { life: fxSeconds(ev.life ?? 2.5), gravity: 9.8 } }],
    } })
    r.fxIds.push(id)
  }
}

/**
 * Per-frame mount tick (main.js frame loop). Steps every registered run,
 * applies flash/spawn events + pose deltas to the corpse entity, and cleans
 * up at sequence end: every spawned fx destroyed, corpse hidden (NOT
 * destroyed — reseedRound reuses tank entities), run deregistered. No leaks.
 */
export function tickDeaths(se, api, dt) {
  const runs = se.deathRuns
  if (!runs || runs.length === 0) return
  for (const r of runs) {
    if (r.done) continue
    const rec = api.entity(r.tankId)
    if (!rec) { r.done = true; continue } // corpse already gone: just clean below
    const { events, done, pose } = r.run.step(dt)
    const tr = rec.components.transform
    for (const ev of events) {
      if (ev.op === 'flash') {
        rec.components.render.visible = ev.visible
      } else if (ev.op === 'spawnFx') {
        spawnDeathFx(api, r, ev)
      } else if (ev.op === 'spawnDebris') {
        spawnDeathDebris(api, r, ev)
      } else {
        console.error(`[se/deaths] unknown mount event "${ev.op}" — skipped`)
      }
    }
    // pose deltas are RELATIVE to the death anchor (the OG corpse never walks);
    // yaw is baseYaw (frozen at death) + the accumulated spin delta (data is
    // DEG/sec — the engine yaw convention is radians, converted here, once)
    tr.x = pose.x
    tr.y = pose.y + pose.dy
    tr.z = pose.z
    tr.yaw = (r.baseYaw ?? 0) + pose.dyaw * (Math.PI / 180)
    if (done) {
      rec.components.render.visible = false // despawn: hide, never destroy (reseed rule)
      for (const id of r.fxIds) { if (api.entity(id)) api.world.destroy(id) }
      r.done = true
    }
  }
  se.deathRuns = runs.filter((r) => !r.done)
}
