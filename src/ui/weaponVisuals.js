// W2-E (plan SE-COMPLETE-1012) — weapons-visuals UI helpers. Pure model +
// DOM apply, all DATA-driven (data/weapons-options.json + data/weapons.json).
// Consumers: src/ui/store.js (uselessItems filter + row icons),
// src/ui/weaponPicker.js (picker icons + filter + tracePaths runtime wiring),
// src/ui/settings.js (bombIcon APPLY live-apply).
import weaponsOptions from '../../data/weapons-options.json' with { type: 'json' };

// ---- BOMB ICON (manual:L2088-L2093) ----------------------------------------
// The descriptor's enum drives the #top-weapon icon element's size from
// visual.sizesPx (DATA, pinned in unit tests). INVISIBLE removes the icon.

export function bombIconSizes() {
  const sizes = weaponsOptions.options.bombIcon?.visual?.sizesPx;
  if (!sizes || typeof sizes !== 'object' ||
      !('INVISIBLE' in sizes) || !('SMALL' in sizes) || !('BIG' in sizes)) {
    throw new Error('[se/weaponVisuals] weapons-options.json bombIcon.visual.sizesPx missing/incomplete — fail loud');
  }
  return sizes;
}

/** Enum value + sizes DATA -> { visible, px }. Unknown enum THROWS. */
export function bombIconSpec(value, sizes) {
  if (!sizes || typeof sizes !== 'object') {
    throw new Error('[se/weaponVisuals] bombIcon: sizes data missing (bombIcon.visual.sizesPx) — fail loud');
  }
  if (!(value in sizes)) {
    throw new Error(`[se/weaponVisuals] bombIcon: ${JSON.stringify(value)} is not one of INVISIBLE|SMALL|BIG — fail loud`);
  }
  const px = sizes[value];
  return { visible: px > 0, px };
}

/**
 * DOM apply: render the bomb icon inside #top-weapon per the spec. The icon
 * src is the descriptor's visual.icon (our own redraw glyph). Idempotent —
 * re-applies in place. Throws when #top-weapon is missing (fail-noisy).
 */
export function applyBombIcon(value, doc = document) {
  const spec = bombIconSpec(value, bombIconSizes());
  const slot = doc.getElementById('top-weapon');
  if (!slot) throw new Error('[se/weaponVisuals] #top-weapon missing — cannot apply bombIcon');
  let icon = doc.getElementById('top-weapon-bomb');
  if (!spec.visible) {
    if (icon) icon.remove();
    slot.dataset.bombIcon = 'INVISIBLE';
    return spec;
  }
  if (!icon) {
    icon = doc.createElement('img');
    icon.id = 'top-weapon-bomb';
    icon.alt = '';
    slot.prepend(icon);
  }
  icon.src = weaponsOptions.options.bombIcon.visual.icon;
  icon.dataset.bombIcon = value;
  icon.style.width = `${spec.px}px`;
  icon.style.height = `${spec.px}px`;
  icon.style.verticalAlign = '-2px';
  slot.dataset.bombIcon = value;
  return spec;
}

// ---- USELESS ITEMS filter (manual:L949-L953 via descriptor L2138-L2142) ----
/**
 * Pure filter for the store weapon column and the picker.
 *   mode 'off' (descriptor default; undefined) -> weapons the CURRENT player
 *        cannot use (blockedFn true — arms-level gating) are HIDDEN;
 *   mode 'on'  -> every row shown (blocked ones greyed by the caller).
 * Cash-blocked rows are NEVER hidden by this filter (doctrine: the user must
 * see WHY — the original hides, we grey; that deviation is the store's, not
 * this filter's).
 */
export function filterUselessWeapons(catalog, blockedFn, mode) {
  if (!Array.isArray(catalog)) throw new TypeError('[se/weaponVisuals] filterUselessWeapons: catalog must be an array');
  if (typeof blockedFn !== 'function') throw new TypeError('[se/weaponVisuals] filterUselessWeapons: blockedFn must be a function');
  if (mode !== undefined && mode !== 'on' && mode !== 'off') {
    throw new Error(`[se/weaponVisuals] uselessItems mode ${JSON.stringify(mode)} is not one of on|off — fail loud`);
  }
  const hideBlocked = mode !== 'on'; // 'off' AND undefined (descriptor default) hide
  return hideBlocked ? catalog.filter((w) => !blockedFn(w)) : catalog.slice();
}

// ---- Runtime settings read -------------------------------------------------
/** The live settings map: se.settings merged OVER localStorage 'se.settings'.
 * MERGE, not wholesale: se.settings may hold only battle-scoped keys
 * (turnMode/teams), and returning it alone shadows the persisted settings
 * (armsLevel, uselessItems, bombIcon...) — the store's W2-E filter then
 * silently reverts to defaults (weapons-visuals RED PIN, FPS-1012). */
export function settingsFor(target = (typeof window !== 'undefined' ? window : undefined)) {
  const se = target?.__se;
  let base = {};
  try {
    const raw = target?.localStorage?.getItem(['se', 'settings'].join('.'));
    if (raw) base = JSON.parse(raw);
  } catch { /* fall through */ }
  if (se?.settings && typeof se.settings === 'object') return { ...base, ...se.settings };
  return base;
}
