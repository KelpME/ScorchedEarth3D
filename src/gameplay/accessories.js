/**
 * S4 — accessories: pure effect model (unit-pure layer; live wiring is a LATER leaf).
 *
 * Pure functions + registry over plain objects. NEVER imports the engine or
 * systems/. Data: data/accessories.json (15 records, manual:L1185-L1204 table).
 * Every encoded rule cites manual:L####; anything the manual doesn't pin is
 * a _placeholder (declared in a comment AND an exported constant).
 * Fail-noisy doctrine: unknown accessory id -> console.error naming it, no effect.
 */

import accessoryData from '../../data/accessories.json' with { type: 'json' };
import ppData from '../../data/physics-presets.json' with { type: 'json' };

// W5 purge: the repair cap mirrors battleLoop.MAX_HULL — now DATA
// (data/physics-presets.json .battle.maxHull), fail-loud on malformed data.
const MAX_HULL_DATA = (() => {
  const v = ppData && ppData.battle ? ppData.battle.maxHull : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new TypeError(`[se/accessories] data/physics-presets.json .battle.maxHull missing/non-numeric — fix the data file, no JS fallback exists`);
  }
  return v;
})();

const RECORDS = new Map(accessoryData.accessories.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------
// W5 purge (plan SE-COMPLETE-1012 §4): the old numeric law literals
// (SHIELD_ABSORB / SHIELD_DIRECT_HIT_DAMAGE / BATTERY_* / SUPER_MAG_* /
// FUEL_TANK_UNITS / MAG_DEFLECTOR_* / PARACHUTE_SAFETY / ARMOR_ABSORB) are
// GONE — the laws are DATA (data/accessories.json .laws; per-field provenance
// documented there). A malformed block fails LOUD naming the file — no JS
// fallback exists (doctrine).
// ---------------------------------------------------------------------------
function law(key) {
  const v = accessoryData && accessoryData.laws ? accessoryData.laws[key] : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`[se/accessories] data/accessories.json .laws.${key} missing/non-numeric — fix the data file, no JS fallback exists`);
  }
  return v;
}
function lawBlock(key) {
  const v = accessoryData && accessoryData.laws ? accessoryData.laws[key] : undefined;
  if (!v || typeof v !== 'object') {
    throw new TypeError(`[se/accessories] data/accessories.json .laws.${key} missing — fix the data file, no JS fallback exists`);
  }
  return v;
}

/** Loud fail-noisy helper: names the unknown id, returns false (never silent). */
function unknownId(id) {
  console.error(`accessories: unknown accessory id "${id}" — no effect applied`);
  return false;
}

function hasId(accessoryIds, id) {
  if (!accessoryIds) return false;
  return Array.from(accessoryIds).includes(id);
}

// ---------------------------------------------------------------------------
// 1. Shield absorption (manual:L1346-L1366 — behavior described, % NEVER pinned)
// ---------------------------------------------------------------------------
/** _placeholder fractions: the manual describes tiers, never percentages. Laws: data (W5 purge). */
export const SHIELD_ABSORB = Object.freeze(Object.fromEntries(Object.entries(lawBlock('shieldAbsorb')).filter(([, v]) => typeof v === 'number')));

/** _placeholder: "damage the shield slightly" (manual:L1346-L1349) has no number. Laws: data (W5 purge). */
export const SHIELD_DIRECT_HIT_DAMAGE = law('shieldDirectHitDamage');

/**
 * Best single shield applies, NOT stacking (manual:L1346-L1366: one shield per tank).
 * -> { absorbed, remaining }
 */
export function absorbShield({ accessoryIds, rawDamage }) {
  let best = 0;
  for (const id of Object.keys(SHIELD_ABSORB)) {
    if (hasId(accessoryIds, id)) best = Math.max(best, SHIELD_ABSORB[id]);
  }
  for (const id of accessoryIds ?? []) {
    if (!RECORDS.has(id)) unknownId(id);
  }
  const absorbed = rawDamage * best;
  return { absorbed, remaining: rawDamage - absorbed };
}

/**
 * Direct-hit rule for `shield` (manual:L1249ff effect string; prose manual:L1346-L1349):
 * a direct hit does NOT explode but slightly damages the shield.
 */
export function shieldDirectHit({ accessoryIds }) {
  if (hasId(accessoryIds, 'shield')) {
    return { explodes: false, shieldDamage: SHIELD_DIRECT_HIT_DAMAGE };
  }
  return { explodes: true, shieldDamage: 0 };
}

// ---------------------------------------------------------------------------
// 2. Power mods
// ---------------------------------------------------------------------------
/** Battery: 10% energy each (record manual:L1195; prose manual:L1332-L1337). Laws: data (W5 purge). */
export const BATTERY_POWER_STEP = law('batteryPowerStep');
/** _placeholder cap: the manual never caps how many batteries boost one shot. Laws: data. */
export const BATTERY_POWER_CAP = law('batteryPowerCap');
/** Super Mag: best power boost (manual:L1363-L1366 "best shields of all"). Laws: data. */
export const SUPER_MAG_POWER_STEP = law('superMagPowerStep');

