// Minimalna in-memory zamjena za Firestore — dovoljna za testiranje ruta.
// Podržava: collection().doc().get/set/update/delete, collection().get(),
// where(field,'==',value).limit(n).get(), podkolekcije i batch().

function matches(data, filters) {
  return filters.every(({ field, value }) => data?.[field] === value);
}

class DocRef {
  constructor(store, path) { this.store = store; this.path = path; }
  get id() { return this.path.split('/').pop(); }

  async get() {
    const data = this.store.docs.get(this.path);
    return {
      id: this.id,
      exists: data !== undefined,
      ref: this,
      data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data)))
    };
  }

  async set(data) { this.store.docs.set(this.path, JSON.parse(JSON.stringify(data))); return this; }

  async update(data) {
    const cur = this.store.docs.get(this.path);
    if (cur === undefined) throw new Error(`No document to update: ${this.path}`);
    this.store.docs.set(this.path, { ...cur, ...JSON.parse(JSON.stringify(data)) });
    return this;
  }

  async delete() { this.store.docs.delete(this.path); return this; }

  collection(name) { return new CollectionRef(this.store, `${this.path}/${name}`); }
}

class CollectionRef {
  constructor(store, path) { this.store = store; this.path = path; this._filters = []; this._limit = null; }

  doc(id) { return new DocRef(this.store, `${this.path}/${id}`); }

  where(field, op, value) {
    if (op !== '==') throw new Error('fake-firestore podržava samo ==');
    const q = new CollectionRef(this.store, this.path);
    q._filters = [...this._filters, { field, value }];
    q._limit = this._limit;
    return q;
  }

  limit(n) {
    const q = new CollectionRef(this.store, this.path);
    q._filters = [...this._filters];
    q._limit = n;
    return q;
  }

  async get() {
    const prefix = this.path + '/';
    let docs = [...this.store.docs.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, data]) => ({ id: p.split('/').pop(), data, ref: new DocRef(this.store, p) }))
      .filter(d => matches(d.data, this._filters));

    if (this._limit != null) docs = docs.slice(0, this._limit);

    return {
      empty: docs.length === 0,
      size: docs.length,
      docs: docs.map(d => ({
        id: d.id,
        ref: d.ref,
        exists: true,
        get: (f) => d.data[f],
        data: () => JSON.parse(JSON.stringify(d.data))
      })),
      forEach(fn) { docs.forEach(d => fn({ id: d.id, ref: d.ref, data: () => d.data })); }
    };
  }
}

export function fakeFirestore(seed = {}) {
  const store = { docs: new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])) };

  return {
    _store: store,
    collection: (name) => new CollectionRef(store, name),
    batch() {
      const ops = [];
      return {
        set:    (ref, data) => ops.push(() => ref.set(data)),
        update: (ref, data) => ops.push(() => ref.update(data)),
        delete: (ref)       => ops.push(() => ref.delete()),
        commit: async () => { for (const op of ops) await op(); return true; }
      };
    },
    // pomoćnik za testove
    dump(path) { return store.docs.get(path); }
  };
}
