/**
 * Flock — GENERIC, asset-agnostic flocking system (fish, birds, bats, bees…).
 *
 * A built-in engine global system, registered like the camera-rig / audio-emitter
 * built-in scripts so ANY game can use it with no copied files: add
 * `{ name: 'flock', params: {...} }` to a scene's `systems` array and spawn
 * entities carrying a `flock` component (group-scoped), and they flock.
 *
 * THE LESSONS LEARNED, encoded:
 *   1. SMOOTH HEADING, never derive yaw from a raw velocity vector. When
 *      steering nearly cancels velocity (crowded, bouncing off a wall) the
 *      speed → 0 and `atan2(vx,vz)` snaps 180° every frame — creatures SPIN in
 *      place. Instead keep a persistent heading angle + cruise speed, and turn
 *      the heading toward the steering direction at a bounded TURN RATE.
 *   2. MODEL FORWARD AXIS. The engine's yaw convention treats +Z as forward
 *      (renderer Euler(0,yaw,0)). A model whose nose points along another axis
 *      must be rotated at import (rotationY) so it leads nose-first; otherwise
 *      it swims backwards or spins. This system only sets yaw/pitch; the model
 *      import handles forward-axis normalization.
 *   3. AXIS-AWARE. `xz` mode (fish, ground bees) keeps y fixed and steers only
 *      in the XZ plane; `xyz` mode (birds, bats) also steers vertically.
 *
 * A system drives every entity with a `flock` component. The component marks
 * GROUP membership (several independent flocks coexist); all other tuning lives
 * in the system params. Equally usable by the AI (write a scene.systems entry +
 * spawn flock-component entities) and the human (the editor's Flocking tool
 * writes the same data).
 *
 * Editor-convention descriptor: { name, label, description, params, init, update }.
 */
