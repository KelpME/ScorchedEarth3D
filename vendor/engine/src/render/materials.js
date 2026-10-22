/**
 * Engine — data-driven material registry (RENDERING-PIPELINE.md §Stage 1 / R1).
 *
 * Materials are SCENE DATA: a scene carries an optional top-level `materials`
 * map
 *
 *   { <name>: { type, color, roughness, metalness, emissive,
 *               emissiveIntensity, map?, normalMap? } }
 *
 * and the engine builds the corresponding THREE.Material from each def.
 * Entities reference a material by NAME (existing behaviour unchanged) or
 * override one per-entity via `render.materialParams` (a lightweight clone +
 * override; instanced tint remains the cheap per-entity case).
 *
 * This module is the single place that turns a material def into a THREE
 * material, shared by the editor and shipped games (via `api.materials`). It
 * imports `three` but only constructs Material objects — no WebGL context is
 * needed — so `normalizeMaterialDef` / `buildMaterial` are pure and
 * unit-testable in Node/vitest.
 *
 * Registry shape mirrors ScriptRegistry/SystemRegistry (register / has / list /
 * get) plus `rebuild` (live material rebuild from a def) and `getDef`, so the
 * editor can edit a def then rebuild the live THREE material in the viewport.
 */

import * as THREE from 'three'
import { buildShaderMaterial, toUniformValue } from './shaders.js'

/** The supported material types (genre-agnostic). `custom` = a folder shader.
 *  Legacy `physical` defs normalize to `standard` in normalizeMaterialDef. */
const TYPES = new Set(['standard', 'basic', 'custom'])

/** Sensible defaults for a material def (type + color + PBR params). */
export function materialDefaults() {
  return {
    type: 'standard',
    color: '#888888',
    roughness: 0.6,
    metalness: 0.0,
    emissive: '#000000',
    emissiveIntensity: 1.0,
  }
}

/**
 * Normalize/validate a material def: apply defaults, coerce to a clean shape.
 * Returns a NEW def (the input is never mutated). Throws TypeError on an
 * invalid `type` (the editor validates the same rule before saving).
 * LEGACY ALIAS (MAT-3): `type:'physical'` normalizes to 'standard' on LOAD —
 * MeshPhysicalMaterial bought nothing here (only color/roughness/metalness
 * were ever set), and the name implied physics-surface data that lives on
 * rigid bodies, not render materials. No game migration: old defs normalize
 * on load and rewrite as 'standard' on their next save.
 * A `custom` def additionally carries `shader` (the named folder shader) and
 * optional `uniforms` (per-material overrides).
 * @param {object} def
 * @returns {{ type: string, color: string, roughness: number, metalness: number,
 *            emissive: string, emissiveIntensity: number, map?: string, normalMap?: string,
 *            shader?: string, uniforms?: object }}
 */
export function normalizeMaterialDef(def = {}) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw new TypeError('material def must be an object')
  }
  const LEGACY_ALIASES = { physical: 'standard' } // MAT-3: physical → standard on load
  let type = def.type || 'standard'
  if (LEGACY_ALIASES[type]) type = LEGACY_ALIASES[type]
  if (!TYPES.has(type)) {
    throw new TypeError(`material type must be one of standard|basic|custom (legacy "physical" aliases to standard), got "${type}"`)
  }
  const d = materialDefaults()
  const out = {
    type,
    color: def.color ?? d.color,
    roughness: def.roughness ?? d.roughness,
    metalness: def.metalness ?? d.metalness,
    emissive: def.emissive ?? d.emissive,
    emissiveIntensity: def.emissiveIntensity ?? d.emissiveIntensity,
  }
  if (def.transparent !== undefined) {
    if (typeof def.transparent !== 'boolean') {
      throw new TypeError('material def transparent must be a boolean')
    }
    out.transparent = def.transparent
  }
  if (def.opacity !== undefined) {
    if (typeof def.opacity !== 'number' || !Number.isFinite(def.opacity)) {
      throw new TypeError('material def opacity must be a finite number')
    }
    out.opacity = Math.min(1, Math.max(0, def.opacity)) // clamp, never reject
  }
  if (def.map !== undefined) out.map = def.map
  if (def.normalMap !== undefined) out.normalMap = def.normalMap
  if (type === 'custom') {
    if (typeof def.shader !== 'string' || def.shader === '') {
      throw new TypeError('custom material def requires a non-empty shader name')
    }
    out.shader = def.shader
    if (def.uniforms !== undefined) {
      if (!def.uniforms || typeof def.uniforms !== 'object' || Array.isArray(def.uniforms)) {
        throw new TypeError('custom material uniforms must be an object')
      }
      out.uniforms = def.uniforms
    }
  }
  return out
}

