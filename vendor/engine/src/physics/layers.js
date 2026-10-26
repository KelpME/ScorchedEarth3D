/**
 * P4a T1: physics layers + masks — pure helpers.
 *
 * Authoring is NAME-based (`collider.layer` / `collider.mask` are strings /
 * string arrays; `scene.physics.layers = { names: [...] }` declares the
 * vocabulary). At step time names are resolved to a layer INDEX (0..31) and a
 * 32-bit MASK so the pair loop and raycast never touch Map iteration or
 * string comparisons on hot paths.
 *
 * Defaults (editor-server probe safety — a scene with NO layers block and
 * colliders with NO layer/mask fields behave exactly as before: everything
 * collides with everything on the implicit 'default' layer).
 */

export const MAX_LAYERS = 32

/** Bit i corresponds to names[i]. */
function nameBit(names, name) {
  for (let i = 0; i < names.length; i++) {
    if (names[i] === name) return 1 << i
  }
  return 0
}

/**
 * Validate/normalize the scene.physics.layers block.
 * @param {{ names?: string[] } | undefined} block
 * @returns {{ names: string[] }} defaults to { names: ['default'] } when absent.
 * @throws TypeError with a field-level message on invalid input.
 */
export function normalizeLayers(block) {
  if (block === undefined || block === null) return { names: ['default'] }
  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new TypeError('scene.physics.layers must be an object')
  }
  const names = block.names
  if (names === undefined || names === null) return { names: ['default'] }
  if (!Array.isArray(names)) {
    throw new TypeError('scene.physics.layers.names must be an array of layer-name strings')
  }
  if (names.length > MAX_LAYERS) {
    throw new TypeError(`scene.physics.layers.names must have at most ${MAX_LAYERS} entries (got ${names.length})`)
  }
  const seen = new Set()
  for (let i = 0; i < names.length; i++) {
    const n = names[i]
    if (typeof n !== 'string') {
      throw new TypeError(`scene.physics.layers.names[${i}] must be a string (got ${typeof n})`)
    }
    if (n === '') {
      throw new TypeError(`scene.physics.layers.names[${i}] must be a non-empty string`)
    }
    if (seen.has(n)) {
      throw new TypeError(`scene.physics.layers.names has a duplicate name: ${n}`)
    }
    seen.add(n)
  }
  const matrix = normalizeMatrix(names, block.matrix)
  return matrix === undefined ? { names: [...names] } : { names: [...names], matrix }
}

/**
 * P4b matrix helpers. scene.physics.layers.matrix = { default?, pairs? } —
 * cell rule(i,j) = pairs['min(i,j)|max(i,j)'] ?? default ?? 'collide',
 * values 'collide' | 'none'. Diagonal cells (player|player) are meaningful.
 * Absent matrix = all-collide (row mask -1) — BIT-IDENTICAL to no matrix.
 */

/** Order two names by their index in `names` (the matrix key convention). */
function orderedPair(names, x, y) {
  return names.indexOf(x) <= names.indexOf(y) ? [x, y] : [y, x]
}

/** 32-bit mask of which layers layerIndex may touch under the matrix alone. */
export function matrixRowMask(names, matrix, layerIndex) {
  if (matrix === undefined || matrix === null) return -1
  const def = matrix.default === undefined ? 'collide' : matrix.default
  const pairs = matrix.pairs
  let row = 0
  for (let i = 0; i < names.length; i++) {
    const [a, b] = orderedPair(names, names[layerIndex], names[i])
    const rule = pairs && Object.prototype.hasOwnProperty.call(pairs, `${a}|${b}`)
      ? pairs[`${a}|${b}`]
      : def
    if (rule === 'collide') row |= 1 << i
  }
  return row | 0
}

/** collider's full effective mask = authored mask AND matrix row. */
export function effectiveMask(names, matrix, colliderLayer, colliderMask) {
  const idx = resolveLayerIndex(names, colliderLayer)
  return maskFrom(names, colliderMask) & matrixRowMask(names, matrix, idx)
}

/** Validate + normalize matrix; returns { default, pairs } with SORTED keys. */
function normalizeMatrix(names, matrix) {
  if (matrix === undefined || matrix === null) return undefined
  if (typeof matrix !== 'object' || Array.isArray(matrix)) {
    throw new TypeError('scene.physics.layers.matrix must be an object')
  }
  if (matrix.default !== undefined && matrix.default !== 'collide' && matrix.default !== 'none') {
    throw new TypeError('scene.physics.layers.matrix.default must be "collide" or "none"')
  }
  let pairs
  if (matrix.pairs !== undefined && matrix.pairs !== null) {
    if (typeof matrix.pairs !== 'object' || Array.isArray(matrix.pairs)) {
      throw new TypeError('scene.physics.layers.matrix.pairs must be an object')
    }
    pairs = {}
    for (const key of Object.keys(matrix.pairs)) {
      const parts = typeof key === 'string' ? key.split('|') : []
      if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
        throw new TypeError(`scene.physics.layers.matrix.pairs key "${key}" must be "<nameA>|<nameB>" with two non-empty names`)
      }
      for (const p of parts) {
        if (!names.includes(p)) {
          throw new TypeError(`scene.physics.layers.matrix references unknown layer "${p}"`)
        }
      }
      const value = matrix.pairs[key]
      if (value !== 'collide' && value !== 'none') {
        throw new TypeError(`scene.physics.layers.matrix.pairs["${key}"] must be "collide" or "none"`)
      }
      const [a, b] = orderedPair(names, parts[0], parts[1])
      pairs[`${a}|${b}`] = value
    }
  }
  return { default: matrix.default === undefined ? 'collide' : matrix.default, pairs: pairs || {} }
}

/**
 * Resolve a collider's layer NAME to its index in the scene's layer list.
 * Absent / 'default' resolves to 0 (the implicit first layer).
 * @param {string[]} names
 * @param {string | undefined} colliderLayer
 */
export function resolveLayerIndex(names, colliderLayer) {
  if (colliderLayer === undefined || colliderLayer === null || colliderLayer === 'default') return 0
  for (let i = 0; i < names.length; i++) {
    if (names[i] === colliderLayer) return i
  }
  return 0 // unknown names resolve to the default layer (validateScene guards first)
}

/**
 * Build the 32-bit mask for a collider. Default (mask absent/null) = ALL bits
 * set — collide with everything. Unknown names contribute 0 (guarded by
 * validateScene).
 * @param {string[]} names the scene layer names
 * @param {string[] | undefined} maskArray the collider's authored mask
 */
export function maskFrom(names, maskArray) {
  if (maskArray === undefined || maskArray === null || !Array.isArray(maskArray) || maskArray.length === 0) {
    return -1 // all 32 bits
  }
  let m = 0
  for (let i = 0; i < maskArray.length; i++) m |= nameBit(names, maskArray[i])
  return m | 0
}

/**
 * Pure pair predicate: two bodies { layerIndex, mask } touch each other only
 * if A's mask includes B's layer AND B's mask includes A's layer.
 * @param {{ layerIndex: number, mask: number }} a
 * @param {{ layerIndex: number, mask: number }} b
 */
export function layerFilter(a, b) {
  return ((a.mask >> b.layerIndex) & 1) === 1 && ((b.mask >> a.layerIndex) & 1) === 1
}
