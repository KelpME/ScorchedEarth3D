// Pure 3D contact manifold generation: SAT over OBBs -> reference/incident
// face clipping -> 0-4 contact points with flip-stable canonical feature IDs.
// Self-contained on purpose: no imports from solver.js/physics.js, no module
// state, no mutation of input shapes.
//
// Contact point placement (midpoint bias): each reported point sits at the
// MIDPOINT between the two opposing face planes — half the penetration depth
// (pen/2) in from the reference surface, and equally pen/2 from the incident
// surface. This is symmetric under the A<->B swap (the same two planes bound
// the midpoint regardless of which body is reference), so a swap reproduces
// identical coordinates. The bias is bounded by the penetration depth: it
// never displaces a point by more than |sep| from either surface.

const EPS = 1e-9;
const SLOP = 0.005; // separation slop: contacts with sep > SLOP count as separated
// Clip/dedupe scale: Sutherland-Hodgman keeps vertices up to CLIP_EPS outside
// a clip plane, and dedupe merges points closer than CLIP_EPS. Both thresholds
// deliberately share ONE 1e-6 scale: clipping cannot emit a pair of corners
// closer than the scale dedupe merges, so no near-duplicate clipped corner
// survives the pipeline (a smaller clip epsilon would leave sub-1e-6 pairs
// that only dedupe catches; a larger dedupe would over-merge real corners).
const CLIP_EPS = 1e-6;

// ---------------------------------------------------------------------------
// Vector / matrix helpers (pure)
// ---------------------------------------------------------------------------

const v3 = (x, y, z) => ({ x, y, z });
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, s) => v3(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => v3(
  a.y * b.z - a.z * b.y,
  a.z * b.x - a.x * b.z,
  a.x * b.y - a.y * b.x
);
const len = (a) => Math.sqrt(dot(a, a));
const normalize = (a) => {
  const l = len(a);
  return l > EPS ? scale(a, 1 / l) : v3(0, 0, 0);
};

// Euler XYZ rotation -> orthonormal axis columns (THREE.Matrix4
// makeRotationFromEuler 'XYZ' convention: R = Rx(x) * Ry(y) * Rz(z)).
export function eulerAxes(rot) {
  if (!rot) return null;
  const a = Math.cos(rot.x || 0), b = Math.sin(rot.x || 0);
  const c = Math.cos(rot.y || 0), d = Math.sin(rot.y || 0);
  const e = Math.cos(rot.z || 0), f = Math.sin(rot.z || 0);
  // columns of the THREE 'XYZ' rotation matrix
  return [
    v3(c * e, a * f + b * e * d, b * f - a * e * d),
    v3(-c * f, a * e - b * f * d, b * e + a * f * d),
    v3(d, -b * c, a * c),
  ];
}

// Shape -> OBB {center, half, axes:[3]} without mutating the shape.
// Plain AABB boxes (no rot/half) become identity-axis OBBs so every box pair
// gets a geometric manifold. Meshes use cx/cy/cz + rot/half as in solver.js.
export function obbFromShape(shape) {
  const k = shape.kind || '';
  if (k === 'box' && shape.box) {
    const b = shape.box;
    return {
      center: v3(b.cx, b.cy, b.cz),
      half: v3(b.hx, b.hy, b.hz),
      axes: [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)],
    };
  }
  let center;
  let half;
  if (shape.half) {
    half = v3(shape.half.x, shape.half.y, shape.half.z);
  } else if (
    shape.minX !== undefined && shape.maxX !== undefined &&
    shape.minY !== undefined && shape.maxY !== undefined &&
    shape.minZ !== undefined && shape.maxZ !== undefined
  ) {
    half = v3(
      (shape.maxX - shape.minX) / 2,
      (shape.maxY - shape.minY) / 2,
      (shape.maxZ - shape.minZ) / 2
    );
  } else {
    const r = (shape.sphere && shape.sphere.radius) || shape.radius || 0.5;
    half = v3(r, r, r);
  }
  center = (shape.cx !== undefined)
    ? v3(shape.cx, shape.cy, shape.cz)
    : (shape.sphere && shape.sphere.x !== undefined)
      // P3.5 (2026-09-14): a SPHERE shape carries its center as sphere.x/y/z —
      // without this branch the sphere OBB fell to the 'half' last-resort
      // (degenerate box at (r,r,r)), so sphere-vs-box contacts computed
      // against a nonsense position: balls passed through boxes / rested
      // on an "invisible collider" in mid-air.
      ? v3(shape.sphere.x, shape.sphere.y, shape.sphere.z)
      : (shape.minX !== undefined && shape.maxX !== undefined)
      // W3 fix: a translated mesh shape carries BOUNDS but no cx — the old
      // fallback (center = half) placed the OBB at a nonsense position and
      // the SAT reported phantom −|half| separations. The bounds midpoint IS
      // the true center (translateShape keeps bounds/tris consistent).
      ? v3(
          (shape.minX + shape.maxX) / 2,
          (shape.minY + shape.maxY) / 2,
          (shape.minZ + shape.maxZ) / 2,
        )
      : half; // last resort: degenerate box at (hx,hy,hz)
  const axes = eulerAxes(shape.rot) || [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)];
  return { center, half, axes };
}

