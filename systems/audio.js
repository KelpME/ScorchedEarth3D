// W3-B (plan SE-COMPLETE-1012) — WebAudio synthesis audio system.
//
// ASSET POLICY: the OG EXE has NO raw PCM (data/og-assets.json audioScan) —
// its SFX were procedural/compressed. We synthesize everything with WebAudio:
// royalty-free, ours, and DATA-driven. Every game event maps to a synth
// recipe in data/sound.json `events` (osc type, freq sweep, white-noise mix,
// envelope, duration, gain) — the data file IS the editable surface; engine
// code carries no sound literals.
//
// SEAM: `se.audio.play(eventId, opts)` is THE seam for every fx call site
// (deaths/weather/lightning leaves add their own calls later). Event wiring
// for fire/explosion/flight runs here WITHOUT touching main.js or
// projectiles3d.js: the browser watcher (autoInstall) observes the EXISTING
// seams — se.liveShot (projectiles3d spawn/destroy, line 147) and
// se.lastImpact.stamp (projectiles3d impact, line 171).
//
// SETTINGS (all through applySettings via the wired:true rows in
// data/sound.json): se.settings.sound (bool), se.settings.volume (0..1),
// se.settings.flightSounds ('POS'|'VEL'|'OFF'). Laws (unit-pinned):
//   - sound off  -> play() schedules ZERO nodes (event still logged)
//   - volume 0   -> play() schedules ZERO nodes
//   - flightSounds OFF or no live projectile -> flight loop torn down
//
// SCHEDULER-SAFE: ONE shared AudioContext, created lazily, resumed on the
// first user gesture (pointerdown/keydown). Recipes are white-noise (cached
// buffer) + oscillator + gain envelopes — no per-play context spam. Node
// counts are deterministic and unit-pinned: (osc?2:0)+(noise>0?2:0).
import soundData from '../data/sound.json' with { type: 'json' };
import weaponsData from '../data/weapons.json' with { type: 'json' };

const WEAPONS = Object.fromEntries((weaponsData.weapons || []).map((w) => [w.id, w]));
// Fire/explosion size bounds (RECORD pixels from data/weapons.json:
// baby_missile 10 ... nuke 75). DATA-derived, not magic: >= 25 px = the heavy
// half of the catalog (heavy artillery, mirv, nuke...).
const LARGE_WEAPON_PX = 25;
const LARGE_IMPACT_WORLD = 5; // rWorld bound: the FIX2 conversion makes nuke 15, baby 2

/** Registry: validate + copy the events map. Fail loud on missing/incomplete data. */
export function loadRegistry(doc) {
  const events = doc && doc.events;
  if (!events || typeof events !== 'object') {
    throw new Error('[se/audio] data/sound.json `events` map missing — audio cannot load (fail loud)');
  }
  const out = {};
  for (const [id, r] of Object.entries(events)) {
    if (id.startsWith('_')) continue;
    if (typeof r.duration !== 'number' || typeof r.gain !== 'number') {
      throw new Error(`[se/audio] recipe "${id}" needs numeric duration and gain — fix the data`);
    }
    if (r.osc && typeof r.osc.type !== 'string') {
      throw new Error(`[se/audio] recipe "${id}" osc.type missing — fix the data`);
    }
    out[id] = r;
  }
  return out;
}

/** Peak loudness for one recipe at the current volume (law: recipe.gain * volume). */
function peak(recipe, volume) {
  return Math.max(0, Math.min(1, recipe.gain)) * Math.max(0, Math.min(1, volume));
}

/**
 * createAudio({ recipes, getContext, settings }) — the pure core. getContext
 * is injected so unit tests drive a fake AudioContext; settings is a provider
 * returning the applySettings-stored map (se.settings).
 */
