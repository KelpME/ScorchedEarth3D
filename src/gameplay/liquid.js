// W2-G (plan SE-COMPLETE-1012) — napalm pooling PURE model (no DOM, no THREE,
// no engine imports). The OG behavior (manual L1035-L1040): napalm "splashes
// around wherever it hits and then bursts into hot flame ... more heat ... if
// it forms deep pools." Model: a quantity field over the voxel grid; each
// settle pass moves every cell's EXCESS liquid (what does not fit under the
// pool-depth bound) to its LOWEST neighbour — so liquid flows downhill and
// accumulates in local minima (the OG pools), never deeper than the sill of
// its basin or the data maxDepth. Deterministic: fixed iteration order, ties
// broken by lowest index, no Math.random, no wall clock — same inputs give
// byte-identical pools. All magnitudes are DATA (data/physics-presets.json
// .liquid); this file carries no literals.
//
// Quantities are in abstract units; world pool depth = amount * depthPerUnit.

/**
 * A pool state over a W x Z grid. Amounts start at zero everywhere.
 */
export function createPoolState({ W, Z }) {
  if (!(W > 0) || !(Z > 0)) throw new TypeError('createPoolState: W and Z must be positive');
  return { W, Z, amount: new Float64Array(W * Z) };
}

export function inBounds(st, x, z) {
  return x >= 0 && z >= 0 && x < st.W && z < st.Z;
}

/** Dump `amount` liquid at cell (x, z). Ignored out of bounds (fail-quiet: caller logs). */
export function spill(st, x, z, amount) {
  if (!inBounds(st, x, z) || !(amount > 0)) return;
  st.amount[z * st.W + x] += amount;
}

export function total(st) {
  const arr = st && st.amount ? st.amount : st; // accepts a state or a raw amounts array
  let t = 0;
  for (const a of arr) t += a;
  return t;
}

/**
 * Capacity of cell (x,z): how much liquid it can hold before the rest must
 * move. Only a LOCAL MINIMUM holds liquid (the OG pools in low points): up to
 * its sill (lowest in-bounds neighbour top) or maxDepth, whichever is
 * shallower. Slope/flat cells hold nothing — their liquid flows downhill or
 * burns off. Out-of-bounds edges count as walls (they never lower a sill).
 * Pure: function of heights + data only.
 */
export function capacityAt(heights, W, Z, x, z, { maxDepth, depthPerUnit }) {
  const h = heights[z * W + x];
  let lowest = Infinity;
  let isMinimum = true;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= W || nz >= Z) continue; // edge = wall
      const nh = heights[nz * W + nx];
      if (nh < lowest) lowest = nh;
      if (nh < h) isMinimum = false;
    }
  }
  if (!isMinimum) return 0; // on a slope: nothing rests here
  if (lowest === Infinity) return maxDepth / depthPerUnit; // isolated cell: maxDepth only
  // Local minimum or plateau. A raised minimum is bounded by its sill (lowest
  // neighbour top); a flat cell (sill 0) pools up to maxDepth — flat crater
  // bottoms are the common in-game pool.
  const depth = lowest > h ? Math.min(maxDepth, lowest - h) : maxDepth;
  return depth / depthPerUnit;
}

/**
 * One settle: return a NEW amount array (pure — inputs untouched) after up to
 * `opts.settleIterations` downhill passes. Deterministic: cells scan in index
 * order; excess moves to the LOWEST neighbour, ties broken by lowest index.
 */
export function settle(st, heights, opts) {
  const { W, Z } = st;
  const { maxDepth, depthPerUnit, settleIterations } = opts;
  let amount = Float64Array.from(st.amount);
  for (let pass = 0; pass < settleIterations; pass++) {
    let moved = 0;
    const next = Float64Array.from(amount);
    for (let z = 0; z < Z; z++) {
      for (let x = 0; x < W; x++) {
        const i = z * W + x;
        const cap = capacityAt(heights, W, Z, x, z, { maxDepth, depthPerUnit });
        const excess = amount[i] - cap;
        if (excess <= 0) continue;
        // lowest neighbour, ties -> lowest index (deterministic)
        let bx = -1, bz = -1, bh = Infinity;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const nx = x + dx, nz = z + dz;
            if (nx < 0 || nz < 0 || nx >= W || nz >= Z) continue; // edges: nowhere to flow
            const nh = heights[nz * W + nx];
            if (nh < bh) { bh = nh; bx = nx; bz = nz; }
          }
        }
        if (bx >= 0 && bh < heights[i]) {
          next[i] -= excess;
          next[bz * W + bx] += excess;
          moved += excess;
        } else {
          next[i] -= excess; // overfilled local minimum: the overflow burns off (napalm is burning liquid)
        }
      }
    }
    amount = next;
    if (moved <= 1e-12) break; // equilibrium reached
  }
  return amount;
}

/** Pools burn down: quantity -> 0 at `burnPerSecond`, never negative. Mutates `amount` (the live sim field). */
export function burn(amount, dt, burnPerSecond) {
  const d = burnPerSecond * dt;
  for (let i = 0; i < amount.length; i++) {
    if (amount[i] <= 0) continue;
    amount[i] = Math.max(0, amount[i] - d);
  }
  return amount;
}

/** Pools above a minimum visible quantity, in scan order (deterministic for spawners/tests). */
export function poolList(amount, { W, Z }, minAmount = 1e-6) {
  const out = [];
  for (let z = 0; z < Z; z++) {
    for (let x = 0; x < W; x++) {
      const a = amount[z * W + x];
      if (a > minAmount) out.push({ x, z, amount: a });
    }
  }
  return out;
}
