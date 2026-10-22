// S2 — round-based economy model. PURE: no DOM, no engine imports.
// Manual anchors (docs/manuals/scorched-earth-1.5-manual.txt):
//  - L1762-L1768: Interest Rate 0-.30, default .05 — "if you start a round
//    with unspent money in the bank, you earn interest on that money".
//  - L1776-L1780: Computers Buy ON/OFF — computer tanks can buy items.
//  - L1802-L1818: Scoring Mode BASIC/STANDARD/GREEDY — scoring consumed in
//    S5; here it is carried through roundEnd untouched (passthrough).
//  - L2077-L2086: Weapons-menu Arms Level 0-4, default 4 — a static config
//    option, NOT a round-varying ramp; armsLevelForRound encodes exactly that.
// Rounding: the manual never states how fractional interest/dollars are
// rounded -> FLOOR (toward zero), documented placeholder (no manual rule).

// Doctrine sweep (plan SE-COMPLETE-1012 §5, W1-B): the old INTEREST_RATE_
// DEFAULT/ARMS_LEVEL_DEFAULT JS literals are GONE — defaults are read from the
// data descriptors (data/economy.json options, data/weapons-options.json
// armsLevel). A malformed descriptor fails LOUD naming the file — no silent
// fallback literal survives.
import econData from '../../data/economy.json' with { type: 'json' };
import weaponsOptionsData from '../../data/weapons-options.json' with { type: 'json' };

function descriptorDefault(json, path, file, manualLine) {
  const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), json);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`[se/economy] descriptor default ${file}:${path} (${manualLine}) missing/non-numeric: ${JSON.stringify(v)} — fix the data file, no JS fallback exists`);
  }
  return v;
}
const INTEREST_RATE_DEFAULT = descriptorDefault(econData, 'options.interestRate.default', 'data/economy.json', 'manual:L1762');
const ARMS_LEVEL_DEFAULT = descriptorDefault(weaponsOptionsData, 'options.armsLevel.default', 'data/weapons-options.json', 'manual:L2077');

/**
 * applyInterest(inventory, rate): credit rate% of current cash, floored to
 * whole dollars (manual gives no rounding rule -> floor; see tests). Mutates
 * the inventory in place; returns the dollars earned.
 */
export function applyInterest(inventory, rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 0.3) {
    throw new TypeError(`[se/economy] applyInterest needs a numeric rate in 0-0.30 (manual:L1762), got ${JSON.stringify(rate)}`);
  }
  if (!inventory || typeof inventory.cash !== 'number') {
    throw new TypeError('[se/economy] applyInterest needs an inventory with numeric cash');
  }
  const earned = Math.floor(inventory.cash * rate); // floor: no manual rounding rule
  inventory.credit(earned);
  return earned;
}

/**
 * roundEnd(econState) -> NEW state { cash after interest, lastInterest,
 * scoringMode passthrough }. scoringMode (BASIC/STANDARD/GREEDY) affects
 * scoring in S5 only (manual:L1802-L1818) — carried, never interpreted here.
 */
export function roundEnd(econState) {
  if (!econState || typeof econState.cash !== 'number' || !Number.isFinite(econState.cash)) {
    throw new TypeError(`[se/economy] roundEnd needs {cash:number}, got ${JSON.stringify(econState)}`);
  }
  const rate = econState.interestRate ?? INTEREST_RATE_DEFAULT; // manual:L1762
  if (typeof rate !== 'number' || rate < 0 || rate > 0.3) {
    throw new TypeError(`[se/economy] interestRate out of 0-0.30 (manual:L1762): ${rate}`);
  }
  const lastInterest = Math.floor(econState.cash * rate); // floor: no manual rule
  return {
    ...econState,
    cash: econState.cash + lastInterest,
    lastInterest,
    // scoringMode passthrough (BASIC/STANDARD/GREEDY -> S5 scoring, manual:L1802-L1818)
  };
}

/**
 * Deterministic LCG (numerical recipes constants; NO Math.random):
 * same seed -> same plan. seed must be an integer.
 */