/**
 * Build a fresh THREE.Material from a material def. Pure (no WebGL needed).
 * `textures` is an optional `{ name: THREE.Texture }` map used to resolve the
 * `map`/`normalMap` asset refs; unknown refs leave the slot unset (a texture
 * registered later via setTexture triggers a rebuild). `shaders` is an
 * optional ShaderRegistry (or { name: ShaderMaterial }) used to resolve a
 * `custom` material's `shader` reference.
 * @param {object} def
 * @param {Record<string, THREE.Texture>} [textures]
 * @param {object} [shaders]  ShaderRegistry or name->ShaderMaterial map
 * @returns {THREE.Material}
 */
export function buildMaterial(def, textures = {}, shaders) {
  const d = normalizeMaterialDef(def)
  if (d.type === 'custom') return buildCustomMaterial(d, shaders, textures)
  const color = new THREE.Color(d.color)
  // `physical` never reaches this branch: normalizeMaterialDef aliases it to
  // 'standard' (MeshPhysicalMaterial only ever received color/roughness/
  // metalness — identical to standard at a heavier shader cost).
  let mat
  if (d.type === 'basic') {
    mat = new THREE.MeshBasicMaterial({ color })
  } else {
    mat = new THREE.MeshStandardMaterial({ color, roughness: d.roughness, metalness: d.metalness })
  }
  if (d.emissive && d.type !== 'basic') {
    mat.emissive = new THREE.Color(d.emissive)
    mat.emissiveIntensity = d.emissiveIntensity
  }
  if (d.transparent === true) {
    mat.transparent = true
    mat.opacity = d.opacity ?? 0.5
    // depthWrite stays THREE-default (true): glass panes are thin, disjoint,
    // and must depth-sort correctly against the voxel slab behind them.
  }
  if (d.map && textures[d.map]) mat.map = textures[d.map]
  // normalMap is NOT honored on basic (unlit — MeshBasicMaterial has no normal
  // shading; assigning it would be a silently-dropped stray property, the
  // same class as the pre-MAT-2 basic card drift). Schema `honored:false` on
  // the UI side; the build side enforces the same contract here.
  if (d.normalMap && d.type !== 'basic' && textures[d.normalMap]) mat.normalMap = textures[d.normalMap]
  return mat
}

/**
 * Build a custom (shader) material: resolve the named shader, then apply any
 * per-material uniform overrides, the material's own `color` (feeding a
 * color-named shader uniform), and the material's `map` TEXTURE (feeding a
 * `map`/`tDiffuse` sampler uniform). So a custom shader inherits both the
 * object's assigned material color AND its texture — e.g. a textured character
 * with the cell shader keeps its texture, with toon shading on top.
 *
 * A color-named shader uniform (`baseColor`, `color`, `diffuse`) is seeded from
 * the material def's `color` when one is authored; explicit `d.uniforms` win.
 * A `map`/`tDiffuse` sampler is set from the material's resolved `map` texture
 * when present (and a `USE_MAP` define is set so the shader can #ifdef it).
 * WITHOUT any per-material injection it returns the shader's OWN ShaderMaterial
 * (a shared reference) so editing the shader updates every material that
 * references it live. WITH injection it returns a clone.
 * @param {object} d  a normalized custom material def
 * @param {object} [shaders]  ShaderRegistry or { name: ShaderMaterial }
 * @param {Record<string, THREE.Texture>} [textures]  name -> texture
 * @returns {THREE.ShaderMaterial}
 */