export function powerMods({ accessoryIds, basePower01 }) {
  let batteries = 0;
  let unknownSeen = false;
  for (const id of accessoryIds ?? []) {
    if (id === 'battery') batteries += 1;
    else if (id === 'super_mag') basePower01 += SUPER_MAG_POWER_STEP;
    else if (!RECORDS.has(id) && !unknownSeen) { unknownId(id); unknownSeen = true; }
  }
  const boosted = basePower01 + Math.min(batteries * BATTERY_POWER_STEP, BATTERY_POWER_CAP);
  return Math.min(1, Math.max(0, boosted)); // clamped 0..1
}

// ---------------------------------------------------------------------------
// 3. Fuel mods (manual:L1388-L1392: each fuel tank = 10 units of fuel)
// ---------------------------------------------------------------------------
export const FUEL_TANK_UNITS = law('fuelTankUnits'); // manual:L1388-L1392 pin, data-carried (W5 purge)

export function fuelMods({ accessoryIds, baseBudgetUnits }) {
  let budget = baseBudgetUnits;
  for (const id of accessoryIds ?? []) {
    if (id === 'fuel_tank') budget += FUEL_TANK_UNITS;
    else if (!RECORDS.has(id)) unknownId(id);
  }
  return budget;
}

// ---------------------------------------------------------------------------
// 4. Mag Deflector (manual:L1339-L1344: upward force near/over tank; fails on fast falls)
// ---------------------------------------------------------------------------
/** _placeholder accel: manual gives force qualitatively, no magnitude. Laws: data (W5 purge). */
export const MAG_DEFLECTOR_ACCEL = law('magDeflectorAccel');
/** _placeholder: "falls down fast enough" is never quantified. Laws: data. */
export const MAG_FALL_FAIL_SPEED = law('magFallFailSpeed');

export function magDeflectorForce({ accessoryIds, projectile, distance }) {
  if (!hasId(accessoryIds, 'mag_deflector')) return 0;
  // "fails on fast falls" -> |vy| strictly over the fail speed deflects nothing
  if (Math.abs(projectile?.vy ?? 0) > MAG_FALL_FAIL_SPEED) return 0;
  void distance; // executor leaf owns the proximity check; kept in the signature
  return MAG_DEFLECTOR_ACCEL;
}

// ---------------------------------------------------------------------------
// 5. Guidance steering — PURE per-frame nudges (a later executor leaf calls these)
// ---------------------------------------------------------------------------
/** _placeholder: heat detector "in range" distance is never pinned. */
export const HEAT_RANGE = 8;

/**
 * guideStep({ accessoryId, projectile:{x,y,z,vx,vy,vz}, target:{x,y,z}, dt }) -> {vx,vy,vz}
 * No Math.random anywhere. Unknown id -> loud + unchanged.
 */
export function guideStep({ accessoryId, projectile, target, dt }) {
  void dt; // per-frame contract; pure step needs no time for these kinematics
  const { vx, vy, vz } = projectile;
  if (!RECORDS.has(accessoryId)) {
    unknownId(accessoryId);
    return { vx, vy, vz };
  }
  if (!target) return { vx, vy, vz }; // no target chosen -> no-op (manual:L1228-L1241)

  switch (accessoryId) {
    case 'heat_guidance': {
      // manual:L1249-L1253: once in range, guide in a straight line to the tank.
      const dx = target.x - projectile.x, dy = target.y - projectile.y, dz = target.z - projectile.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > HEAT_RANGE || dist === 0) return { vx, vy, vz };
      const speed = Math.hypot(vx, vy, vz); // preserve speed, aim straight at target
      const k = speed / dist;
      return { vx: dx * k, vy: dy * k, vz: dz * k };
    }
    case 'horz_guidance':
      // manual:L1270-L1273: horizontal straight line as soon as even with target.
      if (projectile.y === target.y) return { vx, vy: 0, vz };
      return { vx, vy, vz };
    case 'vert_guidance':
      // manual:L1275-L1281: once above the target (x/z over it), head straight down.
      if (projectile.x === target.x && projectile.z === target.z) return { vx: 0, vy, vz: 0 };
      return { vx, vy, vz };
    case 'ballistic_guidance':
    case 'lazy_boy':
      // manual:L1259-L1268 / L1283-L1294: power solved at fire time — S6's solver, not a
      // per-frame nudge. Velocity unchanged; solvePower() is the pinned seam.
      return { vx, vy, vz };
    default:
      unknownId(accessoryId); // valid record, no steering behavior (guidance handled above)
      return { vx, vy, vz };
  }
}

