// W11 (plan SE-BUG-1014, user: "the tank that died doesn't show the barrel
// moving when I aim it, in the second round") — FRONT BARREL SEGMENT RESTORE.
//
// ROOT CAUSE: barrel break (systems/lightning.js detachBarrel) DESTROYS the
// front barrel segment entity (`..._Barrel_Barrel001` — the visible mesh via
// render.node 'Barrel001'). The round boundary clears se.barrelBroken and
// resets maxPower, but the segment ENTITY was never restored — a rebuilt tank
// (full hull/alive from nextRound) aims an EMPTY Barrel wrapper: the wrapper
// rotates (aim_control still writes rot) but nothing visible moves on screen.
//
// Fix law: a ROUND RESET is a fresh tank (same law that resets hull/alive/
// maxPower at the boundary) — so any tank whose segment entity is missing gets
// it re-spawned from the tank archetype's OWN Barrel001 child def (model/node/
// nodePath are DATA, never JS literals). A tank with an intact segment is
// untouched. Fail-loud: a missing Barrel001 child def is a data gap and
// throws — no silent skip.

/** Iterative walk of the archetype children for the Barrel001 child def. */
export function barrel001Def(children) {
  const stack = [...(children || [])]
  while (stack.length > 0) {
    const n = stack.shift()
    if (n && n.name === 'Barrel001') return n
    if (n && Array.isArray(n.children)) stack.push(...n.children)
  }
  return null
}

/** The tank's Barrel node id: shortest subtree id ending '_Barrel' (skips the
 * '_Barrel_Barrel001' wrapper suffix). Same resolution law as lightning.js. */
export function barrelNodeIdFor(tankId, ids) {
  const prefix = `${tankId}_`
  return (ids || [])
    .filter((id) => id.startsWith(prefix) && id.endsWith('_Barrel') && !id.endsWith('_Barrel_Barrel001'))
    .sort((a, b) => a.length - b.length)[0] ?? null
}

/**
 * Restore every tank's missing front barrel segment from the archetype data.
 * api = { query, entity, spawn } (engine api or a fake — unit-pinnable).
 * @param {{ api: object, tankIds: string[], archetype: object, players?: Array }} args
 * @returns Array<{tankId, segId}> — tanks whose segment was re-spawned.
 * @throws when a broken tank has no Barrel001 child def in the archetype (data
 *   gap) — fail-loud, never a silent no-restore.
 */
export function restoreBarrelSegments({ api, tankIds, archetype, players = [] }) {
  if (!api || typeof api.query !== 'function' || typeof api.entity !== 'function' || typeof api.spawn !== 'function') {
    throw new TypeError('[se/barrelRestore] api.query/entity/spawn required')
  }
  const ids = [...api.query({})]
  const restored = []
  for (const tankId of tankIds || []) {
    const barrelId = barrelNodeIdFor(tankId, ids)
    if (!barrelId) continue // no rig: nothing to restore (scene-authored id-less hull)
    const segId = `${barrelId}_Barrel001`
    if (api.entity(segId)) continue // intact: untouched
    const def = barrel001Def(archetype?.children)
    if (!def) {
      throw new Error(`[se/barrelRestore] no Barrel001 child def in the tank archetype — ${tankId}'s broken barrel cannot be restored (data gap)`)
    }
    api.spawn(segId, {
      id: segId,
      name: 'Barrel001',
      parent: barrelId,
      archetypeId: archetype?.id ?? 'tank',
      components: {
        transform: JSON.parse(JSON.stringify(def.components?.transform ?? { x: 0, y: 0, z: 0 })),
        render: JSON.parse(JSON.stringify(def.components?.render ?? {})),
      },
    })
    const p = players.find((pl) => pl && pl.id === tankId)
    if (p) p.barrelBroken = false // stale per-player break flag: the round reset = fresh tank
    restored.push({ tankId, segId })
  }
  return restored
}