function buildCustomMaterial(d, shaders, textures = {}) {
  const shaderMat = resolveShaderMaterial(d.shader, shaders)
  // Figure out any per-material injection: explicit uniform overrides + the
  // material's own color feeding a color-named shader uniform.
  const inject = {}
  const defines = {}
  const overrides = (d.uniforms && typeof d.uniforms === 'object' && !Array.isArray(d.uniforms)) ? d.uniforms : {}
  for (const [k, v] of Object.entries(overrides)) inject[k] = v
  // Seed a color uniform from the material's color if the shader declares one,
  // the user hasn't overridden it explicitly, AND the material's color is
  // actually AUTHORED (not the generic default) — so a plain custom material
  // keeps sharing the shader's material (live edits propagate), while an
  // authored color (green object) seeds the shader.
  const defaultColor = materialDefaults().color
  if (d.color && String(d.color).toLowerCase() !== String(defaultColor).toLowerCase() && shaderMat.uniforms) {
    for (const cn of ['baseColor', 'color', 'diffuse']) {
      const u = shaderMat.uniforms[cn]
      if (u && inject[cn] === undefined) {
        const shaderDefault = u.value && typeof u.value.getHexString === 'function' ? `#${u.value.getHexString()}` : undefined
        if (shaderDefault === undefined || shaderDefault.toLowerCase() !== String(d.color).toLowerCase()) {
          inject[cn] = d.color
        }
        break
      }
    }
  }
  // Seed a TEXTURE sampler from the material's `map` when present. The shader
  // must declare `uniform sampler2D map;` in its GLSL to use it (the cell/toon
  // preset does). We inject the texture + a USE_MAP define so the shader can
  // #ifdef it; if the material has no texture, nothing is injected and the
  // shader falls back to its own baseColor. (An unused sampler uniform is
  // harmless — three only binds the ones the compiled program declares.)
  if (d.map) {
    const tex = textures[d.map]
    if (tex && inject.map === undefined && inject.tDiffuse === undefined) {
      inject.map = tex
      defines.USE_MAP = '1' // non-empty so three's preprocessor emits #define USE_MAP 1
    }
  }
  if (Object.keys(inject).length === 0 && Object.keys(defines).length === 0) return shaderMat
  const clone = shaderMat.clone()
  if (Object.keys(defines).length) clone.defines = { ...(clone.defines || {}), ...defines }
  for (const [k, v] of Object.entries(inject)) clone.uniforms[k] = { value: toUniformValue(v) }
  clone.needsUpdate = true
  return clone
}

/** Resolve a named shader to its built ShaderMaterial (throws if unknown). */
function resolveShaderMaterial(name, shaders) {
  if (shaders && typeof shaders.get === 'function') {
    const mat = shaders.get(name)
    if (mat) return mat
    const def = shaders.getDef ? shaders.getDef(name) : undefined
    if (def) return buildShaderMaterial(def)
  } else if (shaders && typeof shaders === 'object') {
    const direct = shaders[name]
    if (direct && direct.isShaderMaterial) return direct
    if (direct && direct.vertex) return buildShaderMaterial(direct)
  }
  throw new TypeError(`custom material references unknown shader "${name}" — register it (games/<game>/shaders/*.js)`)
}

/**
 * Apply a def's params onto an EXISTING THREE material of the SAME class — used
 * for live rebuilds so an InstancedMesh holding that material updates in place
 * WITHOUT re-batching (the batch key is the material NAME, which is unchanged).
 * @param {THREE.Material} mat
 * @param {object} def
 * @param {Record<string, THREE.Texture>} [textures]
 * @returns {THREE.Material}
 */
export function applyDefToMaterial(mat, def, textures = {}) {
  const d = normalizeMaterialDef(def)
  mat.color = new THREE.Color(d.color)
  if (mat.roughness !== undefined) mat.roughness = d.roughness
  if (mat.metalness !== undefined) mat.metalness = d.metalness
  if (mat.emissive) {
    mat.emissive = new THREE.Color(d.emissive)
    mat.emissiveIntensity = d.emissiveIntensity
  }
  // Transparency parity with buildMaterial: the in-place (same-type) rebuild
  // path must honor `transparent`/`opacity` exactly like a fresh build, or a
  // live edit of those fields would only apply after a type change.
  mat.transparent = d.transparent === true
  mat.opacity = d.transparent === true ? (d.opacity ?? 0.5) : 1
  if (d.map && textures[d.map]) mat.map = textures[d.map]
  if (d.normalMap && d.type !== 'basic' && textures[d.normalMap]) mat.normalMap = textures[d.normalMap]
  mat.needsUpdate = true
  return mat
}

