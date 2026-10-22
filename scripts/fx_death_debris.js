// W2-J — one ballistic tank-fragment of the cook-off / debris_burst death
// primitives (data/deaths.json). The spawner (src/gameplay/deaths.js
// spawnDeathDebris) sets the debris component {vx,vy,vz,age}; this script
// integrates gravity + motion, tumbles via yaw spin, and DESTROYS itself at
// life end (transient: no leaks). treeDebris-style radial impulse, iterative.
export default {
  name: 'fx_death_debris',
  label: 'FX death debris',
  description: 'One ballistic tank fragment: gravity drop + tumble, self-destroys at life end.',
  params: {
    life: { type: 'number', default: 2.5 },
    gravity: { type: 'number', default: 9.8 },
    tumbleDegPerSec: { type: 'number', default: 240 },
  },
  update(state, dt, api, id, params) {
    const rec = api.entity(id)
    if (!rec || !rec.components) return
    const d = rec.components.debris
    if (!d) return
    d.age = (d.age || 0) + dt
    if (d.age >= params.life) { api.world.destroy(id); return }
    const tr = rec.components.transform
    if (!tr) return
    d.vy -= params.gravity * dt
    tr.x += d.vx * dt
    tr.y += d.vy * dt
    tr.z += d.vz * dt
    tr.yaw = (tr.yaw ?? 0) + params.tumbleDegPerSec * dt // ballistic tumble
  },
}
