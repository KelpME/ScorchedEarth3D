// Seeded 3D terrain generator: value-noise fBm hills + rare sharp ridges,
// material bands measured DOWN from each column's final top. Everything is
// derived from the seed via integer hashes — NO Math.random anywhere; same
// seed => byte-identical cells array.

import { W, H, PLAYABLE_H, FLOOR_CELLS, Z, V, X_MIN, Z_MIN, MATERIALS } from './constants.js';
import { makeField } from './field.js';

// Identical algorithm to the retired 2.5D src/voxel/generator.js (the proven rig).
export function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Deterministic 32-bit integer hash (xorshift-multiply finalizer).
export function hashInt(n) {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return h >>> 0;
}

// Hash of a lattice point -> [0,1). Seed is mixed in multiplicatively.
function lattice(seed, x, z) {
  const h = hashInt(
    (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 2654435761)) | 0,
  );
  return h / 2 ** 32;
}

const smooth = (t) => t * t * (3 - 2 * t);

// Seeded 2D value noise on the integer lattice, bilinear-interpolated with
// smoothstep easing. Coordinates in lattice units.
export function noise2(seed, x, z) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const tx = smooth(x - x0), tz = smooth(z - z0);
  const a = lattice(seed, x0, z0);
  const b = lattice(seed, x0 + 1, z0);
  const c = lattice(seed, x0, z0 + 1);
  const d = lattice(seed, x0 + 1, z0 + 1);
  const ab = a + (b - a) * tx;
  const cd = c + (d - c) * tx;
  return ab + (cd - ab) * tz;
}

// Fractal Brownian motion: sum of noise2 octaves, each at freq*lacunarity^i
// scaled by persistence^i, normalized by the total weight -> [0,1).
// T-G1: base freq 1/102.4 (was 1/64). Arithmetic: the cage grew 4x in WORLD
// units (40u -> 160u across x) while V grew 2.5x (0.1 -> 0.25), so the cage
// in CELLS grew 640/400 = 1.6x. To keep hill features the same FRACTION of
// the cage (6.25 base-octave periods across, as before), divide the per-cell
// frequency by 1.6: (1/64)/1.6 = 1/102.4 (exact binary).
export function fbm(seed, x, z, {
  octaves = 5, freq = 1 / 102.4, persistence = 0.5, lacunarity = 2,
} = {}) {
  let sum = 0, weight = 0, f = freq, a = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(seed, x * f, z * f) * a;
    weight += a;
    a *= persistence;
    f *= lacunarity;
  }
  return sum / weight;
}

// W1-C (plan SE-COMPLETE-1012): landscape knobs — bumpiness / slope /
// flattenPeaks / mountainPercent. W5 ARCHITECTURE FLIP (user 2026-10-13):
// the knobs are REAL again, sourced from the voxelTerrain scene component via
// generate(seed, { landscape: {...} }) — the generator reads params.landscape
// ONLY, never settings. Defaults are DATA-DECLARED (data/voxel-terrain.json
// .landscape) and reproduce the historical surface BYTE-IDENTICALLY:
// slope scale = 20/20 = 1 (exact float identity), the bumpiness scale is
// bumpiness/20 = 1, flattenPeaks off skips the cap, and the mountainPercent
// threshold shift (20-pct)/20 = 0 is exact +0.
// Knob -> physics mapping (declared in data/voxel-terrain.json .landscapeNotes):
//   bumpiness        scales the rolling fBm hill amplitude (rollingAmp * bumpiness/20)
//   slope            scales the mountain-ridge amplitude (ridgeAmp * slope/20)
//   flattenPeaks     caps ridge amplitude at half its full height when on
//   mountainPercent  shifts the ridge-presence threshold ((20 - pct)/20 added
//                    to the ridge fbm; 20 = identity, 0 = none, 100 = everywhere)
export const LANDSCAPE_DEFAULTS = Object.freeze({ bumpiness: 20, slope: 20, flattenPeaks: false, mountainPercent: 20 });

// Surface height (cells) for column (x,z): base + rolling hills + rare sharp
// mountain ridges (pow() of a centered fBm — mostly 0, spikes where the
// noise is high). Clamped to [8, H-10]: never touches the field top.
// FPS-1012d (USER DECISION): RESTORED to the pre-W1-C body, verbatim — the
// landscape-params rewrite (bumpiness/slope/flattenPeaks + the preset path
// and my frequency patches) regressed the look the user had. The manual's
// bumpiness/slope/flattenPeaks rows are storage-only (named reason in the
// settings audit) until a spec-gated visual rewrite earns them back.

