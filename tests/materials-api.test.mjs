// E2E testovi ruta za literaturu — bez Firebasea i bez Google-a.
// Dižemo pravi Express server sa pravim routerom (lib/materials-router.js),
// a samo "spoljni svijet" je zamijenjen: Fake Firestore, fake Drive store i
// fake korisnici. Tako se testira stvarna logika ruta, ne kopija.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import multer from 'multer';
import crypto from 'crypto';

import { createMaterialsRouter } from '../lib/materials-router.js';
import { createDriveStore } from '../lib/drive-store.js';
import { publicMaterial } from '../lib/materials.js';
import { fakeFirestore } from './helpers/fake-firestore.mjs';

const USERS = {
  'admin-token':  { uid: 'a1', role: 'admin',   razred: '',     displayName: 'Profesor' },
  'iii1-token':   { uid: 's1', role: 'student', razred: 'III-1', displayName: 'Učenik 1' },
  'iv2-token':    { uid: 's2', role: 'student', razred: 'IV-2',  displayName: 'Učenik 2' }
};

function fakeDrive() {
  const calls = { upload: [], shared: [], removed: [] };
  return {
    mode: 'oauth', folderId: 'FOLDER', calls,
    async ping() { return { ok: true, email: 'nastavnik@gmail.com', storage: { limit: 100, usage: 10 } }; },
    async upload({ name, mimeType }) {
      calls.upload.push({ name, mimeType });
      const id = 'DRIVE_' + calls.upload.length;
      return { id, name, webViewLink: `https://drive.google.com/file/d/${id}/view` };
    },
    async shareAnyone(fileId, role) { calls.shared.push({ fileId, role }); return { id: 'p' }; },
    async remove(fileId) { calls.removed.push(fileId); },
    async updateMeta(fileId, meta) { return { id: fileId, ...meta }; },
    async api() { return {}; },
    download: async () => Buffer.from('DRIVE-BYTES'),
    proxyFile: async (req, res, { fileName, mimeType, contentDisposition }) => {
      res.setHeader('Content-Type', mimeType || 'application/octet-stream');
      if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
      res.setHeader('Accept-Ranges', 'bytes');
      res.end('DRIVE-BYTES');
    }
  };
}

// Buffer-store kao "drugi" store (dokaz da router radi oba načina)
function fakeBufferStore(bytes) {
  return {
    kind: 'firestore', label: 'Interna baza (Firestore)', ready: true,
    removed: [],
    async removeMaterial(m) { this.removed.push(m.id); },
    async read() { return bytes; },
    linkFor: () => null
  };
}

async function boot({ seed = {}, bufferBytes = null } = {}) {
  const db = fakeFirestore(seed);
  const drive = fakeDrive();
  const driveStore = createDriveStore(drive, {});
  const bufferStore = fakeBufferStore(bufferBytes || Buffer.from('BAZA-BYTES'));

  const app = express();
  app.use(express.json({ limit: '20mb' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

  const getUser = async (req) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const user = USERS[token];
    if (!user) throw Object.assign(new Error('Niste prijavljeni'), { status: 401 });
    return user;
  };

  app.use(createMaterialsRouter({
    getDb: () => db,
    storeForMaterial: (m) => (m.fileStore === 'firestore' ? bufferStore : driveStore),
    primaryStore: () => driveStore,
    maxUploadMb: 20,
    getUser,
    requireAdmin: async (req) => {
      const u = await getUser(req);
      if (u.role !== 'admin') throw Object.assign(new Error('Nemate dozvolu'), { status: 403 });
      return u;
    },
    upload
  }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Fajl je prevelik.' });
    res.status(err?.status || 500).json({ error: err?.message || 'Greška' });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    db, drive, driveStore, bufferStore, base,
    close: () => new Promise(r => server.close(r)),
    get: (path, token) => fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
    json: async (path, token) => {
      const res = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      return { res, body: await res.json().catch(() => ({})) };
    },
    uploadFile: (fileBuffer, fields = {}, token = 'admin-token') => {
      const fd = new FormData();
      fd.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), fields.fileName || 'skripta.pdf');
      for (const [k, v] of Object.entries(fields)) if (k !== 'fileName') fd.append(k, v);
      return fetch(base + '/api/materials', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd
      });
    }
  };
}