export function makeLcg(seed) {
  if (!Number.isInteger(seed)) throw new TypeError(`[se/economy] LCG seed must be an integer, got ${JSON.stringify(seed)}`);
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * computerBuyPlan(inventory, rngSeed, playOptions): deterministic purchase
 * plan for computer players when Computers Buy is on (manual:L1776-L1780).
 * SIMPLE strategy per the brief: buy the cheapest arms-legal weapons that fit
 * cash; baby_missile excluded (unlimited supply, manual:L774). Returns
 * [{itemId, rounds, cost}] — a PLAN; applying it is the caller's job.
 * computersBuy 'off' -> []. Unknown values fail loud.
 */
export function computerBuyPlan(inventory, rngSeed, playOptions = {}) {
  const cb = playOptions.computersBuy ?? 'on'; // manual:L1776 default ON
  if (cb !== 'on' && cb !== 'off') {
    throw new TypeError(`[se/economy] computersBuy must be 'on'|'off' (manual:L1776), got ${JSON.stringify(cb)}`);
  }
  if (cb === 'off') return [];
  if (!inventory || typeof inventory.buy !== 'function') {
    throw new TypeError('[se/economy] computerBuyPlan needs an inventory (createInventory result)');
  }
  const rng = makeLcg(rngSeed);
  const cash0 = inventory.cash;
  // Candidate pool: every weapon in the inventory's catalog that is arms-legal
  // and not baby_missile; sorted cheapest-bundle first, equal costs shuffled
  // deterministically by the LCG so plans aren't a static list order.
  const items = Object.keys(inventory.weapons)
    .concat(Object.keys(inventory.accessories ?? {}))
    .map((id) => inventory.item(id))
    .filter((it) => !it.unlimited && it.armsLevel <= inventory.armsLevel);
  // deterministic LCG jitter sort (Fisher-Yates then stable price sort)
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  items.sort((a, b) => a.cost - b.cost);

  const plan = [];
  let budget = cash0;
  for (const item of items) {
    const maxAffordable = Math.floor(budget / item.cost);
    if (maxAffordable < 1) continue;
    // Buy one full bundle per candidate (simple); cap keeps room for variety.
    const bundles = Math.min(maxAffordable, 1 + Math.floor(rng() * 2)); // 1-2 bundles
    const rounds = bundles * item.bundleSize;
    const cost = bundles * item.cost;
    plan.push({ itemId: item.id, rounds, cost });
    budget -= cost;
  }
  return plan;
}

/**
 * armsLevelForRound(round, playOptions): the manual's Arms Level (Play/Weapons
 * menu, manual:L2077-L2086) is a STATIC config option 0-4, default 4 — it does
 * NOT vary with the round number. So this returns the configured cap (or the
 * default) for any round. Kept as a function because the store takes its
 * allowed level from the round context; validated range 0-4, else fail loud.
 */
export function armsLevelForRound(round, playOptions = {}) {
  if (!Number.isInteger(round) || round < 1) {
    throw new TypeError(`[se/economy] armsLevelForRound needs round >= 1, got ${JSON.stringify(round)}`);
  }
  const lvl = playOptions.armsLevel ?? ARMS_LEVEL_DEFAULT; // manual:L2077, data/weapons-options.json
  if (!Number.isInteger(lvl) || lvl < 0 || lvl > 4) {
    throw new TypeError(`[se/economy] playOptions.armsLevel must be integer 0-4 (manual:L2077), got ${JSON.stringify(lvl)}`);
  }
  return lvl;
}

// ---------------------------------------------------------------------------
// W1-B — round-boundary economy + faithful Free Market (plan SE-COMPLETE-1012)
// ---------------------------------------------------------------------------

// SCORCH.MKT binary layout, reverse-engineered from the original DOS game's
// preset data files (SCORCH.MKT, 1060 bytes). Layout:
//   HEADER — 10 bytes:
//     u16 LE @0  : version, observed 2
//     u16 LE @2  : itemCount, observed 48 — equals the OG catalog size
//                  (33 weapons + 15 accessories = 48, data/weapons.json +
//                  data/accessories.json); mapping to item ids NOT established
//     u32 LE @4  : unknown, observed 275        (_placeholder)
//     u16 LE @8  : unknown, observed 43         (_placeholder)
//   RECORDS — N x 22 bytes, fixed stride 22 (verified: the recurring constant
//   f64 pattern repeats only at multiples of 22 across the file):
//     f64 LE @0  : fieldA, observed range 0.048-0.37 (_placeholder: market
//                  pressure / price multiplier coefficient)
//     f64 LE @8  : fieldB, observed range ~0-0.28, often exactly 0 (_placeholder:
//                  demand sensitivity)
//     u32 LE @16 : price, observed plausible dollar amounts 475-36205
//                  (incl. round 5000s) — the item's current market price
//     u16 LE @20 : fieldD, observed 0-43 WITH duplicates (47 records, 15
//                  distinct values) — NOT a 1:1 item index (_placeholder)
//   TRAILER — 16 bytes: f64 LE x2, observed 0.0946386005562562 and
//     0.0028247524899999983 (_placeholder: aggregate market state)
// Floats are IEEE 754 double precision, little-endian (proven: record bytes
// 9a 99 99 99 99 99 b9 3f == exactly 0.05, twice in one record).
// 1060 = 10 + 47*22 + 16 in the shipped file. Every _placeholder field is
// carried through verbatim and never interpreted.
/**
 * parseScorchMkt(buffer): parse the reversed SCORCH.MKT layout (see block
 * comment above). Fails loud naming the format on any structural violation.
 */
export function parseScorchMkt(buffer) {
  if (!buffer || typeof buffer.length !== 'number') {
    throw new TypeError('[se/economy] parseScorchMkt needs a Buffer/ArrayBuffer-like byte array');
  }
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const HEADER = 10, REC = 22, TRAILER = 16;
  if (b.length < HEADER + REC + TRAILER || (b.length - HEADER - TRAILER) % REC !== 0) {
    throw new TypeError(`[se/economy] parseScorchMkt: not a scorch.mkt image (need 10B header + N*22B records + 16B trailer, got ${b.length} bytes)`);
  }
  const records = [];
  for (let off = HEADER; off + REC <= b.length - TRAILER; off += REC) {
    records.push({
      fieldA: b.readDoubleLE(off),
      fieldB: b.readDoubleLE(off + 8),
      price: b.readUInt32LE(off + 16),
      fieldD: b.readUInt16LE(off + 20),
      _placeholder: ['fieldA', 'fieldB', 'fieldD'], // semantics not established from the OG binary
    });
  }
  return {
    header: {
      version: b.readUInt16LE(0),
      itemCount: b.readUInt16LE(2),
      u32Field: b.readUInt32LE(4), // _placeholder: unknown, observed 275
      u16Field: b.readUInt16LE(8), // _placeholder: unknown, observed 43
    },
    records,
    trailer: { x: b.readDoubleLE(b.length - TRAILER), y: b.readDoubleLE(b.length - TRAILER + 8) },
  };
}

// Drift magnitudes: W5 purge (plan SE-COMPLETE-1012 §4) — the old FM_* JS
// literals are GONE; the drift parameters are DATA (data/economy.json
// .freeMarketDrift; manual pins DIRECTIONS only, the values are _placeholder
// derived from the observed MKT ranges — provenance documented in the file).
// A malformed block fails LOUD naming the file — no JS fallback exists.
function fmNum(key) {
  const v = econData && econData.freeMarketDrift ? econData.freeMarketDrift[key] : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`[se/economy] data/economy.json .freeMarketDrift.${key} missing/non-numeric — fix the data file, no JS fallback exists`);
  }
  return v;
}
const FM_PRESSURE_DEFAULT = fmNum('pressureDefault');    // MKT fieldA observed median
const FM_SENSITIVITY_DEFAULT = fmNum('sensitivityDefault'); // MKT fieldB observed active values
const FM_DECAY = fmNum('decay');               // per-round decay of ignored items
const FM_FLOOR = fmNum('floor'), FM_CEIL = fmNum('ceil');  // bounded drift band around base price

