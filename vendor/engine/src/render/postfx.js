/**
 * Engine — post-processing / effects stack (RENDERING-PIPELINE.md §Stage 2 / R2).
 *
 * The renderer draws the whole scene in ONE pass (batched exactly as today)
 * into an off-screen target, then a configurable chain of post-FX passes
 * composites it to screen. Batching is untouched: the scene render is unchanged;
 * only what happens AFTER is new.
 *
 * Post-FX is SCENE DATA — an optional top-level scene block
 *
 *   render: { post: { enabled, passes: [{ type, params }] } }
 *
 * so it round-trips, is editor-authored, and survives save/load/build. Pass
 * types are genre-agnostic engine infra, not gameplay vocabulary.
 *
 * Supported passes:
 *   - `grade`     color grade — brightness / contrast / saturation / gamma
 *                 (an inline ShaderPass; a cheap, deterministic filmic-ish grade).
 *   - `bloom`     UnrealBloomPass (strength / radius / threshold).
 *   - `vignette`  three's VignetteShader (radius -> offset, strength -> darkness).
 *   - `grain`     inline film grain (strength).
 *
 * An OutputPass is always appended last so the composite leaves the composer in
 * the same sRGB space as the plain `renderer.render` path (no washed-out colors).
 *
 * This module is browser-bound (needs a WebGL renderer), so `normalizePostConfig`
 * / `postPassDefaults` are the pure, unit-testable parts; `createPostFX` builds
 * the live chain.
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js'
import { wrapUniforms } from './shaders.js'

/** The BUILT-IN post-FX pass types (genre-agnostic). Custom pass scripts add more. */
export const POST_PASS_TYPES = ['grade', 'bloom', 'vignette', 'grain']

