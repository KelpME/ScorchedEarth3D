/**
 * Engine — data-driven lights (RENDERING-PIPELINE.md §Stage 4 / R4).
 *
 * Lights are SCENE DATA: an optional top-level `lights` array
 *
 *   [
 *     { type: 'ambient',       color, intensity },
 *     { type: 'directional',   color, intensity, position: [x,y,z], castShadow,
 *                              shadow: { mapSize, bias, near, far, left, right, top, bottom } },
 *     { type: 'point',         color, intensity, position: [x,y,z], distance, decay, castShadow },
 *     { type: 'spot',          color, intensity, position: [x,y,z], target, angle, penumbra,
 *                              castShadow, shadow: { mapSize, bias, near, far } },
 *     { type: 'hemisphere',    color, groundColor, intensity },
 *   ]
 *
 * replacing the hardcoded ambient + directional. A global shadow-map type lives
 * in `scene.render.shadows = { type: 'PCFSoftShadowMap' | 'PCFShadowMap' |
 * 'VSMShadowMap' }` (default PCFSoft, matching the pre-R4 default).
 *
 * When a scene carries NO `lights` array, the renderer falls back to the same
 * defaults as before (ambient 0xffffff 0.5 + directional 1.2 with soft
 * shadows), so existing scenes render identically.
 *
 * THREE light objects are constructible in Node (no WebGL), so the normalize +
 * build helpers here are pure and unit-testable.
 */
import * as THREE from 'three'

/** The supported light types (genre-agnostic). */
export const LIGHT_TYPES = ['directional', 'point', 'spot', 'hemisphere', 'ambient']

/** The supported global shadow-map types (THREE.ShadowMap type names). */
export const SHADOW_TYPES = ['PCFSoftShadowMap', 'PCFShadowMap', 'VSMShadowMap', 'BasicShadowMap']

/** Sensible defaults for each light type. */
export function lightDefaults(type) {
  switch (type) {
    case 'ambient': return { type, color: '#ffffff', intensity: 0.5 }
    case 'hemisphere': return { type, color: '#ffffff', groundColor: '#000000', intensity: 0.5 }
    case 'directional': return {
      type, color: '#ffffff', intensity: 1.2, position: [6, 14, 8], castShadow: true,
      shadow: { mapSize: 2048, bias: 0, near: 1, far: 60, left: -30, right: 30, top: 30, bottom: -30 },
    }
    case 'point': return {
      type, color: '#ffffff', intensity: 1, position: [0, 5, 0], distance: 0, decay: 2, castShadow: false,
    }
    case 'spot': return {
      type, color: '#ffffff', intensity: 1, position: [0, 10, 0], target: [0, 0, 0], angle: 0.5, penumbra: 0.2,
      distance: 0, decay: 2, castShadow: true,
      shadow: { mapSize: 1024, bias: 0, near: 0.5, far: 60 },
    }
    default: return { type, color: '#ffffff', intensity: 1 }
  }
}

/** The default `lights` array (matches the pre-R4 hardcoded defaults). */
export function lightsDefaults() {
  return [lightDefaults('ambient'), lightDefaults('directional')]
}