/**
 * A registry of named material defs -> built THREE materials. Mirror of the
 * script/system registries, but for the render surface.
 */
export class MaterialRegistry {
  /**
   * @param {object} [opts]
   * @param {Record<string, THREE.Texture>} [opts.textures]  name -> texture used
   *   to resolve `map`/`normalMap` asset refs.
   * @param {object} [opts.shaders]  a ShaderRegistry (or name->ShaderMaterial
   *   map) used to resolve `custom` material defs' `shader` references (R3).
   */
  constructor({ textures = {}, shaders } = {}) {
    this._defs = new Map() // name -> normalized def
    this._built = new Map() // name -> THREE.Material
    this._textures = textures
    this._shaders = shaders
  }

  /**
   * Register a material def. On FIRST registration builds its THREE material.
   * Re-registering a name updates the def and SYNCs the built material: same
   * type -> mutates the existing material IN PLACE (so an InstancedMesh holding
   * it updates live with no re-batch), different type -> builds a fresh one.
   * `custom` (shader) materials always rebuild fresh (they opt OUT of batching
   * anyway); a shared shader reference keeps object identity stable so live
   * shader edits still propagate.
   * @param {string} name
   * @param {object} def
   */
  register(name, def) {
    if (!name || typeof name !== 'string') throw new TypeError('material name must be a string')
    const d = normalizeMaterialDef(def)
    if (d.type === 'custom') {
      const next = buildMaterial(d, this._textures, this._shaders)
      const prev = this._built.get(name)
      if (prev && prev !== next && typeof prev.dispose === 'function') prev.dispose()
      this._defs.set(name, d)
      this._built.set(name, next)
      return this
    }
    const existing = this._built.get(name)
    const next = buildMaterial(d, this._textures, this._shaders)
    if (existing && existing.type === next.type) {
      applyDefToMaterial(existing, d, this._textures)
      if (typeof next.dispose === 'function') next.dispose()
      this._defs.set(name, d)
    } else {
      this._defs.set(name, d)
      this._built.set(name, next)
    }
    return this
  }

  has(name) {
    return this._defs.has(name)
  }

  list() {
    return [...this._defs.keys()]
  }

  /** The normalized def for `name` (or undefined). */
  getDef(name) {
    return this._defs.get(name)
  }

  /** The built THREE.Material for `name` (or undefined). */
  get(name) {
    return this._built.get(name)
  }

  /**
   * The built-material resolver map (name -> THREE.Material) passed to the
   * Renderer. Same object identity across rebuilds, so the Renderer always sees
   * the current materials.
   */
  get materials() {
    return this._built
  }

  /**
   * Register/replace a texture used to resolve `map`/`normalMap` refs, then
   * rebuild any material that references it so the live view updates.
   * @param {string} name
   * @param {THREE.Texture} tex
   */
  setTexture(name, tex) {
    this._textures[name] = tex
    for (const n of this.list()) {
      const d = this.getDef(n)
      if (d && (d.map === name || d.normalMap === name)) this.rebuild(n)
    }
    return this
  }

  /**
   * Rebuild the THREE material for a registered def.
   * - Same type -> mutates the existing material IN PLACE (live update, no
   *   re-batch; an InstancedMesh holding it updates next frame).
   * - Different type (e.g. standard -> basic) -> builds a fresh material and
   *   returns `typeChanged: true` so the caller can re-create any batches that
   *   reference it.
   * @param {string} name
   * @returns {{ material: THREE.Material, typeChanged: boolean } | null}
   */
  rebuild(name) {
    const d = this._defs.get(name)
    if (!d) return null
    if (d.type === 'custom') {
      const next = buildMaterial(d, this._textures, this._shaders)
      const prev = this._built.get(name)
      if (prev && prev !== next && typeof prev.dispose === 'function') prev.dispose()
      this._built.set(name, next)
      return { material: next, typeChanged: true }
    }
    const existing = this._built.get(name)
    const next = buildMaterial(d, this._textures, this._shaders)
    if (existing && existing.type === next.type) {
      applyDefToMaterial(existing, d, this._textures)
      if (typeof next.dispose === 'function') next.dispose()
      return { material: existing, typeChanged: false }
    }
    this._built.set(name, next)
    return { material: next, typeChanged: true }
  }
}