// World-space OBB corner (local sign triple).
function corner(obb, i, j, k) {
  return add(obb.center, add(
    scale(obb.axes[0], i * obb.half.x),
    add(scale(obb.axes[1], j * obb.half.y), scale(obb.axes[2], k * obb.half.z))
  ));
}

// ---------------------------------------------------------------------------
// SAT over 15 axes (6 face normals + 9 edge crosses)
// ---------------------------------------------------------------------------

// Returns { axis, depth, edge } where axis is oriented arbitrarily; edge is
// null for a face axis or {ia, ib} for the minimum edge cross.
export function satOBB(a, b) {
  let best = null;
  const consider = (axisRaw, edge, face) => {
    const l = len(axisRaw);
    if (l < EPS) return true; // degenerate cross -> skip, not separating
    const axis = scale(axisRaw, 1 / l);
    // project half extents of each box on the axis
    const ra = Math.abs(dot(a.axes[0], axis)) * a.half.x +
      Math.abs(dot(a.axes[1], axis)) * a.half.y +
      Math.abs(dot(a.axes[2], axis)) * a.half.z;
    const rb = Math.abs(dot(b.axes[0], axis)) * b.half.x +
      Math.abs(dot(b.axes[1], axis)) * b.half.y +
      Math.abs(dot(b.axes[2], axis)) * b.half.z;
    const dist = Math.abs(dot(sub(b.center, a.center), axis));
    const depth = ra + rb - dist; // > 0 while overlapping
    if (depth <= 0) return false; // separated on this axis
    if (!best || depth < best.depth - EPS) best = { axis, depth, edge, face };
    return true;
  };
  // Face axes carry their owner ({ body: 'a'|'b', axisIdx }) so the manifold
  // can derive the reference face from the SAT result instead of a
  // center-direction heuristic (which picks a side face when a small box sits
  // deep inside a large box's span — the floor|crate −5.5-sep bug).
  for (let i = 0; i < 3; i++) if (!consider(a.axes[i], null, { body: 'a', axisIdx: i })) return null;
  for (let i = 0; i < 3; i++) if (!consider(b.axes[i], null, { body: 'b', axisIdx: i })) return null;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (!consider(cross(a.axes[i], b.axes[j]), { ia: i, ib: j })) return null;
    }
  }
  return best; // null when fully separated on every axis
}

// Face bookkeeping: faceIndex = axis*2 + (positive ? 0 : 1) -> 'F0'..'F5'.
// Edge features use a symmetric canonical index min(ia,ib)*3 + max(ia,ib)
// so the SAME physical edge pair yields the SAME tag under A<->B swap.
function faceTag(axisIdx, positive) {
  return 'F' + (axisIdx * 2 + (positive ? 0 : 1));
}
function edgeTag(edge) {
  if (!edge) return null;
  const m = Math.min(edge.ia, edge.ib), M = Math.max(edge.ia, edge.ib);
  return 'E' + (m * 3 + M);
}

// Reference face: over all 6 faces of refOBB ONLY (the reference face is
// always a face of the candidate-reference body; the incident face lives on
// the other), the outward face normal best aligned with the direction toward
// the other body's center.
function pickReference(refOBB, incOBB) {
  const toOther = normalize(sub(incOBB.center, refOBB.center));
  let best = null;
  const consider = (body, axisIdx, positive) => {
    const n = scale(body.axes[axisIdx], positive ? 1 : -1);
    const s = dot(n, toOther);
    if (!best || s > best.score + EPS) {
      best = { body, axisIdx, positive, normal: n, score: s };
    }
  };
  for (let i = 0; i < 3; i++) {
    consider(refOBB, i, true);
    consider(refOBB, i, false);
  }
  best.tag = faceTag(best.axisIdx, best.positive);
  return best;
}

