// W2-H (plan SE-COMPLETE-1012) + FPS-1012g — WORLD DRESSING: hide the abyss.
// (a) DECO TERRAIN SKIRT — FPS-1012g (user: 'need to be an extension of the
//     play area — right now different voxel size and different colors'): each
//     skirt side is now FIELD-SHAPED VOXEL DATA (Uint8 cells, W/H/Z, band
//     rule + per-column grass dither identical to generator.fillColumn, tops
//     from the SAME surfaceHeight lattice continuing the field outward) and
//     is meshed through THE REAL MESHER (buildField/buildChunk). Identical V
//     voxel size, identical palette + band dither, identical SHADE lighting —
//     the skirt IS the terrain continuing. The old hand-rolled quad mesh is
//     GONE. PERF: vertical fill capped at fillCells (data, 48) below each
//     column top — deeper is fog/invisible; chunk meshes are merged per side
//     and positioned at the side's world origin.
// (b) +Z CUT FACE: the aquarium cutaway (carveFrontTrench's z0 plane) stays,
//     but the voxel wall extends DOWNWARD below the field floor (y=0) into
//     the fog so the cut no longer floats over void. (Unchanged: slab mesh.)
// (c) FOG: scene fog (FogExp2) — density/color CONSUME the skybox
//     getFogParams() seam (W2-Ca) with a data/physics-presets .dressing.fog
//     override per style.
//
// EXCLUSION BY CONSTRUCTION: the skirt NEVER enters field.cells. It is its
// own scene child ('se_dressing' group), never a mesh in v3d.group (terrain
// boot pins v3d chunks at 554). solidAt() can never read a skirt cell (its
// inField() guard excludes everything outside the field by construction);
// blast() mutates field.cells only; pickSpawns is cage-bounded. Pins live in
// test/unit/skirt.test.js + test/unit/skirt-voxel.test.js — a mutation that
// folds skirt coords into solidAt must kill the exclusion pin; a mutation
// that hand-rolls skirt geometry must kill the mesher-path pin.

import * as THREE from 'three';
import { V, CH, CAGE_Z_MAX, MATERIALS } from './constants.js';
import { surfaceHeight, hashInt } from './generator.js';
import { buildField } from './mesher.js';
import { getFogParams } from '../../systems/skybox.js';
import presets from '../../data/physics-presets.json' with { type: 'json' };

const D = presets.dressing;
export const SKIRT_GROUP_NAME = 'se_dressing';

// Band materials (generator.js convention).
const GRASS = 1, DIRT = 2, DARK = 3; // ROCK: never skirted — DEEPEN-1015 base fill is dirt below the dark band

/**
 * Pure: the cut-face plan for a field — the trench wall plane (carveFront
 * Trench's z0 math) extended BELOW the floor into the fog.
 */
export function skirtPlan(field, dressing = D) {
  const fxMin = field.X_MIN, fxMax = field.X_MIN + field.W * V;
  const z0 = Math.ceil((CAGE_Z_MAX - field.Z_MIN) / V - 1e-9); // carveFrontTrench's plane, re-derived
  const depth = dressing.cutFace.depthWorld;
  return {
    cutFace: {
      xMin: fxMin, xMax: fxMax,
      z: field.Z_MIN + z0 * V,
      yMin: -depth, yMax: 0,
      depthWorld: depth,
    },
  };
}

/**
 * Pure (W4C, plan SE-FIXUP-1012): the DEEP UNDER-SLAB plan — perimeter walls
 * at the three non-cut field edges (-x, +x, -z) extending DOWN from the floor
 * (y=0) to -dressing.underSlab.depthWorld, so the visible terrain reads as
 * going much deeper instead of dropping to void at the edges. Depth is DATA.
 * The +z side is the aquarium cut face (skirtPlan's slab already covers it).
 * Non-playable by construction: these are THREE meshes, never voxels —
 * solidAt/blast/spawns can never touch them (same exclusion law as the W10
 * skirt; pinned in test/unit/underslab.test.js).
 */