/** Default full-screen vertex shader for custom post passes. */
export const POST_PASS_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`

/** Default params for each pass type (a valid `params` for a pass). */
export function postPassDefaults(type) {
  switch (type) {
    case 'grade': return { brightness: 0.0, contrast: 1.0, saturation: 1.0, gamma: 1.0 }
    case 'bloom': return { strength: 0.8, radius: 0.4, threshold: 0.85 }
    case 'vignette': return { strength: 0.8, radius: 1.0 }
    case 'grain': return { strength: 0.1 }
    default: return {}
  }
}

/**
 * Normalize/validate a custom post-FX script def. A custom pass is a full-screen
 * shader with editable uniforms:
 *   { name, label?, shader: { vertex?, fragment, uniforms: { <name>: default } } }
 * Returns a NEW def. Throws on a missing fragment shader / name.
 * @param {object} def
 * @returns {{ name: string, label: string, shader: { vertex: string, fragment: string, uniforms: object } }}
 */
export function normalizeCustomPassDef(def = {}) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw new TypeError('custom post pass def must be an object')
  }
  if (typeof def.name !== 'string' || def.name === '') {
    throw new TypeError('custom post pass name must be a non-empty string')
  }
  const shader = (def.shader && typeof def.shader === 'object' && !Array.isArray(def.shader)) ? def.shader : {}
  const fragment = typeof shader.fragment === 'string' && shader.fragment.trim() ? shader.fragment : ''
  if (!fragment) {
    throw new TypeError(`custom post pass "${def.name}" requires a non-empty fragment shader`)
  }
  const vertex = (typeof shader.vertex === 'string' && shader.vertex.trim()) ? shader.vertex : POST_PASS_VERTEX
  const uniforms = (shader.uniforms && typeof shader.uniforms === 'object' && !Array.isArray(shader.uniforms))
    ? shader.uniforms
    : {}
  return { name: def.name, label: typeof def.label === 'string' ? def.label : def.name, shader: { vertex, fragment, uniforms } }
}

/** The `params` (uniform) defaults for a custom pass, from its def. */
export function customPassDefaults(def) {
  return { ...(def && def.shader && def.shader.uniforms ? def.shader.uniforms : {}) }
}

/** Resolve a custom pass def from a registry/map (get/has-aware or plain object). */
function resolveCustomPass(name, customPasses) {
  if (!customPasses) return undefined
  if (typeof customPasses.get === 'function') {
    if (typeof customPasses.has === 'function' && !customPasses.has(name)) return undefined
    return customPasses.getDef ? customPasses.getDef(name) : customPasses.get(name)
  }
  return customPasses[name]
}

/** The known custom pass names from a registry/map (for config validation). */
function customPassNames(customPasses) {
  if (!customPasses) return []
  if (typeof customPasses.list === 'function') return customPasses.list()
  return Object.keys(customPasses)
}

/**
 * Build a ShaderPass from a custom pass def, applying per-pass uniform params.
 * The params are MERGED into the def's uniform defaults BEFORE the ShaderPass is
 * constructed, so ShaderMaterial is created with the final values (reassigning
 * `pass.uniforms[k]` after construction does not reliably reach the GPU).
 * @param {object} def      a normalized custom pass def
 * @param {object} params   the pass's `params` (uniform overrides, plain values)
 * @returns {ShaderPass}
 */
function buildCustomPass(def, params = {}) {
  const uniforms = { ...def.shader.uniforms, ...params }
  return new ShaderPass({
    uniforms: wrapUniforms(uniforms),
    vertexShader: def.shader.vertex,
    fragmentShader: def.shader.fragment,
  })
}

/** The default `render.post` block (disabled). */
export function postConfigDefaults() {
  return {
    enabled: false,
    passes: [
      { type: 'grade', params: postPassDefaults('grade') },
      { type: 'bloom', params: postPassDefaults('bloom') },
      { type: 'vignette', params: postPassDefaults('vignette') },
      { type: 'grain', params: postPassDefaults('grain') },
    ],
  }
}

/** Clamp a numeric param to [min,max] (or return `fallback` when non-finite). */
function num(v, min, max, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/**
 * Normalize/validate a `render.post` block into a clean shape. Returns a NEW
 * object (input never mutated). Throws TypeError on an unknown pass type or a
 * malformed block, so a typo'd pass can't silently no-op. `knownCustom` is the
 * list of registered custom pass names (from folder post-FX scripts); a pass
 * type is valid if it's a built-in OR in `knownCustom`.
 * @param {object} [cfg]  the raw `render.post` block (or undefined/null).
 * @param {string[]} [knownCustom=[]]  custom pass names that are valid types.
 * @returns {{ enabled: boolean, passes: Array<{type:string, params:object}> }}
 */
export function normalizePostConfig(cfg = postConfigDefaults(), knownCustom = []) {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new TypeError('render.post must be an object')
  }
  const enabled = cfg.enabled !== false
  const rawPasses = Array.isArray(cfg.passes) ? cfg.passes : []
  const passes = rawPasses.map((p, i) => {
    if (!p || typeof p !== 'object' || typeof p.type !== 'string' || p.type === '') {
      throw new TypeError(`render.post.passes[${i}] must be an object with a non-empty type`)
    }
    const known = POST_PASS_TYPES.includes(p.type) || knownCustom.includes(p.type)
    if (!known) {
      throw new TypeError(`render.post.passes[${i}].type must be one of ${[...POST_PASS_TYPES, ...knownCustom].join('|')}, got "${p.type}"`)
    }
    const params = postPassDefaults(p.type)
    const raw = p.params && typeof p.params === 'object' && !Array.isArray(p.params) ? p.params : {}
    switch (p.type) {
      case 'grade':
        params.brightness = num(raw.brightness, -1, 1, params.brightness)
        params.contrast = num(raw.contrast, 0.1, 3, params.contrast)
        params.saturation = num(raw.saturation, 0, 3, params.saturation)
        params.gamma = num(raw.gamma, 0.2, 4, params.gamma)
        break
      case 'bloom':
        params.strength = num(raw.strength, 0, 4, params.strength)
        params.radius = num(raw.radius, 0, 1, params.radius)
        params.threshold = num(raw.threshold, 0, 1, params.threshold)
        break
      case 'vignette':
        params.strength = num(raw.strength, 0, 2, params.strength)
        params.radius = num(raw.radius, 0.1, 3, params.radius)
        break
      case 'grain':
        params.strength = num(raw.strength, 0, 1, params.strength)
        break
      default:
        // Custom pass: keep the params as plain values (uniform overrides);
        // the shader's own defaults fill in anything not provided at build time.
        for (const [k, v] of Object.entries(raw)) {
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            // color-ish object — store as-is (a #rrggbb string is preferred)
            params[k] = v
          } else if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string' || Array.isArray(v)) {
            params[k] = v
          }
        }
        break
    }
    return { type: p.type, params }
  })
  return { enabled, passes }
}

/** Inline color-grade shader (brightness/contrast/saturation/gamma). */
const ColorGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    brightness: { value: 0.0 },
    contrast: { value: 1.0 },
    saturation: { value: 1.0 },
    gamma: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float brightness;
    uniform float contrast;
    uniform float saturation;
    uniform float gamma;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      c.rgb += brightness;
      c.rgb = (c.rgb - 0.5) * contrast + 0.5;
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(vec3(l), c.rgb, saturation);
      c.rgb = pow(max(c.rgb, vec3(0.0)), vec3(1.0 / max(gamma, 0.0001)));
      gl_FragColor = vec4(c.rgb, c.a);
    }
  `,
}

