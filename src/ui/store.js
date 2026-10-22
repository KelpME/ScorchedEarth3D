// S2 — store screen (DOM only, no engine). mountStore(windowTarget) installs
// windowTarget.__store = { open(state), close() }; the panel builds itself and
// appends to document.body. Keyboard/button wiring to game flow is a later
// integration leaf.
//
// Fail-noisy: rows that cannot be bought are greyed WITH the reason as a
// tooltip + data-disabled-reason — NEVER hidden (the original hides them,
// manual:L842-L846; our doctrine says the user must see WHY — documented
// deviation). Prices/bundle sizes come straight from data/*.json (anchors
// manual:L959-L995 weapons, L1185-L1204 accessories). Bundle size semantics:
// cost is dollars PER BUNDLE, buying bundleSize rounds, in multiples of
// bundleSize (manual:L936-L938, L758-L760).
import { createInventory } from '../gameplay/inventory.js';
import { armsLevelForRound } from '../gameplay/economy.js';
import { loadData } from '../data/load.js';
import { filterUselessWeapons, settingsFor } from './weaponVisuals.js'; // W2-E
import { themeColor } from './theme.js';

const fmt = (n) => '$' + n.toLocaleString('en-US');

let panelEl = null;
let uselessMode = 'off'; // W2-E: descriptor default (manual:L2138-L2142)
let inv = null;
let els = null;

function style() {
  if (document.getElementById('se-store-style')) return;
  const s = document.createElement('style');
  s.id = 'se-store-style';
  // Retro palette matches the in-game HUD (index.html hud: ui-monospace on dark).
  s.textContent = `
    #se-store { position:fixed; inset:0; z-index:90; display:flex; align-items:center;
      justify-content:center; background:rgba(0,0,0,.65);
      font:13px/1.45 ui-monospace,monospace; color:${themeColor('text.body')}; }
    #se-store .sheet { width:min(980px,96vw); max-height:92vh; overflow:auto;
      background:${themeColor('panels.sheetBg')}; border:2px solid ${themeColor('panels.sheetBorder')}; box-shadow:0 0 0 2px #000, 6px 6px 0 #000; }
    #se-store header { display:flex; justify-content:space-between; padding:10px 14px;
      border-bottom:2px solid ${themeColor('panels.sheetBorder')}; background:${themeColor('panels.headerBg')}; letter-spacing:1px; }
    #se-store-cash { color:${themeColor('text.green')}; font-weight:bold; }
    #se-store .cols { display:flex; gap:0; }
    #se-store .col { flex:1; min-width:0; padding:8px 12px; }
    #se-store .col + .col { border-left:2px solid ${themeColor('rows.colDivider')}; }
    #se-store .col h3 { margin:2px 0 6px; color:${themeColor('text.green')}; font-size:12px;
      text-transform:uppercase; letter-spacing:2px; }
    #se-store .row { display:flex; align-items:center; gap:6px; padding:2px 4px;
      border-bottom:1px dotted ${themeColor('rows.dotted')}; }
    #se-store .row .row-icon { flex:0 0 16px; image-rendering:pixelated; }
    #se-store .row .nm { flex:1.4; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #se-store .row .cost { flex:0 0 72px; text-align:right; color:${themeColor('text.cash')}; }
    #se-store .row .bdl { flex:0 0 44px; text-align:right; color:${themeColor('text.dim')}; font-size:11px; }
    #se-store .row .owned { flex:0 0 30px; text-align:right; }
    #se-store .row button { font:inherit; background:${themeColor('buttons.actionBg')}; color:${themeColor('buttons.actionText')};
      border:1px solid ${themeColor('buttons.actionBorder')}; cursor:pointer; padding:0 5px; }
    #se-store .row button:disabled { color:${themeColor('buttons.disabledText')}; cursor:default; }
    #se-store .row.se-disabled { opacity:.45; }
    #se-store footer { display:flex; justify-content:flex-end; gap:10px; padding:10px 14px;
      border-top:2px solid ${themeColor('panels.sheetBorder')}; background:${themeColor('panels.headerBg')}; }
    #store-done { font:inherit; background:${themeColor('buttons.doneBg')}; color:${themeColor('buttons.doneText')}; border:2px solid ${themeColor('buttons.doneBorder')};
      padding:4px 22px; cursor:pointer; letter-spacing:2px; }
  `;
  document.head.appendChild(s);
}

