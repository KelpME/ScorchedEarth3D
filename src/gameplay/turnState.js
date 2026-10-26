// S3D — per-game battle state. PURE: no DOM, no engine imports; every value
// deterministic (no Math.random). Doctrine: fail-noisy — unknown ids return
// {ok:false,reason} (never silent), bad constructor input throws.
//
// Consumes the S2 models verbatim: createInventory (src/gameplay/inventory.js,
// baby_missile = Infinity per manual:L774) and armsLevelForRound
// (src/gameplay/economy.js, static Arms Level 0-4, manual:L2077-L2086).
// The weapon RECORD (not just the id) is what the projectiles3d seam
// (se.weaponOverride) wants — selectedRecord() hands it out.

import { createInventory } from './inventory.js';
import { armsLevelForRound } from './economy.js';
import econData from '../../data/economy.json' with { type: 'json' };
import ppData from '../../data/physics-presets.json' with { type: 'json' };
import woData from '../../data/weapons-options.json' with { type: 'json' };

// W5 purge (plan SE-COMPLETE-1012 §4): the old `cash: 20000` / `hull: 100` JS
// literals are GONE — the battle seed + hull come from the DATA files
// (data/economy.json .battle.cashSeed, data/physics-presets.json
// .battle.maxHull). Malformed data fails LOUD naming the file — no JS
// fallback exists (doctrine).
function dataNum(doc, path, file) {
  const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TypeError(`[se/battle] ${file}:${path} missing/non-numeric — fix the data file, no JS fallback exists`);
  }
  return v;
}
const CASH_SEED = dataNum(econData, 'battle.cashSeed', 'data/economy.json');
const MAX_HULL = dataNum(ppData, 'battle.maxHull', 'data/physics-presets.json');

/**
 * defaultBattleGrant(weapons): the documented default seed every battle applies
 * — now DERIVED FROM DATA (W4-D, SE-COMPLETE-1012): each weapon row's
 * startingStock (data/weapons.json) becomes one grant entry; unlimited rows
 * (baby_missile, manual:L774-L776) are skipped because createInventory seeds
 * them Infinity itself. Fail-loud: a row without a valid startingStock, or a
 * non-bundle-multiple count (manual:L936-L937), throws — never silent.
 * cash is UNCHANGED by the grant: starting stock is an ISSUE, not a purchase
 * (the pre-W4-D grant bought through cash and left 8125 of the 20000 seed;
 * pins on that leftover are preserved by not deducting).
 * PURE + exported so the spec can pin the contents.
 */
export function defaultBattleGrant(weapons, overrides = {}) {
  const buys = [];
  const issues = [];
  const loud = (msg) => { issues.push(msg); console.error(msg); };
  const ovMap = overrides ?? {};
  for (const w of weapons ?? []) {
    let stock = w.startingStock;
    const ov = ovMap[w.id];
    if (ov !== undefined) {
      if (ov === 'unlimited' || (Number.isInteger(ov) && ov >= 0)) {
        stock = ov;
      } else {
        loud(`[se/battle] stored weapon_${w.id} override ${JSON.stringify(ov)} is junk ('unlimited' or a non-negative integer expected) — row ignored, catalog startingStock applies`);
      }
    }
    if (w.unlimited) {
      if (stock === 'unlimited') continue;
      // W6: a FINITE override on an unlimited weapon is a deliberate finite
      // seed (the enum offers 'unlimited' by default; any finite choice is
      // the user's). Bundle-multiple law still applies — junk fails loud and
      // the row is IGNORED (the weapon stays unlimited).
      if (stock % w.bundleSize !== 0) {
        loud(`[se/battle] stored weapon_${w.id}=${stock} is not a bundle multiple of ${w.bundleSize} — row ignored (weapon stays unlimited)`);
        continue;
      }
      buys.push({ itemId: w.id, qty: stock });
      continue;
    }
    if (!Number.isInteger(stock) || stock < 0) {
      throw new TypeError(`[se/battle] weapon "${w.id}" needs a non-negative integer startingStock (data/weapons.json), got ${JSON.stringify(stock)}`);
    }
    if (stock === 0) continue;
    if (stock % w.bundleSize !== 0) {
      throw new TypeError(`[se/battle] weapon "${w.id}" startingStock ${stock} is not a bundleSize ${w.bundleSize} multiple (manual:L936-L937)`);
    }
    buys.push({ itemId: w.id, qty: stock });
  }
  // W6: an override id with no catalog row fails loud + named, row ignored.
  for (const id of Object.keys(ovMap)) {
    if (!(weapons ?? []).some((w) => w.id === id)) {
      loud(`[se/battle] stored weapon_${id} overrides unknown weapon id — row ignored`);
    }
  }
  return { cash: CASH_SEED, buys, issues };
}

