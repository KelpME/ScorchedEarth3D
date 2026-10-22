// W5 (plan SE-CINEMATIC-1013, contract C9) — INTRO TITLE CANVAS lifecycle.
// The title itself ("Scorched Earth 3D", Rescuers Down Under title-sequence
// styling: bold serif, burnt orange, dark drop shadow) is SCENE DATA on the
// intro_title entity: a `canvas` component (renderMode 'world' — the engine's
// world-canvas mechanism, node_modules hermesforge-engine/src/render/
// world-canvas.js) with CHILD TEXT WIDGET entities (components text + rect —
// string/color/size/weight/align/offsets all authored in scenes/menu.json,
// shadows are duplicated dark text children offset behind the orange lines).
// NOTHING about the title's content lives in this file.
//
// This script owns only the LIFECYCLE gate: the title plane is visible while
// the intro flyover flies (the camera passes it mid-flight — the movie's
// letters-pass-by feel) and hides at the handoff. Activation mirrors
// intro_flyover: params.enabled === true (inspector toggle) OR game state
// `introFlyover === 'play'` (armed by main.js on every real new game).
// Fail-noisy: an entity without a `canvas` component is named in the console
// and the script goes dormant (no silent fallbacks, no invented content).

export const SCRIPT_NAME = 'title_canvas';

const def = {
  name: SCRIPT_NAME,
  label: 'Intro title canvas',
  description: 'Lifecycle gate for the intro_title world-canvas title (C9): visible while the intro flyover flies (the camera passes the title mid-flight), hidden at the handoff. The title TEXT/COLOR/SIZE are scene data on the canvas child widgets — never here. Trigger: params.enabled OR state introFlyover === "play".',
  params: {
    enabled: { type: 'boolean', default: false },
  },

  update(state, dt, api, id, params) {
    if (!state.checked) {
      state.checked = true;
      const rec = api.entity(id);
      if (!rec || !rec.components || !rec.components.canvas) {
        console.error(`[title_canvas] ${id}: no canvas component — the title cannot render as a world surface (scene data gap, fail-noisy); script dormant`);
        state.broken = true;
      }
    }
    if (state.broken) return;

    // Armed by: params.enabled (inspector), the main.js new-game seam
    // (state introFlyover === 'play'), OR the live flyover seam itself (a
    // params.enabled flyover — spec/dev boots — publishes __se.introFlyover).
    const seam = typeof window !== 'undefined' ? window.__se?.introFlyover : null;
    const play = params.enabled === true ||
      (typeof api.state?.get === 'function' && api.state.get()?.introFlyover === 'play') ||
      !!seam;
    if (!play) return;

    // Desired visibility follows the flyover seam: shown while the flight is
    // live ('flying'), hidden once it hands off ('done'). No seam (editor
    // toggle path, params.enabled): shown — the author is inspecting it.
    const show = seam ? seam.phase === 'flying' : true;
    const rec = api.entity(id);
    if (!rec) return;
    if (!rec.components.render) rec.components.render = {};
    if (rec.components.render.visible !== show) {
      rec.components.render.visible = show; // the same flag the editor/armor visibility toggles (renderer _collect gate)
    }
  },
};

export default def;
