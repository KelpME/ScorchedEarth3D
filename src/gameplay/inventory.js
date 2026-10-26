// S2 — per-player inventory model. PURE: no DOM, no engine imports.
// Doctrine: fail-noisy on missing/unknown data; every encoded rule cites its
// manual line (docs/manuals/scorched-earth-1.5-manual.txt); gaps from the
// manual are DOCUMENTED placeholders, never silent inventions.
//
// Manual anchors used here:
//  - L765-L772: max 99 of any item; partial-bundle remake at ~20% markup
//    (example: own 94 of $10,000/10 -> 5 more costs $6,000 not $5,000).
//  - L774-L776: Baby Missile unlimited supply ("you will always have 99") ->
//    modelled as Infinity qty, unbuyable/unsellable.
//  - L936-L938: "cost is given in dollars per bundle ... you have to buy in
//    multiples of [the bundle size]" -> cost is PER BUNDLE, buys bundleSize
//    rounds; qty must be a multiple of bundleSize.
//  - L862-L867: computer makes an offer per quantity; price varies with qty.
//  - L877: selling "usually" means a loss. NO fixed percentage exists in the
//    manual (economy.json selling.baseFactor === null) -> placeholder below.
//  - L2077-L2086: Weapons-menu Arms Level 0-4 (default 4) gates items.

const MAX_QTY = 99; // manual:L765

/** Bundle-remake markup at the 99-cap: the manual says "about 20%" (L772). */
const CAP_MARKUP = 1.2; // manual:L765-L772

/**
 * Placeholder sell price (manual gap — economy.json selling.baseFactor=null).
 * TODO-X: confirm when the multiplayer lobby AI buyer exists; the manual only
 * says the computer offers a price that varies with quantity (L862-L867) and
 * that you "usually accept a loss" (L877).
 * Per-round price = unitCost * (0.9 - 0.05*(qty-1)), clamped >= unitCost * 0.5.
 * unitCost = item.cost / item.bundleSize (manual:L936-L938).
 */
export const SELL_PLACEHOLDER = true;
export function sellPrice(item, qty) {
  if (!item || typeof item.cost !== 'number' || !(item.bundleSize > 0)) {
    throw new TypeError(`sellPrice: bad item record (need cost + bundleSize): ${JSON.stringify(item)}`);
  }
  if (!(qty >= 1)) throw new TypeError(`sellPrice: qty must be >= 1, got ${qty}`);
  const unitCost = item.cost / item.bundleSize;
  return Math.max(unitCost * (0.9 - 0.05 * (qty - 1)), unitCost * 0.5);
}

function requireItem(catalog, itemId) {
  const rec =
    catalog.weapons.find((w) => w.id === itemId) ||
    catalog.accessories.find((a) => a.id === itemId);
  if (!rec) throw new Error(`[se/inventory] unknown item id "${itemId}" — not in weapons/accessories catalog`);
  return rec;
}