/**
 * W5 (plan SE-COMPLETE-1012 §4): the S6 ballistic solver — the old STUB
 * (console.error + null) is REPLACED by the closed-form vacuum solution.
 * Seam contract (pinned):
 *   solvePower({ origin, angleDeg, target, gravity, wind }) ->
 *     { power, speed, velocity3 } — the POWER (0..1, aim.js speed law
 *     speed = 12 + power*28) whose shot at angleDeg reaches target, plus the
 *     equivalent launch speed and the launchVelocity3-shaped velocity vector
 *     (bearing preserved from origin->target on the XZ plane).
 *     null + LOUD console.error when unreachable (target above the angle's
 *     apex envelope) or bad input — fail-noisy, never a silent guess.
 *   wind: constant-accel effects (viscosity/wind) are NOT in the closed form
 *   — the manual breaks guidance under viscosity (L1834) and the wind-x-
 *   guidance semantics remain an open plan question (Q5); a non-zero wind
 *   logs ONCE per call site that the solve is vacuum-only (loud, benign).
 * Vacuum kinematics: with launch angle θ above horizontal and target at
 * horizontal distance d, height Δh:
 *   v² = g·d² / (2·cos²θ·(d·tanθ − Δh))   (reachable iff d·tanθ > Δh)
 * PURE: no Math.random, no clock, no DOM.
 */
export function solvePower({ origin, angleDeg, target, gravity, wind } = {}) {
  if (!origin || typeof origin.x !== 'number' || typeof origin.z !== 'number') {
    console.error('[se/accessories] solvePower needs origin {x,y,z} — guidance no-op');
    return null;
  }
  if (typeof angleDeg !== 'number' || !Number.isFinite(angleDeg) || angleDeg <= 0 || angleDeg >= 90) {
    console.error(`[se/accessories] solvePower needs 0 < angleDeg < 90, got ${JSON.stringify(angleDeg)} — guidance no-op`);
    return null;
  }
  if (!target || typeof target.x !== 'number' || typeof target.z !== 'number') {
    console.error('[se/accessories] solvePower needs target {x,y,z} — guidance no-op');
    return null;
  }
  if (typeof gravity !== 'number' || !Number.isFinite(gravity) || gravity <= 0) {
    console.error(`[se/accessories] solvePower needs numeric gravity > 0, got ${JSON.stringify(gravity)} — guidance no-op`);
    return null;
  }
  if (wind && ((wind.x ?? 0) !== 0 || (wind.z ?? 0) !== 0)) {
    console.error('[se/accessories] solvePower: vacuum solve ignores wind accel (manual:L1834 breaks guidance; plan Q5 open) — power is ballistic-only');
  }
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const d = Math.hypot(dx, dz); // horizontal distance
  const h = (target.y ?? 0) - (origin.y ?? 0); // height delta
  const DEG = Math.PI / 180;
  const tan = Math.tan(angleDeg * DEG);
  const cos2 = Math.cos(angleDeg * DEG) ** 2;
  const denom = 2 * cos2 * (d * tan - h);
  if (!(denom > 0) || !(d > 0)) {
    console.error(`[se/accessories] solvePower: target unreachable at ${angleDeg}deg (d=${d.toFixed(2)}, dh=${h.toFixed(2)}) — the angle's ballistic envelope never touches it`);
    return null;
  }
  const speed = Math.sqrt(gravity * d * d / denom);
  // aim.js speed law (single source of the 12 + power*28 pin): invert it.
  const power = (speed - 12) / 28;
  if (!(power >= 0) || power > 1) {
    console.error(`[se/accessories] solvePower: required speed ${speed.toFixed(2)} u/s is outside the power law (power=${power.toFixed(3)}) — unreachable with this engine's speed range`);
    return null;
  }
  // velocity3: bearing from origin -> target on XZ, elevation = angleDeg,
  // TOTAL magnitude exactly the solved speed (launchVelocity3-shaped).
  const cos = Math.cos(angleDeg * DEG);
  const ux = dx / (d || 1), uz = dz / (d || 1);
  const planar = speed * cos;
  return {
    power,
    speed,
    velocity3: { vx: ux * planar, vy: tan * planar, vz: uz * planar },
  };
}

// ---------------------------------------------------------------------------
// 6. Parachute fall damage (manual:L1313-L1330: default deployed, safety threshold 5;
//    record manual:L1194 "threshold default 5")
// ---------------------------------------------------------------------------
export const PARACHUTE_SAFETY = law('parachuteSafety'); // manual:L1194 threshold default 5 (data-carried, W5 purge)

/**
 * Chute deploys when fall distance reaches the safety threshold.
 * Count decrement is NOT ours — inventory owns counts.
 */
