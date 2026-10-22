/**
 * Engine shape catalog — the single source of truth for every shape a gameobject
 * can be.
 *
 * There are two overlapping vocabularies in the engine:
 *   - a **render primitive** (`render.mesh`): what the object looks like
 *     (box / cylinder / sphere / plane — distinct unit geometry in the renderer).
 *   - a **collider shape** (`collider.shape`): what it collides as
 *     (box / sphere / cylinder / pill — box+sphere exact, cylinder as its
 *     bounding AABB, pill a real vertical capsule).
 *
 * A shape can be both (box/sphere/cylinder/pill), render-only (plane — a flat
 * surface with no collider volume), or collider-only (render — auto-match the
 * render mesh).
 *
 * The extra render primitives (cone / torus / torusKnot / icosahedron /
 * dodecahedron / octahedron / tetrahedron / ring / circle / lathe) are BOTH a
 * render primitive AND a collider shape: each collides as its REAL render
 * geometry (the renderer's unit primitive triangles scaled by the transform
 * scale — see `deriveRenderCollider` in physics.js), not a bounding box. They
 * carry `dims: []` (no free-text collider params) and collide as the unit
 * render geometry scaled by the transform scale. ring/circle are flat
 * primitives (the renderer bakes rotateX into the shared geometry), so they
 * collide as a flat disc/ring surface — correct, not an error.
 *
 * THIS module is the one place these lists are defined. The editor's inspector
 * dropdowns, scene validation, and any consumer that needs the set of valid
 * render meshes / collider shapes imports them from here. Adding a shape = add
 * one entry (plus, only if it needs new math, a branch in the renderer's
 * `_geometry` and/or physics `shapeFromCollider`). Do not hardcode a shape
 * list anywhere else.
 */

/** Round to 2dp for size readouts (local; the catalog is engine-pure data). */
const r2 = (n) => Math.round(n * 100) / 100

/**
 * Every shape, in display order. Fields:
 *   name     – the value stored in `render.mesh` / `collider.shape`.
 *   label    – human label for pickers.
 *   render   – true if it appears as a render-mesh primitive option.
 *   collider – true if it appears as a collider-shape option.
 *   dims     – collider dimension fields shown in the inspector for this shape
 *              (each { field, label, attr } — attr is the data-hf-* test hook).
 *   sizeText – (c) => string: the collider card's size readout for this shape.
 */