/**
 * createMarketState({catalog, mkt}): per-item market {basePrice, price,
 * pressure, sensitivity, demand}. With an SCORCH.MKT image, record i seeds the
 * i-th catalog item ([...weapons, ...accessories] order) — MAPPING IS
 * _placeholder: the OG record->item ordering is not established (see layout
 * note above). Without mkt: prices start at the catalog base (item.cost).
 */
export function createMarketState({ catalog, mkt } = {}) {
  if (!catalog || !Array.isArray(catalog.weapons) || !Array.isArray(catalog.accessories)) {
    throw new TypeError('[se/economy] createMarketState needs a catalog {weapons, accessories}');
  }
  const items = new Map();
  const list = [...catalog.weapons, ...catalog.accessories];
  list.forEach((item, i) => {
    if (!item || typeof item.cost !== 'number' || item.cost <= 0) {
      throw new TypeError(`[se/economy] createMarketState: catalog item ${item && item.id} has no positive cost`);
    }
    const rec = mkt && Array.isArray(mkt.records) ? mkt.records[i] : null;
    items.set(item.id, {
      basePrice: item.cost,
      price: rec && rec.price > 0 ? rec.price : item.cost,
      pressure: rec && rec.fieldA > 0 && rec.fieldA < 1 ? rec.fieldA : FM_PRESSURE_DEFAULT,
      sensitivity: rec && rec.fieldB > 0 && rec.fieldB < 1 ? rec.fieldB : FM_SENSITIVITY_DEFAULT,
      demand: 0,
      _placeholder: Boolean(rec), // seeded from the OG binary's ambiguous record mapping
    });
  });
  return { items, priceOf: (id) => items.get(id)?.price ?? null };
}