/**
 * The `api.materials` surface exposed to the game host / editor: register a
 * def, get the built material, rebuild live. Mirror of api.scripts/api.systems.
 * @param {MaterialRegistry} registry
 */
export function createMaterialsApi(registry) {
  return {
    list: () => registry.list(),
    has: (name) => registry.has(name),
    register: (name, def) => registry.register(name, def),
    get: (name) => registry.get(name),
    getDef: (name) => registry.getDef(name),
    rebuild: (name) => registry.rebuild(name),
    // Register/replace a loaded texture by its logical asset id, then rebuild
    // any material whose map/normalMap references it (so the map actually
    // renders — R1-complete). The editor resolves the logical id -> file via
    // the manifest and calls this; a def alone never guesses a file path.
    setTexture: (name, tex) => registry.setTexture(name, tex),
  }
}

/** Logical texture-id -> manifest asset entry, tolerant of a bare id. */
function resolveTextureEntry(assets, id) {
  return assets[id] || assets[`texture/${String(id || '').replace(/^texture\//, '')}`]
}

/**
 * Load authored material defs from a game's `assets/materials/*.json` (the
 * dedicated material store). `index` is the manifest's top-level `materials`
 * map ({ <name>: 'assets/materials/<name>.json' }). Returns { <name>: def }
 * for every file that parses. Shared by the editor viewport and shipped games,
 * so materials authored as JSON assets drive both surfaces identically.
 * @param {Record<string,string>} index  material name -> game-relative src
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]  prefix for each src ('' for a game, e.g.
 *        '/games/<game>/' for the editor)
 * @returns {Promise<Record<string,object>>}
 */
export async function loadMaterialDefs(index, { baseUrl = '', fetchFn = fetch } = {}) {
  const defs = {}
  for (const [name, src] of Object.entries(index || {})) {
    try {
      const res = await fetchFn(`${baseUrl}${src}`)
      if (!res.ok) {
        console.error(`[materials] material "${name}" (${src}) could not be loaded (HTTP ${res.status})`)
        continue
      }
      const def = await res.json()
      if (def && typeof def === 'object' && !Array.isArray(def)) defs[name] = def
      else console.error(`[materials] material "${name}" (${src}) is not a JSON object`)
    } catch (err) {
      console.error(`[materials] material "${name}" (${src}) failed to load:`, (err && err.message) || err)
    }
  }
  return defs
}

/**
 * Load the textures referenced by a set of material defs and register them
 * into a material registry (so `map`/`normalMap` resolve to real images).
 * `assets` is the manifest's `assets` map (logical id -> { src, type }).
 * Shared by the editor (at boot) and shipped games (after createGame) so Play
 * and the editor render data-driven materials identically — the engine twin of
 * the editor's ensureMaterialTextures, callable from either.
 * @param {object} registry  a MaterialRegistry (api.materials works)
 * @param {Record<string,object>} defs  { name: def }
 * @param {Record<string,object>} assets  manifest assets map
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]  prefix for each texture src
 */
export async function loadMaterialTextures(registry, defs, assets, { baseUrl = '', fetchFn = fetch } = {}) {
  if (!registry || typeof registry.setTexture !== 'function') return
  const loaded = new Set()
  for (const def of Object.values(defs || {})) {
    for (const field of ['map', 'normalMap']) {
      const id = def && def[field]
      if (!id || typeof id !== 'string' || loaded.has(id)) continue
      loaded.add(id)
      const entry = resolveTextureEntry(assets || {}, id)
      if (!entry || !entry.src) {
        console.error(`[materials] material references ${field} "${id}" which is NOT in the manifest — the texture will not render`)
        continue
      }
      try {
        const tex = await new Promise((res, rej) => new THREE.TextureLoader().load(`${baseUrl}${entry.src}`, res, undefined, rej))
        // COLOR SPACE PER SLOT (MAT-5): `map` is authored sRGB; a `normalMap`
        // is tangent-space DATA and must stay linear (NoColorSpace) —
        // sRGB-decoding normals corrupts them. Mirrors the editor's
        // ensureMaterialTextures (editor/src/materials.js).
        tex.colorSpace = field === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace
        tex.needsUpdate = true
        registry.setTexture(id, tex)
      } catch (err) {
        console.error(`[materials] texture "${id}" (${entry.src}) failed to load:`, (err && err.message) || err)
      }
    }
  }
}