export const SHAPE_CATALOG = [
  {
    name: 'box',
    label: 'Box',
    render: true,
    collider: true,
    dims: [
      { field: 'hx', label: 'Half x', attr: 'data-hf-collider-x' },
      { field: 'hy', label: 'Half y', attr: 'data-hf-collider-y' },
      { field: 'hz', label: 'Half z', attr: 'data-hf-collider-z' },
    ],
    sizeText: (c) => `Full size: ${r2((c.hx ?? 0.5) * 2)} × ${r2((c.hy ?? 0.5) * 2)} × ${r2((c.hz ?? 0.5) * 2)}`,
  },
  {
    name: 'sphere',
    label: 'Sphere',
    render: true,
    collider: true,
    dims: [{ field: 'radius', label: 'Radius', attr: 'data-hf-collider-radius' }],
    sizeText: (c) => `Diameter: ${r2((c.radius ?? 0.5) * 2)}`,
  },
  {
    name: 'cylinder',
    label: 'Cylinder',
    render: true,
    collider: true,
    dims: [
      { field: 'radius', label: 'Radius', attr: 'data-hf-collider-radius' },
      { field: 'height', label: 'Height', attr: 'data-hf-collider-height' },
    ],
    sizeText: (c) => `Size: ${r2((c.radius ?? 0.5) * 2)} × ${r2(c.height ?? 1)} × ${r2((c.radius ?? 0.5) * 2)}`,
  },
  {
    name: 'plane',
    label: 'Plane',
    render: true,
    collider: false,
    dims: [],
    sizeText: () => 'Flat surface — no collider volume',
  },
  {
    name: 'pill',
    label: 'Pill (capsule)',
    // Both a render primitive AND a collider shape. UNIT RENDER GEOMETRY:
    // THREE.CapsuleGeometry(0.25, 0.5) — cap radius 0.25, mid-section
    // (cylindrical core) length 0.5, so TOTAL height = 0.5 + 2×0.25 = 1 and
    // full width = Ø0.5. Unlike box/cylinder/sphere, the unit pill is NOT
    // full-size-1 on every axis: with scale (1,1,1) it renders Ø0.5 × 1. The
    // pill COLLIDER's DEFAULT is deliberately aligned with that unit render
    // pill: radius 0.25, total height 1 — a radius-0.5 capsule at height 1
    // would be a degenerate sphere with zero mid-section. Sphere/cylinder
    // keep their 0.5 radius default (sphere r0.5 = unit Ø1 is correct).
    // Scale y = total height; rendered diameter = 0.5 × scale.x (physics
    // derives the analytic capsule from this documented unit size — see
    // shapeFromRender in physics.js).
    render: true,
    collider: true,
    dims: [
      { field: 'radius', label: 'Radius', attr: 'data-hf-collider-radius' },
      { field: 'height', label: 'Height (total)', attr: 'data-hf-collider-height' },
    ],
    sizeText: (c) => `Diameter ${r2((c.radius ?? 0.25) * 2)}, total height ${r2(c.height ?? 1)}`,
  },
  {
    name: 'cone',
    label: 'Cone',
    render: true,
    collider: true,
    dims: [],
    sizeText: () => 'Diameter 1 × height 1',
  },
  {
    name: 'torus',
    label: 'Torus',
    render: true,
    collider: true,
    dims: [],
    sizeText: () => 'Ring Ø1',
  },
  {
    name: 'torusKnot',
    label: 'Torus Knot',
    render: true,
    collider: true,
    dims: [],
    sizeText: () => 'Diameter 0.8',
  },
  {
    name: 'icosahedron',
    label: 'Icosahedron',
    render: true,
    collider: true,
    dims: [],
    sizeText: () => 'Diameter 1',
  },
  {
    name: 'dodecahedron',
    label: 'Dodecahedron',
    render: true,
    collider: true,
    dims: [],
    sizeText: () => 'Diameter 1',
  },
  {
    name: 'octahedron',
    label: 'Octahedron',
    render: true,
    collider: true,
    dims: [],
    sizeText: () => 'Diameter 1',
  },
  {
    name: 'tetrahedron',
    label: 'Tetrahedron',
    render: true,
    collider: true,
    dims: [],
    sizeText: () => 'Diameter 1',
  },
  {
    name: 'ring',
    label: 'Ring',
    render: true,
    collider: true,
    dims: [],
    sizeText: () => 'Inner 0.6 × outer 1',
  },
  {
    name: 'circle',
    label: 'Circle',
    render: true,
    collider: true,
    dims: [],
    sizeText: () => 'Diameter 1',
  },
  {
    name: 'lathe',
    label: 'Lathe',
    render: true,
    collider: true,
    dims: [],
    sizeText: () => 'Height 1 · Ø0.8',
  },
  {
    name: 'render',
    label: 'Match render mesh',
    render: false,
    collider: true,
    dims: [],
    sizeText: () => 'Auto — matches the render mesh',
  },
]

/** Names of shapes usable as a collider (`collider.shape`). */
export const COLLIDER_SHAPES = SHAPE_CATALOG.filter((s) => s.collider).map((s) => s.name)

/** Names of shapes usable as a render primitive (`render.mesh`). */
export const RENDER_PRIMITIVES = SHAPE_CATALOG.filter((s) => s.render).map((s) => s.name)

/** The catalog entry for a shape name, or undefined. */
export const shapeBy = (name) => SHAPE_CATALOG.find((s) => s.name === name)

/** Is `name` a valid collider shape? */
export const isColliderShape = (name) => COLLIDER_SHAPES.includes(name)

/** Is `name` a valid render primitive? */
export const isRenderPrimitive = (name) => RENDER_PRIMITIVES.includes(name)

/** Collider-shape picker options: [{ value, label }]. */
export const colliderShapeOptions = () =>
  SHAPE_CATALOG.filter((s) => s.collider).map((s) => ({ value: s.name, label: s.label }))

/** Render-primitive picker options: [{ value, label }] (label = "name (primitive)"). */
export const renderPrimitiveOptions = () =>
  SHAPE_CATALOG.filter((s) => s.render).map((s) => ({ value: s.name, label: `${s.name} (primitive)` }))
