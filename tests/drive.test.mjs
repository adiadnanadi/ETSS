import test from 'node:test';
import assert from 'node:assert/strict';

import { readDriveConfig, driveMode } from '../lib/drive.js';
import { createDriveStore } from '../lib/drive-store.js';

const SA = JSON.stringify({
  type: 'service_account',
  project_id: 'kviz-13f52',
  client_email: 'kviz@kviz-13f52.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n'
});

test('readDriveConfig: service account iz JSON-a', () => {
  const cfg = readDriveConfig({ GOOGLE_SERVICE_ACCOUNT: SA, GDRIVE_FOLDER_ID: 'folder-1' });
  assert.equal(cfg.serviceAccount.client_email, 'kviz@kviz-13f52.iam.gserviceaccount.com');
  assert.equal(cfg.folderId, 'folder-1');
  assert.equal(driveMode(cfg), 'service-account');
});

test('readDriveConfig: OAuth refresh token ima prednost (liční Drive)', () => {
  const cfg = readDriveConfig({
    GOOGLE_SERVICE_ACCOUNT: SA,
    GOOGLE_OAUTH_CLIENT_ID: 'cid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
    GOOGLE_OAUTH_REFRESH_TOKEN: 'rt'
  });
  assert.equal(driveMode(cfg), 'oauth');
});

test('readDriveConfig: OAuth client JSON (web/installed) se parsira', () => {
  const cfg = readDriveConfig({
    GOOGLE_OAUTH_CLIENT: JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } }),
    GOOGLE_OAUTH_REFRESH_TOKEN: 'rt'
  });
  assert.equal(cfg.oauth.clientId, 'x');
  assert.equal(driveMode(cfg), 'oauth');
});

test('readDriveConfig: đubre u env ne ruši server', () => {
  const cfg = readDriveConfig({ GOOGLE_SERVICE_ACCOUNT: 'nije json {', GOOGLE_OAUTH_CLIENT: '{{' });
  assert.equal(cfg.serviceAccount, null);
  assert.equal(driveMode(cfg), 'off');
});

test('readDriveConfig: neispravan service account JSON (bez private_key) se odbija', () => {
  const cfg = readDriveConfig({ GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'a@b.c' }) });
  assert.equal(cfg.serviceAccount, null);
  assert.equal(driveMode(cfg), 'off');
});

// ── Fake Drive klijent da se testira drive-store bez Google-a ────────────────
function fakeDrive() {
  const calls = { upload: [], shared: [], removed: [], renamed: [] };
  return {
    mode: 'oauth',
    folderId: 'FOLDER',
    calls,
    async ping() { return { ok: true, email: 'nastavnik@gmail.com' }; },
    async upload(opts) {
      calls.upload.push(opts);
      return { id: 'FILE1', name: opts.name, webViewLink: 'https://drive.google.com/file/d/FILE1/view' };
    },
    async shareAnyone(fileId, role) { calls.shared.push({ fileId, role }); return { id: 'perm1' }; },
    async remove(fileId) { calls.removed.push(fileId); },
    async updateMeta(fileId, meta) { calls.renamed.push({ fileId, meta }); return { id: fileId }; },
    async api(url, opts) {
      if (String(url).includes('/permissions?fields=')) return { permissions: [] };
      return {};
    },
    async download() { return Buffer.from('PDF'); },
    async proxyFile() { return 'streamed'; }
  };
}

test('drive-store: upload ide direktno na Drive sa nazivom materijala', async () => {
  const drive = fakeDrive();
  const store = createDriveStore(drive, {});

  const fields = await store.uploadMaterial({
    materialId: 'm1', title: 'Skripta — Baze podataka', description: 'Poglavlja 1-5',
    fileName: 'skripta final.pdf', ext: 'pdf', mimeType: 'application/pdf', buffer: Buffer.from('x')
  });

  assert.equal(drive.calls.upload.length, 1);
  assert.equal(drive.calls.upload[0].name, 'Skripta — Baze podataka.pdf');
  assert.equal(drive.calls.upload[0].mimeType, 'application/pdf');
  assert.equal(fields.driveFileId, 'FILE1');
  assert.equal(fields.driveFolderId, 'FOLDER');
  assert.equal(fields.driveShared, true);          // javni link je default
  assert.deepEqual(drive.calls.shared, [{ fileId: 'FILE1', role: 'reader' }]);
});

test('drive-store: javno dijeljenje se može isključiti', async () => {
  const drive = fakeDrive();
  const store = createDriveStore(drive, { shareAnyoneDefault: false });
  const fields = await store.uploadMaterial({
    materialId: 'm1', title: '', fileName: 'x.docx', ext: 'docx', buffer: Buffer.from('x')
  });
  assert.equal(fields.driveFileId, 'FILE1');
  assert.equal(fields.driveShared, false);
  assert.equal(drive.calls.shared.length, 0);
});

test('drive-store: linkFor daje view/preview/download linkove', () => {
  const store = createDriveStore(fakeDrive(), {});
  const links = store.linkFor({ driveFileId: 'F9' });
  assert.equal(links.drive, 'https://drive.google.com/file/d/F9/view');
  assert.ok(links.preview.includes('/preview'));
  assert.ok(links.download.includes('export=download'));
  assert.equal(store.linkFor({}), null);
});

test('drive-store: brisanje i preimenovanje prate Firestore dokument', async () => {
  const drive = fakeDrive();
  const store = createDriveStore(drive, {});

  await store.removeMaterial({ driveFileId: 'FILE1' });
  assert.deepEqual(drive.calls.removed, ['FILE1']);

  await store.syncMeta({ driveFileId: 'FILE1', ext: 'pdf' }, { title: 'Nova skripta' });
  assert.equal(drive.calls.renamed[0].meta.name, 'Nova skripta.pdf');
});