function row(item) {
  const r = document.createElement('div');
  r.className = 'row';
  r.dataset.itemId = item.id;

  const owned = inv.weapons[item.id] !== undefined ? inv.weapons[item.id] : inv.accessories[item.id];
  const reason = item.unlimited ? 'unlimited' : inv.buyBlock(item.id);
  if (reason) {
    r.classList.add('se-disabled');
    r.dataset.disabledReason = reason;
    // tooltip names WHY (fail-noisy): manual anchors for cash/arms gating
    r.title = reason === 'arms'
      ? `arms level ${item.armsLevel} required (manual:L2077-L2086)`
      : reason === 'cash' ? 'not enough cash' : 'unlimited supply (manual:L774-L776)';
  }

  // W2-E: row icon = OUR OWN 16x16 redraw (data/weapons.json visual.icon).
  // W6: rows WITHOUT a visual (all 16 accessories, data/accessories.json)
  // must not request /undefined — no icon element, no 404.
  let icon = null;
  if (item.visual?.icon) {
    icon = document.createElement('img');
    icon.className = 'row-icon';
    icon.src = item.visual.icon;
    icon.alt = '';
    icon.width = 16; icon.height = 16;
  }

  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = item.name;
  const cost = document.createElement('span'); cost.className = 'cost'; cost.textContent = fmt(item.cost);
  const bdl = document.createElement('span'); bdl.className = 'bdl';
  // bundleSize = rounds per bundle bought at this cost (manual:L936-L938)
  bdl.textContent = `/x${item.bundleSize}`;
  const own = document.createElement('span'); own.className = 'owned';
  own.textContent = owned === Infinity ? '\u221e' : String(owned);
  if (icon) r.append(icon, nm, cost, bdl, own);
  else r.append(nm, cost, bdl, own);

  const mk = (act, label, qty) => {
    const b = document.createElement('button');
    b.dataset.act = act; b.textContent = label;
    if (reason) { b.disabled = true; }
    else if (act === 'buy5' && item.cost * 5 > inv.cash) { b.disabled = true; b.title = 'not enough cash'; }
    else if (act === 'sell' && !(owned >= item.bundleSize)) { b.disabled = true; b.title = 'nothing to sell'; }
    else b.addEventListener('click', () => doAction(item.id, act));
    r.appendChild(b);
  };
  if (!item.unlimited) {
    mk('buy1', 'Buy x1', 1); // one bundle (manual:L838 "purchase one bundle")
    mk('buy5', 'Buy x5', 5); // five bundles
    mk('sell', 'Sell', 1);   // one bundle back, placeholder sell price
  }
  return r;
}

function doAction(itemId, act) {
  const item = inv.item(itemId);
  const owned = inv.weapons[itemId] !== undefined ? inv.weapons[itemId] : inv.accessories[itemId];
  const res = act === 'sell'
    ? inv.sell(itemId, Math.min(item.bundleSize, owned))
    : inv.buy(itemId, (act === 'buy5' ? 5 : 1) * item.bundleSize);
  if (!res.ok) {
    console.error(`[se/store] ${act} ${itemId} rejected: ${res.reason}`); // fail-noisy, never silent
  }
  render();
}

function render() {
  els.cash.textContent = fmt(inv.cash);
  // W2-E uselessItems (manual:L949-L953): mode off hides weapons the CURRENT
  // player cannot use (arms-level gating via inv.buyBlock 'arms'); cash-blocked
  // rows stay visible (greyed, fail-noisy doctrine). Accessories unaffected.
  const weaponRows = filterUselessWeapons(
    catalogCache.weapons,
    (w) => inv.buyBlock(w.id) === 'arms',
    uselessMode,
  );
  for (const [listId, items] of [[els.weapons, weaponRows], [els.accessories, catalogCache.accessories]]) {
    listId.replaceChildren(...items.map(row));
  }
}