// 2026-10-13 (user: stop hiding tunables in code): the terrain SHAPE knobs —
// historically JS literals below — are DATA (data/voxel-terrain.json .shape),
// overridable per scene via generate(seed, {shape:{...}}) from the
// voxel_terrain scene object. Defaults = the historical values (regression
// pin: byte-identical output). Junk override values fail LOUD naming the key.
import terrainData from '../../data/voxel-terrain.json' with { type: 'json' };
const SHAPE_DEFAULTS = (() => {
  const s = terrainData ? terrainData.shape : undefined;
  const keys = ['baseHeight', 'rollingAmp', 'ridgeAmp', 'ridgePower', 'heightMin', 'grassMax', 'dirtBand', 'darkBand'];
  if (!s || typeof s !== 'object') {
    throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .shape missing — expected keys ${keys.join(', ')}, no JS fallback exists`);
  }
  for (const k of keys) {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) {
      throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .shape.${k} must be a finite number: ${JSON.stringify(s[k])}`);
    }
  }
  return s;
})();

/** Merge per-scene shape overrides over the data defaults (junk fails loud). */
function shapeFor(params) {
  const o = params && typeof params === 'object' ? params.shape : undefined;
  if (o === undefined) return SHAPE_DEFAULTS;
  if (typeof o !== 'object' || Array.isArray(o)) {
    throw new TypeError(`[se/voxel3d] generate params.shape must be an object of numbers: ${JSON.stringify(o)}`);
  }
  const out = { ...SHAPE_DEFAULTS };
  for (const [k, v] of Object.entries(o)) {
    if (!(k in out)) throw new TypeError(`[se/voxel3d] params.shape.${k} is not a known shape key (expected: ${Object.keys(out).join(', ')})`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`[se/voxel3d] params.shape.${k} must be a finite number: ${JSON.stringify(v)}`);
    out[k] = v;
  }
  return out;
}

