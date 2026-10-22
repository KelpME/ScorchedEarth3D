# SE Voxel Shell spike harness (V2a) — foreman-owned bench

Runs both shell candidates against the REAL field size (W=160 x H=96, V=0.25) from
src/voxel/. Measures: full build ms + blast re-extract ms (the V2 gate is ≤16ms blast
re-extract of affected chunks). Pure node, no three.js — geometry arrays are the
deliverable shape; the renderer host (V3) consumes them.

## Candidate A — smooth 2D contour strip
Surface = height(x) polyline. Strip mesh: for each column pair, two triangles between
surface points and surface+offset(depth) below; normals smoothed by averaging adjacent
segment normals; vertex colors sampled at the surface material. Dirty range = columns
touched by a blast → rebuild only that column range into its chunk buffers.

## Candidate B — per-chunk extruded surface net (DRG read)
Chunk = 32 columns wide (5 chunks). Per chunk build: front/back slabs + top skin from
height(x) with SMOOTHED boundary vertices (midpoint relaxation across chunk seams keeps
watertight), exposed side walls where |height delta| > 0 between neighbor columns
(crater walls, colored by the WALL material = deepest exposed cell), bottom slab.
Vertex colors: top skin grass→dirt blend by depth under surface; walls = material of
the cell the face abuts. Blast re-extract = rebuild touched chunks only.

## Gate table (fill from runs/spike-*.json)
| metric | budget | A | B |
|---|---|---|---|
| full build (all 5 chunks) | <= 1 frame (~16ms) | | |
| blast re-extract (r=2 world, mid-slope) | <= 16 ms | | |
| worst-case blast (r=4 crossing 2 chunk seams) | <= 16 ms | | |
| verts per full terrain | <= ~8k | | |

Decision rule (plan DEC-2): B ships if it meets the budgets; else A. Numbers recorded
in plans/SE-VOXEL-TERRAIN.md before V3 builds.
