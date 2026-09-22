// Presence API — aktivni korisnici + IP
import { Router } from 'express';

export function createPresenceRouter({ getUser, requireAdmin, getDb }) {
  const router = Router();

  function getClientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  router.post('/api/presence', async (req, res) => {
    try {
      const user = await getUser(req);
      const adminDb = getDb();
      if (!adminDb) return res.status(503).json({ error: 'Baza nije konfigurisana' });

      const ip   = getClientIp(req);
      const ua   = String(req.headers['user-agent'] || '').slice(0, 300);
      const page = String(req.body?.page || '').slice(0, 120) || null;
      const now  = new Date().toISOString();

      const ref  = adminDb.collection('presence').doc(user.uid);
      const prev = await ref.get();

      const data = {
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || user.email || '',
        role: user.role || 'student',
        razred: user.razred || '',
        ip,
        userAgent: ua,
        page,
        lastSeen: now,
        updatedAt: now
      };
      if (!prev.exists) data.firstSeen = now;

      await ref.set(data, { merge: true });
      res.json({ ok: true });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('❌ presence:', e.message);
      res.status(status).json({ error: e.message || 'Greška' });
    }
  });

  router.get('/api/admin/presence', async (req, res) => {
    try {
      await requireAdmin(req);
      const adminDb = getDb();
      if (!adminDb) return res.status(503).json({ error: 'Baza nije konfigurisana' });

      const ONLINE_MS = 5 * 60 * 1000;
      const snap = await adminDb.collection('presence')
        .orderBy('lastSeen', 'desc')
        .limit(200)
        .get();

      const now = Date.now();
      const users = snap.docs.map(d => {
        const x = d.data();
        const last = new Date(x.lastSeen || 0).getTime();
        return {
          uid: x.uid || d.id,
          email: x.email || '',
          displayName: x.displayName || x.email || '—',
          role: x.role || 'student',
          razred: x.razred || '',
          ip: x.ip || '—',
          userAgent: x.userAgent || '',
          page: x.page || '',
          lastSeen: x.lastSeen || null,
          firstSeen: x.firstSeen || null,
          online: Number.isFinite(last) && (now - last) < ONLINE_MS
        };
      });

      res.json({
        success: true,
        onlineCount: users.filter(u => u.online).length,
        totalTracked: users.length,
        users
      });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('❌ admin presence:', e.message);
      res.status(status).json({ error: e.message || 'Greška' });
    }
  });

  return router;
}
