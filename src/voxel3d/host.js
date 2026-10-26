// voxel3d host: mounts mesher chunk buffers into a three.js scene.
//
// MATERIAL DECISION (pinned): MeshBasicMaterial({vertexColors:true}).
// The mesher bakes lighting into the vertex colors via SHADE_TOP/SHADE_SIDE
// constants — that bake IS the lighting model. Layering a Lambert/Phong
// response on top double-darkens every face; a light-free BasicMaterial
// instead costs zero lighting, renders the flat Minecraft read the bake was
// designed for, and produces pixel-deterministic frames (the screenshot
// gates depend on that determinism). So: NO lights are added, ever.
//
// No per-frame rebuild lives here: remesh() is only ever called by callers
// with an explicit dirty-chunk set (e.g. the blast dirtyChunks path).

import * as THREE from 'three';
import { buildField, rebuildChunks } from './mesher.js';
import { mountDressing } from './skirt.js';
import { trenchWorldDepth } from './aquarium.js';
import { V, CAGE_Z_MAX, Z_MIN } from './constants.js';
import terrainData from '../../data/voxel-terrain.json' with { type: 'json' };

// DEEPEN-1015 R6: the grey under-field MESH (buildUnderFieldGroup /
// 'se_underfield' / 'underfield_rock' / dressing.underField) is RETIRED — the
// ground below the playable surface is now REAL TERRAIN VOXELS: the field
// grew DEEPER by FLOOR_CELLS (constants.js, data/voxel-terrain.json
// .floorExtension) and generate() fills the deep cells with the same strata
// law. No second object; solidAt/blast/spawns all reach the deep voxels.

// DEEPEN-1015 R4 (hollow-intro fix): data .corridorSolid.slabCells — the welded
// fall-slab width in cells. The mesher emits interior z-boundary faces on the
// slab planes (see buildChunk opts.slabZ) and intro_flyover groups the
// corridor chunk buckets by the SAME slab grid, so every seam that can open
// mid-fall carries real faces on both sides. Junk data fails LOUD.
const CORRIDOR_SOLID = (() => {
  const c = terrainData ? terrainData.corridorSolid : undefined;
  if (!c || typeof c !== 'object' || !Number.isInteger(c.slabCells) || c.slabCells <= 0) {
    throw new TypeError(`[se/voxel3d] data/voxel-terrain.json .corridorSolid.slabCells must be a positive integer (cells per welded fall slab): ${JSON.stringify(c)}`);
  }
  return c;
})();

/** Live slab opts for the mesher (corridor start derived from live bindings — setMapSize-safe). */
function corridorSlabOpts() {
  const corridorStartCell = Math.ceil((CAGE_Z_MAX + trenchWorldDepth() - Z_MIN) / V - 1e-9);
  return { slabZ: CORRIDOR_SOLID.slabCells, slabZStart: corridorStartCell };
}

// DEEPEN-1015 R5 FINAL's skirt-local fade reuse note is RETIRED with the
// under-fill mesh itself (R6).