/** Merge per-scene landscape overrides over the DATA defaults (junk fails loud). */
function landscapeFor(params) {
  const o = params && typeof params === 'object' ? params.landscape : undefined;
  if (o === undefined) return LANDSCAPE_DEFAULTS;
  if (typeof o !== 'object' || Array.isArray(o)) {
    throw new TypeError(`[se/voxel3d] generate params.landscape must be an object of knob values: ${JSON.stringify(o)}`);
  }
  const out = { ...LANDSCAPE_DEFAULTS };
  for (const [k, v] of Object.entries(o)) {
    if (!(k in out)) throw new TypeError(`[se/voxel3d] params.landscape.${k} is not a known landscape key (expected: ${Object.keys(out).join(', ')})`);
    if (k === 'flattenPeaks') {
      if (typeof v !== 'boolean') throw new TypeError(`[se/voxel3d] params.landscape.flattenPeaks must be a boolean (on/off stored typed): ${JSON.stringify(v)}`);
    } else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
      throw new TypeError(`[se/voxel3d] params.landscape.${k} must be a finite number in 0..100: ${JSON.stringify(v)}`);
    }
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// TERRAIN TYPES (task 'landscape variety'): named landscape presets = optional
// .shape overrides over the data defaults + optional .rockScatter (seeded
// random rock blobs embedded in the soil). DATA-DECLARED in
// data/voxel-terrain.json .terrainTypes (default .terrainTypesDefault); the
// generator never invents a type. Junk data or junk params.terrainType fails
// LOUD naming the key/name. Default 'classic' declares nothing -> byte-
// identical output to the pre-feature generator (regression pin).
const TERRAIN_TYPES = (() => {
  const t = terrainData ? terrainData.terrainTypes : undefined;
  const dName = terrainData ? terrainData.terrainTypesDefault : undefined;
  if (!t || typeof t !== 'object' || Array.isArray(t) || !Object.keys(t).length) {
    throw new TypeError('[se/voxel3d] data/voxel-terrain.json .terrainTypes missing/empty — no JS fallback exists (fail-loud doctrine)');
  }
  if (typeof dName !== 'string' || !(dName in t)) {
    throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .terrainTypesDefault ${JSON.stringify(dName)} is not a key of .terrainTypes`);
  }
  const shapeKeys = Object.keys(SHAPE_DEFAULTS);
  const out = {};
  for (const [name, def] of Object.entries(t)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .terrainTypes.${name} must be an object: ${JSON.stringify(def)}`);
    }
    for (const k of Object.keys(def)) {
      if (k !== 'shape' && k !== 'rockScatter' && !k.startsWith('_')) {
        throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .terrainTypes.${name}.${k} is not a known key (expected: shape, rockScatter, _notes)`);
      }
    }
    if (def.shape !== undefined) {
      if (!def.shape || typeof def.shape !== 'object' || Array.isArray(def.shape)) {
        throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .terrainTypes.${name}.shape must be an object of shape overrides`);
      }
      for (const [k, v] of Object.entries(def.shape)) {
        if (!shapeKeys.includes(k)) throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .terrainTypes.${name}.shape.${k} is not a known shape key (expected: ${shapeKeys.join(', ')})`);
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .terrainTypes.${name}.shape.${k} must be a finite number: ${JSON.stringify(v)}`);
      }
    }
    if (def.rockScatter !== undefined) {
      const rs = def.rockScatter;
      const need = (cond, msg) => { if (!cond) throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .terrainTypes.${name}.rockScatter: ${msg} — ${JSON.stringify(rs)}`); };
      need(rs && typeof rs === 'object' && !Array.isArray(rs), 'must be an object');
      need(Number.isInteger(rs.count) && rs.count >= 0, 'count must be an integer >= 0 (boulder sites per 100k columns)');
      need(Number.isInteger(rs.minDepth) && rs.minDepth >= 1, 'minDepth must be an integer >= 1 (cells below the column top)');
      need(Number.isInteger(rs.maxDepth) && rs.maxDepth >= rs.minDepth, 'maxDepth must be an integer >= minDepth');
      need(typeof rs.sizeMin === 'number' && rs.sizeMin > 0, 'sizeMin must be a number > 0 (cells)');
      need(typeof rs.sizeMax === 'number' && rs.sizeMax >= rs.sizeMin, 'sizeMax must be a number >= sizeMin (cells)');
      need(typeof rs.noiseAmp === 'number' && rs.noiseAmp >= 0 && rs.noiseAmp < 1, 'noiseAmp must be a number in [0,1) (FBM silhouette perturbation fraction)');
      need(typeof rs.noiseFreq === 'number' && rs.noiseFreq > 0, 'noiseFreq must be a number > 0 (angular noise lattice units)');
      need(typeof rs.clusterChance === 'number' && rs.clusterChance >= 0 && rs.clusterChance <= 1, 'clusterChance must be a number in [0,1]');
      need(Number.isInteger(rs.pebbleDensity) && rs.pebbleDensity >= 0, 'pebbleDensity must be an integer >= 0 (nuggets per 100k columns)');
    }
    out[name] = def;
  }
  return out;
})();

// P3 SETTLE-PACE-1015: Rock Amount (0-100, the settings row) — the generator
// consumes it via params.rockAmount (main.js passes terrainCfg.rockAmount at
// every generate site; the generator never reads settings directly).
// Undefined reads as the DATA default 100 (identity). Junk fails LOUD.
function rockAmountFor(params) {
  const a = params && typeof params === 'object' ? params.rockAmount : undefined;
  if (a === undefined) return 100;
  if (typeof a !== 'number' || !Number.isFinite(a) || a < 0 || a > 100) {
    throw new TypeError(`[se/voxel3d] params.rockAmount must be a finite number in 0..100: ${JSON.stringify(a)}`);
  }
  return a;
}

/** Resolve params.terrainType to its data definition (junk fails loud). */
function terrainTypeFor(params) {
  const name = params && typeof params === 'object' ? params.terrainType : undefined;
  if (name === undefined) return { name: terrainData.terrainTypesDefault, def: TERRAIN_TYPES[terrainData.terrainTypesDefault] };
  if (typeof name !== 'string') throw new TypeError(`[se/voxel3d] params.terrainType must be a string (a key of data/voxel-terrain.json .terrainTypes): ${JSON.stringify(name)}`);
  const def = TERRAIN_TYPES[name];
  if (!def) throw new RangeError(`[se/voxel3d] params.terrainType ${JSON.stringify(name)} is not a known terrain type (expected one of: ${Object.keys(TERRAIN_TYPES).join(', ')})`);
  return { name, def };
}

/** Public list of the data-declared type names (settings/UI consumers). */
export function terrainTypeNames() {
  return Object.keys(TERRAIN_TYPES);
}

// ---------------------------------------------------------------------------
// P3 SETTLE-PACE-1015: ROCK DEPTH BANDING — rock cells pick rock vs rockDark
// by DEPTH band, so crater cross-sections read stone-in-dirt, not tinted dirt.
// DATA-DECLARED in data/voxel-terrain.json .rockBanding { bandDepth, darkRows }:
// a rock cell is rockDark iff its DEPTH BELOW THE COLUMN TOP (fromTop, 0 = the
// topmost cell) satisfies (fromTop % bandDepth) < darkRows — the SAME
// measure-down-from-the-top law as the grass/dirt/dark bands (DEEPEN-1015 R2,
// user 2026-10-15: the old absolute-y rule drew flat world-height strata lines
// through the cutaway; bands now follow the terrain surface per column).
// R2b (user 2026-10-15: "i dont want the bands to be a uniform depth —
// randomized everywhere"): the band phase is WOBBLED by seeded 2D value noise
// (data .rockBanding.wobble, cells) so strata thickness/edges are irregular
// everywhere — no uniform 4-cell cadence, no flat lines, deterministic per
// seed. The law is EXPORTED (rockBandDark) so the scatter and its unit pins
// share one definition.
// Deterministic, no RNG; both materials share hardness 1.0. Junk data fails
// LOUD naming the key.
const ROCK_BANDING = (() => {
  const b = terrainData ? terrainData.rockBanding : undefined;
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new TypeError('[se/voxel3d] data/voxel-terrain.json .rockBanding missing — expected { bandDepth, darkRows, wobble }, no JS fallback exists');
  }
  if (!Number.isInteger(b.bandDepth) || b.bandDepth < 1 || !Number.isInteger(b.darkRows) || b.darkRows < 1 || b.darkRows > b.bandDepth || !Number.isInteger(b.wobble) || b.wobble < 0) {
    throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .rockBanding must be integers with 1 <= darkRows <= bandDepth and wobble >= 0: ${JSON.stringify(b)}`);
  }
  return b;
})();

