// W2-G (plan SE-COMPLETE-1012) — WEATHER + ELEMENT VFX system.
// (a) CLOUDS + GROUND FOG per sky style: cover/count/drift/altitude are DATA
//     (data/physics-presets.json .weather); fog density/color CONSUME the
//     skybox getFogParams() seam (W2-Ca). Drift is deterministic per battle
//     seed (LCG, no Math.random, no wall clock).
// (b) FIRE VFX: burning-terrain cells (napalm hits + lightning fires ignite
//     via the SEAMS below); flame fx entities at burning cells, burn-out over
//     data burnSeconds.
// (c) NAPALM POOLING consumes the pure model src/gameplay/liquid.js; pool fx
//     entities mount on the voxel field at settled pools; a burning pool
//     lights its flame.
// Entities follow the fx_blast_sphere pattern: runtime-spawned named entities
// with transform/render/fx components — editor-visible, colors from DATA.
//
// SEAMS exposed for producers (lightning sibling W2-Cb; napalm executor):
//   window.__se.weather.ignite(x, z, source)  — set the cell at world (x,z) burning
//   window.__se.weather.spill(x, z, amount)   — napalm quantity into the pool sim
//   window.__se.weather.events.push({ type, x, z, amount? }) — queued form;
//     types: 'napalm' | 'ignite' | 'lightning-strike' (the last two alias).
import { getFogParams } from './skybox.js';
import * as THREE from 'three'; // FOG-ALWAYS-ON-FIX: mountStormFog lazily mounts the event's FogExp2
import presets from '../data/physics-presets.json' with { type: 'json' };
import { createPoolState, spill as liqSpill, settle, burn as liqBurn, poolList } from '../src/gameplay/liquid.js';
import { W, Z, V, X_MIN, Z_MIN, cellX, cellZ, cellTopWorldY, FIELD_X_MIN, FIELD_X_MAX, FIELD_Z_MIN, FIELD_Z_MAX } from '../src/voxel3d/constants.js';
import { columnTop } from '../src/voxel3d/field.js';

const WX = presets.weather;
const LIQ = presets.liquid;
const DRESSING = presets.dressing;