// Reference face on a KNOWN body/axis/sign — derived from the SAT minimum
// axis (unlike pickReference's center-direction heuristic). Reuses the same
// tag + quad construction as pickIncident so ids clip consistently.
function pickReferenceFace(obb, axisIdx, positive) {
  const n = scale(obb.axes[axisIdx], positive ? 1 : -1);
  const tag = faceTag(axisIdx, positive);
  const h = [obb.half.x, obb.half.y, obb.half.z];
  const t = [0, 1, 2].filter((a) => a !== axisIdx);
  const fc = add(obb.center, scale(n, h[axisIdx]));
  const u = obb.axes[t[0]], v = obb.axes[t[1]];
  const hu = h[t[0]], hv = h[t[1]];
  const quad = [];
  for (const su of [1, -1]) for (const sv of [1, -1]) {
    quad.push(add(fc, add(scale(u, su * hu), scale(v, sv * hv))));
  }
  const ordered = [quad[0], quad[1], quad[3], quad[2]];
  return { axisIdx, positive, normal: n, tag, center: fc, quad: ordered, score: 1 };
}

// Incident face on the other body: face normal most anti-parallel to ref normal.
function pickIncident(obb, refNormal) {
  let best = null;
  for (let i = 0; i < 3; i++) {
    for (const positive of [true, false]) {
      const n = scale(obb.axes[i], positive ? 1 : -1);
      const s = dot(n, refNormal);
      if (!best || s < best.score - EPS) best = { axisIdx: i, positive, normal: n, score: s };
    }
  }
  best.tag = faceTag(best.axisIdx, best.positive);
  // face polygon as an ordered quad
  const h = [obb.half.x, obb.half.y, obb.half.z];
  const t = [0, 1, 2].filter((a) => a !== best.axisIdx);
  const fc = add(obb.center, scale(best.normal, h[best.axisIdx]));
  const u = obb.axes[t[0]], v = obb.axes[t[1]];
  const hu = h[t[0]], hv = h[t[1]];
  const sgn = [1, -1];
  const quad = [];
  for (const su of sgn) for (const sv of sgn) {
    quad.push(add(fc, add(scale(u, su * hu), scale(v, sv * hv))));
  }
  // reorder to a proper ring: (+,+), (+,-), (-,-), (-,+)
  const ordered = [quad[0], quad[1], quad[3], quad[2]];
  return { ...best, center: fc, quad: ordered };
}