export function underSlabPlan(field, dressing = D) {
  const depth = dressing.underSlab.depthWorld;
  const fxMin = field.X_MIN, fxMax = field.X_MIN + field.W * V;
  const fzMin = field.Z_MIN, fzMax = field.Z_MIN + field.Z * V;
  return [
    { name: '-x', x: fxMin, xMin: fxMin, xMax: fxMin, zMin: fzMin, zMax: fzMax, yMin: -depth, yMax: 0, depthWorld: depth },
    { name: '+x', x: fxMax, xMin: fxMax, xMax: fxMax, zMin: fzMin, zMax: fzMax, yMin: -depth, yMax: 0, depthWorld: depth },
    { name: '-z', z: fzMin, xMin: fxMin, xMax: fxMax, zMin: fzMin, zMax: fzMin, yMin: -depth, yMax: 0, depthWorld: depth },
  ];
}

/**
 * Pure: distance-fog plan for a sky style — density/color CONSUME the
 * skybox getFogParams() seam (W2-Ca) with the data dressing override. */
export function dressingFog(style, dressing = D) {
  const base = dressing.fog;
  const seam = getFogParams(style) || { density: 0, color: null };
  const row = (base.styleOverrides && base.styleOverrides[style]) || {};
  if (row.density != null) return { density: row.density, color: row.color || seam.color || base.colorFallback };
  // FOG-ALWAYS-ON-FIX (plans/FOG-ALWAYS-ON-FIX.md, user-reported 2026-10-14):
  // the old seamlessDensity FLOOR is gone — a zero-haze style (seam density 0,
  // e.g. PLAIN) gets density 0 and mountDressing mounts NO scene fog at all.
  // Styles with haze > 0 scale off their seam density.
  return {
    density: seam.density * base.densityScale,
    color: seam.color || base.colorFallback,
  };
}

/**
 * Pure: the skirt-local depth-fade plan (FOG-ALWAYS-ON-FIX fix A) — the
 * dressing's deep meshes (skirt sides, cut face, under-slab) fade toward the
 * data fade color by depth below y=0. Replaces the scene-fog crutch that used
 * to hide the skirt's vertical cut. Color + depths are DATA (never JS).
 */
export function skirtFadePlan(dressing = D) {
  const f = dressing.fog && dressing.fog.skirtFade;
  if (!f) throw new Error('skirt.js: dressing.fog.skirtFade missing from data/physics-presets.json — fail loud, no defaults');
  for (const k of ['color', 'startDepth', 'fullDepth']) {
    if (f[k] === undefined) throw new Error(`skirt.js: dressing.fog.skirtFade.${k} missing — fail loud, no defaults`);
  }
  if (!(f.fullDepth > f.startDepth)) throw new Error(`skirt.js: dressing.fog.skirtFade.fullDepth (${f.fullDepth}) must exceed startDepth (${f.startDepth})`);
  return { color: f.color, startDepth: f.startDepth, fullDepth: f.fullDepth };
}

/** Inject the skirt-local depth fade into a MeshBasicMaterial (FOG-ALWAYS-ON-FIX
 *  fix A): vertex world-Y below -startDepth mixes toward the fade color, fully
 *  faded at -fullDepth. NOT scene fog — the material is self-contained, so
 *  clear skies leave every scene object unfogged while the deep shell still
 *  sinks into haze. */
export function applyDepthFade(mat, plan) {
  // EXPORTED (CUTFACE-REWORK-1014 R4 item 11): the under-field under-fill now
  // lives in host.js (part of the field host's own mount) and shares this
  // skirt-local fade law (FOG-ALWAYS-ON-FIX) — it must sink into the same
  // haze as the skirt/under-slab deep shell.
  const color = new THREE.Color(plan.color);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFadeColor = { value: color };
    shader.uniforms.uFadeStart = { value: plan.startDepth };
    shader.uniforms.uFadeFull = { value: plan.fullDepth };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFadeY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFadeY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFadeY;\nuniform vec3 uFadeColor;\nuniform float uFadeStart;\nuniform float uFadeFull;')
      .replace('#include <color_fragment>', [
        '#include <color_fragment>',
        'float fadeT = clamp((-vFadeY - uFadeStart) / (uFadeFull - uFadeStart), 0.0, 1.0);',
        'diffuseColor.rgb = mix(diffuseColor.rgb, uFadeColor, fadeT);',
      ].join('\n'));
  };
  mat.customProgramCacheKey = () => 'se_skirt_fade';
}

