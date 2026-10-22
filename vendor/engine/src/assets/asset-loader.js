/**
 * Manifest-backed asset loading (FOUNDATION-PLAN.md §6).
 *
 * Assets are referenced by logical manifest ids, never guessed file paths.
 * A per-game manifest.json maps logical ids to the CANONICAL generator shape
 * { kind, format, src } (MIG complete — the legacy { type, src } shape is no
 * longer accepted; migrate with tools/migration/mig-generator-shape.mjs). The loader
 * resolves, caches, and returns decoded assets. Missing ids fail with an
 * actionable error (the id and the list of known ids), never a silent miss.
 *
 * The loader is written against an injectable `fetch` so it runs in the
 * browser (real fetch + Three loaders) and in Node (a mock fetch).
 */

import { knownKinds, knownFormats } from './kinds.js'

export class ManifestError extends Error {
  constructor(message, { id, knownIds } = {}) {
    super(message)
    this.name = 'ManifestError'
    this.id = id
    this.knownIds = knownIds
  }
}

/**
 * A manifest entry's asset type: `format` (the file extension string) from the
 * canonical generator shape. Same string used for decoder routing and
 * `load(id, expectedType)` checks.
 */
export function entryType(entry) {
  return entry.format
}

/**
 * Validate a manifest object. Returns the manifest or throws a ManifestError
 * describing exactly what is wrong.
 *
 * ONLY the canonical generator shape is accepted (MIG complete — the MIG-3
 * dual-shape acceptance is deleted):
 *  `{ kind: 'model'|'texture', format: 'glb', src }` — `format` is the
 *  extension string. Legacy `{ type, src }` manifests FAIL validation with a
 *  pointer to the migration tool.
 *
 * @param {object} manifest  parsed JSON
 * @param {string} [sourceLabel]  e.g. "games/poly-runner/assets/manifest.json"
 * @returns {object} the manifest (with an assets map)
 */
export function validateManifest(manifest, sourceLabel = 'manifest') {
  if (!manifest || typeof manifest !== 'object') {
    throw new ManifestError(`${sourceLabel}: not an object`)
  }
  if (!manifest.assets || typeof manifest.assets !== 'object' || Array.isArray(manifest.assets)) {
    throw new ManifestError(`${sourceLabel}: missing "assets" object`)
  }
  // KINDS REGISTRY (kinds.js) is the single source of the format/kind
  // vocabulary. Derived per call so a one-line registry addition inherits
  // immediately.
  const KNOWN_TYPES = knownFormats()
  const KNOWN_KINDS = new Set([...knownKinds(), 'sfx'])
  for (const [id, entry] of Object.entries(manifest.assets)) {
    if (!entry || typeof entry !== 'object') {
      throw new ManifestError(`${sourceLabel}: asset "${id}" must be an object`)
    }
    if (typeof entry.src !== 'string' || entry.src === '') {
      throw new ManifestError(`${sourceLabel}: asset "${id}" missing non-empty "src"`)
    }
    const type = entryType(entry)
    if (typeof type !== 'string' || type === '') {
      throw new ManifestError(`${sourceLabel}: asset "${id}" missing "format" (canonical generator shape {kind, format, src} required; legacy {type, src} manifests must be migrated via tools/migration/mig-generator-shape.mjs)`)
    }
    if (!KNOWN_TYPES.has(type)) {
      throw new ManifestError(`${sourceLabel}: asset "${id}" has unknown type "${type}" (expected glb|gltf|fbx|png|jpg|jpeg|tga|exr|wav|mp3|ogg|flac)`)
    }
    if (entry.kind !== undefined && !KNOWN_KINDS.has(entry.kind)) {
      throw new ManifestError(`${sourceLabel}: asset "${id}" has unknown kind "${entry.kind}" (expected ${[...KNOWN_KINDS].join('|')})`)
    }
  }
  return manifest
}

/**
 * Loader that resolves manifest ids, decodes assets, and caches the results.
 *
 * @param {object} opts
 * @param {object} opts.manifest   the (already validated) manifest object
 * @param {Function} [opts.fetch]  async (src) => Response; defaults to global fetch
 * @param {object} [opts.decoders]  { glb: (resp,src)=>T, texture: ..., audio: ... }
 *   Each decoder receives the Response and the src path and returns a decoded
 *   asset. If omitted, the loader returns the raw Response and caches it.
 */
export class AssetLoader {
  constructor({ manifest, fetch: fetchFn, decoders = {} }) {
    this.manifest = validateManifest(manifest)
    // Explicit null disables fetch; only fall back to global when omitted (undefined).
    this._fetch = fetchFn === undefined
      ? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
      : fetchFn
    this._decoders = decoders
    this._cache = new Map() // logicalId -> Promise<decoded>
    this._bySrc = new Map() // src -> logicalId (dedupe)
  }

  /** The list of known logical ids (for actionable errors). */
  knownIds() {
    return Object.keys(this.manifest.assets)
  }

  /** The manifest entry for a logical id, or undefined. */
  entry(id) {
    return this.manifest.assets[id]
  }

  /**
   * Load (and cache) an asset by logical id.
   * @param {string} id  logical manifest id
   * @param {string} [type]  optional expected type override
   * @returns {Promise<any>} decoded asset (cached; repeated calls share the promise)
   */
  async load(id, type) {
    const entry = this.manifest.assets[id]
    if (!entry) {
      throw new ManifestError(
        `asset not found: "${id}" (known ids: ${this.knownIds().join(', ') || 'none'})`,
        { id, knownIds: this.knownIds() }
      )
    }
    if (type !== undefined && entryType(entry) !== type) {
      throw new ManifestError(`asset "${id}" is type "${entryType(entry)}", not "${type}"`, { id, knownIds: this.knownIds() })
    }
    if (this._cache.has(id)) return this._cache.get(id)

    const promise = this._loadEntry(entry, id)
    this._cache.set(id, promise)
    try {
      await promise
    } catch (err) {
      // Don't cache failures; allow a retry next call.
      this._cache.delete(id)
      throw err
    }
    return this._cache.get(id)
  }

  async _loadEntry(entry, id) {
    if (!this._fetch) throw new Error('AssetLoader has no fetch; provide one in the constructor')
    // Dedupe by src: if another id already loaded this file, reuse it.
    const existing = this._bySrc.get(entry.src)
    if (existing) return this._cache.get(existing)

    const resp = await this._fetch(entry.src)
    if (!resp.ok) {
      throw new ManifestError(`failed to fetch "${entry.src}" for asset "${id}" (HTTP ${resp.status})`, { id, knownIds: this.knownIds() })
    }
    // Decoder routing runs off `format` (canonical generator shape).
    const decoder = this._decoders[entryType(entry)]
    const decoded = decoder ? await decoder(resp, entry.src) : resp
    this._bySrc.set(entry.src, id)
    return decoded
  }

  /** Whether a logical id is already loaded/cached. */
  isLoaded(id) {
    return this._cache.has(id)
  }

  /** Drop a cached asset (forces a reload on next load). */
  invalidate(id) {
    const entry = this.manifest.assets[id]
    if (entry) this._bySrc.delete(entry.src)
    return this._cache.delete(id)
  }

  /** Clear the entire cache. */
  clear() {
    this._cache.clear()
    this._bySrc.clear()
  }
}
