// W2-I (plan SE-COMPLETE-1012) — voxel tree debris PURE MODEL.
// Doctrine: no THREE, no DOM, no data-file imports — every color, size,
// hardness, physics number arrives via spec/opts (archetype + data params,
// never content literals in JS). All flows ITERATIVE (plain for-loops) — a
// sibling leaf died on a recursive flow; this module may never recurse.
//
// Tree voxel storage mirrors the terrain field layout (idx = x + z*nx +
// y*nx*nz, column-contiguous) with LOCAL cell indices; world mapping runs
// through origin + voxelSize. Materials are indices into tree.mats (0 =
// EMPTY), each carrying { kind, color, transparent, opacity, damageable,
// hardness } from the archetype spec — damageable:false (leaves) are skipped
// by every carve, like terrain voxels of infinite hardness but untouchable.

// Deterministic string->int hash for per-cell tumble (no Math.random).
function hash3(x, y, z, s) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + s * 1274126177) | 0
  h = (h ^ (h >>> 13)) * 1274126177 | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295 // 0..1
}

// mulberry32 — seeded PRNG for scatter (deterministic per seed).
function mulberry32(seed) {
  let a = seed | 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Deterministic per-id string hash (FNV-1a) — seeds the per-tree clump plan,
// tint drift and sway phase (no Math.random / wall-clock anywhere).
function hashId(s) {
  let h = 2166136261 | 0
  const str = String(s ?? '')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h | 0
}

const TAU = Math.PI * 2

// Per-tree tint drift (W8-B): deterministic per seed, within the drift band.
// Returns { dh, dv } — hue / value(HSL lightness) offsets for applyTint.
export function treeTint(seed, drift) {
  const r = mulberry32(((seed | 0) ^ 0x9e3779b9) | 0)
  return {
    dh: (r() * 2 - 1) * drift.hue,
    dv: (r() * 2 - 1) * drift.value,
  }
}

// Apply hue/value drift to an integer hex color (HSL roundtrip, clamped).
export function applyTint(color, dh, dv) {
  const r = ((color >> 16) & 255) / 255, g = ((color >> 8) & 255) / 255, b = (color & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  h = ((h + dh) % 1 + 1) % 1
  const l2 = Math.min(1, Math.max(0, l + dv))
  const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s
  const p = 2 * l2 - q
  const chan = (t) => {
    let t2 = t
    if (t2 < 0) t2 += 1
    if (t2 > 1) t2 -= 1
    if (t2 < 1 / 6) return p + (q - p) * 6 * t2
    if (t2 < 1 / 2) return q
    if (t2 < 2 / 3) return p + (q - p) * (2 / 3 - t2) * 6
    return p
  }
  const ri = Math.round(Math.min(1, Math.max(0, chan(h + 1 / 3))) * 255)
  const gi = Math.round(Math.min(1, Math.max(0, chan(h))) * 255)
  const bi = Math.round(Math.min(1, Math.max(0, chan(h - 1 / 3))) * 255)
  return (ri << 16) | (gi << 8) | bi
}

// Sway weight (W8-B): 0 at the trunk top, 1 at the crown top, linear between
// (height-weighted canopy lean — trunk planted). Clamped to [0, 1].
export function swayWeight(tree, y) {
  const lo = tree.trunkTopY, hi = tree.crownTopY
  if (!(hi > lo)) return y >= hi ? 1 : 0
  return Math.max(0, Math.min(1, (y - lo) / (hi - lo)))
}

// Idle sway offset: deterministic in (time, hz, phase), bounded by amp*1.17.
// Primary lean + a small flutter term; weight scales the whole offset (0 at
// the trunk -> exactly zero offset).
export function swayOffset(weight, time, amp, hz, phase) {
  if (!weight || !amp || !hz) return { dx: 0, dz: 0 }
  const t = time * hz * TAU + phase * TAU
  return {
    dx: amp * weight * (0.7 * Math.sin(t) + 0.08 * Math.sin(t * 2.7 + 1.3)),
    dz: amp * weight * (0.7 * Math.sin(t * 1.13 + 0.7) + 0.08 * Math.sin(t * 2.3)),
  }
}
// W8-F: wind coupling. windPct = clamp(|wind.x| / (maxWind * pxToWorld), 0, 1)
// — |wind| (world u/s^2 seam) relative to the settings max, SE-px anchor
// applied by the caller (SE_PX_TO_WORLD lives in settingsApply.js). Degenerate
// maxWind parks at 0 (calm), never NaN/Inf.
export function windPctOf(windX, maxWind, pxToWorld) {
  const mw = (maxWind ?? 0) * (pxToWorld ?? 0)
  if (!(mw > 0)) return 0
  return Math.max(0, Math.min(1, Math.abs(windX ?? 0) / mw))
}

// W8-F: amplitude scale from windPct — idle floor at zero wind, linear ramp
// to idleFloor + coupling at full wind. All inputs spec data (archetype).
export function swayScale(windPct, spec) {
  const floor = spec?.swayIdleFloor ?? 0
  const coupling = spec?.swayWindCoupling ?? 0
  const p = Math.max(0, Math.min(1, windPct ?? 0))
  return floor + coupling * p
}

// W8-F: PER-CLUMP sway — each crown clump moves on its own noise-driven
// offset: two incommensurate-frequency sine sums (deterministic 'random'),
// per-clump phase + amplitude/hz jitter hashed from (clump index, clump
// phase seed) — never Math.random / wall-clock. Amplitude is wind-coupled
// via swayScale(windPct). Bound: |offset| <= amp * scale * (1+jitter) * 0.79.
export function clumpSway(tree, clumpIdx, time, windPct) {
  const s = tree?.sway
  if (!s || !s.amp || !s.hz) return { dx: 0, dz: 0 }
  const seed = s.clumpPhaseSeed ?? 0
  const jitter = s.clumpAmpJitter ?? 0
  const phase = hash3(clumpIdx | 0, seed | 0, 1, 71)
  const ampJit = 1 + (hash3(clumpIdx | 0, seed | 0, 2, 73) * 2 - 1) * jitter
  const hzJit = 1 + (hash3(clumpIdx | 0, seed | 0, 3, 79) * 2 - 1) * jitter * 0.5
  const amp = s.amp * swayScale(windPct, s) * ampJit
  if (!amp) return { dx: 0, dz: 0 }
  const t1 = time * s.hz * hzJit * TAU + phase * TAU
  const t2 = t1 * 1.618 + 0.7 // incommensurate flutter term (deterministic)
  return {
    dx: amp * (0.7 * Math.sin(t1) + 0.08 * Math.sin(t2 * 2.7)),
    dz: amp * (0.7 * Math.sin(t1 * 1.13 + 0.7) + 0.08 * Math.sin(t2 * 2.3)),
  }
}

// W8-F: deterministic per-tree yaw rotation (degrees) inside rotationDeg
// bounds — hashed from the tree id (the scatter/build seed carrier).
export function treeRotation(id, rotationDeg) {
  if (!rotationDeg) return 0
  const min = rotationDeg.min ?? 0
  const max = rotationDeg.max ?? 0
  const h = (hashId(String(id ?? '')) >>> 0) / 4294967296
  return min + h * (max - min)
}
// Build a tree voxel grid from an archetype-shaped spec at a world origin.
// spec: { voxelSize, trunkHeight, trunkRadius, crownLayers, crownRadius,
//         crownClumps?, limbCount?, tintDrift?, swayAmp?, swayHz?,
//         trunkColor, trunkHardness, leafColors[], leafOpacity,
//         leafTransparent, leafDamageable, colorSeed }
// Multi-clump crown (spec.crownClumps): one dominant voxel mass + satellite
// clumps tucked around it (W8-B, street-tree technique voxelized) — clumps
// are placed deterministically per id and NEVER touch (>=1 empty cell between
// 26-connected leaf masses). Trunk limbs (trunk material) reach from the
// trunk top INTO the first limbCount clumps. Shrink-only ragged noise breaks
// the ball silhouette; it can never merge clumps or disconnect one.
export function buildTree(spec, origin, id) {
  const v = spec.voxelSize
  const cr = spec.crownRadius
  const nx = 2 * cr + 1
  const nz = 2 * cr + 1
  const th = spec.trunkHeight
  const cx = cr, cz = cr
  const idx = (x, y, z) => x + z * nx + y * nx * nz

  // Materials: 0 = EMPTY. Mats[1] trunk; mats[2..] one per leaf color (spec).
  const mats = [null, {
    kind: 'trunk', color: typeof spec.trunkColor === 'string' ? parseInt(spec.trunkColor.slice(1), 16) : spec.trunkColor,
    transparent: false, opacity: 1, damageable: true, hardness: spec.trunkHardness,
  }]
  for (const c of spec.leafColors) {
    mats.push({
      kind: 'leaf', color: typeof c === 'string' ? parseInt(c.slice(1), 16) : c,
      transparent: !!spec.leafTransparent, opacity: spec.leafOpacity,
      damageable: !!spec.leafDamageable, hardness: 1,
    })
  }
  // Per-tree tint drift (deterministic per id + colorSeed): hue/value drift
  // inside the spec band, applied to leaf materials only.
  let tint = null
  if (spec.tintDrift) {
    tint = treeTint(hashId(id) ^ (((spec.colorSeed ?? 0) * 2654435761) | 0), spec.tintDrift)
    for (let m = 2; m < mats.length; m++) mats[m].color = applyTint(mats[m].color, tint.dh, tint.dv)
  }

  // Multi-clump crown plan: dominant mass + satellites at evenly spread
  // angles (deterministic jitter), centers >= (r0 + rs + gap) apart so
  // clumps stay distinct 26-connected leaf masses. ny grows to fit.
  let plan = null
  let ny = th + spec.crownLayers
  if (spec.crownClumps) {
    const cc = spec.crownClumps
    const n = Math.max(1, cc.count | 0)
    const r0 = Math.max(1, Math.round(cr * (cc.dominantScale ?? 0.35)))
    const rs = Math.max(1, Math.round(cr * (cc.satelliteScale ?? 0.22)))
    const gap = Math.max(2, cc.gap ?? 2)
    const d = r0 + rs + gap
    const rng = mulberry32(hashId(id) ^ (((spec.colorSeed ?? 0) * 2654435761) | 0))
    const cy0 = th + r0 - 2
    plan = [{ x: cx, y: cy0, z: cz, r: r0, dominant: true }]
    for (let i = 1; i < n; i++) {
      const ang = ((i - 1) / Math.max(1, n - 1)) * TAU + (rng() - 0.5) * 0.5
      plan.push({
        x: Math.round(cx + Math.cos(ang) * d),
        y: cy0 + Math.round((rng() - 0.5) * 4),
        z: Math.round(cz + Math.sin(ang) * d),
        r: rs, dominant: false,
      })
    }
    for (const c of plan) ny = Math.max(ny, c.y + c.r + 1)
  }

  const cells = new Uint8Array(nx * ny * nz)

  let trunkCount = 0, leafCount = 0, firstTrunk = -1
  const r2 = spec.trunkRadius * spec.trunkRadius + 0.5
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < nx; x++) {
      for (let z = 0; z < nz; z++) {
        const dx = x - cx, dz = z - cz
        if (dx * dx + dz * dz > r2) continue
        cells[idx(x, y, z)] = 1
        trunkCount++
        if (firstTrunk < 0) firstTrunk = idx(x, y, z)
      }
    }
  }

  if (plan) {
    // Multi-clump crown: ragged spheres (shrink-only noise per cell —
    // irregular silhouette that can neither merge clumps nor split one).
    for (const c of plan) {
      const r2v = c.r * c.r + 0.5
      const xLo = Math.max(0, c.x - c.r), xHi = Math.min(nx - 1, c.x + c.r)
      const yLo = Math.max(0, c.y - c.r), yHi = Math.min(ny - 1, c.y + c.r)
      const zLo = Math.max(0, c.z - c.r), zHi = Math.min(nz - 1, c.z + c.r)
      for (let x = xLo; x <= xHi; x++) {
        for (let y = yLo; y <= yHi; y++) {
          for (let z = zLo; z <= zHi; z++) {
            const re = c.r * (0.85 + 0.15 * hash3(x, y, z, 91))
            const dx = x - c.x, dy = y - c.y, dz = z - c.z
            if (dx * dx + dy * dy + dz * dz > re * re + 0.5) continue
            if (cells[idx(x, y, z)] !== 0) continue
            const mi = 2 + ((x + y + z + (spec.colorSeed ?? 0)) % spec.leafColors.length)
            cells[idx(x, y, z)] = mi
            leafCount++
          }
        }
      }
    }
    // Limbs: straight trunk-material path from the trunk-top cell into the
    // first limbCount clumps (reaches INTO the clump — overwrites leaf cells,
    // which stay connected around the 1-wide line).
    const nLimb = Math.min(spec.limbCount ?? 0, plan.length)
    for (let i = 0; i < nLimb; i++) {
      const c = plan[i]
      const steps = Math.max(Math.abs(c.x - cx), Math.abs(c.y - (th - 1)), Math.abs(c.z - cz), 1)
      for (let k = 0; k <= steps; k++) {
        const x = Math.round(cx + (c.x - cx) * k / steps)
        const y = Math.round((th - 1) + (c.y - (th - 1)) * k / steps)
        const z = Math.round(cz + (c.z - cz) * k / steps)
        const i2 = idx(x, y, z)
        if (cells[i2] === 1) continue
        if (cells[i2] >= 2) leafCount--
        cells[i2] = 1
        trunkCount++
      }
    }
  } else {
    // Layered crown (specs without crownClumps — the pre-W8-B silhouette).
    for (let l = 0; l < spec.crownLayers; l++) {
      const y = th + l
      const lr = Math.max(1, spec.crownRadius - Math.floor((l * cr) / Math.max(1, spec.crownLayers)))
      const lr2 = lr * lr + 0.5
      for (let x = 0; x < nx; x++) {
        for (let z = 0; z < nz; z++) {
          const dx = x - cx, dz = z - cz
          if (dx * dx + dz * dz > lr2) continue
          const mi = 2 + ((x + y + z + (spec.colorSeed ?? 0)) % spec.leafColors.length)
          cells[idx(x, y, z)] = mi
          leafCount++
        }
      }
    }
  }

  const tree = {
    id, origin: { ...origin }, v, nx, ny, nz, cells, mats,
    count: trunkCount + leafCount, trunkCount, leafCount, debris: [],
    clumps: plan ?? undefined,
    tint,
    // W8-G: editor-visible charred-trunk color (data, not a JS literal) —
    // charTrunk swaps the trunk material to this on a lightning strike.
    charColor: spec.charColor ?? null,
    charred: false,
    trunkTopY: origin.y + th * v,
    crownTopY: origin.y + ny * v,
    sway: (spec.swayAmp || spec.swayHz)
      ? {
          amp: spec.swayAmp ?? 0, hz: spec.swayHz ?? 1, phase: (hashId(id) >>> 8) / 16777216,
          // W8-F wind-coupled per-clump sway — all archetype data:
          swayIdleFloor: spec.swayIdleFloor ?? 0,
          swayWindCoupling: spec.swayWindCoupling ?? 0,
          swayClumpPhaseSeed: spec.swayClumpPhaseSeed ?? 0,
          swayClumpAmpJitter: spec.swayClumpAmpJitter ?? 0,
        }
      : null,
    // W8-F: deterministic per-tree yaw (radians) — applied by the render
    // pivot at mount (entity transform is flat t.x/y/z, no rotation field).
    rotationDeg: treeRotation(id, spec.rotationDeg),
    rotationRad: treeRotation(id, spec.rotationDeg) * (Math.PI / 180),
    boundRadius: 0.5 * Math.sqrt((nx * v) ** 2 + (ny * v) ** 2 + (nz * v) ** 2),
  }
  // Local cell index -> world center (grid centered on origin horizontally).
  tree.cellCenter = (i) => {
    const x = i % nx
    const z = Math.floor(i / nx) % nz
    const y = Math.floor(i / (nx * nz))
    return {
      x: origin.x + (x + 0.5 - nx / 2) * v,
      y: origin.y + (y + 0.5) * v,
      z: origin.z + (z + 0.5 - nz / 2) * v,
    }
  }
  tree.firstTrunkCell = () => firstTrunk
  return tree
}