export function createVoxel3dHost(scene) {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  /** chunkKey -> THREE.Mesh (only non-empty chunks get meshes) */
  const meshes = new Map();
  // CRATER-DRAIN: the per-sim-step render-mesh drain queue. A shell impact
  // enqueues its dirtyChunks here (enqueueRemesh) instead of building the
  // whole render mesh synchronously in one frame; settle3d's per-step drain
  // (drainRemesh) builds a bounded slice behind the blast-sphere VFX that
  // already plays over ~65 sim steps. The voxel COLLIDER is field-based
  // (drive.js reads columnTop(field,...) off field.cells, mutated
  // synchronously by blast()), so ONLY the visual mesh is deferred — collision
  // sees the carved terrain the frame the shell lands.
  const pendingChunks = new Set();

  function makeMesh(chunk) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(chunk.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(chunk.colors, 3));
    return new THREE.Mesh(geo, material);
  }

  // Per-chunk build+swap+dispose — extracted so remesh() (synchronous callers)
  // and drainRemesh() (the deferred drain) apply the IDENTICAL transform.
  // key: the chunk key; chunk: the rebuilt geometry. Mutates meshes/group in
  // place: vertCount 0 -> dispose+remove existing mesh; existing -> swap
  // attributes + computeBoundingSphere; else makeMesh + add to the group.
  function applyChunk(key, chunk) {
    const existing = meshes.get(key);
    if (chunk.vertCount === 0) {
      if (existing) {
        group.remove(existing);
        existing.geometry.dispose();
        meshes.delete(key);
      }
      return;
    }
    if (existing) {
      const geo = existing.geometry;
      geo.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(chunk.normals, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(chunk.colors, 3));
      geo.computeBoundingSphere();
      return;
    }
    const mesh = makeMesh(chunk);
    meshes.set(key, mesh);
    group.add(mesh);
  }

  return {
    group,

    // Full mount: buildField over the whole field; one mesh per non-empty
    // chunk (vertCount 0 chunks stay unmounted; empty rebuilds remove them).
    mount(field) {
      const chunks = buildField(field, corridorSlabOpts()); // DEEPEN-1015 R4: slab-boundary faces on the corridor fall slabs
      for (const [key, chunk] of chunks) {
        if (chunk.vertCount === 0) continue;
        const mesh = makeMesh(chunk);
        meshes.set(key, mesh);
        group.add(mesh);
      }
      scene.add(group);
      // W2-H: world dressing (skirt + cut-face + fog) as a SEPARATE scene
      // child — never into v3d.group (the 554-chunk pin stays byte-identical).
      // Idempotent: a reseed's fresh-host remount replaces the old group.
      mountDressing(scene, field);
    },

    // DEEPEN-1015 L3b seam (fail-noisy): the mounted chunk meshes bucketed by
    // chunk z — [{ cz, meshes: [THREE.Mesh...] }] sorted by cz. The intro
    // flyover addresses the CORRIDOR chunk groups through this: the fall
    // translates each mesh's position.y only (the meshes sit at position 0
    // with world-coord geometry), NEVER field.cells (heights/collision stay
    // cage-side). Throws when no chunk meshes are mounted — never a silent
    // empty list that hides a broken host.
    chunkGroups() {
      if (meshes.size === 0) {
        throw new Error(`[voxel3d/host] chunkGroups(): no chunk meshes mounted — the field host is empty (mount() never ran or removed everything) — fail-noisy`);
      }
      const byZ = new Map();
      for (const [key, mesh] of meshes) {
        const cz = Number(key.split(',')[2]);
        if (!Number.isInteger(cz)) {
          throw new Error(`[voxel3d/host] chunkGroups(): chunk key "${key}" is not a "cx,cy,cz" triple — fail-noisy`);
        }
        if (!byZ.has(cz)) byZ.set(cz, []);
        byZ.get(cz).push(mesh);
      }
      return [...byZ.entries()]
        .map(([cz, ms]) => ({ cz, meshes: ms }))
        .sort((a, b) => a.cz - b.cz);
    },

    // Incremental update for a dirty chunk-key set. Mutates in place:
    // disposes old geometry, swaps in new attributes; creates meshes that
    // went non-empty, removes + disposes ones that went empty.
    // SYNCHRONOUS path — kept for any caller that must build immediately.
    remesh(dirtySet, field) {
      const chunks = rebuildChunks(field, dirtySet, corridorSlabOpts());
      for (const [key, chunk] of chunks) applyChunk(key, chunk);
    },

    // CRATER-DRAIN: defer a dirty chunk-key set into the render-mesh queue.
    // Set-dedups, so re-enqueue is idempotent. The drain (drainRemesh) builds
    // them a bounded slice per sim step behind the blast-sphere VFX.
    enqueueRemesh(dirtySet) {
      for (const key of dirtySet) pendingChunks.add(key);
    },

    // CRATER-DRAIN: build up to `budget` queued chunks this step and mount
    // them. Cheap no-op when budget<=0 or the queue is empty. Returns the
    // count actually built. Rebuilds the given keys off the LIVE field, then
    // applies each via applyChunk (the same transform remesh() uses) and drops
    // the drained keys from the queue.
    drainRemesh(field, budget) {
      if (!(budget > 0) || pendingChunks.size === 0) return 0;
      const keys = [];
      for (const key of pendingChunks) {
        if (keys.length >= budget) break;
        keys.push(key);
      }
      const chunks = rebuildChunks(field, keys, corridorSlabOpts());
      let built = 0;
      for (const key of keys) {
        applyChunk(key, chunks.get(key));
        pendingChunks.delete(key);
        built++;
      }
      return built;
    },

    // CRATER-DRAIN seam (specs): how many chunk renders are still queued.
    get pendingCount() {
      return pendingChunks.size;
    },

    // Seam (specs): how many chunk meshes are currently mounted on the group.
    get mountedChunkCount() {
      return group.children.length;
    },

    dispose() {
      for (const mesh of meshes.values()) mesh.geometry.dispose();
      meshes.clear();
      material.dispose();
      scene.remove(group);
    },
  };
}
