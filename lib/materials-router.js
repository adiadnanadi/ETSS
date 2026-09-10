// ════════════════════════════════════════════════════════════════════════════
// Rute za "Literatura" (materijali).
//
// Upload ide DIREKTNO na Google Drive iz admin stranice (bez odlaska na Drive).
// Serviranje fajla ide kroz našu stranicu, pa učenik ne mora imati Google nalog
// niti pristup Drive-u — a materijal ima svoj link (/m/<token>) koji radi i
// bez prijave, ako je dijeljenje uključeno.
//
// Router je zavisnostima injektiran (getUser, storeForMaterial...) pa se može
// testirati bez Firebasea i bez Google-a — vidi tests/materials-api.test.mjs.
// ════════════════════════════════════════════════════════════════════════════

import express from 'express';
import crypto from 'crypto';
import {
  fileExt, isAllowedFile, isInlineExt, mimeForExt, sanitizeFileName,
  parseRange, canAccessMaterial, publicMaterial, contentDisposition
} from './materials.js';

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function sendError(res, e, where) {
  const status = e?.status || 500;
  if (status >= 500) console.error(`❌ ${where}:`, e?.message || e);
  res.status(status).json({ error: e?.message || 'Greška' });
}

function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host  = req.headers['x-forwarded-host'] || req.get?.('host') || req.headers.host;
  return `${proto}://${host}`;
}

