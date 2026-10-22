export const DEG = Math.PI / 180;
export const clampDeg = (d, lo = 0, hi = 180) => Math.min(hi, Math.max(lo, d));
export const AIM_SIGN = 1;                     // user-verified: barrel dug with -1 (2026-10-11); +1 raises the visual arc
export function barrelRotX(angleRad, restX = 0.005313325003629333) { return restX + AIM_SIGN * angleRad; }
export function muzzleDir(angleDeg, facing) {
  const a = clampDeg(angleDeg) * DEG;
  return { x: facing * Math.cos(a), y: Math.sin(a) };
}
export function launchVelocity(angleDeg, power, facing) {
  const d = muzzleDir(angleDeg, facing);
  const speed = 12 + power * 28;               // 12..40 u/s (T-G1: x2 of 6+power*14 — range x4 for the 4x arena)
  return { vx: d.x * speed, vy: d.y * speed };
}

// ---- X3b: 3D aim (bearing + elevation), DEC for the drive/aim model ----

/** Unit muzzle direction: elevation angleDeg (0 = flat, 90 = straight up), bearingDeg (0 = +Z, the engine forwardFromYaw convention). */
export function muzzleDir3(angleDeg, bearingDeg) {
  const a = clampDeg(angleDeg) * DEG;
  const b = bearingDeg * DEG;
  return { x: Math.cos(a) * Math.sin(b), y: Math.sin(a), z: Math.cos(a) * Math.cos(b) };
}

/** 3D launch velocity: same 12 + power*28 speed law (T-G1), aimed in 3D. */
export function launchVelocity3(angleDeg, power, bearingDeg) {
  const d = muzzleDir3(angleDeg, bearingDeg);
  const speed = 12 + power * 28;
  return { vx: d.x * speed, vy: d.y * speed, vz: d.z * speed };
}

/** World shell origin from the tank / Barrel / ShellSpawn transforms (PURE).
 * ShellSpawn offset is Barrel-local: Rx(pitch) applies the barrel's live
 * elevation, then the assembled offset is rotated by the hull yaw (Ry) and
 * added to the tank root position. Single derivation shared by BOTH fire
 * paths (aim_control script + main.js Space key) — they must never drift. */
export function shellWorldOrigin(tank, barrel, spawn) {
  const pitch = barrel?.rot?.x ?? 0;
  const yaw = tank?.yaw ?? 0;
  const py = (spawn?.y ?? 0) * Math.cos(pitch) - (spawn?.z ?? 0) * Math.sin(pitch);
  const pz = (spawn?.y ?? 0) * Math.sin(pitch) + (spawn?.z ?? 0) * Math.cos(pitch);
  const ox = (barrel?.x ?? 0) + (spawn?.x ?? 0);
  const oy = (barrel?.y ?? 0) + py;
  const oz = (barrel?.z ?? 0) + pz;
  return {
    x: (tank?.x ?? 0) + ox * Math.cos(yaw) + oz * Math.sin(yaw),
    y: (tank?.y ?? 0) + oy,
    z: (tank?.z ?? 0) - ox * Math.sin(yaw) + oz * Math.cos(yaw),
  };
}

/** SHELL BEARING (user-verified 2026-10-11): the hull's visual front is
 * OPPOSITE the raw yaw vector — shells launched along yaw crossed 180°.
 * Both fire paths MUST go through this (single source, no drift). */
export function shellBearingRad(yawRad) { return yawRad + Math.PI; }

/** W2-Cb maxPower seam: the EFFECTIVE shot power = min(aim.power, maxPower)
 * (damage->maxPower law, data/physics-presets .damagePower). maxPower missing
 * (no battle / undamaged) reads as full 1.0. */
export function effectivePower(power, maxPower = 1) {
  return Math.min(Math.max(0, power ?? 0), Math.max(0, maxPower));
}