// DEEPEN-1015 R4 (user: dirt/dark strata thickness is uniform — randomize
// per-column with seeded noise): data .strataWobble { dirt, dark, freq } —
// the effective band thickness per column is sh.dirtBand / sh.darkBand plus a
// seeded per-column noise offset (round((noise2(seed ^ salt, x*freq, z*freq)
// *2-1) * wobble), clamped >= 1). Separate salt per band; deterministic per
// seed; wobble 0 = byte-identical legacy fill. Junk data fails LOUD.
const STRATA_WOBBLE = (() => {
  const w = terrainData ? terrainData.strataWobble : undefined;
  if (!w || typeof w !== 'object' || Array.isArray(w)) {
    throw new TypeError('[se/voxel3d] data/voxel-terrain.json .strataWobble missing — expected { dirt, dark, freq }, no JS fallback exists');
  }
  for (const k of ['dirt', 'dark']) {
    if (!Number.isInteger(w[k]) || w[k] < 0) {
      throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .strataWobble.${k} must be an integer >= 0 (cells): ${JSON.stringify(w[k])}`);
    }
  }
  if (typeof w.freq !== 'number' || !Number.isFinite(w.freq) || w.freq <= 0) {
    throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .strataWobble.freq must be a number > 0 (noise lattice frequency): ${JSON.stringify(w.freq)}`);
  }
  return w;
})();
const STRATA_SALT_DIRT = 0x51d1 | 0;
const STRATA_SALT_DARK = 0xda2a | 0;

// PURE rock-strata law, shared by scatterRocks + unit pins. `dark` iff the
// noise-wobbled depth below the column top lands in the dark band. bandDepth/
// darkRows/wobble are data (.rockBanding); seed is the field seed — the same
// wobble field every regen of that seed (deterministic), different across
// seeds. Wobble scales a [-1,1] value-noise field sampled on world cell x/z
// (plus a y term so the wobble drifts with depth too — strata wander, never
// straight lines).
const BAND_WOBBLE_SEED = 0xb4bd1 | 0;
export function rockBandDark(fromTop, x, y, z, banding, seed) {
  const w = banding.wobble;
  const wob = w === 0 ? 0 : (noise2(seed ^ BAND_WOBBLE_SEED, x * 0.11, z * 0.11 + y * 0.31) * 2 - 1) * w;
  const d = fromTop + Math.round(wob);
  return ((d % banding.bandDepth) + banding.bandDepth) % banding.bandDepth < banding.darkRows;
}

