// Volumetric cloud renderer — §3c of plans/CLOUD-TOOL.md.
// ONE raymarched box per region: BoxGeometry + ShaderMaterial. Degrade is DATA
// (quality tier → march steps from params, never code). No game content literals:
// every constant comes from params. FBM noise is inlined in the shader (decision 1:
// no shared glsl chunk until a second volume consumer exists).
import * as THREE from 'three'

// Pure: hex '#rrggbb' → {r,g,b} 0..1. THROWS on anything else (fail loud).
export function hexToRgb(hex, paramName) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/.test(hex)) {
    throw new Error(`volumetric-cloud: param '${paramName}' value '${hex}' is not '#rrggbb' — fail loud`)
  }
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  }
}

// stepsFor is imported from the script module (src/scripts/volumetric-cloud.js)
// — the ONE definition; quality-tier step counts must stay in sync there.
// Re-exported so existing render-side consumers/tests keep their import path.
import { stepsFor } from '../scripts/volumetric-cloud.js'
export { stepsFor }

// Pure: params → uniform value object (unit-testable surface; no THREE types —
// plain {x,y,z}/{r,g,b} so vitest can assert without a GPU context).
export function buildUniforms(p) {
  const steps = stepsFor(p)
  if (!(p.sizeX > 0) || !(p.sizeY > 0) || !(p.sizeZ > 0)) {
    throw new Error(`volumetric-cloud: sizeX/Y/Z must all be > 0 — fail loud`)
  }
  if (!(p.resolutionScale > 0) || p.resolutionScale > 1) {
    throw new Error(`volumetric-cloud: resolutionScale '${p.resolutionScale}' outside (0,1] — fail loud`)
  }
  // Fail loud BEFORE Math.round/NaN can flow silently into the shader.
  if (!Number.isFinite(p.density) || p.density < 0) {
    throw new Error(`volumetric-cloud: param 'density' value '${p.density}' must be a finite number >= 0 — fail loud`)
  }
  if (!Number.isFinite(p.coverage) || p.coverage < 0 || p.coverage > 1) {
    throw new Error(`volumetric-cloud: param 'coverage' value '${p.coverage}' must be a finite number in [0,1] — fail loud`)
  }
  if (!Number.isFinite(p.noiseScale) || p.noiseScale <= 0) {
    throw new Error(`volumetric-cloud: param 'noiseScale' value '${p.noiseScale}' must be a finite number > 0 — fail loud`)
  }
  if (!Number.isFinite(p.detailOctaves) || p.detailOctaves < 1) {
    throw new Error(`volumetric-cloud: param 'detailOctaves' value '${p.detailOctaves}' must be a finite number >= 1 — fail loud`)
  }
  return {
    uSize: { value: { x: p.sizeX, y: p.sizeY, z: p.sizeZ } },
    uDensity: { value: p.density },
    uCoverage: { value: p.coverage },
    uNoiseScale: { value: p.noiseScale },
    uDetailOctaves: { value: Math.round(p.detailOctaves) },
    uLitColor: { value: hexToRgb(p.litColor, 'litColor') },
    uShadeColor: { value: hexToRgb(p.shadeColor, 'shadeColor') },
    uAmbient: { value: p.ambient },
    uLightDir: { value: lightDir(p.lightAzimuth, p.lightElevation) },
    uDrift: { value: { x: 0, z: 0 } }, // advanced by the fixed-step system via driftStep
    uSteps: { value: steps },
    uResolutionScale: { value: p.resolutionScale },
  }
}

// Pure: azimuth/elevation (deg) → normalized light direction.
export function lightDir(azimuthDeg, elevationDeg) {
  const az = (azimuthDeg * Math.PI) / 180
  const el = (elevationDeg * Math.PI) / 180
  const x = Math.cos(el) * Math.cos(az)
  const y = Math.sin(el)
  const z = Math.cos(el) * Math.sin(az)
  const len = Math.hypot(x, y, z) || 1
  return { x: x / len, y: y / len, z: z / len }
}