// W8-E fail-loud data gate RETIRED (W6-scrub, plans/SE-SCRUB-W6/INVENTORY.md):
// the storm clock is now the SIM clock (wx.t, fixed steps) — a paused/stepped
// sim freezes the fog/cloud ramp exactly like every other system. The
// presets.weather.wallClock data block is retired in data/physics-presets.json
// with a _source note (its only consumer was this gate + the realT accrual
// below, both gone).
// W-A fail-loud data gate: the wind-drift coupling is DATA — no JS literals.
if (!WX.wind || typeof WX.wind.coupling !== 'number') {
  throw new Error('weather: presets.weather.wind.coupling missing — fail loud, no defaults');
}
const STORM_EV = DRESSING.fog && DRESSING.fog.stormEvent;
// CLOUD-TOOL T8: the stormEvent.billboards fail-loud gate is RETIRED — the
// billboards block is a tombstone (its values moved to the storm_front region
// params, plans/CLOUD-MIGRATION.md) and RETIRED data must not be REQUIRED, so
// nothing here gates on or validates it anymore.
// W8-K fail-loud data gate: the fog-box vertical extent anchor, the manual Fog
// modifier row and the persistent exterior block are DATA — no JS literals.
if (typeof DRESSING.fog.boxBottomY !== 'number') {
  throw new Error('weather: presets.dressing.fog.boxBottomY missing — fail loud, no defaults');
}
const FOG_MOD = presets.landscape && presets.landscape.fog;
if (!FOG_MOD || FOG_MOD.default === undefined || !Array.isArray(FOG_MOD.enum)) {
  throw new Error('weather: presets.landscape.fog row missing (the manual Fog modifier) — fail loud, no defaults');
}
const EXT = DRESSING.fog.exterior;
if (EXT) {
  for (const k of ['alwaysOn', 'density', 'span', 'bottomY', 'topY', 'layers', 'color']) {
    if (EXT[k] === undefined) throw new Error(`weather: presets.dressing.fog.exterior.${k} missing — fail loud, no defaults`);
  }
  if (!/^#[0-9a-f]{6}$/.test(EXT.color)) throw new Error('weather: exterior.color must be a #rrggbb hex — fail loud');
}

// W8-A storm-front roll salt: algorithm constant (like the LCG constants), NOT
// game content — separates the storm chain from the cloud/drift chain so the
// two plans never correlate.
const STORM_SALT = 0x5eed;

// mulberry-style LCG: 32-bit state, deterministic bit-for-bit (same doctrine
// as skybox.js / napalm.js).
export function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Pure: ONE W-A wind-drift integration step. The live wind
 * (window.__se.wind = {x,z} world u/s^2, rolled deterministically per
 * round/turn) is folded into the drift through the DATA coupling factor
 * (presets.weather.wind.coupling): the drift DIRECTION and relative SPEED
 * follow the wind sign/magnitude, INTEGRATED over dt — a wind change mid-flight
 * steers the front, it never teleports (an absolute wind*t term would jump by
 * wind * totalT). wind 0 / absent = zero extra offset = the OLD seeded drift
 * exactly. Returns the NEW offsets (caller stores them per entity).
 */
export function windDriftStep(ox, oz, wind, coupling, dt) {
  if (!wind || !Number.isFinite(dt) || dt <= 0) return { ox, oz };
  return {
    ox: ox + (wind.x || 0) * coupling * dt,
    oz: oz + (wind.z || 0) * coupling * dt,
  };
}

/** Pure: ground-fog plan for a style — density/color CONSUME the skybox seam. */
export function fogPlan(style) {
  const seam = getFogParams(style); // { density, color } from the skyStyles DATA
  const layers = Math.max(0, Math.round(seam.density * WX.fog.maxLayers));
  return {
    density: seam.density,
    layers,
    color: seam.color || WX.fog.layerColorFallback, // PLAIN's seeded palette has no static color
    height: WX.fog.layerHeight,
    span: WX.fog.layerSpan,
    opacity: WX.fog.layerOpacityMax,
    bottomY: DRESSING.fog.boxBottomY, // W8-K: boxes stack from below the lowest terrain (down into the earth)
  };
}

/** Pure: fire plan (DATA only). */
export function firePlan() {
  return { burnSeconds: WX.fire.burnSeconds, spread: WX.fire.spread, cellScale: WX.fire.cellScale, coreColor: WX.fire.coreColor, midColor: WX.fire.midColor };
}

// ---- W8-A (plan SE-COMPLETE-1012): STORM FOG AS AN EVENT -------------------
// Fog is a HOSTILE-WEATHER EVENT on the storm sky: a per-round deterministic
// roll (seed chain) decides whether a storm front occurs; when it does, the
// LIVE scene.fog (FogExp2, mounted by dressing mountDressing) density ramps
// baseline -> densityStorm over rise, holds, then falls back to baseline.
// Every magnitude is DATA (dressing.fog.stormEvent); the event gates on the
// data style name (no style literals in JS). Styles without an event keep
// their per-style fog byte-identical: this code never writes scene.fog unless
// a plan for THIS round occurred and its window is open.

/**
 * Pure: per-round storm-front plan. `ev` defaults to the DATA stormEvent block
 * (injectable so tests can pin chance semantics without mutating presets).
 * Same seed = same plan (occurs AND startSeconds) — determinism pin.
 */
export function stormEventPlan(style, seed, ev = DRESSING.fog && DRESSING.fog.stormEvent) {
  if (!ev || style !== ev.style) return { occurs: false, startSeconds: null };
  const rand = lcg((((seed >>> 0) ^ STORM_SALT) >>> 0) || 1);
  if (!(rand() < ev.chancePerRound)) return { occurs: false, startSeconds: null };
  return { occurs: true, startSeconds: rand() * (ev.startMaxSeconds || 0) };
}

/**
 * Pure: 0..1 storm ramp factor at time u (seconds since front arrival).
 * Linear rise -> pinned hold -> linear fall -> 0. u <= 0 (or post-event) = 0.
 */
export function stormRampK(u, ev) {
  if (!(u > 0)) return 0;
  if (u < ev.riseSeconds) return u / ev.riseSeconds;
  if (u < ev.riseSeconds + ev.holdSeconds) return 1;
  const fu = u - ev.riseSeconds - ev.holdSeconds;
  if (fu < ev.fallSeconds) return 1 - fu / ev.fallSeconds;
  return 0;
}

/** Pure: scene-fog density at storm time t — baseline lerped to densityStorm by the ramp factor. */
export function stormDensity(plan, t, baseline, ev = DRESSING.fog && DRESSING.fog.stormEvent) {
  if (!ev || !plan || !plan.occurs) return baseline;
  const k = stormRampK(t - plan.startSeconds, ev);
  return baseline + (ev.densityStorm - baseline) * k;
}

// ---- W8-K (plan SE-COMPLETE-1012, user-directed): FOG EXTENT + PERSISTENT
// EXTERIOR FOG + THE FOG MODIFIER. All pure, all DATA-driven.
//
// (1) DOWN INTO THE EARTH: every fog box stacks from the data bottomY
//     (dressing.fog.boxBottomY, below the lowest terrain) UP — no clear air
//     under a floating band.
// (2) PERSISTENT EXTERIOR FOG: dressing.fog.exterior (alwaysOn default TRUE,
//     density, span) mounts at boot with ZERO storm event; storm events ramp
//     its color darker/thicker via colorStorm.
// (3) THE FOG MODIFIER: the manual's landscape Fog row gates the interior —
//     OFF (default) interior stays calm (capped at baseline); ON interior
//     reaches storm-level density without any event.

/**
 * Pure: the exterior fog plan — the DATA exterior block folded with the
 * mounted storm-front entity's exterior params (entity edit wins, absent
 * entity = the data byte-identically). Returns null when no exterior DATA.
 */
export function exteriorPlan(base = DRESSING.fog.exterior, front = null) {
  if (!base) return null;
  const p = { ...base };
  if (front) {
    if (front.exteriorAlwaysOn !== undefined) p.alwaysOn = front.exteriorAlwaysOn;
    if (typeof front.exteriorDensity === 'number') p.density = front.exteriorDensity;
    if (typeof front.exteriorSpan === 'number') p.span = front.exteriorSpan;
  }
  return p;
}

/**
 * Pure: the exterior box transforms — stacked boxes filling bottomY..topY,
 * count = round(layers * density) * 4 RING bands (density 0 = no boxes:
 * mutation-prove pin). W-A: the layer is a RING around the play area — 4 band
 * boxes (-x/+x/-z/+z) hugging the FIELD edges, ZERO footprint over the field
 * footprint (the user sees fog inside the panes with the modifier off today).
 * The +Z band is the open cutaway side. Band depth = the DATA span (reused);
 * x-bands span the full ring z extent, z-bands fill between them (no corner
 * overlap). `field` extents are injectable (node-testable); default = the LIVE
 * field extents from voxel3d/constants (read at call time — setMapSize-safe).
 */
export function exteriorBoxes(plan, field = null) {
  if (!plan || !plan.alwaysOn) return [];
  const F = field || { xMin: FIELD_X_MIN, xMax: FIELD_X_MAX, zMin: FIELD_Z_MIN, zMax: FIELD_Z_MAX };
  const layers = Math.max(0, Math.round(plan.layers * plan.density));
  const h = (plan.topY - plan.bottomY) / plan.layers;
  const depth = plan.span; // W-A: span reused as the outward band depth (data note)
  const midX = (F.xMin + F.xMax) / 2, midZ = (F.zMin + F.zMax) / 2;
  const bands = [
    { band: '-x', x: F.xMin - depth / 2, z: midZ, scaleX: depth, scaleZ: (F.zMax - F.zMin) + 2 * depth },
    { band: '+x', x: F.xMax + depth / 2, z: midZ, scaleX: depth, scaleZ: (F.zMax - F.zMin) + 2 * depth },
    { band: '-z', x: midX, z: F.zMin - depth / 2, scaleX: F.xMax - F.xMin, scaleZ: depth },
    { band: '+z', x: midX, z: F.zMax + depth / 2, scaleX: F.xMax - F.xMin, scaleZ: depth },
  ];
  const boxes = [];
  for (let i = 0; i < layers; i++) {
    const y0 = plan.bottomY + i * h;
    for (const bd of bands) {
      boxes.push({ index: boxes.length, layer: i, band: bd.band, y: y0 + h / 2, scaleY: h, x: bd.x, z: bd.z, scaleX: bd.scaleX, scaleZ: bd.scaleZ });
    }
  }
  return boxes;
}

/** Pure: fog-box center Y so the box's BOTTOM lands on bottomY (t = 0 -> bottom == bottomY). */
export function fogBoxY(bottomY, layerHeight, t) {
  return bottomY + layerHeight * (0.5 + t);
}

/**
 * Pure: the INTERIOR scene-fog density under the Fog modifier.
 * OFF (default): capped at the baseline — fog stays EXTERIOR-only.
 * ON: pinned at storm-level density (no event needed).
 */
export function interiorDensity(fogOn, k, baseline, ev) {
  const d = baseline + (ev.densityStorm - baseline) * k;
  return fogOn ? Math.max(d, ev.densityStorm) : Math.min(d, baseline);
}

/** Live: the Fog modifier switch — se.settings.fog ('on'/'off'), DATA default fallback. */
function interiorFogOn(se) {
  const v = se.settings ? se.settings.fog : undefined;
  return v === undefined ? FOG_MOD.default === 'on' : v === 'on';
}

/**
 * Pure fire model: tick every cell's age; returns a NEW map without the
 * expired cells (burn-out over data burnSeconds). Map key "x:z" (cell coords).
 */
export function tickFires(cells, dt, plan) {
  const next = new Map();
  for (const [key, c] of cells) {
    const age = c.age + dt;
    if (age < (c.burnSeconds ?? plan.burnSeconds)) next.set(key, { ...c, age });
  }
  return next;
}

/**
 * W8-J: the storm front is an EDITOR-VISIBLE OBJECT (scene entity
 * weather_storm_front, archetype storm_front). This pure merge folds the
 * mounted entity's stormFront params over the data base
 * (dressing.fog.stormEvent): an edited field wins, everything else rides the
 * data, a missing entity returns the base UNCHANGED (same object). The ramp
 * clock/determinism are untouched — only magnitudes merge.
 */
export function frontEvent(base, front) {
  if (!front) return base;
  const ev = { ...base };
  for (const k of ['style', 'riseSeconds', 'holdSeconds', 'fallSeconds', 'densityStorm', 'colorStorm', 'chancePerRound', 'startMaxSeconds', 'exteriorAlwaysOn', 'exteriorDensity', 'exteriorSpan']) {
    if (front[k] !== undefined) ev[k] = front[k];
  }
  if (typeof front.areaSpanXZ === 'number') {
    ev.area = { ...(base.area || { _placeholder: true }), spanXZ: front.areaSpanXZ };
  }
  // CLOUD-TOOL T8: the billboard merge path (front.billboardCount/... into
  // ev.billboards) is RETIRED with mountStormBillboards — nothing consumes
  // ev.billboards anymore, so the merge would be a dead no-op.
  return ev;
}

/** W8-J: the mounted storm-front entity's params (api may be absent in node unit runs). */
function resolveFront(api) {
  if (!api || typeof api.entity !== 'function') return null;
  const rec = api.entity('weather_storm_front');
  return rec && rec.components && rec.components.stormFront ? rec : null;
}

/**
 * CLOUD-TOOL T7 (plans/CLOUD-MIGRATION.md): the storm_front volumetric-cloud
 * REGION (scene entity `storm_front`, engine builtin script) is the storm
 * event's write target — T8 retargets the ramp onto these params.
 */
export function stormFrontRegion(api) {
  return cloudRegionParams(api, 'storm_front');
}

/**
 * CLOUD-TOOL T7 fail-loud gate: storm event data is present but the scene
 * lacks a storm_front volumetric-cloud region -> throw, naming the region
 * (legacy values moved to the scene params, never silently dropped).
 */
export function stormFrontRegionParams(api) {
  const params = stormFrontRegion(api);
  if (STORM_EV && !params) {
    throw new Error('weather: storm event data present but the scene lacks a storm_front volumetric-cloud region — fail loud (plans/CLOUD-MIGRATION.md)');
  }
  return params;
}

/**
 * Shared volumetric-cloud region lookup (T7 dedupe): entity id -> the
 * entity's volumetric-cloud script params, or null when the scene lacks one
 * (api may be absent in node unit runs).
 */
function cloudRegionParams(api, id) {
  if (!api || typeof api.entity !== 'function') return null;
  const rec = api.entity(id);
  const script = rec && rec.components && Array.isArray(rec.components.scripts)
    ? rec.components.scripts.find((s) => s && s.name === 'volumetric-cloud')
    : null;
  return script ? script.params : null;
}

/**
 * CLOUD-TOOL T8: the CALM cloudscape region's script params (scene entity
 * `clouds_calm`) — the ramp BASELINE source.
 */
export function calmCloudRegion(api) {
  return cloudRegionParams(api, 'clouds_calm');
}

/**
 * CLOUD-TOOL T8 (plans/CLOUD-MIGRATION.md): the storm_front region params at
 * ramp factor k — density lerps from the CALM baseline (clouds_calm region
 * params, captured at event open) to densityStorm (the storm_front region's
 * OWN authored density, the T7-verbatim storm numbers); litColor mixes the
 * same way toward the storm color. Pure; deterministic.
 */
export function stormRegionParams(k, calm, storm) {
  return {
    density: calm.density + (storm.density - calm.density) * k,
    litColor: mixHex(calm.litColor, storm.litColor, k),
  };
}

/**
 * CLOUD-TOOL T8 live writer: fold the ramped params onto the storm_front
 * region's script params (mutates in place so the scene/__clouds seam reads
 * them). While the event is LIVE a missing region fails loud; restores skip
 * silently (the region may be gone with the scene).
 */
function writeStormRegion(api, values, live) {
  if (!api || typeof api.entity !== 'function') return;
  const p = stormFrontRegion(api);
  if (!p) {
    if (live) throw new Error('weather: storm event live but the storm_front volumetric-cloud region is missing — fail loud');
    return;
  }
  if (typeof values.density === 'number') p.density = values.density;
  if (typeof values.litColor === 'string') p.litColor = values.litColor;
}

/** Pure hex mix a->b by k (no THREE import: the FogExp2 color is mutated via its own setStyle). */
export function mixHex(a, b, k) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sa, sb) => Math.round((sa + (sb - sa) * k));
  const r = ch((pa >> 16) & 255, (pb >> 16) & 255);
  const g = ch((pa >> 8) & 255, (pb >> 8) & 255);
  const bl = ch(pa & 255, pb & 255);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

