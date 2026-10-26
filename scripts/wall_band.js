// Wall-visual unification (cleanup directive, plan W2-B retirement): the arena
// wall visual lives ON the glass pane entities — no parallel invisible band.
// Attach `wall_band` to a parent `arena_wall` entity; the 4 glass_pane
// entities are its CHILDREN (the hierarchy shows the panes in the editor).
//
// ONE param in ONE place drives all panes: `wallMode` (settings row, data enum
// in data/physics-presets.json physics.wallMode). Per update the script reads
// the mode off the settings seam (window.__se.settings.wallMode), and when it
// CHANGED it re-applies: render.tint (hex) + render.tintMode 'replace' per
// pane child, and the pane material's opacity — colors/opacity/height are DATA
// (physics-presets.json wallVisuals.modes) via wallVisualParams(), which
// THROWS on an unknown mode (fail loud, no in-code defaults).
//
// Renderer access mirrors the intro_flyover paneFadeMaterial precedent: the
// named scene material is resolved through window.__renderer._resolveMaterial
// (panes share the named `glass` materials; all panes get the same mode
// opacity at any moment, so a shared-material write is exact). Missing
// material is fail-noisy (named); missing tint data is fail-LOUD.

import { wallVisualParams } from '../src/gameplay/walls.js';

export default {
  name: 'wall_band',
  label: 'Arena wall band',
  description: 'Drives the arena wall visual on this entity\'s glass pane children: per wallMode (settings), tint + opacity from physics-presets.json wallVisuals DATA.',
  params: {}, // mode lives on the settings row — never duplicated here

  init() {
    return { lastMode: undefined, lastPanes: [] };
  },

  update(state, dt, api, id) {
    const mode = (typeof window !== 'undefined' && window.__se?.settings?.wallMode) || 'NONE';
    if (mode === state.lastMode) return; // cheap per-frame: re-apply only on change
    const v = wallVisualParams(mode); // throws on unknown mode — fail loud

    const paneIds = api.query({ parent: id });
    if (paneIds.length === 0) {
      console.error(`[wall_band] entity ${id} has no pane children — attach glass_pane children (wall visual will not render)`);
      state.lastMode = mode;
      return;
    }

    const mats = new Set();
    for (const pid of paneIds) {
      const rec = api.entity(pid);
      const r = rec?.components?.render;
      if (!r) {
        console.error(`[wall_band] pane ${pid} has no render component — cannot tint`);
        continue;
      }
      r.tint = v.color;
      r.tintMode = 'replace';
      if (r.material) mats.add(r.material);
    }
    const renderer = typeof window !== 'undefined' ? window.__renderer : null;
    for (const name of mats) {
      const mat = renderer && typeof renderer._resolveMaterial === 'function'
        ? renderer._resolveMaterial(name)
        : null;
      if (!mat) {
        console.error(`[wall_band] pane material "${name}" did not resolve to a renderer material — opacity not applied (fail-noisy)`);
        continue;
      }
      mat.transparent = true;
      mat.opacity = Math.max(0, Math.min(1, v.opacity));
    }
    state.lastMode = mode;
  },
};