// Terrain damage path (src/voxel3d/blast.js rule) pointed at tree voxels:
// a cell dies iff the hardness-scaled distance from the blast center to the
// cell center is within the radius. NON-damageable materials (leaves) are
// skipped outright. Iterative AABB scan; center/r in WORLD coordinates.
export function carveTree(tree, center, rWorld) {
  const v = tree.v
  // blast center in grid-local continuous cell space (grid centered on origin)
  const cX = (center.x - tree.origin.x) / v + tree.nx / 2
  const cY = (center.y - tree.origin.y) / v
  const cZ = (center.z - tree.origin.z) / v + tree.nz / 2
  const rCells = rWorld / v
  const r2 = rCells * rCells
  let removed = 0, trunkRemoved = 0, leafRemoved = 0
  for (let x = 0; x < tree.nx; x++) {
    for (let z = 0; z < tree.nz; z++) {
      for (let y = 0; y < tree.ny; y++) {
        const i = x + z * tree.nx + y * tree.nx * tree.nz
        const m = tree.cells[i]
        if (m === 0) continue
        const mat = tree.mats[m]
        if (!mat.damageable) continue
        const h = mat.hardness
        const dx = (x + 0.5 - cX) * h
        const dy = (y + 0.5 - cY) * h
        const dz = (z + 0.5 - cZ) * h
        if (dx * dx + dy * dy + dz * dz <= r2) {
          tree.cells[i] = 0
          removed++
          trunkRemoved++
          tree.count--
          tree.trunkCount--
        }
      }
    }
  }
  return { removed, trunkRemoved }
}