// Effective shape = data defaults <- type's .shape overrides <- scene shape.
function shapeForType(params, typeDef) {
  const typeShape = typeDef && typeDef.shape ? typeDef.shape : undefined;
  if (!typeShape) return shapeFor(params);
  const scene = params && typeof params === 'object' ? params.shape : undefined;
  if (scene === undefined) return { ...SHAPE_DEFAULTS, ...typeShape };
  if (typeof scene !== 'object' || Array.isArray(scene)) {
    throw new TypeError(`[se/voxel3d] generate params.shape must be an object of numbers: ${JSON.stringify(scene)}`);
  }
  const out = { ...SHAPE_DEFAULTS, ...typeShape };
  for (const [k, v] of Object.entries(scene)) {
    if (!(k in out)) throw new TypeError(`[se/voxel3d] params.shape.${k} is not a known shape key (expected: ${Object.keys(out).join(', ')})`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`[se/voxel3d] params.shape.${k} must be a finite number: ${JSON.stringify(v)}`);
    out[k] = v;
  }
  return out;
}

// P3 SETTLE-PACE-1015 ROCK REDESIGN (user: the old ellipsoid blobs read as
// "a giant square") — deterministic noise-shaped boulders + embedded pebbles.
// PURE MATERIAL CONVERSION of grass/dirt/dark cells — the field's solid/empty
// geometry is untouched (surface, blasts' shape targets, settle behavior all
// unchanged; rock/rockDark only differ via the EXISTING per-material hardness
// in blast.js). The surface cell of each column is never converted
// (soil-embedded; outcrops appear naturally on slopes where a neighboring
// column's top is lower). Separate LCG (seeded via hashInt of seed ^ type-name
// salt) so the surface RNG stream is undisturbed; count 0 + pebbleDensity 0
// skip the loops entirely (default byte-identity). No Math.random anywhere.
//
// BOULDERS: each site's occupancy is a radial mask with FBM value-noise
// perturbation r(θ, y) = baseR * (1 + amp * (fbmSite(θ, y, siteSeed) * 2 - 1)),
// vertically squashed to 0.75*baseR — irregular lumpy silhouettes, never
// primitives. Clusters: clusterChance rolls 1-3 smaller satellite blobs
// offset near the parent. rockAmount (0-100, the Rock Amount settings row)
// scales the site count; 0 = none.
//
// PEBBLES: second pass — sparse single/2-cell rock nuggets through the dirt
// VOLUME (below the surface, above y=1), density data (pebbleDensity per
// type, scaled by the Rock Amount row). Blasts carving dirt expose them.
//
// BANDING: rock cells pick rock vs rockDark by the data-declared y-band rule
// (ROCK_BANDING) so crater cross-sections read stone-in-dirt.
const fbmSite = (seed, theta, y) => {
  // 2-octave seeded value-noise FBM over the circle (cos/sin keep theta
  // continuous at the wrap) + a y term so layers stay lumpy in 3D.
  const a1 = noise2(seed, Math.cos(theta) * 1.0, Math.sin(theta) * 1.0 + y * 0.35);
  const a2 = noise2(seed ^ 6839585, Math.cos(theta) * 2.0, Math.sin(theta) * 2.0 + y * 0.7);
  return (a1 + 0.5 * a2) / 1.5;
};

