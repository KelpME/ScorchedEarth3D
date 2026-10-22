export default {
  name: 'fx_decay', label: 'FX decay',
  description: 'Expands + ages an fx entity, destroying it at end of life.',
  params: { maxScale: { type: 'number', default: 2.2 }, life: { type: 'number', default: 0.6 } },
  update(state, dt, api, id, params) {
    const rec = api.entity(id); if (!rec || !rec.components) return;
    const fx = rec.components.fx; if (!fx) return;
    fx.age = (fx.age || 0) + dt;
    const t = Math.min(1, fx.age / (fx.life ?? params.life));
    const s = 0.3 + (params.maxScale - 0.3) * t;
    if (rec.components.transform) rec.components.transform.scale = [s, s, s];
    if (t >= 1) api.world.destroy(id);
  },
};