// True when the UNSCALED blast sphere overlaps any solid cell (blast "hits"
// the tree even if every overlapped cell is non-damageable).
export function treeHit(tree, center, rWorld) {
  const v = tree.v
  const cX = (center.x - tree.origin.x) / v + tree.nx / 2
  const cY = (center.y - tree.origin.y) / v
  const cZ = (center.z - tree.origin.z) / v + tree.nz / 2
  const r2 = (rWorld / v) * (rWorld / v)
  for (let x = 0; x < tree.nx; x++) {
    for (let z = 0; z < tree.nz; z++) {
      for (let y = 0; y < tree.ny; y++) {
        const i = x + z * tree.nx + y * tree.nx * tree.nz
        if (tree.cells[i] === 0) continue
        const dx = x + 0.5 - cX, dy = y + 0.5 - cY, dz = z + 0.5 - cZ
        if (dx * dx + dy * dy + dz * dz <= r2) return true
      }
    }
  }
  return false
}

// Blast behavior: every SURVIVING voxel detaches into debris with velocity =
// (unit radial away from blast) * power * speedScale * falloff(dist) plus a
// deterministic tumble (angular velocity, never polluting the linear radial
// direction). Destroys nothing — carving already did. Clears the grid.
// ITERATIVE single pass; zero-length radial (blast exactly at a cell center)
// resolves UP so the direction pin holds for every debris record.
//
// SETTLE-PACE P4 — SPAWN BURST BUDGET (data-first): opts.debrisPerStep (data:
// data/tree.json .debris.debrisPerStep) opts in to SIM-STEPPED streaming — the
// full detach queue lands in tree.detach (FIFO, deterministic cell order) and
// stepDebris delivers up to debrisPerStep records per step into tree.debris,
// so a full-crown detach streams over a few frames instead of one frame-cost
// spike. No budget -> the legacy INSTANT path (all records straight into
// tree.debris) — the pure-model back-compat contract. The old maxDebris cap
// break is GONE: the W8-B full-crown rule is absolute — a full crown is never
// truncated; pacing, not truncation, is the budget mechanism.
export function explode(tree, blastCenter, power, opts) {
  const speedScale = opts.speedScale ?? 1
  const falloffDist = opts.falloffDist ?? 1.5
  const tumbleScale = opts.tumbleScale ?? 0
  const per = opts.debrisPerStep
  const streaming = typeof per === 'number' && Number.isFinite(per) && per > 0
  if (streaming && !tree.detach) tree.detach = []
  const out = streaming ? tree.detach : tree.debris
  let spawned = 0
  for (let i = 0; i < tree.cells.length; i++) {
    const m = tree.cells[i]
    if (m === 0) continue
    const c = tree.cellCenter(i)
    let rx = c.x - blastCenter.x, ry = c.y - blastCenter.y, rz = c.z - blastCenter.z
    const dist = Math.sqrt(rx * rx + ry * ry + rz * rz)
    if (dist < 1e-6) { rx = 0; ry = 1; rz = 0 } else { rx /= dist; ry /= dist; rz /= dist }
    const s = power * speedScale * (1 / (1 + dist / falloffDist))
    const h = hash3(i % tree.nx, Math.floor(i / (tree.nx * tree.nz)), Math.floor(i / tree.nx) % tree.nz, 17)
    out.push({
      x: c.x, y: c.y, z: c.z,
      vx: rx * s, vy: ry * s, vz: rz * s,
      rx: (h - 0.5) * tumbleScale, ry: (hash3(i, 1, 2, 29) - 0.5) * tumbleScale, rz: (hash3(3, i, 4, 31) - 0.5) * tumbleScale,
      ax: 0, ay: 0, az: 0, // accumulated tumble angle for the render mount
      mat: m, age: 0, rest: 0,
    })
    tree.cells[i] = 0
    spawned++
  }
  tree.count = 0
  tree.trunkCount = 0
  tree.leafCount = 0
  return spawned
}