// Sutherland-Hodgman: clip polygon against plane keep dot(n,p) <= d.
// CLIP_EPS (not EPS): same 1e-6 scale as the dedupe pass below — see the
// comment at CLIP_EPS's declaration for why the two must share a scale.
function clipPlane(poly, n, d) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = dot(p, n) - d, dq = dot(q, n) - d;
    if (dp <= CLIP_EPS) out.push(p);
    if ((dp < -CLIP_EPS && dq > CLIP_EPS) || (dp > CLIP_EPS && dq < -CLIP_EPS)) {
      const t = dp / (dp - dq);
      out.push(add(p, scale(sub(q, p), t)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OBB vs OBB manifold
// ---------------------------------------------------------------------------

function obbManifold(a, b, ca, cb) {
  const sat = satOBB(a, b);
  if (!sat) return null; // separated

  // Normal A -> B: SAT axis oriented along center difference.
  let normal = sat.axis;
  if (dot(normal, sub(cb.center, ca.center)) < 0) normal = scale(normal, -1);

  // Reference / incident faces. The reference face comes FROM THE SAT RESULT:
  // the face owning the minimum-penetration axis, on whichever body owns that
  // axis. A center-direction heuristic is wrong when a small body sits deep
  // inside a large body's lateral span (floor|crate picked the floor's SIDE
  // face → sep −5.5 phantom). Flip-tolerance: the ± face whose normal points
  // AGAINST the other body's center is the contact face.
  let ref, inc, refIsA, refOBB, incOBB;
  if (sat.face && !sat.edge) {
    const owner = sat.face.body === 'a' ? a : b;
    const other = sat.face.body === 'a' ? b : a;
    const toOther = sub(other.center, owner.center);
    const positive = dot(owner.axes[sat.face.axisIdx], toOther) >= 0;
    const refN = scale(owner.axes[sat.face.axisIdx], positive ? 1 : -1);
    const r = pickReferenceFace(owner, sat.face.axisIdx, positive);
    ref = r; refOBB = owner; refIsA = sat.face.body === 'a';
    inc = pickIncident(other, ref.normal);
    incOBB = other;
  } else {
    // EDGE-cross minimum axis: no single owning face — fall back to the
    // center-direction heuristic for the clipping frame (points will still be
    // flip-symmetric via the midpoint projection).
    const refA = pickReference(a, b);
    const refB = pickReference(b, a);
    if (refA.score >= refB.score) {
      ref = refA; inc = pickIncident(b, ref.normal); refIsA = true; refOBB = a; incOBB = b;
    } else {
      ref = refB; inc = pickIncident(a, ref.normal); refIsA = false; refOBB = b; incOBB = a;
    }
  }

  // Reference face plane point.
  const h = [refOBB.half.x, refOBB.half.y, refOBB.half.z];
  const facePoint = add(refOBB.center, scale(ref.normal, h[ref.axisIdx]));

  // Side planes of the reference face (its two tangent axes, both signs).
  const tAxes = [0, 1, 2].filter((i) => i !== ref.axisIdx);
  const planes = [];
  for (const t of tAxes) {
    const n = refOBB.axes[t];
    const bound = dot(n, refOBB.center) + h[t];
    planes.push([n, bound], [scale(n, -1), -dot(n, refOBB.center) + h[t]]);
  }

  // Clip the incident quad against the 4 side planes.
  let poly = inc.quad;
  for (const [n, d] of planes) {
    poly = clipPlane(poly, n, d);
    if (poly.length === 0) break;
  }

  // Keep points at/below the reference face surface (sep <= SLOP).
  const kept = [];
  for (const p of poly) {
    const sep = dot(ref.normal, sub(p, facePoint));
    if (sep <= SLOP) kept.push({ p, sep });
  }
  if (kept.length === 0) return null;

  // Deduplicate near-identical points at the CLIP_EPS scale (1e-6) so pairs
  // of clipped corners closer than the clip epsilon cannot survive as two.
  const uniq = [];
  for (const k of kept) {
    if (!uniq.some((u) => len(sub(u.p, k.p)) < CLIP_EPS)) uniq.push(k);
  }
  if (uniq.length === 0) return null;

  // Reduce to <= 4: deepest first, tie-broken by coordinates (deterministic).
  uniq.sort((u, v) => (u.sep - v.sep) || cmpVec(u.p, v.p));
  const four = uniq.slice(0, 4);

  // Canonical ordering: sort by world position so point order (and the
  // role index baked into ids) is invariant under A<->B swaps.
  four.sort((u, v) => cmpVec(u.p, v.p));

  // Flip-stable feature tags: sorted multiset {refTag, incTag}; the edge flag
  // (whether the SAT min axis was an edge cross) goes into the role.
  const tags = [ref.tag, inc.tag].sort();
  const kind = sat.edge ? 'edge-edge' : 'face-face';
  const featureRef = ref.tag, featureInc = inc.tag;

  let pi = 0;
  const points = four.map((k) => {
    // Flip-stable contact point: the midpoint of the incident point and its
    // projection on the reference face plane. Averaging is symmetric under
    // A<->B (the same two planes are used whichever body is reference), so
    // the same physical contact yields identical coordinates either way.
    const proj = sub(k.p, scale(ref.normal, dot(ref.normal, sub(k.p, facePoint))));
    const pp = scale(add(k.p, proj), 0.5);
    return {
      px: pp.x, py: pp.y, pz: pp.z,
      sep: k.sep,
      id: `${tags[0]}|${tags[1]}|${kind}:${pi++}`,
      featureA: refIsA ? featureRef : featureInc,
      featureB: refIsA ? featureInc : featureRef,
    };
  });
  // Final deterministic order: by id (then coordinates for identical ids).
  points.sort((u, v) => (u.id < v.id ? -1 : u.id > v.id ? 1 : 0));

  return { normal, pointCount: points.length, points };
}

function cmpVec(u, v) {
  return (u.x - v.x) || (u.y - v.y) || (u.z - v.z) || 0;
}

// ---------------------------------------------------------------------------
// Curved dispatch
// ---------------------------------------------------------------------------

function sphereOf(shape) {
  if (shape.kind === 'sphere' && shape.sphere) return shape.sphere.radius;
  if (shape.radius) return shape.radius;
  return null;
}

// Sphere vs OBB: closest point on the box surface to the sphere center.
function sphereVsOBB(sc, r, obb) {
  // local coordinates of the sphere center in the OBB frame
  const d = sub(sc, obb.center);
  const local = [dot(d, obb.axes[0]), dot(d, obb.axes[1]), dot(d, obb.axes[2])];
  const h = [obb.half.x, obb.half.y, obb.half.z];
  const clamped = local.map((c, i) => Math.max(-h[i], Math.min(h[i], c)));
  const inside = local.every((c, i) => Math.abs(c) <= h[i]);
  // world-space closest surface point
  let closest = obb.center;
  for (let i = 0; i < 3; i++) closest = add(closest, scale(obb.axes[i], clamped[i]));

  let sep, point, faceTagStr;
  if (!inside) {
    const diff = sub(sc, closest);
    const dist = len(diff);
    sep = dist - r;
    point = closest;
    // feature: face(s) the closest point lies on
    const fi = local.findIndex((c, i) => Math.abs(Math.abs(c) - h[i]) < 1e-7);
    faceTagStr = fi >= 0 ? faceTag(fi, local[fi] > 0) : 'F0';
  } else {
    // center inside: deepest axis of minimum penetration
    let bi = 0, bd = Infinity;
    for (let i = 0; i < 3; i++) {
      const pen = h[i] - Math.abs(local[i]);
      if (pen < bd) { bd = pen; bi = i; }
    }
    const sgn = local[bi] >= 0 ? 1 : -1;
    point = add(obb.center, scale(obb.axes[bi], sgn * h[bi]));
    sep = -bd - r;
    faceTagStr = faceTag(bi, sgn > 0);
  }
  return { sep, point, boxTag: faceTagStr };
}

function sphereBoxManifold(sa, sb, sphereIsA) {
  const r = sphereOf(sa);
  const boxOBB = obbFromShape(sb);
  const sphereCenter = sphereCenterOf(sa);
  const res = sphereVsOBB(sphereCenter, r, boxOBB);
  if (res.sep > SLOP) return null;
  // normal A -> B: toward the box if the sphere is A, away from it if not.
  const normal = sphereIsA
    ? normalize(sub(res.point, sphereCenter))
    : normalize(sub(sphereCenter, res.point));
  const tags = ['S', res.boxTag].sort();
  const id = `${tags[0]}|${tags[1]}|sphere-box:0`;
  const point = res.point;
  const featureA = sphereIsA ? 'S' : res.boxTag;
  const featureB = sphereIsA ? res.boxTag : 'S';
  return {
    normal,
    pointCount: 1,
    points: [{ px: point.x, py: point.y, pz: point.z, sep: res.sep, id, featureA, featureB }],
  };
}

function sphereCenterOf(shape) {
  const o = obbFromShape(shape);
  return o.center;
}

function sphereSphereManifold(sa, sb) {
  const rA = sphereOf(sa), rB = sphereOf(sb);
  const cA = sphereCenterOf(sa), cB = sphereCenterOf(sb);
  const diff = sub(cB, cA);
  const dist = len(diff);
  const sep = dist - rA - rB;
  if (sep > SLOP) return null;
  let normal = dist > EPS ? scale(diff, 1 / dist) : v3(0, 1, 0);
  const mid = scale(add(cA, cB), 0.5);
  return {
    normal,
    pointCount: 1,
    points: [{ px: mid.x, py: mid.y, pz: mid.z, sep, id: 'S|S|sphere-sphere:0', featureA: 'S', featureB: 'S' }],
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// contactManifold(sa, sb) -> { normal:{x,y,z} (A->B), pointCount, points:
//   [{px,py,pz, sep, id, featureA, featureB}] } or null when separated
// (sep > 0 beyond slop 0.005). Pure: reads shapes, mutates nothing.
export function contactManifold(sa, sb) {
  const sA = sphereOf(sa) != null;
  const sB = sphereOf(sb) != null;
  if (sA && sB) return sphereSphereManifold(sa, sb);
  if (sA) return sphereBoxManifold(sa, sb, true);
  if (sB) return sphereBoxManifold(sb, sa, false);
  const a = obbFromShape(sa), b = obbFromShape(sb);
  return obbManifold(a, b, a, b);
}