// W6 (SE-FIXUP-1012 item 4): stored weapon_<id> rows (data/weapons-options.json
// descriptors, persisted in localStorage 'se.settings') now SEED the battle
// grant — the user-set starting counts must reach the battle inventory. The
// ONLY pure seam for them is the settings bag passed into createBattle
// (createBattle is pure: no DOM, no localStorage). Validation is against the
// descriptors: unknown id / junk value fails loud + named and that row is
// IGNORED (never a silent clamp, never a silent drop).
export function startingStockOverridesFromSettings(settings = {}) {
  const overrides = {};
  const issues = [];
  const loud = (msg) => { issues.push(msg); console.error(msg); };
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (!key.startsWith('weapon_')) continue;
    const desc = woData.options?.[key];
    if (!desc || !Array.isArray(desc.enum)) {
      loud(`[se/battle] stored ${key} has no weapons-options descriptor — row ignored`);
      continue;
    }
    if (!desc.enum.includes(String(value))) {
      loud(`[se/battle] stored ${key}=${JSON.stringify(value)} is not a valid enum member (${desc.enum.join('|')}) — row ignored`);
      continue;
    }
    overrides[key.slice('weapon_'.length)] = value === 'unlimited' ? 'unlimited' : Number(value);
  }
  return { overrides, issues };
}