export function createMaterialsRouter({
  getDb,
  storeForMaterial,
  storageSummary   = () => ({}),
  primaryStore     = null,      // () => store za nove uploude
  getUser,
  requireAdmin,
  upload,
  driveStatus      = null,      // async () => ({...}) | null
  maxUploadMb      = 20
}) {
  const router = express.Router();

  const dbOrFail = () => { const db = getDb(); if (!db) throw httpError('Baza nije konfigurisana', 503); return db; };
  const col      = () => dbOrFail().collection('materials');
  const newId    = () => `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  async function findById(id) {
    const snap = await col().doc(id).get();
    if (!snap.exists) throw httpError('Materijal ne postoji', 404);
    return { id, material: snap.data() };
  }

  function storeOf(material) {
    const store = storeForMaterial(material);
    if (!store) throw httpError('Skladište fajlova nije konfigurisano', 503);
    return store;
  }

  // ── Prikaz materijala + linkovi (nikad ne curimo Drive ID / storage putanju) ─
  function decorate(req, user, material) {
    const isAdmin = user?.role === 'admin';
    const store   = storeForMaterial(material);
    const out     = publicMaterial(material, { isAdmin });
    const base    = baseUrl(req);

    out.storeKind  = store?.kind || null;
    out.storeLabel = store?.label || null;

    const shared  = material.shareEnabled !== false && !!material.shareToken;
    out.shareUrl  = shared ? `${base}/m/${material.shareToken}` : null;
    out.links     = {
      file:     `${base}/api/materials/${material.id}/file`,
      page:     shared ? `${base}/viewer?m=${material.shareToken}` : `${base}/viewer?id=${material.id}`,
      view:     shared ? `${base}/m/${material.shareToken}` : null,
      download: shared ? `${base}/m/${material.shareToken}?download=1` : null
    };

    // Google Drive link: admin uvijek, učenik samo ako je fajl javno podijeljen
    const driveLinks = store?.linkFor ? store.linkFor(material) : null;
    if (driveLinks && (isAdmin || material.driveShared)) out.drive = driveLinks;

    return out;
  }

  // ── Slanje fajla (stream preko store-a ili Buffer + Range) ─────────────────
  async function serveFile(req, res, { id, material, download = false, inline = false }) {
    const store = storeOf(material);
    const asAttachment = download || (!inline && !isInlineExt(material.ext));

    res.setHeader('Cache-Control', 'private, max-age=300');

    if (download) {
      col().doc(id).update({ downloads: (material.downloads || 0) + 1 }).catch(() => {});
    }

    // 1) Store koji ume sam da streamuje (Google Drive, Firebase Storage)
    if (typeof store.streamTo === 'function') {
      return store.streamTo(req, res, material, {
        download: asAttachment,
        contentDisposition: contentDisposition(material.fileName, asAttachment)
      });
    }

    // 2) Store koji vraća Buffer (Firestore chunk-ovi) — sami radimo Range
    const size = Number(material.size) || 0;
    const range = size > 0 ? parseRange(req.headers.range, size) : null;
    if (range && range.unsatisfiable) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }

    const buffer = await store.read(material);
    if (!buffer || buffer.length === 0)
      throw httpError('Fajl nije pronađen u skladištu. Obriši materijal i dodaj ga ponovo.', 410);

    res.setHeader('Content-Type', material.mimeType || mimeForExt(material.ext));
    res.setHeader('Content-Disposition', contentDisposition(material.fileName, asAttachment));
    res.setHeader('Accept-Ranges', 'bytes');

    if (!range) {
      res.setHeader('Content-Length', buffer.length);
      return res.end(buffer);
    }
    const chunk = buffer.subarray(range.start, range.end + 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${buffer.length}`);
    res.setHeader('Content-Length', chunk.length);
    res.end(chunk);
  }

  // ── LIST: admin sve, učenik samo svoj razred i vidljivo ────────────────────
  router.get('/api/materials', async (req, res) => {
    try {
      const user = await getUser(req);
      const snap = await col().get();
      let items  = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      if (user.role !== 'admin') items = items.filter(m => canAccessMaterial(m, user));
      items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

      res.json({ success: true, materials: items.map(m => decorate(req, user, m)) });
    } catch (e) { sendError(res, e, 'materials list'); }
  });

  // ── STATUS skladišta (admin) — da se odmah vidi je li Drive povezan ────────
  router.get('/api/storage/status', async (req, res) => {
    try {
      await requireAdmin(req);
      const summary = { ...storageSummary(), maxUploadMb };
      if (typeof driveStatus === 'function') {
        summary.drive = await driveStatus();
      }
      res.json({ success: true, ...summary });
    } catch (e) { sendError(res, e, 'storage status'); }
  });

  // ── UPLOAD (samo admin) → fajl ide na Google Drive ─────────────────────────
  router.post('/api/materials', upload.single('file'), async (req, res) => {
    let materialId = null;
    let store      = null;
    let storedFields = null;
    try {
      const user = await requireAdmin(req);
      if (!req.file) throw httpError('Fajl je obavezan', 400);

      const origName = req.file.originalname || 'dokument';
      const ext      = fileExt(origName);
      if (!isAllowedFile(origName))
        throw httpError('Dozvoljeni formati: PDF, DOC, DOCX, PPT, PPTX, TXT', 400);

      const {
        title = '', description = '', subject = '', razredi = '[]',
        shareEnabled = '1'
      } = req.body || {};

      let razrediArr = [];
      try { razrediArr = JSON.parse(razredi); } catch { razrediArr = razredi ? [razredi] : []; }
      if (!Array.isArray(razrediArr)) razrediArr = [];

      materialId = newId();
      store      = (primaryStore && primaryStore()) || storeForMaterial({});   // Drive, ako je povezan
      if (typeof store.uploadMaterial !== 'function')
        throw httpError(`Skladište "${store.kind}" ne podržava dodavanje novih fajlova`, 503);

      const cleanTitle = String(title).trim() || origName;
      const wantsShare = String(shareEnabled) !== '0' && String(shareEnabled) !== 'false';

      const fields = typeof store.uploadMaterial === 'function'
        ? await store.uploadMaterial({
            materialId,
            title:       cleanTitle,
            description: String(description).trim(),
            fileName:    origName,
            ext,
            mimeType:    mimeForExt(ext),
            buffer:      req.file.buffer,
            share:       wantsShare          // Drive dozvola samo ako je javni link uključen
          })
        : {};

      storedFields = fields;
      if (wantsShare && typeof store.shareFile === 'function' && fields.driveFileId && !fields.driveShared) {
        fields.driveShared = await store.shareFile({ ...fields, ext }, true).catch(() => false);
      }

      const docData = {
        title:       cleanTitle,
        description: String(description).trim(),
        subject:     String(subject).trim(),
        razredi:     razrediArr.map(r => String(r).trim()).filter(Boolean),
        fileName:    origName,
        ext,
        mimeType:    mimeForExt(ext),
        size:        req.file.size,
        uploadedBy:  user.uid,
        uploadedByName: user.displayName,
        visible:     true,
        shareEnabled: wantsShare,
        shareToken:  crypto.randomBytes(12).toString('hex'),
        downloads:   0,
        createdAt:   new Date().toISOString(),
        fileStore:   store.kind,
        ...fields
      };

      await col().doc(materialId).set(docData);
      res.json({ success: true, material: decorate(req, user, { id: materialId, ...docData }) });
    } catch (e) {
      if (storedFields && store && materialId)
        await store.removeMaterial({ id: materialId, ...storedFields }).catch(() => {});
      sendError(res, e, 'materials upload');
    }
  });

  // ── UPDATE meta (samo admin) ───────────────────────────────────────────────
  router.put('/api/materials/:id', async (req, res) => {
    try {
      const user = await requireAdmin(req);
      const { title, description, subject, razredi, visible, shareEnabled } = req.body || {};
      const upd = { updatedAt: new Date().toISOString() };
      if (title !== undefined)        upd.title        = String(title).trim();
      if (description !== undefined)  upd.description  = String(description).trim();
      if (subject !== undefined)      upd.subject      = String(subject).trim();
      if (visible !== undefined)      upd.visible      = !!visible;
      if (shareEnabled !== undefined) upd.shareEnabled = !!shareEnabled;
      if (razredi !== undefined)      upd.razredi      = (Array.isArray(razredi) ? razredi : []).map(r => String(r).trim()).filter(Boolean);

      const { id, material } = await findById(req.params.id);
      const store = storeForMaterial(material);

      // Naziv/opis na Drive-u prati naziv materijala
      if (store?.syncMeta) await store.syncMeta(material, upd).catch(() => {});

      // Uključivanje/isključivanje javnog linka → Drive dozvola
      if (upd.shareEnabled !== undefined && store?.shareFile && material.driveFileId) {
        const ok = await store.shareFile(material, upd.shareEnabled).catch(e => {
          console.warn('⚠️  Drive dijeljenje:', e.message);
          return material.driveShared;
        });
        upd.driveShared = !!ok;
      }
      if (upd.shareEnabled === true && !material.shareToken) {
        upd.shareToken = crypto.randomBytes(12).toString('hex');
      }

      await col().doc(id).update(upd);
      res.json({ success: true, updated: upd, material: decorate(req, user, { id, ...material, ...upd }) });
    } catch (e) { sendError(res, e, 'materials update'); }
  });

  // ── Osveži/promijeni Google Drive link (admin) ─────────────────────────────
  router.get('/api/materials/:id/drive-link', async (req, res) => {
    try {
      const user = await requireAdmin(req);
      const { id, material } = await findById(req.params.id);
      const store = storeForMaterial(material);
      const links = store?.linkFor ? store.linkFor(material) : null;
      if (!links) throw httpError('Ovaj materijal nije na Google Drive-u', 404);
      res.json({ success: true, ...links, shared: !!material.driveShared, id });
    } catch (e) { sendError(res, e, 'materials drive link'); }
  });

  // ── DELETE (samo admin) — briše i fajl iz skladišta ────────────────────────
  router.delete('/api/materials/:id', async (req, res) => {
    try {
      await requireAdmin(req);
      const { id, material } = await findById(req.params.id);
      const store = storeForMaterial(material);
      if (store?.removeMaterial) {
        try { await store.removeMaterial({ id, ...material }); }
        catch (e) { console.warn('⚠️  Brisanje fajla:', e.message); }
      }
      await col().doc(id).delete();
      res.json({ success: true });
    } catch (e) { sendError(res, e, 'materials delete'); }
  });

  // ── FILE (prijavljeni korisnik; Bearer ili ?token=) ────────────────────────
  router.get('/api/materials/:id/file', async (req, res) => {
    try {
      const t = req.query.token;
      if (t && !req.headers.authorization) req.headers.authorization = 'Bearer ' + t;
      const user = await getUser(req);

      const { id, material } = await findById(req.params.id);
      if (!canAccessMaterial(material, user)) throw httpError('Nemate pristup ovom materijalu', 403);

      await serveFile(req, res, { id, material, download: req.query.download === '1', inline: req.query.inline === '1' });
    } catch (e) { sendError(res, e, 'materials file'); }
  });

  // ── META (za viewer stranicu: prijavljeni) ─────────────────────────────────
  router.get('/api/materials/:id/meta', async (req, res) => {
    try {
      const t = req.query.token;
      if (t && !req.headers.authorization) req.headers.authorization = 'Bearer ' + t;
      const user = await getUser(req);
      const { id, material } = await findById(req.params.id);
      if (!canAccessMaterial(material, user)) throw httpError('Nemate pristup ovom materijalu', 403);
      res.json({ success: true, material: decorate(req, user, { id, ...material }) });
    } catch (e) { sendError(res, e, 'materials meta'); }
  });

  // ── JAVNI LINK: /m/<shareToken> — radi bez prijave ─────────────────────────
  router.get('/m/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '');
      if (!/^[a-f0-9]{8,64}$/i.test(token)) throw httpError('Link nije važeći', 404);

      const snap = await col().where('shareToken', '==', token).limit(1).get();
      if (snap.empty) throw httpError('Link nije važeći ili je materijal obrisan', 404);

      const doc = snap.docs[0];
      const material = doc.data();
      if (material.shareEnabled === false) throw httpError('Dijeljenje ovog materijala je isključeno', 403);

      await serveFile(req, res, {
        id: doc.id, material,
        download: req.query.download === '1',
        inline:   req.query.view === '1' || req.query.inline === '1'
      });
    } catch (e) { sendError(res, e, 'materials share'); }
  });

  // ── META za javni link (viewer bez prijave) ────────────────────────────────
  router.get('/api/materials/public/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '');
      if (!/^[a-f0-9]{8,64}$/i.test(token)) throw httpError('Link nije važeći', 404);

      const snap = await col().where('shareToken', '==', token).limit(1).get();
      if (snap.empty) throw httpError('Link nije važeći ili je materijal obrisan', 404);

      const doc = snap.docs[0];
      const material = doc.data();
      if (material.shareEnabled === false) throw httpError('Dijeljenje ovog materijala je isključeno', 403);

      const out = decorate(req, null, { id: doc.id, ...material });
      delete out.razredi;                  // javna stranica ne treba razrede
      out.links.file = `${baseUrl(req)}/m/${token}`;
      delete out.drive;                    // Drive link ne izlažemo javno
      res.json({ success: true, material: out });
    } catch (e) { sendError(res, e, 'materials public meta'); }
  });

  return router;
}