// Integrate debris one step: gravity, motion, tumble; despawn on rest
// (grounded + slow for restSeconds) or age timeout. In-place write-index
// compaction (single iterative pass — despawned records drop out, the array
// shrinks; no leaks, no recursion). groundYAt(x,z) -> ground plane y or null
// (null = no ground: only the timeout can end a straggler).
export function stepDebris(tree, dt, opts) {
  // SETTLE-PACE P4: drain the streaming detach queue (explode's debrisPerStep
  // budget) — FIFO, deterministic order, up to opts.debrisPerStep records per
  // sim step into active debris. No budget -> any queued records deliver
  // instantly (legacy contract).
  if (tree.detach && tree.detach.length > 0) {
    const per = opts.debrisPerStep
    const n = typeof per === 'number' && Number.isFinite(per) && per > 0
      ? Math.min(per, tree.detach.length)
      : tree.detach.length
    for (let k = 0; k < n; k++) tree.debris.push(tree.detach[k])
    tree.detach.splice(0, n)
  }
  const g = opts.gravity ?? 9.8
  const restSpeed = opts.restSpeed ?? 0.4
  const restSeconds = opts.restSeconds ?? 0.75
  const timeoutSeconds = opts.timeoutSeconds ?? 8
  const groundYAt = opts.groundYAt
  const half = tree.v / 2
  let w = 0
  for (let r = 0; r < tree.debris.length; r++) {
    const d = tree.debris[r]
    d.age += dt
    d.vy -= g * dt
    d.x += d.vx * dt
    d.y += d.vy * dt
    d.z += d.vz * dt
    d.ax += d.rx * dt
    d.ay += d.ry * dt
    d.az += d.rz * dt
    const gy = groundYAt ? groundYAt(d.x, d.z) : null
    if (gy !== null && gy !== undefined && d.y - half <= gy) {
      d.y = gy + half
      if (d.vy < 0) d.vy = 0
      const fr = Math.pow(0.02, dt) // ground friction, frame-rate independent
      d.vx *= fr
      d.vz *= fr
    }
    const speed = Math.hypot(d.vx, d.vy, d.vz)
    const grounded = gy !== null && gy !== undefined && d.y - half <= gy + 1e-6
    d.rest = grounded && speed < restSpeed ? d.rest + dt : 0
    const dead = d.age >= timeoutSeconds || d.rest >= restSeconds
    if (!dead) tree.debris[w++] = d
  }
  tree.debris.length = w
  return { alive: w }
}