/** Inline film-grain shader (per-pixel hash noise). */
const GrainShader = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.1 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float g = (hash(vUv + fract(sin(gl_FragCoord.xy) * 0.0001)) - 0.5) * strength;
      gl_FragColor = vec4(c.rgb + g, c.a);
    }
  `,
}

/**
 * Build ONE post pass instance from a normalized pass descriptor. Built-in
 * types build their fixed passes; any other type is resolved against the
 * `customPasses` registry/map (a folder post-FX script) and built as a
 * ShaderPass with its params applied as uniform overrides.
 * @param {{ type: string, params: object }} pass
 * @param {object} [customPasses]  { name: def } or a get/has-aware registry
 * @returns {import('three/examples/jsm/postprocessing/Pass.js').Pass}
 */
function buildPass(pass, customPasses) {
  const { type, params } = pass
  switch (type) {
    case 'grade': {
      const sp = new ShaderPass(ColorGradeShader)
      sp.uniforms.brightness.value = params.brightness
      sp.uniforms.contrast.value = params.contrast
      sp.uniforms.saturation.value = params.saturation
      sp.uniforms.gamma.value = params.gamma
      return sp
    }
    case 'bloom':
      return new UnrealBloomPass(new THREE.Vector2(512, 512), params.strength, params.radius, params.threshold)
    case 'vignette': {
      const sp = new ShaderPass(VignetteShader)
      // VignetteShader uniforms: offset (radius) + darkness (strength).
      sp.uniforms.offset.value = params.radius
      sp.uniforms.darkness.value = params.strength
      return sp
    }
    case 'grain': {
      const sp = new ShaderPass(GrainShader)
      sp.uniforms.strength.value = params.strength
      return sp
    }
    default: {
      const def = resolveCustomPass(type, customPasses)
      if (!def) throw new TypeError(`unknown post pass type "${type}" (not a built-in or a registered custom post-FX script)`)
      return buildCustomPass(normalizeCustomPassDef(def), params)
    }
  }
}

/**
 * Create the post-FX chain for a renderer/scene/camera.
 *
 * @param {object} opts
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {THREE.Scene} opts.scene
 * @param {THREE.Camera} opts.camera
 * @returns {{
 *   enabled: boolean,
 *   setChain(config|null): this,
 *   render(): void,
 *   resize(): void,
 *   dispose(): void,
 * }}
 */
export function createPostFX({ renderer, scene, camera, customPasses }) {
  let composer = null
  let config = normalizePostConfig(postConfigDefaults())

  /** (Re)build the EffectComposer chain from a `render.post` config (or null). */
  function setChain(raw) {
    const knownCustom = customPassNames(customPasses)
    const next = raw
      ? normalizePostConfig(raw, knownCustom)
      : normalizePostConfig({ enabled: false }, knownCustom)
    config = next
    if (composer) { composer.dispose(); composer = null }
    if (!next.enabled || next.passes.length === 0) return this
    composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    for (const pass of next.passes) composer.addPass(buildPass(pass, customPasses))
    // Always finish in the renderer's output color space (sRGB) so the
    // composite matches the plain render path (no washed-out colors).
    composer.addPass(new OutputPass())
    resize()
    return this
  }

  /** Match the composer targets to the renderer's drawing-buffer size. */
  function resize() {
    if (!composer) return
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    composer.setPixelRatio(renderer.getPixelRatio())
    composer.setSize(Math.floor(size.width), Math.floor(size.height))
  }

  /** Render the scene through the chain (one scene pass + post passes). */
  function render() {
    if (composer) composer.render()
  }

  function dispose() {
    if (composer) { composer.dispose(); composer = null }
  }

  return {
    get enabled() { return config.enabled && composer !== null },
    // Exposed for tests/debugging — the live EffectComposer (null when off).
    get composer() { return composer },
    setChain,
    render,
    resize,
    dispose,
  }
}
