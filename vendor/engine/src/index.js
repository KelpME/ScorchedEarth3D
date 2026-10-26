/**
 * HermesForge engine — public facade.
 *
 * Games and behaviors import ONLY from this module. Internal modules are not
 * part of the contract. See engine/docs/API.md for the living API reference.
 */
export { GameLoop } from './core/game-loop.js'
export { validateAddon, resolveAddonLibrary, KNOWN_ENTRY_KINDS, ADDON_KINDS } from './addons/addon-spec.js'
export { World } from './core/ecs.js'
export { createGame, Game } from './core/game.js'
export { EffectRegistry, spawnEffect, createEffectsApi } from './core/effects.js'
export { createController } from './core/controller.js'
export { ScriptRegistry, runScripts, createScriptsApi, wrapGameScript, isGameScriptDef } from './core/scripts.js'
export { SystemRegistry, runSystems, createSystemsApi } from './core/systems.js'
export { flockSystem, BUILTIN_FLOCK_SYSTEMS, BUILTIN_FLOCK_SYSTEM_METAS } from './systems/flock.js'
export { cloudSystem, BUILTIN_CLOUD_SYSTEMS } from './systems/volumetric-cloud.js'
export { navAgentSystem, BUILTIN_NAV_AGENT_SYSTEMS, BUILTIN_NAV_AGENT_SYSTEM_METAS } from './systems/nav-agent.js'
export { navAgentUpdate, navAgentAttach, navAgentDetach, resetNavAgentState, REPATH_INTERVAL_S } from './nav/agent-core.js'
export { impactFlashEffect } from './render/effects-builtin.js'
export {
  BUILTIN_SCRIPTS,
  BUILTIN_SCRIPT_METAS,
  cameraRigScript,
  audioEmitterScript,
  animEventsScript,
  resetActiveRig,
  resetEmitterState,
  resetUnknownModeWarnings,
} from './scripts/builtins.js'
export {
  flockScript,
  BUILTIN_FLOCK_SCRIPTS,
  BUILTIN_FLOCK_SCRIPT_METAS,
  resetFlockState,
} from './scripts/flock.js'
export {
  cloudScript,
} from './scripts/volumetric-cloud.js'
export {
  createPhysicsApi,
  dynamicBodyScript,
  PHYSICS_BUILTIN_SCRIPTS,
  PHYSICS_BUILTIN_SCRIPT_METAS,
  PHYSICS_DEFAULTS,
} from './physics/system.js'
export {
  BUILTIN_COMPONENTS,
  BUILTIN_COMPONENT_METAS,
  componentDefaults,
  COMPONENT_REGISTRY,
  ComponentRegistry,
  createComponentsApi,
} from './components/index.js'
export { InputSnapshot, InputCapture, JumpBuffer, CoyoteTime, lerp, Interpolator } from './input/input-snapshot.js'
export {
  InputActionMap,
  key as inputKey,
  mouseButton,
  padButton,
  padAxis,
} from './input/input-map.js'
export { AudioSystem } from './audio/audio.js'
export { Pool } from './core/pool.js'
export { validateManifest, AssetLoader, ManifestError } from './assets/asset-loader.js'
export { fbxDecoder } from './assets/fbx-loader.js'
export { modelHealthCheck } from './assets/model-health.js'
export { placeModelOnGround, packScaleFor } from './assets/model-placement.js'
export { importModel, resolveModelMaterials } from './assets/model-importer.js'
export { extractRig, placeRigOnGround } from './assets/rig-extract.js'
export { decodeAndCheckModel } from './assets/decode-check.js'
export {
  backendFromIR,
  validateImport,
  manifestEntries,
  archetypeRecord,
  registrationKeys,
  canonicalizeModelPath,
} from './assets/import-backend.js'
export { KIND_FORMATS, knownKinds, knownFormats, kindForFormat } from './assets/kinds.js'
export { buildImportIR, validateIR, serializeIR, parseIR } from './assets/import-ir.js'
export { fbxToIR, scanFbxHeader, scanFbxTextureRefs, normalizeFbx, convertFbxMaterialsToPbr, shininessToRoughness } from './assets/fbx-adapter.js'
export { createTelemetryOverlay } from './telemetry/overlay.js'
export { createFrameProfiler, frameProfiler } from './telemetry/frame-profiler.js'
export { AABB, Sphere, Capsule, aabbOverlap, sphereOverlap, applyGravity, snapToGround, raycastAABB, resolveFloor, GRAVITY, boxVsSphere, sphereVsCapsule, capsuleOverlap, boxVsCapsule, raycastSphere, raycastCapsule, shapeFromCollider, shapeFromRender, readScale, rotateTriangles, readRotation, rotateOffset, aabbToTris, buildMeshShape, meshRaycast, resolveBodyVsMesh, scaleTriangles, translateShape, colliderCenter, shapeBottomY, shapesOverlap, raycastShape, shapeBottom, shapeXZ } from './physics/physics.js'
export { createNav, normalizeNav, validateNav } from './nav/nav.js'
export { groundAnchorLocalY, placeY, shapeTopAtY } from './physics/placement.js'
export { sweepShape } from './physics/sweeps.js'
export { validateScene, migrateScene, normalizeScene, migrateScaleToTransform, migrateRenderScaleInComponents, migrateVelocityToRigidBody, migrateHudToCanvas, mergeArchetype, resolveArchetypeChain, resolveArchetypeChainById, mergeArchetypeWithBase, SceneBuilder, resolveWorldTransforms, DEFAULT_LAYER, defaultLayers, resolveLayers, MAX_INSTANCES_PER_ARCHETYPE, sceneMaterializationReport } from './scene/scene.js'
export { UI_WIDGET_TYPES, UI_RENDER_MODES, UI_RECT_ANCHORS, uiWidgetDefaults, rectDefaults, canvasDefaults, resolveAnchorRect, rectToWorld, validateCanvas, validateWidget, validateRect, UI_EASINGS, uiEase, uiLerp, uiTween } from './render/ui-schema.js'
export { terrainVertexCount, normalizeTerrain, sampleTerrainHeight, sampleTerrainSurface, buildTerrainTriangles, validateTerrain } from './render/terrain-math.js'
export { valueNoiseHeight, normalizeNoiseOpts, generateRandomTile, generateNoiseTile, tileSpan, worldVertexToLocal, generateSeamMatchedTile, generateRow, adjacentFreeSlots } from './terrain/terrain-gen.js'
export { falloffWeight, sculptTileHeights, applyConstraints, localSlopeDeg, applySculptWorld } from './terrain/terrain-brush.js'
export { SHAPE_CATALOG, COLLIDER_SHAPES, RENDER_PRIMITIVES, shapeBy, isColliderShape, isRenderPrimitive, colliderShapeOptions, renderPrimitiveOptions } from './catalog/shapes.js'
export { batchKey, groupBatches, breakoutReason, supportsInstancedTint, SKINNED } from './render/batching.js'
export { resolveClip, DEFAULT_FADE, normalizeAnimOptions } from './render/animation.js'
export { clampAnimRange, crossedEvents } from './render/animation.js'
export { evaluateBlendSpace, migrateLocomotion, triangulate } from './render/blendTree.js'
export {
  retargetClip,
  resolveBoneMap,
  HUMANOID_BONE_MAP,
  clipSourceBones,
  remapTrackName,
  splitTrackName,
} from './render/retarget.js'
export { autoMapRigs, classifyRig } from './render/auto-map.js'
export {
  validateAnimator,
  validateBoneMapCoverage,
} from './animator/validate-animator.js'
export {
  buildAnimator,
  collectRigBones,
  buildBlendTree,
} from './animator/build-animator.js'
export { resolveCharacterBoneMap } from './animator/bone-map.js'
export { analyzeRig, checkRigIntegrity } from './animator/rig-integrity.js'
export { collectBindRest, buildBindCorrections, applyBindCorrections } from './animator/bind-pose.js'
export { toKeyframeTrack, toKeyframeTracks, trackClassFor } from './animator/keyframe-tracks.js'
export {
  applyAnimatorDefaults,
  ANIMATOR_DEFAULTS,
  CLIP_ROLES,
  RECOMMENDED_CLIP_ROLES,
  BONE_MAP_MODES,
  PERSISTED_BONE_MAP_PREFIX,
  RETARGET_SOLVERS,
  ROOT_MOTION_MODES,
  REQUIRED_BONE_ROLES,
} from './animator/animator-spec.js'
export { computeCameraPosition, computeLookAt, forwardFromYaw, CAMERA_PRESETS } from './render/camera.js'
export { Renderer } from './render/renderer.js'
export {
  MaterialRegistry,
  createMaterialsApi,
  buildMaterial,
  normalizeMaterialDef,
  materialDefaults,
  loadMaterialDefs,
  loadMaterialTextures,
} from './render/materials.js'
export { createPostFX, normalizePostConfig, postPassDefaults, postConfigDefaults, POST_PASS_TYPES, normalizeCustomPassDef, customPassDefaults, POST_PASS_VERTEX } from './render/postfx.js'
export {
  ShaderRegistry,
  createShadersApi,
  buildShaderMaterial,
  normalizeShaderDef,
  shaderDefaults,
  shaderHealth,
  wrapUniforms,
  toUniformValue,
  applyShaderDefToMaterial,
  DEFAULT_VERTEX,
  DEFAULT_FRAGMENT,
} from './render/shaders.js'
export {
  buildLights,
  normalizeLights,
  normalizeShadowConfig,
  shadowMapType,
  lightDefaults,
  lightsDefaults,
  LIGHT_TYPES,
  SHADOW_TYPES,
} from './render/lights.js'