/** Clamp a number to [min,max] (or return `fallback` when non-finite). */
function num(v, min, max, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/**
 * Normalize/validate a `lights` array into a clean list. Returns a NEW array
 * (input never mutated). Throws TypeError on an unknown light type or a
 * malformed entry, so a typo'd light can't silently drop.
 * @param {Array<object>} [config]
 * @returns {Array<object>}
 */
export function normalizeLights(config) {
  if (config === undefined || config === null) return lightsDefaults()
  if (!Array.isArray(config)) throw new TypeError('lights must be an array')
  return config.map((l, i) => {
    if (!l || typeof l !== 'object' || typeof l.type !== 'string' || l.type === '') {
      throw new TypeError(`lights[${i}] must be an object with a non-empty type`)
    }
    if (!LIGHT_TYPES.includes(l.type)) {
      throw new TypeError(`lights[${i}].type must be one of ${LIGHT_TYPES.join('|')}, got "${l.type}"`)
    }
    const d = lightDefaults(l.type)
    const out = {
      type: l.type,
      color: typeof l.color === 'string' ? l.color : d.color,
      intensity: num(l.intensity, 0, 100, d.intensity),
    }
    if (l.type === 'hemisphere') out.groundColor = typeof l.groundColor === 'string' ? l.groundColor : d.groundColor
    if (l.type === 'directional' || l.type === 'point' || l.type === 'spot') {
      out.position = (Array.isArray(l.position) && l.position.length >= 3)
        ? [num(l.position[0], -1e4, 1e4, 0), num(l.position[1], -1e4, 1e4, 0), num(l.position[2], -1e4, 1e4, 0)]
        : d.position
      if (l.type === 'spot') {
        out.target = (Array.isArray(l.target) && l.target.length >= 3)
          ? [num(l.target[0], -1e4, 1e4, 0), num(l.target[1], -1e4, 1e4, 0), num(l.target[2], -1e4, 1e4, 0)]
          : d.target
        out.angle = num(l.angle, 0.01, Math.PI / 2, d.angle)
        out.penumbra = num(l.penumbra, 0, 1, d.penumbra)
        out.distance = num(l.distance, 0, 1e4, d.distance)
        out.decay = num(l.decay, 0, 4, d.decay)
      }
      if (l.type === 'point') {
        out.distance = num(l.distance, 0, 1e4, d.distance)
        out.decay = num(l.decay, 0, 4, d.decay)
      }
      out.castShadow = l.castShadow !== undefined ? Boolean(l.castShadow) : d.castShadow
      if (out.castShadow) {
        out.shadow = {
          mapSize: num(l.shadow && l.shadow.mapSize, 64, 8192, d.shadow ? d.shadow.mapSize : 2048),
          bias: num(l.shadow && l.shadow.bias, -1, 1, 0),
          near: num(l.shadow && l.shadow.near, 0.01, 1e4, d.shadow ? d.shadow.near : 1),
          far: num(l.shadow && l.shadow.far, 1, 1e4, d.shadow ? d.shadow.far : 60),
        }
        if (l.type === 'directional') {
          const s = d.shadow
          out.shadow.left = num(l.shadow && l.shadow.left, -1e4, 0, s ? s.left : -30)
          out.shadow.right = num(l.shadow && l.shadow.right, 0, 1e4, s ? s.right : 30)
          out.shadow.top = num(l.shadow && l.shadow.top, 0, 1e4, s ? s.top : 30)
          out.shadow.bottom = num(l.shadow && l.shadow.bottom, -1e4, 0, s ? s.bottom : -30)
        }
      }
    }
    return out
  })
}

/** Normalize `scene.render.shadows` (global shadow-map type). */
export function normalizeShadowConfig(shadows) {
  if (!shadows || typeof shadows !== 'object' || Array.isArray(shadows)) return { type: 'PCFSoftShadowMap' }
  const type = shadows.type && SHADOW_TYPES.includes(shadows.type) ? shadows.type : 'PCFSoftShadowMap'
  return { type }
}

/** Resolve a THREE.ShadowMap type constant from a type string. */
export function shadowMapType(type) {
  const map = {
    PCFSoftShadowMap: THREE.PCFSoftShadowMap,
    PCFShadowMap: THREE.PCFShadowMap,
    VSMShadowMap: THREE.VSMShadowMap,
    BasicShadowMap: THREE.BasicShadowMap,
  }
  return map[type] !== undefined ? map[type] : THREE.PCFSoftShadowMap
}

/**
 * Build THREE lights from a normalized `lights` list.
 * @param {Array<object>} [config]  a normalized lights list (defaults when absent)
 * @returns {{ lights: Array<THREE.Light> }}
 */
export function buildLights(config) {
  const list = normalizeLights(config)
  const lights = list.map((l) => {
    let light
    const color = new THREE.Color(l.color)
    if (l.type === 'ambient') {
      light = new THREE.AmbientLight(color, l.intensity)
    } else if (l.type === 'hemisphere') {
      light = new THREE.HemisphereLight(color, new THREE.Color(l.groundColor), l.intensity)
    } else if (l.type === 'point') {
      light = new THREE.PointLight(color, l.intensity, l.distance, l.decay)
      if (Array.isArray(l.position)) light.position.set(l.position[0], l.position[1], l.position[2])
      light.castShadow = l.castShadow === true
    } else if (l.type === 'spot') {
      light = new THREE.SpotLight(color, l.intensity, l.distance, l.angle, l.penumbra, l.decay)
      if (Array.isArray(l.position)) light.position.set(l.position[0], l.position[1], l.position[2])
      light.castShadow = l.castShadow === true
      if (l.shadow && light.shadow) {
        light.shadow.mapSize.set(l.shadow.mapSize, l.shadow.mapSize)
        light.shadow.bias = l.shadow.bias
        light.shadow.camera.near = l.shadow.near
        light.shadow.camera.far = l.shadow.far
      }
      if (Array.isArray(l.target)) {
        light.target.position.set(l.target[0], l.target[1], l.target[2])
        light.target.updateMatrixWorld()
      }
    } else { // directional
      light = new THREE.DirectionalLight(color, l.intensity)
      if (Array.isArray(l.position)) light.position.set(l.position[0], l.position[1], l.position[2])
      // Directional lights point ALONG `direction` (position -> position + dir).
      // Without an authored direction they keep the three.js default of aiming
      // at the origin. The target must be in the scene for the direction to apply.
      if (Array.isArray(l.direction) && l.direction.length >= 3) {
        // target is added as a CHILD of the light, so its local position is the
        // direction vector itself; world target = light.position + direction.
        light.target.position.set(l.direction[0], l.direction[1], l.direction[2])
        light.target.updateMatrixWorld()
        light.add(light.target)
      }
      light.castShadow = l.castShadow === true
      if (l.shadow && light.shadow) {
        light.shadow.mapSize.set(l.shadow.mapSize, l.shadow.mapSize)
        light.shadow.bias = l.shadow.bias
        light.shadow.camera.near = l.shadow.near
        light.shadow.camera.far = l.shadow.far
        light.shadow.camera.left = l.shadow.left
        light.shadow.camera.right = l.shadow.right
        light.shadow.camera.top = l.shadow.top
        light.shadow.camera.bottom = l.shadow.bottom
        light.shadow.camera.updateProjectionMatrix()
      }
    }
    return light
  })
  return { lights }
}
