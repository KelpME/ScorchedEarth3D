// W8-C (plan SE-COMPLETE-1012) — VOLUMETRIC STORM CLOUDS: WebGL raymarch port.
// The user's reference (threejs.org/examples/webgpu_volume_cloud) is WebGPU/TSL
// raymarching and CANNOT run here (WebGLRenderer engine) — the TECHNIQUE is
// adapted per the royalty clause: raymarch one slab volume over the play area
// against a procedurally-generated 3D noise texture (Data3DTexture, WebGL2
// sampler3D) in a hand-written GLSL fragment shader.
//
// PERF LAW (hard frame-time budget):
//   - ONE volume slab over the play area (a single box + single draw).
//   - Step count is DATA (the clouds_calm region params, capped by [stepsMin,
//     stepsMax]) — no per-frame CPU work per voxel: the field is generated
//     ONCE at mount, the GPU does all marching.
//   - Early-exit when opacity saturates (uEarlyExit).
// HARD DOCTRINE: every magnitude is DATA (the scene's volumetric-cloud region
// params — clouds_calm + storm_front, scenes/level-01.json); fail-loud on a
// missing key (module init throws NAMING the key) — no JS literals for game
// content, no silent defaults.
// STORM TIE: density + darkness ramp CONSUME the W8-A stormEventPlan timing
// (dressing.fog.stormEvent data block — same seed chain as the fog event, so
// clouds and fog arrive together). Calm sky = thin faint clouds (data-set
// calmDensity, a small non-zero fraction of stormDensity — wispy, not zero).
// EDITOR VISIBILITY: mounted as a scene system (main.js systems map) whose
// descriptor carries params; exposes a window.__se.stormClouds seam
// (uniforms + mesh) mirroring the weather/lightning force-storm convention.
import * as THREE from 'three';
import { stormEventPlan, stormRampK } from './weather.js';
import { W, Z, V, X_MIN, Z_MIN } from '../src/voxel3d/constants.js';
import sceneData from '../scenes/level-01.json' with { type: 'json' };
import presets from '../data/physics-presets.json' with { type: 'json' };

// CLOUD-TOOL T8 (plans/CLOUD-MIGRATION.md) — SINGLE SOURCE OF TRUTH: the slab's
// data IS the scene's volumetric-cloud REGION params (the clouds_calm +
// storm_front entities in scenes/level-01.json), read through the same
// entity -> scripts -> volumetric-cloud -> params shape weather.js's region
// lookup consumes. The presets block is a RETIRED tombstone (values kept as a
// record for external readers) — no code reads it anymore.
/** Scene lookup: entity id -> { params, transform } of its volumetric-cloud region, or null. */
function regionData(id) {
  const e = (sceneData.entities || []).find((en) => en && en.id === id);
  const scripts = e && e.components && Array.isArray(e.components.scripts)
    ? e.components.scripts : null;
  const script = scripts ? scripts.find((s) => s && s.name === 'volumetric-cloud') : null;
  if (!script || !script.params) return null;
  return { params: script.params, transform: e.components.transform || {} };
}

const CALM_R = regionData('clouds_calm'); // calm cloudscape: baseline magnitudes + shared algorithm constants
const STORM_R = regionData('storm_front'); // storm front: its OWN authored storm magnitudes

// Fail loud at module init: the regions are the only data source.
(function requireRegions() {
  if (!CALM_R) throw new Error('stormClouds: the scene lacks a clouds_calm volumetric-cloud region — the scene regions are the single data source (plans/CLOUD-MIGRATION.md)');
  if (!STORM_R) throw new Error('stormClouds: the scene lacks a storm_front volumetric-cloud region — the scene regions are the single data source (plans/CLOUD-MIGRATION.md)');
  for (const k of ['density', 'litColor', 'sizeX', 'sizeY', 'sizeZ', 'noiseScale', 'detailOctaves', 'driftSpeedX',
    'steps', 'stepsMin', 'stepsMax', 'noiseSize', 'noiseSeed', 'noisePeriod', 'threshold', 'softness',
    'opacityPerStep', 'earlyExit', 'heightFade']) {
    if (!(k in CALM_R.params)) throw new Error(`stormClouds: clouds_calm volumetric-cloud params.${k} missing — fail loud, no defaults`);
  }
  for (const k of ['density', 'litColor']) {
    if (!(k in STORM_R.params)) throw new Error(`stormClouds: storm_front volumetric-cloud params.${k} missing — fail loud, no defaults`);
  }
})();