// ---- entity spawners (fx_blast_sphere pattern: named entities + DATA) -----

// W8-K: the PERSISTENT EXTERIOR FOG — stacked haze boxes over the skirt
// terrain OUTSIDE the play-area cage, mounted at boot (alwaysOn, zero storm
// event needed). Every magnitude is DATA (dressing.fog.exterior, folded with
// the storm-front entity's exterior params).
function mountExteriorFog(api, wx, frontRec) {
  if (!EXT) return;
  for (const id of wx.exteriorIds) { if (api.entity(id)) api.world.destroy(id); }
  wx.exteriorIds = [];
  const plan = exteriorPlan(EXT, frontRec && frontRec.components.stormFront);
  for (const b of exteriorBoxes(plan)) {
    const id = `weather_fog_exterior_${b.index}`;
    api.spawn(id, { name: id, components: {
      // W-A: ring-band placement (x/z/scaleX/scaleZ from the pure geometry) —
      // zero footprint over the field footprint.
      transform: { x: b.x, y: b.y, z: b.z, scale: [b.scaleX, b.scaleY, b.scaleZ] },
      render: { mesh: 'box', material: 'fx', materialParams: { color: plan.color, nonce: id }, visible: true },
      // NO `fx` component: persistent dressing, not transient FX (same contract as clouds).
      weather: { kind: 'fog', exterior: true, index: b.index, band: b.band },
    } });
    wx.exteriorIds.push(id);
    wx.ids.push(id);
  }
  wx.exteriorBaseColor = plan.color;
}

