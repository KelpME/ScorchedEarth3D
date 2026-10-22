/**
 * Engine — custom shaders (RENDERING-PIPELINE.md §Stage 3 / R3).
 *
 * A shader is a NAMED def { name, vertex, fragment, uniforms } — GLSL sources +
 * a plain `uniforms` map ({ <name>: value }). Shaders are folder-driven
 * (`games/<game>/shaders/*.js`, each exporting a def), registered into a
 * ShaderRegistry, and referenced by a scene MATERIAL of `type: 'custom'`
 * (`{ type: 'custom', shader: '<name>', uniforms?: {...} }`).
 *
 * Custom-shader materials are UNIQUE by design: an entity whose material
 * resolves to a ShaderMaterial opts OUT of ECS auto-batching and renders
 * individually (the documented R3 trade-off — batched standard/material
 * entities are unaffected). See batching.js + the renderer.
 *
 * `shaderHealth` provides a compile-health check (the model-health philosophy:
 * reject a broken shader at edit, not at runtime). It validates the def shape,
 * that uniforms are JSON-serializable, and — when a WebGL renderer is supplied
 * — that the shader actually compiles on the GPU (capturing three's "Shader
 * Error" console output). The pure shape/JSON checks are unit-testable in Node.
 *
 * This module imports `three` but only constructs Material objects (no WebGL
 * context needed), so ShaderRegistry / buildShaderMaterial / shaderHealth are
 * Node/vitest-safe.
 */
import * as THREE from 'three'

/**
 * Convert a plain uniform value (scalar / [x,y,z] / [x,y,z,w] / '#rrggbb') into
 * a three uniform `{ value }`. Vectors and colors become THREE objects; scalars
 * and booleans pass through.
 */
export function toUniformValue(v) {
  if (Array.isArray(v)) {
    if (v.length === 2) return new THREE.Vector2(v[0], v[1])
    if (v.length === 3) return new THREE.Vector3(v[0], v[1], v[2])
    if (v.length === 4) return new THREE.Vector4(v[0], v[1], v[2], v[3])
    return v
  }
  if (typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return new THREE.Color(v)
  if (typeof v === 'object' && v !== null && typeof v.isColor === 'function') return v
  return v
}

/** Wrap a plain `{ name: value }` uniforms map into three's `{ name: { value } }`. */
export function wrapUniforms(uniforms) {
  const out = {}
  for (const [k, v] of Object.entries(uniforms || {})) out[k] = { value: toUniformValue(v) }
  return out
}

/** Sensible defaults for a shader def. */
export function shaderDefaults() {
  return { name: '', vertex: '', fragment: '', uniforms: {} }
}

/** A canonical vertex shader (passes through position + uv) for minimal shaders. */
export const DEFAULT_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`

/** A canonical fragment shader (flat tint from a `color` uniform). */
export const DEFAULT_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(color, 1.0); }
`

/**
 * Validate/normalize a shader def: coerce to a clean shape, apply defaults.
 * Returns a NEW def. Throws TypeError on a malformed def.
 * @param {object} def
 * @returns {{ name: string, vertex: string, fragment: string, uniforms: object }}
 */
export function normalizeShaderDef(def = {}) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw new TypeError('shader def must be an object')
  }
  if (typeof def.name !== 'string' || def.name === '') {
    throw new TypeError('shader name must be a non-empty string')
  }
  const vertex = typeof def.vertex === 'string' && def.vertex.trim() ? def.vertex : DEFAULT_VERTEX
  const fragment = typeof def.fragment === 'string' && def.fragment.trim() ? def.fragment : DEFAULT_FRAGMENT
  const uniforms = def.uniforms && typeof def.uniforms === 'object' && !Array.isArray(def.uniforms)
    ? def.uniforms
    : {}
  return { name: def.name, vertex, fragment, uniforms }
}

/**
 * Build a fresh THREE.ShaderMaterial from a normalized shader def (vertex +
 * fragment + wrapped uniforms). Pure (no WebGL needed to construct).
 * @param {object} def
 * @returns {THREE.ShaderMaterial}
 */
export function buildShaderMaterial(def) {
  const d = normalizeShaderDef(def)
  return new THREE.ShaderMaterial({
    vertexShader: d.vertex,
    fragmentShader: d.fragment,
    uniforms: wrapUniforms(d.uniforms),
  })
}