const catalogCache = { weapons: null, accessories: null };

export async function mountStore(windowTarget) {
  style();
  if (!catalogCache.weapons) {
    // loadData fails loud (names the missing file) — doctrine: no fallbacks.
    const [w, a] = await Promise.all([loadData('weapons'), loadData('accessories')]);
    catalogCache.weapons = w.weapons;
    catalogCache.accessories = a.accessories;
  }

  function open(state = {}) {
    if (typeof state.cash !== 'number' || !Number.isFinite(state.cash)) {
      console.error(`[se/store] open() needs {cash:number, round:number}, got ${JSON.stringify(state)}`);
      throw new TypeError('[se/store] open() requires numeric cash');
    }
    // W2-E: uselessItems mode — explicit state wins, else live settings
    // (se.settings / localStorage 'se.settings'), else descriptor default.
    uselessMode = state.uselessItems ?? settingsFor(windowTarget).uselessItems ?? 'off';
    const round = state.round ?? 1;
    const armsLevel = armsLevelForRound(round, state.playOptions ?? {}); // manual:L2077
    inv = createInventory({
      cash: state.cash,
      freeMarket: !!state.freeMarket,
      armsLevel,
      catalog: { weapons: catalogCache.weapons, accessories: catalogCache.accessories },
    });
    // W4-D (SE-COMPLETE-1012): the opener may seed the player's CURRENT owned
    // counts (battle startingStock / prior purchases). Fail-loud on unknown
    // ids — never silently dropped. No seed (e.g. store-screen standalone
    // mounts) behaves exactly as before: finite items start owned 0.
    const seed = (map, counts) => {
      for (const [id, n] of Object.entries(counts ?? {})) {
        // requireItem inside inv.item() throws on unknown ids — that IS the
        // fail-loud path (message names the id); let it propagate.
        inv.item(id);
        map[id] = n;
      }
    };
    seed(inv.weapons, state.weapons);
    seed(inv.accessories, state.accessories);

    close(); // one panel at a time
    panelEl = document.createElement('div');
    panelEl.id = 'se-store';
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    const header = document.createElement('header');
    // W6: 'STORE — <player>' when the opener names the player (per-player
    // sequential between-rounds turns); plain 'STORE' otherwise (back-compat
    // for the standalone store-screen path).
    const title = document.createElement('span');
    title.textContent = state.playerName ? `STORE — ${state.playerName}` : 'STORE';
    els = { cash: document.createElement('span') };
    els.cash.id = 'store-cash';
    header.append(title, els.cash);

    const cols = document.createElement('div'); cols.className = 'cols';
    const mkCol = (id, label, listKey) => {
      const c = document.createElement('div'); c.className = 'col'; c.id = id;
      const h = document.createElement('h3'); h.textContent = label;
      const list = document.createElement('div'); list.className = 'list';
      c.append(h, list);
      return [c, list];
    };
    const [wCol, wList] = mkCol('store-col-weapons', 'Weapons');
    const [aCol, aList] = mkCol('store-col-accessories', 'Accessories');
    cols.append(wCol, aCol);
    els.weapons = wList; els.accessories = aList;

    const footer = document.createElement('footer');
    const done = document.createElement('button');
    done.id = 'store-done'; done.textContent = 'DONE'; // manual:L848-L852
    done.addEventListener('click', () => close());
    footer.append(done);

    sheet.append(header, cols, footer);
    panelEl.appendChild(sheet);
    document.body.appendChild(panelEl);
    render();
  }

  function close() {
    if (panelEl) {
      const detail = inv ? {
        cash: inv.cash,
        weapons: { ...inv.weapons },
        accessories: { ...inv.accessories },
        freeMarket: inv.freeMarket,
        armsLevel: inv.armsLevel,
      } : null;
      panelEl.remove();
      panelEl = null;
      if (detail) {
        windowTarget.dispatchEvent(new CustomEvent('se-store-close', { detail }));
      }
    }
  }

  windowTarget.__store = { open, close };
}
