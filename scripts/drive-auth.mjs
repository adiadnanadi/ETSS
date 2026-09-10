#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// Povezivanje Google Drive-a — jednokratno, lokalno na tvom računaru.
//
//   npm run drive:auth                 # OAuth: fajlovi idu na TVOJ lični Drive
//   npm run drive:auth -- --client putanja/client_secret.json
//   npm run drive:auth -- --check      # provjeri postojeću konfiguraciju
//
// Šta radi:
//   1. otvori Google stranicu za prijavu (izabereš svoj Google nalog)
//   2. vrati se na http://localhost:PORT i uzme "refresh token"
//   3. ispiše vrijednosti koje samo prekopiraš u Render → Environment
//
// Token se ne čuva nigdje osim u onome što ti zalijepiš u Render env.
// ════════════════════════════════════════════════════════════════════════════

import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { readDriveConfig, createDriveClient, driveMode } from '../lib/drive.js';

const SCOPE = 'https://www.googleapis.com/auth/drive';
const args = process.argv.slice(2);

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const has        = (flag) => args.includes(flag);
const clientFile = argValue('--client') || process.env.GOOGLE_OAUTH_CLIENT_FILE || '';

function log(msg = '') { console.log(msg); }
function bold(msg) { return `\x1b[1m${msg}\x1b[0m`; }
function green(msg) { return `\x1b[32m${msg}\x1b[0m`; }
function yellow(msg) { return `\x1b[33m${msg}\x1b[0m`; }
function dim(msg) { return `\x1b[2m${msg}\x1b[0m`; }

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'cmd'
            : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, cmdArgs, () => {});
}

// ── Nađi OAuth client id/secret ─────────────────────────────────────────────
function resolveOAuthClient() {
  const cfg = readDriveConfig();
  if (cfg.oauth.clientId && cfg.oauth.clientSecret) {
    return { clientId: cfg.oauth.clientId, clientSecret: cfg.oauth.clientSecret, source: 'env' };
  }
  if (clientFile && fs.existsSync(clientFile)) {
    const parsed = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
    const c = parsed.web || parsed.installed;
    if (c?.client_id && c?.client_secret) {
      return { clientId: c.client_id, clientSecret: c.client_secret, source: clientFile };
    }
  }
  return null;
}

// ── --check: provjeri konfiguraciju bez mijenjanja ičega ─────────────────────
async function runCheck() {
  const cfg = readDriveConfig();
  const mode = driveMode(cfg);

  log(bold('\n📦 Google Drive — provjera konfiguracije\n'));
  log(`  Način rada:      ${mode === 'off' ? yellow('nije povezan') : green(mode)}`);
  log(`  Servisni nalog:  ${cfg.serviceAccount ? cfg.serviceAccount.client_email : dim('—')}`);
  log(`  OAuth klijent:   ${cfg.oauth.clientId || dim('—')}`);
  log(`  Refresh token:   ${cfg.oauth.refreshToken ? green('postavljen') : dim('—')}`);
  log(`  Folder (GDRIVE_FOLDER_ID): ${cfg.folderId || dim('— (ide u korijen Drive-a)')}`);
  log('');

  if (mode === 'off') {
    log(yellow('Drive nije povezan. Pokreni bez --check da ga povežeš.\n'));
    process.exitCode = 1;
    return;
  }

  try {
    const client = createDriveClient(cfg);
    const ping   = await client.ping();
    log(green('✅ Veza radi.'));
    log(`  Nalog:   ${ping.name || ''} <${ping.email || ''}>`);
    if (ping.storage?.limit) {
      const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
      log(`  Zauzeće: ${gb(ping.storage.usage)} / ${gb(ping.storage.limit)}`);
    }
    if (cfg.folderId) {
      const folder = await client.folderInfo();
      log(`  Folder:  ${folder.name} (${folder.id})`);
      log(`  Dodavanje fajlova u folder: ${folder.canAddChildren === false ? yellow('nije dozvoljeno') : green('dozvoljeno')}`);
      if (!folder.canAddChildren) {
        log(dim('  → Podijeli folder sa servisnim nalogom kao Editor.'));
      }
    }
    log('');
  } catch (e) {
    log(`❌ ${e.message}\n`);
    process.exitCode = 1;
  }
}