const VERT = /* glsl */ `
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// Inline 3D value-noise FBM (decision 1: no shared glsl chunk).
const FRAG = /* glsl */ `
precision highp float;
varying vec3 vLocal;
uniform vec3 uSize;
uniform float uDensity;
uniform float uCoverage;
uniform float uNoiseScale;
uniform float uDetailOctaves;
uniform vec3 uLitColor;
uniform vec3 uShadeColor;
uniform float uAmbient;
uniform vec3 uLightDir;
uniform vec2 uDrift;
uniform int uSteps;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0));
  float n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1));
  float n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1));
  float n111 = hash13(i + vec3(1, 1, 1));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float a = 0.5, sum = 0.0, norm = 0.0;
  for (int o = 0; o < 5; o++) {
    if (float(o) >= uDetailOctaves) break;
    sum += a * vnoise(p);
    norm += a;
    p *= 2.0;
    a *= 0.5;
  }
  return sum / max(norm, 1e-4);
}

// coverageRemap (plan §3b), GPU side: coverage 1 → all samples pass, 0 → only 1.
// KEEP IN SYNC with the JS twin coverageRemap() in src/scripts/volumetric-cloud.js
// (the JS copy is the testable authority; this GLSL version must mirror its math).
float coverageRemap(float cov, float sample_) {
  float edge = 1.0 - clamp(cov, 0.0, 1.0);
  return clamp((sample_ - edge) / max(1e-4, 1.0 - edge), 0.0, 1.0);
}

float densityAt(vec3 lp) {
  vec3 q = (lp / uSize + 0.5) * uSize * uNoiseScale + vec3(uDrift.x, 0.0, uDrift.y);
  float n = fbm(q);
  float vertFade = 1.0 - abs(lp.y / (uSize.y * 0.5)); // soft top/bottom edges
  return uDensity * coverageRemap(uCoverage, n) * clamp(vertFade, 0.0, 1.0);
}

