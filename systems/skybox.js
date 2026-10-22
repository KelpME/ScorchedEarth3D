/**
 * Skybox system (plan SE-UI-CAM-1011 T-UI-4; W2-Ca plan SE-COMPLETE-1012).
 *
 * Two layers, strictly separated:
 *   MECHANISMS (code): 'gradient' — large inverted sphere, vertex-color
 *                gradient: horizon haze at y=0, darker zenith, darker nadir.
 *                'solid'    — same inverted sphere with one flat color.
 *   OG STYLES (DATA): the 8 manual sky styles (manual:L1922-L1929) live ONLY in
 *                data/physics-presets.json under "skyStyles" — palette
 *                (zenith/horizon/nadir hex, or seeded:true for PLAIN's
 *                per-round classic-SE family), haze.density (the fog-system
 *                seam, via getFogParams()), and sun/moon/stars flags.
 *                HARD DOCTRINE: style palettes = DATA; nothing style-shaped
 *                lives in this file. Data is loaded at module init (fetch in
 *                the browser, fs fallback in node tests); unavailable data
 *                fails NOISY and the system degrades to the two mechanisms.
 *   RANDOM is a picker (data `picker:true`, `excludes:['BLACK']`): the round
 *                seed deterministically picks one non-excluded style.
 *
 * Exports:
 *   SKY_STYLES            — ['gradient','solid'] (the mechanism registry)
 *   OG_SKY_STYLES         — the 8 OG style names, straight from the data file
 *   resolveStyle(value)   — pure: settings 'sky' value -> { style, note }.
 *                           Mechanism + OG names match (case/whitespace
 *                           tolerant); missing/unknown fall back to 'gradient'
 *                           with a note NAMING the fallback (never silent).
 *   getFogParams(style)   — pure: style -> { density, color } from the DATA.
 *                           The seam the future fog system consumes (density 0
 *                           = no haze; color = the style's horizon color).
 *   skyVariation(seed)    — pure: seed -> { zenith, horizon, nadir } hex colors
 *                           (deterministic LCG keyed by the ROUND seed).
 *   createSkybox(THREE, { style, seed }) -> { object3d, style, variation,
 *                           disposed, dispose() }.
 *                           Every instance owns its geometry AND material —
 *                           dispose() kills them (plus any starfield), so
 *                           nothing is ever shared across disposals. State for
 *                           specs rides on object3d.userData: { fog, stars,
 *                           sun, moon }.
 */

export const SKY_STYLES = ['gradient', 'solid'];

// ---- W2-Ca: OG style DATA (physics-presets.json "skyStyles") ----------------
// Loaded once at module init. Browser: fetch relative to this module URL
// (serve.js serves the game root). Node: fetch has no file:// handler, so the
// same URL is read via node:fs. Either way the DATA is the single source.
let OG_STYLES_DATA = null;
let ogStyleNames = [];
async function _loadStyleData() {
  const url = new URL('../data/physics-presets.json', import.meta.url);
  let fetchErr = null;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    OG_STYLES_DATA = (await res.json()).skyStyles || null;
  } catch (err) {
    fetchErr = err;
  }
  if (!OG_STYLES_DATA) {
    try {
      const fs = await import('node:fs');
      OG_STYLES_DATA = JSON.parse(fs.readFileSync(url, 'utf8')).skyStyles || null;
    } catch (fsErr) {
      console.error(
        `[sky] skyStyles data unavailable (fetch: ${fetchErr ? fetchErr.message : 'skipped'}; ` +
        `fs: ${fsErr.message}) — OG styles disabled, gradient default only`,
      );
    }
  }
  ogStyleNames = OG_STYLES_DATA ? Object.keys(OG_STYLES_DATA).filter((k) => !k.startsWith('_')) : [];
}
await _loadStyleData(); // top-level await: main.js cannot mount a sky before the DATA exists

export const OG_SKY_STYLES = ogStyleNames;

// numericjs-style LCG constants (same family as settingsApply.js rollWind) —
// deterministic, no Math.random anywhere.
const LCG_A = 1664525;
const LCG_C = 1013904223;
const LCG_M = 4294967296; // 2^32

function lcg(seed) {
  let s = (Number(seed) >>> 0) || 1; // 0 would fixpoint on LCG_C
  return () => {
    s = (Math.imul(s, LCG_A) + LCG_C) >>> 0;
    return s / LCG_M;
  };
}