export function fallDamageMods({ accessoryIds, fallDistanceUnits, rawFallDamage }) {
  for (const id of accessoryIds ?? []) {
    if (!RECORDS.has(id)) unknownId(id);
  }
  if (hasId(accessoryIds, 'parachute') && fallDistanceUnits >= PARACHUTE_SAFETY) {
    return { damage: 0, chuteDeployed: true };
  }
  return { damage: rawFallDamage, chuteDeployed: false };
}

// ---------------------------------------------------------------------------
// 7. Contact Trigger (manual:L1394-L1401: explodes the moment it touches; tunneling off)
// ---------------------------------------------------------------------------
export function explodeOnContact({ accessoryIds }) {
  return hasId(accessoryIds, 'contact_trigger');
}

// ---------------------------------------------------------------------------
// 8. Auto Defense — pure eligibility ONLY (manual:L1368-L1374).
//    The one-time-cost scaling to rounds left is economy's, not ours.
// ---------------------------------------------------------------------------
export function autoDefenseEligible({ accessoryIds, round, roundsTotal }) {
  void round; void roundsTotal; // cost scaling lives in economy
  return hasId(accessoryIds, 'auto_defense');
}

// ---------------------------------------------------------------------------
// 9. describeActive — [{id, kind, summary}] for a future HUD (summary = record.effect)
// ---------------------------------------------------------------------------
export function describeActive(accessoryIds) {
  const rows = [];
  for (const id of accessoryIds ?? []) {
    const rec = RECORDS.get(id);
    if (!rec) { unknownId(id); continue; }
    rows.push({ id: rec.id, kind: rec.kind, summary: rec.effect });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 10. ARMOR — toggleable per player (W2-C-sibling, plan SE-COMPLETE-1012;
//     USER DIRECTIVE). Record _placeholder: armor is NOT in the manual
//     L1185-L1204 table; the absorption fraction is UNPINNED data.
//     Armor ON = Armor1-4 model nodes visible + absorption; OFF = hidden +
//     no absorption. The toggle affordance is the V hotkey in main.js (data-
//     driven record above documents it).
// ---------------------------------------------------------------------------
/** _placeholder: the manual never lists armor — fraction is a declared pin. Laws: data (W5 purge). */
export const ARMOR_ABSORB = law('armorAbsorb');

/** Pure absorption: owned armor + toggle ON halves the raw damage. */
export function absorbArmor({ accessoryIds, armorOn, rawDamage }) {
  for (const id of accessoryIds ?? []) {
    if (!RECORDS.has(id)) unknownId(id);
  }
  const owned = hasId(accessoryIds, 'armor');
  if (owned && armorOn === true) {
    const absorbed = rawDamage * ARMOR_ABSORB;
    return { absorbed, remaining: rawDamage - absorbed };
  }
  return { absorbed: 0, remaining: rawDamage };
}

/**
 * Apply absorption to a battleLoop onBlast() results array
 * ([{id, damage, killed, ...}]) against the LIVE battle players — the hull
 * has already been reduced, so absorption RESTORES the absorbed portion
 * (capped at 100 hull = battleLoop MAX_HULL). Mutates player.hull and
 * annotates result.absorbed. Unknown result ids (mirrors gone) are no-ops —
 * the blast path already failed loud upstream.
 */
export function applyArmorAbsorption(results, players) {
  const MAX_HULL = MAX_HULL_DATA; // data: physics-presets .battle.maxHull (W5 purge)
  for (const r of results ?? []) {
    const p = (players ?? []).find((pl) => pl.id === r?.id);
    if (!p || !(r.damage > 0)) continue;
    const ownedIds = Object.keys(p.inventory?.accessories ?? {}).filter((id) => (p.inventory.accessories[id] ?? 0) > 0);
    const { absorbed } = absorbArmor({ accessoryIds: ownedIds, armorOn: p.armorOn, rawDamage: r.damage });
    if (absorbed > 0) {
      r.absorbed = absorbed;
      p.hull = Math.min(MAX_HULL, p.hull + absorbed);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Registry: createAccessoryMods({ ownedIds }) — ownedIds = Map|object id -> count
// ---------------------------------------------------------------------------
export function createAccessoryMods({ ownedIds } = {}) {
  const entries = ownedIds instanceof Map
    ? [...ownedIds.entries()]
    : Object.entries(ownedIds ?? {});
  const owned = new Set(entries.filter(([, count]) => (count ?? 0) > 0).map(([id]) => id));

  return {
    has(id) {
      if (!RECORDS.has(id)) { unknownId(id); return false; }
      return owned.has(id);
    },
    modsFor(id) {
      const rec = RECORDS.get(id);
      if (!rec || !owned.has(id)) return null;
      const row = { id: rec.id, kind: rec.kind, summary: rec.effect };
      if (id in SHIELD_ABSORB) row.absorb = SHIELD_ABSORB[id];
      return row;
    },
  };
}