// ── OAuth tok: autorizacija → refresh token ──────────────────────────────────
async function runAuth() {
  const client = resolveOAuthClient();
  if (!client) {
    log(bold('\n🔑 Potreban je Google OAuth klijent (jednokratno, 2 minute)\n'));
    log('  1. Otvori https://console.cloud.google.com/apis/credentials');
    log(`  2. Odaberi projekat ${bold('kviz-13f52')} (ili kreiraj ako ga nema na spisku)`);
    log('  3. Klikni "Create credentials" → "OAuth client ID"');
    log('  4. Application type: ' + bold('Desktop app') + '  (naziv npr. "KvizMajstor Drive")');
    log('  5. Create → preuzmi JSON (dugme "Download JSON")');
    log('  6. Pokreni ponovo:');
    log(dim('     npm run drive:auth -- --client ~/Downloads/client_secret_XXXX.json'));
    log('\n  Ako OAuth consent screen još nije postavljen, Google će te voditi kroz to');
    log('  (User type: External, Test users: dodaj svoj e-mail).\n');
    process.exitCode = 1;
    return;
  }

  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id:     client.clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         SCOPE,
    access_type:   'offline',
    prompt:        'consent'
  }).toString();

  log(bold('\n🔗 Otvori ovaj link u browseru i prijavi se svojim Google nalogom:\n'));
  log('  ' + authUrl + '\n');
  log(dim('  (Ako se browser ne otvori sam, kopiraj link ručno.)\n'));
  log(dim('  Čekam potvrdu…'));

  const code = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      const c   = url.searchParams.get('code');
      const err = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font-family:sans-serif;padding:40px;background:#0d1626;color:#e2eaf8">
        <h2>${c ? '✅ Uspješno povezano!' : '❌ Greška'}</h2>
        <p>${c ? 'Možeš zatvoriti ovaj tab i vratiti se u terminal.' : (err || 'Nema koda')}</p>
      </body></html>`);

      if (c) resolve(c); else reject(new Error(err || 'Autorizacija nije vraćena'));
    }).on('error', reject);

    openBrowser(authUrl);
  }).finally(() => server.close());

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     client.clientId,
      client_secret: client.clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code'
    }).toString()
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    log(`\n❌ Google nije vratio refresh token: ${data.error_description || data.error || res.status}`);
    log(dim('  Savjet: ukloni aplikaciju sa https://myaccount.google.com/permissions i pokreni ponovo.\n'));
    process.exitCode = 1;
    return;
  }

  log(green('\n✅ Gotovo! Dodaj ove varijable u Render → Environment:\n'));
  log(`GOOGLE_OAUTH_CLIENT_ID=${client.clientId}`);
  log(`GOOGLE_OAUTH_CLIENT_SECRET=${client.clientSecret}`);
  log(`GOOGLE_OAUTH_REFRESH_TOKEN=${data.refresh_token}`);
  log('');
  log(dim('  (Client ID/Secret se smiju čuvati kao env; refresh token vrijedi dok ga ne opozoveš.)'));
  log('');

  // Odmah provjeri da radi
  process.env.GOOGLE_OAUTH_CLIENT_ID     = client.clientId;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = client.clientSecret;
  process.env.GOOGLE_OAUTH_REFRESH_TOKEN = data.refresh_token;
  log(dim('  Provjeravam vezu…'));
  const ping = await createDriveClient(readDriveConfig(process.env)).ping().catch(e => ({ error: e.message }));
  if (ping.error) log(`  ⚠️  Provjera: ${ping.error}\n`);
  else log(green(`  ✅ Radi kao ${ping.email}\n`));
}

if (has('--check')) runCheck();
else runAuth();