/** W8-K: storm events ramp the exterior darker/thicker (colorStorm mix by the ramp k). */
function tintExteriorFog(api, wx, color) {
  for (const id of wx.exteriorIds) {
    const rec = api.entity(id);
    if (rec && rec.components.render && rec.components.render.materialParams) {
      rec.components.render.materialParams.color = color;
    }
  }
}

// W4 (plan SE-FIXUP-1012 item 7, user-reported 'fog sits in the play area all
// the time'): the per-style ground-fog boxes are INTERIOR mounts — they live
// ONLY while the Fog modifier is ON or a storm fog event is live. Sync runs
// every update (cheap: mount/unmount on state CHANGE only). The exterior fog
// (W8-K) is untouched — always on, outside the cage.
function syncInteriorFog(api, wx, se) {
  const want = interiorFogOn(se) || !!wx.stormActive;
  if (wx.interiorFogLive === want) return;
  wx.interiorFogLive = want;
  for (const id of wx.interiorFogIds) { if (api.entity(id)) api.world.destroy(id); }
  wx.interiorFogIds = [];
  if (!want || !wx.fogPlan) return;
  const fieldW = W * V, fieldZ = Z * V;
  for (let i = 0; i < wx.fogPlan.layers; i++) spawnFogLayer(api, wx, i, wx.fogPlan, fieldW, fieldZ);
}

function spawnFogLayer(api, wx, i, plan, fieldW, fieldZ) {
  const id = `weather_fog_${i}`;
  const t = i / Math.max(1, plan.layers);
  api.spawn(id, { name: id, components: {
    transform: { x: X_MIN + fieldW * (0.2 + 0.6 * ((i * 0.37) % 1)), y: fogBoxY(plan.bottomY, plan.height, t), z: Z_MIN + fieldZ * ((i * 0.61) % 1), scale: [plan.span, plan.height, plan.span] },
    render: { mesh: 'box', material: 'fx', visible: true },
    // NO `fx` component: persistent fog, not transient FX (same contract as clouds).
    weather: { kind: 'fog', index: i },
  } });
  wx.ids.push(id);
  wx.interiorFogIds.push(id);
}

function spawnFlame(api, wx, key, topY, plan2) {
  const [cx, cz] = key.split(':').map(Number);
  const id = `weather_flame_${wx.flameN = (wx.flameN || 0) + 1}`;
  api.spawn(id, { name: id, components: {
    transform: { x: X_MIN + (cx + 0.5) * V, y: topY + plan2.cellScale, z: Z_MIN + (cz + 0.5) * V, scale: [plan2.cellScale, plan2.cellScale * 2, plan2.cellScale] },
    render: { mesh: 'sphere', material: 'fx_blast', skinned: true, materialParams: { color: plan2.coreColor, nonce: id }, visible: true },
    fx: { age: 0, opacity: 1, life: plan2.burnSeconds },
    scripts: [{ name: 'fx_decay', params: { maxScale: plan2.cellScale * 1.6, life: plan2.burnSeconds } }],
    weather: { kind: 'flame', cell: key },
  } });
  wx.flames.set(key, id);
  wx.ids.push(id);
}

// ---- WEATHER-PERF-1015: change-only pool mounting ---------------------------

/**
 * Mount pool fx entities ON CHANGE ONLY: per-pool entity ids persist across
 * frames (stable material nonce = the pool entity id). New pools spawn, vanished
 * pools destroy, pools whose amount changed update transform in place (y and
 * y-scale from the new depth). Signature tracking lives in wx.poolMounts
 * ("x:z" -> { id, amount }). Pure w.r.t. terrain — placement uses the LAST
 * CACHED heights (wx.heights), never a per-frame heightsOf walk.
 */