export const flockSystem = {
  name: 'flock',
  label: 'Flock',
  description: 'Drives every entity carrying a `flock` component (group-scoped). Generic for fish/birds/bats/bees. Smooth-heading so creatures sweep, never spin.',
  params: {
    group: { type: 'string', default: 'flock', label: 'Group' },
    axis: { type: 'string', default: 'xz', label: 'Axis (xz = fish/bees, xyz = birds/bats)' },
    separation: { type: 'number', default: 1.0, label: 'Separation' },
    alignment: { type: 'number', default: 1.0, label: 'Alignment' },
    cohesion: { type: 'number', default: 1.0, label: 'Cohesion' },
    boundary: { type: 'number', default: 2.5, label: 'Wall avoid' },
    viewRadius: { type: 'number', default: 2.2, label: 'View radius' },
    avoidRadius: { type: 'number', default: 1.1, label: 'Avoid radius' },
    cruiseSpeed: { type: 'number', default: 1.2, label: 'Cruise speed' },
    turnRate: { type: 'number', default: 2.2, label: 'Turn rate (rad/s)' },
    minX: { type: 'number', default: -1.8 },
    maxX: { type: 'number', default: 1.8 },
    minY: { type: 'number', default: 0.4 },
    maxY: { type: 'number', default: 1.2 },
    minZ: { type: 'number', default: -4.3 },
    maxZ: { type: 'number', default: 4.3 },
  },

  init(params) {
    this._p = params
  },

  update(dt, api) {
    const W = this._p
    if (!W) return
    const axis3 = W.axis === 'xyz'
    const GRID = 3.0

    // Gather flock members for this group.
    const members = []
    for (const id of api.query({ has: 'flock' })) {
      const rec = api.entity(id)
      const fc = rec && rec.components && rec.components.flock
      if (!fc) continue
      if (fc.group !== undefined && fc.group !== W.group) continue
      const tf = rec.components.transform
      if (!tf) continue
      members.push({
        id,
        x: tf.x, y: tf.y, z: tf.z,
        heading: fc.heading != null ? fc.heading : (tf.yaw != null ? tf.yaw : 0),
        pitch: fc.pitch != null ? fc.pitch : (tf.pitch != null ? tf.pitch : 0),
        cruise: fc.cruise || W.cruiseSpeed,
        comp: fc,
      })
    }
    if (members.length < 2) return

    // Spatial hash grid (XZ for neighbor lookup in both modes).
    const grid = new Map()
    const key = (cx, cz) => cx * 100000 + cz
    for (const f of members) {
      const k = key(Math.floor(f.x / GRID), Math.floor(f.z / GRID))
      if (!grid.has(k)) grid.set(k, [])
      grid.get(k).push(f)
    }

    const limit = (av, max) => {
      const m = Math.abs(av)
      return m > max && m > 0 ? av * (max / m) : av
    }

    for (const f of members) {
      // --- Steering accumulation ---
      let sx = 0, sz = 0, sy = 0, nSep = 0
      let ax = 0, az = 0, ay = 0, nAlign = 0
      let cx = 0, cz = 0, cy = 0, nCoh = 0
      const r2 = W.viewRadius * W.viewRadius
      const avoid2 = W.avoidRadius * W.avoidRadius
      const minCx = Math.floor((f.x - W.viewRadius) / GRID)
      const maxCx = Math.floor((f.x + W.viewRadius) / GRID)
      const minCz = Math.floor((f.z - W.viewRadius) / GRID)
      const maxCz = Math.floor((f.z + W.viewRadius) / GRID)
      const nbrs = []
      for (let gx = minCx; gx <= maxCx; gx++) {
        for (let gz = minCz; gz <= maxCz; gz++) {
          const cell = grid.get(key(gx, gz))
          if (!cell) continue
          for (const o of cell) {
            if (o === f) continue
            const dx = o.x - f.x
            const dz = o.z - f.z
            if (dx * dx + dz * dz < r2) nbrs.push(o)
          }
        }
      }
      for (const o of nbrs) {
        const dx = f.x - o.x
        const dz = f.z - o.z
        const d2 = dx * dx + dz * dz
        const d = Math.sqrt(d2) || 0.0001
        if (d2 < avoid2) { sx += (dx / d) / d; sz += (dz / d) / d; nSep++ }
        ax += o.x - f.x; az += o.z - f.z; nAlign++
        cx += o.x; cz += o.z; nCoh++
        if (axis3) { sy += (o.y - f.y) / (d2 + 1e-4); ay += o.y - f.y; cy += o.y }
      }

      let steerX = 0, steerZ = 0, steerY = 0
      const fwdX = Math.sin(f.heading) * f.cruise * Math.cos(f.pitch)
      const fwdZ = Math.cos(f.heading) * f.cruise * Math.cos(f.pitch)
      const maxSpeed = W.cruiseSpeed

      if (nSep > 0) {
        steerX += (limit(sx, maxSpeed) - fwdX) * W.separation
        steerZ += (limit(sz, maxSpeed) - fwdZ) * W.separation
        if (axis3) steerY += (limit(sy, maxSpeed) - f.pitch * f.cruise) * W.separation
      }
      if (nAlign > 0) {
        const am = Math.hypot(ax, az) || 1
        steerX += (limit(ax / am * maxSpeed, maxSpeed) - fwdX) * W.alignment
        steerZ += (limit(az / am * maxSpeed, maxSpeed) - fwdZ) * W.alignment
        if (axis3 && nAlign > 0) steerY += (limit(ay / nAlign, maxSpeed) - f.pitch * f.cruise) * W.alignment
      }
      if (nCoh > 0) {
        const gx = cx / nCoh - f.x
        const gz = cz / nCoh - f.z
        const gm = Math.hypot(gx, gz) || 1
        steerX += (limit(gx / gm * maxSpeed, maxSpeed) - fwdX) * W.cohesion
        steerZ += (limit(gz / gm * maxSpeed, maxSpeed) - fwdZ) * W.cohesion
        if (axis3) steerY += (limit(cy / nCoh - f.y, maxSpeed) - f.pitch * f.cruise) * W.cohesion
      }

      // Wall avoidance.
      const m = 0.8
      if (f.x - W.minX < m) steerX += W.boundary * (1 - (f.x - W.minX) / m)
      if (W.maxX - f.x < m) steerX -= W.boundary * (1 - (W.maxX - f.x) / m)
      if (f.z - W.minZ < m) steerZ += W.boundary * (1 - (f.z - W.minZ) / m)
      if (W.maxZ - f.z < m) steerZ -= W.boundary * (1 - (W.maxZ - f.z) / m)
      if (axis3) {
        if (f.y - W.minY < m) steerY += W.boundary * (1 - (f.y - W.minY) / m)
        if (W.maxY - f.y < m) steerY -= W.boundary * (1 - (W.maxY - f.y) / m)
      }

      // --- Smooth heading integration (Lesson 1) ---
      const steerMag = Math.hypot(steerX, steerZ)
      const desired = steerMag > 1e-4 ? Math.atan2(steerX, steerZ) : f.heading
      let dh = desired - f.heading
      while (dh > Math.PI) dh -= Math.PI * 2
      while (dh < -Math.PI) dh += Math.PI * 2
      const maxTurn = W.turnRate * dt
      if (Math.abs(dh) > maxTurn) dh = Math.sign(dh) * maxTurn
      f.heading += dh
      f.heading = ((f.heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)

      // Vertical turn for xyz mode (bounded so birds/bats don't flip end-over-end).
      let fwd = f.cruise
      if (axis3) {
        const maxPitchTurn = W.turnRate * dt * 0.6
        const dp = limit(steerY, maxSpeed)
        let dp2 = Math.atan2(dp, fwd)
        if (Math.abs(dp2) > maxPitchTurn) dp2 = Math.sign(dp2) * maxPitchTurn
        f.pitch += dp2
        f.pitch = Math.max(-1.2, Math.min(1.2, f.pitch))
      }

      // Advance at cruise speed along heading/pitch.
      const cp = Math.cos(f.pitch)
      const vx = Math.sin(f.heading) * fwd * cp
      const vz = Math.cos(f.heading) * fwd * cp
      const vy = Math.sin(f.pitch) * fwd
      f.x += vx * dt
      f.z += vz * dt
      f.y = axis3 ? f.y + vy * dt : W.minY // xz mode: keep at the band floor
      f.x = Math.max(W.minX, Math.min(W.maxX, f.x))
      f.z = Math.max(W.minZ, Math.min(W.maxZ, f.z))
      if (axis3) f.y = Math.max(W.minY, Math.min(W.maxY, f.y))

      // Write back to entity.
      const rec = api.entity(f.id)
      const tf = rec && rec.components && rec.components.transform
      if (tf) {
        tf.x = f.x
        tf.y = f.y
        tf.z = f.z
        tf.yaw = f.heading
        if (axis3) tf.pitch = f.pitch
      }
      f.comp.heading = f.heading
      f.comp.pitch = f.pitch
      f.comp.vx = vx
      f.comp.vz = vz
      f.comp.updated = true
    }
  },
}

/** Built-in flock system registry entry: { flock: flockSystem }. */
export const BUILTIN_FLOCK_SYSTEMS = { flock: flockSystem }
/** Metadata for the editor Systems picker. */
export const BUILTIN_FLOCK_SYSTEM_METAS = [flockSystem]
