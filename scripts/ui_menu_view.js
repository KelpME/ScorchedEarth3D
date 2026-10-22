/**
 * ui_menu_view — PURE view model for the migrated ui_menu canvas
 * (CANVAS-MIGRATION 2026-10). No DOM: `computeMenu` consumes the live menu
 * feed (window.__se.menuFeed — written by main.js / src/ui/menu.js) plus the
 * context derived from the widget CHILDREN (labels ride the entities — see
 * ui_menu_bind) and returns the display state the bind script writes into the
 * widget components each step.
 *
 * Display laws (unchanged from the retired ui_menu_render DOM renderer):
 *   - the New Battle row's label is composed LIVE from the store (players /
 *     rounds counts) through the bind script's liveLabelTemplate PARAM — the
 *     template is archetype data, editor-editable, never a code literal.
 *   - a missing feed renders the authored defaults (never invented content).
 */

/**
 * PURE: feed + context -> view model. No DOM.
 * @param {object} feed  the live menu feed { open, version, players, rounds }.
 * @param {object} ctx   context derived from the widget children by the bind
 *   script: { version: string, rowPrefixes: {<action>: label}, template:
 *   string } (template = the liveLabelTemplate bind param).
 */
export function computeMenu(feed = {}, ctx = { version: '', rowPrefixes: {}, template: '' }) {
  const prefixOf = (action) => {
    const p = ctx.rowPrefixes ? ctx.rowPrefixes[action] : undefined
    return typeof p === 'string' ? p : ''
  }
  const fill = (template, label, players, rounds) =>
    String(template || '{label}')
      .replaceAll('{label}', label)
      .replaceAll('{players}', String(players))
      .replaceAll('{rounds}', String(rounds))
  const players = Number.isInteger(feed.players) && feed.players > 0 ? feed.players : null
  const rounds = Number.isInteger(feed.rounds) && feed.rounds >= 1 ? feed.rounds : null
  return {
    versionText: typeof feed.version === 'string' && feed.version ? feed.version : ctx.version,
    newBattleText:
      players && rounds
        ? fill(ctx.template, prefixOf('newbattle'), players, rounds)
        : prefixOf('newbattle'),
  }
}
