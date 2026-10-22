/**
 * KINDS REGISTRY — the single source of the asset kind→formats vocabulary
 * (MIG-1 amendment 4: foundational, not a patch). One exported map; every
 * consumer derives from it instead of hand-rolling its own extension list:
 *
 *   - `validateManifest` / `AssetLoader` (asset-loader.js): knownTypes =
 *     the union of all format lists; knownKinds = the map's keys (+ the
 *     `sfx` fallback pseudo-kind).
 *   - `manifestEntries()` (import-backend.js): entry `kind` = the inverse
 *     lookup `kindForFormat(format)`.
 *   - editor save routes (serve.js): logical-id prefixes and canonical
 *     manifest entries derive from the same map.
 *   - the migration script (tools/migration/mig-generator-shape.mjs):
 *     legacy `type` → `kind` inversion derives from it.
 *
 * Audio is a FIRST-CLASS kind (wav/mp3/ogg/flac). Adding a future kind is a
 * ONE-LINE addition here — validation, the generator, the editor routes and
 * the migration script all inherit it with no further edits.
 */
// NOTE: the outer object is intentionally NOT frozen — the extensibility
// contract (one-line kind additions, inherited everywhere) is exercised at
// runtime by tests; the format arrays are frozen.
export const KIND_FORMATS = {
  model: Object.freeze(['glb', 'gltf', 'fbx']),
  texture: Object.freeze(['png', 'jpg', 'jpeg', 'tga', 'exr']),
  audio: Object.freeze(['wav', 'mp3', 'ogg', 'flac']),
}

/** The registry keys — the closed vocabulary of manifest `kind` values. */
export function knownKinds() {
  return Object.keys(KIND_FORMATS)
}

/** Every format the registry knows, as a Set (the old `knownTypes` set). */
export function knownFormats() {
  const out = new Set()
  for (const formats of Object.values(KIND_FORMATS)) {
    for (const f of formats) out.add(f)
  }
  return out
}

/**
 * Inverse lookup: a file format/extension → its coarse kind.
 * Falls back to 'sfx' (sound-effect catch-all) for anything the registry
 * does not list — the historical fallback of the editor's id prefixing.
 * Read dynamically over KIND_FORMATS so a one-line registry addition is
 * inherited immediately (MIG-1 amendment 4 extensibility contract).
 */
export function kindForFormat(format) {
  const f = String(format || '').toLowerCase()
  for (const [kind, formats] of Object.entries(KIND_FORMATS)) {
    if (formats.includes(f)) return kind
  }
  return 'sfx'
}
