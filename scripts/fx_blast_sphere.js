// SE-FX — one sphere of the expanding blast series. The spawner
// (systems/projectiles3d.js spawnBlastSpheres) creates one entity per data
// entry in data/blast-fx.json, each carrying fx = { color, opacity, maxScale
// (= the blast's rWorld), delay, growSeconds, minScale } and this script.
// Lifecycle: invisible during delay -> grows minScale -> maxScale while
// opacity fades 1 -> 0 -> destroyed at full size (transient: no leaks).
// Colors are DATA (fx.color, applied via render.materialParams by the
// spawner); this script never hardcodes a color.
export default {
  name: 'fx_blast_sphere',
  label: 'FX blast sphere',
  description: 'One expanding, fading sphere of the blast series: grows from minScale to maxScale (the blast rWorld) while opacity fades to zero, then despawns.',
  params: {
    maxScale: { type: 'number', default: 2 },
    delay: { type: 'number', default: 0 },
    growSeconds: { type: 'number', default: 0.5 },
    minScale: { type: 'number', default: 0.05 },
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
    if (t <= 0) { // pre-delay stagger window: parked invisible at the blast point
      if (rec.components.transform) rec.components.transform.scale = [0.001, 0.001, 0.001]
      if (rec.components.render) rec.components.render.visible = false
      return
    }
    if (rec.components.render) rec.components.render.visible = true
    const g = Math.min(1, t / growSeconds)
    const s = minScale + (params.maxScale - minScale) * g
    if (rec.components.transform) rec.components.transform.scale = [s, s, s]
    fx.opacity = 1 - g // expanding -> more transparent, fully gone at max size
    if (g >= 1) api.world.destroy(id)
  },
}