export function createAudio({ recipes, getContext, settings = () => ({}) }) {
  const audio = {
    recipes,
    running: false, // flight loop live?
    played: [], // observable seam: recent { id, nodes, at } (capped)
    __loop: null, // { osc, gain, noise, noiseGain }
    __flightData: null,
    settings,
  };
  const log = (id, nodes) => {
    audio.played.push({ id, nodes, at: (typeof performance !== 'undefined' ? performance.now() : Date.now()) });
    if (audio.played.length > 128) audio.played.shift();
  };

  function schedule(recipe) {
    const ctx = getContext && getContext();
    if (!ctx) return 0;
    const t0 = ctx.currentTime;
    const p = peak(recipe, typeof audio.settings().volume === 'number' ? audio.settings().volume : 1);
    if (p <= 0) return 0; // volume law — nothing scheduled at all
    let n = 0;
    const env = (gainNode) => {
      const g = gainNode.gain;
      g.setValueAtTime(0.0001, t0);
      g.setValueAtTime(p, t0 + (recipe.attack ?? 0.005));
      g.exponentialRampToValueAtTime(0.0001, t0 + recipe.duration);
    };
    if (recipe.osc) {
      const osc = ctx.createOscillator();
      osc.type = recipe.osc.type;
      osc.frequency.setValueAtTime(recipe.osc.from, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, recipe.osc.to), t0 + recipe.duration);
      const g = ctx.createGain();
      g.__isGain = true; g.__peak = p; // test seam
      env(g);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + recipe.duration + 0.02);
      n += 2;
    }
    const noise = typeof recipe.noise === 'number' ? recipe.noise : 0;
    if (noise > 0) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      const g = ctx.createGain();
      g.__isGain = true; g.__peak = p * noise; // test seam
      const gn = g.gain;
      gn.setValueAtTime(0.0001, t0);
      gn.setValueAtTime(p * noise, t0 + (recipe.attack ?? 0.005));
      gn.exponentialRampToValueAtTime(0.0001, t0 + recipe.duration);
      src.connect(g).connect(ctx.destination);
      src.start(t0); src.stop(t0 + recipe.duration + 0.02);
      n += 2;
    }
    return n;
  }

  /** THE seam. Returns the node count scheduled (0 = silent/muted/unknown). */
  audio.play = (id, _opts = {}) => {
    const recipe = recipes[id];
    if (!recipe) {
      console.error(`[se/audio] unknown event id "${id}" — no recipe in data/sound.json (fail-noisy, nothing scheduled)`);
      log(id, 0);
      return 0;
    }
    const s = audio.settings();
    if (s.sound === false) { // MUTE LAW: sound off -> ZERO nodes (logged, observable)
      log(id, 0);
      return 0;
    }
    const nodes = schedule(recipe);
    log(id, nodes);
    return nodes;
  };

  /** Flight-loop data feed (documented foreman seam): pos {x,y,z}, vel {x,y,z}. */
  audio.flight = (data) => { audio.__flightData = data; };

  function startLoop() {
    const ctx = getContext && getContext();
    if (!ctx || audio.__loop) return;
    const recipe = recipes['projectile.flight'];
    if (!recipe) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = recipe.osc.type;
    osc.frequency.setValueAtTime(recipe.osc.from, t0);
    osc.loop = true; // continuous while the projectile flies
    const g = ctx.createGain();
    const p = peak(recipe, typeof audio.settings().volume === 'number' ? audio.settings().volume : 1) * 0.6;
    g.gain.setValueAtTime(p, t0);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    audio.__loop = { osc, gain: g };
    audio.running = true;
  }

  function stopLoop() {
    const ctx = getContext && getContext();
    if (audio.__loop && ctx) {
      try { audio.__loop.osc.stop(); } catch { /* already stopped */ }
      audio.__loop = null;
    }
    audio.running = false;
  }

  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  /** Pitch mapping — DATA bounds from sound.json pitch: POS by height, VEL by speed. */
  function pitch() {
    const recipe = recipes['projectile.flight'];
    const pb = recipe && recipe.pitch;
    const d = audio.__flightData;
    if (!pb || !d) return null;
    let t;
    if (audio.settings().flightSounds === 'POS' && d.pos) {
      t = clamp01((d.pos.y - pb.pos.min) / (pb.pos.max - pb.pos.min));
    } else if (d.vel) {
      const speed = Math.hypot(d.vel.x || 0, d.vel.y || 0, d.vel.z || 0);
      t = clamp01((speed - pb.vel.min) / (pb.vel.max - pb.vel.min));
    } else {
      return null;
    }
    return pb.freq.min + t * (pb.freq.max - pb.freq.min);
  }

  /**
   * Flight-loop gating (call per frame; the browser watcher and unit tests
   * both drive it). update(dt, { flying }): starts the loop only when the
   * flightSounds setting is POS/VEL AND a projectile is live; tears it down
   * otherwise; applies the data-driven pitch while running.
   */
  audio.update = (_dt, { flying = false } = {}) => {
    const mode = audio.settings().flightSounds;
    if (!flying || mode === 'OFF' || mode === undefined || mode === false) {
      stopLoop();
      return;
    }
    if (!audio.running) startLoop();
    if (audio.__loop) {
      const f = pitch();
      if (f != null && audio.__loop.osc.frequency) audio.__loop.osc.frequency.value = f;
    }
  };

  audio.stopLoop = stopLoop; // explicit teardown seam
  return audio;
}