function scatterRocks(f, seed, rs, salt, amount, banding) {
  const GRASS = 1, DIRT = 2, DARK = 3, ROCK = 4, ROCKDARK = 5;
  const row = W * Z;
  const nSites = Math.round((rs.count * W * Z) / 100000 * amount / 100);
  const nPebbles = Math.round((rs.pebbleDensity * W * Z) / 100000 * amount / 100);
  if (nSites === 0 && nPebbles === 0) return 0;
  const rnd = lcg(hashInt((seed >>> 0) ^ salt));
  const tops = new Map(); // column -> topmost solid y (lazy per touched column)
  const colTop = (x, z) => {
    const key = x + z * W;
    let t = tops.get(key);
    if (t === undefined) {
      t = -1;
      const base = x + z * W;
      for (let y = H - 1; y >= 0; y--) {
        if (f.cells[base + y * row] !== 0) { t = y; break; }
      }
      tops.set(key, t);
    }
    return t;
  };
  // Rock cell material by the data DEPTH-band rule with noise wobble (strata
  // wander with the surface AND with depth — never flat or uniform). Shared
  // pure law: rockBandDark (exported, the unit pins consume the same fn).
  const matAt = (x, y, z, seedLocal) => (rockBandDark(colTop(x, z) - y, x, y, z, banding, seedLocal) ? ROCKDARK : ROCK);
  // Noise-shaped boulder fill around (cx, cy, cz): occupancy iff
  // d <= baseR * (1 + amp * (fbmSite(θ, y, siteSeed) * 2 - 1)) and
  // |y - cy| <= 0.75 * baseR, never the surface cell, only soil values.
  const carveBoulder = (cx, cy, cz, baseR, siteSeed, amp) => {
    const rx = Math.ceil(baseR * (1 + amp)) + 1;
    const ry = Math.max(1, Math.round(baseR * 0.75));
    for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(W - 1, Math.ceil(cx + rx)); x++) {
      for (let z = Math.max(0, Math.floor(cz - rx)); z <= Math.min(Z - 1, Math.ceil(cz + rx)); z++) {
        for (let y = Math.max(0, cy - ry); y <= Math.min(H - 1, cy + ry); y++) {
          const dx = x - cx, dz = z - cz;
          const theta = Math.atan2(dz, dx);
          const n = fbmSite(siteSeed, theta, y);
          const rEff = baseR * (1 + amp * (n * 2 - 1));
          if (Math.hypot(dx, dz) > rEff) continue;
          if (Math.abs(y - cy) > baseR * 0.75) continue;
          if (y >= colTop(x, z)) continue; // never the surface cell itself
          const p = x + z * W + y * row;
          const v = f.cells[p];
          if (v === GRASS || v === DIRT || v === DARK) {
            f.cells[p] = matAt(x, y, z, seed); // depth-band + noise wobble
            placed++;
          }
        }
      }
    }
  };
  let placed = 0;
  for (let b = 0; b < nSites; b++) {
    const cx = Math.floor(rnd() * W);
    const cz = Math.floor(rnd() * Z);
    const r = rs.sizeMin + rnd() * (rs.sizeMax - rs.sizeMin);
    const depth = rs.minDepth + Math.floor(rnd() * (rs.maxDepth - rs.minDepth + 1));
    const top = colTop(cx, cz);
    if (top < 1) continue; // empty or surface-only column: nowhere to embed
    const cy = top - depth;
    if (cy < 0) continue;
    const siteSeed = hashInt((hashInt(b * 2654435761 + 12345) ^ (seed >>> 0) ^ salt) >>> 0);
    carveBoulder(cx, cy, cz, r, siteSeed, rs.noiseAmp);
    // Clusters: 1-3 smaller satellite blobs offset near the parent.
    if (rnd() < rs.clusterChance) {
      const nSat = 1 + Math.floor(rnd() * 3);
      for (let s = 0; s < nSat; s++) {
        const ang = rnd() * Math.PI * 2;
        const dist = r * (0.9 + rnd() * 0.7);
        const satR = r * (0.35 + rnd() * 0.3);
        const satSeed = hashInt((siteSeed ^ Math.imul(s + 1, 0x9e3779b9)) >>> 0);
        carveBoulder(
          cx + Math.cos(ang) * dist,
          cy + (rnd() * 2 - 1) * r * 0.3,
          cz + Math.sin(ang) * dist,
          satR, satSeed, rs.noiseAmp,
        );
      }
    }
  }
  // Pebbles: sparse single/2-cell nuggets through the dirt VOLUME (below the
  // surface, above y=1) — blasts carving dirt expose them in crater walls.
  for (let p = 0; p < nPebbles; p++) {
    const cx = Math.floor(rnd() * W);
    const cz = Math.floor(rnd() * Z);
    const top = colTop(cx, cz);
    if (top < 2) continue; // need soil BELOW the surface: y in [1, top-1]
    const depth = 1 + Math.floor(rnd() * Math.max(1, Math.min(rs.maxDepth, top - 1)));
    const y = Math.max(1, Math.min(top - 1, top - depth));
    if (y < 1 || y > top - 1) continue;
    const put = (x, z) => {
      if (x < 0 || x >= W || z < 0 || z >= Z) return;
      if (y >= colTop(x, z)) return; // never the surface cell itself
      const q = x + z * W + y * row;
      const v = f.cells[q];
      if (v === GRASS || v === DIRT || v === DARK) {
        f.cells[q] = matAt(x, y, z, seed); // depth-band + noise wobble
        placed++;
      }
    };
    put(cx, cz);
    if (rnd() < 0.5) put(cx + 1, cz); else put(cx, cz + 1); // 2-cell nugget half the time
  }
  return placed;
}

