// W2-J — one expanding GROUND RING of a death sequence (data/deaths.json
// 'ring' primitive). Same lifecycle contract as fx_blast_sphere: parked
// invisible during delay -> grows minScale -> maxScale while fx.opacity fades
// 1 -> 0 -> destroyed (transient, no leaks). Ring shape = y-flattened sphere
// (params.flat), the OG trig rings' 3D reading. Colors are DATA (fx.color).
export default {
  name: 'fx_death_ring',
  label: 'FX death ring',
  description: 'One expanding, y-flattened sphere: a ground-shock ring of a death sequence; fades to zero then despawns.',
  params: {
    maxScale: { type: 'number', default: 2 },
    delay: { type: 'number', default: 0 },
    growSeconds: { type: 'number', default: 0.9 },
    minScale: { type: 'number', default: 0.05 },
    flat: { type: 'number', default: 0.12 },
  },
  update(state, dt, api, id, params) {
    const rec = api.entity(id)
    if (!rec || !rec.components) return
    const fx = rec.components.fx
    if (!fx) return
    fx.age = (fx.age || 0) + dt
    const growSeconds = fx.growSeconds ?? params.growSeconds
    const minScale = fx.minScale ?? params.minScale
    const t = fx.age - (fx.delay ?? params.delay)
    if (t <= 0) {
      if (rec.components.transform) rec.components.transform.scale = [0.001, 0.001, 0.001]
      if (rec.components.render) rec.components.render.visible = false
      return
    }
    if (rec.components.render) rec.components.render.visible = true
    const g = Math.min(1, t / growSeconds)
    const s = minScale + (params.maxScale - minScale) * g
    if (rec.components.transform) rec.components.transform.scale = [s, s * (params.flat ?? 0.12), s]
    fx.opacity = 1 - g
    if (g >= 1) api.world.destroy(id)
  },
}