// The slab data (the historic VC shape is preserved so the pure model and the
// uniforms below read unchanged), derived from the regions:
//   - shared algorithm constants + calm magnitudes <- clouds_calm params
//   - the storm magnitudes <- storm_front's OWN params
//   - the slab band <- clouds_calm transform.y ± sizeY/2 (26..40 on level-01)
//   - slabPad <- sizeX minus the play-area span, split over both sides
const CALM = CALM_R.params;
const STORM = STORM_R.params;
const CALM_Y = CALM_R.transform.y || 0;
const VC = {
  enabled: true, // the regions exist (gated above) = the volume is on
  steps: CALM.steps, stepsMin: CALM.stepsMin, stepsMax: CALM.stepsMax,
  noiseSize: CALM.noiseSize, noiseOctaves: CALM.detailOctaves, noisePeriod: CALM.noisePeriod,
  noiseSeed: CALM.noiseSeed, noiseScale: CALM.noiseScale,
  slabYMin: CALM_Y - CALM.sizeY / 2, slabYMax: CALM_Y + CALM.sizeY / 2,
  slabPad: (CALM.sizeX - W * V) / 2,
  threshold: CALM.threshold, softness: CALM.softness, opacityPerStep: CALM.opacityPerStep,
  earlyExit: CALM.earlyExit, heightFade: CALM.heightFade,
  driftSpeed: CALM.driftSpeedX,
  calmDensity: CALM.density, calmColor: CALM.litColor,
  stormDensity: STORM.density, stormColor: STORM.litColor,
};
// Storm-event timing rides the (NOT retired) stormEvent data block — the same
// W8-A block the fog event consumes, so clouds and fog arrive together.
const EV = presets.dressing && presets.dressing.fog && presets.dressing.fog.stormEvent;

// ---- pure noise model (deterministic per DATA seed, lattice-periodic) ------

/** Integer hash -> [0,1). Lattice coords wrap mod DATA.noisePeriod (seamless tiling). */
export function noiseHash(ix, iy, iz, seed) {
  const P = VC.noisePeriod;
  const x = ((ix % P) + P) % P;
  const y = ((iy % P) + P) % P;
  const z = ((iz % P) + P) % P;
  let h = seed >>> 0;
  h = Math.imul(h ^ (x + 0x9e3779b9), 0x27d4eb2d); h ^= h >>> 15;
  h = Math.imul(h ^ (y + 0x165667b1), 0x85ebca6b); h ^= h >>> 13;
  h = Math.imul(h ^ (z + 0xc2b2ae35), 0x27d4eb2d); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Pure trilinear value noise with smoothstep lattice fade — deterministic per seed. */
export function noiseAt(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const lerp = (a, b, t) => a + (b - a) * t;
  const c00 = lerp(noiseHash(xi, yi, zi, seed), noiseHash(xi + 1, yi, zi, seed), sx);
  const c10 = lerp(noiseHash(xi, yi + 1, zi, seed), noiseHash(xi + 1, yi + 1, zi, seed), sx);
  const c01 = lerp(noiseHash(xi, yi, zi + 1, seed), noiseHash(xi + 1, yi, zi + 1, seed), sx);
  const c11 = lerp(noiseHash(xi, yi + 1, zi + 1, seed), noiseHash(xi + 1, yi + 1, zi + 1, seed), sx);
  return lerp(lerp(c00, c10, sy), lerp(c01, c11, sy), sz);
}

/** Pure fbm field over a size^3 lattice (values [0,1]) — ONE-TIME CPU cost at mount. */
export function buildNoiseField(size, seed, octaves = VC.noiseOctaves) {
  const P = VC.noisePeriod;
  const field = new Float32Array(size * size * size);
  const amps = [];
  let ampSum = 0;
  for (let o = 0; o < octaves; o++) { amps[o] = 1 / (1 << o); ampSum += amps[o]; }
  let i = 0;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++, i++) {
        const u = (x * P) / size, v = (y * P) / size, w = (z * P) / size;
        let acc = 0;
        for (let o = 0; o < octaves; o++) {
          const f = 1 << o;
          acc += noiseAt(u * f, v * f, w * f, (seed + o * 0x9e37) >>> 0) * amps[o];
        }
        field[i] = acc / ampSum; // [0,1)
      }
    }
  }
  return field;
}