/**
 * Compile-health check for a shader def — the model-health philosophy applied
 * to shaders: reject a broken shader at EDIT, not at runtime. Returns a
 * structured `{ ok, errors }`. When a WebGL `renderer` is supplied, also
 * compiles on the GPU and captures three's "Shader Error" console output to
 * catch genuine GLSL errors. The pure shape/JSON/constructor checks always run.
 * @param {object} def
 * @param {THREE.WebGLRenderer} [renderer]  optional — to do a real GL compile.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function shaderHealth(def, renderer) {
  const errors = []
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    return { ok: false, errors: ['shader def must be an object'] }
  }
  if (typeof def.name !== 'string' || def.name === '') {
    errors.push('shader name must be a non-empty string')
  }
  if (typeof def.vertex !== 'string' || !def.vertex.trim()) {
    errors.push('vertex shader must be a non-empty string')
  }
  if (typeof def.fragment !== 'string' || !def.fragment.trim()) {
    errors.push('fragment shader must be a non-empty string')
  }
  if (def.uniforms !== undefined) {
    if (!def.uniforms || typeof def.uniforms !== 'object' || Array.isArray(def.uniforms)) {
      errors.push('shader uniforms must be an object')
    } else {
      for (const [k, v] of Object.entries(def.uniforms)) {
        if (typeof v === 'function') errors.push(`uniform "${k}" must be a plain value, got a function`)
        else if (typeof v === 'object' && v !== null) {
          try { JSON.stringify(v) } catch { errors.push(`uniform "${k}" is not JSON-serializable`) }
        }
      }
    }
  }
  // A constructor-time build catches shape errors (e.g. a name the renderer
  // can't wrap) without needing a GPU.
  if (errors.length === 0) {
    try { buildShaderMaterial(def) } catch (err) { errors.push(`ShaderMaterial construction failed: ${err.message}`) }
  }
  // Real GPU compile via the provided renderer: three logs "THREE.WebGLProgram:
  // Shader Error ..." to console on a genuine GLSL failure. Capture + reject.
  if (errors.length === 0 && renderer && typeof renderer.compile === 'function') {
    const logs = []
    const orig = console.error
    console.error = (...args) => { logs.push(String(args[0] || '')) }
    try {
      const material = buildShaderMaterial(def)
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)
      const cam = new THREE.PerspectiveCamera()
      renderer.compile(mesh, cam)
    } catch (err) { logs.push(String((err && err.message) || err)) }
    finally { console.error = orig }
    if (logs.some((l) => /shader error|shader compile|error: 0:/.test(l))) {
      errors.push('shader failed to compile on the GPU (see the console for details)')
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * A registry of named shader defs -> built THREE.ShaderMaterials. Mirror of the
 * material/script/system registries. `register` validates the def + builds the
 * material (so a broken def is rejected at registration). Re-registering a name
 * replaces it (returns `typeChanged` semantics are N/A — shaders are always
 * unique ShaderMaterials).
 */
export class ShaderRegistry {
  constructor() {
    this._defs = new Map() // name -> normalized def
    this._built = new Map() // name -> THREE.ShaderMaterial
  }

  register(name, def) {
    if (!name || typeof name !== 'string') throw new TypeError('shader name must be a string')
    const d = normalizeShaderDef({ ...def, name })
    const mat = buildShaderMaterial(d)
    const prev = this._built.get(name)
    if (prev && typeof prev.dispose === 'function') prev.dispose()
    this._defs.set(name, d)
    this._built.set(name, mat)
    return this
  }

  has(name) { return this._defs.has(name) }

  list() { return [...this._defs.keys()] }

  getDef(name) { return this._defs.get(name) }

  /** The built THREE.ShaderMaterial for `name` (or undefined). */
  get(name) { return this._built.get(name) }

  /** The built-material resolver map (name -> ShaderMaterial) for the renderer. */
  get materials() { return this._built }

  /** Rebuild the material for a def — IN PLACE, so live shader edits propagate
   *  to every mesh/material holding the same reference (stable identity). */
  rebuild(name) {
    const d = this._defs.get(name)
    if (!d) return null
    const mat = this._built.get(name)
    if (!mat) {
      const next = buildShaderMaterial(d)
      this._built.set(name, next)
      return { material: next, typeChanged: false }
    }
    applyShaderDefToMaterial(mat, d)
    return { material: mat, typeChanged: false }
  }

  /** Update a def + rebuild IN PLACE (stable identity → live recompile). The
   *  editor's Shaders panel calls this after a Save so every custom material
   *  that references the shader updates live. New shaders use `register`. */
  update(name, def) {
    if (!name || typeof name !== 'string') throw new TypeError('shader name must be a string')
    const d = normalizeShaderDef({ ...def, name })
    this._defs.set(name, d)
    const mat = this._built.get(name)
    if (mat) applyShaderDefToMaterial(mat, d)
    else this._built.set(name, buildShaderMaterial(d))
    return this
  }
}

/**
 * Apply a (normalized) shader def onto an EXISTING THREE.ShaderMaterial IN
 * PLACE — new vertex/fragment sources + uniforms — so a live shader edit
 * updates every mesh/material that holds the same material reference without a
 * rebuild. Returns the material (same identity).
 * @param {THREE.ShaderMaterial} mat
 * @param {object} def
 * @returns {THREE.ShaderMaterial}
 */
export function applyShaderDefToMaterial(mat, def) {
  const d = normalizeShaderDef(def)
  mat.vertexShader = d.vertex
  mat.fragmentShader = d.fragment
  // Mutate the EXISTING uniforms object IN PLACE rather than replacing the
  // reference. three's WebGLRenderer caches a persistent reference to
  // `material.uniforms` (materialProperties.uniforms) at first program
  // acquisition and uploads from THAT object every frame. When the shader
  // source is unchanged (only a uniform VALUE was edited), the program cache
  // key is identical, the renderer early-outs on setProgram, and a freshly
  // REPLACED uniforms object is never picked up — the GPU keeps rendering the
  // old value. Updating each uniform's value on the SAME object lets a
  // uniform-only live edit reach the GPU immediately. A shader-text change
  // still recompiles (the program cache key derives from the GLSL source).
  const next = wrapUniforms(d.uniforms)
  for (const k of Object.keys(mat.uniforms)) {
    if (!(k in next)) delete mat.uniforms[k]
  }
  for (const [k, u] of Object.entries(next)) {
    if (mat.uniforms[k]) mat.uniforms[k].value = u.value
    else mat.uniforms[k] = u
  }
  mat.needsUpdate = true
  return mat
}

/** The `api.shaders` surface (mirror of api.materials/api.scripts/api.systems). */
export function createShadersApi(registry) {
  return {
    list: () => registry.list(),
    has: (name) => registry.has(name),
    register: (name, def) => registry.register(name, def),
    get: (name) => registry.get(name),
    getDef: (name) => registry.getDef(name),
    rebuild: (name) => registry.rebuild(name),
    update: (name, def) => registry.update(name, def),
    }
}