export function mountPools(api, wx, pools, heights) {
  if (!wx.poolMounts) wx.poolMounts = new Map();
  const seen = new Set();
  for (const pool of pools) {
    const key = `${pool.x}:${pool.z}`;
    seen.add(key);
    const rec = wx.poolMounts.get(key);
    const topY = heights ? heights[pool.z * W + pool.x] : 0;
    const depth = pool.amount * LIQ.depthPerUnit;
    if (!rec || !api.entity(rec.id)) {
      if (rec) wx.poolMounts.delete(key); // stale record (entity gone): remount fresh
      spawnPool(api, wx, pool, topY, depth);
      const id = wx.poolIds[wx.poolIds.length - 1];
      wx.poolMounts.set(key, { id, amount: pool.amount });
    } else if (rec.amount !== pool.amount) {
      const e = api.entity(rec.id);
      if (e && e.components && e.components.transform) {
        e.components.transform.y = topY + depth / 2;
        e.components.transform.scale = [V * 2, Math.max(0.05, depth), V * 2]; // mirrors spawnPool's placement
      }
      rec.amount = pool.amount;
    }
  }
  const vanished = [];
  for (const [key, rec] of wx.poolMounts) {
    if (!seen.has(key)) {
      if (api.entity(rec.id)) api.world.destroy(rec.id);
      vanished.push(rec.id);
      wx.poolMounts.delete(key);
    }
  }
  if (vanished.length) {
    const dead = new Set(vanished);
    wx.poolIds = wx.poolIds.filter((id) => !dead.has(id));
    wx.ids = wx.ids.filter((id) => !dead.has(id));
  }
}

/**
 * Terrain-mutation seam: clear the cached heights so the next live-liquid step
 * recomputes them ONCE (the dry path stays free). Exported pure (acts on wx);
 * the window.__se.weather.invalidateHeights seam wraps this.
 */
export function invalidateHeights(wx) {
  wx.heights = null;
  if (wx.liquid) wx.liquid.total = undefined;
}

function spawnPool(api, wx, pool, topY, depth) {
  const id = `weather_pool_${wx.poolN = (wx.poolN || 0) + 1}`;
  api.spawn(id, { name: id, components: {
    transform: { x: X_MIN + (pool.x + 0.5) * V, y: topY + depth / 2, z: Z_MIN + (pool.z + 0.5) * V, scale: [V * 2, Math.max(0.05, depth), V * 2] },
    render: { mesh: 'box', material: 'fx_blast', skinned: true, materialParams: { color: LIQ.poolColor, nonce: id }, visible: true },
    fx: { age: 0, opacity: 0.85 },
    weather: { kind: 'pool', cell: `${pool.x}:${pool.z}` },
  } });
  wx.poolIds.push(id);
  wx.ids.push(id);
}

// ---- system def ------------------------------------------------------------

