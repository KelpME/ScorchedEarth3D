/**
 * shell_cam — PURE shell-tracking camera math (SE-CINEMATIC-1013, contract
 * C5). No DOM, no three import: plain numbers only, pins in
 * test/unit/shell_cam.test.js, style matched to cam_rig.js.
 *
 * Two modes, chosen by the existing follow-mode toggle (W2 wires the branch):
 *  - follow ON  → chasePose: cam rides BEHIND/ABOVE the shell, lookAt ahead of
 *    it along the velocity (cam_rig follow family convention: dir =
 *    (sin(bearing), cos(bearing)), bearing = atan2(vx, vz) — bearing 0 = +Z).
 *  - follow OFF → trackPose: from wherever the camera currently is, the focus
 *    point GLIDES toward the shell (exponential ease, frame-rate independent)
 *    and the radius eases toward the track zoom — pan/zoom, never a teleport.
 *
 * All tunables are DATA (data/camera.json shellTrack block, contract C6) —
 * zero literals here; every numeric default is echoed by a unit pin.
 */

/**
 * Follow-mode chase pose for a shell in flight.
 * INVARIANT (test-pinned): dot(camPos − shellPos, dir) < 0 — strictly behind,
 * same invariant as cam_rig.followPose. backDist is clamped into the
 * zoom.followMinBackDist..followMaxBackDist span (passed in as data).
 * @param {object} o {
 *   shell {x,y,z} current shell position,
 *   vel {x,y,z} shell velocity (y ignored for the ground bearing),
 *   backDist=9, height=4.5, lookAhead=0,
 *   minBackDist=5, maxBackDist=40
 * }
 * @returns {{x,y,z,lookAt:{x,y,z}}}
 */
export function chasePose({ shell = { x: 0, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 0 }, backDist = 9, height = 4.5, lookAhead = 0, minBackDist = 5, maxBackDist = 40 }) {
  // Ground bearing from velocity (engine forwardFromYaw convention: 0 = +Z).
  // A near-zero horizontal velocity (shell at the apex / straight up) falls
  // back to bearing 0 (+Z) so the pose stays well-defined.
  const hspeed = Math.hypot(vel.x, vel.z)
  const bearing = hspeed > 1e-9 ? Math.atan2(vel.x, vel.z) : 0
  const dir = { x: Math.sin(bearing), z: Math.cos(bearing) }
  const back = Math.min(maxBackDist, Math.max(minBackDist, backDist))
  return {
    x: shell.x - dir.x * back,
    y: shell.y + height,
    z: shell.z - dir.z * back,
    lookAt: {
      x: shell.x + dir.x * lookAhead,
      y: shell.y,
      z: shell.z + dir.z * lookAhead,
    },
  }
}

/**
 * Non-follow track step (pure — one ease step per call; W2 feeds it the
 * current focus/radius each frame). Moves the focus point a fraction
 * `panEase` of the remaining distance toward the shell (exponential
 * smoothing, frame-rate independent) and eases the radius toward
 * `zoomRadius` by `zoomEase`. The camera GLIDES — each step covers only a
 * fraction of the gap, so a far shot pans/zooms in, never teleports.
 * Focus y eases too (shells climb; the look should follow the arc).
 * @param {object} o {
 *   focus {x,y,z} current focus point,
 *   radius current camera radius,
 *   shell {x,y,z} shell position,
 *   panEase=0.12 (fraction of remaining focus gap per step),
 *   zoomRadius=90, zoomEase=0.10 (fraction of remaining radius gap per step)
 * }
 * @returns {{x:number,y:number,z:number,radius:number}}
 */
export function trackPose({ focus = { x: 0, y: 0, z: 0 }, radius = 42, shell = { x: 0, y: 0, z: 0 }, panEase = 0.12, zoomRadius = 90, zoomEase = 0.10 }) {
  return {
    x: focus.x + (shell.x - focus.x) * panEase,
    y: focus.y + (shell.y - focus.y) * panEase,
    z: focus.z + (shell.z - focus.z) * panEase,
    radius: radius + (zoomRadius - radius) * zoomEase,
  }
}

/**
 * Flight-window gate helper (pure predicate, C5 "spawn → materialize/impact").
 * True while the shell is alive in the tracked window. `done` covers the
 * impact/materialize edge: once true, tracking disengages for that shot.
 * @param {object} s { active:boolean, done:boolean }
 * @returns {boolean}
 */
export function trackActive({ active = false, done = false }) {
  return active === true && done !== true
}
