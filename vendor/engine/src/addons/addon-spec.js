/**
 * Addon contract (Addon-1): the `addon.json` manifest schema + a pure
 * validation gate + the global addon-library resolver.
 *
 * An addon is one self-contained distributable unit extending HermesForge —
 * a code addon (editor panel, behavior/system, component, post-FX, shader) or
 * an asset addon (models/clips/audio/textures/materials) — packaged as a
 * folder (zip/tarball for distribution) with a REQUIRED `addon.json` manifest.
 * The full contract lives in `.hermes/plans/2026-08-29_addon-contract.md`.
 *
 * Manifest shape:
 *   {
 *     id: 'forge-terrain',           // unique, kebab-case
 *     name: 'Terrain',
 *     version: '1.0.0',              // semver
 *     kind: 'code',                  // 'code' | 'asset' | 'both'
 *     description: '...',            // optional
 *     author: '...',                 // optional
 *     license: 'MIT',                // optional
 *     engine: { min: '0.1.4' },      // optional engine-version compat
 *     entries: { ... }               // what the addon contributes (below)
 *   }
 *
 * The `entries` vocabulary (known kinds — unknown kinds are IGNORED for
 * forward compatibility, a declared-but-malformed known kind is a hard error):
 *   editorPanels: [{ id, launch }]        — panels launched from the Tools popup
 *   behaviors:    [{ id, src }]           — per-entity gameplay scripts
 *   systems:      [{ id, src }]           — global systems
 *   components:   [{ id, src }]           — schema-driven components
 *   postFX:       [{ id, src }]           — custom post-FX passes
 *   shaders:      [{ id, src }]           — custom GLSL shaders
 *   assets:       { <assetId>: <src> }    — models/clips/audio/… registered
 *                                           into a game's manifest; every
 *                                           entry MUST have a src path
 *
 * This module is pure: no filesystem, no editor wiring. The loader
 * (Addon-2) and install route build on it.
 */

/** Kept in one place so the loader and docs cite the same vocabulary. */
export const KNOWN_ENTRY_KINDS = ['editorPanels', 'behaviors', 'systems', 'components', 'postFX', 'shaders', 'assets']

/** The addon kinds (the manifest's `kind` field). */
export const ADDON_KINDS = ['code', 'asset', 'both']

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// Pragmatic semver: major[.minor[.patch]][-pre][+build] — sufficient for a
// compat field; we never do dependency resolution (versions are pinned).
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** A code-like entry record: { id, src } (or `launch` for editor panels). */
function checkEntryRecord(entries, kind, i, entry, srcKey, hard) {
  const path = `entries.${kind}[${i}]`
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    hard.push({ code: 'addon.entry-record', path, message: `${path} must be an object` })
    return
  }
  if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    hard.push({ code: 'addon.entry-id', path, message: `${path}.id must be a non-empty string` })
  }
  if (typeof entry[srcKey] !== 'string' || entry[srcKey].trim() === '') {
    hard.push({ code: 'addon.entry-src', path, message: `${path}.${srcKey} must be a non-empty string (path inside the addon package)` })
  }
}

/**
 * Validate an `addon.json` manifest. Pure — mirrors the validateScene /
 * validateAnimator gate style. @param manifest the parsed addon.json object
 * @returns {{ ok: boolean, hard: Array<{code,path,message}> }} ok is true
 *   iff there are no hard errors. `hard` lists structured errors (empty when
 *   valid). Unknown entry kinds are ignored (forward-compatible).
 */
export function validateAddon(manifest) {
  const hard = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, hard: [{ code: 'addon.manifest', path: '', message: 'addon.json must be a non-array object' }] }
  }
  if (typeof manifest.id !== 'string' || manifest.id.trim() === '') {
    hard.push({ code: 'addon.id', path: 'id', message: 'addon.id must be a non-empty string' })
  } else if (!KEBAB.test(manifest.id)) {
    hard.push({ code: 'addon.id', path: 'id', message: `addon.id must be kebab-case (lowercase letters/digits, hyphen-separated), got: ${manifest.id}` })
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    hard.push({ code: 'addon.name', path: 'name', message: 'addon.name must be a non-empty string' })
  }
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    hard.push({ code: 'addon.version', path: 'version', message: `addon.version must be semver (major.minor.patch), got: ${JSON.stringify(manifest.version)}` })
  }
  if (!ADDON_KINDS.includes(manifest.kind)) {
    hard.push({ code: 'addon.kind', path: 'kind', message: `addon.kind must be one of ${ADDON_KINDS.join(' | ')}, got: ${JSON.stringify(manifest.kind)}` })
  }
  if (manifest.engine !== undefined) {
    if (!manifest.engine || typeof manifest.engine !== 'object' || Array.isArray(manifest.engine)
      || typeof manifest.engine.min !== 'string' || !SEMVER.test(manifest.engine.min)) {
      hard.push({ code: 'addon.engine', path: 'engine', message: 'addon.engine must be { min: "<semver>" }' })
    }
  }
  if (manifest.entries === undefined || manifest.entries === null) {
    // entries is the contract's heart but an addon that ships only metadata is
    // technically valid; the loader just registers nothing.
  } else if (!manifest.entries || typeof manifest.entries !== 'object' || Array.isArray(manifest.entries)) {
    hard.push({ code: 'addon.entries', path: 'entries', message: 'addon.entries must be an object keyed by entry kind' })
  } else {
    const entries = manifest.entries
    // Known kinds: a DECLARED key must be well-formed (malformed = hard error).
    // Unknown keys: ignored (forward-compatible vocabulary growth).
    for (const kind of Object.keys(entries)) {
      if (!KNOWN_ENTRY_KINDS.includes(kind)) continue
      const value = entries[kind]
      if (kind === 'assets') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          hard.push({ code: 'addon.entry-kind', path: `entries.${kind}`, message: `entries.${kind} must be an object mapping asset id -> src path` })
          continue
        }
        for (const assetId of Object.keys(value)) {
          if (typeof value[assetId] !== 'string' || value[assetId].trim() === '') {
            hard.push({ code: 'addon.asset-src', path: `entries.${kind}.${assetId}`, message: `entries.${kind}.${assetId} must be a non-empty src path inside the addon package` })
          }
        }
        continue
      }
      if (!Array.isArray(value)) {
        hard.push({ code: 'addon.entry-kind', path: `entries.${kind}`, message: `entries.${kind} must be an array` })
        continue
      }
      const srcKey = kind === 'editorPanels' ? 'launch' : 'src'
      for (let i = 0; i < value.length; i++) checkEntryRecord(entries, kind, i, value[i], srcKey, hard)
    }
  }
  return { ok: hard.length === 0, hard }
}

/**
 * Resolve the global addon-library path from the editor server config — the
 * read-only source folder addons live in before a game copies them in
 * (mirroring the Assets folder). Pure: given a config object (the shape
 * `getServerConfig()` returns), returns its `addonsDir`. The DEFAULT and the
 * env override (`HF_ADDONS_DIR`) live in the editor's
 * `editor/test/games-config.js` — the SAME mechanism that resolves the games
 * and assets folders — so this module never hardcodes a location.
 * @param {{ addonsDir?: string }} config
 * @returns {string} the library path, or '' when the config carries none
 */
export function resolveAddonLibrary(config) {
  const dir = config && typeof config.addonsDir === 'string' ? config.addonsDir.trim() : ''
  return dir || ''
}