// W8-G (plan SE-COMPLETE-1012, user-directed) — LIGHTNING STRIKE FIRE/CHAR
// (pure model). scorchLeaves: leaf-material voxels within rWorld of the
// strike point detach through the EXISTING debris path (same record shape as
// explode(), stepped/rendered by the same step/sync code) — a data-driven
// FRACTION of the eligible set, selected deterministically per (cell, seed).
// Trunk voxels are never touched (leaves-trunk-selective pin). charTrunk:
// the trunk MATERIAL swaps to the tree's editor-visible charColor (data) —
// recolor, never carve; the blackened tree remains standing.
export function scorchLeaves(tree, center, rWorld, fraction, seed) {
  const v = tree.v
  const cX = (center.x - tree.origin.x) / v + tree.nx / 2
  const cY = (center.y - tree.origin.y) / v
  const cZ = (center.z - tree.origin.z) / v + tree.nz / 2
  const r2 = (rWorld / v) * (rWorld / v)
  const eligible = []
  for (let i = 0; i < tree.cells.length; i++) {
    const m = tree.cells[i]
    if (m === 0 || tree.mats[m].kind !== 'leaf') continue
    const x = i % tree.nx
    const z = Math.floor(i / tree.nx) % tree.nz
    const y = Math.floor(i / (tree.nx * tree.nz))
    const dx = x + 0.5 - cX, dy = y + 0.5 - cY, dz = z + 0.5 - cZ
    if (dx * dx + dy * dy + dz * dz <= r2) eligible.push(i)
  }
  const take = Math.max(0, Math.min(eligible.length, Math.floor(eligible.length * (fraction ?? 0))))
  // deterministic selection: rank eligible cells by a per-cell hash, take lowest
  const ranked = eligible
    .map((i) => ({ i, h: hash3(i % tree.nx, Math.floor(i / (tree.nx * tree.nz)), Math.floor(i / tree.nx) % tree.nz, seed | 0) }))
    .sort((a, b) => a.h - b.h)
  let detached = 0
  for (let k = 0; k < take; k++) {
    const i = ranked[k].i
    const c = tree.cellCenter(i)
    let rx = c.x - center.x, ry = c.y - center.y, rz = c.z - center.z
    const dist = Math.sqrt(rx * rx + ry * ry + rz * rz)
    if (dist < 1e-6) { rx = 0; ry = 1; rz = 0 } else { rx /= dist; ry /= dist; rz /= dist }
    const s = rWorld * (1 / (1 + dist / 1.5)) // explode()'s falloff, strike-powered
    const h = hash3(i % tree.nx, Math.floor(i / (tree.nx * tree.nz)), Math.floor(i / tree.nx) % tree.nz, 17)
    tree.debris.push({
      x: c.x, y: c.y, z: c.z,
      vx: rx * s, vy: ry * s, vz: rz * s,
      rx: (h - 0.5) * 6, ry: (hash3(i, 1, 2, 29) - 0.5) * 6, rz: (hash3(3, i, 4, 31) - 0.5) * 6,
      ax: 0, ay: 0, az: 0,
      mat: tree.cells[i], age: 0, rest: 0,
    })
    tree.cells[i] = 0
    tree.leafCount--
    tree.count--
    detached++
  }
  return { eligible: eligible.length, detached }
}