export function createInventory({ cash, freeMarket = false, armsLevel = 4, catalog } = {}) {
  if (typeof cash !== 'number' || !Number.isFinite(cash) || cash < 0) {
    throw new TypeError(`[se/inventory] createInventory needs a finite non-negative numeric cash, got ${JSON.stringify(cash)}`);
  }
  if (!catalog || !Array.isArray(catalog.weapons) || !Array.isArray(catalog.accessories) ||
      catalog.weapons.length === 0 || catalog.accessories.length === 0) {
    throw new Error('[se/inventory] createInventory needs a catalog {weapons:[], accessories:[]} — refusing to run an empty store');
  }
  const arms = Number.isInteger(armsLevel) && armsLevel >= 0 && armsLevel <= 4
    ? armsLevel
    : (() => { throw new TypeError(`[se/inventory] armsLevel must be integer 0-4 (manual:L2077), got ${JSON.stringify(armsLevel)}`); })();

  const weapons = {};
  const accessories = {};
  for (const w of catalog.weapons) {
    // baby_missile = Infinity: manual:L774 "each player has an unlimited
    // supply of Baby Missiles" (the UI pins 99; we model true Infinity).
    weapons[w.id] = w.unlimited ? Infinity : 0;
  }
  for (const a of catalog.accessories) accessories[a.id] = 0;

  // freeMarket=true grants ALL weapons+accessories 10 rounds free.
  // NOTE / honest gap: the manual's Free Market option (L1782-L1795) is a
  // supply-and-demand pricing switch and says NOTHING about free items; the
  // brief orders this grant ("verify wording, cite line") — verified: no such
  // wording exists (grep of 'free' across the manual, L1782-L1818 region
  // included). Encoded as brief-mandated behavior with this citation note.
  if (freeMarket) {
    for (const w of catalog.weapons) if (!w.unlimited) weapons[w.id] = 10;
    for (const a of catalog.accessories) accessories[a.id] = 10;
  }

  const state = { cash, freeMarket, armsLevel, weapons, accessories };

  function findItem(itemId) { return requireItem(catalog, itemId); }

  /** Why this item cannot be bought right now, or null. 'arms' | 'cash' | null. */
  function buyBlock(itemId) {
    const item = findItem(itemId);
    if (item.unlimited) return null; // handled as 'no_buy' by buy()
    if (item.armsLevel > state.armsLevel) return 'arms'; // manual:L2077-L2086
    if (item.cost > state.cash) return 'cash'; // manual:L842-L846 shows/hides; we grey w/ reason
    return null;
  }

  return {
    get cash() { return state.cash; },
    /** credit(dollars): sole external mutation path for cash (applyInterest). */
    credit(amount) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        throw new TypeError(`[se/inventory] credit needs a finite number, got ${JSON.stringify(amount)}`);
      }
      state.cash += amount;
      return state.cash;
    },
    weapons: state.weapons,
    accessories: state.accessories,
    freeMarket: state.freeMarket,
    armsLevel: state.armsLevel,
    item: findItem,
    buyBlock,

    /**
     * buy(itemId, qty): qty = ROUNDS wanted, must be a multiple of
     * bundleSize (manual:L937 "buy in multiples of 10"). Price = bundleCost x
     * bundleCount (manual:L936 cost is per bundle). At the 99-cap the final
     * partial bundle is remade at ~20% markup (manual:L765-L772).
     */
    buy(itemId, qty = 1) {
      const item = findItem(itemId);
      if (item.unlimited) return { ok: false, reason: 'no_buy' }; // manual:L774-L776 always stocked
      if (!Number.isInteger(qty) || qty < 1) return { ok: false, reason: 'qty' };
      if (item.armsLevel > state.armsLevel) return { ok: false, reason: 'arms' }; // manual:L2077
      if (qty % item.bundleSize !== 0) return { ok: false, reason: 'bundle' }; // manual:L937
      const owned = state.weapons[itemId] ?? state.accessories[itemId] ?? 0;
      const room = MAX_QTY - owned; // manual:L765
      if (room <= 0) return { ok: false, reason: 'cap' };
      const wantBundles = qty / item.bundleSize;
      let rounds, cost;
      if (qty > room) {
        // Partial remake: only the fraction that fits is sold, remade bundle
        // repriced at ~20% markup (manual:L765-L772 example 94+10 -> 5 @ $6,000).
        rounds = room;
        cost = (item.cost / item.bundleSize) * rounds * CAP_MARKUP;
      } else {
        rounds = qty;
        cost = item.cost * wantBundles;
      }
      cost = Math.floor(cost); // dollars are whole; no manual rule -> floor (see economy.test note)
      if (cost > state.cash) return { ok: false, reason: 'cash' }; // fail-noisy
      state.cash -= cost;
      const map = item.kind !== undefined ? state.accessories : state.weapons;
      map[itemId] = owned + rounds;
      return { ok: true, cost, rounds };
    },

    /**
     * sell(itemId, qty): qty = ROUNDS, multiple of bundleSize; price per the
     * DOCUMENTED PLACEHOLDER sellPrice above (_placeholder:true flags the
     * manual gap). Gain floored to whole dollars. baby_missile unsellable
     * (manual:L774-L776, L798 "except Baby Missiles").
     */
    sell(itemId, qty = 1) {
      const item = findItem(itemId);
      if (item.unlimited) return { ok: false, reason: 'no_sell' }; // manual:L774, L798
      if (!Number.isInteger(qty) || qty < 1) return { ok: false, reason: 'qty' };
      if (qty % item.bundleSize !== 0) return { ok: false, reason: 'bundle' }; // manual:L937
      const map = item.kind !== undefined ? state.accessories : state.weapons;
      const owned = map[itemId] ?? 0;
      if (qty > owned) return { ok: false, reason: 'stock' };
      const price = sellPrice(item, qty); // per-round placeholder price
      const gained = Math.floor(price * qty); // manual states no rounding -> floor
      map[itemId] = owned - qty;
      state.cash += gained;
      return { ok: true, gained, price, _placeholder: SELL_PLACEHOLDER }; // TODO-X: confirm with lobby AI buyer
    },
  };
}
