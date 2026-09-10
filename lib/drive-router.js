// ════════════════════════════════════════════════════════════════════════════
// Rute za povezivanje Google Drive-a iz samog admin panela.
//
//   GET  /api/drive/status            (admin)  — je li povezan, koji nalog, kvota
//   POST /api/drive/connect           (admin)  — { clientId, clientSecret, folderId } → Google link
//   GET  /api/drive/connect/callback  (javno)  — Google vraća kod; ovdje se sprema refresh token
//   POST /api/drive/disconnect        (admin)  — prekida vezu i opoziva token
//
// Callback mora biti javan jer Google preusmjerava browser korisnika na njega;
// sigurnost nosi jednokratni `state` (24 bajta) koji je vezan za admin sesiju.
// ════════════════════════════════════════════════════════════════════════════

import express from 'express';

export function createDriveRouter({ requireAdmin, drive, pageUrl = '/admin' }) {
  const router = express.Router();

  const baseUrl = (req) => {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host  = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
  };

  function sendError(res, e) {
    const status = e?.status || 500;
    if (status >= 500) console.error('❌ drive:', e?.message || e);
    res.status(status).json({ error: e?.message || 'Greška' });
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  router.get('/api/drive/status', async (req, res) => {
    try {
      await requireAdmin(req);
      const status = await drive.status(baseUrl(req));
      res.json({ success: true, ...status });
    } catch (e) { sendError(res, e); }
  });

  // ── Korak 1: vrati Google link za prijavu ──────────────────────────────────
  router.post('/api/drive/connect', async (req, res) => {
    try {
      const user = await requireAdmin(req);
      const { clientId, clientSecret, folderId = '' } = req.body || {};
      const { url, state } = drive.startConnect({
        clientId:     String(clientId || '').trim(),
        clientSecret: String(clientSecret || '').trim(),
        folderId:     String(folderId || '').trim(),
        uid:          user.uid,
        baseUrl:      baseUrl(req)
      });
      res.json({ success: true, url, state, redirectUri: drive.redirectUri(baseUrl(req)) });
    } catch (e) { sendError(res, e); }
  });

  // ── Korak 2: Google preusmjerava ovdje ─────────────────────────────────────
  router.get('/api/drive/connect/callback', async (req, res) => {
    const { code, state, error } = req.query;
    try {
      const status = await drive.finishConnect({ state, code, error, baseUrl: baseUrl(req) });
      res.redirect(`${pageUrl}?drive=connected&account=${encodeURIComponent(status.email || '')}`);
    } catch (e) {
      console.error('❌ drive callback:', e.message);
      res.redirect(`${pageUrl}?drive=error&msg=${encodeURIComponent(e.message)}`);
    }
  });

  // ── Prekid veze ────────────────────────────────────────────────────────────
  router.post('/api/drive/disconnect', async (req, res) => {
    try {
      await requireAdmin(req);
      await drive.disconnect();
      res.json({ success: true });
    } catch (e) { sendError(res, e); }
  });

  return router;
}