/** PERF LAW: step count clamps into the DATA range; zero/negative fails loud. */
export function clampSteps(n, data = VC) {
  const s = Math.round(n);
  if (!(s > 0)) throw new Error(`stormClouds: steps must be > 0 (got ${n}) — marching loop dies silently otherwise`);
  return Math.max(data.stepsMin, Math.min(data.stepsMax, s));
}

/** Pure: every render param straight from DATA (round-trip). */
export function volumePlan(style, seed, data = VC) {
  return {
    steps: clampSteps(data.steps, data),
    threshold: data.threshold,
    softness: data.softness,
    opacityPerStep: data.opacityPerStep,
    earlyExit: data.earlyExit,
    driftSpeed: data.driftSpeed,
    calmDensity: data.calmDensity,
    stormDensity: data.stormDensity,
    calmColor: data.calmColor,
    stormColor: data.stormColor,
    slabYMin: data.slabYMin,
    slabYMax: data.slabYMax,
    noiseScale: data.noiseScale,
  };
}

/**
 * Pure: storm-cloud state at time t. Ramp CONSUMES the W8-A stormEventPlan
 * timing (same ev data block + seed chain as the fog event). Calm styles
 * never storm (plan.occurs false -> k 0). Non-storm t -> thin faint clouds.
 */
export function stormCloudState(style, t, seed, ev = EV, data = VC) {
  const plan = stormEventPlan(style, seed, ev);
  const k = plan.occurs ? stormRampK(t - plan.startSeconds, ev) : 0;
  return {
    k,
    density: data.calmDensity + (data.stormDensity - data.calmDensity) * k,
    darkness: k,
  };
}

// ---- GPU: procedural 3D noise texture + raymarch shader (hand-written GLSL) --

/** Data-seeded procedural field -> Data3DTexture (RedFormat, repeat, linear). ONE-TIME CPU gen. */
function buildNoiseTexture() {
  const size = VC.noiseSize;
  const field = buildNoiseField(size, VC.noiseSeed >>> 0);
  const bytes = new Uint8Array(size * size * size);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(field[i] * 255)));
  const tex = new THREE.Data3DTexture(bytes, size, size, size);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// GLSL ES 3.00 (WebGL2): camera->box raymarch against the sampler3D field.
const VERT = [
  'out vec3 vWorldPos;',
  'void main() {',
  '  vec4 wp = modelMatrix * vec4(position, 1.0);',
  '  vWorldPos = wp.xyz;',
  '  gl_Position = projectionMatrix * viewMatrix * wp;',
  '}',
].join('\n');

const FRAG = [
  'precision highp float;',
  'precision highp sampler3D;',
  'uniform sampler3D uNoise;',
  'uniform int uSteps;',
  'uniform float uThreshold;',
  'uniform float uSoftness;',
  'uniform float uOpacity;',
  'uniform float uEarlyExit;',
  'uniform float uDensity;',
  'uniform float uDarkness;',
  'uniform float uTime;',
  'uniform float uScale;',
  'uniform float uDrift;',
  'uniform float uHeightFade;',
  'uniform vec3 uColor;',
  'uniform vec3 uStormColor;',
  'uniform vec3 uBoxMin;',
  'uniform vec3 uBoxMax;',
  'in vec3 vWorldPos;',
  'layout(location = 0) out highp vec4 fragColor;',
  'void main() {',
  '  vec3 ro = cameraPosition;',
  '  vec3 rd = vWorldPos - ro;',
  '  float rayLen = length(rd);',
  '  if (rayLen < 1e-4) discard;',
  '  rd /= rayLen;',
  '  vec3 inv = 1.0 / rd;',
  '  vec3 tA = (uBoxMin - ro) * inv;',
  '  vec3 tB = (uBoxMax - ro) * inv;',
  '  vec3 tN = min(tA, tB);',
  '  vec3 tF = max(tA, tB);',
  '  float enter = max(max(tN.x, tN.y), tN.z);',
  '  float exit = min(min(tF.x, tF.y), tF.z);',
  '  enter = max(enter, 0.0);',
  '  if (exit <= enter) discard;',
  '  float spanY = uBoxMax.y - uBoxMin.y;',
  '  if (spanY <= 0.0) discard; // zero-volume slab (W8-C-FIX mutation guard): renders nothing',
  '  float midY = uBoxMin.y + spanY * 0.5;',
  '  float stepLen = (exit - enter) / float(uSteps);',
  '  vec3 sc = mix(uColor, uStormColor, uDarkness);',
  '  float acc = 0.0;',
  '  float t = enter + stepLen * 0.5;',
  '  for (int i = 0; i < uSteps; i++) {',
  '    if (acc >= uEarlyExit) break; // PERF LAW: early-exit on opacity saturation',
  '    vec3 p = ro + rd * t;',
  '    vec3 uvw = vec3((p.x + uTime * uDrift) * uScale, p.y * uScale, p.z * uScale);',
  '    float n = texture(uNoise, fract(uvw)).r;',
  '    float d = smoothstep(uThreshold, uThreshold + uSoftness, n);',
  '    float hFade = clamp(1.0 - abs(p.y - midY) / (spanY * 0.5), 0.0, 1.0);',
  '    d *= uDensity * mix(1.0, hFade, uHeightFade);',
  '    acc += d * uOpacity;',
  '    t += stepLen;',
  '  }',
  '  if (acc < 0.003) discard;',
  '  fragColor = vec4(sc, min(acc, 1.0));',
  '}',
].join('\n');