// W8-G: trunk material swap to charColor (editor-visible data carried by the
// archetype through buildTree's spec.charColor). Recolor ONLY — counts never
// change. Returns false when there is no trunk or no charColor data.
export function charTrunk(tree) {
  const color = tree?.charColor
  if (!color || !(tree?.trunkCount > 0) || !tree.mats?.[1]) return false
  tree.mats[1].color = typeof color === 'string' ? parseInt(color.slice(1), 16) : color
  tree.charred = true
  return true
}

// W2-C2 (plan SE-FIXUP-1012): treeDensity (0-100, se.settings row produced by
// W1) -> scatter density (trees per world-u^2). Mapping rule is DATA (passed
// in as cfg { densityMax, densityDefaultPct } from data/tree.json): density =
// densityMax * clamp(pct, 0, 100) / 100. pct undefined -> the DATA default pct
// (never an inline magic number). 0 -> 0 (zero trees); 100 -> densityMax.
export function densityFor(pct, cfg) {
  const max = cfg?.densityMax
  if (typeof max !== 'number' || !(max > 0)) return 0
  const p = typeof pct === 'number' && Number.isFinite(pct) ? pct : (cfg?.densityDefaultPct ?? 0)
  return (max * Math.max(0, Math.min(100, p))) / 100
}

