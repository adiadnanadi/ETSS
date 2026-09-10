// Testira PRAVI Google Drive klijent (lib/drive.js) protiv lažnog Google servera:
// token refresh, multipart upload, metadata, stream sa Range, dozvole i brisanje.
// Tako znamo da HTTP tok radi i prije nego što se unesu pravi kredencijali.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createDriveClient } from '../lib/drive.js';
import { createDriveStore } from '../lib/drive-store.js';

// ── Lažni Google ────────────────────────────────────────────────────────────
async function fakeGoogle() {
  const state = {
    tokens: [], uploads: [], permissions: [], deleted: [], meta: [],
    files: new Map(), accessToken: 'AT-1', tokenCalls: 0
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);

      // token
      if (url.pathname === '/token') {
        state.tokenCalls++;
        state.tokens.push(body.toString());
        return json(res, { access_token: state.accessToken, expires_in: 3600 });
      }

      // provjera autorizacije
      if (req.headers.authorization !== `Bearer ${state.accessToken}`) {
        return json(res, { error: { message: 'Invalid Credentials', code: 401 } }, 401);
      }

      // about
      if (url.pathname === '/drive/v3/about') {
        return json(res, { user: { emailAddress: 'nastavnik@gmail.com', displayName: 'Nastavnik' },
                           storageQuota: { limit: '1000', usage: '100' } });
      }

      // upload koji pada zbog kvote (servisni nalozi na Gmail-u)
      if (url.pathname === '/quota-upload' && req.method === 'POST') {
        return json(res, { error: { message: "The user's Drive storage quota has been exceeded.", code: 403 } }, 403);
      }

      // upload (multipart)
      if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
        const text = body.toString('latin1');
        const boundary = /boundary=(.+)$/.exec(req.headers['content-type'])?.[1];
        const parts = text.split(`--${boundary}`);
        const metaPart = parts[1] || '';
        const metaJson = JSON.parse(metaPart.slice(metaPart.indexOf('\r\n\r\n') + 4).trim());
        const filePart = parts[2] || '';
        const fileText = filePart.slice(filePart.indexOf('\r\n\r\n') + 4, filePart.lastIndexOf('\r\n'));
        const bytes = Buffer.from(fileText, 'latin1');
        state.uploads.push({ meta: metaJson, byteLength: body.length, contentType: req.headers['content-type'] });
        const id = 'F' + (state.uploads.length);
        state.files.set(id, bytes);
        return json(res, { id, name: metaJson.name, size: String(bytes.length),
                           mimeType: 'application/pdf',
                           webViewLink: `https://drive.google.com/file/d/${id}/view` });
      }

      // dozvole
      if (url.pathname.endsWith('/permissions') && req.method === 'POST') {
        state.permissions.push({ path: url.pathname, body: JSON.parse(body.toString() || '{}') });
        return json(res, { id: 'perm1' });
      }
      if (url.pathname.endsWith('/permissions') && req.method === 'GET') {
        return json(res, { permissions: [{ id: 'perm1', type: 'anyone', role: 'reader' }] });
      }
      if (url.pathname.includes('/permissions/') && req.method === 'DELETE') {
        state.permissions.push({ method: 'DELETE', path: url.pathname });
        res.writeHead(204).end();
        return;
      }

      // metadata / media
      const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (fileMatch) {
        const id = decodeURIComponent(fileMatch[1]);
        const file = state.files.get(id) || Buffer.from('NEMA');
        if (req.method === 'DELETE') {
          state.deleted.push(id);
          state.files.delete(id);
          res.writeHead(204).end();
          return;
        }
        if (req.method === 'PATCH') {
          state.meta.push({ id, body: JSON.parse(body.toString() || '{}') });
          return json(res, { id, webViewLink: `https://drive.google.com/file/d/${id}/view` });
        }
        if (url.searchParams.get('alt') === 'media') {
          const range = req.headers.range;
          if (range) {
            const m = /bytes=(\d+)-(\d*)/.exec(range);
            const start = Number(m[1]);
            const end = m[2] ? Number(m[2]) : file.length - 1;
            const slice = file.subarray(start, end + 1);
            res.writeHead(206, {
              'Content-Type': 'application/pdf',
              'Content-Range': `bytes ${start}-${end}/${file.length}`,
              'Content-Length': String(slice.length),
              'Accept-Ranges': 'bytes'
            });
            res.end(slice);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(file.length), 'Accept-Ranges': 'bytes' });
          res.end(file);
          return;
        }
        return json(res, { id, name: 'f.pdf', owners: [{ emailAddress: 'nastavnik@gmail.com' }], capabilities: { canAddChildren: true } });
      }

      return json(res, { error: { message: 'Nepoznata ruta u testu: ' + url.pathname } }, 404);
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  return {
    state,
    endpoints: {
      token:  `http://127.0.0.1:${port}/token`,
      files:  `http://127.0.0.1:${port}/drive/v3/files`,
      upload: `http://127.0.0.1:${port}/upload/drive/v3/files`
    },
    close: () => new Promise(r => server.close(r))
  };
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function oauthCfg(endpoints) {
  return {
    serviceAccount: null,
    oauth: { clientId: 'cid', clientSecret: 'secret', refreshToken: 'rt' },
    folderId: 'FOLDER', quotaFallback: true, endpoints
  };
}