/**
 * Pure (FPS-1012g): build each skirt side as FIELD-SHAPED voxel data.
 * Heights come from the SAME generator surfaceHeight (seed rides the field
 * object) evaluated on the field's OWN cell lattice continued outward
 * (negative and beyond-W/Z lattice coords — one noise surface, no resample,
 * no seam). Bands are measured DOWN from each column's top with the exact
 * generator fillColumn rule (grass 1-3 per-column dither, dirt 12, dark 24,
 * rock), CAPPED at dressing.skirt.fillCells cells below the top (below is
 * fog/invisible). The returned objects are mesher-ready fields: W/H/Z/X_MIN/
 * Z_MIN/CHUNKS_* + Uint8Array cells, geometry in LOCAL space (X_MIN/Z_MIN=0)
 * so meshes position at the side's world origin (originWorld).
 *
 * @param {{ W, Z, X_MIN, Z_MIN, __seSeed? }} field
 * @param {object} dressing  data/physics-presets.json .dressing
 * @returns Array<{ name, cells, W, H, Z, X_MIN, Z_MIN, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, originWorld:[x,y,z], yLow, topMin, topMax, __cx0, __cz0 }>
 */
export function buildSkirtFields(field, dressing = D) {
  const width = dressing.skirt.widthWorld;
  const fill = dressing.skirt.fillCells ?? 48;
  const seed = field.__seSeed ?? 0;
  const fxMin = field.X_MIN;
  const fzMin = field.Z_MIN;
  const nW = width / V; // width in field-lattice cells (must be integral: the skirt uses the field's own voxel size)
  if (!Number.isInteger(nW)) throw new RangeError(`dressing.skirt.widthWorld ${width} is not a multiple of the voxel size V=${V}`);

  const sides = [];
  // Lattice ranges [cx0..cx1] x [cz0..cz1] INCLUSIVE, on the field's cell
  // lattice continued outward. -x/+x span the field z-range PLUS both z
  // margins (corner coverage); -z spans the field x-range (its corners are
  // covered by the -x/+x sides).
  const zSpan = [-nW, field.Z - 1 + nW];
  sides.push(latticeSide('-x', -nW, -1, zSpan[0], zSpan[1]));
  sides.push(latticeSide('+x', field.W, field.W + nW - 1, zSpan[0], zSpan[1]));
  sides.push(latticeSide('-z', 0, field.W - 1, -nW, -1));

  function latticeSide(name, cx0, cx1, cz0, cz1) {
    const Wc = cx1 - cx0 + 1, Zc = cz1 - cz0 + 1;
    // Tops: the SAME lattice function the field used — surfaceHeight(seed,
    // latticeX, latticeZ) — continued across the field boundary. FPS-1012d:
    // presets no longer shape terrain — one surface for all values.
    const tops = new Int16Array(Wc * Zc);
    let minTop = Infinity, maxTop = -Infinity;
    for (let lz = 0; lz < Zc; lz++) {
      for (let lx = 0; lx < Wc; lx++) {
        // SE-FIXUP-1012: shape params ride the field (generate stores them on
        // __seParams) — the lattice continuation must use the SAME shape the
        // field used, or per-scene shape overrides would seam at the edge.
        const t = surfaceHeight(seed, cx0 + lx, cz0 + lz, { shape: field.__seParams?.shape });
        tops[lx + lz * Wc] = t;
        if (t < minTop) minTop = t;
        if (t > maxTop) maxTop = t;
      }
    }
    // Local vertical window: rows [yLow, maxTop) — every column is filled
    // DOWN from its own top, capped at `fill` cells (bands run out into dirt
    // — DEEPEN-1015, no grey base band; deeper is swallowed by fog).
    const yLow = Math.max(0, minTop - fill);
    const Hc = maxTop - yLow;
    const cells = new Uint8Array(Wc * Hc * Zc);
    const ROW = Wc * Zc;
    for (let lz = 0; lz < Zc; lz++) {
      for (let lx = 0; lx < Wc; lx++) {
        const top = tops[lx + lz * Wc];
        // The generator's exact per-column grass dither (1..3, deterministic).
        const g = 1 + (hashInt((cx0 + lx) * 31 + (cz0 + lz) * 57 + seed) % 3);
        const base = lx + lz * Wc;
        const yStart = Math.max(yLow, top - fill);
        for (let y = yStart; y < top; y++) {
          const fromTop = top - 1 - y; // 0 = topmost cell — generator's band rule verbatim
          let m;
          if (fromTop < g) m = GRASS;
          else if (fromTop < g + 12) m = DIRT;
          else if (fromTop < g + 12 + 24) m = DARK;
          // DEEPEN-1015: below-dark continues as DIRT — matches the field's
          // fillColumn law (grey rock base band removed from the base fill).
          else m = DIRT;
          cells[base + (y - yLow) * ROW] = m;
        }
      }
    }
    return {
      name, cells,
      W: Wc, H: Hc, Z: Zc,
      X_MIN: 0, Z_MIN: 0, // local origin — mesh.position = originWorld
      CHUNKS_X: Math.ceil(Wc / CH), CHUNKS_Y: Math.ceil(Hc / CH), CHUNKS_Z: Math.ceil(Zc / CH),
      originWorld: [fxMin + cx0 * V, yLow * V, fzMin + cz0 * V],
      yLow, topMin: minTop, topMax: maxTop,
      __cx0: cx0, __cz0: cz0,
    };
  }
  return sides;
}