// Deterministic landscape scatter: mulberry32(seed) rejection sampling over
// the margin-clipped bounds; a candidate is kept when its column has ground
// (surfaceYAt non-null) and it respects minSeparation from kept spots.
// Density (spots per world-u^2) sets the target count, capped by maxTrees;
// `tries` bounds the rejection loop (iterative, always terminates).
export function scatterTrees(opts) {
  const rng = mulberry32(opts.seed ?? 0)
  const xMin = opts.xMin + (opts.margin ?? 0)
  const xMax = opts.xMax - (opts.margin ?? 0)
  const zMin = opts.zMin + (opts.margin ?? 0)
  const zMax = opts.zMax - (opts.margin ?? 0)
  const area = Math.max(0, (xMax - xMin) * (zMax - zMin))
  const target = Math.min(opts.maxTrees ?? 20, Math.round(area * (opts.density ?? 0)))
  const minSep2 = (opts.minSeparation ?? 0) * (opts.minSeparation ?? 0)
  const tries = opts.tries ?? 4000
  const kept = []
  if (target <= 0 || area <= 0) return kept
  for (let t = 0; t < tries && kept.length < target; t++) {
    const x = xMin + rng() * (xMax - xMin)
    const z = zMin + rng() * (zMax - zMin)
    const y = opts.surfaceYAt ? opts.surfaceYAt(x, z) : 0
    if (y === null || y === undefined) continue
    let ok = true
    for (let k = 0; k < kept.length; k++) {
      const dx = kept[k].x - x, dz = kept[k].z - z
      if (dx * dx + dz * dz < minSep2) { ok = false; break }
    }
    if (ok) kept.push({ x, y, z })
  }
  return kept
}
