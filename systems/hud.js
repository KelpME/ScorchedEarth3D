/**
 * T-UI-5 (plan SE-UI-CAM-1011) — top panel feed + unit re-exports.
 * CANVAS-MIGRATION 2026-10: the top panel is now a REAL canvas+widget tree
 * (assets/archetypes/ui_top_panel.json + scripts/ui_top_panel_bind.js) painted
 * by the ENGINE renderer. This module is NO LONGER a renderer — renderTopPanel
 * is retired (the static index.html panel markup is gone with it). It keeps:
 *   feedTopPanel/getTopPanelFeed — main.js's per-step state feed, which the
 *     bind script reads (main.js mirrors it onto window.__se.topPanelFeed).
 *   computeTopPanel — the pure display-law view model, re-exported from
 *     scripts/ui_top_panel_view.js for the unit pins (import path stable).
 */

import { computeTopPanel as computePanel, DEFAULT_CTX } from '../scripts/ui_top_panel_view.js'

// Unit pins (test/unit/top-panel.test.js) import computeTopPanel + DEFAULT_CTX
// from THIS module — re-export so the pure view-model pins keep their path.
export const computeTopPanel = computePanel
export { DEFAULT_CTX }

// W3-B (plan SE-COMPLETE-1012): the audio system self-installs on
// window.__se (window.__se.audio + the se.audio.play(eventId) seam) the
// moment the boot page loads hud.js — main.js is NOT touched. Node unit
// runs have no window: the install is a no-op there.
if (typeof window !== 'undefined') {
  import('./audio.js').then((m) => m.autoInstall()).catch((e) => console.error('[se/audio] install failed', e));
}

// main.js feeds the main-owned live state (drive, meter, battle, wind) here.
let fed = {}

/** Merge one partial state update from main.js (main computes, bind renders). */
export function feedTopPanel(partial) {
  fed = { ...fed, ...partial }
}

/** SE-EXPANSION-1012 B1 — read the current feed (unit pin: hull exposure). */
export function getTopPanelFeed() { return fed }
