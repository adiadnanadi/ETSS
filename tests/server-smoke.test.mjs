// Smoke test: diže PRAVI server.js (bez Firebase i bez Google kredencijala) i
// provjerava da se stranice serviraju i da API vraća razumljive greške umjesto pucanja.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 3941;
const BASE = `http://127.0.0.1:${PORT}`;

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), FIREBASE_SERVICE_ACCOUNT: '', MISTRAL_API_KEY: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', d => logs.push(d.toString()));
  child.stderr.on('data', d => logs.push(d.toString()));
  return { child, logs };
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* još se diže */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

test('server.js se diže i servira stranice + ima /viewer rutu', async (t) => {
  const { child, logs } = startServer();
  t.after(() => child.kill('SIGKILL'));

  assert.ok(await waitForServer(), 'server nije počeo slušati:\n' + logs.join(''));

  for (const path of ['/', '/login', '/admin', '/student', '/create-quiz', '/viewer']) {
    const res = await fetch(BASE + path);
    assert.equal(res.status, 200, `${path} nije 200`);
    assert.match(res.headers.get('content-type') || '', /html/);
  }

  const health = await fetch(`${BASE}/api/health`).then(r => r.json());
  assert.equal(health.ok, true);

  // Bez Firebasea API mora vratiti jasnu grešku (503), ne 500 ni pucanje
  const list = await fetch(`${BASE}/api/materials`);
  assert.equal(list.status, 503);
  assert.match((await list.json()).error, /konfigurisan/i);

  const badLink = await fetch(`${BASE}/m/${'0'.repeat(24)}`);
  assert.equal(badLink.status, 503);   // baza nije dostupna u ovom testu

  const staticCss = await fetch(`${BASE}/css/style.css`);
  assert.equal(staticCss.status, 200);

  assert.ok(logs.join('').includes('KvizMajstor pokrenut'), 'nema start loga');
});