export default {
  name: 'weather',
  label: 'Weather (clouds/fog/fire/pools)',
  description: 'W2-G: per-sky-style clouds + ground fog (density via the skybox getFogParams seam, deterministic drift per battle seed), burning-terrain fire VFX, and napalm pooling (src/gameplay/liquid.js pure model).',
  params: {},

  init() {
    const se = typeof window !== 'undefined' ? window.__se : null;
    if (!se) return;
    if (!se.weather || se.weather._system !== true) {
      se.weather = {
        _system: true,
        ids: [], // every entity this system owns — rebuilt cleanly on re-plan
        events: [], // producer seam queue: {type:'ignite'|'napalm'|'lightning-strike', x, z, amount?}
        style: null,
        seed: null,
        t: 0,
        fires: new Map(), // "cx:cz" -> { age, burnSeconds }
        flames: new Map(), // "cx:cz" -> flame entity id
        flameN: 0,
        poolN: 0,
        poolIds: [],
        poolMounts: new Map(), // WEATHER-PERF-1015: "x:z" -> { id, amount } — change-only pool mounting
        heights: null, // WEATHER-PERF-1015: cached terrain heights (heightsOf is never per-frame)
        liquid: null, // pool state, built lazily against the live field
        pools: null, // settled amount array (Float64Array)
        storm: null, // W8-A: this round's storm-front plan { occurs, startSeconds }
        roundStart: 0, // W8-E: wall-clock second THIS round began — plan.startSeconds is relative to it
        stormActive: null, // live event state { plan, baseline, color, regionCalm, regionStorm } while the window is open
        stormRegionBase: null, // CLOUD-TOOL T8: the storm_front region's AUTHORED storm params (captured once per session)
        interiorFogIds: [], // W4: interior fog box mounts — live ONLY while fogOn (modifier) or a storm event is live
        interiorFogLive: false, // W4: last-synced interior mount state (mount/unmount on change only)
        fogPlan: null, // W4: this style's fogPlan (per-style magnitudes; mount gating is the modifier/event state)

        exteriorIds: [], // W8-K: persistent exterior fog box mounts (always on, re-planned per round)
        exteriorBaseColor: null, // W8-K: the DATA exterior color (storm tint restores to it)
        areaSpan: 0, // W8-J: RETIRED with the billboard drift (T8) — field kept one release for external readers, never written
        realT: 0, // W6-scrub: RETIRED — the storm clock is the SIM clock (wx.t); field kept one release for external readers, never advanced
        _wallLast: undefined, // W6-scrub: RETIRED with the wall-clock accrual
      };
    }
    // ignite/spill seams: bound ONCE per bridge, idempotent.
    if (!se.weather.ignite) {
      se.weather.ignite = (x, z, source) => se.weather.events.push({ type: 'ignite', x, z, source });
      se.weather.spill = (x, z, amount) => se.weather.events.push({ type: 'napalm', x, z, amount });
    }
    // W8-A forcing seam (mirrors lightning forceStrike): deterministically start
    // a storm front NOW (specs/specs-driven demos). Restores any live event to
    // its captured baseline first so the forced event ramps from true baseline.
    if (!se.weather.forceStorm) {
      se.weather.forceStorm = () => {
        const wx = se.weather;
        if (wx.stormActive) restoreStormFog(se); // api-less seam: a ramped region restores on the next event open or re-plan
        wx.roundStart = wx.t; // W6-scrub: the forced front starts NOW on the SIM clock (round-relative: 1/60 into this "round")
        wx.storm = { occurs: true, startSeconds: 1 / 60 };
        return wx.storm;
      };
    }
    // W6-scrub reset seam: scrub/controller reset clears the plan cache so the
    // next update re-plans from the authored state (a live storm event must
    // not survive a run reset).
    if (!se.weather.reset) {
      se.weather.reset = () => { se.weather.style = null; se.weather.seed = null; se.weather.storm = null; };
    }
    // WEATHER-PERF-1015: terrain-mutation seam — clear the cached heights so
    // the next live-liquid step recomputes them once (the dry path stays free).
    if (!se.weather.invalidateHeights) {
      se.weather.invalidateHeights = () => invalidateHeights(se.weather);
    }
  },

  update(dt, api) {
    const se = typeof window !== 'undefined' && window.__se;
    if (!se || !se.field || !se.sky) return; // editor viewport / pre-sky: no-op
    this.init();
    // CLOUD-TOOL T7 fail-loud gate: storm event data present but the scene
    // lacks a storm_front volumetric-cloud region -> throw (T8 consumes the
    // params this gate guards).
    stormFrontRegionParams(api);
    const wx = se.weather;
    wx.t += dt;
    // W6-scrub: the storm clock IS wx.t (sim time). The W8-E wall-clock
    // accrual (realT from performance.now) is retired — under editor scrub a
    // paused sim must freeze the fog/cloud ramp, and determinism beats the
    // real-time feel the spiral guard used to buy. See
    // plans/SE-SCRUB-W6/INVENTORY.md item 6.

    // Re-plan when the style or the round seed changes (per-round determinism).
    const style = se.sky.style;
    const seed = (se.terrainSeed && se.terrainSeed.value) || 0;
    if (wx.style !== style || wx.seed !== seed) {
      restoreStormFog(se, api); // a live event never survives a re-plan (new round/new sky)
      wx.style = style;
      wx.seed = seed;
      wx.storm = stormEventPlan(style, seed); // W8-A per-round deterministic roll
      wx.roundStart = wx.t; // W6-scrub: plan timing is round-relative on the SIM clock (a reseed restarts the event window)
      for (const id of wx.ids) { if (api.entity(id)) api.world.destroy(id); }
      wx.ids = [];
      wx.flames.clear();
      wx.poolIds = [];
      wx.fires.clear();
      wx.interiorFogIds = []; // W4: the re-plan destroy above cleared the mounts; force a fresh sync
      wx.interiorFogLive = false;
      // CLOUD-TOOL T8: no cloud/billboard mounts — the storm ramp writes the
      // storm_front region's SCRIPT params (applyStormFog below); the region
      // entities are persistent scene data, never spawned here.
      // W4: interior fog boxes are GATED mounts (Fog modifier ON or live storm
      // event) — store the style plan, sync decides the mount.
      wx.fogPlan = fogPlan(style);
      syncInteriorFog(api, wx, se);
      mountExteriorFog(api, wx, resolveFront(api)); // W8-K: persistent exterior fog, always on (zero event needed)
      wx.liquid = createPoolState({ W, Z }); // fresh pool sim per round
      wx.pools = wx.liquid.amount;
      wx.heights = heightsOf(se); // WEATHER-PERF-1015: one cached walk per re-plan, never per frame
      wx.poolMounts = new Map(); // pool entity ownership restarts with the round (ids were destroyed above)
    }

    // W8-A storm-front event: ramp the LIVE scene.fog (FogExp2) through
    // rise->hold->fall. No-op (never writes fog) unless this round's plan
    // occurred and its window is open — other styles stay byte-identical.
    applyStormFog(wx, se, api);
    syncInteriorFog(api, wx, se); // W4: interior fog mounts follow the modifier / live storm event

    // Producer seams: consume queued events (napalm spills + ignitions).
    const events = wx.events.splice(0, wx.events.length);
    for (const ev of events) {
      const cx = Math.max(0, Math.min(W - 1, cellX(ev.x)));
      const cz = Math.max(0, Math.min(Z - 1, cellZ(ev.z)));
      if (ev.type === 'napalm') {
        liqSpill(wx.liquid, cx, cz, ev.amount ?? 1);
        wx.liquid.total = liquidTotal(wx.liquid.amount); // mass changed -> settle gate reopens
        igniteCell(wx, cx, cz);
      } else if (ev.type === 'ignite' || ev.type === 'lightning-strike') {
        igniteCell(wx, cx, cz);
      }
    }

    // Fire tick: burn-out over data time; spread is DATA (0 until the manual pins a rate).
    const fplan = firePlan();
    wx.fires = tickFires(wx.fires, dt, fplan);
    for (const [key, id] of [...wx.flames]) {
      if (!wx.fires.has(key)) {
        if (api.entity(id)) api.world.destroy(id);
        wx.flames.delete(key);
      }
    }
    if (fplan.spread > 0) applySpread(wx, fplan);
    for (const key of wx.fires.keys()) {
      if (!wx.flames.has(key)) {
        const [cx, cz] = key.split(':').map(Number);
        spawnFlame(api, wx, key, cellTopWorldY(columnTop(se.field, cx, cz)), fplan); // DEEPEN-1015 R6 seam
      }
    }

    // Pooling: settle the pure model against live heights, mount pool fx.
    // PERF LAW (FPS-1012): the settle scan is W*Z*settleIterations — running
    // it per-frame with zero liquid on the field cost ~21M ops/frame (~5 FPS).
    // (1) idle skip: no liquid mass anywhere -> no settle, no pool fx.
    // (2) settleHz gate: active pools settle at a data rate (pooling is a
    // slow visual — 60Hz reflow is wasted work); burn still scales by dt.
    if (wx.liquid) {
      // PERF LAW (FPS-1012b): heightsOf walks every column top (W*Z columnTop
      // scans) — NEVER per frame. WEATHER-PERF-1015: the walk is CACHED on
      // wx.heights and recomputed only (a) per re-plan (fresh pool state),
      // (b) once when the cache is missing while liquid is live (post-
      // invalidation), or (c) inside the settle accumulator branch (a settle
      // actually ran at LIQ.settleHz). The dry path (total 0) never pays it.
      if (wx.liquid.total === undefined) wx.liquid.total = liquidTotal(wx.pools)
      if (wx.liquid.total > 0) {
        if (!wx.heights) wx.heights = heightsOf(se); // cache miss only (invalidation / first live frame)
        wx.liquid.acc = (wx.liquid.acc || 0) + dt
        const step = 1 / (LIQ.settleHz ?? 5)
        if (wx.liquid.acc >= step) {
          wx.liquid.acc = 0
          wx.heights = heightsOf(se); // a settle ran -> terrain heights are re-read here, only here
          const settled = settle(wx.liquid, wx.heights, LIQ); // reads wx.liquid.amount (spills included)
          wx.liquid.amount = wx.pools = settled;
          wx.liquid.total = liquidTotal(wx.pools)
        }
        liqBurn(wx.pools, dt, LIQ.burnPerSecond);
        // WEATHER-PERF-1015: change-only mounting — pool entities persist
        // across frames; spawn/destroy only for new/vanished pools, update
        // transform in place when (x, z, amount) changed. Material nonce is
        // the pool entity id (stable per pool, never churns per frame).
        mountPools(api, wx, poolList(wx.pools, { W, Z }), wx.heights);
      }
    }
  },

  onDetach() {
    const se = typeof window !== 'undefined' ? window.__se : null;
    if (!se || !se.weather) return;
    se.weather.ids = []; // entity ownership ends with the scene mount
    se.weather.poolIds = [];
    se.weather.poolMounts = new Map(); // WEATHER-PERF-1015: pool entity ownership ends with the scene mount
    se.weather.interiorFogIds = []; // W4: interior fog box ownership ends with the scene mount
    se.weather.exteriorIds = []; // W8-K: exterior box ownership ends with the scene mount
  },
};