/** h,s,l (0..1) -> '#rrggbb' — the standard HSL recipe, no THREE dependency. */
function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Pure per-round sky palette from the round seed. Same seed = same sky;
 * different seed = (with overwhelming probability) different sky. Classic-SE
 * family (user-tuned 2026-10-11: the old mid-blue zenith read as a "huge blue
 * spot" when zoomed out): PALE warm-blue zenith, beige horizon haze, muted
 * nadir — each nudged per seed so rounds visibly differ while the sky stays
 * warm/beige at every zoom level.
 */
export function skyVariation(seed) {
  const rand = lcg(seed);
  const jitter = (base, span) => base + (rand() - 0.5) * span;
  const zenith = hslToHex(((jitter(0.57, 0.04) % 1) + 1) % 1, jitter(0.22, 0.10), jitter(0.78, 0.06));
  const horizon = hslToHex(((jitter(0.10, 0.04) % 1) + 1) % 1, jitter(0.38, 0.14), jitter(0.82, 0.05));
  const nadir = hslToHex(((jitter(0.32, 0.08) % 1) + 1) % 1, jitter(0.18, 0.12), jitter(0.2, 0.06));
  return { zenith, horizon, nadir };
}

/**
 * Pure settings-value -> style. Mechanism names and OG style names match
 * directly (case/whitespace tolerant; OG names canonicalize to uppercase);
 * anything else (missing, empty, junk) resolves to the 'gradient' default and
 * returns a note string that NAMES the fallback — the caller is responsible
 * for logging it (console.info) so the choice is never silent.
 */
export function resolveStyle(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (SKY_STYLES.includes(trimmed.toLowerCase())) {
    return { style: trimmed.toLowerCase(), note: null };
  }
  const og = ogStyleNames.find((n) => n.toLowerCase() === trimmed.toLowerCase());
  if (og) return { style: og, note: null };
  const shown = value === undefined || value === null ? 'unset' : JSON.stringify(String(value));
  return {
    style: 'gradient',
    note: `sky setting ${shown} is not a known sky style (${[...SKY_STYLES, ...ogStyleNames].join('|')}) — defaulting to 'gradient'`,
  };
}

/**
 * W2-Ca fog/haze seam — per-style fog params straight from the DATA. The
 * future fog system consumes { density, color }; density 0 = no haze, color
 * is the style's horizon color (null for the seeded default, which has no
 * static palette). Unknown style -> zero fog. Pure, no THREE.
 */
export function getFogParams(style) {
  const entry = OG_STYLES_DATA && typeof style === 'string' ? OG_STYLES_DATA[style] : null;
  if (!entry || entry.picker) return { density: 0, color: null };
  return {
    density: entry.haze && typeof entry.haze.density === 'number' ? entry.haze.density : 0,
    color: entry.colors && entry.colors.horizon ? entry.colors.horizon : null,
  };
}

/** W2-Ca: deterministic RANDOM pick — one non-excluded OG style per seed. */
function pickRandom(seed) {
  const usable = ogStyleNames.filter((n) => {
    const e = OG_STYLES_DATA[n];
    return e && !e.picker && !(e.excludes || []).includes(n);
  });
  if (!usable.length) return null;
  const rand = lcg(Number(seed) >>> 0);
  return usable[Math.floor(rand() * usable.length)];
}

const SKY_RADIUS = 800; // camera far is 1000 (engine Renderer): inside far; RECENTERED on the camera xz each frame (main.js recenterSky, SE-COVERAGE-1015) so a radius modest vs the field span is safe at every mapSize

/** Deterministic upper-hemisphere starfield (STARS data flag -> visible stars). */
function buildStarfield(THREE, seed) {
  const COUNT = 300;
  const rand = lcg(seed);
  const pos = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    // uniform direction on the upper hemisphere, near the sky radius
    const u = rand();
    const v = rand();
    const theta = u * Math.PI * 2;
    const z = 0.05 + v * 0.95; // y in [0.05, 1] — always above the horizon
    const r = Math.sqrt(1 - z * z);
    const R = SKY_RADIUS * 0.92;
    pos[i * 3] = Math.cos(theta) * r * R;
    pos[i * 3 + 1] = z * R;
    pos[i * 3 + 2] = Math.sin(theta) * r * R;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const material = new THREE.PointsMaterial({ color: 0xffffff, size: 2.5, sizeAttenuation: false, depthWrite: false, fog: false });
  const points = new THREE.Points(geometry, material);
  points.name = 'skybox-stars';
  points.renderOrder = -999; // over the sky sphere (-1000), under everything else
  points.frustumCulled = false;
  return points;
}

/**
 * Build a skybox instance. `seed` keys the per-round palette (omit for the
 * unseeded boot default 0 — main.js always passes the round seed). Mechanism
 * names and OG style names both work; RANDOM resolves to a seeded pick.
 * Unknown styles fail NOISY (console.error naming what was skipped) and still
 * build the gradient default, so a bad settings value can never blank the sky.
 */
export function createSkybox(THREE, { style, seed = 0 } = {}) {
  let effective = style;
  let entry = null;
  if (typeof style === 'string' && ogStyleNames.includes(style)) {
    entry = OG_STYLES_DATA[style];
    if (entry && entry.picker) {
      const picked = pickRandom(seed);
      if (picked) {
        effective = picked;
        entry = OG_STYLES_DATA[picked];
      } else {
        console.error('[sky] RANDOM pick: no usable style in skyStyles data — defaulting to gradient');
        effective = 'gradient';
      }
    }
  } else if (!SKY_STYLES.includes(style)) {
    console.error(`[sky] createSkybox: style ${JSON.stringify(style)} is not one of ${[...SKY_STYLES, ...ogStyleNames].join('|')} — skipped, building 'gradient'`);
    effective = 'gradient';
  }

  let variation;
  let mechanism = effective; // 'gradient' | 'solid' when no OG entry
  if (entry) {
    mechanism = entry.mechanism || 'gradient';
    variation = entry.seeded ? skyVariation(seed) : { ...entry.colors }; // DATA, never code
  } else {
    variation = skyVariation(seed);
  }

  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 16);

  let material;
  if (mechanism === 'gradient') {
    // Per-vertex gradient: t = y/radius in [-1,1]; horizon haze band around
    // y=0, blending to the darker zenith above and darker nadir below.
    const pos = geometry.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const zen = new THREE.Color(variation.zenith);
    const hor = new THREE.Color(variation.horizon);
    const nad = new THREE.Color(variation.nadir);
    const c = new THREE.Color();
    const smooth = (t) => t * t * (3 - 2 * t); // smoothstep
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(-1, Math.min(1, pos.getY(i) / SKY_RADIUS));
      if (t >= 0) c.copy(hor).lerp(zen, smooth(Math.min(1, t / 0.6)));
      else c.copy(hor).lerp(nad, smooth(Math.min(1, -t / 0.35)));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false });
  } else {
    material = new THREE.MeshBasicMaterial({ color: variation.zenith, side: THREE.BackSide, depthWrite: false, fog: false });
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `skybox-${effective}`;
  mesh.renderOrder = -1000; // renders first; with depthWrite=false everything paints over it
  mesh.frustumCulled = false; // frustum-safe: a 1600u sphere is never culled by the arena camera

  // W2-Ca state handle for specs (window.__se.sky.object3d.userData in-browser):
  // per-style fog/haze params (the future fog system's seam) + the data flags.
  const styleFlags = entry || { sun: false, moon: false, stars: false };
  mesh.userData = {
    fog: getFogParams(effective),
    stars: !!styleFlags.stars,
    sun: !!styleFlags.sun,
    moon: !!styleFlags.moon,
  };
  if (styleFlags.stars) {
    mesh.add(buildStarfield(THREE, seed)); // deterministic per seed
  }

  let disposed = false;
  return {
    object3d: mesh,
    style: effective,
    seed: Number(seed) >>> 0, // the round seed this sky was built from (state handle)
    variation,
    fog: mesh.userData.fog, // mirrored on the handle for node-side consumers
    stars: mesh.userData.stars,
    get disposed() { return disposed; },
    dispose() {
      if (disposed) return; // idempotent
      disposed = true;
      for (const child of [...mesh.children]) {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
        mesh.remove(child);
      }
      if (mesh.parent) mesh.parent.remove(mesh);
      geometry.dispose(); // this instance owns both — nothing shared survives
      material.dispose();
    },
  };
}
