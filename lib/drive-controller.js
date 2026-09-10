// ════════════════════════════════════════════════════════════════════════════
// Upravljanje vezom sa Google Drive-om — bez komandne linije i bez env varijabli.
//
// Admin u panelu (Literatura) klikne "Poveži Google Drive", prijavi se svojim
// Google nalogom i to je to. Refresh token se čuva u Firestore-u
// (settings/drive) i koristi za sve uploude.
//
// Ako su kredencijali postavljeni preko env varijabli, oni imaju prioritet.
// ════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import { readDriveConfig, driveMode, createDriveClient } from './drive.js';

const SCOPE        = 'https://www.googleapis.com/auth/drive';
const AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL   = 'https://oauth2.googleapis.com/revoke';
const PENDING_TTL  = 15 * 60 * 1000;   // 15 minuta za dovršetak prijave

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function createDriveController({
  getSettings,          // async () => ({...}) | null   — iz Firestore-a
  saveSettings,         // async (data) => void
  clearSettings,        // async () => void
  envCfg = readDriveConfig(),
  endpoints = {}
} = {}) {
  let settings  = null;
  let loaded    = false;
  let cached    = null;
  let cachedKey = null;
  const pending = new Map();   // state -> { clientId, clientSecret, uid, folderId, at }

  const EP = {
    token:  endpoints.token  || envCfg.endpoints?.token  || DEFAULT_TOKEN_URL,
    revoke: endpoints.revoke || REVOKE_URL
  };

  async function loadSettings(force = false) {
    if (loaded && !force) return settings;
    loaded   = true;
    settings = (await getSettings?.().catch(() => null)) || null;
    return settings;
  }

  // env ima prioritet; ako ga nema, koriste se kredencijali iz panela
  function currentConfig() {
    if (driveMode(envCfg) !== 'off') return envCfg;

    const s = settings || {};
    if (s.refreshToken && s.clientId && s.clientSecret) {
      return {
        serviceAccount: null,
        oauth: { clientId: s.clientId, clientSecret: s.clientSecret, refreshToken: s.refreshToken },
        folderId: s.folderId || envCfg.folderId || '',
        quotaFallback: true,
        endpoints: envCfg.endpoints
      };
    }
    return envCfg;
  }

  function configKey(cfg) {
    return [
      driveMode(cfg),
      cfg.oauth?.refreshToken || cfg.serviceAccount?.client_email || '',
      cfg.oauth?.clientId || '',
      cfg.folderId || ''
    ].join('|');
  }

  // Klijent se pravi "u hodu" — kad se kredencijali promijene, sam se obnovi
  function client() {
    const cfg  = currentConfig();
    const mode = driveMode(cfg);
    if (mode === 'off') { cached = null; cachedKey = null; return null; }

    const key = configKey(cfg);
    if (!cached || cachedKey !== key) {
      cached    = createDriveClient(cfg);
      cachedKey = key;
    }
    return cached;
  }

  function redirectUri(baseUrl) {
    return process.env.GDRIVE_REDIRECT_URI || `${baseUrl}/api/drive/connect/callback`;
  }

  function authUrlFor({ baseUrl, clientId, state }) {
    return AUTH_URL + '?' + new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  redirectUri(baseUrl),
      response_type: 'code',
      scope:         SCOPE,
      access_type:   'offline',
      prompt:        'consent',
      include_granted_scopes: 'true',
      state
    }).toString();
  }

  // Učitaj kredencijale odmah (ne blokira start servera)
  Promise.resolve().then(() => loadSettings()).catch(() => {});

  return {
    get settings() { return settings; },
    get mode()     { return driveMode(currentConfig()); },
    isConnected()  { return driveMode(currentConfig()) !== 'off'; },
    client,
    redirectUri,

    async load(force = false) { return loadSettings(force); },

    // ── Status za panel ──────────────────────────────────────────────────────
    async status(baseUrl) {
      await loadSettings();
      const cfg  = currentConfig();
      const mode = driveMode(cfg);
      const out = {
        connected: false,
        configured: mode !== 'off',
        mode,
        source: driveMode(envCfg) !== 'off' ? 'env' : (settings?.refreshToken ? 'panel' : null),
        redirectUri: baseUrl ? redirectUri(baseUrl) : null,
        folderId: cfg.folderId || null,
        email: null, name: null, storage: null, folder: null, error: null
      };
      if (mode === 'off') return out;

      try {
        const ping = await this.client().ping();
        out.connected = true;
        out.email     = ping?.email || null;
        out.name      = ping?.name || null;
        out.storage   = ping?.storage || null;
        if (cfg.folderId) {
          out.folder = await this.client().folderInfo().catch(e => ({ error: e.message }));
        }
      } catch (e) {
        out.error = e.message;
      }
      return out;
    },

    // ── Korak 1: pripremi Google link za prijavu ─────────────────────────────
    startConnect({ clientId, clientSecret, folderId = '', uid, baseUrl }) {
      if (!clientId || !clientSecret)
        throw httpError('Unesi Client ID i Client Secret iz Google Cloud Console-a');

      const state = crypto.randomBytes(24).toString('hex');
      pending.set(state, { clientId, clientSecret, folderId, uid, at: Date.now() });

      // počisti istekle zahtjeve
      for (const [k, v] of pending) if (Date.now() - v.at > PENDING_TTL) pending.delete(k);

      return { state, url: authUrlFor({ baseUrl, clientId, state }) };
    },

    // ── Korak 2: Google vraća kod → refresh token ────────────────────────────
    async finishConnect({ state, code, baseUrl, error }) {
      const entry = pending.get(state);
      if (!entry) throw httpError('Prijava je istekla ili nije započeta iz ovog panela. Pokušaj ponovo.', 400);
      if (Date.now() - entry.at > PENDING_TTL) { pending.delete(state); throw httpError('Prijava je istekla. Pokušaj ponovo.'); }
      if (error) { pending.delete(state); throw httpError(`Google je odbio prijavu: ${error}`, 400); }
      if (!code) throw httpError('Google nije vratio kod za prijavu');

      const res = await fetch(EP.token, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id:     entry.clientId,
          client_secret: entry.clientSecret,
          redirect_uri:  redirectUri(baseUrl),
          grant_type:    'authorization_code'
        }).toString()
      });
      const data = await res.json().catch(() => ({}));
      pending.delete(state);

      if (!res.ok || !data.refresh_token) {
        const detail = data.error_description || data.error || `HTTP ${res.status}`;
        throw httpError(
          `Google nije vratio trajni pristup (${detail}). ` +
          'Ako si ranije već povezivao aplikaciju, ukloni je na myaccount.google.com/permissions i pokušaj ponovo.',
          400
        );
      }

      const next = {
        clientId:     entry.clientId,
        clientSecret: entry.clientSecret,
        refreshToken: data.refresh_token,
        folderId:     entry.folderId || '',
        connectedBy:  entry.uid || null,
        updatedAt:    new Date().toISOString()
      };
      await saveSettings?.(next);
      settings  = next;
      loaded    = true;
      cached    = null;      // natjeraj da se klijent obnovi sa novim tokenom
      cachedKey = null;

      const status = await this.status(baseUrl);
      if (!status.connected) throw httpError(status.error || 'Prijava je prošla, ali veza ne radi. Provjeri da je Drive API uključen.', 400);
      return status;
    },

    // ── Prekid veze (i opoziv tokena na Google-u) ────────────────────────────
    async disconnect() {
      await loadSettings();
      const token = settings?.refreshToken;
      if (token) {
        await fetch(EP.revoke, {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    new URLSearchParams({ token }).toString()
        }).catch(() => {});
      }
      await clearSettings?.();
      settings  = null;
      loaded    = true;
      cached    = null;
      cachedKey = null;
      return { ok: true };
    },

    // Za testove
    _pending: pending
  };
}