function buildVolume() {
  const pad = VC.slabPad;
  const xMin = X_MIN - pad, xMax = X_MIN + W * V + pad;
  const zMin = Z_MIN - pad, zMax = Z_MIN + Z * V + pad;
  const yMin = VC.slabYMin, yMax = VC.slabYMax;
  const uniforms = {
    uNoise: { value: buildNoiseTexture() },
    uSteps: { value: clampSteps(VC.steps) },
    uThreshold: { value: VC.threshold },
    uSoftness: { value: VC.softness },
    uOpacity: { value: VC.opacityPerStep },
    uEarlyExit: { value: VC.earlyExit },
    uDensity: { value: VC.calmDensity },
    uDarkness: { value: 0 },
    uTime: { value: 0 },
    uScale: { value: VC.noiseScale },
    uDrift: { value: VC.driftSpeed },
    uHeightFade: { value: VC.heightFade },
    uColor: { value: new THREE.Color(VC.calmColor) },
    uStormColor: { value: new THREE.Color(VC.stormColor) },
    uBoxMin: { value: new THREE.Vector3(xMin, yMin, zMin) },
    uBoxMax: { value: new THREE.Vector3(xMax, yMax, zMax) },
  };
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide, // back-face fragment -> ray exit; box math handles entry/exit
  });
  const geometry = new THREE.BoxGeometry(xMax - xMin, yMax - yMin, zMax - zMin);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set((xMin + xMax) / 2, (yMin + yMax) / 2, (zMin + zMax) / 2);
  mesh.renderOrder = 10; // after the sky sphere + opaque field
  mesh.name = 'weather_storm_clouds_volume'; // W8-J: coherent WEATHER group naming (weather_storm_front / weather_storm_lightning scene entities)
  mesh.frustumCulled = false; // the slab bounds the play area; camera-facing always relevant
  return { mesh, material, uniforms };
}

// ---- system def (editor-visible descriptor; mirrors the weather mount) ------

