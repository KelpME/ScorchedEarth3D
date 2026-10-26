/**
 * scorched-earth — boot module.
 *
 * Slice 0 of the Scorched Earth rebuild (see SCORCHED-EARTH-ASSET-LIST.md):
 * loads the user-supplied tank GLB through the shared engine import pipeline and
 * places two tanks facing each other on a flat test ground, viewed from a side
 * camera. The destructible terrain sim replaces this ground in the next slice.
 *
 * Boot result → window.__boot; live Game → window.__game; Renderer →
 * window.__renderer; model decode results → window.__modelInfo (a decode failure
 * is loud, never a silent box).
 */
import * as THREE from 'three'
import { createGame, Renderer, MaterialRegistry, importModel } from 'hermesforge-engine'
// TEMP DIAG (idle-0fps): raw frame-timing, NO engine import (the deep import
// breaks the build). Logs step-vs-frame split + entity count so we can NAME
// the growing bucket while it degrades. Remove after the fix.
// X3c: the voxel3d battlefield REPLACES the 2.5D terrain host (see the
// __se block for the shim decision). Old host import is gone.
import { generate as generateVoxel3d, terrainTypeNames } from './voxel3d/generator.js'
import { createVoxel3dHost } from './voxel3d/host.js'
import { columnTop } from './voxel3d/field.js'
import { W, H, Z, V, X_MIN, Z_MIN, cellX, cellZ, cellTopWorldY, FIELD_X_MIN, FIELD_X_MAX, FIELD_Z_MIN, FIELD_Z_MAX, CAGE_X_MIN, CAGE_X_MAX, CAGE_Z_MIN, CAGE_Z_MAX, mapSize, setMapSize, extentsFor, turnBudgetFor } from './voxel3d/constants.js'
import { clampAzimuth, followOrbitPose, panFocus, clampTilt, clampRadius } from './gameplay/cam_rig.js'
// W2 (SE-CINEMATIC-1013 C5): pure shell-tracking camera math — chase/track
// poses + the flight-window gate; params read from data/camera.json below.
import { chasePose, trackPose, trackActive } from './gameplay/shell_cam.js'
import { shellWorldOrigin, shellBearingRad } from './gameplay/aim.js'
import { toEngineDef } from '../scripts/adapter.js'
import aimControl from '../scripts/aim_control.js'
import fxDecay from '../scripts/fx_decay.js'
import fxBlastSphere from '../scripts/fx_blast_sphere.js'
// W2-J (plan SE-COMPLETE-1012): data-driven 3D death sequences (this main.js
// block is the ONLY wiring this leaf touches here).
import fxDathRing from '../scripts/fx_death_ring.js'
import fxDathDebris from '../scripts/fx_death_debris.js'
import { playDeath, tickDeaths } from './gameplay/deaths.js'
// W11 (plan SE-BUG-1014): barrel break destroys the front segment entity and
// only se.barrelBroken was reset at the boundary — the rebuilt tank aimed an
// EMPTY Barrel wrapper (nothing visible moves). Restore from archetype DATA.
import { restoreBarrelSegments } from './gameplay/barrelRestore.js'
import paneDrop from '../scripts/pane_drop.js'
import wallBand from '../scripts/wall_band.js' // arena wall visual on glass pane children (band retired)
// Archetype-driven UI renderers (OBJECT TREES, user hard doctrine 2026-10-11):
// the menu/top-panel CONTENT lives on assets/archetypes/ui_*.json CHILD
// entities (typed text/panel widget components + rect — CANVAS-MIGRATION
// 2026-10); the bind scripts write live values, the engine paints.
import menuBindDef from '../scripts/ui_menu_bind.js'
// WAVE-3 (2026-10-20): the menu row BUTTONS are the ui_menu widget entities —
// each menu_row_<action> interactive panel carries the GENERIC ui_menu_row
// script (its action is the declared param); the handlers this module wires
// into window.__se.menuActions are what the script performs.
import menuRowDef from '../scripts/ui_menu_row.js'
import weaponActionDef from '../scripts/ui_weapon_action.js'
// W2 (SE-CINEMATIC-1013): the intro flyover script def — DATA on the menu
// scene's intro_flyover entity; imported into the createGame scripts map.
import introFlyoverDef from '../scripts/intro_flyover.js'
import titleCanvasDef from '../scripts/title_canvas.js' // W5 (SE-CINEMATIC-1013 C9): intro_title lifecycle gate
// CANVAS-MIGRATION 2026-10: the top panel is a REAL canvas+widget tree —
// the bind script (registered below) writes LIVE values into the widgets.
import panelBindDef from '../scripts/ui_top_panel_bind.js'
import { carveFrontTrench } from './voxel3d/aquarium.js'
import { advanceSeed, pickSpawns } from './gameplay/roundTerrain.js'
import projectiles3dSystem from '../systems/projectiles3d.js'
import turnDirectorSystem from '../systems/turn_director.js'
// COMPUTER OPPONENTS (plan SE-COMPLETE-1012): AI turn driver — plan/act on a
// computer tank's turn through the shared aim+fire seams.
import aiTurnSystem from '../systems/ai_turn.js'
import settle3dSystem from '../systems/settle3d.js'
// W2-Cb — hostile-sky lightning + the damage->maxPower law (plan SE-COMPLETE-1012)
import lightningSystem from '../systems/lightning.js'
import { applyMaxPowerDrain, effectivePower, strikePoint } from './gameplay/lightning.js'
import { planFall, impactParams, tanksStageDone, settleStageSignal, queueKillDeath } from './gameplay/impact.js' // W5: Impact Damage + the tank-fall damage path; W2: settle-stage signals; W3: kill queue append
// SETTLE-PACE-1015 (user directive, option 1): buried tanks — isBuried gate +
// DATA minCoverU (physics-presets .buried), validated at module load (fail
// loud at boot, same precedent as impactParams).
import { isBuried, buriedParams } from './gameplay/buried.js'
// T-UI-4 — per-round skybox system (mechanism-first, style is settings data).
import { createSkybox, resolveStyle } from '../systems/skybox.js'
// W8-D — editor camera visualization seam (window.__se.cameraHelper, opt-in only)
import { createCameraHelperSeam } from '../systems/cameraHelper.js'
import weatherSystem from '../systems/weather.js' // W2-G — clouds/fog/fire/pools (editor-visible system)
// ==== W8-C VOLUMETRIC STORM CLOUDS — BEGIN (plan SE-COMPLETE-1012) =========
import stormCloudsSystem from '../systems/stormClouds.js' // W8-C — raymarch volume (editor-visible system)
// ==== W8-C VOLUMETRIC STORM CLOUDS — END ===================================
import audioSystem from '../systems/audio.js' // W3-B — WebAudio synth registry (data/sound.json recipes)
import { feedTopPanel, getTopPanelFeed } from '../systems/hud.js' // feed seam (panel rendered by the engine canvas)
import createDriveSystem from '../systems/drive.js'
import { openSetup } from './ui/setup.js'
import { playerRosterData, tankPalette } from './ui/config.js'
// T-UI-3 — Start-menu boot hook (src/ui/menu.js: mountMenu({onStart,version})).
import { mountMenu, menuRowActions } from './ui/menu.js'
import { showBattleLoading, hideBattleLoading } from './ui/battle-loading.js'
// S3D — battle state + weapon picker (chosen weapon drives the shot via the
// se.weaponOverride seam projectiles3d already reads; ammo burns per fire).
import { loadData } from './data/load.js'
import { rollWind, rollWindTurn, rollLandscape } from './gameplay/settingsApply.js' // W1-A: live wind; W1-C: Random Land
import { createBattle } from './gameplay/turnState.js'
import { resolveCashAtStart } from './gameplay/economySettings.js'
import { storeTargetPlayer, storeQueue, resumeAllowed } from './gameplay/betweenRounds.js' // W6: between-rounds store flow
// WEAPON-BAR-FOLD 2026-10-20: the DOM strip (src/ui/weaponPicker.js) is
// RETIRED — the bar + full-armory overlay are ui_top_panel widget entities;
// main.js keeps the STATE (window.__se.weaponBar) + INPUT (keyboard below)
// and owns the visuals wiring the picker used to do at mount.
import { filterUselessWeapons, settingsFor, applyBombIcon } from './ui/weaponVisuals.js'
import { ensureTracePathsSystem } from '../systems/tracePaths.js'
// INT — battle loop (damage->score->rounds), store mount + open event,
// round-end scoreboard overlays (all consume S5/S2 modules verbatim).
import { createBattleLoop } from './gameplay/battleLoop.js'
import { assignTeams } from './gameplay/teams.js' // W4-A turn modes + teams
import { makeDirector } from './gameplay/director.js'
// W1-B — round-boundary economy + faithful Free Market (plan SE-COMPLETE-1012)
import { roundBoundary, createMarketState } from './gameplay/economy.js'
import { mountStore } from './ui/store.js'
import { showScoreboard, showRoundEnd } from './ui/scoreboard.js'
import pkg from '../package.json' with { type: 'json' }

// The game's archetype files (assets/archetypes/<id>.json) — the static server
// does not directory-list, so we load the known filenames directly.
const ARCHETYPE_FILES = ['tank.json', 'glass_pane.json', 'terrain.json', 'battlefield_camera.json', 'shell.json', 'ui_menu.json', 'ui_top_panel.json', 'tree.json', 'storm_front.json', 'storm_lightning.json'] // W2-I: tree.json — editor-spawnable voxel tree archetype (spawnArchetype); W8-J: the WEATHER objects (storm front + lightning params) join the registry

window.__THREE = THREE
window.__boot = null
window.__game = null
window.__renderer = null
window.__modelInfo = {}

// S1 boot gate: capture window.__se.skipSetup NOW (page.addInitScript sets it
// before this module runs) because boot() REPLACES window.__se wholesale.
const __seSkipSetup = window.__se?.skipSetup === true

// Model logical-id → manifest src (game-relative). The manifest registers the
// same ids as `model/<id>` entries.
const MODEL_SRC = {
  tank: 'assets/models/tank.glb',
  projectiles: 'assets/models/projectiles.glb', // SE-EXPANSION-1012 A3
}

// The GLB is authored at ~real scale (hull ~2.5 wide, 3.2 long, 1.6 tall) — no
// pack normalization needed; keep it 1:1 so the turret pivot math stays honest.
// Import doctrine: 1:1, ZERO numeric transforms — per-projectile nodes from
// projectiles.glb mount at their authored size (no scaling in engine code);
// the settings scale option multiplies BLAST rWorld (projectiles3d
// SCALE_MULT), not the visual — visual is 1:1 by doctrine.
const MODEL_SCALE = { tank: 1, projectiles: 1 }

async function loadModel(key) {
  const src = MODEL_SRC[key]
  try {
    const resp = await fetch(src)
    if (!resp.ok) throw new Error(`${src} HTTP ${resp.status}`)
    const { group, report } = await importModel(resp, {
      format: 'glb',
      src,
      scale: MODEL_SCALE[key] ?? 1,
      tint: 0x8a8f72, // olive drab for the untextured meshes (player colors come later)
    })
    window.__modelInfo[key] = { ok: true, src, materials: report.materials }
    return group
  } catch (e) {
    window.__modelInfo[key] = { ok: false, src, error: String((e && e.message) || e) }
    return null
  }
}

/** Deep clone that keeps child hierarchy (no skinned meshes in this model). */
function cloneModel(source) {
  const cloneNode = (node) => {
    const c = node.clone(false)
    for (const child of node.children) c.add(cloneNode(child))
    return c
  }
  return cloneNode(source)
}

/** World-surface y of the voxel3d field at (x,z): top solid cell + cell edge.
 *  Out-of-field columns read as the y=0 floor plane (the field AABB walls
 *  live at x=-120..120, z=-30..30; beyond them there is no ground). */
function voxelSurfaceWorld(field, x, z) {
  const cx = Math.min(W - 1, Math.max(0, cellX(x)))
  const cz = Math.min(Z - 1, Math.max(0, cellZ(z)))
  return cellTopWorldY(columnTop(field, cx, cz)) // DEEPEN-1015 R6: one seam for (top+1)*V minus the deep floor offset
}

