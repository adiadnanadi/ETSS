// Testira povezivanje Google Drive-a iz admin panela (lib/drive-controller.js
// i lib/drive-router.js) protiv lažnog Google servera — bez pravih kredencijala.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { once } from 'node:events';

import { createDriveController } from '../lib/drive-controller.js';
import { createDriveRouter } from '../lib/drive-router.js';

async function fakeGoogle({ refreshToken = 'RT-1', failWith = null } = {}) {
  const state = { tokenRequests: [], revokes: [], uploads: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const send = (obj, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (url.pathname === '/token') {
        state.tokenRequests.push(Object.fromEntries(new URLSearchParams(body)));
        if (failWith) return send({ error: 'invalid_grant', error_description: failWith }, 400);
        if (body.includes('grant_type=authorization_code')) return send({ refresh_token: refreshToken, access_token: 'AT1' });
        return send({ access_token: 'AT1', expires_in: 3600 });
      }
      if (url.pathname === '/revoke') { state.revokes.push(body); return send({}); }
      if (url.pathname === '/drive/v3/about') {
        if (req.headers.authorization !== 'Bearer AT1') return send({ error: { message: 'Invalid Credentials' } }, 401);
        return send({ user: { emailAddress: 'nastavnik@gmail.com', displayName: 'Nastavnik' }, storageQuota: { limit: '1000', usage: '250' } });
      }
      if (url.pathname === '/drive/v3/files') return send({ id: 'F1', webViewLink: 'https://drive.google.com/file/d/F1/view' });
      send({});
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    state,
    endpoints: {
      token:  `http://127.0.0.1:${port}/token`,
      revoke: `http://127.0.0.1:${port}/revoke`,
      files:  `http://127.0.0.1:${port}/drive/v3/files`
    },
    close: () => new Promise(r => server.close(r))
  };
}

function makeController(g, stored = {}) {
  let settings = Object.keys(stored).length ? { ...stored } : null;
  const envCfg = {           // kao da u env nema ničega
    serviceAccount: null,
    oauth: { clientId: '', clientSecret: '', refreshToken: '' },
    folderId: '',
    quotaFallback: true,
    endpoints: { token: g.endpoints.token, files: g.endpoints.files, upload: g.endpoints.files }
  };
  const controller = createDriveController({
    envCfg,
    endpoints: g.endpoints,
    getSettings: async () => settings,
    saveSettings: async (d) => { settings = { ...settings, ...d }; },
    clearSettings: async () => { settings = null; }
  });
  return { controller, get settings() { return settings; } };
}

test('nepovezan Drive: status kaže da nije povezan i nudi redirect URI', async () => {
  const g = await fakeGoogle();
  try {
    const { controller } = makeController(g);
    const st = await controller.status('https://moja-aplikacija.onrender.com');
    assert.equal(st.connected, false);
    assert.equal(st.configured, false);
    assert.equal(st.source, null);
    assert.equal(st.redirectUri, 'https://moja-aplikacija.onrender.com/api/drive/connect/callback');
    assert.equal(controller.isConnected(), false);
    assert.equal(controller.client(), null);
  } finally { await g.close(); }
});

test('startConnect traži kredencijale i vraća Google link sa state-om', async () => {
  const g = await fakeGoogle();
  try {
    const { controller } = makeController(g);
    assert.throws(() => controller.startConnect({ clientId: '', clientSecret: '', baseUrl: 'https://x' }), /Client ID/i);

    const { url, state } = controller.startConnect({
      clientId: 'cid.apps.googleusercontent.com', clientSecret: 'tajna',
      folderId: 'FOLDER1', uid: 'admin1', baseUrl: 'https://moja.onrender.com'
    });

    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(parsed.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
    assert.equal(parsed.searchParams.get('redirect_uri'), 'https://moja.onrender.com/api/drive/connect/callback');
    assert.equal(parsed.searchParams.get('access_type'), 'offline');
    assert.equal(parsed.searchParams.get('prompt'), 'consent');
    assert.equal(parsed.searchParams.get('state'), state);
    assert.ok(state.length >= 32);
  } finally { await g.close(); }
});

test('finishConnect: kod → refresh token → veza radi odmah', async () => {
  const g = await fakeGoogle();
  try {
    const box = makeController(g);
    const { state } = box.controller.startConnect({
      clientId: 'cid', clientSecret: 'tajna', folderId: 'FOLDER1', uid: 'a1', baseUrl: 'https://x.co'
    });

    const st = await box.controller.finishConnect({ state, code: 'CODE1', baseUrl: 'https://x.co' });
    assert.equal(st.connected, true);
    assert.equal(st.email, 'nastavnik@gmail.com');
    assert.equal(st.storage.usage, 250);
    assert.equal(st.source, 'panel');

    // token je sačuvan i vezan za folder
    assert.equal(box.settings.refreshToken, 'RT-1');
    assert.equal(box.settings.folderId, 'FOLDER1');
    assert.equal(box.settings.connectedBy, 'a1');

    // klijent sada radi
    assert.ok(box.controller.client());

    // state se ne može iskoristiti dvaput
    await assert.rejects(() => box.controller.finishConnect({ state, code: 'CODE1', baseUrl: 'https://x.co' }), /istekla|ponovo/i);
  } finally { await g.close(); }
});

test('finishConnect: neispravan/istekao state i Google greška', async () => {
  const g = await fakeGoogle();
  try {
    const { controller } = makeController(g);
    await assert.rejects(() => controller.finishConnect({ state: 'nepostojeci', code: 'x', baseUrl: 'https://x' }), /istekla|ponovo/i);

    const { state } = controller.startConnect({ clientId: 'c', clientSecret: 's', baseUrl: 'https://x' });
    await assert.rejects(() => controller.finishConnect({ state, error: 'access_denied', baseUrl: 'https://x' }), /odbio/i);
  } finally { await g.close(); }
});

test('finishConnect: ako Google ne vrati refresh token, poruka objašnjava šta uraditi', async () => {
  const g = await fakeGoogle({ failWith: 'Bad Request' });
  try {
    const { controller } = makeController(g);
    const { state } = controller.startConnect({ clientId: 'c', clientSecret: 's', baseUrl: 'https://x' });
    await assert.rejects(
      () => controller.finishConnect({ state, code: 'x', baseUrl: 'https://x' }),
      /myaccount\.google\.com\/permissions|trajni pristup/i
    );
  } finally { await g.close(); }
});

test('disconnect opoziva token na Google-u i briše vezu', async () => {
  const g = await fakeGoogle();
  try {
    const box = makeController(g, { clientId: 'c', clientSecret: 's', refreshToken: 'RT-OLD', folderId: '' });
    await box.controller.load();
    assert.equal(box.controller.isConnected(), true);

    await box.controller.disconnect();

    assert.equal(box.settings, null);
    assert.equal(box.controller.isConnected(), false);
    assert.equal(box.controller.client(), null);
    assert.ok(g.state.revokes[0].includes('token=RT-OLD'));
  } finally { await g.close(); }
});

test('env kredencijali imaju prioritet nad onima iz panela', async () => {
  const g = await fakeGoogle();
  try {
    const envCfg = {
      serviceAccount: null,
      oauth: { clientId: 'env-cid', clientSecret: 'env-secret', refreshToken: 'ENV-RT' },
      folderId: 'ENV-FOLDER',
      quotaFallback: true,
      endpoints: { token: g.endpoints.token, files: g.endpoints.files, upload: g.endpoints.files }
    };
    const controller = createDriveController({
      envCfg,
      getSettings: async () => ({ clientId: 'panel', clientSecret: 'panel', refreshToken: 'PANEL-RT' }),
      saveSettings: async () => {},
      clearSettings: async () => {}
    });
    const st = await controller.status('https://x.co');
    assert.equal(st.source, 'env');
    assert.equal(st.folderId, 'ENV-FOLDER');
  } finally { await g.close(); }
});

// ── Rute ────────────────────────────────────────────────────────────────────
test('rute: status/connect/callback/disconnect rade kroz HTTP', async () => {
  const g = await fakeGoogle();
  try {
    const box = makeController(g);
    const app = express();
    app.use(express.json());
    app.use(createDriveRouter({
      requireAdmin: async (req) => {
        if (req.headers.authorization !== 'Bearer admin') {
          throw Object.assign(new Error('Nemate dozvolu'), { status: 403 });
        }
        return { uid: 'a1', role: 'admin' };
      },
      drive: box.controller
    }));

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      // status je samo za admina
      const denied = await fetch(`${base}/api/drive/status`);
      assert.equal(denied.status, 403);

      const before = await (await fetch(`${base}/api/drive/status`, { headers: { Authorization: 'Bearer admin' } })).json();
      assert.equal(before.connected, false);
      assert.ok(before.redirectUri.endsWith('/api/drive/connect/callback'));

      // korak 1: link
      const start = await (await fetch(`${base}/api/drive/connect`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: 'cid', clientSecret: 'tajna', folderId: 'F1' })
      })).json();
      assert.ok(start.url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
      assert.match(start.redirectUri, /\/api\/drive\/connect\/callback$/);

      // korak 2: Google preusmjerava na callback (bez prijave, nosi state)
      const cb = await fetch(`${base}/api/drive/connect/callback?code=CODE1&state=${start.state}`, { redirect: 'manual' });
      assert.equal(cb.status, 302);
      const location = cb.headers.get('location');
      assert.match(location, /^\/admin\?drive=connected/);
      assert.match(location, /nastavnik%40gmail\.com/);

      // sad je povezan
      const after = await (await fetch(`${base}/api/drive/status`, { headers: { Authorization: 'Bearer admin' } })).json();
      assert.equal(after.connected, true);
      assert.equal(after.email, 'nastavnik@gmail.com');

      // greška u callbacku vraća korisnika na panel sa porukom
      const bad = await fetch(`${base}/api/drive/connect/callback?code=x&state=nepostojeci`, { redirect: 'manual' });
      assert.match(bad.headers.get('location'), /^\/admin\?drive=error/);

      // prekid veze
      const off = await fetch(`${base}/api/drive/disconnect`, { method: 'POST', headers: { Authorization: 'Bearer admin' } });
      assert.equal(off.status, 200);
      const final = await (await fetch(`${base}/api/drive/status`, { headers: { Authorization: 'Bearer admin' } })).json();
      assert.equal(final.connected, false);
    } finally { await new Promise(r => server.close(r)); }
  } finally { await g.close(); }
});