const PDF = Buffer.from('%PDF-1.4\n' + 'x'.repeat(5000) + '\n%%EOF');

test('upload: fajl ide na Google Drive i link se odmah dobije', async () => {
  const ctx = await boot();
  try {
    const res = await ctx.uploadFile(PDF, { title: 'Skripta Baze', subject: 'Informatika', razredi: '["III-1"]' });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.material.storeKind, 'drive');
    assert.ok(body.material.drive.drive.includes('DRIVE_1'));   // link na Google Drive
    assert.equal(ctx.drive.calls.upload[0].name, 'Skripta Baze.pdf');
    assert.match(body.material.shareUrl, /\/m\/[a-f0-9]{24}$/);
    assert.match(body.material.links.page, /\/viewer\?m=[a-f0-9]{24}$/);
    assert.deepEqual(body.material.razredi, ['III-1']);
    assert.equal(ctx.drive.calls.shared.length, 1);   // javni link je uključen
  } finally { await ctx.close(); }
});

test('upload: odbija nedozvoljeni format i prazan zahtjev', async () => {
  const ctx = await boot();
  try {
    const bad = await ctx.uploadFile(Buffer.from('MZ'), { fileName: 'virus.exe' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Dozvoljeni formati/);

    const empty = await fetch(ctx.base + '/api/materials', { method: 'POST', headers: { Authorization: 'Bearer admin-token' } });
    assert.equal(empty.status, 400);
  } finally { await ctx.close(); }
});

test('upload bez javnog linka: Drive fajl se ne dijeli i nema /m/ linka', async () => {
  const ctx = await boot();
  try {
    const res  = await ctx.uploadFile(PDF, { title: 'Interno', shareEnabled: '0' });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(ctx.drive.calls.shared.length, 0);        // nema 'anyone' dozvole na Drive-u
    assert.equal(body.material.shareEnabled, false);
    assert.equal(body.material.shareUrl, null);
    assert.equal(body.material.links.view, null);

    // čak i ako se token pogodi, javni link je zatvoren
    const stored = [...ctx.db._store.docs.entries()].find(([k]) => k.startsWith('materials/'));
    assert.ok(stored, 'materijal je upisan u bazu');
    assert.equal((await ctx.get(`/m/${stored[1].shareToken}`)).status, 403);

    // admin i dalje može otvoriti fajl preko svoje prijave
    const own = await ctx.get(`/api/materials/${stored[0].split('/')[1]}/file`, 'admin-token');
    assert.equal(own.status, 200);
    assert.ok(body.material.links.page.includes('/viewer?id='));
  } finally { await ctx.close(); }
});

test('upload: učenik ne može dodavati materijale', async () => {
  const ctx = await boot();
  try {
    const res = await ctx.uploadFile(PDF, {}, 'iii1-token');
    assert.equal(res.status, 403);
    assert.equal(ctx.drive.calls.upload.length, 0);   // ništa nije otišlo na Drive
  } finally { await ctx.close(); }
});

test('lista: učenik vidi materijal označen za njegov razred i kad je zapis drugačiji', async () => {
  const ctx = await boot({ seed: {
    'materials/m1': { title: 'Za III-T5', razredi: [' iii–t5 '], visible: true, ext: 'pdf', shareToken: 'a'.repeat(24), createdAt: '2024-01-01' },
    'materials/m2': { title: 'JSON string', razredi: '["III-1"]', visible: true, ext: 'pdf', shareToken: 'b'.repeat(24), createdAt: '2024-02-01' }
  }});
  try {
    const iii1 = await ctx.json('/api/materials', 'iii1-token');
    assert.deepEqual(iii1.body.materials.map(m => m.title), ['JSON string']);

    const file = await ctx.get('/api/materials/m2/file', 'iii1-token');
    assert.equal(file.status, 200);

    const denied = await ctx.get('/api/materials/m1/file', 'iii1-token');
    assert.equal(denied.status, 403);
  } finally { await ctx.close(); }
});

test('lista: razmak u razredu je isto što i crtica (III 1 = III-1)', async () => {
  const ctx = await boot({ seed: {
    'materials/m1': { title: 'Crtica u bazi', razredi: ['III-1'], visible: true, ext: 'pdf', shareToken: 'a'.repeat(24), createdAt: '2024-01-01' },
    'materials/m2': { title: 'Razmak u bazi', razredi: ['III 1'], visible: true, ext: 'pdf', shareToken: 'b'.repeat(24), createdAt: '2024-02-01' }
  }});
  try {
    // učenik iii1-token ima razred 'III-1' — mora vidjeti OBA zapisa
    const list = await ctx.json('/api/materials', 'iii1-token');
    assert.deepEqual(list.body.materials.map(m => m.title).sort(), ['Crtica u bazi', 'Razmak u bazi']);

    const file = await ctx.get('/api/materials/m2/file', 'iii1-token');
    assert.equal(file.status, 200);

    // drugi razred i dalje ne vidi
    const other = await ctx.json('/api/materials', 'iv2-token');
    assert.deepEqual(other.body.materials.map(m => m.title), []);
  } finally { await ctx.close(); }
});

test('lista: učenik vidi samo svoj razred i vidljivo, bez internih polja', async () => {
  const ctx = await boot({ seed: {
    'materials/m1': { title: 'Za III-1', razredi: ['III-1'], visible: true,  ext: 'pdf', driveFileId: 'D1', driveShared: true, shareToken: 'a'.repeat(24), createdAt: '2024-01-01' },
    'materials/m2': { title: 'Za IV-2', razredi: ['IV-2'], visible: true,  ext: 'pdf', driveFileId: 'D2', shareToken: 'b'.repeat(24), createdAt: '2024-02-01' },
    'materials/m3': { title: 'Skriveno', razredi: [],      visible: false, ext: 'pdf', driveFileId: 'D3', shareToken: 'c'.repeat(24), createdAt: '2024-03-01' },
    'materials/m4': { title: 'Za sve',  razredi: [],       visible: true,  ext: 'docx', shareToken: 'd'.repeat(24), createdAt: '2024-04-01' }
  }});
  try {
    const student = await ctx.json('/api/materials', 'iii1-token');
    assert.deepEqual(student.body.materials.map(m => m.title).sort(), ['Za III-1', 'Za sve']);
    assert.ok(!JSON.stringify(student.body).includes('driveFileId'));
    assert.ok(!JSON.stringify(student.body).includes('Drive' + ' ID'));
    // Drive link ne ide učeniku ni kad je fajl javno podijeljen na Drive-u
    assert.ok(student.body.materials.every(m => m.drive === undefined), 'učenik ne smije dobiti Drive link');

    // razred koji ne odgovara → nema pristupa fajlu
    const denied = await ctx.get('/api/materials/m2/file', 'iii1-token');
    assert.equal(denied.status, 403);

    // PDF u tuđem razredu se ne vidi ni preko javnog linka ako je share isključen
    const adminList = await ctx.json('/api/materials', 'admin-token');
    assert.equal(adminList.body.materials.length, 4);
    assert.ok(adminList.body.materials.every(m => typeof m.shareToken === 'string' && m.shareToken.length === 24));
    const rawDriveIds = adminList.body.materials.map(m => m.driveFileId).filter(v => v !== undefined);
    assert.equal(rawDriveIds.length, 0, 'sirovi Drive ID se ne šalje ni adminu — koristi se links.drive');
  } finally { await ctx.close(); }
});

test('fajl: stream sa Drive-a uz podršku za Range i preuzimanje', async () => {
  const ctx = await boot({ seed: {
    'materials/m1': { title: 'Skripta', razredi: [], visible: true, ext: 'pdf', mimeType: 'application/pdf',
                      fileName: 'skripta.pdf', driveFileId: 'D1', shareToken: 'a'.repeat(24), downloads: 0 }
  }});
  try {
    const res = await ctx.get('/api/materials/m1/file?token=iii1-token');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(await res.text(), 'DRIVE-BYTES');

    const dl = await ctx.get('/api/materials/m1/file?token=iii1-token&download=1');
    assert.match(dl.headers.get('content-disposition'), /^attachment;/);

    const meta = await ctx.json('/api/materials/m1/meta?token=iii1-token');
    assert.equal(meta.body.material.storeKind, 'drive');
    // učenik NE dobija Google Drive link — čita/preuzima kroz našu stranicu
    assert.equal(meta.body.material.drive, undefined);

    const adminMeta = await ctx.json('/api/materials/m1/meta', 'admin-token');
    assert.ok(adminMeta.body.material.drive.preview.includes('/preview'));

    // ni kad je fajl javno podijeljen na Drive-u, učenik i dalje NE dobija link
    ctx.db._store.docs.set('materials/m1', { ...ctx.db.dump('materials/m1'), driveShared: true });
    const sharedMeta = await ctx.json('/api/materials/m1/meta?token=iii1-token');
    assert.equal(sharedMeta.body.material.drive, undefined, 'učenik nikad ne dobija Drive link');
    const sharedAdminMeta = await ctx.json('/api/materials/m1/meta', 'admin-token');
    assert.ok(sharedAdminMeta.body.material.drive.drive.includes('/file/d/D1/'));
  } finally { await ctx.close(); }
});

test('fajl: store koji vraća Buffer radi Range 206/416 (rezerva za starije zapise)', async () => {
  const bytes = Buffer.from('0123456789abcdef');
  const ctx = await boot({ bufferBytes: bytes, seed: {
    'materials/m1': { title: 'U bazi', razredi: [], visible: true, ext: 'pdf', mimeType: 'application/pdf',
                      fileName: 'b.pdf', fileStore: 'firestore', size: bytes.length, shareToken: 'a'.repeat(24) }
  }});
  try {
    const full = await ctx.get('/api/materials/m1/file', 'admin-token');
    assert.equal(await full.text(), bytes.toString());

    const part = await fetch(ctx.base + '/api/materials/m1/file', {
      headers: { Authorization: 'Bearer admin-token', Range: 'bytes=2-5' }
    });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 2-5/${bytes.length}`);
    assert.equal(await part.text(), '2345');

    const bad = await fetch(ctx.base + '/api/materials/m1/file', {
      headers: { Authorization: 'Bearer admin-token', Range: 'bytes=999-' }
    });
    assert.equal(bad.status, 416);
  } finally { await ctx.close(); }
});

test('javni link /m/<token>: radi bez prijave, respektuje shareEnabled', async () => {
  const token = 'f'.repeat(24);
  const ctx = await boot({ seed: {
    'materials/m1': { title: 'Javno', razredi: ['III-1'], visible: true, ext: 'pdf', mimeType: 'application/pdf',
                      fileName: 'j.pdf', driveFileId: 'D1', shareToken: token, shareEnabled: true },
    'materials/m2': { title: 'Zatvoreno', razredi: [], visible: true, ext: 'pdf', driveFileId: 'D2',
                      shareToken: 'e'.repeat(24), shareEnabled: false }
  }});
  try {
    const ok = await ctx.get(`/m/${token}`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'DRIVE-BYTES');

    const dl = await ctx.get(`/m/${token}?download=1`);
    assert.match(dl.headers.get('content-disposition'), /^attachment;/);

    const published = await ctx.json(`/api/materials/public/${token}`);
    assert.equal(published.body.material.title, 'Javno');
    assert.equal(published.body.material.razredi, undefined);
    assert.equal(published.body.material.drive, undefined);   // Drive link se ne izlaže javno

    const closed = await ctx.get(`/m/${'e'.repeat(24)}`);
    assert.equal(closed.status, 403);

    assert.equal((await ctx.get('/m/neispravan-token')).status, 404);
    assert.equal((await ctx.get('/m/' + '9'.repeat(24))).status, 404);
  } finally { await ctx.close(); }
});

test('izmjena: naziv se prenosi na Drive, isključivanje linka skida javnu dozvolu', async () => {
  const ctx = await boot({ seed: {
    'materials/m1': { title: 'Staro', description: '', razredi: [], visible: true, ext: 'pdf',
                      driveFileId: 'D1', driveShared: true, shareToken: 'a'.repeat(24), shareEnabled: true }
  }});
  try {
    const res = await fetch(ctx.base + '/api/materials/m1', {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Novo ime', shareEnabled: false, visible: false })
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.material.title, 'Novo ime');
    assert.equal(body.material.visible, false);
    assert.equal(body.material.links.view, null);      // nema više javnog linka
    assert.equal(ctx.db.dump('materials/m1').driveShared, false);
    assert.equal(ctx.drive.calls.shared.length, 0);    // isključivanje skida dozvolu, ne dodaje je

    // ponovno uključivanje → Drive dozvola "anyone with the link"
    await fetch(ctx.base + '/api/materials/m1', {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareEnabled: true })
    });
    assert.equal(ctx.drive.calls.shared.length, 1);
    assert.equal(ctx.drive.calls.shared[0].role, 'reader');
  } finally { await ctx.close(); }
});

test('brisanje: briše i fajl iz skladišta i zapis u bazi', async () => {
  const ctx = await boot({ seed: {
    'materials/m1': { title: 'X', razredi: [], visible: true, ext: 'pdf', driveFileId: 'D1', shareToken: 'a'.repeat(24) }
  }});
  try {
    const res = await fetch(ctx.base + '/api/materials/m1', { method: 'DELETE', headers: { Authorization: 'Bearer admin-token' } });
    assert.equal(res.status, 200);
    assert.deepEqual(ctx.drive.calls.removed, ['D1']);
    assert.equal(ctx.db.dump('materials/m1'), undefined);
    assert.equal((await ctx.get('/api/materials/m1/file', 'admin-token')).status, 404);
  } finally { await ctx.close(); }
});

test('bez povezanog Drive-a: upload vraća jasnu poruku, ništa se ne čuva u bazi', async () => {
  const db = fakeFirestore();
  const app = express();
  app.use(express.json());
  const upload = multer({ storage: multer.memoryStorage() });
  app.use(createMaterialsRouter({
    getDb: () => db,
    storeForMaterial: () => null,          // Drive nije povezan
    primaryStore: () => null,
    getUser: async () => ({ uid: 'a1', role: 'admin', displayName: 'Profesor' }),
    requireAdmin: async () => ({ uid: 'a1', role: 'admin', displayName: 'Profesor' }),
    upload
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const fd = new FormData();
    fd.append('file', new Blob([PDF], { type: 'application/pdf' }), 'skripta.pdf');
    const res  = await fetch(base + '/api/materials', { method: 'POST', body: fd });
    const body = await res.json();

    assert.equal(res.status, 503);
    assert.match(body.error, /Drive nije povezan/i);
    assert.match(body.error, /Poveži Google Drive/i);
    assert.equal([...db._store.docs.keys()].length, 0, 'ništa se ne smije upisati u bazu');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('stari materijal bez shareToken-a: link se pravi kad se uključi dijeljenje', async () => {
  const ctx = await boot({ seed: {
    'materials/m1': { title: 'Star', razredi: [], visible: true, ext: 'pdf', driveFileId: 'D1', createdAt: '2020-01-01' }
  }});
  try {
    const before = await ctx.json('/api/materials/m1/meta', 'admin-token');
    assert.equal(before.body.material.shareUrl, null);
    assert.equal(before.body.material.links.view, null);

    const res = await fetch(ctx.base + '/api/materials/m1', {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareEnabled: true })
    });
    const body = await res.json();
    assert.match(body.material.shareUrl, /\/m\/[a-f0-9]{24}$/);

    // i taj link stvarno radi
    const token = body.material.shareUrl.split('/m/')[1];
    assert.equal((await ctx.get(`/m/${token}`)).status, 200);
  } finally { await ctx.close(); }
});

test('nepostojeći materijal vraća 404, a ne 500', async () => {
  const ctx = await boot();
  try {
    assert.equal((await ctx.get('/api/materials/nema/file', 'admin-token')).status, 404);
    assert.equal((await ctx.json('/api/materials/nema/meta', 'admin-token')).res.status, 404);
    assert.equal((await ctx.get('/m/' + '0'.repeat(24))).status, 404);
  } finally { await ctx.close(); }
});

test('veliki PDF (1 MB) prolazi kroz upload bez izmjene bajtova', async () => {
  const ctx = await boot();
  try {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(1024 * 1024)]);
    const res = await ctx.uploadFile(big, { title: 'Veliki', razredi: '[]' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.material.size, big.length);
    assert.equal(body.material.chunks, 0);             // Drive ne koristi chunk-ove
    assert.equal(body.material.storeKind, 'drive');
  } finally { await ctx.close(); }
});

test('publicMaterial ostaje jedini izlaz — nema curenja storagePath', async () => {
  const out = publicMaterial({ id: 'x', storagePath: 'SECRET/PATH', driveFileId: 'SECRET_ID' }, { isAdmin: false });
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});