async function boot() {
  const project = await (await fetch('./project.json')).json()
  const entry = project.scenes.find((s) => s.path === project.entryScene) || project.scenes[0]
  // ?scene= override (the editor's Test (Scene) popup) beats the entry scene.
  const sceneRel = new URLSearchParams(location.search).get('scene') || entry.path
  const scene = await (await fetch('./' + sceneRel)).json()

  // Load every model the game declares BEFORE the first frame so entities with
  // render.modelName resolve immediately.
  const sharedModels = {}
  await Promise.all(
    Object.keys(MODEL_SRC).map(async (key) => {
      const g = await loadModel(key)
      if (g) sharedModels[key] = g
    }),
  )

  const canvas = document.getElementById('game')

  // Data-driven materials: seed a MaterialRegistry from the scene's `materials`
  // map and hand its built-materials resolver to BOTH the renderer and
  // createGame (the editor's viewport pattern) — entities resolve named
  // materials, no white fallback.
  const materialRegistry = new MaterialRegistry()
  for (const [name, def] of Object.entries(scene.materials || {})) {
    try { materialRegistry.register(name, def) } catch (e) { console.warn(`[boot] invalid material "${name}":`, e) }
  }

  // Load the game's archetypes so scene eidolons resolve at runtime (matching
  // the editor, which reads the same assets/archetypes/*.json).
  const archetypes = {}
  for (const f of ARCHETYPE_FILES) {
    try {
      const d = await (await fetch(`./assets/archetypes/${f}`)).json()
      if (d && d.id) archetypes[d.id] = { name: d.name || d.id, components: d.components || {}, children: d.children || [] }
    } catch { /* skip unparsable archetype file */ }
  }

  // Mechanism-first asset model (no game-specific model names in code): every
  // render.model path declared anywhere in the archetype data must be in the
  // renderer's asset registry, or the renderer silently drops those subtrees
  // (the tankV3 class of bug: archetype upgraded its model, MODEL_SRC did not,
  // tanks rendered zero meshes). Collect the full set and load what MODEL_SRC
  // missed; decode failures stay LOUD via __modelInfo[path].
  const archetypeModelPaths = new Set()
  const walkNodes = (nodes) => {
    for (const n of nodes || []) {
      const m = n.components && n.components.render && n.components.render.model
      if (typeof m === 'string') archetypeModelPaths.add(m)
      walkNodes(n.children)
    }
  }
  for (const a of Object.values(archetypes)) walkNodes([a])

  const renderer = new Renderer({ canvas, materials: materialRegistry.materials })
  window.__renderer = renderer
  // W8-I TEST-PERF SEAM (plan SE-COMPLETE-1012, documented, flag-gated — zero
  // cost without the flag): '?se-test-perf=lowres' renders the game ONCE EVERY
  // 5th FRAME. Software-GL test runners draw full-res frames at ~400ms
  // (2.1M tris through SwiftShader) and every CDP input event pays a frame
  // boundary — input-loop specs (camera arcs, wheel zooms, drive keys) blow
  // their 60s budgets at ~0.9s/event, and data-fetch promise delivery starves
  // (setup screens mount empty). Skipping draws does NOT skip the sim: game
  // logic, director phases, camera state and drive budgets all advance per
  // frame; only the PAINT is thinned. Geometry/sim pins are unaffected, and
  // pixel-pinning specs NEVER pass the flag — they keep the full render path.
  if (new URLSearchParams(location.search).get('se-test-perf') === 'lowres') {
    const realRender = renderer.renderer.render.bind(renderer.renderer)
    let renderSkipCount = 0
    renderer.renderer.render = (scene, camera) => {
      if (++renderSkipCount % 5 === 0) return realRender(scene, camera)
      // The camera pose must stay FRESH on skipped frames: specs read
      // renderer.camera.position (pan math, follow radius) and a stale camera
      // silently corrupts those pins. _applyCamera is cheap trig — run it
      // every frame; only the expensive SCENE DRAW is thinned.
      try { renderer._applyCamera(window.__game?.api) } catch { /* pre-boot frame */ }
      return undefined
    }
    console.info('[se/test-perf] lowres seam active (render 1-in-5 + live camera apply) — test-runner render cost only')
  }
  for (const src of archetypeModelPaths) {
    if (Object.values(MODEL_SRC).includes(src)) continue // already loaded + registered
    try {
      const resp = await fetch(src)
      if (!resp.ok) throw new Error(`${src} HTTP ${resp.status}`)
      const { group, report } = await importModel(resp, { format: 'glb', src, scale: 1, tint: 0x8a8f72 })
      renderer.registerModelAsset(src, group)
      window.__modelInfo[src] = { ok: true, src, materials: report.materials }
    } catch (e) {
      window.__modelInfo[src] = { ok: false, src, error: String((e && e.message) || e) }
      console.error(`[boot] archetype-referenced model failed to load: ${src}`)
    }
  }
  // SE daytime sky backdrop (the landscape options arrive with the terrain slice).
  renderer.scene.background = new THREE.Color(0x8fb8dc)

  // MODEL-IMPORT: node-scoped children (render.model + render.node — the
  // hydrated archetype children) resolve their subtree against the renderer's
  // asset registry, which is EMPTY on boot. Register the SHARED decoded model
  // once per asset path (the registry model is never scene-attached; the
  // renderer clones subtrees from it). Canonical path form = the game-relative
  // manifest src, same string the archetype's render.model uses — this mirrors
  // the editor's canonicalization (editor/src/modelAssets.js
  // ensureSceneModelsRegistered strips the games/<game>/ prefix).
  for (const [key, model] of Object.entries(sharedModels)) {
    renderer.registerModelAsset(MODEL_SRC[key], model)
  }

  // Camera handle: the engine camera-rig built-in drives api.camera; we keep
  // the renderer's orbit preset as the backing implementation and let the
  // rig's params (radius/theta/phi/fov) flow through.
  const camHandle = {
    setPreset(name, args) {
      // SE-FIXUP-1012 W3 (C3): shared zoom-out cap on the ENGINE-RIG preset
      // choke — any engine script driving a huge orbit radius lands inside the
      // DATA max. Upper bound only: the follow pose legitimately sits at
      // backDist 5..40, far below the orbit minRadius.
      if (args && Number.isFinite(args.radius) && window.__camZoomMax) args.radius = Math.min(window.__camZoomMax, args.radius)
      if (args && typeof args.fov === 'number') { renderer.camera.fov = args.fov; renderer.camera.updateProjectionMatrix() }
      renderer.setCameraPreset(name, args)
    },
    setFocus(id) { window.__camFocus = id },
    setActive(id) { window.__camActive = id },
  }
  // Daylight-ish lighting so the low-poly tank reads with some shading.
  if (renderer.ambientLight) renderer.ambientLight.intensity = 0.75
  if (renderer.directionalLight) renderer.directionalLight.intensity = 1.6

  const game = createGame({
    scene,
    archetypes,
    camera: camHandle,
    scripts: {
      aim_control: toEngineDef(aimControl),
      fx_decay: toEngineDef(fxDecay),
      fx_blast_sphere: toEngineDef(fxBlastSphere),
      // W2-J: death-sequence fx scripts (ring + ballistic fragments)
      fx_death_ring: toEngineDef(fxDathRing),
      fx_death_debris: toEngineDef(fxDathDebris),
      pane_drop: toEngineDef(paneDrop),
      wall_band: toEngineDef(wallBand),
      // Archetype-driven UI (editor-visible scripts on the ui_* archetypes).
      // CANVAS-MIGRATION 2026-10: the menu canvas's LIVE BINDING script —
      // writes the widget components' fields from the menu feed each step;
      // the engine renderer paints the overlay (no DOM renderer anymore).
      ui_menu_bind: toEngineDef(menuBindDef),
      // WAVE-3 (2026-10-20): the GENERIC menu-row button script — carried by
      // each interactive menu_row_<action> panel widget; a click on the row's
      // engine overlay node dispatches onPointerClick (engine widget
      // interaction seam) and this script performs the declared action.
      // Registered RAW (not toEngineDef): the engine wraps game-script defs
      // natively — including the stateful onPointerClick hook (the adapter
      // flattens update only and would drop the click hook).
      ui_menu_row: menuRowDef,
      // WEAPON-BAR-FOLD (2026-10-20): the GENERIC weapon-bar button script —
      // carried by each interactive weapon-bar widget (slots, page arrows,
      // +N armory affordance, [STORE], armory rows). Registered RAW (same
      // law as ui_menu_row): the engine's native wrap keeps the stateful
      // onPointerClick hook (toEngineDef would drop it).
      ui_weapon_action: weaponActionDef,
      // CANVAS-MIGRATION 2026-10: the panel canvas's LIVE BINDING script —
      // writes the widget components' fields from the state feed each step;
      // the engine renderer paints the overlay (no DOM renderer anymore).
      ui_top_panel_bind: toEngineDef(panelBindDef),
      // W2 (SE-CINEMATIC-1013 C1): the intro flyover is DATA — the menu scene's
      // intro_flyover entity carries the script. The engine wraps the
      // 5-arg descriptor natively (per-entity closure state), so it registers
      // RAW (same shape its W1a stand-in poll used).
      intro_flyover: introFlyoverDef,
      title_canvas: titleCanvasDef,
    },
    systems: { projectiles3d: projectiles3dSystem, turn_director: turnDirectorSystem, ai_turn: aiTurnSystem, drive: createDriveSystem({ game: () => game }), settle3d: settle3dSystem, lightning: lightningSystem, weather: weatherSystem, audio: audioSystem,
      // ==== W8-C VOLUMETRIC STORM CLOUDS — BEGIN (plan SE-COMPLETE-1012) ====
      stormClouds: stormCloudsSystem,
      // ==== W8-C VOLUMETRIC STORM CLOUDS — END ==============================
    },
    // GAME-LOCAL component META — registers the
    // schema so the editor inspector renders real cards for the game's config
    // components (voxelTerrain / stormFront / stormLightning).
    components: [
      {
        // SE-FIXUP-1012 (user 2026-10-13: "i want an object for the 3d voxel
        // terrain"): the 3D voxel field's authored config as a FIRST-CLASS
        // scene object — replaces the fossil 2.5D 'terrain' heightfield entity
        // (its only live fields were seed + blastRadius; the rest are retired
        // 2.5D-era values carried as data so nothing is silently dropped).
        // main.js reads seed + blastRadius from this component (fail-loud when
        // the entity is missing); dims/spacing stay constants-authoritative
        // (src/voxel3d/constants.js W/H/Z/V never scale).
        name: 'voxelTerrain',
        label: 'Voxel terrain (3D battlefield)',
        description: 'The 3D voxel battlefield. The grid itself (map extents, 40cm cells, depth) is fixed — set the map size under Play Options; everything visual or gameplay-tuning about the terrain is here. Defaults come from data/voxel-terrain.json; this scene overrides it.',
        params: {
          seed: { type: 'number', default: 1936, label: 'Seed', help: 'Starting terrain pattern. Every round rollover advances the seed, which is why each round’s hills differ. Same seed = same terrain.' },
          blastRadius: { type: 'number', default: 2, min: 0, max: 10, step: 1, label: 'Blast radius', help: 'Crater size when shells dig in, in cells (1 cell = 0.25 world units). Scales with the weapon’s blast on top of this.' },
          baseHeight: { type: 'number', group: 'Terrain shape', default: 60, min: 0, max: 150, step: 1, label: 'Base height', help: 'Floor height of the terrain, in cell rows (1 row = 0.25 units). Higher = thicker ground cross-section.' },
          rollingAmp: { type: 'number', group: 'Terrain shape', default: 50, min: 0, max: 150, step: 1, label: 'Rolling hills', help: 'Amplitude of the smooth fBm hills layered over the base height.' },
          ridgeAmp: { type: 'number', group: 'Terrain shape', default: 90, min: 0, max: 200, step: 1, label: 'Mountain ridges', help: 'Height of the sharp mountain ridges layered on top of the hills.' },
          ridgePower: { type: 'number', group: 'Terrain shape', default: 3, min: 1, max: 6, step: 0.5, label: 'Ridge sharpness', help: 'How peaked the ridges are: 1 = broad rolling walls, 6 = narrow spiked peaks.' },
          heightMin: { type: 'number', group: 'Terrain shape', default: 8, min: 0, max: 40, step: 1, label: 'Min column height', help: 'No column is filled lower than this — guarantees ground under every position.' },
          grassMax: { type: 'number', group: 'Strata (soil layers)', default: 3, min: 1, max: 6, step: 1, label: 'Grass cap (max)', help: 'Each column gets a grass cap 1..this-many cells thick, randomized per column.' },
          dirtBand: { type: 'number', group: 'Strata (soil layers)', default: 12, min: 0, max: 48, step: 1, label: 'Dirt band', help: 'Thickness of the dirt layer under the grass cap, in cells.' },
          darkBand: { type: 'number', group: 'Strata (soil layers)', default: 24, min: 0, max: 64, step: 1, label: 'Dark earth band', help: 'Thickness of the dark-earth layer under the dirt; rock fills everything below.' },
        },
      },
      {
        // W8-J — WEATHER OBJECT MODEL: the storm front event as an entity.
        // Registered so the editor inspector renders the params (pickers/
        // numbers/colors) on the weather_storm_front scene entity.
        name: 'stormFront',
        label: 'Storm front (weather event)',
        description: 'W8-J: the rolling storm front — fog density/color escalation over the mounted baseline, rise/hold/fall ramp (SIM clock since the W6-scrub retrofit: paused/stepped sim freezes the ramp, seed-deterministic per round), and the AREA span (spanXZ world units centered on the field, covers the terrain around the play area). The VISIBLE FRONT is the storm_front volumetric-cloud REGION entity (scenes/level-01.json) — the T8 storm ramp writes its density/litColor live (billboard params retired with the billboard mount). systems/weather.js consumes these params live.',
        params: {
          style: { type: 'string', options: ['STORMY', 'PLAIN'], default: 'STORMY', label: 'Sky style that storms' },
          riseSeconds: { type: 'number', default: 8.0, label: 'Rise seconds' },
          holdSeconds: { type: 'number', default: 20.0, label: 'Hold seconds' },
          fallSeconds: { type: 'number', default: 12.0, label: 'Fall seconds' },
          densityStorm: { type: 'number', default: 0.045, label: 'Peak FogExp2 density' },
          colorStorm: { type: 'string', default: '', label: 'Peak fog color (hex)' }, // hex defaults live in the archetype JSON (doctrine: none in code),
          chancePerRound: { type: 'number', default: 0.34, label: 'Chance per round (0-1)' },
          startMaxSeconds: { type: 'number', default: 25.0, label: 'Max arrival delay (s)' },
          areaSpanXZ: { type: 'number', default: 520.0, label: 'Area span XZ (world units, centered on field)' },
        },
      },
      {
        // W8-J — WEATHER OBJECT MODEL: lightning vfx params entity.
        // P5 (plans/SETTLE-PACE-1015.md) LIVE-WIRED: systems/lightning.js
        // liveLightningVfx() reads this component PER STRIKE (edited fields
        // win over presets.lightning.vfx) — editor edits apply to the next
        // strike; cadence/logic unchanged.
        name: 'stormLightning',
        label: 'Storm lightning (vfx params)',
        description: 'W8-J: the lightning VFX magnitudes as a weather object (base mirrors presets.lightning.vfx). LIVE-WIRED (P5): bolt/flash geometry is built per strike from these values via systems/lightning.js liveLightningVfx; strike timing/cadence stays in the data file.',
        params: {
          boltColor: { type: 'string', default: '', label: 'Bolt color (hex)' },
          flashColor: { type: 'string', default: '', label: 'Flash color (hex)' },
          boltHeight: { type: 'number', default: 30.0, label: 'Bolt height (world)' },
          boltWidth: { type: 'number', default: 0.12, label: 'Bolt width (world)' },
          life: { type: 'number', default: 0.35, label: 'Bolt life (s)' },
          levels: { type: 'number', default: 5, label: 'Lichtenberg levels' },
          roughness: { type: 'number', default: 0.38, label: 'Jitter roughness' },
          branchChance: { type: 'number', default: 0.18, label: 'Branch chance' },
          branchDecay: { type: 'number', default: 0.55, label: 'Branch decay' },
          segmentMinLen: { type: 'number', default: 0.6, label: 'Min segment length' },
          bias: { type: 'number', default: 0.3, label: 'Target bias' },
          branchWidthFrac: { type: 'number', default: 0.5, label: 'Branch width fraction' },
          maxSegments: { type: 'number', default: 96, label: 'Per-strike segment budget' },
        },
      },
    ],
    onFrame: (api, loop) => renderer.render(api, loop),
    // W6-scrub retrofit: the SIM leaves the rAF bridge — everything that
    // advances game state runs here, once per FIXED step (dt is always
    // fixedDt, the loop's clock), so editor scrub (controller.pause /
    // stepOnce) freezes or advances it deterministically. frame() below keeps
    // only render-side per-frame work. Function decls below hoist, so this
    // closure is safe to build before their textual definitions.
    onStep: (dt) => seSimStep(dt),
  })
  window.__game = game

  // Register one model CLONE per entity that references a modelName (the
  // shared-model lesson: entities render through per-id clones).
  function syncRuntimeModels(api) {
    for (const id of api.query({})) {
      const mn = api.entity(id)?.components?.render?.modelName
      if (!mn || !sharedModels[mn]) continue
      if (!renderer._models || !renderer._models[id]) {
        renderer.registerModel(id, cloneModel(sharedModels[mn]))
      }
    }
  }
  syncRuntimeModels(game.api)

  // ---- voxel3d battlefield + SE bridge state (window.__se) -----------------
  // X3c DECISION (documented in the commit body): the voxel3d field renders
  // ground across the same x-span as the 2.5D host's terrain entity, so the
  // two collide visually — the old ground is REMOVED: terrain-test.json drops
  // 'terrain' from its systems and main.js no longer mounts the 2.5D host.
  // window.__terrain / __se.host become the minimal shim below so
  // turn_director's settling (host.settled()) keeps working; the camera
  // specs' __terrain readiness signal stays truthy without a second ground.
  // SE-FIXUP-1012 (user 2026-10-13): the 3D battlefield config lives on the
  // 'voxel_terrain' scene entity's voxelTerrain component (fail-loud when the
  // entity is missing — the named default keeps boot alive, never silent).
  // The old 2.5D 'terrain' heightfield entity is gone from menu.json.
  const terrainCfg = (() => {
    const ent = game.api.entity('voxel_terrain')
    const cfg = ent?.components?.voxelTerrain
    if (!cfg) {
      console.error('[se/voxel-terrain] scene entity voxel_terrain (voxelTerrain component) missing — seed falls back to the procedural default 1234, blastRadius to 2 (data declares them on the scene object)')
      return { seed: 1234, blastRadius: 2 }
    }
    return cfg
  })()
  const sysParams = (name) => (scene.systems.find((s) => s.name === name) || {}).params || {}
  const terrainSeed = { value: terrainCfg.seed ?? 1234 } // T-G5: mutable — advanced on every round rollover
  // SE-FIXUP-1012 (user: stop hiding tunables): per-scene SHAPE overrides read
  // from the voxelTerrain component's flat params (junk fails loud, missing
  // keys fall to the data defaults in data/voxel-terrain.json). Rides
  // generate() -> field.__seParams so the skirt lattice stays seamless.
  const SHAPE_KEYS = ['baseHeight', 'rollingAmp', 'ridgeAmp', 'ridgePower', 'heightMin', 'grassMax', 'dirtBand', 'darkBand']
  const terrainShape = () => {
    const s = {}
    for (const k of SHAPE_KEYS) {
      const v = terrainCfg[k]
      if (v === undefined) continue
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        console.error(`[se/voxel-terrain] shape param ${k}=${JSON.stringify(v)} is junk — the data default is used (voxel_terrain scene object)`)
        continue
      }
      s[k] = v
    }
    return s
  }
  // W1-C (plan SE-COMPLETE-1012): OG .MTN landscape presets are DATA
  // (data/landscapes.json, parsed from the original earth/*.MTN files — the
  // one-off decoder script that did the extraction has since been retired).
  // Fail-noisy: a missing manifest keeps the procedural
  // generator (preset rows then resolve to NONE with a console error).
  let landscapesDoc = null
  try {
    landscapesDoc = await loadData('landscapes')
  } catch (e) {
    console.error(`[se/landscape] landscapes.json load failed (${String(e)}) — preset picker falls back to NONE`)
  }
  // W5 ARCHITECTURE FLIP (user 2026-10-13): the voxelTerrain component is the
  // SINGLE SOURCE OF TRUTH for the 3D terrain. The landscape knobs
  // (bumpiness/slope/flattenPeaks/mountainPercent/randomLand) live on the
  // component (junk fails loud naming the key, missing keys fall to the data
  // defaults in data/voxel-terrain.json .landscape). The generator consumes
  // params.landscape ONLY — the old settings-reading landscapeParams helper
  // and the localStorage boot snapshot are DELETED (settings rows are
  // write-through controllers onto the component, never a source).
  const LAND_KEYS = ['bumpiness', 'slope', 'mountainPercent']
  const terrainLandscape = () => {
    const l = {}
    for (const k of LAND_KEYS) {
      const v = terrainCfg[k]
      if (v === undefined) continue
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
        console.error(`[se/voxel-terrain] landscape knob ${k}=${JSON.stringify(v)} is junk — the data default is used (data/voxel-terrain.json .landscape)`)
        continue
      }
      l[k] = v
    }
    l.flattenPeaks = terrainCfg.flattenPeaks === true || terrainCfg.flattenPeaks === 'on'
    return l
  }
  // SE-EXPANSION-1012 A1: map size is owned by the voxelTerrain component
  // (mapSize knob). Boot honors terrainCfg.mapSize BEFORE generating the
  // field — extents are data read at generation time. Junk fails noisy.
  try {
    if (terrainCfg.mapSize != null) setMapSize(terrainCfg.mapSize) // throws on junk
    console.info(`[map-size] boot mapSize=${mapSize()} field=${W}x192x${Z} (voxelTerrain component)`)
  } catch (e) {
    console.error(`[map-size] voxelTerrain mapSize rejected (${String(e)}) — default extents kept`)
  }
  const field = generateVoxel3d(terrainSeed.value, { landscape: terrainLandscape(), shape: terrainShape(), terrainType: terrainCfg.terrainType, rockAmount: terrainCfg.rockAmount })
  // T-G4 aquarium: carve the front buffer ring (world z >= CAGE_Z_MAX) to
  // EMPTY BEFORE mounting, so the mesher emits the cut-strata face at the
  // trench wall — the camera looks into the front of an aquarium.
  const carved = carveFrontTrench(field)
  console.info(`[aquarium] carved ${carved.carvedCells} cells (cellZ ${carved.cellZStart}..${carved.cellZEnd}, BOUNDED — L3b) from the front buffer ring — cut strata face (T-G4)`)
  const v3d = createVoxel3dHost(renderer.scene) // foreign-children strategy, same as the old host
  v3d.mount(field)
  // Ground EVERY tank on its voxel column once at boot. The scene-authored y is
  // stale by construction (it predates the voxel field; the seed decides the
  // surface). The drive system re-grounds only the ACTIVE turn's tank, so
  // without this the idle tank hovers/sinks until its first turn. Fail-noisy:
  // a tank outside the field x/z span gets the clamped edge column and a warn.
  const groundTanksOn = (f) => { // T-G5: shared by boot AND round-reseed respawn
    for (const id of game.api.query({})) {
      if (!/^tank\d+$/.test(id)) continue
      const tr = game.api.entity(id).components?.transform
      if (!tr) continue
      const out = tr.x < FIELD_X_MIN || tr.x > FIELD_X_MAX || (tr.z ?? 0) < FIELD_Z_MIN || (tr.z ?? 0) > FIELD_Z_MAX
      if (out) console.warn(`[boot] ${id} spawn (${tr.x},${tr.z}) is outside the voxel field span — clamped to edge column`)
      tr.y = voxelSurfaceWorld(f, tr.x ?? 0, tr.z ?? 0)
    }
  }
  groundTanksOn(field)
  // SE-EXPANSION-1012 A1 — pane placement is EXTENT-DERIVED, never scene
  // literals: menu.json's authored pane overrides are recomputed here from the
  // live CAGE_* walls at every boot and every map-size change (doctrine: size
  // is data; the aquarium panes ride the scaled cage).
  const placePanesFromExtents = () => {
    const spanX = CAGE_X_MAX - CAGE_X_MIN
    const spanZ = CAGE_Z_MAX - CAGE_Z_MIN
    const cageMidZ = (CAGE_Z_MIN + CAGE_Z_MAX) / 2 // cage is z-ASYMMETRIC (front-anchored, back wall at FIELD_Z_MIN + 10f) — never assume mid 0
    // W5 (SE-CINEMATIC-1013 C10): the pane HEIGHT + docked center-Y are the
    // scene's authored data (menu.json pane transforms) — the extents pass
    // re-derives only the WALL PLACEMENT + span; the authored y/scale-y ride
    // through so the panes can tower past the frustum (data, not code).
    const spec = {}
    for (const [id, base] of Object.entries({
      pane_left:  { x: -(CAGE_X_MAX + 0.5), z: cageMidZ, scale: [0.1, spanZ] },
      pane_right: { x: CAGE_X_MAX + 0.5, z: cageMidZ, scale: [0.1, spanZ] },
      pane_back:  { x: 0, z: CAGE_Z_MIN - 0.5, scale: [spanX + 1, 0.1] },
      pane_front: { x: 0, z: CAGE_Z_MAX + 0.5, scale: [spanX, 0.1] },
    })) {
      const rec = game.api.entity(id)
      if (!rec) continue // scenes without this pane skip silently (entity absent)
      const tr = rec.components?.transform
      const sc = tr?.scale
      const h = sc && (Array.isArray(sc) ? sc[1] : sc.y)
      spec[id] = { ...base, y: (h && tr.y) || 24, h: h || 48 }
    }
    for (const [id, s] of Object.entries(spec)) {
      const tr = game.api.entity(id)?.components?.transform
      if (!tr) {
        // fail-noisy anchor law: a pane entity present in the scene WITHOUT a
        // transform anchor names the entity and is left authored (never a
        // silent skip that hides a half-enclosed cage).
        console.error(`[panes] ${id} exists in the scene but has no transform anchor — pane NOT placed from the extents (cage may be unenclosed)`)
        continue
      }
      tr.x = s.x; tr.y = s.y; tr.z = s.z
      const sc = tr.scale
      if (Array.isArray(sc)) { sc[0] = s.scale[0]; sc[1] = s.h; sc[2] = s.scale[1] }
      else if (sc && typeof sc === 'object') { sc.x = s.scale[0]; sc.y = s.h; sc.z = s.scale[1] }
      const script = (game.api.entity(id)?.components?.scripts || []).find((x) => x && x.name === 'pane_drop')
      if (script?.params) script.params.restY = s.y // pane height never scales (H authored)
    }
  }
  placePanesFromExtents()
  window.__se = {
    host: {
      // T-G5: reads the LIVE window.__se.field so a round reseed (which swaps
      // se.field) is seen by every surface() consumer immediately.
      surface: (x, z) => voxelSurfaceWorld(window.__se.field, x, z),
      // SETTLE: the real gate now — true only when the settle3d system reports
      // no active slump (and no pending work), so the director genuinely waits.
      // Pre-first-frame (settling undefined) reads settled, never stuck.
      settled: () => !window.__se.settling?.active,
      step() {},
    },
    terrainCfg,
    terrainSeed, // T-G5: mutable { value } — the live terrain seed, advanced per round
    // SE-EXPANSION-1012 A3: projectiles.glb loaded ONCE (MODEL_SRC above) and
    // registered under its asset path; the runtime node seam carries the
    // spawnable TOP-LEVEL node names (read from the loaded scene — name-based
    // selection only). The embedded Hull tank subtree (a leftover TOP-LEVEL
    // Blender scene node here) is REMOVED from the spawnable set — it and its
    // descendants are never projectile candidates.
    projectileModelSrc: MODEL_SRC.projectiles,
    projectileNodes: (() => {
      const g = sharedModels.projectiles
      if (!g) return []
      // importModel wraps the decoded glb in a single 'Scene' group — the
      // glTF's own top-level nodes are its children.
      const tops = g.children.length === 1 && g.children[0].children?.length
        ? g.children[0].children : g.children
      const banned = new Set()
      const ban = (obj) => { banned.add(obj.name); (obj.children || []).forEach(ban) }
      for (const c of tops) if (/Hull/i.test(c.name)) ban(c)
      return tops.map((c) => c.name).filter((n) => n && !banned.has(n))
    })(),
    gravity: sysParams('projectiles3d').gravity ?? 9.8,
    wind: { x: 0, z: 0 }, // horizontal accel u/s^2 (manual wind maps in S-later)
    directorParams: sysParams('turn_director'),
    director: null,
    pendingShot: null,
    field,
    v3d,
    // SE-EXPANSION-1012 A1 seams: live size state + the applySettings-backed
    // live-apply path (specs and the settings UI both land here).
    mapSize: () => mapSize(),
    extents: () => ({ mapSize: mapSize(), W, H, Z, V, X_MIN, Z_MIN, FIELD_X_MIN, FIELD_X_MAX, FIELD_Z_MIN, FIELD_Z_MAX, CAGE_X_MIN, CAGE_X_MAX, CAGE_Z_MIN, CAGE_Z_MAX }),
    lastRegenMs: 0,
  }
  window.__terrain = window.__se.host // shim alias — camera specs gate readiness on it
  // W8-I (plan SE-COMPLETE-1012): windCfg defaults must exist BEFORE the first
  // reseedRound. The W8-E random battle-seed made the menu New-Battle path
  // reseedRound(config.seed) BEFORE startBattle's async data load had set
  // windCfg — rollWind failed loud ("maxWind missing") on EVERY setup-flow
  // boot. Defaults land here, from the same DATA source; startBattle's
  // if (!se.windCfg) guard keeps honoring any earlier applySettings.
  let TANK_TINT_RE = null // data-driven player-color node matcher (data/tank-colors.json, built at boot)
  try {
    const ppBoot = await loadData('physics-presets')
    // 2026-10-13: the player-color node list (data/tank-colors.json) — which
    // tank model nodes receive the player color. Fail-loud on junk; consumed
    // by computeTintTargets/applyPlayerColors below.
    const tankColors = await loadData('tank-colors')
    if (!Array.isArray(tankColors.tintNodes) || !tankColors.tintNodes.length || tankColors.tintNodes.some((n) => typeof n !== 'string' || !n.trim())) {
      throw new Error('tintNodes must be a non-empty array of node-name strings')
    }
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    TANK_TINT_RE = new RegExp(`_(${tankColors.tintNodes.map((n) => esc(n.trim())).join('|')})$`)
    window.__se.windCfg = {
      maxWind: ppBoot.landscape.maxWind.default,
      changingWind: ppBoot.landscape.changingWind.default === 'on',
      deltaRange: ppBoot.landscape.changingWind.deltaRange,
    }
  } catch (e) {
    console.error(`[se/battle] boot windCfg init failed (${String(e)}) — startBattle retries from DATA`)
  }
  // W2-Cb spec seams: strike log + deterministic probes (the system object is
  // the same def the engine dispatches, so `this` methods behave identically).
  window.__se.lightning = {
    strikes: [],
    rollTurn: (turnIndex) => lightningSystem.resolveTurn(window.__se, turnIndex),
    forceStrike: (tankId) => lightningSystem.forceStrike(game.api, window.__se, tankId),
    detachBarrel: (tankId) => lightningSystem.detachBarrel(game.api, window.__se, tankId),
  }
  // ---- W8-D (plan SE-COMPLETE-1012): editor camera visualization -------------
  // THREE.CameraHelper seam for camera entities — EDITOR TOOLING ONLY. The
  // HermesForge editor renders the selection outline engine-side (engine/src/
  // render/renderer.js) but exposes no selection-helper hook a game repo can
  // reach, so this game-side seam is the mount: enable() builds the helper for
  // a camera (default: the live renderer camera the battlefield rig drives)
  // and parents it into the renderer scene, disable() removes + disposes it.
  // HARD DOCTRINE: boot NEVER calls enable() — plain game boot has NO
  // CameraHelper in the scene graph (pinned in test/camera-visualizer.spec.js).
  // helper.update() rides the per-frame loop (see updateCameraHelper in
  // frame()) while enabled — never a boot behavior.
  window.__se.cameraHelper = createCameraHelperSeam({
    THREE,
    scene: renderer.scene,
    getCamera: () => renderer.camera,
  })
  let camhLastFov = renderer.camera ? renderer.camera.fov : null
  function updateCameraHelper() {
    if (!window.__se.cameraHelper.enabled) return
    const cam = renderer.camera
    if (cam && cam.fov !== camhLastFov) { cam.updateProjectionMatrix(); camhLastFov = cam.fov }
    window.__se.cameraHelper.handle?.update() // three docs: re-sync after projection change
  }

  window.__controller = game.controller
  // WEAPON-BAR-FOLD: the weapon bar + full-armory overlay ship CLOSED — the
  // bind script re-opens the bar when a battle mounts (feed-driven), but the
  // FIRST painted frame must not flash them open before the first sim step.
  // The entities are scene content (ui_top_panel archetype instance).
  for (const gid of ['ui_top_panel_weapon_group', 'ui_top_panel_armory_group']) {
    const rec = game.api.entity(gid)
    if (!rec) { console.error(`[se/weaponBar] layout group "${gid}" missing from the scene — cannot close the weapon bar at boot`); continue }
    const wr = rec.components.render || (rec.components.render = { visible: true })
    wr.visible = false
  }
  // W6-scrub: the run reset is the controller's slot (one mechanism for the
  // editor scrub toolbar AND window.__controller.reset()).
  game.controller.onRunReset(seRunReset) // hoisted fn below (defined after reseedRound)

  // ---- Canvas UI boot seeding (user hard doctrine, 2026-10-11) --------------
  // Scene content entities (ui_menu / ui_top_panel archetypes) are TREES: the
  // typed WIDGET CHILD entities (text/panel + rect) carry ALL content; the
  // root script is the live binder. Boot seeds the seams from the archetype
  // file's children (merged with the scene entity's per-child overrides, the
  // same merge the engine's hydration applies) — the registered bind scripts
  // keep the widgets live afterward every fixed step.
  const sceneArchEnt = (archId) => (scene.entities || []).find((e) => e && e.archetypeId === archId)
  const rootScriptParams = (archId, scriptName) => {
    const ent = sceneArchEnt(archId)
    const archP = ((archetypes[archId]?.components?.scripts || []).find((s) => s && s.name === scriptName) || {}).params || {}
    const entComps = ent?.overrides?.components || ent?.components || {}
    const ovP = ((entComps.scripts || []).find((s) => s && s.name === scriptName) || {}).params || {}
    return { ent, params: { ...archP, ...ovP } }
  }
  // Per-instance child overrides (overrides.children[childName].components —
  // widget components merge shallowly per component, same as the engine).
  const applyChildOverrides = (children, ovMap) => !(ovMap && typeof ovMap === 'object') ? children : children.map((c) => {
    const ov = ovMap[c.name]
    if (!ov || typeof ov !== 'object') return c
    const base = c.components || {}
    const ovC = ov.components || {}
    const merged = { ...c, components: { ...base } }
    for (const [k, v] of Object.entries(ovC)) {
      merged.components[k] = (typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k])
        ? { ...base[k], ...v } : v
    }
    return merged
  })
  const menuRoot = rootScriptParams('ui_menu', 'ui_menu_bind')
  const panelRoot = rootScriptParams('ui_top_panel', 'ui_top_panel_bind')
  // CANVAS-MIGRATION 2026-10: the panel's children are REAL widget entities
  // (text/panel components). Their per-instance overrides merge the same way.
  const panelChildren = applyChildOverrides(archetypes.ui_top_panel?.children || [], panelRoot.ent?.overrides?.children)
  // WAVE-3 (2026-10-20): the menu's row panels are INTERACTIVE widget entities
  // carrying the ui_menu_row script — no hit-layer row derivation anymore.
  // The bind script's LIVE feed: version comes from package.json, open /
  // players / rounds are written by src/ui/menu.js (open()/close()/START).
  window.__se.menuFeed = { open: false, version: `v${pkg.version}`, players: 0, rounds: 0 }
  // ---- WEAPON BAR (WEAPON-BAR-FOLD 2026-10-20) -------------------------------
  // The bottom weapon bar + FULL ARMORY overlay are REAL widget entities of
  // the ui_top_panel canvas (weapon_group anchored bottom / armory_group
  // anchored center) — the DOM strip (src/ui/weaponPicker.js) is RETIRED.
  // main.js owns the STATE (per-player page, overlay, pick actions) and the
  // KEYBOARD (input, not rendering — 1-9 / ',' / '.' / 'I' / overlay nav stay
  // here, below); the bind script renders per step from the feed
  // (window.__se.topPanelFeed.weaponBar). Clicks dispatch through the generic
  // ui_weapon_action widget script -> window.__se.weaponActions. Page size is
  // the archetype's weaponPageSize ROOT param (content is archetype data).
  const weaponPageSize = Number.isFinite(panelRoot.params.weaponPageSize)
    ? panelRoot.params.weaponPageSize : 9
  const weaponBar = {
    battle: null,
    pageByPlayer: {}, // per-player page state (player index -> 0-based page)
    lastPlayer: null, // turn-flip detection: recenters the page
    lastSelected: null, // off-page selection detection (top-panel selector)
    overlayOpen: false,
    overlaySel: 0,

    mount(battle) {
      weaponBar.battle = battle
      weaponBar.closeArmory()
      weaponBar.pageByPlayer = {}
      weaponBar.lastPlayer = null
      weaponBar.lastSelected = null
      // W2-E runtime wiring (was the retired picker's mount): register the
      // trace_paths system on the live game + apply the bombIcon appearance.
      // Fail-noisy, never fatal. The #top-weapon slot is RETIRED (canvas
      // migration) — the bombIcon spec only applies while that slot exists.
      try {
        ensureTracePathsSystem(window.__game, () => settingsFor(window))
        if (document.getElementById('top-weapon')) {
          applyBombIcon(settingsFor(window).bombIcon ?? 'BIG')
        } else if (typeof console !== 'undefined') {
          console.info('[se/weaponBar] #top-weapon slot retired — bombIcon spec stored, no DOM icon applied')
        }
      } catch (e) {
        console.error(`[se/weaponBar] W2-E visuals wiring failed: ${e.message}`)
      }
    },

    /** Owned (qty>0) weapon records for player i, in data/weapons.json order. */
    owned(i) {
      const battle = weaponBar.battle
      const player = battle && battle.players[i]
      if (!player) return []
      return battle.weaponCatalog.filter((w) => player.inventory.weapons[w.id] > 0)
    },

    /** The owned list the bar currently shows (uselessItems-aware). */
    currentOwned() {
      const battle = weaponBar.battle
      if (!battle) return []
      const i = battle.current
      const settings = settingsFor(window)
      const uselessOn = settings.uselessItems === 'on'
      const armsLevel = Number.isFinite(battle.armsLevel) ? battle.armsLevel
        : Number.isFinite(settings.armsLevel) ? settings.armsLevel : 4
      const ownedAll = weaponBar.owned(i)
      const owned = uselessOn ? ownedAll : filterUselessWeapons(ownedAll, (w) => (w.armsLevel ?? 0) > armsLevel, 'off')
      if (!uselessOn && ownedAll.length > 0 && owned.length === 0) {
        console.error('[se/weaponBar] uselessItems filter hid EVERY owned weapon (arms-level gating) — showing all (fail-noisy, never a blank bar)')
      }
      return (!uselessOn && owned.length === 0) ? ownedAll : owned
    },

    flipPage(dir) {
      const battle = weaponBar.battle
      if (!battle) return
      const pages = Math.max(1, Math.ceil(weaponBar.currentOwned().length / weaponPageSize))
      const cur = weaponBar.pageByPlayer[battle.current] ?? 0
      weaponBar.pageByPlayer[battle.current] = (cur + dir + pages) % pages // wrap-around
    },

    openArmory() {
      const battle = weaponBar.battle
      if (!battle) return
      const owned = weaponBar.currentOwned()
      const selIdx = owned.findIndex((w) => w.id === battle.selectedWeapon[battle.current])
      weaponBar.overlaySel = selIdx >= 0 ? selIdx : (weaponBar.pageByPlayer[battle.current] ?? 0) * weaponPageSize
      weaponBar.overlayOpen = true
    },

    closeArmory() {
      weaponBar.overlayOpen = false
      weaponBar.overlaySel = 0
    },

    moveOverlay(dir) {
      const n = weaponBar.currentOwned().length
      if (n === 0) return
      weaponBar.overlaySel = (weaponBar.overlaySel + dir + n) % n // wrap-around
    },

    pick(weaponId) {
      const battle = weaponBar.battle
      if (!battle) return
      battle.chooseWeapon(battle.current, weaponId) // reason lands in lastChoose -> the feed
    },

    /**
     * Per-step feed payload: runs the recentering law (page RESETS to the
     * selected weapon's page on a turn flip / when the selection moves
     * off-page — manual paging must never snap back while browsing), then
     * returns the raw bar data for scripts/ui_top_panel_view.js's pure
     * computeWeaponBar. Mutating + pure-split mirrors the retired picker.
     */
    view() {
      const battle = weaponBar.battle
      if (!battle) return { mounted: false }
      const player = battle.players[battle.current]
      if (!player) {
        console.error(`[se/weaponBar] battle.current ${battle.current} has no player — bar not updated`)
        return { mounted: false }
      }
      const ownedShown = weaponBar.currentOwned()
      const selId = battle.selectedWeapon[battle.current]
      const selIdx = ownedShown.findIndex((w) => w.id === selId)
      const size = weaponPageSize
      const pages = Math.max(1, Math.ceil(ownedShown.length / size))
      let page = weaponBar.pageByPlayer[battle.current] ?? 0
      const offPage = selIdx >= 0 && (selIdx < page * size || selIdx >= (page + 1) * size)
      const selChanged = weaponBar.lastSelected !== null && weaponBar.lastSelected !== selId
      if (weaponBar.lastPlayer !== battle.current || (selChanged && offPage)) {
        page = selIdx >= 0 ? Math.floor(selIdx / size) : Math.min(page, pages - 1)
        weaponBar.pageByPlayer[battle.current] = page
      }
      if (page >= pages) { page = pages - 1; weaponBar.pageByPlayer[battle.current] = page }
      weaponBar.lastPlayer = battle.current
      weaponBar.lastSelected = selId
      const paged = ownedShown.length > size
      const slots = ownedShown.slice(page * size, (page + 1) * size).map((w, i) => ({
        id: w.id, name: w.name, qty: player.inventory.weapons[w.id],
        selected: selId === w.id, keyIndex: i + 1,
      }))
      while (slots.length < size) slots.push(null)
      return {
        mounted: true,
        playerName: player.name,
        page, pages, paged,
        slots,
        ownedCount: ownedShown.length,
        overlayOpen: weaponBar.overlayOpen && ownedShown.length > size,
        overlaySel: weaponBar.overlaySel,
        overlayRows: weaponBar.overlayOpen && ownedShown.length > size
          ? ownedShown.map((w) => ({ id: w.id, name: w.name, qty: player.inventory.weapons[w.id], selected: selId === w.id }))
          : [],
        lastChoose: battle.lastChoose ?? null,
        shopLocked: window.__se.shopLocked === true,
      }
    },
  }
  window.__se.weaponBar = weaponBar // state seam (specs + the keyboard handler)
  // The generic ui_weapon_action widget script dispatches here (WAVE-3 seam).
  // FAIL-NOISY handlers: an empty slot / missing row names why nothing picked.
  window.__se.weaponActions = {
    page_prev: () => weaponBar.flipPage(-1),
    page_next: () => weaponBar.flipPage(1),
    armory_open: () => weaponBar.openArmory(),
    armory_close: () => weaponBar.closeArmory(),
    store: () => window.dispatchEvent(new CustomEvent('se-open-store')),
    quick_pick: ({ slot } = {}) => {
      const v = weaponBar.view()
      const s = v.slots[(slot | 0) - 1]
      if (s) weaponBar.pick(s.id)
      else console.error(`[se/weaponBar] quick_pick slot ${slot} is empty on page ${(v.page ?? 0) + 1} — nothing to pick (fail-noisy)`)
    },
    armory_pick: ({ row } = {}) => {
      const r = weaponBar.view().overlayRows[(row | 0) - 1]
      if (r) { weaponBar.closeArmory(); weaponBar.pick(r.id) }
      else console.error(`[se/weaponBar] armory_pick row ${row} has no weapon — nothing to pick (fail-noisy)`)
    },
  }
  window.__se.topPanelRootParams = panelRoot.params // the bind script's live params (spec seam)

  // ---- WEAPON-BAR KEYBOARD (INPUT — stays in main.js, WEAPON-BAR-FOLD) -------
  // 1-9 quick-pick the CURRENT page (out-of-range digit shows WHY, never
  // silent), ','/'.' flip pages (wrap-around), 'I' toggles the full armory
  // overlay; while the overlay is up it owns arrows (move) / Enter (pick +
  // close) / Escape (close). SE-UI-CAM-1011 stands: NO arrow weapon cycling —
  // arrows are camera-only. Rendering is the bind script's; this is input.
  window.addEventListener('keydown', (e) => {
    const battle = weaponBar.battle
    if (!battle) return // no bar mounted (menu/setup) — nothing owns these keys
    if (window.__se?.battleReady && !window.__se.battleReady()) return // setup overlay owns input
    if (window.__menu?.isOpen()) return // T-UI-3 menu gate
    const k = e.key || ''
    const owned = weaponBar.currentOwned()
    const size = weaponPageSize
    if (weaponBar.overlayOpen && owned.length > size) {
      // Overlay is modal: arrows navigate, Enter picks + closes, Escape closes.
      if (k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); weaponBar.moveOverlay(-1); return }
      if (k === 'ArrowDown' || k === 'ArrowRight') { e.preventDefault(); weaponBar.moveOverlay(1); return }
      if (k === 'Enter') {
        e.preventDefault()
        const w = owned[weaponBar.overlaySel]
        if (w) { weaponBar.closeArmory(); weaponBar.pick(w.id) }
        return
      }
      if (k === 'Escape') { e.preventDefault(); weaponBar.closeArmory(); return }
    }
    if (k === 'i' || k === 'I') {
      if (owned.length > size) {
        e.preventDefault()
        if (weaponBar.overlayOpen) weaponBar.closeArmory()
        else weaponBar.openArmory()
      }
      return
    }
    if (k === ',') { e.preventDefault(); weaponBar.flipPage(-1); return }
    if (k === '.') { e.preventDefault(); weaponBar.flipPage(1); return }
    if (k >= '1' && k <= '9') {
      // Digits quick-pick the CURRENT PAGE (page 0 when unpaged — unchanged).
      const page = weaponBar.pageByPlayer[battle.current] ?? 0
      const w = owned[page * size + Number(k) - 1]
      if (w) { e.preventDefault(); weaponBar.pick(w.id) }
      else {
        // Out-of-range digit: show WHY nothing happened (never silent).
        battle.lastChoose = { ok: false, reason: 'not_owned', weaponId: `key ${k}` }
      }
    }
  })


  // ---- SKY (plan SE-UI-CAM-1011 T-UI-4) --------------------------------------
  // Per-round skybox: the mechanism lives in systems/skybox.js (style is DATA —
  // 'gradient' | 'solid'), the style comes from the 'sky' settings value, and
  // the per-round palette is keyed by the ROUND seed from the existing reseed
  // path (terrainSeed — no second RNG forked). Boot mounts once (below);
  // reseedRound() force-remounts every round — dispose() kills the instance's
  // own geometry+material, so remounting the old sky is never safe (same
  // doctrine as the voxel host). Any writer of se.settings funnels through the
  // accessor installed here: applySettings' final step REPLACES se.settings
  // wholesale, so an applied 'sky' style switch takes effect immediately
  // without the settings UI knowing this system exists. State handle for
  // specs: window.__se.sky { style, seed, variation, created, disposed, object3d }.
  let skyHandle = null
  let skySettings = window.__se.settings // undefined until the first settings apply
  const skyCounters = { created: 0, disposed: 0 }
  function mountSky(reason, { force = false } = {}) {
    const resolved = resolveStyle(skySettings?.sky)
    const changed = !skyHandle || skyHandle.style !== resolved.style
    if (resolved.note && (force || changed)) console.info(`[sky] ${resolved.note} (${reason})`) // never a silent fallback
    if (!force && !changed) return // same style already mounted — nothing to do
    if (skyHandle) {
      renderer.scene.remove(skyHandle.object3d)
      skyHandle.dispose() // kills THIS instance's geometry+material, idempotent
      skyCounters.disposed++
    }
    skyHandle = createSkybox(THREE, { style: resolved.style, seed: terrainSeed.value })
    skyCounters.created++
    renderer.scene.add(skyHandle.object3d) // renderOrder -1000 + depthWrite=false: paints first, overpainted by all
    window.__se.sky = {
      style: skyHandle.style,
      seed: skyHandle.seed,
      variation: skyHandle.variation,
      created: skyCounters.created,
      disposed: skyCounters.disposed,
      object3d: skyHandle.object3d,
    }
  }
  // SE-COVERAGE-1015: the sky sphere is RECENTERED on the camera's xz every
  // frame (presentation-side: idempotent reader of the live render camera, no
  // sim mutation, scrub-safe). y stays 0 so the horizon gradient band stays on
  // the world ground plane. A fixed origin-pinned sphere escapes the reachable
  // camera volume: FIELD_* live bindings scale x2.5 (medium) / x5 (large), so
  // the worst-case camera distance from the origin is
  // hypot(FIELD_X_MAX, FIELD_Z_MIN) + zoom.maxRadius = 808.8u (medium) /
  // 1450.8u (large) — both beyond the 800u sphere (probed, test/
  // skybox-coverage.spec.js pins the containment). Recentring makes the
  // camera's horizontal offset from the sky center exactly 0 at EVERY
  // mapSize; the vertical reach (focus y <= H*V + radius*sin(TILT_MAX)
  // ~= 214u) stays far inside the 800u radius and the 1000u camera far.
  function recenterSky() {
    if (!skyHandle || skyHandle.disposed) return
    const cam = renderer.camera
    if (!cam) return
    skyHandle.object3d.position.set(cam.position.x, 0, cam.position.z)
  }

  Object.defineProperty(window.__se, 'settings', {
    configurable: true, // a later leaf may re-own this accessor
    get() { return skySettings },
    set(v) {
      skySettings = v
      mountSky('settings-apply') // 'sky' setting applies on write
    },
  })
  mountSky('boot', { force: true }) // boot mount — missing setting names its 'gradient' fallback in console

  // ==== W2-B ARENA WALLS — RETIRED ====
  // The wall visual is now a scene entity tree: `arena_wall` (script wall_band)
  // + 4 glass_pane CHILDREN, authored in scenes/menu.json and
  // scenes/level-01.json. wallMode (settings) drives it; no band mount, no
  // walls debug seam — the editor hierarchy shows the panes.


  // ---- Aim surface (D7): lazily ensure aim components + input --------------
  // SE-EXPANSION-1012 A2: POWER is a stored value — R = up, F = down, 0.01
  // internal per keydown (keyboard auto-repeat gives the held-press ramp),
  // clamp [0,1]. The DEC-J charge/sweep meter is REMOVED; Space = fire only.
  function ensureAim(id) {
    const rec = game.api.entity(id)
    if (!rec) return null
    if (!rec.components.aim) rec.components.aim = { angleDeg: 45, power: 0.55, fire: false }
    return rec.components.aim
  }
  function activeTurn() {
    const anchor = game.api.entity('camera_anchor')
    return anchor?.components?.director?.turn || 'tank1'
  }
  // SE-NPLAYER-1012: HUD name fallback is DATA-driven — tankN -> the DATA
  // default-name list by index (mod length). No per-player literals.
  let fallbackNames = null // loaded in startBattle (play-options.json .players)
  let fallbackNamesWarned = false
  function fallbackPlayerName(turnId) {
    const m = /^tank(\d+)$/.exec(turnId || '')
    const i = m ? Number(m[1]) - 1 : 0
    if (fallbackNames?.length) return fallbackNames[i % fallbackNames.length]
    // Pre-battle (default names ride in with the battle's data load) this is a
    // normal transient — silent. A battle RUNNING without the name list means
    // the data failed to load: fail-noisy ONCE.
    if (window.__se?.battle && !fallbackNamesWarned) {
      fallbackNamesWarned = true
      console.error('[se/hud] battle running but play-options default-name list never loaded — HUD name fallback degraded')
    }
    return `PLAYER ${i + 1}` // last-resort only: data failed to load, named loudly above
  }
  function activeAim() { return ensureAim(activeTurn()) }

  // Shared fire path (ShellSpawn doctrine, aim.js L53: "both fire paths MUST
  // go through this"): the SPACE keydown AND window.__aim.requestFire() both
  // land here — ONE ShellSpawn/Barrel origin derivation, ONE director
  // requestFire, ONE ammo burn. (FIX: the old __aim.requestFire() only set
  // aim.fire=true, which nothing consumed since the shot moved to the
  // director seam — the fire-projectile.spec path was dead at HEAD.)
  function fireActiveTurn(v) {
    const turn = activeTurn()
    const t = game.api.entity(turn)?.components?.transform
    // Lazy-create the director exactly like systems/drive.js + turn_director.js
    // do: __aim.requestFire() can fire BEFORE the first system update (specs
    // stepOnce after requestFire), so the director may not exist yet.
    if (!window.__se.director) {
      window.__se.director = makeDirector({ settleTimeout: window.__se.directorParams?.settleTimeout ?? 600 })
    }
    if (!t) return false
    const a = activeAim()
    // ShellSpawn doctrine (tankV5): BOTH fire paths share ONE derivation
    // (aim.js shellWorldOrigin/shellBearingRad) — the shot leaves the
    // model's own ShellSpawn empty (riding the barrel's live elevation),
    // on the user-verified bearing. Mechanism-first lookup; missing
    // ShellSpawn → console.error + legacy tank+1.4 origin (fail-noisy).
    const prefix = `${turn}_`;
    const ids = game.api.query({});
    const barrelId = ids.filter((id) => id.startsWith(prefix) && id.endsWith('_Barrel')).sort((a, b) => a.length - b.length)[0] ?? null;
    const spawnId = ids.filter((id) => id.startsWith(prefix) && id.endsWith('_ShellSpawn')).sort((a, b) => a.length - b.length)[0] ?? null;
    const brec = barrelId ? game.api.entity(barrelId) : null;
    const srec = spawnId ? game.api.entity(spawnId) : null;
    let origin = null;
    if (brec?.components?.transform && srec?.components?.transform) {
      origin = shellWorldOrigin(t, brec.components.transform, srec.components.transform);
    } else {
      console.error(`[fire] ${turn}: no ShellSpawn/Barrel node — shell spawns from legacy tank+1.4 origin`);
    }
    const accepted = window.__se.director.requestFire(turn, {
      tank: turn, x: origin ? origin.x : t.x, y: origin ? origin.y : t.y + 1.4, z: origin ? origin.z : (t.z ?? 0),
      angleDeg: a?.angleDeg ?? 45,
      // W2-Cb: the fire path carries the EFFECTIVE power —
      // min(aim.power, maxPower) (damage->maxPower law; undamaged = full).
      power: effectivePower(v, window.__se.battle?.players?.find((p) => p.id === turn)?.maxPower),
      bearingRad: shellBearingRad(window.__drive.get().bearingDeg * Math.PI / 180),
    })
    // S3D: the director accepted the shot -> burn one round of the
    // chosen weapon. not-ok AFTER acceptance is a bug (the picker only
    // offers owned weapons), so it logs loud and the shot still flies.
    if (accepted && window.__se.battle) {
      const bt = window.__se.battle
      syncBattleTurn() // fire belongs to the DIRECTOR's turn — mirror it first
      // INT: the loop must know who fired the NEXT blast (the
      // projectiles3d seam also carries p.tank — registerShot is the
      // explicit second seam the brief pins).
      window.__se.battleLoop?.registerShot(turn)
      window.__se.talk?.play('attack', turn) // W4-C: the firing tank taunts (data/talk.json)
      const ammo = bt.useAmmo(bt.current, bt.selectedWeapon[bt.current])
      if (!ammo.ok) console.error(`[se/battle] fire accepted but useAmmo failed (${ammo.reason}) for "${bt.selectedWeapon[bt.current]}"`)
    }
    return accepted
  }

  // The scene's `systems` list may not declare "drive" (level-01 ships an
  // empty list); attach it so the drive model + activeTank seam always run.
  if (!(game.scene.systems || []).some((s) => s && s.name === 'drive')) {
    game.scene.systems = [...(game.scene.systems || []), { name: 'drive', params: {} }]
  }
  // Same attach pattern for the SETTLE terrain-slump system (declared AFTER
  // projectiles3d/turn_director: the impact watch reads this frame's blast).
  if (!(game.scene.systems || []).some((s) => s && s.name === 'settle3d')) {
    game.scene.systems = [...(game.scene.systems || []), { name: 'settle3d', params: {} }]
  }
  // W2-Cb: lightning LAST — it watches the director turn (per-turn strike
  // roll) and steps debris; runs after projectiles3d's barrel-break trigger.
  if (!(game.scene.systems || []).some((s) => s && s.name === 'lightning')) {
    game.scene.systems = [...(game.scene.systems || []), { name: 'lightning', params: {} }]
  }
  // W2-G — weather system (clouds/fog/fire/napalm pools). Same mount pattern as
  // lightning: scene-systems entry; the system itself is the editor-visible def.
  if (!(game.scene.systems || []).some((s) => s && s.name === 'weather')) {
    game.scene.systems = [...(game.scene.systems || []), { name: 'weather', params: {} }]
  }
  // ==== W8-C VOLUMETRIC STORM CLOUDS — BEGIN (plan SE-COMPLETE-1012) ========
  // Raymarch volume slab over the play area; the system def is the
  // editor-visible registry entry, storm ramp rides the W8-A stormEventPlan.
  if (!(game.scene.systems || []).some((s) => s && s.name === 'stormClouds')) {
    game.scene.systems = [...(game.scene.systems || []), { name: 'stormClouds', params: {} }]
  }
  // ==== W8-C VOLUMETRIC STORM CLOUDS — END ==================================
  // ==== COMPUTER OPPONENTS (plan SE-COMPLETE-1012) — BEGIN ===================
  // AI turn driver: appended LAST so it runs after turn_director (it reads the
  // director state and acts through window.__aim on the active computer tank).
  if (!(game.scene.systems || []).some((s) => s && s.name === 'ai_turn')) {
    game.scene.systems = [...(game.scene.systems || []), { name: 'ai_turn', params: {} }]
  }
  // ==== COMPUTER OPPONENTS — END =============================================

  window.__aim = {
    setAngle(d) { const a = activeAim(); if (a) a.angleDeg = Math.min(180, Math.max(0, d)) },
    setPower(p) { const a = activeAim(); if (a) a.power = Math.min(1, Math.max(0, p)) },
    setBearing(d) { window.__drive.setBearing(d) },
    setDrive(d) { window.__drive.setDrive(d) },
    requestFire() { const a = activeAim(); return a ? fireActiveTurn(a.power) : false }, // shared fire path — returns acceptance
  }
  window.addEventListener('keydown', (e) => {
    // T-UI-3: ESC from an active battle returns to the Start menu, parking the
    // director exactly like the existing roundend park (requestFire rejects
    // while parked; the menu is the only way back out — New Battle re-runs S1).
    if (e.key !== 'Escape') return
    if (!battleReady || window.__menu?.isOpen()) return
    const d = window.__se?.director
    if (!d) return
    const st = d.state()
    if (st.phase !== 'roundend' && st.phase !== 'matchover') {
      d.set({ phase: 'roundend', shot: null }) // same park checkRoundEnd() uses
    }
    // Already-parked (roundend/matchover) just re-opens the menu — never a
    // dead end where ESC closed the menu and the parked battle has no way back.
    window.__menu.open()
  })
  // ==== W2-C-sibling ARMOR (plan SE-COMPLETE-1012) — BEGIN ==================
  // Toggle affordance: the V hotkey (data-driven: the armor record's effect
  // string in data/accessories.json documents it; 'a'/'d' are bearing). ON =
  // the tank model's Armor1-4 nodes visible + damage absorption
  // (accessories.applyArmorAbsorption, hooked in systems/projectiles3d.js);
  // OFF = hidden + no absorption. Visibility is applied EVERY updateHud frame
  // (same law as applyPlayerColors) so no stale plating can linger.
  const ARMOR_NODE_RE = /_Armor\d+$/
  function applyArmorVisibility() {
    const battle = window.__se?.battle
    if (!battle) return
    const renders = game.api.query({ has: 'render' })
    battle.players.forEach((p, i) => {
      const owned = (p.inventory?.accessories?.armor ?? 0) > 0
      const on = owned && p.armorOn === true
      const prefix = `tank${i + 1}_`
      for (const id of renders) {
        if (id.startsWith(prefix) && ARMOR_NODE_RE.test(id)) {
          const rec = game.api.entity(id)
          if (rec?.components?.render) rec.components.render.visible = on
        }
      }
    })
  }
  window.__se.toggleArmor = () => {
    const battle = window.__se?.battle
    if (!battle) return console.error('[se/armor] toggleArmor without a battle — ignored')
    const player = battle.players[battle.current]
    if (!player || !((player.inventory?.accessories?.armor ?? 0) > 0)) {
      return console.error('[se/armor] active player does not OWN armor — toggle rejected (fail-noisy)')
    }
    player.armorOn = !(player.armorOn === true)
    applyArmorVisibility()
    return player.armorOn
  }
  // ==== W2-C-sibling ARMOR — END ============================================
  window.addEventListener('keydown', (e) => {
    if (!battleReady || window.__menu?.isOpen()) return // S1 gate + T-UI-3 menu gate
    const k = (e.key || '').toLowerCase()
    if (k === 'shift' || k === 'control' || k === 'alt' || k === 'meta' || k === 'capslock') return
    const dr = window.__drive
    if (k === ' ') {
      // SE-EXPANSION-1012 A2: Space fires the STORED power — one tap, one
      // shot, no sweep (the charge minigame code path is removed).
      // USER-BUG 2026-10-11: no e.repeat guard — holding Space auto-repeated
      // (~30/s) and re-fired every repeat ("MIRV does not stop firing").
      // Keyboard auto-repeat stays INTENTIONAL for R/F (ramp); never for fire.
      if (e.repeat) return
      e.preventDefault()
      const a = activeAim()
      if (a) fireActiveTurn(a.power)
      return
    }
    const a = activeAim()
    if (k === 'q' && a) a.angleDeg = Math.min(180, Math.max(0, (a.angleDeg ?? 45) - 2))
    else if (k === 'e' && a) a.angleDeg = Math.min(180, Math.max(0, (a.angleDeg ?? 45) + 2))
    // SE-EXPANSION-1012 A2: R = power UP, F = power DOWN — 0.01 internal per
    // keydown (keyboard auto-repeat gives the held-press ramp), clamp [0,1].
    else if (k === 'r' && a) a.power = Math.min(1, (a.power ?? 0.55) + 0.01)
    else if (k === 'f' && a) a.power = Math.max(0, (a.power ?? 0.55) - 0.01)
    // T-CAM-1: ArrowUp/Down/Left/Right are REASSIGNED to the camera focus pan
    // (the camera-rig keydown handler below owns them); A/D bearing, W/S drive
    // are unchanged.
    // A/D turn direction (user-verified 2026-10-11): A = turn LEFT on screen,
    // D = turn RIGHT — the old mapping read inverted through the play camera.
    else if (k === 'a') dr.setBearing(dr.get().bearingDeg + 2)
    else if (k === 'd') dr.setBearing(dr.get().bearingDeg - 2)
    else if (k === 'w') dr.setDrive(dr.get().drive + 0.2)
    else if (k === 's') dr.setDrive(dr.get().drive - 0.2)
    // W2-C-sibling: V toggles the ACTIVE player's armor (W2-C-sibling ARMOR
    // block above owns the semantics; fail-noisy when unowned).
    else if (k === 'v') window.__se.toggleArmor()
  })

  // ---- Camera rig (X3a): 180° orbit arc + wheel zoom + behind-tank follow ---
  // camState is the orbit data; cam_rig.js (pure) owns the arc math. The
  // renderer's engine `orbit` preset places x=+cos(theta), z=+sin(theta)
  // (engine/src/render/camera.js), so game azimuth 90° == theta pi/2 == +z —
  // NO mirroring (verified live: camera-control.spec pins azimuth 90 => cam z>30).
  // The engine phi is measured from +Y; our camState.phi is elevation from
  // horizontal => engine_phi = PI/2 - phi (exact; keeps camera-control.spec green).
  // SE-FIXUP-1012 W3 (contract C3): zoom limits + turn-focus params ride DATA
  // (data/camera.json, `_source` documented there); the literals below are
  // only the fail-soft fallback if the fetch throws (pre-W3 behavior).
  let camData = null
  try { camData = await loadData('camera') } catch (e) { console.error('[se/cam] data/camera.json failed to load — falling back to the pre-W3 literals:', e) }
  const CAM_ZOOM = { minRadius: 84, maxRadius: 336, wheelStep: 0.08, followMinBackDist: 5, followMaxBackDist: 40, ...(camData?.zoom || {}) }
  const CAM_FOCUS = { radius: 90, durationSec: 1.2, inputCancels: true, ...(camData?.turnFocus || {}) }
  // W2 (SE-CINEMATIC-1013 C6): shell-track params — DATA only (data/camera.json
  // shellTrack, chase + track blocks). A missing block fails NOISY and shell
  // tracking stays disabled — never silent fallback literals (hard doctrine).
  const SHELL_TRACK = camData?.shellTrack
  if (!SHELL_TRACK?.chase || !SHELL_TRACK?.track) console.error('[se/cam] data/camera.json shellTrack (chase/track) missing — shell tracking DISABLED (fail-noisy)')
  // W2 seam (C4 input parking): the intro flyover publishes its live status on
  // window.__se.introFlyover; while active the rig handlers below discard input.
  const flyoverActive = () => !!window.__se?.introFlyover?.active
  const DEG = Math.PI / 180
  const camEntity = game.api.entity('battlefield_camera')
  const rigComp = camEntity?.components?.scripts?.find((s) => s.name === 'camera-rig')
  const rigParams = rigComp ? rigComp.params : null
  // W4 (SE-CINEMATIC-1013 C4): the flyover handoff needs the anchor the orbit
  // focuses — read live (missing = fail-noisy, no silent fallback).
  const anchorRec = game.api.entity('camera_anchor')
  if (!anchorRec) console.error('[cam_rig] camera_anchor missing — the intro flyover handoff pose is unavailable (fail-noisy)')
  const anchorPos = anchorRec
    ? { x: anchorRec.components.transform.x, y: anchorRec.components.transform.y, z: anchorRec.components.transform.z }
    : null
  // W3: the BOOT radius honors the shared cap too — rigParams.radius arrives
  // from scene data and was previously trusted unclamped (the one unclamped
  // zoom-out path; a huge scene radius escaped the arena).
  const camState = { azimuthDeg: 90, radius: clampRadius(rigParams?.radius ?? 168, CAM_ZOOM.minRadius, CAM_ZOOM.maxRadius), phi: 0.35, yawOffsetDeg: 0 }
  window.__camRadius = () => camState.radius
  function applyOrbit() {
    // T-CAM-1: the drag yaw offset accumulates unclamped in camState; the
    // EFFECTIVE azimuth is clamped into the 0..180 arc here (orbitPose's
    // documented behavior — same clamp the pure math pins).
    // W3: the radius is clamped HERE as well — applyOrbit is the one writer
    // of the engine preset/rig params, so any stray camState.radius writer
    // still lands inside the data cap (defense in depth; the wheel clamps
    // its own write below).
    camState.radius = clampRadius(camState.radius, CAM_ZOOM.minRadius, CAM_ZOOM.maxRadius)
    const theta = clampAzimuth(camState.azimuthDeg + camState.yawOffsetDeg) * DEG
    const phiEng = Math.PI / 2 - camState.phi
    if (rigParams) {
      // Persist through the rig (scripts re-read these each step; the live
      // camera-control.spec pins rigParams.radius === __camRadius()).
      rigParams.focus = 'camera_anchor'
      rigParams.theta = theta
      rigParams.phi = phiEng
      rigParams.radius = camState.radius
    }
    renderer.setCameraPreset('orbit', { focus: 'camera_anchor', theta, phi: phiEng, radius: camState.radius, fov: 40 })
    // W4 (SE-CINEMATIC-1013 C4): publish the LIVE battle-start pose — the intro
    // flyover's final cameraPose eases onto exactly this (seamless handoff, no
    // teleport). Same engine orbit math (node_modules hermesforge-engine
    // camera.js orbit: pos = focus + radius·sin(phi)·cos(theta), cos(phi),
    // sin(phi)·sin(theta)).
    if (anchorPos) {
      window.__se = window.__se || {}
      window.__se.battlePose = {
        pos: {
          x: anchorPos.x + camState.radius * Math.sin(phiEng) * Math.cos(theta),
          y: anchorPos.y + camState.radius * Math.cos(phiEng),
          z: anchorPos.z + camState.radius * Math.sin(phiEng) * Math.sin(theta),
        },
        target: { x: anchorPos.x, y: anchorPos.y, z: anchorPos.z },
        fov: 40,
      }
    }
  }
  applyOrbit() // ONE init call: boot the rig from camState defaults
  canvas.addEventListener('wheel', (e) => {
    if (flyoverActive()) return // W2 C4: rig input parked during the flyover — discarded, no state mutation
    e.preventDefault()
    // W3: bounds + step from DATA (data/camera.json zoom block).
    camState.radius = clampRadius(camState.radius * (1 + Math.sign(e.deltaY) * CAM_ZOOM.wheelStep), CAM_ZOOM.minRadius, CAM_ZOOM.maxRadius)
    // T-CAM-1 FOLLOW mode: wheel = follow DISTANCE (clamped 5..40); the follow
    // drive reads it every frame, no explicit re-drive needed.
    if (followMode) followState.backDist = clampRadius(followState.backDist * (1 + Math.sign(e.deltaY) * CAM_ZOOM.wheelStep), CAM_ZOOM.followMinBackDist, CAM_ZOOM.followMaxBackDist)
    else applyOrbit() // follow owns the preset while ON; radius lands on toggle-off
    // W3 turn-focus: manual zoom input overrides the auto transition — never
    // fight the user (data switch: turnFocus.inputCancels).
    if (turnFocusAnim && CAM_FOCUS.inputCancels) cancelTurnFocus('wheel')
  }, { passive: false })

  // ---- T-CAM-1 mouse drag: DEFAULT view = pan/tilt the orbit; FOLLOW = orbit
  // around the subject tank. Left button only; offsets are pure in-memory
  // camState/followState fields (nothing persisted).
  const PAN_TILT = { dragX: 0.25, dragY: 0.003 } // deg per px azimuth / rad per px tilt
  let dragging = false
  canvas.addEventListener('pointerdown', (e) => {
    if (flyoverActive() || e.button !== 0) return // W2 C4: parked during the flyover
    dragging = true
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointermove', (e) => {
    if (flyoverActive() || !dragging || e.buttons === 0) return // W2 C4: parked
    const dx = e.movementX || 0, dy = e.movementY || 0
    if (followMode) {
      followState.offsetDeg += dx * PAN_TILT.dragX // accumulates, no wrap — pure math takes it raw
      followState.phi = clampTilt(followState.phi + dy * PAN_TILT.dragY)
    } else {
      camState.yawOffsetDeg += dx * PAN_TILT.dragX
      camState.phi = clampTilt(camState.phi + dy * PAN_TILT.dragY)
      applyOrbit()
    }
  })
  const endDrag = () => { dragging = false }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)

  // Orbit arc keys: ','/'.' step the azimuth by 2° (arrows/F-keys are owned
  // elsewhere). Its OWN listener — the aim keydown handler is a sibling's.
  window.addEventListener('keydown', (e) => {
    if (e.key === ',') { camState.azimuthDeg = clampAzimuth(camState.azimuthDeg - 2); applyOrbit() }
    else if (e.key === '.') { camState.azimuthDeg = clampAzimuth(camState.azimuthDeg + 2); applyOrbit() }
  })

  // ---- T-CAM-1 arrow keys = screen-relative focus pan (DEFAULT view) --------
  // Up/Down move the focus along the camera's ground-projected forward
  // (away-from-camera = "up"), Left/Right strafe it screen-left/right.
  // panFocus (pure) clamps into the voxel field bounds; pan is disabled while
  // FOLLOW mode owns the camera (it orbits the tank — there is no free focus).
  // battleReady-gated like the aim handler; ','/'.' stay ungated (pre-existing).
  const PAN_STEP = 4 // world units per press
  window.addEventListener('keydown', (e) => {
    if (!battleReady || followMode || flyoverActive() || window.__menu?.isOpen()) return // W2 C4: parked during the flyover
    const k = (e.key || '').toLowerCase()
    let strafe = 0, dist = 0
    if (k === 'arrowup') dist = PAN_STEP
    else if (k === 'arrowdown') dist = -PAN_STEP
    else if (k === 'arrowleft') strafe = -PAN_STEP
    else if (k === 'arrowright') strafe = PAN_STEP
    else return
    const at = game.api.entity('camera_anchor')?.components?.transform
    if (!at) { console.error('[cam_rig] focus pan: no camera_anchor transform — pan dropped'); return }
    // Camera ground-forward = focus - camera position (xz). The renderer's
    // orbit preset positions the camera; read its live position.
    const c = renderer.camera.position
    const focus = panFocus({ x: at.x ?? 0, y: at.y ?? 0, z: at.z ?? 0 }, (at.x ?? 0) - c.x, (at.z ?? 0) - c.z, strafe, dist)
    at.x = focus.x
    at.z = focus.z
    at.y = focus.y
    applyOrbit()
  })

  // Follow toggle (data, not a second camera): while ON, each frame drives the
  // renderer to followPose(activeTank). Seam (SHARED-X3, frozen): X3b publishes
  // window.__se.activeTank {x,y,z,bearingRad,...}; while it is undefined the
  // follow camera parks on the camera_anchor transform, no throw. To stop the
  // engine camera-rig built-in from re-driving the orbit preset each step, the
  // rig's mode is parked on a sentinel (unknown modes are a logged no-op in
  // builtins.js); toggling OFF restores 'orbit' immediately.
  let followMode = false
  // T-CAM-1 follow-orbit state: offsetDeg orbits the SUBJECT tank (0 = the
  // classic behind-tank followPose), phi is the elevation tilt, backDist the
  // follow distance (wheel adjusts it in follow mode). In-memory only.
  const followState = { offsetDeg: 0, phi: 0.35, backDist: 9 }
  const followBtn = document.getElementById('btn-follow')
  if (followBtn) followBtn.addEventListener('click', () => setFollow(!followMode))
  else console.error('[cam_rig] #btn-follow missing from index.html — follow toggle unavailable')
  function setFollow(on) {
    if (window.__se?.introFlyover?.active) return // W2 C4: the follow handler parks during the flyover (input discarded)
    followMode = on
    if (on && turnFocusAnim) cancelTurnFocus('follow-toggle') // follow owns the camera; no auto transition
    if (followBtn) followBtn.textContent = 'Follow: ' + (on ? 'ON' : 'OFF')
    if (on) { // fresh orbit each engagement — nothing persisted
      followState.offsetDeg = 0
      followState.phi = 0.35
      followState.backDist = 9
    }
    if (rigParams) rigParams.mode = on ? 'behind-tank-follow' : 'orbit'
    if (!on) applyOrbit()
  }
  function driveFollow() {
    let t = window.__se?.activeTank
    if (!t) {
      const at = game.api.entity('camera_anchor')?.components?.transform
      if (!at) console.error('[cam_rig] no window.__se.activeTank and no camera_anchor transform — follow parked at origin')
      t = at ? { x: at.x ?? 0, y: at.y ?? 0, z: at.z ?? 0, bearingRad: 0 } : { x: 0, y: 0, z: 0, bearingRad: 0 }
    }
    // T-CAM-1: followOrbitPose — offset 0 is EXACTLY followPose (unit-pinned);
    // drag rotates the camera around the tank at constant ground radius while
    // lookAt keeps the tank framed.
    const f = followOrbitPose({ x: t.x, y: t.y, z: t.z, bearingRad: t.bearingRad ?? 0, offsetDeg: followState.offsetDeg, phi: followState.phi, backDist: followState.backDist })
    driveCameraDirect(f)
  }
  // W2: the direct camera drive shared by the follow orbit and the shell
  // chase — the preset AND the position/lookAt both write so the engine's
  // per-render _applyCamera draws the SAME pose (orbit around an explicit
  // target at the lookAt point).
  function driveCameraDirect(f) {
    const dx = f.x - f.lookAt.x, dy = f.y - f.lookAt.y, dz = f.z - f.lookAt.z
    let r = Math.hypot(dx, dy, dz)
    // W3 (C3): one shared zoom-out cap — the derived follow radius honors it too.
    if (window.__camZoomMax) r = Math.min(window.__camZoomMax, r)
    renderer.setCameraPreset('orbit', {
      target: { x: f.lookAt.x, y: f.lookAt.y, z: f.lookAt.z },
      radius: r, theta: Math.atan2(dz, dx), phi: Math.acos(dy / r), fov: 40,
    })
    renderer.camera.position.set(f.x, f.y, f.z)
    renderer.camera.lookAt(f.lookAt.x, f.lookAt.y, f.lookAt.z)
  }

  // ---- W2 (SE-CINEMATIC-1013, contracts C5/C6): SHELL TRACK ------------------
  // EVERY shot is tracked automatically for the flight window (director 'flight'
  // + a live projectile3d entity → materialize/impact): follow ON → chasePose
  // rides behind/above the shell; follow OFF → trackPose glides the orbit focus
  // + radius toward it (pan/zoom, never a teleport). The pose math is the pure
  // module src/gameplay/shell_cam.js; every tunable is DATA (data/camera.json
  // shellTrack — chase + track blocks, read once at boot above). frame() calls
  // tickShellTrack() BEFORE driveFollow and skips the follow drive whenever the
  // shell (or the intro flyover) owns the camera.
  let shellTrackPrev = false
  function shellLive() {
    const id = game.api.query({ has: 'projectile3d' })[0]
    const p = id ? game.api.entity(id)?.components?.projectile3d : null
    if (!p) return null
    return { pos: { x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0 }, vel: { x: p.vx ?? 0, y: p.vy ?? 0, z: p.vz ?? 0 } }
  }
  function tickShellTrack() {
    if (flyoverActive()) return true // C4: the flyover owns the camera — park the shell drive too (last write wins there)
    if (!SHELL_TRACK) return false // data gap already failed NOISY at boot
    const st = window.__se?.director?.state?.()
    const fl = shellLive()
    const tracking = trackActive({ active: st?.phase === 'flight', done: !fl })
    if (!tracking) { shellTrackPrev = false; return false }
    if (!shellTrackPrev && turnFocusAnim) cancelTurnFocus('shell-track') // the shot owns the camera now
    shellTrackPrev = true
    if (followMode) {
      // CHASE: physically follow the shell — rides behind/above it, lookAt
      // ahead along the velocity. The user's follow DISTANCE (wheel) is kept.
      const f = chasePose({
        shell: fl.pos, vel: fl.vel, backDist: followState.backDist,
        height: SHELL_TRACK.chase.height, lookAhead: SHELL_TRACK.chase.lookAhead,
        minBackDist: CAM_ZOOM.followMinBackDist, maxBackDist: CAM_ZOOM.followMaxBackDist,
      })
      driveCameraDirect(f)
    } else {
      // TRACK (pan/zoom): the focus glides toward the shell (exponential ease,
      // frame-rate independent) and the radius eases toward the DATA zoom —
      // from wherever the camera currently is, never a teleport.
      const at = game.api.entity('camera_anchor')?.components?.transform
      if (!at) { console.error('[se/cam] shell-track: no camera_anchor transform — track pose skipped (fail-noisy)'); return true }
      const next = trackPose({
        focus: { x: at.x ?? 0, y: at.y ?? 0, z: at.z ?? 0 }, radius: camState.radius,
        shell: fl.pos, panEase: SHELL_TRACK.track.panEase,
        zoomRadius: SHELL_TRACK.track.zoomRadius, zoomEase: SHELL_TRACK.track.zoomEase,
      })
      at.x = next.x
      at.y = next.y
      at.z = next.z
      camState.radius = clampRadius(next.radius, CAM_ZOOM.minRadius, CAM_ZOOM.maxRadius)
      applyOrbit()
    }
    return true
  }
  // W3 spec seam: __cam.setRadius simulates a STRAY camState.radius writer
  // (e.g. a future feature writing the field directly) — applyOrbit must land
  // it inside the DATA cap. Read-only elsewhere; nothing else writes through.
  window.__cam = {
    state: () => ({ mode: followMode ? 'follow' : 'orbit', azimuthDeg: camState.azimuthDeg, yawOffsetDeg: camState.yawOffsetDeg, radius: camState.radius, phi: camState.phi, follow: { ...followState }, turn: turnFocusTurn, focusAnim: turnFocusAnim ? { ...turnFocusAnim } : null }),
    setRadius: (r) => { camState.radius = r; applyOrbit() },
  }

  // ---- SE-FIXUP-1012 W3 (contract C3): turn-start auto focus + zoom ---------
  // On each director turn change the camera glides to the ACTIVE tank: the
  // focus (camera_anchor transform) lerps to the tank position and the orbit
  // radius eases to the DATA target (data/camera.json turnFocus: radius,
  // durationSec, inputCancels). Manual camera input (wheel above, drag via
  // pointerdown) cancels the transition — never fight the user. The FIRST
  // observed turn does not focus (boot already frames the field; turning on
  // battle mount broke the camera-control.spec boot pins).
  let turnFocusAnim = null
  let turnFocusTurn = null
  window.__camZoomMax = CAM_ZOOM.maxRadius // engine-rig preset choke reads the DATA cap (see camHandle.setPreset)
  function cancelTurnFocus(reason) {
    if (!turnFocusAnim) return
    console.info(`[se/cam] turn-focus cancelled (${reason})`)
    turnFocusAnim = null
  }
  function startTurnFocus(turnId) {
    if (followMode) return // follow owns the camera; no auto transition
    const tr = game.api.entity(turnId)?.components?.transform
    if (!tr) { console.error(`[se/cam] turn-focus: no transform for "${turnId}" — skipped`); return }
    const at = game.api.entity('camera_anchor')?.components?.transform
    if (!at) { console.error('[se/cam] turn-focus: no camera_anchor transform — skipped'); return }
    turnFocusAnim = {
      t: 0, dur: CAM_FOCUS.durationSec,
      from: { x: at.x ?? 0, y: at.y ?? 0, z: at.z ?? 0 }, to: { x: tr.x ?? 0, y: tr.y ?? 0, z: tr.z ?? 0 },
      fromR: camState.radius, toR: clampRadius(CAM_FOCUS.radius, CAM_ZOOM.minRadius, CAM_ZOOM.maxRadius),
    }
  }
  function tickTurnFocus(dt, parked = false) {
    // Watch the director turn each frame (cheap state read); catch the change
    // when the turn actually flips (settle end). Parked phases (roundend /
    // matchover) never refocus, and the flyover parks the pose drive (C4).
    const d = window.__se?.director
    const st = d?.state?.()
    if (st && st.turn && st.turn !== turnFocusTurn) {
      const wasTurn = turnFocusTurn
      turnFocusTurn = st.turn
      if (wasTurn !== null && !parked && st.phase !== 'roundend' && st.phase !== 'matchover') startTurnFocus(st.turn)
    }
    if (!turnFocusAnim || parked) return
    const anim = turnFocusAnim
    anim.t += dt
    const k = Math.min(1, anim.t / anim.dur)
    const e = 1 - (1 - k) * (1 - k) // easeOutQuad — smooth arrival, fast start
    const at = game.api.entity('camera_anchor')?.components?.transform
    if (at) {
      at.x = anim.from.x + (anim.to.x - anim.from.x) * e
      at.y = anim.from.y + (anim.to.y - anim.from.y) * e
      at.z = anim.from.z + (anim.to.z - anim.from.z) * e
    }
    camState.radius = anim.fromR + (anim.toR - anim.fromR) * e
    applyOrbit()
    if (k >= 1) turnFocusAnim = null
  }
  // Drag = manual camera input: a left-press on the canvas during the
  // transition overrides it (inputCancels data switch).
  canvas.addEventListener('pointerdown', () => { if (turnFocusAnim && CAM_FOCUS.inputCancels) cancelTurnFocus('drag') })

  window.__boot = {
    valid: game.valid,
    canvas: !!canvas,
    webgl: renderer.webglAvailable,
    errors: game.errors,
    models: window.__modelInfo,
  }

  const fixedDt = (project.gameLoop && project.gameLoop.fixedDt) || 1 / 60
  const maxDelta = (project.gameLoop && project.gameLoop.maxDelta) || 0.1
  // INT position seam (pinned): EVERY frame, while a battle loop exists, the
  // live tank transforms are pushed into the loop via setTankPositions — so
  // any blast (which lands between frames, after game.step) damages tanks at
  // their current world positions. Same entity-transform access as
  // applyPlayerColors (game.api.entity(tankN).components.transform).
  // W5 (plan SE-COMPLETE-1012): IMPACT DAMAGE (manual:L2156-L2161, Archaic
  // Options) — the tank-fall damage path, wired into the single damage path
  // (battleLoop.onBlast hostile, exactly like lightning). Per frame, an ALIVE
  // tank whose support surface DROPPED (a blast/settle carved its column)
  // falls: it snaps down to the new surface and books fall damage per the
  // DATA magnitudes (data/physics-presets.json .impact) — gated by the Tanks
  // Fall setting (off = no fall, the tank rides/floats, legacy), with the
  // Impact Damage setting choosing the booking label (manual: total damage
  // is identical either way). fallY tracks each tank's last supported surface;
  // cleared wherever tanks are TELEPORTED (boot/battle spawn/reseed/map-size)
  // so round rollovers never book phantom falls.
  const fallY = new Map() // tankId -> last supported surface world-y
  // SETTLE-PACE-1015 (user directive, option 1): buried-tank DATA threshold.
  const BURIED = buriedParams()
  // W2 (plan SETTLE-SEQUENCE-1014): pending fall plans, captured when a tank
  // SNAPS during the settle 'tanks' stage and BOOKED in the 'fallDamage'
  // stage (one stage per tick, per the W1 machine). Cleared on teleport
  // (resetFallTracking) and after booking — a teleport must never book a
  // phantom fall. Entries: { dropPx, damage, timing } (from planFall).
  const fallPlans = new Map() // tankId -> pending fall plan
  function resetFallTracking() {
    fallY.clear(); fallPlans.clear()
    // W3 (plan SETTLE-SEQUENCE-1014): a queued death must SURVIVE the settle
    // finishing normally (resetFallTracking is NOT a death-clear on the play
    // path) — but a RESEED is a round rollover: the death belongs to the old
    // round and playing it against a reseeded/repositioned tank would be a
    // phantom. Clear the queue here (reseed calls this); in-flight deathRuns
    // are already torn down by reseedRound's own se.deathRuns = [] reset.
    window.__se.deathQueue = []
  }
  // W2, part 1 — the BASELINE still tracks EVERY sim step (the W5 invariant):
  // the crater that drops a tank lands at impact, BEFORE the settle 'tanks'
  // stage opens, so freezing fallY outside 'tanks' (as the W2 brief first
  // pinned) would baseline AFTER the crater and no fall could ever be
  // detected — and a driven tank would go stale and phantom-fall next settle.
  // This pass never MOVES a tank; it only reads surfaces into fallY. The
  // movement/damage gating lives entirely in tickTankFalls below.
  function trackFallBaseline() {
    const se = window.__se
    const battle = se?.battle
    const field = se?.field
    if (!battle || !field) return
    for (const p of battle.players) {
      if (!p.alive) { fallY.delete(p.id); fallPlans.delete(p.id); continue }
      const tr = game.api.entity(p.id)?.components?.transform
      if (!tr) continue
      // SETTLE-PACE-1015 (user directive, option 1): a BURIED tank's honest
      // baseline is tank.y itself (the tank IS at its support surface — the
      // dirt above is cover, not ground). Baseline = surf would book phantom
      // fall damage for dirt removed ABOVE the tank when it digs itself out;
      // baseline = tank.y makes both the no-phantom-damage case and the
      // dig-free descent (its own blast carves the column, the tank rides
      // DOWN from tank.y to the carved surface) correct at every carve
      // depth: surf < tank.y => planFall fires the real fall; surf ≈ tank.y
      // => sub-threshold, no fall, no damage.
      const surf = voxelSurfaceWorld(field, tr.x ?? 0, tr.z ?? 0)
      const buried = isBuried({ tankY: tr.y ?? 0, surf, minCoverU: BURIED.minCoverU })
      fallY.set(p.id, buried ? (tr.y ?? 0) : surf)
    }
  }
  // W2, part 2 — the tank-fall path is GATED to the settle 'tanks' stage:
  // outside it (hold/dirt/fallDamage/deaths, or any non-settling phase)
  // tanks NEVER move and NO damage is booked. Two-phase: 'tanks' snaps +
  // collects plans (NO damage), 'fallDamage' books every collected plan via
  // the same single damage path (loop.onBlast hostile). se.settleStageDone
  // is the director's per-tick stage-done signal (settleStageSignal), set
  // each call.
  function tickTankFalls() {
    const se = window.__se
    const dir = se?.director?.state()
    const stage = dir?.phase === 'settling' ? dir.settleStage : null
    if (stage !== 'tanks' && stage !== 'fallDamage') {
      // W2-REGRESSION-FIX (2026-10-15, X2 terrain session): the baseline must
      // still be PRE-crater when the 'tanks' stage opens. A blast carves its
      // footprint IN-FRAME at impact — BEFORE the settling machine enters
      // 'hold' (probe: after a 15u nuke carve of column top 94 -> 34, the
      // top is ALREADY 34 on the first hold step). trackFallBaseline() used
      // to run on every non-tanks step, re-baselining the cratered surface
      // during hold/dirt — planFall then saw fromY == toY and the fall path
      // was dead (no snap, no [se/impact] line; settle-stages.spec measured
      // yAtFallDamage == t1y0). The baseline is only SAFE to refresh outside
      // the settling phase (aim/flight: driving happens there, so a driven
      // tank never goes stale; settle end re-baselines the post-fall surface
      // before the next shot). Inside settling the frozen pre-crater value
      // is exactly what lets the tanks stage detect the drop.
      if (dir?.phase !== 'settling') trackFallBaseline()
      // W3: the deaths stage DRAINS the kill queue — playDeath for every
      // queued entry, in kill order, ONCE (then the queue empties; runs are
      // ticked per-frame by tickDeaths below). Kills landing during
      // hold/dirt/tanks/fallDamage only QUEUE (the onBlast hook); their
      // animations never start before this stage opens.
      if (stage === 'deaths' && Array.isArray(se.deathQueue) && se.deathQueue.length > 0) {
        for (const entry of se.deathQueue) playDeath(se, game.api, entry.tankId, entry.seed)
        se.deathQueue.length = 0 // drained — done now requires the runs themselves
      }
      se.settleStageDone = settleStageSignal({
        phase: dir?.phase,
        settleStage: stage,
        deathRuns: se.deathRuns,
        pendingDeaths: Array.isArray(se.deathQueue) ? se.deathQueue.length : 0, // W3: queue must be empty before the turn advances
      })
      return
    }
    const loop = se?.battleLoop
    const battle = se?.battle
    const field = se?.field
    if (!loop || !battle || !field) {
      // W-terrain session (2026-10-15): no battle/battleLoop (menu-less boot)
      // or no field — nothing can fall or book, so the caller-gated stages
      // vacuously complete. Leaving settleStageDone unset here DEADLOCKED the
      // tanks stage forever (probe: skipSetup-less boot stuck settling/tanks,
      // stageDone false, director never reached aim — collapse.spec hang).
      se.settleStageDone = true
      return
    }
    let params
    try {
      params = impactParams()
    } catch (e) {
      console.error(`[se/impact] ${e.message} — fall damage disabled this frame`)
      se.settleStageDone = true // data broken = falls can't be planned; fail-loud above, vacuous-advance below (never deadlock the settle machine)
      return
    }
    if (stage === 'fallDamage') {
      // W2: FIRST frame of the stage — book every plan collected in 'tanks'.
      // tr.y was already snapped there; the blast lands at the tank's
      // (post-fall) position, same hostile path, same console line as W5.
      for (const [id, plan] of fallPlans) {
        const tr = game.api.entity(id)?.components?.transform
        if (!tr) continue
        if (plan.damage > 0) {
          const at = { x: tr.x ?? 0, y: tr.y ?? 0, z: tr.z ?? 0 }
          const sp = strikePoint(at, { damage: plan.damage, blastRpx: params.blastRpx })
          loop.onBlast({ x: sp.x, y: sp.y, z: sp.z, rPx: params.blastRpx, hostile: true }) // sky-nobody's-attacker path: damage + maxPower drain + deaths, NO scoring
          console.info(`[se/impact] ${id} fell ${plan.dropPx.toFixed(1)} SE px — ${plan.damage} hull (${plan.timing}; impactDamage ${se.settings?.impactDamage === false ? 'off' : 'on'})`)
        }
      }
      fallPlans.clear()
      se.settleStageDone = settleStageSignal({ phase: dir.phase, settleStage: stage, fallDamageDone: true }) // all plans booked (advance next tick — the director's 1-tick minimum holds anyway)
      return
    }
    // stage === 'tanks': snap falling tanks + collect plans, NO damage here.
    const surfs = [] // one { snapped, atRest } per ALIVE tank — tanksStageDone input
    for (const p of battle.players) {
      if (!p.alive) { fallY.delete(p.id); fallPlans.delete(p.id); continue }
      const tr = game.api.entity(p.id)?.components?.transform
      if (!tr) continue
      const surf = voxelSurfaceWorld(field, tr.x ?? 0, tr.z ?? 0)
      // SETTLE-PACE-1015 (user directive, option 1): a BURIED tank cannot
      // fall — it is under its support surface (planFall would see a RISE
      // and null anyway), and it has NO pending snap. Baseline = tank.y
      // (honest support, same reasoning as trackFallBaseline above) and any
      // stale fall plan is dropped: a buried tank digs itself free via the
      // NEXT tanks-stage pass once its own blast (or any carve) drops the
      // surf to/below tank.y — the matrix is pinned in test/unit/buried.test.js:
      // (a) surf returns to ≈ tank.y => no fall, no damage;
      // (b) over-carved below tank.y => real fall from the tank.y baseline;
      // (c) partial cover (< minCoverU) => not buried, baseline = surf.
      if (isBuried({ tankY: tr.y ?? 0, surf, minCoverU: BURIED.minCoverU })) {
        fallY.set(p.id, tr.y ?? 0)
        fallPlans.delete(p.id) // a buried tank has no pending snap
        surfs.push({ snapped: false, atRest: true })
        continue
      }
      const last = fallY.get(p.id)
      fallY.set(p.id, surf)
      if (last == null) { surfs.push({ snapped: false, atRest: true }); continue } // first sighting after a teleport — no delta, nothing pending
      const plan = planFall({
        fromY: last,
        toY: surf,
        tanksFall: se.settings?.tanksFall,
        impactDamage: se.settings?.impactDamage,
        params,
      })
      if (!plan) { surfs.push({ snapped: false, atRest: true }); continue } // no pending fall (tanksFall off / rise / sub-threshold / buried)
      tr.y = surf // the fall: the tank rides down to its (new) surface
      fallPlans.set(p.id, { dropPx: plan.dropPx, damage: plan.damage, timing: plan.timing }) // booked in the fallDamage stage
      surfs.push({ snapped: true, atRest: true }) // already re-grounded this tick
    }
    se.settleStageDone = settleStageSignal({ phase: dir.phase, settleStage: stage, tanksDone: tanksStageDone(surfs) })
  }
  function feedTankPositions() {
    const loop = window.__se?.battleLoop
    if (!loop) return
    const battle = window.__se?.battle
    if (!battle) return
    const list = []
    for (const p of battle.players) {
      const tr = game.api.entity(p.id)?.components?.transform
      if (!tr) { // fail-noisy ONCE per missing tank per frame is too loud; the loop's onBlast errors per blast
        continue
      }
      list.push({ id: p.id, x: tr.x ?? 0, y: tr.y ?? 0, z: tr.z ?? 0 })
    }
    loop.setTankPositions(list)
  }
  // ---- HUD text (X3c → T-UI-5): consolidated top panel -----------------------
  // Data flow (kept): main.js computes (drive, meter, battle, wind), hud.js
  // renders — no DOM writes here. The active player's name/color and the
  // weapon selector state come from the battle turn state (syncBattleTurn).
  // KEYS_HINT (row-3 controls text) MOVED to panel_hint's text widget child in
  // assets/archetypes/ui_top_panel.json — content is archetype data, not code.
  function cycleWeapon(dir) {
    const battle = window.__se.battle
    if (!battle) return
    syncBattleTurn()
    const player = battle.players[battle.current]
    if (!player) return
    const owned = battle.weaponCatalog.filter((w) => player.inventory.weapons[w.id] > 0)
    if (owned.length === 0) return
    const cur = owned.findIndex((w) => w.id === battle.selectedWeapon[battle.current])
    const next = owned[(cur + dir + owned.length) % owned.length]
    battle.chooseWeapon(battle.current, next.id)
  }
  // CANVAS-MIGRATION 2026-10: the #top-weapon selector BUTTON is retired with
  // the static panel markup — weapon cycling is owned by the weapon picker bar
  // (click / digits / ,/. pages / I armory). cycleWeapon stays for the picker.

  function updateHud() {
    syncBattleTurn() // S3D: picker + panel track the director's turn (cheap findIndex)
    const dr = window.__drive
    const d = dr ? dr.get() : { bearingDeg: 0, budget: 0 }
    const a = activeAim() || {}
    const battle = window.__se.battle
    const player = battle ? battle.players[battle.current] : null
    const selId = battle ? battle.selectedWeapon[battle.current] : null
    const wRec = battle ? battle.weaponCatalog.find((w) => w.id === selId) : null
    feedTopPanel({
      power: a.power ?? 0,
      angleDeg: a.angleDeg ?? 45,
      bearingDeg: d.bearingDeg,
      distLeft: d.budget,
      playerName: player ? player.name : fallbackPlayerName(activeTurn()),
      playerColor: player ? player.color : null,
      weaponName: wRec ? wRec.name : undefined,
      weaponCount: player && selId ? player.inventory.weapons[selId] : undefined,
      accessories: player ? player.inventory.accessories : {},
      // SE-EXPANSION-1012 B1 — HEALTH: the ACTIVE player's hull % on the
      // panel_status_hull statusrow; hulls exposes every player's hull.
      hull: player ? player.hull : undefined,
      hulls: battle ? battle.players.map((pl) => ({ id: pl.id, hull: pl.hull })) : [],
      // W2-Cb — POWER cap: the active player's maxPower (undamaged players
      // carry 1.0; the panel shows 'cur/max' only when damaged).
      maxPower: player ? player.maxPower : undefined,
      windX: window.__se.wind ? window.__se.wind.x : 0,
      // W2-C-sibling — ARMOR toggle state: undefined = unowned (indicator
      // dims 'ARM —'); true/false = owned ON/OFF. applyArmorVisibility() runs
      // every frame right after the feed (plating can never go stale).
      armor: player && (player.inventory?.accessories?.armor ?? 0) > 0
        ? player.armorOn === true
        : undefined,
    })
    // CANVAS-MIGRATION 2026-10: mirror the feed onto window.__se.topPanelFeed —
    // the ui_top_panel_bind script reads it per step and writes the widget
    // components' fields; the engine renderer paints the overlay from them.
    // WEAPON-BAR-FOLD: the weapon bar's raw state rides the same feed (the
    // pure computeWeaponBar view model composes the widget texts in the bind).
    window.__se.topPanelFeed = { ...getTopPanelFeed(), weaponBar: weaponBar.view() }
    applyArmorVisibility() // W2-C-sibling ARMOR: every-frame node visibility law
    // ==== W4-A SIMULTANEOUS UI HINT (plan SE-COMPLETE-1012) — BEGIN ==========
    // Manual:L2179-L2183 (status bar shows every tank's power/weapon in
    // Simultaneous Mode) — this build's hint: a lazy #se-turnmode-hint line
    // showing the lockstep state. FIRST FIRE = COMMIT (the shared fire path
    // accepts the shot into the volley); the hint names who commits next.
    try {
      const se2 = window.__se
      const sim = se2?.settings?.turnMode === 'simultaneous'
      let el = document.getElementById('se-turnmode-hint')
      if (!sim) { if (el) el.remove(); return } // synchronous: no hint, ever
      if (!el) {
        el = document.createElement('div')
        el.id = 'se-turnmode-hint'
        el.style.cssText = 'position:fixed;top:2px;left:50%;transform:translateX(-50%);z-index:60;font:11px monospace;color:#9fdc7f;background:#0f1a0cdd;border:1px solid #3a5a3a;padding:2px 10px;pointer-events:none'
        document.body.append(el)
      }
      const st = se2.director?.state()
      const nameOf = (id) => se2.battle?.players.find((p) => p.id === id)?.name ?? id
      el.textContent = !st ? '' : st.phase === 'planning'
        ? `SIMULTANEOUS PLANNING — ${nameOf(st.turn)}: FIRE TO COMMIT (1 shot each)`
        : st.phase === 'resolving' || st.phase === 'flight'
          ? 'SIMULTANEOUS — RESOLVING VOLLEY'
          : ''
    } catch (e) { console.error('[se/hud] turnmode hint failed:', e) }
    // ==== W4-A SIMULTANEOUS UI HINT — END =====================================
  }
  let last = performance.now()
  // INT round end (brief #5): checked whenever the director idles in 'aim' —
  // after every shot settles (or a death skips someone), if the loop says the
  // round is over, close it: survival awards + showRoundEnd overlay, and the
  // director is parked on 'roundend'/'matchover' so requestFire rejects
  // (no shots while the standings are up). Rollover resumes on DONE (armNextRound).
  function checkRoundEnd() {
    const se = window.__se
    const loop = se.battleLoop, d = se.director
    if (!loop || !d) return
    const st = d.state()
    // W4-A: simultaneous lockstep rounds idle in 'planning' between volleys —
    // the round-end check must run there too (teams: last TEAM standing).
    if (st.phase !== 'aim' && st.phase !== 'planning') return // mid-flight/settling: wait; parked phases: return
    if (!loop.roundOver()) return
    const res = loop.endRound()
    // W2-Cb: the round boundary resets the power law — full hull = full
    // maxPower again. The detached BARREL does not regenerate (the manual
    // pins no repair rule; _placeholder — new battle = fresh tanks).
    try {
      const rule = window.__se.damagePowerRule
      if (rule) for (const p of window.__se.battle.players) p.maxPower = rule.maxPower
      window.__se.barrelBroken = {}
      window.__se.lightningTurn = 0
    } catch (e) { console.error('[se/lightning] round-boundary power reset failed:', e) }
    // W1-B round-boundary economy (plan SE-COMPLETE-1012): where the round
    // actually closes — interest credit per player (manual:L1762), the
    // Computers Buy shop pass (manual:L1776, real inventory flow), and the
    // faithful Free Market per-round drift when enabled (manual:L1782-L1800).
    // Deterministic: rngSeed derives from the round number, never Math.random.
    try {
      const es = window.__se.economySettings ?? {}
      const b = se.battle
      const econRes = roundBoundary({
        players: b.players,
        interestRate: es.interestRate ?? undefined,
        computersBuy: es.computersBuy ?? 'on',
        rngSeed: b.round ?? 1,
        market: window.__se.market ?? null,
      })
      if (econRes.market) window.__se.market = econRes.market // persists per battle
      window.__se.lastRoundEconomy = econRes // per-player cash after the pass
    } catch (e) {
      console.error('[se/economy] round-boundary economy pass failed loud:', e)
    }
    // Documented simplification (_placeholder — the manual's per-round respawn
    // is map setup we don't simulate): tanks KEEP their positions; only
    // hull/alive reset, via nextRound() inside endRound().
    if (res.next === 'match') {
      d.set({ phase: 'matchover', shot: null })
      // Match end: the FINAL STANDINGS overlay is shown (no shop — the battle
      // is over). The round-end-before-shop ordering only applies to a round
      // rollover (below), so the standings render here with NO onClose hook.
      showRoundEnd(res.roundSnapshot)
    } else {
      d.set({ phase: 'roundend', shot: null })
      armNextRound()
      // ROUND-END-BEFORE-SHOP ordering: the FINAL STANDINGS overlay is shown
      // FIRST (rendered here, no synchronous store open) and the shop opens
      // AFTER the user dismisses it. The standings overlay (#se-scoreboard, z
      // 95) is the round-end dismissal gate — its DONE button fires this
      // onClose hook. The store opens behind it (z 120) only once the standings
      // are dismissed, so the user reads the standings before shopping. If the
      // store can't open (no human in the queue / store unmounted),
      // openStoreBetweenRounds returns false and the hook resumes the round
      // directly so the standings DONE is never a dead end.
      showRoundEnd(res.roundSnapshot, () => {
        // Only open the shop while still parked between rounds (director phase
        // 'roundend'). If the standings are dismissed AFTER the round resumed
        // (a flow that dismisses them late), this is a no-op — never open the
        // store mid-round. (shopOpenAllowed lives inside the store-mount closure;
        // the phase check here is its exact condition, kept in this outer scope.)
        if (window.__se.director?.state().phase !== 'roundend') return
        openStoreBetweenRounds() // no human queue / store unmounted -> returns false and resumes so the DONE isn't a dead end
      })
    }
  }
  // W6: the between-rounds store — a SEQUENTIAL MANUAL TURN PER HUMAN PLAYER
  // (pure helper storeQueue: every non-computer, INCLUDING dead players who
  // respawn at the boundary), seeded from the LIVE inventory (cash after the
  // roundBoundary pass, owned stock real). Fail-loud: no human in the queue
  // or the store unmounted -> a named console error, no store, resume armed.
  function openStoreBetweenRounds() {
    const se = window.__se
    const b = se.battle
    if (!b) return false
    const queue = storeQueue(b.players)
    if (!queue.length) {
      console.error('[se/store] round ended with no human player in the store queue (computers only) — between-rounds store NOT opened (resume stays armed)')
      return false
    }
    if (!window.__store) {
      console.error('[se/store] between-rounds store open skipped: the store is not mounted (data load failed at battle start) — resume stays armed')
      return false
    }
    se.storeQueue = queue
    se.storeOpen = true
    se.storePlayerId = queue[0].id
    window.__store.open({
      cash: queue[0].inventory.cash,
      round: b.round ?? 1,
      playOptions: { armsLevel: b.armsLevel },
      playerName: queue[0].name,
      weapons: queue[0].inventory.weapons,
      accessories: queue[0].inventory.accessories,
    })
    console.info(`[se/store] between-rounds store opened for ${queue[0].name} (${queue[0].id}) — queue turn 1/${queue.length}, round ${b.round ?? 1} boundary`)
    return true
  }
  function frame() {
    const now = performance.now()
    const dt = Math.min(maxDelta, (now - last) / 1000)
    last = now
    // TEMP DIAG (idle-0fps): raw frame-timing, NO engine import (the deep import
    // breaks the build). Logs the step-vs-frame split + entity count so we can
    // NAME the growing bucket while it degrades. Remove after the fix.
    if (!window.__idleDiag) window.__idleDiag = { stepMs: 0, frameMs: 0, n: 0 }
    const _tStep = performance.now()
    game.step(dt) // W6-scrub: the SIM advances inside (onStep -> seSimStep, 0 steps while paused)
    const _sMs = performance.now() - _tStep
    // flyover replay + syncRuntimeModels + updateHud are render-side bookkeeping
    // done BEFORE game.frame() — fold them into the render bucket.
    if (flyoverReattach) {
      const stripRec = game.api.entity('intro_flyover')
      if (!stripRec) console.error('[se/flyover] intro_flyover gone — flyover re-attach dropped (fail-noisy)')
      else stripRec.components.scripts = [...(stripRec.components.scripts || []), { name: 'intro_flyover', params: { ...flyoverReattach.params } }]
      flyoverReattach = null
    }
    syncRuntimeModels(game.api) // render-side: register model clones for new entities
    if (window.__se.syncShopGate) window.__se.syncShopGate() // SHOP gate (user-verified rule): dim/label [STORE] outside roundend — defined once the battle mounts
    updateHud()
    const _tFrame = performance.now()
    game.frame()
    const _fMs = performance.now() - _tFrame
    const _diag = window.__idleDiag
    _diag.stepMs += _sMs; _diag.frameMs += _fMs; _diag.n++
    if (_diag.n === 60 || (_diag.n > 1200 && _diag.n % 120 === 0)) {
      const avgStep = _diag.stepMs / _diag.n, avgFrame = _diag.frameMs / _diag.n
      const ents = window.__game?.api ? window.__game.api.query({}).length : 0
      console.warn(`[idle-diag] frames=${_diag.n} avgStep=${avgStep.toFixed(1)}ms avgFrame=${avgFrame.toFixed(1)}ms total=${(avgStep+avgFrame).toFixed(1)}ms entities=${ents}`)
    }
    applyFxOpacity() // SE-FX render hook: fx.opacity data -> per-entity material (see below)
    tickTurnFocus(dt, flyoverActive()) // SE-FIXUP W3: turn-start auto focus (data-driven, C3) — BEFORE the follow drive; parked while the flyover owns the camera (C4)
    // W2 shell-track: the tracked shell owns the camera for the flight window —
    // chase (follow ON) / pan-zoom glide (follow OFF); the intro flyover
    // outranks it. driveFollow only runs when nothing is tracked.
    if (!tickShellTrack() && followMode) driveFollow() // post-step: drive the follow cam AFTER the rig
    updateCameraHelper() // W8-D: frustum re-sync ONLY while the editor seam is enabled
    recenterSky() // SE-COVERAGE-1015: sky sphere follows the camera xz — never exits at any mapSize
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // W6-scrub retrofit (plans/SE-SCRUB-W6/INVENTORY.md): the sim bridge that
  // used to sit in frame() runs here — ONE call per FIXED step (dt is always
  // the loop's fixedDt, i.e. simTime increments of 1/60), instead of once per
  // rendered frame on the wall clock. Original relative order preserved:
  // falls land FIRST so the blast mirror reads post-fall positions (W5),
  // then the feed, then the round boundary, then the death sequencer (which
  // ran after game.frame() before — it is pure sim + entity state, safe one
  // step earlier). Every callee early-returns until the battle mounts, so
  // pre-battle fixed steps are no-ops.
  function seSimStep(dt) {
    tickTankFalls() // W5: falls land FIRST so the blast mirror reads post-fall positions
    feedTankPositions() // INT: live tank transforms for the loop's blast mirror
    checkRoundEnd() // INT round end: director parking + economy pass + store gate
    tickDeaths(window.__se, game.api, dt) // W2-J: death stage sequencer per FIXED step (deterministic under scrub)
  }

  // SE-FX blast-series render hook: fx_blast_sphere animates scale + writes
  // fx.opacity on the ENTITY (pure sim data — tests read it); the render-owner
  // (here, per the behaviors doctrine: scripts never touch the renderer)
  // applies it to each sphere's per-entity material clone. Spheres route
  // individually (render.skinned) into renderer._skinned, so their materials
  // are unique clones (spawner sets materialParams.nonce). Additive blending
  // reads best on the voxel field — data/blast-fx.json .rendering.blending
  // declares the intent, the engine material def has no blending field.
  const ADDITIVE_BLENDING = THREE.AdditiveBlending
  const _fxBlendApplied = new Set()
  function applyFxOpacity() {
    if (!renderer._skinned) return
    for (const id of game.api.query({ has: 'fx' })) {
      const fx = game.api.entity(id)?.components?.fx
      if (!fx || fx.opacity === undefined) continue
      const mat = renderer._skinned.get(id)?.material
      if (!mat) continue
      if (!_fxBlendApplied.has(id)) {
        _fxBlendApplied.add(id)
        mat.transparent = true
        mat.blending = ADDITIVE_BLENDING
        mat.depthWrite = false // additive spheres must not punch holes in the voxel field
      }
      mat.opacity = Math.max(0, Math.min(1, fx.opacity))
    }
  }

  // ---- S1 boot gate: roster/setup screen before gameplay keys ---------------
  // window.__se.skipSetup === true bypasses the overlay entirely (specs and
  // the editor set it via page.addInitScript) — then battleReady is true from
  // the start and behavior is exactly pre-S1. The ONLY change to the X3b
  // keydown handler is the battleReady guard on its first line; everything
  // else in this hunk is new S1-owned code at the tail of boot().
  let battleReady = true
  // ---- W2 (SE-CINEMATIC-1013): new-game flyover trigger (C4) ----------------
  // The intro flyover script stays attached to intro_flyover for the
  // page's life, but its per-entity closure state ends at phase 'done' — a
  // SECOND new game would never replay it. primeIntroFlyover cycles the
  // scripts component (removal here; the frame loop re-attaches AFTER the
  // detach pass has observed it, clearing the closure state) and arms the
  // W2 seam: game state introFlyover='play' (script header: params.enabled OR
  // state introFlyover === 'play'). skipSetup boots (specs/editor) never call
  // it — they go straight to battle with the flyover dormant.
  let flyoverReattach = null
  function primeIntroFlyover() {
    const rec = game.api.entity('intro_flyover')
    const scripts = rec?.components?.scripts
    const entry = Array.isArray(scripts) ? scripts.find((s) => s.name === 'intro_flyover') : null
    if (!entry) {
      console.error('[se/flyover] intro_flyover carries no intro_flyover script — the new-game cinematic is SKIPPED (scene data gap, fail-noisy)')
      return
    }
    rec.components.scripts = scripts.filter((s) => s.name !== 'intro_flyover')
    flyoverReattach = { params: { ...entry.params } } // authored scene params ride back on the re-attach
    game.api.state.set({ ...game.api.state.get(), introFlyover: 'play' })
  }

  // T-UI-3 menu hook (archetype-driven per the user-directed follow-up):
  // mount ALWAYS (ESC-park seam needs window.__menu even in skipSetup boots);
  // OPEN when no battle is active (no skipSetup). scenes/menu.json is the
  // ENTRY scene: its ui_menu entity marks it as the menu scene and its
  // archetype params drive the menu content. SKIPOVERRIDE RULE (deviation,
  // documented): skipSetup keeps priority over the ui_menu marker — every
  // battle spec boots skipSetup on the (now menu) default entry and must
  // still go straight to battle; ui_menu presence gates params + editor
  // semantics, !skipSetup gates open(). New Battle runs the SAME S1 setup
  // flow — openSetup() -> START BATTLE -> battleReady + startBattle(config);
  // the battle runs as an OVERLAY on the menu scene's already-mounted
  // battlefield (menu.json carries the same terrain/tanks as terrain-test —
  // boot has no second-scene mount, and this avoids a re-boot).
  const menu = mountMenu({
    version: `v${pkg.version}`,
    onStart: () => {
      // No overlay here: the setup screen (z-40) must stay visible and
      // usable. "GENERATING..." only covers the actual generation, from
      // START BATTLE until the landscape + tanks mount (see below).
      openSetup().then((config) => {
        battleReady = true
        window.__se.config = config
        window.__se.rounds = config.rounds
        showBattleLoading() // generation begins now: show over the battle, hide on mount
        // W8-E battle-start landscape variety (user-reported 'every new game is
        // the same landscape'): the boot base seed is a FIXED scene constant, so
        // every new battle restarted the same LCG chain -> identical first
        // landscape. A NEW battle now rolls a fresh base (Math.random is the ONE
        // intended entropy source — everything downstream stays deterministic
        // FROM the seed: same seed = same landscape). An explicit config.seed
        // (setup handoff) is honored verbatim.
        // W8-I DETERMINISTIC TEST SEAM (documented): '?se-test-seed=<uint>'
        // replaces the Math.random roll for TESTS — terrain, spawn-zone and
        // shot-outcome specs pin through it instead of assuming the old fixed
        // first landscape. Production (no param) keeps full variety.
        const testSeedRaw = new URLSearchParams(location.search).get('se-test-seed')
        const testSeed = testSeedRaw !== null && /^\d+$/.test(testSeedRaw) ? (Number(testSeedRaw) >>> 0) : undefined
        reseedRound(typeof config?.seed === 'number' ? config.seed : (testSeed ?? (Math.random() * 4294967296) >>> 0))
        applyPlayerColors(config)
        primeIntroFlyover() // W2 (SE-CINEMATIC-1013): every new game plays the cinematic BEFORE the first turn
        startBattle(config).finally(hideBattleLoading) // hide when the landscape+tanks mount
      })
    },
  })
  window.__menu = menu // ESC-park seam + input guards read isOpen()
  // WAVE-3: the handlers the ui_menu_row widget script performs on a row
  // click (menu_row_<action> interactive panels on the ui_menu canvas).
  window.__se.menuActions = menuRowActions(menu)
  if (!__seSkipSetup) {
    battleReady = false
    menu.open()
  } else {
    // skipSetup (specs/editor): config is intentionally absent — fail-noisy
    // ONCE per doctrine, but do not brick the boot: default 2 human players.
    console.error('[se/battle] no setup config (skipSetup) — starting default battle: 2 human players, defaultBattleGrant')
    startBattle(null)
  }
  window.__se.battleReady = () => battleReady

  // ---- S3D: battle state + weapon picker -----------------------------------
  // createBattle (pure) from window.__se.config players (fallback: 2 defaults).
  // The shot seam: window.__se.weaponOverride -> the ACTIVE player's selected
  // weapon RECORD (projectiles3d resolves behavior from it). The director owns
  // the turn rotation; battle.current mirrors director.state().turn so the
  // picker + ammo always track who is firing.
  function startBattle(config) {
    // W1-A: physics-presets joins the boot load — the windCfg defaults
    // (maxWind 200, changingWind off, data deltaRange) come from DATA, and
    // the per-round wind rolls off the SAME deterministic seed chain as the
    // terrain (terrainSeed) at every battle/round start.
    return Promise.all([loadData('weapons'), loadData('accessories'), loadData('play-options'), loadData('physics-presets'), loadData('ai-personalities'), loadData('economy')]).then(([wData, aData, poData, ppData, aiData, econDoc]) => {
      // SE-NPLAYER-1012: default roster (skipSetup / no config) is DATA-built —
      // names + colors by index from play-options.json .players (fail-noisy
      // readers throw on junk data). The HUD name fallback reads the same list.
      const rosterData = playerRosterData(poData) // throws naming the data gap
      fallbackNames = rosterData.defaultNames
      const palette = tankPalette(poData)
      const players = (config?.players?.length ? config.players : Array.from({ length: rosterData.count.default }, (_, i) => ({
        name: rosterData.defaultNames[i % rosterData.defaultNames.length],
        color: palette[i % palette.length],
      })))
        .map((p) => ({ name: p.name, color: p.color ?? null, kind: p.kind ?? 'human', personalityId: p.personalityId ?? null }))
      // T-UI-3 armsLevel (manual:L2077-L2086): the Weapons Menu Arms Level caps
      // which items inventories can buy/fire (inventory.buy + checkChoose).
      // Stored 'se.settings'.armsLevel wins; invalid -> fail-noisy default 4
      // (never a silent clamp). Applies at battle creation (a mid-battle change
      // takes effect on the NEXT battle — documented here, not silent).
      let armsLevel
      let economySettings = {} // W1-B: interestRate/cashAtStart/computersBuy/freeMarket (manual:L1756-L1818)
      try {
        const stored = JSON.parse(localStorage.getItem(['se', 'settings'].join('.')) || 'null')
        armsLevel = stored && stored.armsLevel
        if (stored) economySettings = stored
      } catch (e) {
        console.error(`[se/battle] localStorage 'se.settings' unreadable (${e}) — armsLevel defaults 4`)
      }
      if (!(Number.isInteger(armsLevel) && armsLevel >= 0 && armsLevel <= 4)) {
        if (armsLevel != null) console.error(`[se/battle] stored armsLevel ${JSON.stringify(armsLevel)} is not an integer 0-4 — defaulting 4`)
        armsLevel = undefined
      }
      // W1-B economy settings validation (fail-noisy to descriptor defaults,
      // same pattern as armsLevel/scoringMode — never silent):
      const econ = {}
      const ir = economySettings.interestRate
      if (ir != null) {
        if (typeof ir === 'number' && Number.isFinite(ir) && ir >= 0 && ir <= 0.3) econ.interestRate = ir
        else console.error(`[se/battle] stored interestRate ${JSON.stringify(ir)} is not a number in 0-0.30 (manual:L1762) — descriptor default applies`)
      }
      // W1-B cashAtStart: boot resolver reads the descriptor default from
      // data/economy.json (loaded above as econDoc) and migrates the stale
      // pre-migration $0 default up to the descriptor default (OG INITIAL_CASH).
      // The pure logic lives in src/gameplay/economySettings.js (main.js can't
      // be unit-tested). fail-NOISY preserved: an invalid stored value names it
      // + the valid range; a migrated 0 logs a loud one-time message and the
      // migrated settings are persisted back so UI + boot agree and it never
      // re-migrates.
      const { cash: cashAtStartCash, migrated: cashMigrated, settings: cashMigratedSettings } = resolveCashAtStart(economySettings, econDoc)
      if (cashMigrated.includes('cashAtStart')) {
        console.error(`[se/settings] migrated stale cashAtStart 0 -> descriptor default ${econDoc.options.cashAtStart.default} (OG INITIAL_CASH; the old $0 default was unplayable). Set a real value in ECONOMY settings to override.`)
        try { localStorage.setItem(['se', 'settings'].join('.'), JSON.stringify(cashMigratedSettings)) } catch (e) { console.error(`[se/settings] could not persist migrated cashAtStart (${e})`) }
      }
      // fail-NOISY: an invalid stored value names it + the valid range (the
      // resolver already applied the descriptor default; the message mirrors
      // the old inline one and the other economy options above).
      {
        const stored = economySettings.cashAtStart
        if (stored != null && !(typeof stored === 'number' && Number.isFinite(stored) && stored >= 0 && stored <= econDoc.options.cashAtStart.range.max)) {
          console.error(`[se/battle] stored cashAtStart ${JSON.stringify(stored)} is not a number in 0-${econDoc.options.cashAtStart.range.max} (manual:L1770) — descriptor default applies`)
        }
      }
      if (typeof cashAtStartCash === 'number') econ.cashAtStart = cashAtStartCash
      const cb = economySettings.computersBuy
      if (cb != null) {
        if (cb === 'on' || cb === 'off') econ.computersBuy = cb
        else console.error(`[se/battle] stored computersBuy ${JSON.stringify(cb)} is not 'on'|'off' (manual:L1776) — descriptor default applies`)
      }
      const fm = economySettings.freeMarket
      if (fm != null) {
        if (fm === 'on' || fm === 'off') econ.freeMarket = fm
        else console.error(`[se/battle] stored freeMarket ${JSON.stringify(fm)} is not 'on'|'off' (manual:L1782) — descriptor default applies`)
      }
      const freeMarketOn = econ.freeMarket === 'on'
      const battle = createBattle({
        players, weapons: wData.weapons, accessories: aData.accessories,
        economy: {
          armsLevel,
          cash: typeof econ.cashAtStart === 'number' ? econ.cashAtStart : undefined, // manual:L1770 seed
          freeMarket: freeMarketOn,
        },
        // W6 (SE-FIXUP-1012 item 4): the stored weapon_* rows (localStorage
        // 'se.settings') seed the battle grant — user-set starting weapons
        // reach the inventory (validated against the descriptors inside
        // createBattle; junk rows fail loud + named and are ignored).
        // cashMigratedSettings === economySettings unless cashAtStart was
        // migrated (stale 0 -> default), in which case it carries the lifted
        // value so the in-battle settings reflect it immediately.
        settings: cashMigratedSettings,
      })
      window.__se.battle = battle
      // ==== COMPUTER OPPONENTS (plan SE-COMPLETE-1012) — BEGIN ================
      // kind/personalityId ride the setup config onto the battle players (the
      // ai_turn driver consumes them; createBattle keeps the isComputer bool
      // for the economy gate). Personalities doc loaded WITH the battle data
      // (same Promise.all — the driver never sees a half-mounted battle).
      window.__se.aiPersonalities = aiData
      for (let i = 0; i < battle.players.length; i++) {
        battle.players[i].kind = players[i]?.kind ?? 'human'
        battle.players[i].personalityId = players[i]?.personalityId ?? null
      }
      // ==== COMPUTER OPPONENTS — END ==========================================
      // W2-Cb damage->maxPower law: the rule is DATA (physics-presets
      // .damagePower); every player starts at maxPower full. The law applies
      // to EVERY damage event (wrapper installed on the loop below, once it
      // exists) — the actual applied damage drains maxPower, floored by data.
      window.__se.damagePowerRule = ppData.damagePower
      for (const p of battle.players) p.maxPower = ppData.damagePower.maxPower
      // W1-A — windCfg defaults from DATA (the settings UI's applySettings may
      // already have set windCfg; never clobber an applied config) + the LIVE
      // per-round roll from the terrain seed chain (deterministic per round).
      const se = window.__se
      if (!se.windCfg) {
        se.windCfg = {
          maxWind: ppData.landscape.maxWind.default,
          changingWind: ppData.landscape.changingWind.default === 'on',
          deltaRange: ppData.landscape.changingWind.deltaRange,
        }
      }
      rollWind(se, terrainSeed.value)
      let windTurns = 0 // per-turn nudge index (W1-A): deterministic by seed + turn
      // W1-B: round-boundary economy context + faithful Free Market state
      // (manual:L1782-L1800). Market state persists PER BATTLE on
      // window.__se.market and drifts every roundBoundary call.
      window.__se.economySettings = { interestRate: econ.interestRate ?? null, computersBuy: econ.computersBuy ?? 'on' }
      window.__se.market = freeMarketOn
        ? createMarketState({ catalog: { weapons: wData.weapons, accessories: aData.accessories } })
        : null
      window.__se.weaponOverride = () => {
        syncBattleTurn()
        return battle.selectedRecord(battle.current)
      }
      weaponBar.mount(battle)

      // ---- INT: battle loop (damage -> score -> rounds) --------------------
      // scoringMode: localStorage 'se.settings' ONLY if present, else
      // STANDARD (manual:L1802-L1804 default; data/economy.json agrees).
      let scoringMode
      try {
        const stored = JSON.parse(localStorage.getItem(['se', 'settings'].join('.')) || 'null')
        scoringMode = stored && stored.scoringMode
      } catch (e) {
        console.error(`[se/battleLoop] localStorage 'se.settings' unreadable (${e}) — scoringMode defaults STANDARD`)
      }
      if (scoringMode != null && !['BASIC', 'STANDARD', 'GREEDY'].includes(scoringMode)) {
        console.error(`[se/battleLoop] stored scoringMode ${JSON.stringify(scoringMode)} is not BASIC|STANDARD|GREEDY — defaulting STANDARD`)
        scoringMode = undefined
      }
      const rounds = Number.isInteger(config?.rounds) && config.rounds >= 1 ? config.rounds : 1
      // ==== W4-A TURN MODES + TEAMS (plan SE-COMPLETE-1012) — BEGIN ==========
      // Setup-screen options (data/play-options.json descriptors, read from
      // the START config). Stored as SETTINGS DATA on se.settings so every
      // consumer reads them per key (armsLevel doctrine); validated against
      // the descriptor enums — junk falls back to the defaults fail-noisy
      // (synchronous / NONE), never a silent clamp.
      const TURN_MODES = ['synchronous', 'simultaneous']
      const TEAMS_MODES = ['NONE', '2V2', '1V2V1']
      let turnMode = config?.options?.turnMode
      if (!TURN_MODES.includes(turnMode)) {
        if (turnMode != null) console.error(`[se/battle] config option turnMode ${JSON.stringify(turnMode)} invalid — default 'synchronous' applies`)
        turnMode = 'synchronous'
      }
      let teamsMode = config?.options?.teamLayout
      if (!TEAMS_MODES.includes(teamsMode)) {
        if (teamsMode != null) console.error(`[se/battle] config option teams ${JSON.stringify(teamsMode)} invalid — default 'NONE' applies`)
        teamsMode = 'NONE'
      }
      se.settings = { ...(se.settings || {}), turnMode, teams: teamsMode }
      // Team assignment data (src/gameplay/teams.js): tankId -> team label,
      // or null when teams are off. Wrong player count fails loud -> no teams
      // (round-end/damage keep the legacy rule rather than a broken battle).
      let teams = null
      try {
        teams = assignTeams(battle.players, teamsMode)
      } catch (e) {
        console.error(`[se/battle] team assignment failed (${e.message}) — playing WITHOUT teams`)
        teams = null
      }
      window.__se.teams = teams
      // ==== W4-A TURN MODES + TEAMS — END ====================================
      const loop = createBattleLoop({ battle, scoringMode, rounds, teams })
      window.__se.battleLoop = loop
      // W2-Cb: the maxPower drain wrapper — onBlast is THE single damage path
      // (shots via projectiles3d, lightning via systems/lightning.js); wrapping
      // it here drains the shooter's maxPower on the ACTUAL applied damage of
      // every event (law data: se.damagePowerRule).
      {
        const innerOnBlast = loop.onBlast.bind(loop)
        loop.onBlast = (blast) => {
          const results = innerOnBlast(blast)
          for (const r of results) {
            const p = battle.players.find((pl) => pl.id === r.id)
            if (p && r.damage > 0) applyMaxPowerDrain(p, r.damage, window.__se.damagePowerRule)
          }
          // W3 DEATH HOOK (plan SETTLE-SEQUENCE-1014): every kill QUEUES its
          // animation — playDeath is NOT called here (the old W2-J immediate
          // path fired mid-destruction / mid-fall). The queue drains in the
          // settle 'deaths' stage only (tickTankFalls above), so deaths play
          // after dirt -> tanks -> fallDamage, OG order. Seed formula and the
          // per-kill deathN increment order are preserved EXACTLY from W2-J
          // (determinism: same kill sequence -> same death cases), just
          // deferred. The queue is initialized/cleared by resetFallTracking
          // (reseed = round rollover — a stale queued death is a phantom).
          for (const r of results) {
            if (r.killed) {
              window.__se.deathQueue = window.__se.deathQueue || []
              window.__se.deathN = queueKillDeath(window.__se.deathQueue, {
                tankId: r.id,
                seedBase: window.__se.terrainSeed.value,
                deathN: window.__se.deathN,
              })
            }
          }
          return results
        }
      }

      // Multiplayer director (INT): replace the lazily-built default with an
      // order-aware one — turnOrder = one tankN per player; dead players are
      // skipped; accepted shots register the blast attacker.
      // SE-NPLAYER-1012 DIRECTOR VERDICT (verified, NOT rewritten): both
      // makeDirector (src/gameplay/director.js — turnOrder array + nextAlive()
      // wrap, no 2-player assumption) and the turn_director system seam are
      // already N-generic by NAME (tank1..tankN from battle.players); the
      // ['tank1','tank2'] default only fires when no turnOrder is passed.
      const turnOrder = battle.players.map((p) => p.id)
      const director = makeDirector({
        settleTimeout: window.__se.directorParams?.settleTimeout ?? 600,
        turnOrder,
        // W4-A: simultaneous = lockstep planning -> one resolving volley.
        turnMode: window.__se.settings?.turnMode === 'simultaneous' ? 'simultaneous' : undefined,
        isAlive: (id) => battle.players.some((p) => p.id === id && p.alive),
        onTurnAdvance: () => {
          loop.onTurnAdvance() // diagnostic counter only — roundOver is last-tank-standing (user-verified rule)
          // W1-A — Changing Wind: bounded, deterministic per-turn nudge at
          // every turn advance (manual: "Wind changes slightly between each
          // shot"); bounds come from the DATA deltaRange.
          if (window.__se.windCfg?.changingWind) rollWindTurn(window.__se, terrainSeed.value, ++windTurns)
        },
      })
      const innerRequestFire = director.requestFire
      director.requestFire = (tankId, shot) => {
        const ok = innerRequestFire(tankId, shot)
        if (ok) loop.registerShot(tankId) // every acceptance path (SPACE, aim_control, specs)
        return ok
      }
      window.__se.director = director

      // ---- SE-NPLAYER-1012: bind N tanks (count is runtime data) ------------
      // Scene doctrine: scenes/menu.json keeps its TWO authored tanks (the
      // default); a battle for N players SPAWNS the difference from the tank
      // ARCHETYPE (api.spawnArchetype — same hydration path as scene load)
      // and DESPAWNS any extra scene tanks. N = cfg.players.length — never a
      // per-scene literal. pickSpawns fails loudly if an edge is unusable;
      // the fail-loud "no tankN entity" seam below keeps firing if a spawn
      // ever fails to bind (config stored, sim has no hull).
      const nPlayers = battle.players.length
      // W1.5: the zone radius rides DATA (play-options.json players.spawnRadius)
      // and lives on se so the round-reseed hook re-rolls zones from the SAME
      // radius + the SAME seed chain.
      window.__se.spawnRadius = (typeof poData?.players?.spawnRadius === 'number' && Number.isFinite(poData.players.spawnRadius) && poData.players.spawnRadius > 0)
        ? poData.players.spawnRadius : 0
      try {
        const spawns = pickSpawns(window.__se.field, nPlayers, { radius: window.__se.spawnRadius, seed: terrainSeed.value })
        const faceCenter = (s) => Math.atan2(0 - s.x, 0 - s.z) // bearing 0 = +Z convention
        for (let i = 0; i < nPlayers; i++) {
          const id = `tank${i + 1}`
          const s = spawns[i]
          const rec = game.api.entity(id)
          if (!rec) {
            const spawned = game.api.spawnArchetype('tank', {
              id,
              transform: { x: s.x, y: s.y, z: s.z, yaw: faceCenter(s) },
            })
            if (!spawned) {
              console.error(`[se/battle] spawnArchetype('tank', ${id}) FAILED — player ${i + 1} has no hull (fail-loud seam fires per frame)`)
              continue
            }
            const fresh = game.api.entity(id)
            if (fresh && !fresh.components.aim) fresh.components.aim = { angleDeg: 45, power: 0.55, fire: false }
          } else {
            // W1.5 — EVERY round 1 placement uses the spawn roll, exactly like
            // later rounds: reposition scene-authored tanks onto the zone roll
            // (the old `nPlayers > 2` gate left round-1 tanks on AUTHORED
            // positions — the round-1 placement divergence bug).
            const tr = rec.components.transform
            tr.x = s.x; tr.y = s.y; tr.z = s.z; tr.yaw = faceCenter(s)
          }
        }
        for (const id of [...game.api.query({})]) {
          const m = /^tank(\d+)$/.exec(id)
          if (m && Number(m[1]) > nPlayers) {
            console.warn(`[se/battle] despawning extra scene tank ${id} (players=${nPlayers})`)
            game.world.destroy(id)
          }
        }
        syncRuntimeModels(game.api) // register the model clones the new tanks need
        if (window.__se.config?.players?.length) applyPlayerColors(window.__se.config, { strict: true }) // tint the spawned tanks too
        resetFallTracking() // W5: battle spawn is a teleport — baseline the fall tracking
      } catch (e) {
        console.error(`[se/battle] ${nPlayers}-player battle could not bind spawns: ${String(e?.message || e)} — battle proceeds with whatever tanks are bound (fail-loud per frame)`)
      }

      // W6-scrub (plans/SE-SCRUB-W6/INVENTORY.md): AUTHORED-STATE SNAPSHOT —
      // the data `controller.reset()` / editor scrub reset restores. Pure
      // data (hull/alive/maxPower/inventory maps + round + boot seed);
      // inventory is captured as plain maps (the live object keeps its
      // methods — restore writes fields back into it, never replaces it).
      window.__se.runSnapshot = {
        seed: terrainSeed.value,
        round: battle.round ?? 1,
        players: battle.players.map((p) => ({
          id: p.id,
          hull: p.hull,
          alive: p.alive,
          maxPower: p.maxPower,
          armorOn: p.armorOn,
          cash: p.inventory.cash,
          weapons: { ...p.inventory.weapons },
          accessories: { ...p.inventory.accessories },
        })),
      }

      // ---- INT: store mount + 'se-open-store' (the picker's [STORE] event) --
      // USER-VERIFIED RULE (shop gate): buying is allowed ONLY between rounds
      // (director phase 'roundend'). Mid-round the gate rejects se-open-store
      // (fail-noisy console.error + visible #se-shop-notice reason line) and
      // the se-store-close apply path below rejects purchases at the
      // mechanism level — even if the UI is bypassed, nothing lands.
      // Economy still validates cash/arms/cap on the allowed path.
      function shopOpenAllowed() {
        const d = window.__se.director
        return !!(d && d.state().phase === 'roundend')
      }
      // Visible reason line (doctrine: never silent) — one notice at a time.
      let noticeTimer = null
      function showShopNotice(reason) {
        let el = document.getElementById('se-shop-notice')
        if (!el) {
          el = document.createElement('div')
          el.id = 'se-shop-notice'
          el.style.cssText = 'position:fixed; left:50%; bottom:64px; transform:translateX(-50%); z-index:200; padding:8px 16px; background:#3a1414; color:#f2c4c4; border:2px solid #8a4444; font:bold 13px monospace;'
          document.body.appendChild(el)
        }
        el.textContent = reason
        el.style.display = 'block'
        if (noticeTimer) clearTimeout(noticeTimer)
        noticeTimer = setTimeout(() => { el.style.display = 'none' }, 4000)
      }
      // Dim the [STORE] widget while the shop is locked (visible locked state;
      // the button stays clickable so a click shows the reason, not silence).
      // WEAPON-BAR-FOLD: [STORE] is a ui_top_panel WIDGET now — the gate only
      // publishes the locked state (window.__se.shopLocked); the bind script
      // dims the widget's text color from the feed per step.
      function syncShopGate() {
        window.__se.shopLocked = !shopOpenAllowed()
      }
      window.__se.syncShopGate = syncShopGate
      // Shop-gate styling (injected once): dim the locked [STORE] button, and
      // raise the store panel above the round-end standings overlay (z 95, the
      // store defaults to 90) so between-rounds shopping is actually usable.
      if (!document.getElementById('se-shop-gate-style')) {
        const s = document.createElement('style')
        s.id = 'se-shop-gate-style'
        s.textContent = '#se-store { z-index:120 !important; } #se-scoreboard { inset: 0 0 64px 0 !important; }' // W6: !important — store.js injects its own #se-store style AT MOUNT (later sheet, equal specificity) which would otherwise clobber this raise and let the standings overlay intercept the panel
        document.head.appendChild(s)
      }
      mountStore(window).then(() => {
        // T-UI-3: New Battle can restart the battle after an ESC park — remove
        // the PREVIOUS battle's store listeners first so old closures never
        // double-fire against the new battle.
        for (const [n, h] of window.__se.storeListeners ?? []) window.removeEventListener(n, h)
        window.__se.storeListeners = []
        const on = (name, h) => { window.__se.storeListeners.push([name, h]); window.addEventListener(name, h) }
        on('se-open-store', () => {
          if (!shopOpenAllowed()) {
            console.error('[se/store] se-open-store REJECTED: the shop is locked while a round is active — buying is allowed only between rounds (user-verified rule)')
            showShopNotice('SHOP LOCKED — buying is allowed only between rounds')
            return
          }
          const cur = battle.players[battle.current]
          if (!cur) {
            console.error('[se/store] se-open-store with no current battle player — store not opened')
            return
          }
          // W6: track WHO the store is open for — the close snapshot lands on
          // that player (the manual [STORE] path targets the current player;
          // the auto between-rounds open targets the first queue turn). No
          // boundary queue here: a manual open must never advance one.
          window.__se.storeQueue = null
          window.__se.storePlayerId = cur.id
          window.__store.open({ cash: cur.inventory.cash, round: battle.round ?? 1, playOptions: { armsLevel }, playerName: cur.name, weapons: cur.inventory.weapons, accessories: cur.inventory.accessories }) // T-UI-3 + W4-D: the shop seeds from the LIVE inventory (owned counts real) and caps offers at the same Arms Level
        })
        // Buy-back: the panel's close snapshot lands on the CURRENT player.
        // NOTE the S2 store contract: open() seeds a FRESH inventory (finite
        // items start owned 0, store.js/createInventory), so the detail's
        // quantities ARE the purchases themselves (selling impossible from a
        // zero seed) — ADD them to the battle inventory, never assign
        // (assigning would wipe un-touched ammo). Cash goes through the sole
        // documented mutation path credit(); Infinity (baby_missile) skipped.
        on('se-store-close', (e) => {
          // Mechanism-level guard (user-verified shop gate): a close snapshot
          // arriving outside the between-rounds window is REJECTED — no cash,
          // no ammo, fail-noisy. The store can only be OPENED mid-roundend,
          // so this only fires if something bypasses the UI.
          if (!shopOpenAllowed()) {
            console.error('[se/store] se-store-close REJECTED: purchases are only allowed between rounds — snapshot dropped (user-verified rule)', e.detail)
            showShopNotice('PURCHASES REJECTED — buying is allowed only between rounds')
            return
          }
          // W6: the close snapshot lands on WHO the store was opened for
          // (storePlayerId from either open path), falling back to current.
          const cur = battle.players.find((p) => p.id === window.__se.storePlayerId) ?? battle.players[battle.current]
          const d = e.detail
          if (!cur || !d) {
            console.error('[se/store] se-store-close without a battle player/detail — purchases dropped', d)
            return
          }
          cur.inventory.credit(d.cash - cur.inventory.cash)
          // W4-D live-seed: open() seeds from the LIVE inventory, so the
          // detail's quantities are the NEW TOTALS (owned + purchases - sold)
          // — ASSIGN them, never ADD (adding double-counts the seed: 5+5+5).
          // 99-cap for finite counts; Infinity (baby_missile seed) preserved.
          const applyQty = (into, snap) => {
            for (const [id, n] of Object.entries(snap)) {
              into[id] = n === Infinity ? Infinity : Math.min(99, Math.max(0, n | 0))
            }
          }
          applyQty(cur.inventory.weapons, d.weapons)
          applyQty(cur.inventory.accessories, d.accessories)
          // W2-C-sibling: a first armor purchase defaults the toggle ON
          // (armorOn ??= true) — plating visible immediately, V toggles it.
          if ((cur.inventory.accessories.armor ?? 0) > 0 && cur.armorOn === undefined) cur.armorOn = true
          loop.scoreState.setCash(cur.id, d.cash) // scoreboard shows live cash
          // W6 sequential queue: after this player's snapshot lands, if more
          // human players remain in the boundary queue, open the store for the
          // NEXT one immediately (their own cash/stock seeded). storeOpen stays
          // TRUE through the whole queue — the rollover resume gate stays
          // blocked; it flips false ONLY after the LAST player closes. A
          // mid-round [STORE] close (no boundary queue) just clears the flag.
          const q = window.__se.storeQueue
          const idx = Array.isArray(q) ? q.findIndex((p) => p && p.id === cur.id) : -1
          const next = Array.isArray(q) && idx >= 0 ? q[idx + 1] : null
          if (next) {
            window.__se.storePlayerId = next.id
            window.__store?.open({
              cash: next.inventory.cash,
              round: battle.round ?? 1,
              playOptions: { armsLevel: battle.armsLevel },
              playerName: next.name,
              weapons: next.inventory.weapons,
              accessories: next.inventory.accessories,
            })
            console.info(`[se/store] between-rounds store opened for ${next.name} (${next.id}) — queue turn ${idx + 2}/${q.length}`)
          } else {
            window.__se.storeQueue = null
            // W6: the between-rounds store closed — the resume gate unblocks
            // (the next explicit 'next round' click outside the store proceeds).
            window.__se.storeOpen = false
          }
        })
      }).catch((e) => {
        console.error('[se/store] store could not mount (data load failed) — [STORE] will fail loud on open:', String(e))
      })
    }).catch((e) => {
      console.error('[se/battle] battle could not start (data load failed) — shots fall back to baby_missile via the projectiles3d seam:', String(e))
    })
  }
  // T-G5 — new terrain every round: advance the seed, regenerate + re-carve +
  // re-mount the voxel field, respawn both tanks on fresh surface positions,
  // reset the drive budget. Wired on the round-rollover resume path; also
  // exposed as window.__se.reseedRound (skipSetup boots default rounds=1,
  // whose round end goes straight to 'matchover', so specs drive the hook).
  // W8-E (user-reported 'every new game is the same landscape'): an optional
  // explicit base seed pins the chain START — chain math is unchanged (same
  // seed = same landscape; specs' terrainSeed.value injection still wins).
  function reseedRound(baseSeed) {
    terrainSeed.value = typeof baseSeed === 'number' ? baseSeed >>> 0 : advanceSeed(terrainSeed.value)
    rollWind(window.__se, terrainSeed.value) // W1-A: wind re-rolls on the SAME advanced seed chain — deterministic per round
    // W5 write-through: randomLand lives on the voxelTerrain component — when
    // on, the per-round roll WRITES the knobs onto the component (the single
    // source of truth), then the generator consumes them. Deterministic per
    // round seed.
    if (terrainCfg.randomLand === true || terrainCfg.randomLand === 'on') {
      Object.assign(terrainCfg, rollLandscape(terrainSeed.value))
    }
    const nf = generateVoxel3d(terrainSeed.value, { landscape: terrainLandscape(), shape: terrainShape(), terrainType: terrainCfg.terrainType, rockAmount: terrainCfg.rockAmount }) // W5: knobs from the voxelTerrain component (randomLand roll written through)
    const carved = carveFrontTrench(nf)
    console.info(`[reseed] terrain seed -> ${terrainSeed.value}, wind -> ${JSON.stringify(window.__se.wind)}, carved ${carved.carvedCells} cells (cellZ >= ${carved.cellZStart}) (T-G5 + W1-A)`)
    mountSky('reseed', { force: true }) // T-UI-4: sky re-created from the NEW round seed — same seed = same sky, old sky disposed
    const spawns = pickSpawns(nf, window.__se.battle?.players?.length ?? 2, { radius: window.__se.spawnRadius ?? 0, seed: terrainSeed.value }) // fail-noisy BEFORE the live field is touched; N = runtime roster size; W1.5 zone roll from the SAME seed chain
    const nv = createVoxel3dHost(renderer.scene) // fresh host exactly like boot: dispose() also kills the shared material, so remounting the old host is not safe
    nv.mount(nf)
    window.__se.v3d.dispose()
    window.__se.field = nf
    window.__se.v3d = nv
    const ids = [...game.api.query({})].filter((id) => /^tank\d+$/.test(id)).sort()
    ids.forEach((id, i) => {
      const rec = game.api.entity(id)
      const tr = rec?.components?.transform
      const s = spawns[i]
      // W10 (plan SE-FIXUP-1012 item 4, user: "when the next round starts, that
      // player is still missing visually"): the death sequence hides the tank
      // entity (deaths.js tickDeaths, 'hide never destroy — reseed rule') and
      // the respawn MUST un-hide it. Also fail-noisy re-ground: a tank that
      // somehow sits below the field floor at round start is placed back on
      // the fresh surface, never left in the void.
      if (rec?.components?.render) rec.components.render.visible = true
      if (tr && typeof tr.y === 'number' && (!Number.isFinite(tr.y) || tr.y < -V)) {
        console.error(`[reseed] ${id} respawned from a bad pose (y=${tr.y}) — re-grounded on the fresh surface`)
        tr.y = undefined
      }
      if (!tr || !s) return
      tr.x = s.x
      tr.z = s.z
      tr.y = voxelSurfaceWorld(nf, s.x, s.z) // EXACTLY on the surface: (columnTop+1)*V
    })
    resetFallTracking() // W5: teleport — no phantom falls on the fresh round
    // W11 (plan SE-BUG-1014, user: "the tank that died doesn't show the barrel
    // moving when I aim it, in the second round"): barrel break destroyed the
    // front segment entity and only se.barrelBroken reset at the boundary —
    // the rebuilt tank aimed an EMPTY Barrel wrapper. Data-driven restore
    // (fresh tank per round = fresh barrel); intact tanks untouched.
    try {
      const restored = restoreBarrelSegments({
        api: game.api,
        tankIds: ids,
        archetype: archetypes.tank,
        players: window.__se.battle?.players ?? [],
      })
      for (const r of restored) console.info(`[reseed] ${r.tankId}: front barrel segment restored from archetype data (round reset = fresh tank)`)
    } catch (e) {
      console.error(`[reseed] barrel segment restore failed: ${String(e?.message || e)}`)
      throw e
    }
    window.__drive?.setBudget(turnBudgetFor(mapSize())) // active tank back to full budget (24 x map factor); the idle tank's record resets on its next turn change
  }
  window.__se.reseedRound = reseedRound
  // W6-scrub (plans/SE-SCRUB-W6/INVENTORY.md) — THE RESET PROBLEM: scrub
  // reset re-hydrates only ENTITIES; the SE sim lives outside the scene.
  // Registered on the controller (game.controller.onRunReset) so BOTH the
  // editor scrub toolbar and window.__controller.reset() restore the authored
  // state: battle data from the mount snapshot, fresh authored terrain +
  // spawn poses (reseedRound on the BOOT seed — also re-plans weather + resets
  // fall tracking + drive budget), no in-flight ordnance, director parked on
  // the initial 'aim' phase, tank1 to fire.
  function seRunReset() {
    const se = window.__se
    const snap = se?.runSnapshot
    if (!se?.battle || !snap) {
      console.error('[se/scrub] run reset with no battle/snapshot — nothing to restore (battle never mounted)')
      return
    }
    for (let i = 0; i < snap.players.length; i++) {
      const live = se.battle.players[i], s = snap.players[i]
      if (!live) continue
      live.hull = s.hull
      live.alive = s.alive
      live.maxPower = s.maxPower
      live.armorOn = s.armorOn
      live.inventory.credit(s.cash - live.inventory.cash) // state rewind via the SOLE documented mutation path (cash is getter-only; negative deltas allowed)
      Object.assign(live.inventory.weapons, s.weapons)
      for (const k of Object.keys(live.inventory.weapons)) if (!(k in s.weapons)) delete live.inventory.weapons[k]
      Object.assign(live.inventory.accessories, s.accessories)
      for (const k of Object.keys(live.inventory.accessories)) if (!(k in s.accessories)) delete live.inventory.accessories[k]
    }
    se.battle.round = snap.round
    se.battle.current = 0
    se.lightningTurn = 0
    se.barrelBroken = {}
    se.market = null
    se.lastRoundEconomy = null
    se.storeOpen = false
    se.deathRuns = [] // any in-flight death sequencer dies with the reset (reseedRound re-hides/re-grounds the corpse entity)
    for (const id of [...game.api.query({})]) {
      if (/^(shell_|blast_|fx_)/.test(id)) game.world.destroy(id) // in-flight ordnance + fx never survive a reset
    }
    se.weather?.reset?.() // force the weather re-plan on the next fixed step (a live storm event must not survive)
    reseedRound(snap.seed) // authored field + spawn poses + fall-tracking + drive budget
    window.__drive?.resetRecords?.() // W6-scrub: drive bearing records are closure state — a stale record would overwrite the restored spawn yaw every step (round rollovers keep facing; only the RUN reset clears)
    const d = se.director
    if (d) d.set({ phase: 'aim', settleSteps: 0, shot: null, shots: [], turn: se.battle.players[0]?.id ?? 'tank1' })
  }
  // SE-EXPANSION-1012 A1 — live map-size apply: the settingsApply-backed seam.
  // Validates via setMapSize (throws on junk, fail-noisy), re-generates the
  // field at the SAME seed (this is a size change, not a reseed), re-carves,
  // re-mounts a fresh host, re-grounds tanks, re-places panes and re-seeds the
  // drive budget (24 x factor). Perf is measured, never guessed.
  function applyMapSize(size) {
    const t0 = performance.now()
    setMapSize(size) // throws on unknown size — state untouched
    try {
    // 2026-10-14 field-depth-x2: fields doubled in cells (default 960x192x480 =
    // 88.5MB; large is 4800x192x2400 = 2.2GB). Release the
    // old field BEFORE the new allocation so the regen peak doesn't stack two
    // fields in the tab (large regen OOMed in Chromium without this).
    window.__se.field = null
    const nf = generateVoxel3d(terrainSeed.value, { landscape: terrainLandscape(), shape: terrainShape(), terrainType: terrainCfg.terrainType, rockAmount: terrainCfg.rockAmount }) // W5: knobs from the voxelTerrain component
    const carved = carveFrontTrench(nf)
    const nv = createVoxel3dHost(renderer.scene) // fresh host: dispose() kills the shared material
    nv.mount(nf)
    window.__se.v3d.dispose()
    window.__se.field = nf
    window.__se.v3d = nv
    groundTanksOn(nf)
    resetFallTracking() // W5: teleport — no phantom falls on map-size re-ground
    placePanesFromExtents()
    window.__drive?.setBudget(turnBudgetFor(mapSize()))
    window.__se.lastRegenMs = performance.now() - t0
    console.info(`[map-size] applied ${mapSize()}: field ${nf.W}x${nf.H}x${nf.Z}, carved ${carved.carvedCells} cells, regen ${window.__se.lastRegenMs.toFixed(0)}ms`)
    return window.__se.lastRegenMs
    } catch (e) {
      // DEEPEN-1015 R6b: medium/large exceed the data budget MAX_FIELD_BYTES —
      // makeField throws the named RangeError AFTER `field` was nulled above.
      // Fail-noisy still: restore the DEFAULT field so the page never sits on
      // a null field, then rethrow (the caller sees the named error).
      setMapSize('default')
      const nf = generateVoxel3d(terrainSeed.value, { landscape: terrainLandscape(), shape: terrainShape(), terrainType: terrainCfg.terrainType, rockAmount: terrainCfg.rockAmount })
      const carved = carveFrontTrench(nf)
      const nv = createVoxel3dHost(renderer.scene)
      nv.mount(nf)
      window.__se.v3d.dispose()
      window.__se.field = nf
      window.__se.v3d = nv
      groundTanksOn(nf)
      resetFallTracking()
      placePanesFromExtents()
      window.__drive?.setBudget(turnBudgetFor(mapSize()))
      window.__se.lastRegenMs = performance.now() - t0
      console.error(`[map-size] ${JSON.stringify(size)} refused (budget/alloc) — default field restored: ${String(e)}`)
      throw e
    }
  }
  window.__se.setMapSize = applyMapSize
  // W5 write-through controller (settingsApply TERRAIN_KNOBS lands here):
  // every terrain knob row writes onto the voxelTerrain component — the
  // single source of truth — then the field rebuilds at the SAME seed so the
  // change is visible live. mapSize routes through applyMapSize (its own
  // extents/pane/budget rebuild). Values are validated by applySettings
  // before the write; junk from direct calls is refused fail-noisy.
  function applyTerrainKnob(key, value) {
    if (key === 'mapSize') return applyMapSize(value)
    if (key === 'flattenPeaks') {
      terrainCfg.flattenPeaks = value === true || value === 'on'
      if (!terrainCfg.flattenPeaks && value !== false && value !== 'off') {
        throw new RangeError(`applyTerrainKnob: flattenPeaks ${JSON.stringify(value)} is not on/off`)
      }
    } else if (key === 'randomLand') {
      terrainCfg.randomLand = value === true || value === 'on'
      if (!terrainCfg.randomLand && value !== false && value !== 'off') {
        throw new RangeError(`applyTerrainKnob: randomLand ${JSON.stringify(value)} is not on/off`)
      }
    } else if (key === 'bumpiness' || key === 'slope' || key === 'mountainPercent') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new RangeError(`applyTerrainKnob: ${key} ${JSON.stringify(value)} out of range 0..100`)
      }
      terrainCfg[key] = value
    } else if (key === 'rockAmount') {
      // P3 SETTLE-PACE-1015: Rock Amount (0-100 %) — scales the rock scatter's
      // boulder sites + pebble density at generation. Validated here BEFORE the
      // regenerate; the generator independently fail-louds (defense in depth).
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new RangeError(`applyTerrainKnob: rockAmount ${JSON.stringify(value)} out of range 0..100`)
      }
      terrainCfg.rockAmount = value
    } else if (key === 'terrainType') {
      // W-landscape (plan SETTLE-SEQUENCE-1014 queued item): the Landscape →
      // Terrain Type row write-through. Validated here BEFORE the regenerate
      // below (a junk type must never reach generateVoxel3d mid-apply); the
      // generator independently fail-louds on unknown names (defense in depth).
      const names = terrainTypeNames()
      if (typeof value !== 'string' || !names.includes(value)) {
        throw new RangeError(`applyTerrainKnob: terrainType ${JSON.stringify(value)} is not a known terrain type (expected one of: ${names.join(', ')} — data/voxel-terrain.json .terrainTypes)`)
      }
      terrainCfg.terrainType = value
    } else {
      throw new RangeError(`applyTerrainKnob: ${key} is not a terrain knob`)
    }
    const t0 = performance.now()
    const nf = generateVoxel3d(terrainSeed.value, { landscape: terrainLandscape(), shape: terrainShape(), terrainType: terrainCfg.terrainType, rockAmount: terrainCfg.rockAmount }) // same seed — a knob change, not a reseed
    const carved = carveFrontTrench(nf)
    const nv = createVoxel3dHost(renderer.scene) // fresh host: dispose() kills the shared material
    nv.mount(nf)
    window.__se.v3d.dispose()
    window.__se.field = nf
    window.__se.v3d = nv
    groundTanksOn(nf)
    resetFallTracking()
    placePanesFromExtents()
    window.__drive?.setBudget(turnBudgetFor(mapSize()))
    window.__se.lastRegenMs = performance.now() - t0
    console.info(`[terrain-knob] ${key}=${JSON.stringify(value)}: field ${nf.W}x192x${nf.Z}, carved ${carved.carvedCells} cells, regen ${window.__se.lastRegenMs.toFixed(0)}ms`)
    return window.__se.lastRegenMs
  }
  window.__se.applyTerrainKnob = applyTerrainKnob
  // Round rollover resume: the director sits in 'roundend' while the round-end
  // overlay is up; DONE on the scoreboard resumes play in the NEW round
  // (nextRound() already ran inside endRound()). hull/alive reset there;
  // tank positions deliberately unchanged (documented simplification).
  // T-G5: positions are NO LONGER unchanged — the terrain reseed respawns
  // both tanks on fresh surface columns before the turn is handed back.
  let resumeArmed = false
  // The round-rollover resume: the director sits in 'roundend' while the
  // round-end standings/shop window is up; this reseeds the terrain and hands
  // the phase back to 'aim' (or 'planning' for simultaneous lockstep). Shared
  // by the gateResume click gate (below) and the round-end standings' onClose
  // hook when the shop can't open (no human queue / store unmounted) — so the
  // standings DONE is never a dead end.
  function resumeRound() {
    resumeArmed = false
    reseedRound()
    const d = window.__se.director
    if (d && d.state().phase === 'roundend') {
      // W4-A: simultaneous battles resume into the lockstep planning phase.
      const planning = window.__se.settings?.turnMode === 'simultaneous'
      if (planning) {
        const firstAlive = window.__se.battle?.players.find((p) => p.alive)?.id ?? null
        d.set({ phase: 'planning', settleSteps: 0, shot: null, shots: [], turn: firstAlive })
      } else d.set({ phase: 'aim', settleSteps: 0 })
    }
  }
  function armNextRound() {
    if (resumeArmed) return // one resume listener at a time
    resumeArmed = true
    // SHOP gate (user-verified rule): clicks on the [STORE] button or the open
    // store panel must NOT resume the round — roundend is the shopping window.
    // The round-end STANDINGS overlay (#se-scoreboard) is a separate dismissal
    // gate: its DONE opens the shop (showRoundEnd's onClose hook) and must NOT
    // resume either — the shop opens behind it, and the round resumes only once
    // the shop is closed. Any other click resumes.
    // W6: the between-rounds store AUTO-OPENS at the boundary — while it is
    // open, clicks INSIDE the panel stay with the store (buy rows must not
    // resume); a click OUTSIDE the open panel is the explicit 'next round'
    // action: it closes the store (the close snapshot lands, purchases apply)
    // and resumes. With the store closed, any non-store click resumes (the
    // pure helper resumeAllowed pins phase 'roundend' + !storeOpen).
    // NOTE: a buy click re-renders the rows (render() -> replaceChildren),
    // DETACHING the clicked button mid-dispatch — closest('#se-store') on the
    // detached subtree is null (the ancestor chain is broken at the removed
    // row), so the composed path (snapshotted at dispatch, still carrying the
    // panel) is the reliable inside-test.
    const clickedInStore = (e) => {
      if (e.target && e.target.closest && e.target.closest('#se-store')) return true
      try { return (e.composedPath?.() ?? []).some((el) => el && el.id === 'se-store') } catch { return false }
    }
    // ROUND-END-BEFORE-SHOP: the standings overlay is the round-end dismissal
    // gate — its DONE fires showRoundEnd's onClose hook (which opens the shop
    // behind it). A click on the standings must NOT resume the round here.
    const clickedInScoreboard = (e) => {
      if (e.target && e.target.closest && e.target.closest('#se-scoreboard')) return true
      try { return (e.composedPath?.() ?? []).some((el) => el && el.id === 'se-scoreboard') } catch { return false }
    }
    const gateResume = (e) => {
      if (e.target && e.target.closest && e.target.closest('.hf-ui-overlay [data-ui-id^="ui_menu"], .hf-ui-overlay [data-ui-id^="ui_top_panel_weapon_group"], .hf-ui-overlay [data-ui-id^="ui_top_panel_armory_group"]')) return // T-UI-3/WAVE-3: menu + weapon-bar widget clicks must not resume
      if (clickedInScoreboard(e)) return // STANDINGS overlay dismissal gate — its DONE opens the shop (onClose hook), not a resume
      if (window.__se.storeOpen) {
        if (clickedInStore(e)) return // store handles its own clicks (incl. buy/DONE rows)
        window.__store?.close?.() // explicit close -> se-store-close applies
        // W6 sequential queue: closing this player's turn may have OPENED the
        // next queue player's store (storeOpen stayed true) — that click is
        // consumed by the queue advance; the round must NOT resume yet. Only
        // the close after the LAST queue player (storeOpen false) resumes.
        if (window.__se.storeOpen) return
      }
      window.removeEventListener('click', gateResume)
      resumeRound()
    }
    window.addEventListener('click', gateResume)
  }
  // Mirror the director's turn into battle.current (director alternates
  // tank1/tank2...; players map by tankN id, fail-loud if unknown).
  function syncBattleTurn() {
    const battle = window.__se.battle
    if (!battle) return -1
    const turnId = window.__se.director?.state()?.turn ?? 'tank1'
    if (!turnId) return battle.current // W4-A: simultaneous 'resolving' parks the pointer — keep the current mirror
    const idx = battle.players.findIndex((p) => p.id === turnId)
    if (idx < 0) {
      console.error(`[se/battle] director turn "${turnId}" has no battle player (config roster vs scene tanks mismatch) — keeping current`)
      return battle.current
    }
    if (idx !== battle.current) {
      battle.current = idx
    }
    return idx
  }

  // Player colors -> render.tint + render.tintMode (engine MODEL-IMPORT
  // per-entity override: '#rrggbb' hex, tintMode 'replace' = the player color
  // verbatim). 2026-10-13 user follow-up: ONLY the HULL takes the player
  // color — the old apply tinted every node-scoped child (Armor, Barrel,
  // Track, gears), which read as a mess. The node list is DATA
  // (data/tank-colors.json tintNodes); children whose id ends with
  // `_<NodeName>` are tinted, every OTHER tank child gets any stale
  // tint/tintMode CLEARED (idempotent per apply — no lingering color).
  // Targets are recomputed every apply (SE-NPLAYER-1012 runtime spawns);
  // extra players beyond the scene's tanks log loudly (fail-noisy).
  const TANK_ID_RE = /^tank(\d+)(?:_|$)/
  function computeTintTargets() {
    const tankIds = game.api.query({ has: 'render' })
      .map((id) => ({ id, m: TANK_ID_RE.exec(id) }))
      .filter((r) => r.m)
      .sort((a, b) => Number(a.m[1]) - Number(b.m[1]) || a.id.length - b.id.length)
      .map((r) => r.id)
    const targets = [] // [rootId, childIds...] per player index
    for (let i = 0; i < 10; i++) {
      const root = `tank${i + 1}`
      if (!game.api.entity(root)) { targets.push(null); continue }
      // 2026-10-13: only the tintNodes (data/tank-colors.json) children — the
      // root plus THIS tank's `_<NodeName>` suffix matches (Hull), NOT
      // Barrel/Armor/Track — and never a SIBLING tank's nodes.
      targets.push(tankIds.filter((id) => id === root || (id.startsWith(`${root}_`) && TANK_TINT_RE.test(id))))
    }
    return targets
  }
  const tintTargets = computeTintTargets() // boot-authored tanks (kept for parity; apply recomputes)
  void tintTargets
  function applyPlayerColors(config, { strict = false } = {}) {
    if (!window.__se) return // boot() failed before __se existed
    if (!TANK_TINT_RE) { console.error('[se/tank-colors] tint node list not loaded yet — apply skipped (no fallback literals)'); return }
    const targets = computeTintTargets()
    // Stale-tint clear: a tank child OUTSIDE the tint node list must not keep
    // any earlier apply's color (the old law tinted every node). Idempotent.
    const tinted = new Set(targets.filter(Boolean).flat())
    for (const id of game.api.query({ has: 'render' })) {
      if (!TANK_ID_RE.test(id) || tinted.has(id)) continue
      const rec = game.api.entity(id)
      if (rec?.components?.render && (rec.components.render.tint !== undefined || rec.components.render.tintMode !== undefined)) {
        delete rec.components.render.tint
        delete rec.components.render.tintMode
      }
    }
    config.players.forEach((p, i) => {
      const t = targets[i]
      if (!t) {
        // strict (post-spawn reapply): a missing tank is the fail-loud seam.
        // Non-strict (START click, pre-bind): the battle spawns the difference
        // from the archetype — expected, informational.
        const msg = `[se/setup] player ${i + 1} (${p.name}) color ${p.color}: no tank${i + 1} entity in the scene — color stored in window.__se.config only`
        if (strict) console.error(msg)
        else console.info(msg + ' (expected pre-bind — startBattle spawns the difference from the tank archetype)')
        return
      }
      for (const id of t) {
        const rec = game.api.entity(id)
        if (rec?.components?.render) {
          rec.components.render.tint = p.color
          rec.components.render.tintMode = 'replace' // vibrant: player color verbatim, never multiplied over the olive base
        }
      }
    })
  }
}

boot().catch((e) => {
  window.__boot = { valid: false, canvas: false, webgl: false, error: String((e && e.stack) || e) }
})