function igniteCell(wx, cx, cz) {
  const key = `${cx}:${cz}`;
  if (!wx.fires.has(key)) wx.fires.set(key, { age: 0, burnSeconds: WX.fire.burnSeconds });
}

// ---- W8-A storm-front event: live FogExp2 application ----------------------

/** The FogExp2 mounted by dressing mountDressing, via the se bridge (no main.js coupling). */
function liveFog(se) {
  const scene = se.sky && se.sky.object3d && se.sky.object3d.parent;
  return scene && scene.fog ? scene.fog : null;
}

// FOG-ALWAYS-ON-FIX (plans/FOG-ALWAYS-ON-FIX.md): clear skies mount NO scene
// fog (skirt.js mountDressing sets scene.fog = null for zero-haze styles). The
// storm event still needs a FogExp2 write target — when the event opens on its
// data style, mount one at the style's dressing baseline (seam x densityScale,
// the same plan mountDressing uses). Styles whose seam is 0 never mount.
function mountStormFog(se, style) {
  const scene = se.sky && se.sky.object3d && se.sky.object3d.parent;
  if (!scene || !THREE) return null;
  const seam = getFogParams(style) || { density: 0, color: null };
  const density = seam.density * DRESSING.fog.densityScale;
  if (!(density > 0)) return null;
  const fog = new THREE.FogExp2(seam.color || DRESSING.fog.colorFallback, density);
  scene.fog = fog;
  return fog;
}

/** Write the captured baseline back to the live fog and close the event. */
function restoreStormFog(se, api) {
  const wx = se.weather;
  const a = wx.stormActive;
  if (!a) return;
  wx.stormActive = null;
  // CLOUD-TOOL T8: the storm_front region's params restore to the captured
  // CALM baseline (region rides the event window like the billboards did).
  if (a.regionCalm) writeStormRegion(api, a.regionCalm, false);
  if (wx.exteriorBaseColor) tintExteriorFog(api, wx, wx.exteriorBaseColor); // W8-K: exterior tint restores to the DATA color
  const fog = liveFog(se);
  if (!fog) return;
  fog.density = a.baseline;
  fog.color.setStyle(a.color);
  // FOG-ALWAYS-ON-FIX: a zero-haze style mounts NO scene fog — if the live
  // style's dressing plan is density 0, unmount the storm-event fog entirely.
  const style = se.sky && se.sky.style;
  const seam = style ? (getFogParams(style) || { density: 0 }) : { density: 0 };
  if (!(seam.density > 0)) {
    const scene = se.sky && se.sky.object3d && se.sky.object3d.parent;
    if (scene) scene.fog = null;
  }
}