/** Concatenate mesher chunk geometries (all share the field-local origin)
 *  into one BufferGeometry-data object. Pure. */
export function mergeChunkGeoms(chunks) {
  let n = 0;
  for (const g of chunks.values()) n += g.vertCount;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  let o = 0;
  for (const g of chunks.values()) {
    positions.set(g.positions, o);
    normals.set(g.normals, o);
    colors.set(g.colors, o);
    o += g.vertCount * 3;
  }
  return { positions, normals, colors, vertCount: n };
}

/** FPS-1012g: mesh ONE skirt side THROUGH THE REAL MESHER — buildField over
 *  the side's field data, chunks merged (same geometry the field chunks get,
 *  in field-local coordinates). Pure data in, geometry data out. */
export function skirtSideGeometry(sideData) {
  return mergeChunkGeoms(buildField(sideData));
}

/** Build the dressing THREE.Group for a field (voxel skirt + cut-face slab).
 *  Skirt: one merged mesher mesh per side, positioned at the side's world
 *  origin, vertex-colored basic material (same read as the host's field
 *  material) with fog enabled. Mount as a SEPARATE scene child — never into
 *  v3d.group. */
export function buildSkirtGroup(field, dressing = D) {
  const group = new THREE.Group();
  group.name = SKIRT_GROUP_NAME;

  // W10 (plan SE-FIXUP-1012 item 4): ONE terrain — the deco skirt (the
  // multi-part exterior terrain) is DATA-GATED OFF by default
  // (dressing.skirt.enabled, physics-presets.json). The cut-face slab and the
  // fog below are ALWAYS mounted (both load-bearing: the aquarium cutaway
  // must not float over void; the storm/fog law consumes the mounted density).
  if (dressing.skirt?.enabled === true) {
  const skirtMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true }); // same read as the host's field material: the mesher's SHADE bake IS the lighting
  applyDepthFade(skirtMat, skirtFadePlan(dressing)); // FOG-ALWAYS-ON-FIX: skirt-local fade, NOT scene fog
  for (const s of buildSkirtFields(field, dressing)) {
    const g = skirtSideGeometry(s);
    if (g.vertCount === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
    const mesh = new THREE.Mesh(geo, skirtMat);
    mesh.name = `skirt_${s.name}`;
    mesh.position.set(s.originWorld[0], s.originWorld[1], s.originWorld[2]);
    group.add(mesh);
  }
  } // end dressing.skirt.enabled gate (W10: skirt is opt-in data)

  // CUTFACE-REWORK-1014 Round 2 item 5 (user 'there is STILL a brown/grey
  // plane that needs to go away'): the cut-face slab REMOVED — live probe
  // showed it (x [-120,120], z [19.75,20], y [-16,0], full-width dirt lip)
  // fully redundant: DEEPEN-1015 R6 — the real voxel field now extends deep
  // footprint (z to +30, y to -112) and the mesher's carved voxel wall reads
  // as the cut face above y=0. skirtPlan stays (pure — pins the trench plane).

  // W4C (plan SE-FIXUP-1012): DEEP UNDER-SLAB — perimeter walls at the -x/+x/
  // -z field edges from y=0 down to dressing.underSlab.depthWorld (DATA), so
  // the terrain reads as going much deeper instead of dropping to void. Same
  // rock/dirt coloring as the cut face, same fog law. ALWAYS mounted (like the
  // cut face); non-playable by construction (THREE meshes, never voxels).
  if (dressing.underSlab?.enabled !== false) {
    const cw = new THREE.Color(MATERIALS[4].color); // rock
    const cd = new THREE.Color(MATERIALS[2].color); // dirt lip at the top
    const usMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
    applyDepthFade(usMat, skirtFadePlan(dressing)); // FOG-ALWAYS-ON-FIX: skirt-local fade, NOT scene fog
    for (const w of underSlabPlan(field, dressing)) {
      const uw = w.xMax - w.xMin, ud = w.zMax - w.zMin;
      const ug = new THREE.BoxGeometry(Math.max(uw, V), w.yMax - w.yMin, Math.max(ud, V));
      const ucount = ug.attributes.position.count;
      const ucols = new Float32Array(ucount * 3);
      for (let i = 0; i < ucount; i++) {
        const y = ug.attributes.position.getY(i);
        const c = y > (w.yMax - w.yMin) / 2 - 3 * V ? cd : cw; // dirt lip within 3 voxels of the floor line
        ucols[i * 3] = c.r; ucols[i * 3 + 1] = c.g; ucols[i * 3 + 2] = c.b;
      }
      ug.setAttribute('color', new THREE.BufferAttribute(ucols, 3));
      const us = new THREE.Mesh(ug, usMat);
      us.name = `underslab_${w.name}`;
      const cx = (w.xMin + w.xMax) / 2, cz = (w.zMin + w.zMax) / 2;
      us.position.set(cx, (w.yMin + w.yMax) / 2, cz);
      group.add(us);
    }
  }

  // CUTFACE-REWORK-1014 R4 item 11: the GREY ROCK UNDER-FIELD slab MOVED to
  // src/voxel3d/host.js (buildUnderFieldGroup) — it is the playable area's own
  // deep body and mounts with the field host, not with the dressing. The
  // se_dressing group mounts NO underfield mesh (pinned in
  // test/dressing.spec.js + test/underslab.spec.js).

  return group;
}

/**
 * Mount (or re-mount) the dressing for a field onto a scene:
 *  - removes any previous 'se_dressing' child (idempotent on remount/reseed);
 *  - adds the skirt + cut-face group as a SEPARATE scene child;
 *  - sets scene.fog (FogExp2) from dressingFog(style) — style from the live
 *    sky handle when present, else the data default style.
 * Returns { group, fog } info for logging/specs.
 */
export function mountDressing(scene, field, dressing = D) {
  const prev = scene.children.find((o) => o.name === SKIRT_GROUP_NAME);
  if (prev) {
    scene.remove(prev);
    prev.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }
  const group = buildSkirtGroup(field, dressing);
  scene.add(group);
  const style = (typeof window !== 'undefined' && window.__se?.sky?.style) || dressing.fog.defaultStyle;
  const plan = dressingFog(style, dressing);
  // FOG-ALWAYS-ON-FIX: density 0 (zero-haze style) mounts NO scene fog — the
  // scene stays fog-free on clear skies; the deep dressing fades locally.
  const fog = plan.density > 0 ? new THREE.FogExp2(new THREE.Color(plan.color), plan.density) : null;
  scene.fog = fog;
  return { group, fog, style, fogPlan: plan };
}