// Per-type salt: a deterministic hash of the type NAME (no data-field magic
// number needed — the name IS the data).
function typeSalt(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  return hashInt(h);
}

export function surfaceHeight(seed, x, z, params) {
  const sh = shapeForType(params, terrainTypeFor(params).def);
  const lk = landscapeFor(params);
  const base = sh.baseHeight;
  // REAL knob: bumpiness scales the rolling fBm amplitude (20 = identity).
  const rolling = fbm(seed, x, z) * sh.rollingAmp * (lk.bumpiness / 20);
  // REAL knobs: mountainPercent shifts the ridge-presence threshold
  // ((pct-20)/20 added — 20 = identity, 0 = none, 100 = everywhere); slope
  // scales the ridge amplitude (20 = identity); flattenPeaks caps the ridge
  // at half its full height (off = identity).
  const mtnBoost = (lk.mountainPercent - 20) / 20;
  const ridgeRaw = Math.pow(Math.max(0, fbm(seed + 7777, x, z) * 2 - 1 + mtnBoost), sh.ridgePower) * sh.ridgeAmp * (lk.slope / 20);
  const ridge = lk.flattenPeaks ? Math.min(ridgeRaw, sh.ridgeAmp * (lk.slope / 20) * 0.5) : ridgeRaw;
  const h = Math.round(base + rolling + ridge);
  // DEEPEN-1015 R6: the clamp ceiling is PLAYABLE_H - 10 (the historical H=192
  // bound) — surfaceHeight keeps its playable-above-the-floor-plane semantics
  // and byte-identical output; the deep floor cells are generate()'s business.
  return Math.max(sh.heightMin, Math.min(PLAYABLE_H - 10, h));
}


