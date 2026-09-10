// ════════════════════════════════════════════════════════════════════════════
// Registry skladišta fajlova.
//
// Materijal zna gdje mu je fajl (`fileStore` polje), pa se store traži po tom
// imenu. Ako polje ne postoji (stari materijali), koristi se prvi dostupni —
// ili Firebase Storage ako dokument ima `storagePath`.
//
// Svaki store ima isti minimalni interfejs:
//   kind                      → 'drive' | 'firestore' | 'storage'
//   label                     → ljudski naziv za UI
//   uploadMaterial({...})     → polja koja se upisuju u Firestore dokument
//   removeMaterial(material)  → briše fajl
//   streamTo(req,res,...)     → (opcionalno) servira fajl direktno
//   read(material) / read(id) → (opcionalno) vraća Buffer
// Plus opcionalno: linkFor, shareFile, syncMeta, ping, stats.
// ════════════════════════════════════════════════════════════════════════════

const registry = new Map();
const ordered  = [];

export function register(store, { priority = 10 } = {}) {
  if (!store || !store.kind) return null;
  store.priority = priority;
  registry.set(store.kind, store);
  const idx = ordered.findIndex(s => s.kind === store.kind);
  if (idx >= 0) ordered.splice(idx, 1);
  ordered.push(store);
  ordered.sort((a, b) => (a.priority || 50) - (b.priority || 50));
  return store;
}

export function resolveStore(name) {
  if (!name) return null;
  return registry.get(name) || null;
}

// Za konkretan materijal — koristi ono što piše u dokumentu.
export function storeForMaterial(material = {}) {
  if (material.fileStore) {
    const s = resolveStore(material.fileStore);
    if (s) return s;
  }
  if (material.storagePath) {
    const s = resolveStore('storage');
    if (s) return s;
  }
  return primaryStore();
}

export function primaryStore() {
  return ordered.find(s => s.ready !== false) || ordered[0] || null;
}

export function availableStores() {
  return ordered.map(s => ({
    kind:  s.kind,
    label: s.label || s.kind,
    mode:  s.mode || null,
    ready: s.ready !== false
  }));
}

export function storageSummary() {
  const active = primaryStore();
  return {
    activeKind:  active?.kind || null,
    activeLabel: active?.label || null,
    stores:      availableStores()
  };
}