export default {
  name: 'stormClouds',
  label: 'Storm clouds (volumetric raymarch)',
  description: 'W8-C: one raymarched volume slab over the play area against a data-seeded procedural 3D noise texture (WebGL2 sampler3D). Density + darkness ramp with the W8-A stormEventPlan timing (dressing.fog.stormEvent); calm sky = thin faint clouds. All magnitudes are the SCENE volumetric-cloud region params (clouds_calm + storm_front, scenes/level-01.json) — the single source of truth (plans/CLOUD-MIGRATION.md).',
  params: {
    enabled: { type: 'boolean', default: VC.enabled, label: 'Volume enabled' },
  },

  init() {
    const se = typeof window !== 'undefined' ? window.__se : null;
    if (!se) return;
    if (!se.stormClouds || se.stormClouds._system !== true) {
      se.stormClouds = {
        _system: true,
        name: 'stormClouds',
        t: 0,
        forcedPlan: null, // forceStorm seam: { occurs, startSeconds } — preferred over the natural roll while set
        mesh: null,
        material: null,
        uniforms: null,
      };
    }
    if (!se.stormClouds.forceStorm) {
      se.stormClouds.forceStorm = () => {
        const sc = se.stormClouds;
        sc.forcedPlan = { occurs: true, startSeconds: sc.t + 1 / 60 };
        return sc.forcedPlan;
      };
    }
  },

  update(dt, api) {
    const se = typeof window !== 'undefined' ? window.__se : null;
    if (!se || !se.sky) return; // editor viewport / pre-sky: no-op
    this.init();
    if (!VC.enabled) return;
    const sc = se.stormClouds;
    if (!sc.mesh) {
      const vol = buildVolume();
      sc.mesh = vol.mesh;
      sc.material = vol.material;
      sc.uniforms = vol.uniforms;
      const scene = se.sky && se.sky.object3d && se.sky.object3d.parent;
      if (!scene) { sc.mesh = null; return; }
      scene.add(sc.mesh);
    }
    sc.t += dt;
    const style = se.sky.style;
    const seed = (se.terrainSeed && se.terrainSeed.value) || 0;
    // Plan resolution, in order: (1) this system's forceStorm seam (direct cloud
    // forcing); (2) the LIVE W8-A weather event state — wx.storm is the SAME
    // plan holder the fog ramp consumes (applyStormFog), so weather.forceStorm
    // drives fog AND clouds together; the ramp is computed on the weather clock
    // (wx.t) so both systems see identical k at every step. (3) The natural
    // per-round roll otherwise — same stormEventPlan chain as the fog event.
    // (W8-C-FIX: before this, weather.forceStorm set only wx.storm, which the
    // per-frame writer here never read — the fog ramped while the clouds were
    // reset to calm values every frame.)
    const end = EV.riseSeconds + EV.holdSeconds + EV.fallSeconds;
    let plan = sc.forcedPlan;
    let evUsed = EV; // W8-J: data EV until a live front object supplies merged params
    let tBase = sc.t;
    if (plan && plan.occurs && tBase - plan.startSeconds > end) { sc.forcedPlan = null; plan = null; }
    if (!plan && se.weather && se.weather.storm && se.weather.storm.occurs) {
      plan = se.weather.storm;
      // W8-J: the live front OBJECT's merged params (se.weather.stormActive.ev)
      // drive the slab ramp too, so edited front magnitudes move fog + clouds
      // as ONE storm; data EV is the fallback when no live event object exists.
      evUsed = (se.weather.stormActive && se.weather.stormActive.ev) || EV;
      // W6-scrub: consume the weather plan on the SAME SIM clock the fog ramp
      // uses (wx.t — the W8-E wall clock is retired with it), ROUND-RELATIVE
      // (plan.startSeconds is measured from wx.roundStart). A paused/stepped
      // sim freezes the cloud ramp with the fog.
      tBase = (se.weather.t || 0) - (se.weather.roundStart || 0);
    }
    if (!plan) plan = stormEventPlan(style, seed, EV);
    let k = 0;
    if (plan && plan.occurs) k = stormRampK(tBase - plan.startSeconds, evUsed);
    const u2 = sc.uniforms;
    u2.uDensity.value = VC.calmDensity + (VC.stormDensity - VC.calmDensity) * k;
    // PERF LAW (T8): the march budget follows the density ramp — calm skies
    // (k 0) march at stepsMin, storm peak (k 1) marches at the full data
    // steps. Always data-capped by [stepsMin, stepsMax] (clampSteps fails
    // loud on a dead loop), so the volume's per-frame cost tracks the visual
    // weight it renders instead of charging storm cost on calm skies.
    u2.uSteps.value = clampSteps(VC.stepsMin + (VC.steps - VC.stepsMin) * k);
    u2.uDarkness.value = k;
    u2.uTime.value = sc.t * VC.driftSpeed;
  },

  onDetach() {
    const se = typeof window !== 'undefined' ? window.__se : null;
    if (!se || !se.stormClouds) return;
    const sc = se.stormClouds;
    if (sc.mesh && sc.mesh.parent) sc.mesh.parent.remove(sc.mesh);
    if (sc.mesh) { sc.mesh.geometry.dispose(); sc.material.dispose(); sc.uniforms.uNoise.value.dispose(); }
    sc.mesh = sc.material = sc.uniforms = null; // rebuilt on the next mount
  },
};
