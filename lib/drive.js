// ════════════════════════════════════════════════════════════════════════════
// Google Drive klijent.
//
// Dva načina rada:
//
//  1) SERVICE ACCOUNT  (GOOGLE_SERVICE_ACCOUNT)
//     Najlakše za server — nema "re-connect" svakih par sati. Ali service
//     account ima svoj Drive (nema kvotu za upload bez Workspace-a), zato se
//     mapa na TVOJ Drive preko GDRIVE_FOLDER_ID i foldera podijeljenog s njim.
//
//  2) OAUTH REFRESH TOKEN  (GOOGLE_OAUTH_CLIENT_ID/SECRET + REFRESH_TOKEN)
//     Fajlovi se uploaduju DIREKTNO na tvoj lični Drive (id ili storage quota
//     troje se na tvoj račun). Postupak: `npm run drive:auth`.
//
// Ovdje nema Firebasea — samo Google Drive REST API preko fetch-a.
// ════════════════════════════════════════════════════════════════════════════

const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES  = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE        = 'https://www.googleapis.com/auth/drive';

export function readDriveConfig(env = process.env) {
  const saJson = env.GOOGLE_SERVICE_ACCOUNT || env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  let serviceAccount = null;
  if (saJson.trim()) {
    try {
      const parsed = JSON.parse(saJson);
      if (parsed.client_email && parsed.private_key) serviceAccount = parsed;
      else if (parsed.web || parsed.installed) serviceAccount = null;   // to je OAuth client JSON
    } catch { /* nije JSON — ignoriši */ }
  }

  // OAuth client JSON može doći i kao GOOGLE_OAUTH_CLIENT (CEO fajl sa neta)
  let oauthClientJson = null;
  const ocRaw = env.GOOGLE_OAUTH_CLIENT || '';
  if (ocRaw.trim()) {
    try { oauthClientJson = JSON.parse(ocRaw); } catch { /* ignoriši */ }
  }
  const oauthClient = oauthClientJson?.web || oauthClientJson?.installed || null;

  const oauth = {
    clientId:     env.GOOGLE_OAUTH_CLIENT_ID     || oauthClient?.client_id     || '',
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || oauthClient?.client_secret || '',
    refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN || ''
  };

  return {
    serviceAccount,
    oauth,
    folderId:  env.GDRIVE_FOLDER_ID || '',
    quotaFallback: env.GDRIVE_QUOTA_FALLBACK !== '0',
    // Adrese se mogu preusmjeriti (koristi se u testovima; u produkciji default)
    endpoints: {
      token:  env.GOOGLE_TOKEN_URL        || TOKEN_URL,
      files:  env.GOOGLE_DRIVE_API        || DRIVE_FILES,
      upload: env.GOOGLE_DRIVE_UPLOAD_API || DRIVE_UPLOAD
    }
  };
}

export function driveMode(cfg = readDriveConfig()) {
  if (cfg.oauth.clientId && cfg.oauth.clientSecret && cfg.oauth.refreshToken) return 'oauth';
  if (cfg.serviceAccount) return 'service-account';
  return 'off';
}

function requireFetch() {
  if (typeof fetch !== 'function') throw new Error('Node.js 18+ je potreban (globalni fetch)');
}

// ── JWT za service account (bez googleapis biblioteke) ───────────────────────
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJwt(serviceAccount, scope, aud = TOKEN_URL) {
  const { createSign } = await import('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim  = {
    iss:   serviceAccount.client_email,
    scope,
    aud,
    iat:   now,
    exp:   now + 3600
  };

  const payload = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer  = createSign('RSA-SHA256');
  signer.update(payload);
  const signature = signer.sign(serviceAccount.private_key).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${payload}.${signature}`;
}

async function fetchToken(body, tokenUrl = TOKEN_URL) {
  requireFetch();
  const res  = await fetch(tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams(body).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Google prijava nije uspjela: ${detail}`);
  }
  return data;
}