test('drive klijent: OAuth token se uzima jednom i kešira', async () => {
  const g = await fakeGoogle();
  try {
    const drive = createDriveClient(oauthCfg(g.endpoints));
    const a = await drive.getAccessToken();
    const b = await drive.getAccessToken();
    assert.equal(a, 'AT-1');
    assert.equal(b, 'AT-1');
    assert.equal(g.state.tokenCalls, 1, 'token se ne smije tražiti za svaki zahtjev');

    const req = g.state.tokens[0];
    assert.match(req, /grant_type=refresh_token/);
    assert.match(req, /refresh_token=rt/);
    assert.match(req, /client_secret=secret/);
  } finally { await g.close(); }
});

test('drive klijent: ping daje nalog i kvotu', async () => {
  const g = await fakeGoogle();
  try {
    const drive = createDriveClient(oauthCfg(g.endpoints));
    const ping  = await drive.ping();
    assert.equal(ping.email, 'nastavnik@gmail.com');
    assert.equal(ping.mode, 'oauth');
    assert.equal(ping.storage.limit, 1000);
  } finally { await g.close(); }
});

test('drive klijent: upload šalje multipart sa nazivom, folderom i bajtovima', async () => {
  const g = await fakeGoogle();
  try {
    const drive = createDriveClient(oauthCfg(g.endpoints));
    const bytes = Buffer.from('%PDF-1.4\nTEST-BAJTOVI\n%%EOF');
    const up = await drive.upload({ name: 'Skripta.pdf', mimeType: 'application/pdf', buffer: bytes });

    assert.equal(up.id, 'F1');
    assert.match(up.webViewLink, /drive\.google\.com\/file\/d\/F1\/view/);
    assert.equal(g.state.uploads.length, 1);
    assert.deepEqual(g.state.uploads[0].meta, { name: 'Skripta.pdf', parents: ['FOLDER'] });
    assert.match(g.state.uploads[0].contentType, /multipart\/related; boundary=/);
    assert.deepEqual(g.state.files.get('F1'), bytes);
  } finally { await g.close(); }
});

test('drive klijent: stream prosljeđuje Range (206 + Content-Range)', async () => {
  const g = await fakeGoogle();
  try {
    const drive = createDriveClient(oauthCfg(g.endpoints));
    const bytes = Buffer.from('0123456789');
    g.state.files.set('F9', bytes);

    const full = await drive.stream('F9');
    const fullBuf = Buffer.concat(await collect(full.stream));
    assert.equal(fullBuf.toString(), '0123456789');

    const part = await drive.stream('F9', 'bytes=2-5');
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(Buffer.concat(await collect(part.stream)).toString(), '2345');
  } finally { await g.close(); }
});

test('drive klijent: dozvole i brisanje', async () => {
  const g = await fakeGoogle();
  try {
    const drive = createDriveClient(oauthCfg(g.endpoints));
    await drive.shareAnyone('F1', 'reader');
    assert.deepEqual(g.state.permissions[0].body, { role: 'reader', type: 'anyone', allowFileDiscovery: false });

    await drive.updateMeta('F1', { name: 'Novo.pdf' });
    assert.deepEqual(g.state.meta[0].body, { name: 'Novo.pdf' });

    await drive.remove('F1');
    assert.deepEqual(g.state.deleted, ['F1']);
  } finally { await g.close(); }
});

test('drive store + klijent: upload, javni link, dijeljenje i brisanje zajedno', async () => {
  const g = await fakeGoogle();
  try {
    const drive = createDriveClient(oauthCfg(g.endpoints));
    const store = createDriveStore(drive, {});

    const fields = await store.uploadMaterial({
      materialId: 'm1', title: 'Baze podataka', description: 'Skripta',
      fileName: 'skripta.pdf', ext: 'pdf', mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\nX\n%%EOF')
    });
    assert.equal(fields.driveFileId, 'F1');
    assert.equal(fields.driveShared, true);
    assert.deepEqual(g.state.permissions[0].body, { role: 'reader', type: 'anyone', allowFileDiscovery: false });

    // isključivanje javnog linka skida 'anyone' dozvolu
    const stillShared = await store.shareFile({ driveFileId: 'F1' }, false);
    assert.equal(stillShared, false);
    assert.ok(g.state.permissions.some(p => p.method === 'DELETE'));

    await store.removeMaterial({ driveFileId: 'F1' });
    assert.deepEqual(g.state.deleted, ['F1']);
  } finally { await g.close(); }
});

test('drive klijent: jasna greška kad Google vrati 401/403', async () => {
  const g = await fakeGoogle();
  try {
    const drive = createDriveClient(oauthCfg(g.endpoints));
    await drive.ping();                           // token se kešira ('AT-1')
    g.state.accessToken = 'NOVI-TOKEN';           // Google ga je u međuvremenu odbio
    await assert.rejects(() => drive.about(), /Google Drive/);
  } finally { await g.close(); }
});

async function collect(stream) {
  const out = [];
  for await (const chunk of stream) out.push(Buffer.from(chunk));
  return out;
}

test('drive klijent: kvota daje poruku koja kaže ŠTA konkretno uraditi', async () => {
  const g = await fakeGoogle();
  try {
    const cfg = {
      ...oauthCfg(g.endpoints),
      folderId: '',   // bez foldera → nema retry-a, odmah jasna poruka
      endpoints: { ...g.endpoints, upload: g.endpoints.upload.replace('/upload/drive/v3/files', '/quota-upload') }
    };
    const drive = createDriveClient(cfg);
    const err = await drive.upload({ name: 'x.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') })
      .then(() => null, e => e);

    assert.ok(err, 'upload je morao pasti');
    assert.equal(err.status, 507);
    assert.match(err.message, /npm run drive:auth|kvotu/i);
    assert.ok(!/quotaExceeded|storageQuotaExceeded/.test(err.message), 'bez Google žargona u poruci');
  } finally { await g.close(); }
});