/** Per-frame: open the event window at plan start, ramp density+color, restore at the end. */
function applyStormFog(wx, se, api) {
  // W8-J: the storm-front OBJECT's params drive the event — the mounted
  // weather_storm_front entity (archetype storm_front) folds over the data
  // base; a missing entity falls back to the data byte-identically.
  const frontRec = resolveFront(api);
  const BASE = DRESSING.fog && DRESSING.fog.stormEvent;
  if (!BASE) return; // no DATA block -> no event (data is the only source)
  const ev = frontEvent(BASE, frontRec && frontRec.components.stormFront);
  // W8-K FOG MODIFIER: the manual's Fog switch gates the interior. ON -> the
  // interior is pinned at storm-level density with NO event needed (the event
  // capture below then starts from that storm-level baseline). OFF (default)
  // -> the interior is capped at the baseline; fog stays EXTERIOR-only.
  const fogOn = interiorFogOn(se);
  let fog = liveFog(se);
  if (!fog) {
    // FOG-ALWAYS-ON-FIX: clear skies have NO scene fog. The event still drives
    // the volumetric-cloud REGION — only the FogExp2 writes need a fog. Mount
    // lazily when (a) the live style IS the event's data style (its dressing
    // baseline fog) or (b) the manual Fog modifier is ON (explicit user opt-in,
    // style-independent). Other styles keep clear skies.
    const wantFog = fogOn || (!!se.sky && se.sky.style === ev.style);
    if (!wantFog) return;
    fog = mountStormFog(se, ev.style);
    if (!fog) return;
  }
  // W8-K FOG MODIFIER: the manual's Fog switch gates the interior. ON -> the
  // interior is pinned at storm-level density with NO event needed (the event
  // capture below then starts from that storm-level baseline). OFF (default)
  // -> the interior is capped at the baseline; fog stays EXTERIOR-only.
  if (fogOn) fog.density = ev.densityStorm;
  // W8-E reseed safety: a re-plan (new round seed / style change) re-rolls
  // wx.storm — a live event holding the STALE captured plan must restore its
  // baseline immediately and close (the next open re-captures the CURRENT
  // style's baseline). This is the belt-and-braces guard on top of the
  // restoreStormFog() call in the re-plan block above.
  if (wx.stormActive && wx.storm !== wx.stormActive.plan) restoreStormFog(se, api);
  if (!wx.stormActive) {
    const plan = wx.storm;
    const startAbs = wx.roundStart + (plan ? plan.startSeconds : 0); // W6-scrub: round-relative start on the SIM clock
    if (!plan || !plan.occurs || wx.t < startAbs) return;
    // CLOUD-TOOL T8: the ramp's write target is the storm_front volumetric-cloud
    // REGION. Capture the CALM baseline (clouds_calm region params) at event
    // open and the STORM target (the region's OWN authored params — the
    // T7-verbatim storm numbers) once per session; the ramp then writes
    // density/litColor onto the region every step (stormRegionParams law).
    const regionParams = stormFrontRegion(api);
    if (!regionParams) throw new Error('weather: storm event open but the storm_front volumetric-cloud region is missing — fail loud (plans/CLOUD-MIGRATION.md)');
    // T8 fail-loud gap closed: the STORM target is validated with the SAME
    // standard as the calm baseline below — a malformed storm density used to
    // make writeStormRegion silently skip (typeof guard) and a malformed
    // litColor produced '#NaN…'.
    if (typeof regionParams.density !== 'number' || !Number.isFinite(regionParams.density)) {
      throw new Error('weather: storm_front region params.density must be a finite number — fail loud, no defaults');
    }
    if (!/^#[0-9a-f]{6}$/.test(String(regionParams.litColor))) {
      throw new Error('weather: storm_front region params.litColor must be a #rrggbb hex — fail loud, no defaults');
    }
    const calmP = calmCloudRegion(api);
    if (!calmP || typeof calmP.density !== 'number' || !/^#[0-9a-f]{6}$/.test(calmP.litColor)) {
      throw new Error('weather: storm event open but the scene lacks a clouds_calm volumetric-cloud region (density + litColor) — fail loud');
    }
    if (!wx.stormRegionBase) wx.stormRegionBase = { density: regionParams.density, litColor: regionParams.litColor };
    wx.stormActive = {
      plan,
      baseline: fog.density, // whatever the dressing mount set for THIS style — captured at event START only
      color: `#${fog.color.getHexString()}`,
      ev, // W8-J: the merged front params are frozen at event open (mid-event edits apply at the NEXT open)
      regionCalm: { density: calmP.density, litColor: calmP.litColor }, // captured at event open (CLOUD-TOOL T8)
      regionStorm: wx.stormRegionBase, // the region's authored storm values (persisted across events)
    };
  }
  const a = wx.stormActive;
  const evL = a.ev || ev; // live-event params frozen at open
  const u = wx.t - (wx.roundStart + a.plan.startSeconds); // W6-scrub: ramp on the SIM clock, round-relative
  const end = evL.riseSeconds + evL.holdSeconds + evL.fallSeconds;
  if (u >= end) { restoreStormFog(se, api); wx.storm = null; return; }
  const k = stormRampK(u, evL);
  fog.density = interiorDensity(fogOn, k, a.baseline, evL); // W8-K: the Fog modifier caps (OFF) or pins (ON) the interior
  fog.color.setStyle(mixHex(a.color, evL.colorStorm, k));
  // W8-K: storm events ramp the whole thing darker/thicker as today — the
  // exterior boxes tint toward colorStorm with the same ramp factor.
  if (wx.exteriorBaseColor) tintExteriorFog(api, wx, mixHex(wx.exteriorBaseColor, evL.colorStorm, k));
  // CLOUD-TOOL T8: the storm ramp writes the storm_front region's SCRIPT
  // params — density lerped calm->densityStorm, litColor blended toward the
  // storm color (stormRegionParams law). Fails loud when the region vanished.
  writeStormRegion(api, stormRegionParams(k, a.regionCalm, a.regionStorm), true);
}

/** Total liquid mass in the pool array (0 = field is dry -> settle skipped). */
function liquidTotal(pools) {
  let t = 0;
  for (let i = 0; i < pools.length; i++) t += pools[i];
  return t;
}

function applySpread(wx, plan2) {
  const born = [];
  for (const key of wx.fires.keys()) {
    const [x, z] = key.split(':').map(Number);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k2 = `${x + dx}:${z + dz}`;
      if (!wx.fires.has(k2)) born.push(k2);
    }
  }
  for (const k2 of born) wx.fires.set(k2, { age: 0, burnSeconds: plan2.burnSeconds }); // rate IS the data spread
}

/** Terrain heights from the LIVE voxel field (world y of each column top). */
function heightsOf(se) {
  const heights = new Float64Array(W * Z);
  for (let z = 0; z < Z; z++) {
    for (let x = 0; x < W; x++) {
      heights[z * W + x] = cellTopWorldY(columnTop(se.field, x, z)); // documented seam (projectiles3d surfaceWorldY) — DEEPEN-1015 R6
    }
  }
  return heights;
}