/**
 * driftRound(market, {bought, rngSeed}): one round of Free Market drift
 * (manual:L1782-L1800 — directions pinned, magnitudes _placeholder). bought =
 * {itemId: unitsBought}. PURE — returns a NEW market state; deterministic via
 * makeLcg(rngSeed) jitter.
 *   demand'   : EWMA — demand*0.5 + units (damped demand level)
 *   bought    : price += floor(base * pressure * units)  (demand pushes up)
 *   ignored   : price -= floor(base * FM_DECAY)          (supply exceeds demand)
 *   reversion : price moves toward equilibrium base*(1 + pressure*demand')
 *               by (target - price) * sensitivity * 2 — the manual's damped
 *               "bouncing" toward the new equilibrium (L881-L887)
 * Clamped to [base*FM_FLOOR, base*FM_CEIL] (_placeholder band).
 */
export function driftRound(market, { bought = {}, rngSeed = 1 } = {}) {
  if (!market || !(market.items instanceof Map)) {
    throw new TypeError('[se/economy] driftRound needs a createMarketState result');
  }
  const rng = makeLcg(Number.isInteger(rngSeed) ? rngSeed : 1);
  const items = new Map();
  for (const [id, st] of market.items) {
    const units = bought[id] ?? 0;
    const demand = st.demand * 0.5 + units;
    let price = st.price;
    if (units > 0) price += Math.floor(st.basePrice * st.pressure * units);
    else price -= Math.floor(st.basePrice * FM_DECAY);
    const target = st.basePrice * (1 + st.pressure * demand);
    price += Math.round((target - price) * st.sensitivity * 2);
    price += Math.floor(rng() * 2); // bounded LCG jitter (0..1), deterministic
    const lo = Math.floor(st.basePrice * FM_FLOOR), hi = Math.floor(st.basePrice * FM_CEIL);
    price = Math.min(hi, Math.max(lo, price));
    items.set(id, { ...st, price, demand });
  }
  return { items, priceOf: (id) => items.get(id)?.price ?? null };
}

/**
 * roundBoundary({players, interestRate, computersBuy, rngSeed, market}):
 * the round-end economy pass, called where the director's endRound fires.
 *   1. interest: floor(cash * rate) credited per player (manual:L1762).
 *   2. computers buy: when computersBuy === 'on' (manual:L1776), each
 *      isComputer player runs computerBuyPlan through the REAL inventory
 *      (existing store flow: inventory.buy enforces arms/cash/bundle caps).
 *   3. market: when a free-market state is passed it drifts per round using
 *      the aggregate purchases as demand.
 * Returns { interest:{id:earned}, purchases:[{id,itemId,rounds,cost}],
 *           cash:{id:cashAfter}, market } — pure w.r.t. cash except the
 *   documented inventory.buy/credit mutations (the same contract as S2).
 */
export function roundBoundary({ players, interestRate = INTEREST_RATE_DEFAULT, computersBuy = 'on', rngSeed = 1, market = null } = {}) {
  if (!Array.isArray(players) || players.length === 0) {
    throw new TypeError('[se/economy] roundBoundary needs a non-empty players array');
  }
  const interest = {};
  for (const p of players) {
    if (!p || !p.inventory || typeof p.inventory.cash !== 'number') {
      throw new TypeError(`[se/economy] roundBoundary: player ${p && p.id} has no inventory with numeric cash`);
    }
    const rate = interestRate ?? INTEREST_RATE_DEFAULT;
    const earned = Math.floor(p.inventory.cash * rate); // floor: no manual rounding rule (L1762)
    p.inventory.credit(earned);
    interest[p.id] = earned;
  }
  const purchases = [];
  if (computersBuy === 'on') {
    players.forEach((p, i) => {
      if (!p.isComputer) return;
      const plan = computerBuyPlan(p.inventory, (Number.isInteger(rngSeed) ? rngSeed : 1) + i * 7919);
      for (const entry of plan) {
        const res = p.inventory.buy(entry.itemId, entry.rounds);
        if (res.ok) purchases.push({ id: p.id, itemId: entry.itemId, rounds: res.rounds, cost: res.cost });
      }
    });
  } else if (computersBuy !== 'off') {
    throw new TypeError(`[se/economy] roundBoundary computersBuy must be 'on'|'off' (manual:L1776), got ${JSON.stringify(computersBuy)}`);
  }
  let nextMarket = market;
  if (market) {
    const bought = {};
    for (const p of purchases) bought[p.itemId] = (bought[p.itemId] ?? 0) + p.rounds;
    nextMarket = driftRound(market, { bought, rngSeed: Number.isInteger(rngSeed) ? rngSeed : 1 });
  }
  const cash = Object.fromEntries(players.map((p) => [p.id, p.inventory.cash]));
  return { interest, purchases, cash, market: nextMarket };
}