export function createBattle({ players, weapons, accessories, economy = {}, settings = null, startingStockOverrides = null } = {}) {
  if (!Array.isArray(players) || players.length === 0) {
    throw new TypeError(`[se/battle] createBattle needs a non-empty players array, got ${JSON.stringify(players)}`)
  }
  if (!Array.isArray(weapons) || weapons.length === 0) {
    throw new TypeError('[se/battle] createBattle needs the weapons catalog (data/weapons.json) — refusing to run a battle with no weapons')
  }
  if (!Array.isArray(accessories)) {
    throw new TypeError('[se/battle] createBattle needs the accessories catalog (data/accessories.json)')
  }
  const round = economy.round ?? 1
  const armsLevel = armsLevelForRound(round, { armsLevel: economy.armsLevel })
  // W6: stored weapon_* settings (or an explicit overrides map) seed the
  // grant — back-compat: no settings/overrides = the pure data-derived grant.
  let grantIssues = [];
  let overrides = startingStockOverrides;
  if (overrides == null && settings) {
    const derived = startingStockOverridesFromSettings(settings)
    overrides = derived.overrides
    grantIssues = derived.issues
  } else if (overrides == null) {
    overrides = {}
  }
  const grant = defaultBattleGrant(weapons, overrides) // W4-D data grant + W6 stored weapon_* overrides, fail-loud
  grantIssues = grantIssues.concat(grant.issues ?? [])
  const cash = economy.cash ?? grant.cash

  const WEAPONS = Object.fromEntries(weapons.map((w) => [w.id, w]))

  const list = players.map((p, i) => {
    const inventory = createInventory({ cash, freeMarket: economy.freeMarket ?? false, armsLevel, catalog: { weapons, accessories } })
    // W4-D: the grant is an ISSUE, not a purchase — quantities land straight in
    // the weapons map (ids are guaranteed by derivation from this same catalog;
    // cash is untouched, so the documented 8125 leftover of the 20000 seed is
    // preserved). freeMarket's blanket 10-round grant (createInventory) runs
    // BEFORE this assign, so data startingStock wins where both fire.
    for (const b of grant.buys) inventory.weapons[b.itemId] = b.qty
    return {
      id: `tank${i + 1}`,
      name: p.name || `Player ${i + 1}`,
      inventory,
      hull: MAX_HULL, // data: physics-presets .battle.maxHull (W5 purge)
      alive: true,
      color: p.color ?? null,
      isComputer: p.kind === 'computer', // W1-B: computersBuy gate at the round boundary (manual:L1776)
    }
  })

  const battle = {
    players: list,
    // Catalog in data/weapons.json order — the picker lists owned weapons in
    // this order (deterministic; inventory maps have no ordering contract).
    weaponCatalog: weapons,
    // W6: the overrides the grant honored + any loud issues (pin-able).
    startingStockOverrides: overrides,
    startingStockIssues: grantIssues,
    current: 0,
    round,
    armsLevel,
    // Selected weapon id per player (index-aligned). baby_missile default —
    // everyone owns Infinity of it (manual:L774).
    selectedWeapon: list.map(() => 'baby_missile'),
    lastChoose: null, // {ok, reason?, weaponId} — the picker shows blocked reasons

    /** Why weaponId cannot be selected for player i, applied atomically. */
    chooseWeapon(i, weaponId) {
      const res = battle.checkChoose(i, weaponId)
      battle.lastChoose = { ...res, weaponId }
      if (res.ok) battle.selectedWeapon[i] = weaponId
      return { ok: res.ok, ...(res.reason ? { reason: res.reason } : {}) }
    },

    /** Read-only gate: 'unknown' | 'dead' | 'arms' | 'ammo' | ok. */
    checkChoose(i, weaponId) {
      const p = list[i]
      if (!p) return { ok: false, reason: 'unknown_player' }
      const w = WEAPONS[weaponId]
      if (!w) return { ok: false, reason: 'unknown' } // accessories are NOT weapons
      if (!p.alive) return { ok: false, reason: 'dead' }
      if (w.armsLevel > armsLevel) return { ok: false, reason: 'arms' } // manual:L2077-L2086
      if (!(p.inventory.weapons[weaponId] > 0)) return { ok: false, reason: 'ammo' }
      return { ok: true }
    },

    /** Spend one round of ammo for player i (a shot the director accepted). */
    useAmmo(i, weaponId) {
      const p = list[i]
      if (!p) return { ok: false, reason: 'unknown_player' }
      if (!WEAPONS[weaponId]) return { ok: false, reason: 'unknown' }
      if (!p.alive) return { ok: false, reason: 'dead' }
      const map = p.inventory.weapons
      if (map[weaponId] === Infinity) return { ok: true, remaining: Infinity } // manual:L774 — untouched
      if (!(map[weaponId] > 0)) return { ok: false, reason: 'ammo' }
      map[weaponId] -= 1
      return { ok: true, remaining: map[weaponId] }
    },

    /** Advance to the NEXT ALIVE player (dead players are skipped). Returns new current. */
    nextTurn() {
      let n = battle.current
      for (let k = 0; k < list.length; k++) {
        n = (n + 1) % list.length
        if (list[n].alive) { battle.current = n; return n }
      }
      return battle.current // nobody else alive — current stays
    },

    /** The selected weapon RECORD for player i (the projectiles3d override seam). */
    selectedRecord(i) {
      const w = WEAPONS[battle.selectedWeapon[i ?? battle.current]]
      if (!w) {
        console.error(`[se/battle] selectedWeapon "${battle.selectedWeapon[i ?? battle.current]}" not in data/weapons.json — falling back to baby_missile`)
        return WEAPONS.baby_missile
      }
      return w
    },
  }
  return battle
}
