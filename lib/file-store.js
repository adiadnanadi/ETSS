// ════════════════════════════════════════════════════════════════════════════
// REZERVNO skladište: chunk-ovi u Firestore-u.
//
// Ne koristi se dok je Google Drive povezan. Služi da literatura ostane
// funkcionalna ako Drive privremeno nije dostupan (npr. istekao refresh token)
// i kao alternativa bez Google naloga.
//
// Uključivanje:  MATERIALS_STORE=firestore  (ili kao fallback u server.js)
// Isključivanje: FALLBACK_FIRESTORE=0
// ════════════════════════════════════════════════════════════════════════════

import { chunkBuffer, joinChunks, CHUNK_BYTES } from './materials.js';

const CHUNK_COLLECTION = 'chunks';
const MAX_BATCH_WRITES = 400;   // Firestore dozvoljava 500 po batch-u

export function createFirestoreStore(db, {
  chunkBytes = CHUNK_BYTES,
  cacheBytes = 64 * 1024 * 1024   // drži zadnje čitane fajlove u RAM-u
} = {}) {
  if (!db) throw new Error('Firestore nije dostupan');

  const chunksCol = (id) => db.collection('materials').doc(id).collection(CHUNK_COLLECTION);

  const cache    = new Map();   // id -> { buffer, bytes }  (Map čuva redoslijed = LRU)
  const inflight = new Map();   // id -> Promise<Buffer>    (spoji paralelne zahtjeve)
  let cacheUsed  = 0;

  function cacheGet(id) {
    const hit = cache.get(id);
    if (!hit) return null;
    cache.delete(id);           // bump na kraj (najsvježiji)
    cache.set(id, hit);
    return hit.buffer;
  }

  function cacheSet(id, buffer) {
    if (!buffer || buffer.length === 0 || buffer.length > cacheBytes) return;
    const prev = cache.get(id);
    if (prev) { cacheUsed -= prev.bytes; cache.delete(id); }
    cache.set(id, { buffer, bytes: buffer.length });
    cacheUsed += buffer.length;
    while (cacheUsed > cacheBytes && cache.size > 1) {
      const oldest = cache.keys().next().value;
      cacheUsed -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
  }

  function cacheDrop(id) {
    const prev = cache.get(id);
    if (prev) { cacheUsed -= prev.bytes; cache.delete(id); }
  }

  async function readChunks(id) {
    const snap = await chunksCol(id).get();
    if (!snap || snap.empty) return null;
    const docs = snap.docs
      .map(d => ({ i: Number(d.get('i') ?? 0), data: d.get('data') || '' }))
      .sort((a, b) => a.i - b.i);
    return joinChunks(docs.map(d => d.data));
  }

  async function removeChunks(id) {
    cacheDrop(id);
    for (;;) {
      const snap = await chunksCol(id).limit(MAX_BATCH_WRITES).get();
      if (!snap || snap.empty) return;
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      if (snap.size < MAX_BATCH_WRITES) return;
    }
  }

  async function writeChunks(id, buffer) {
    const parts = chunkBuffer(buffer, chunkBytes);
    try {
      for (let offset = 0; offset < parts.length; offset += MAX_BATCH_WRITES) {
        const batch = db.batch();
        parts.slice(offset, offset + MAX_BATCH_WRITES).forEach((data, k) => {
          const i = offset + k;
          batch.set(chunksCol(id).doc(String(i).padStart(6, '0')), { i, data });
        });
        await batch.commit();
      }
    } catch (e) {
      await removeChunks(id).catch(() => {});   // bez polovično upisanih fajlova
      throw e;
    }
    cacheSet(id, buffer);
    return { chunks: parts.length, chunkBytes };
  }

  // Vraća Buffer; istovremeni zahtjevi za isti fajl čekaju jedan čitač.
  async function readBuffer(id) {
    const cached = cacheGet(id);
    if (cached) return cached;

    const running = inflight.get(id);
    if (running) return running;

    const job = (async () => {
      const buf = await readChunks(id);
      if (buf && buf.length) cacheSet(id, buf);
      return buf;
    })().finally(() => inflight.delete(id));

    inflight.set(id, job);
    return job;
  }

  return {
    kind:   'firestore',
    label:  'Interna baza (Firestore)',
    mode:   'chunks',
    ready:  true,
    chunkBytes,

    async uploadMaterial({ materialId, buffer }) {
      const meta = await writeChunks(materialId, buffer);
      return { fileStore: 'firestore', ...meta };
    },

    async removeMaterial(material = {}) {
      const id = typeof material === 'string' ? material : material.id;
      if (id) await removeChunks(id);
    },

    read: (material) => readBuffer(typeof material === 'string' ? material : material.id),
    download: (material) => readBuffer(typeof material === 'string' ? material : material.id),

    linkFor: () => null,   // nema eksternog linka — ide kroz našu stranicu

    cacheStats() {
      return { entries: cache.size, bytes: cacheUsed, inflight: inflight.size };
    }
  };
}
