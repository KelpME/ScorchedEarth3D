// Mirror of editor/src/scripts.js makeScript — game scripts export the EDITOR
// descriptor shape (update(state, dt, api, id, params)); the engine ScriptRegistry
// wants update(dt, api, id, params) with per-entity closure state.
export function toEngineDef(desc) {
  const state = new Map();
  return {
    params: desc.params || {},
    onAttach: (id) => { if (!state.has(id)) state.set(id, desc.init ? desc.init() : {}); },
    update: (dt, api, id, p) => {
      if (!state.has(id)) state.set(id, desc.init ? desc.init() : {});
      if (desc.update) desc.update(state.get(id), dt, api, id, p);
    },
    onDetach: (id) => { state.delete(id); if (desc.onDetach) desc.onDetach(id); },
  };
}
