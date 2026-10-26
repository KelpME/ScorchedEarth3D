// T-G4 — aquarium pane drop. Drops a pane from `dropHeight` above the
// EXPLICIT rest height `params.restY` (world units, authored in the scene
// script params — never captured from the live transform, which can be
// mid-drop if the adapter re-instances the script state). Tweens back down
// with cubic ease-out over `duration`.
// Fail-noisy: missing/invalid restY names the entity and leaves it authored.
export default {
  name: 'pane_drop', label: 'Pane drop',
  description: 'Drops an aquarium pane from dropHeight above params.restY, easing out over duration.',
  params: {
    dropHeight: { type: 'number', default: 60 },
    duration: { type: 'number', default: 1.2 },
    restY: { type: 'number' },
  },
  update(state, dt, api, id, params) {
    const rec = api.entity(id);
    if (!rec || !rec.components) return;
    const tr = rec.components.transform;
    if (!tr) {
      console.error(`[pane_drop] entity ${id} has no transform component — cannot drop`);
      return;
    }
    if (state.restY === undefined) {
      if (typeof params.restY !== 'number' || !Number.isFinite(params.restY)) {
        console.error(`pane_drop: params.restY missing for ${id} — pane will not animate`);
        state.restY = null;
        return;
      }
      state.restY = params.restY;
      state.age = 0;
    }
    if (state.restY === null) return; // fail-noisy: leave pane at authored pose
    const drop = params.dropHeight ?? 60;
    const dur = params.duration ?? 1.2;
    if (state.age === 0 && tr.y === state.restY) {
      tr.y = state.restY + drop; // first frame: start high in the sky
    }
    state.age = Math.min(dur, state.age + dt);
    const t = state.age / dur;
    const ease = 1 - Math.pow(1 - t, 3); // cubic ease-out onto rest y
    tr.y = state.restY + drop * (1 - ease);
  },
};