// One shared noise buffer per context (scheduler-safe: no per-play buffer alloc).
function noiseBuffer(ctx) {
  if (!ctx.__seNoise) {
    const len = Math.floor(ctx.sampleRate || 44100) * 1;
    ctx.__seNoise = ctx.createBuffer(1, len, ctx.sampleRate || 44100);
    const data = ctx.__seNoise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  return ctx.__seNoise;
}

// ---------------------------------------------------------------------------
// Browser install: the system self-mounts on window.__se from the hud.js
// module side-effect import (main.js is NOT touched). Watches the EXISTING
// seams for fire/explosion/flight; exposes window.__se.audio.
// ---------------------------------------------------------------------------

/** Weapon record for the live shot: se.weaponOverride may return record or id. */
function shotWeapon(se) {
  try {
    const o = typeof se.weaponOverride === 'function' ? se.weaponOverride() : null;
    if (!o) return WEAPONS.baby_missile;
    if (typeof o === 'object') return o.behavior ? o : (WEAPONS[o.id] ?? WEAPONS.baby_missile);
    return WEAPONS[o] ?? WEAPONS.baby_missile;
  } catch {
    return WEAPONS.baby_missile;
  }
}

export function autoInstall() {
  if (typeof window === 'undefined') return; // node unit runs: never install
  let installed = false;
  const tryInstall = () => {
    if (installed) return true;
    const se = window.__se;
    if (!se) return false;
    installed = true;
    // ONE shared AudioContext, lazily created, resumed on first gesture.
    let ctx = null;
    const getContext = () => {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); } catch { return null; }
        const resume = () => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); };
        for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, { once: true, passive: true });
      }
      return ctx;
    };
    const audio = createAudio({
      recipes: loadRegistry(soundData),
      getContext,
      settings: () => (window.__se && window.__se.settings) || {},
    });
    se.audio = audio;

    // Watcher: fire/explosion from the EXISTING seams (no main.js edits), and
    // the flight-loop gate. tick() is exposed for deterministic specs.
    let fireLatch = false;
    let lastImpactStamp = se.lastImpact ? se.lastImpact.stamp : 0;
    audio.tick = () => {
      const s = window.__se;
      if (!s || !s.audio) return;
      const flying = !!s.liveShot;
      if (flying && !fireLatch) {
        fireLatch = true;
        const w = shotWeapon(s);
        audio.play((w.blastRadius ?? 0) >= LARGE_WEAPON_PX ? 'fire.large' : 'fire.small');
        audio.play('projectile.whistle'); // descending falling-shell tone
      } else if (!flying) {
        fireLatch = false;
      }
      const li = s.lastImpact;
      if (li && li.stamp !== lastImpactStamp) {
        lastImpactStamp = li.stamp;
        audio.play((li.rWorld ?? 0) >= LARGE_IMPACT_WORLD ? 'explosion.large' : 'explosion.small');
      }
      audio.update(1 / 60, { flying });
    };
    const loop = () => { audio.tick(); window.requestAnimationFrame(loop); };
    window.requestAnimationFrame(loop);
    return true;
  };
  if (!tryInstall()) {
    const poll = window.setInterval(() => { if (tryInstall()) window.clearInterval(poll); }, 120);
  }
}

// Editor-visible system object (same shape as the other systems/*.js modules).
// Registration in main.js's systems map is the FOREMAN's line — this module
// already self-installs via hud.js, so the default export documents the seam:
//   systems: { ..., audio: audioSystem }   // optional; watcher is self-driven
export default {
  name: 'audio',
  label: 'Audio (WebAudio synth)',
  description: 'Data-driven SFX: every event is a synth recipe in data/sound.json; se.audio.play(id) is the seam; sound/volume/flightSounds settings wired through applySettings.',
  update(dt, api) {
    const se = typeof window !== 'undefined' && window.__se;
    if (se && se.audio && se.audio.tick) se.audio.tick(); // no-op if self-install already drives it
  },
};