void main() {
  // Raymarch in the box's local space: ray from camera through this fragment.
  vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 rd = normalize(world - cameraPosition);
  vec3 lro = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  vec3 lrd = normalize((inverse(modelMatrix) * vec4(world + rd, 1.0)).xyz - lro);

  // halfExt = box half-extents. NOT named 'half' — that is a reserved word in
  // GLSL ES 1.00 and would fail shader compilation on real drivers.
  vec3 halfExt = uSize * 0.5;
  vec3 inv = 1.0 / lrd;
  vec3 t0 = (-halfExt - lro) * inv;
  vec3 t1 = (halfExt - lro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float tEnter = max(max(tmin.x, tmin.y), tmin.z);
  float tExit = min(min(tmax.x, tmax.y), tmax.z);
  if (tExit <= max(tEnter, 0.0)) { discard; }
  tEnter = max(tEnter, 0.0);

  // Raymarch in the box's local space: ray from camera through this fragment.
  // ALGORITHM CONSTANTS (renderer tuning, not game content — mirrors the flock
  // LCG-comment doctrine): the loop cap 256 below is a hard safety ceiling on
  // the march so a mis-tuned quality param cannot hang the GPU; the step-count
  // itself always comes from uSteps (data).
  float stepLen = (tExit - tEnter) / float(uSteps);
  float T = 1.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 256; i++) {
    if (i >= uSteps) break;
    vec3 lp = lro + lrd * (tEnter + (float(i) + 0.5) * stepLen);
    float d = densityAt(lp);
    // 0.001: density below this is visually empty — skipping it keeps the
    // empty-sky case cheap without visible banding.
    if (d > 0.001) {
      // Two-color Beer-powder lighting toward uLightDir.
      vec3 lstep = uLightDir * stepLen;
      float lightT = 1.0;
      // 3 light-march samples: fixed shadow-ray budget — cheap softening of
      // the toward-light transmittance, resolution-independent.
      // 8.0: light-march extinction multiplier — deepens self-shadowing so
      // the toward-light ray darkens faster than the view ray (cloud body reads solid).
      for (int s = 1; s <= 3; s++) {
        lightT *= exp(-densityAt(lp + lstep * float(s)) * stepLen * 8.0);
      }
      // 4.0: powder-effect strength — brightens thin/dense edges to fake
      // multiple scattering (the classic "powder" term of GPU Pro volume clouds).
      float powder = 1.0 - exp(-d * stepLen * 4.0);
      // 0.6/0.4: base-vs-powder blend weights — mostly the plain Beer term,
      // with the powder term lifting shadowed edges ~40%.
      // Ambient (uAmbient param) lifts the SHADE-color floor so unlit density
      // is not pure black — applied on the shade path only.
      vec3 shadeCol = uShadeColor * (1.0 + uAmbient);
      vec3 lit = mix(shadeCol, uLitColor, clamp(lightT * (0.6 + 0.4 * powder), 0.0, 1.0));
      // 8.0: view-ray extinction multiplier — sets opacity accumulation rate
      // so default density reaches near-opaque over a few dozen meters.
      float a = 1.0 - exp(-d * stepLen * 8.0);
      acc += lit * a * T;
      T *= 1.0 - a;
      if (T < 0.01) break;
    }
  }
  float alpha = clamp(1.0 - T, 0.0, 1.0);
  // 0.003: alpha below this is sub-perceptual — discard to keep the transparent
  // pass cheap and avoid blending seams at the box shell.
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(acc / max(alpha, 1e-4), alpha);
}
`

// Explicit shape per known uniform — NO generic key-heuristic. The old
// 'x' in v && 'z' in v && !('r' in v) guess mangled {x,z} shapes (uDrift).
// Keys must stay in sync with buildUniforms above.
const UNIFORM_SHAPE = {
  uSize: 'vec3', uDensity: 'float', uCoverage: 'float', uNoiseScale: 'float',
  uDetailOctaves: 'float', uLitColor: 'rgb', uShadeColor: 'rgb', uAmbient: 'float',
  uLightDir: 'vec3', uDrift: 'vec2', uSteps: 'int', uResolutionScale: 'float',
}

// Reconcile LIVE params into an ALREADY-MOUNTED cloud mesh without re-mounting
// (inspector edits must apply per frame — the mesh/material identity is kept so
// the GPU program never recompiles). Re-runs buildUniforms(p) — the fail-loud
// validator — then copies values into the mounted uniforms by declared shape.
// A size change re-fits the box SCALE against the mount-time geometry dims
// (the geometry itself is never rebuilt).
export function syncCloudUniforms(entry, p) {
  if (!entry || !entry.uniforms || !entry.mesh) {
    throw new Error(`volumetric-cloud: syncCloudUniforms needs a mounted { mesh, uniforms } entry — fail loud`)
  }
  const u = buildUniforms(p)
  for (const k of Object.keys(u)) {
    const target = entry.uniforms[k]
    if (!target) {
      throw new Error(`volumetric-cloud: mounted mesh is missing uniform '${k}' — fail loud`)
    }
    const v = u[k].value
    const shape = UNIFORM_SHAPE[k]
    if (shape === 'vec3') target.value.set(v.x, v.y ?? 0, v.z)
    else if (shape === 'rgb') target.value.set(v.r, v.g, v.b)
    else if (shape === 'vec2') target.value.set(v.x, v.z)
    else target.value = v
  }
  if (entry.base) {
    entry.mesh.scale.set(p.sizeX / entry.base.x, p.sizeY / entry.base.y, p.sizeZ / entry.base.z)
  }
}

// Mount the region's raymarched box. Caller owns lifecycle (unmount/destroy on
// detach / scene switch). Uniforms come from buildUniforms(p) — the system
// reconciles params → uniforms each fixed step.
export function createCloudMesh(p) {
  const uniforms = buildUniforms(p)
  const threeUniforms = {}
  for (const k of Object.keys(uniforms)) {
    const v = uniforms[k].value
    let value = v
    if (UNIFORM_SHAPE[k] === 'vec3') value = new THREE.Vector3(v.x, v.y ?? 0, v.z)
    else if (UNIFORM_SHAPE[k] === 'rgb') value = new THREE.Vector3(v.r, v.g, v.b)
    else if (UNIFORM_SHAPE[k] === 'vec2') value = new THREE.Vector2(v.x, v.z)
    threeUniforms[k] = { value }
  }

  const geo = new THREE.BoxGeometry(p.sizeX, p.sizeY, p.sizeZ)
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: threeUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  return { mesh, uniforms: threeUniforms, material: mat, geometry: geo }
}