// ── Klijent ─────────────────────────────────────────────────────────────────
export function createDriveClient(cfg = readDriveConfig()) {
  const mode = driveMode(cfg);
  const EP   = {
    token:  cfg.endpoints?.token  || TOKEN_URL,
    files:  cfg.endpoints?.files  || DRIVE_FILES,
    upload: cfg.endpoints?.upload || DRIVE_UPLOAD
  };
  const ABOUT_URL = EP.files.replace(/\/files\/?$/, '/about');

  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

    let data;
    if (mode === 'oauth') {
      data = await fetchToken({
        client_id:     cfg.oauth.clientId,
        client_secret: cfg.oauth.clientSecret,
        refresh_token: cfg.oauth.refreshToken,
        grant_type:    'refresh_token'
      }, EP.token);
    } else if (mode === 'service-account') {
      const assertion = await signJwt(cfg.serviceAccount, SCOPE, EP.token);
      data = await fetchToken({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      }, EP.token);
    } else {
      throw new Error('Google Drive nije povezan');
    }

    cachedToken    = data.access_token;
    tokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return cachedToken;
  }

  async function api(url, { method = 'GET', body, json, headers = {}, raw = false } = {}) {
    requireFetch();
    const token = await getAccessToken();
    const init  = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };

    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (body !== undefined) {
      init.body = body;
    }

    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = `Google Drive greška (HTTP ${res.status})`;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error?.message) msg = `Google Drive: ${parsed.error.message}`;
      } catch { if (text) msg = `Google Drive (HTTP ${res.status}): ${text.slice(0, 300)}`; }
      const err = new Error(msg);
      err.status = res.status === 401 || res.status === 403 ? 502 : 500;
      throw err;
    }
    if (raw) return res;
    if (res.status === 204) return {};
    return res.json().catch(() => ({}));
  }

  const escapeQ = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const client = {
    mode,
    folderId: cfg.folderId,
    quotaFallback: cfg.quotaFallback,
    endpoints: EP,
    getAccessToken,
    api,
    // URL konkretnog fajla (koristi ga i drive-store za dozvole)
    fileApi: (fileId, sub = '') => `${EP.files}/${encodeURIComponent(fileId)}${sub}`,

    async about() {
      return api(`${ABOUT_URL}?fields=user,storageQuota`);
    },

    async ping() {
      const info = await client.about();
      return {
        ok:      true,
        mode,
        email:   info.user?.emailAddress || null,
        name:    info.user?.displayName   || null,
        storage: info.storageQuota ? {
          limit: Number(info.storageQuota.limit || 0),
          usage: Number(info.storageQuota.usage || 0),
          inDrive: Number(info.storageQuota.usageInDrive || 0)
        } : null
      };
    },

    // Postoji li folder i je li dijeljen sa service account-om?
    async folderInfo(folderId = cfg.folderId) {
      if (!folderId) throw new Error('GDRIVE_FOLDER_ID nije postavljen');
      const data = await api(`${EP.files}/${encodeURIComponent(folderId)}?fields=id,name,mimeType,webViewLink,owners(emailAddress),capabilities(canAddChildren)`);
      const owners = (data.owners || []).map(o => o.emailAddress).filter(Boolean);
      const me     = (await client.whoAmI())?.email || null;
      return {
        id: data.id, name: data.name, mimeType: data.mimeType,
        webViewLink: data.webViewLink,
        owners,
        canAddChildren: data.capabilities?.canAddChildren,
        sharedWithServiceAccount: !!me && owners.includes(me)
      };
    },

    async whoAmI() {
      const info = await client.about().catch(() => null);
      return info ? { email: info.user?.emailAddress, name: info.user?.displayName } : null;
    },

    // Upload fajla (multipart). Ako folder nije dostupan i dopušten je
    // fallback, ide u service-account-ov sopstveni Drive.
    async upload({ name, mimeType, buffer, folderId = cfg.folderId }) {
      const boundary = 'kviz' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      const meta = { name };
      if (folderId) meta.parents = [folderId];

      const pre = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
        'utf8'
      );
      const post  = Buffer.from(`\r\n--${boundary}--`, 'utf8');
      const body  = Buffer.concat([pre, buffer, post]);

      const url = `${EP.upload}?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,mimeType,webViewLink,webContentLink`;

      try {
        return await api(url, {
          method: 'POST',
          body,
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(body.length) }
        });
      } catch (e) {
        const quotaProblem = /storage quota|quotaExceeded|storageQuotaExceeded/i.test(e.message);
        if (quotaProblem && cfg.quotaFallback && folderId) {
          console.warn('⚠️  Drive kvota service account-a puna — pokušavam bez foldera…');
          try {
            return await client.upload({ name, mimeType, buffer, folderId: '' });
          } catch { /* ispod dajemo jasnu poruku */ }
        }
        if (quotaProblem) {
          const err = new Error(
            'Google Drive nije prihvatio fajl: nalog nema kvotu za upload. ' +
            (mode === 'service-account'
              ? 'Servisni nalozi na običnom Gmail-u nemaju Google kvotu — poveži svoj lični Drive sa "npm run drive:auth" (varijanta A u README-u), ili koristi Workspace / dijeljeni drive folder.'
              : 'Provjeri da li je na Google nalogu iskorištena kvota (storage.google.com).')
          );
          err.status = 507;   // Insufficient Storage
          throw err;
        }
        if (/not found|File not found|insufficientFilePermissions/i.test(e.message) && folderId) {
          throw new Error(
            `Folder na Drive-u (${folderId}) nije dostupan nalogu. ` +
            `Podijeli folder sa e-mailom iz GOOGLE_SERVICE_ACCOUNT kao Editor (ili podesi GDRIVE_FOLDER_ID).`
          );
        }
        throw e;
      }
    },

    async download(fileId) {
      if (!fileId) throw new Error('Drive ID fajla nedostaje');
      const res = await api(`${EP.files}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { raw: true });
      return Buffer.from(await res.arrayBuffer());
    },

    // Vraća stream za velike fajlove (BEZ držanja cijelog PDF-a u RAM-u).
    async stream(fileId, rangeHeader) {
      if (!fileId) throw new Error('Drive ID fajla nedostaje');
      const headers = {};
      if (rangeHeader) headers.Range = rangeHeader;
      const res = await api(
        `${EP.files}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
        { raw: true, headers }
      );
      const { Readable } = await import('stream');
      return { stream: Readable.fromWeb(res.body), status: res.status, headers: res.headers };
    },

    async updateMeta(fileId, { name, description } = {}) {
      const body = {};
      if (name !== undefined)        body.name        = name;
      if (description !== undefined) body.description = description;
      return api(`${EP.files}/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,webViewLink`, {
        method: 'PATCH', json: body
      });
    },

    async remove(fileId) {
      if (!fileId) return;
      await api(`${EP.files}/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: 'DELETE' });
    },

    // Dozvola "svako ko ima link može gledati" — koristi se za javni link.
    async shareAnyone(fileId, role = 'reader') {
      return api(`${EP.files}/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true&sendNotificationEmail=false`, {
        method: 'POST',
        json:   { role, type: 'anyone', allowFileDiscovery: false }
      });
    },

    // Proslijeđivanje Range zahtjeva direktno na Google (najbolje za PDF).
    async proxyFile(req, res, { fileId, fileName, mimeType, size, download = false, contentType, contentDisposition }) {
      const wantsRange = !!req.headers.range;
      const { stream, status, headers } = await client.stream(fileId, req.headers.range);

      const type = contentType || mimeType || 'application/octet-stream';
      res.status(wantsRange && status === 206 ? 206 : 200);
      res.setHeader('Content-Type', type);
      res.setHeader('Accept-Ranges', headers.get?.('accept-ranges') || 'bytes');
      const len = headers.get?.('content-length');
      if (len) res.setHeader('Content-Length', len);
      const cr = headers.get?.('content-range');
      if (cr) res.setHeader('Content-Range', cr);
      if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
      else if (download) res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName || 'dokument')}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      stream.on('error', err => {
        console.error('❌ drive stream:', err.message);
        if (!res.headersSent) res.status(502).end(); else res.end();
      });
      stream.pipe(res);
    }
  };

  return client;
}