// Fills every column [0, top) solid with bands measured DOWN from the top:
// grass (1-3 cells, per-column deterministic), then 12 dirt, then 24 dark,
// then dirt to y=0. DEEPEN-1015 (USER DECISION): the old grey rock/rockDark
// base band below the dark band is REMOVED — the playable strata (grass/dirt)
// extend to the bottom of the field; no grey base block. Rock/rockDark remain
// via scatterRocks (surface boulders + pebbles, Rock Amount row, y-band
// strata) — only the base fill changed. Bands clamp naturally at y=0 — short
// columns can be all-grass+dirt; no special-casing, bands just run out.
// FPS-1012d (USER DECISION): the .MTN preset path is REMOVED from terrain
// shaping — the user read "landscape preset" as a VISUAL pick, not a shape
// override; the W1-C shape-replication path flattened the 3D fBm hills and
// the depth-patch attempt didn't restore the feel. Terrain is the pure 3D
// noise surface again (surfaceHeight, below) for EVERY settings value.
// data/landscapes.json stays as reference for a FUTURE visual (colors/sky)
// use; a stored legacy preset value is ignored fail-noisy at settingsApply.
export function generate(seed, params = {}) {
  const f = makeField();
  // W2-H (plan SE-COMPLETE-1012): the seed + landscape params RIDE the field
  // object so the dressing skirt consumes the SAME landscape without main.js
  // wiring. Metadata only — NON-ENUMERABLE so field deepEqual pins (fields
  // generated with equal params must stay byte-identical) never see it; the
  // cells bytes are untouched.
  Object.defineProperty(f, '__seSeed', { value: seed >>> 0, enumerable: false, writable: true });
  Object.defineProperty(f, '__seParams', {
    value: Object.freeze(params && typeof params === 'object' ? { ...params } : {}),
    enumerable: false,
    writable: true,
  });
  const GRASS = 1, DIRT = 2, DARK = 3, ROCK = 4; // ROCK: scatterRocks material only (DEEPEN-1015: never the base fill)
  // TERRAIN TYPES: resolve the named type first — its .shape overrides merge
  // into the shape defaults (per-scene .shape still wins), and its
  // .rockScatter (if any) converts soil cells to rock after the fill pass.
  const { name: typeName, def: typeDef } = terrainTypeFor(params);
  const sh = shapeForType(params, typeDef);
  const ROW = W * Z;
  // DEEPEN-1015 R6 PERF: the deep floor extension multiplies the fill volume
  // (~620 cells/column vs ~90). The per-column laws are computed ONCE into
  // typed arrays (identical values/formulas as the old per-column loop —
  // byte-identical output), then the fill runs as:
  //   rows [0, minDirt): every column is below its band stack there -> the
  //   whole contiguous y-row is DIRT -> one cells.fill memset per row;
  //   rows [minDirt, maxTop): one ascending scan — per column, below its
  //   yDirtStart is DIRT, the [yDirtStart, top) window carries the strata
  //   bands (grass/dirt/dark, fromTop measured down from the top), above top
  //   stays EMPTY (allocation-zeroed — never written).
  const nCols = ROW;
  const tops = new Int16Array(nCols);
  const gArr = new Int16Array(nCols);
  const dirtArr = new Int16Array(nCols);
  const darkArr = new Int16Array(nCols);
  const yDirtStart = new Int16Array(nCols);
  let maxTop = 0;
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < Z; z++) {
      const col = x + z * W;
      // DEEPEN-1015 R6: the column top in CELL space = FLOOR_CELLS (the deep
      // cells below the playable floor plane) + the playable top. The SAME
      // strata law fills [0, top) — below the dark band the fill continues as
      // DIRT all the way to the deep floor (real terrain voxels below the
      // playable surface, never an auxiliary mesh).
      const top = FLOOR_CELLS + surfaceHeight(seed, x, z, params);
      // Per-column grass thickness 1..grassMax, fully deterministic.
      const g = 1 + (hashInt(x * 31 + z * 57 + seed) % sh.grassMax);
      // DEEPEN-1015 R4: per-column WOBBLED band thicknesses (data .strataWobble)
      // — seeded noise offsets over the base sh.dirtBand / sh.darkBand,
      // clamped >= 1; deterministic per seed, wobble 0 = legacy exact bands.
      const dirtThick = Math.max(1, sh.dirtBand + Math.round((noise2(seed ^ STRATA_SALT_DIRT, x * STRATA_WOBBLE.freq, z * STRATA_WOBBLE.freq) * 2 - 1) * STRATA_WOBBLE.dirt));
      const darkThick = Math.max(1, sh.darkBand + Math.round((noise2(seed ^ STRATA_SALT_DARK, x * STRATA_WOBBLE.freq, z * STRATA_WOBBLE.freq) * 2 - 1) * STRATA_WOBBLE.dark));
      tops[col] = top;
      gArr[col] = g;
      dirtArr[col] = dirtThick;
      darkArr[col] = darkThick;
      yDirtStart[col] = Math.max(0, top - (g + dirtThick + darkThick));
      if (top > maxTop) maxTop = top;
    }
  }
  let minDirt = yDirtStart[0];
  for (let c = 1; c < nCols; c++) if (yDirtStart[c] < minDirt) minDirt = yDirtStart[c];
  const cells = f.cells;
  // Rows below EVERY column's band stack are pure deep dirt: one memset each.
  for (let y = 0; y < minDirt; y++) {
    cells.fill(DIRT, y * ROW, (y + 1) * ROW);
  }
  // Above that, per-column monotonic loops: the remaining deep-dirt stretch
  // [minDirt, yDirtStart) then the strata-band window [yDirtStart, top).
  // (Same law and values as the retired per-column fillColumn — the band
  // math below is its body verbatim; only the iteration order changed.)
  for (let col = 0; col < nCols; col++) {
    const top = tops[col];
    const ys = yDirtStart[col] < minDirt ? minDirt : yDirtStart[col];
    for (let y = minDirt; y < ys; y++) cells[col + y * ROW] = DIRT;
    const g = gArr[col], dt = dirtArr[col], dkt = darkArr[col];
    for (let y = ys; y < top; y++) {
      const fromTop = top - 1 - y; // 0 = topmost cell
      let m;
      if (fromTop < g) m = GRASS;
      else if (fromTop < g + dt) m = DIRT;
      else if (fromTop < g + dt + dkt) m = DARK;
      // DEEPEN-1015: below the dark band the strata continue as DIRT to the
      // deep floor — the grey rock base band is gone from the base fill.
      else m = DIRT;
      cells[col + y * ROW] = m;
    }
  }
  // Rock scatter AFTER the fill: pure material conversion, separate RNG,
  // scaled by the Rock Amount row (params.rockAmount, default 100 = identity).
  if (typeDef.rockScatter) {
    scatterRocks(f, seed, typeDef.rockScatter, typeSalt(typeName), rockAmountFor(params), ROCK_BANDING);
  }
  return f;
}

// (fillColumn was folded into generate()'s DEEPEN-1015 R6 row-wise fill —
// same law, one pass; see the PERF comment in generate above.)
