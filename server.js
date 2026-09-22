import express from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { Mistral } from '@mistralai/mistralai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { createStorageStore } from './lib/storage-store.js';
import { readDriveConfig } from './lib/drive.js';
import { createDriveController } from './lib/drive-controller.js';
import { createDriveStore } from './lib/drive-store.js';
import { register, primaryStore, storeForMaterial } from './lib/file-stores.js';
import { createMaterialsRouter } from './lib/materials-router.js';
import { createDriveRouter } from './lib/drive-router.js';
import { normalizeRazred } from './lib/materials.js';
import { createPresenceRouter } from './lib/presence-router.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app       = express();

// Maksimalna veličina fajla (materijali i PDF za kviz). Može se podesiti
// env varijablom MATERIALS_MAX_MB (npr. 10 za sporiju vezu / manju potrošnju).
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MATERIALS_MAX_MB) || 20);

const upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });
const mistral   = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// ── Firebase Admin init ──────────────────────────────────────────────────────
let adminAuth    = null;
let adminDb      = null;
let adminBucket  = null;
const BUCKET_NAME = process.env.FIREBASE_STORAGE_BUCKET || 'kviz-13f52.firebasestorage.app';
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (serviceAccount.project_id) {
    initializeApp({ credential: cert(serviceAccount), storageBucket: BUCKET_NAME });
    adminAuth = getAuth();
    adminDb   = getFirestore();
    try { adminBucket = getStorage().bucket(); } catch(e) { console.warn('⚠️  Storage bucket greška:', e.message); }
    console.log('✅ Firebase Admin inicijalizovan');
  } else {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT nije postavljen');
  }
} catch(e) {
  console.warn('⚠️  Firebase Admin greška:', e.message);
}

app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  }
}));

// Auth helper
async function getUser(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ') || !adminAuth) return null;
  try {
    return await adminAuth.verifyIdToken(h.slice(7));
  } catch { return null; }
}
async function requireAdmin(req, res) {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ error: 'Niste prijavljeni' }); return null; }
  const snap = await adminDb.collection('users').doc(user.uid).get();
  if (!snap.exists || snap.data()?.role !== 'admin') {
    res.status(403).json({ error: 'Samo admin' }); return null;
  }
  return user;
}

/** Popravi poziciju taba Aktivnost (sidebar na laptopu + mobile nav) */
function serveAdminHtml(req, res) {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'public/pages/admin.html'), 'utf8');

    // Ukloni pogrešno ubačeno dugme (sb-item unutar mobile-nav)
    html = html.replace(
      /\s*<button class="sb-item" data-page="presence"[^>]*>[\s\S]*?<\/button>/,
      ''
    );

    const sidebarBtn = `<button class="sb-item" data-page="presence" onclick="switchPage(this)">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
    Aktivnost
    <span class="sb-badge" id="sb-online-count" style="display:none">0</span>
  </button>`;

    const mobileBtn = `<button class="mobile-nav-item" data-page="presence" onclick="switchPage(this); typeof closeMobileNav==='function'&&closeMobileNav();">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
      Aktivnost
      <span class="nav-badge" id="mob-online-count">0</span>
    </button>`;

    // Sidebar: dodaj ako nema
    if (!html.includes('class="sb-item" data-page="presence"')) {
      if (html.includes('data-page="materials" onclick="switchPage(this)"')) {
        html = html.replace(
          '<button class="sb-item" data-page="materials" onclick="switchPage(this)">',
          sidebarBtn + '\n  <button class="sb-item" data-page="materials" onclick="switchPage(this)">'
        );
      } else if (html.includes('data-page="students" onclick="switchPage(this)"')) {
        html = html.replace(
          /(<button class="sb-item" data-page="students" onclick="switchPage\(this\)">[\s\S]*?<\/button>)/,
          '$1\n' + sidebarBtn
        );
      }
    }

    // Mobile nav: dodaj ako nema
    if (!html.includes('mobile-nav-item" data-page="presence"') && !html.includes("mobile-nav-item' data-page='presence'")) {
      if (html.includes('data-page="materials" onclick="switchPage(this); closeMobileNav')) {
        html = html.replace(
          /<button class="mobile-nav-item" data-page="materials"/,
          mobileBtn + '\n    <button class="mobile-nav-item" data-page="materials"'
        );
      } else if (html.includes('class="mobile-nav-items"')) {
        html = html.replace(
          '</div>\n</nav>\n\n<!-- SIDEBAR -->',
          mobileBtn + '\n  </div>\n</nav>\n\n<!-- SIDEBAR -->'
        );
      }
    }

    // Sync mobile badge u loadPresence
    if (html.includes("sb-online-count") && !html.includes('mob-online-count')) {
      html = html.replace(
        "if (badge) { badge.textContent = data.onlineCount ?? 0; badge.style.display = 'inline'; }",
        "if (badge) { badge.textContent = data.onlineCount ?? 0; badge.style.display = 'inline'; }\n"
        + "    const mobBadge = document.getElementById('mob-online-count');\n"
        + "    if (mobBadge) mobBadge.textContent = data.onlineCount ?? 0;"
      );
    }

    res.type('html').send(html);
  } catch (e) {
    console.error('serveAdminHtml', e);
    res.sendFile(path.join(__dirname, 'public/pages/admin.html'));
  }
}

app.get('/',            (req, res) => res.sendFile(path.join(__dirname, 'public/pages/login.html')));
app.get('/login',       (req, res) => res.sendFile(path.join(__dirname, 'public/pages/login.html')));
app.get('/admin',       serveAdminHtml);
app.get('/student',     (req, res) => res.sendFile(path.join(__dirname, 'public/pages/student.html')));
app.get('/create-quiz', (req, res) => res.sendFile(path.join(__dirname, 'public/pages/create-quiz.html')));
app.get('/take-quiz',   (req, res) => res.sendFile(path.join(__dirname, 'public/pages/take-quiz.html')));
app.get('/result',      (req, res) => res.sendFile(path.join(__dirname, 'public/pages/result.html')));
app.get('/materijali',  (req, res) => res.redirect('/student'));
app.get('/viewer',      (req, res) => res.sendFile(path.join(__dirname, 'public/pages/material.html')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Presence
app.use(createPresenceRouter({ getUser, requireAdmin, getDb: () => adminDb }));

// Materials + Drive
const storageStore = createStorageStore({ getBucket: () => adminBucket });
const driveCtrl = createDriveController({ getDb: () => adminDb });
const driveStore = createDriveStore({ getController: () => driveCtrl });
register('storage', storageStore);
register('drive', driveStore);

app.use(createMaterialsRouter({
  upload,
  getUser,
  requireAdmin,
  getDb: () => adminDb,
  primaryStore,
  storeForMaterial,
  maxUploadMb: MAX_UPLOAD_MB
}));
app.use(createDriveRouter({ getUser, requireAdmin, getController: () => driveCtrl }));

// ── Admin user management
app.delete('/api/admin/user/:uid', async (req, res) => {
  if (!adminAuth) return res.status(503).json({ error: 'Firebase nije spreman' });
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    await adminAuth.deleteUser(req.params.uid);
    if (adminDb) await adminDb.collection('users').doc(req.params.uid).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/user/:uid', async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: 'Firebase nije spreman' });
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const updates = {};
    const { displayName, razred, smjer, role } = req.body || {};
    if (displayName !== undefined) updates.displayName = displayName;
    if (razred !== undefined) updates.razred = normalizeRazred(razred);
    if (smjer !== undefined) updates.smjer = smjer;
    if (role !== undefined) updates.role = role;
    await adminDb.collection('users').doc(req.params.uid).set(updates, { merge: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Generate quiz
app.post('/api/generate-quiz', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'PDF nije poslan' });
    const numQuestions = parseInt(req.body.numQuestions || '10', 10);
    const difficulty = req.body.difficulty || 'srednje';
    const subject = req.body.subject || '';
    const topic = req.body.topic || '';
    let questionTypes = ['multiple_choice'];
    try { questionTypes = JSON.parse(req.body.questionTypes || '[]'); } catch {}
    if (!questionTypes.length) questionTypes = ['multiple_choice'];

    const pdfData = await pdfParse(req.file.buffer);
    const text = (pdfData.text || '').slice(0, 12000);
    if (text.length < 50) return res.status(400).json({ error: 'PDF nema dovoljno teksta' });

    const prompt = `Na osnovu sljedećeg nastavnog materijala generiši ${numQuestions} kviz pitanja na bosanskom jeziku.
Predmet: ${subject || 'opće'}
Tema: ${topic || 'opće'}
Težina: ${difficulty}
Tipovi: ${questionTypes.join(', ')}

Materijal:
${text}

Vrati ISKLJUČIVO validan JSON niz objekata oblika:
[{"id":"q1","question":"...","options":["A","B","C","D"],"correctAnswer":"A","points":1,"explanation":"..."}]
Bez markdowna, bez komentara.`;

    const response = await mistral.chat.complete({
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      maxTokens: 4000
    });

    let raw = response.choices[0].message.content.trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    const questions = JSON.parse(raw);
    if (!Array.isArray(questions) || !questions.length) throw new Error('AI nije vratio pitanja');
    res.json({ success: true, questions });
  } catch (e) {
    console.error('generate-quiz', e);
    res.status(500).json({ error: e.message || 'Greška pri generisanju' });
  }
});

// ── Grade
app.post('/api/grade', async (req, res) => {
  try {
    const { questions, studentAnswers, studentName } = req.body || {};
    if (!Array.isArray(questions)) return res.status(400).json({ error: 'Nedostaju pitanja' });
    let totalPoints = 0, earnedPoints = 0;
    const gradedAnswers = questions.map((q) => {
      const pts = q.points || 1;
      totalPoints += pts;
      const ans = studentAnswers?.[q.id];
      const isCorrect = ans !== undefined && String(ans).trim() === String(q.correctAnswer).trim();
      if (isCorrect) earnedPoints += pts;
      return {
        questionId: q.id,
        question: q.question,
        options: q.options,
        correctAnswer: q.correctAnswer,
        studentAnswer: ans ?? null,
        isCorrect,
        points: pts,
        earned: isCorrect ? pts : 0,
        explanation: q.explanation || ''
      };
    });
    const pct = totalPoints ? Math.round((earnedPoints / totalPoints) * 100) : 0;
    const gradeInfo = [
      { min: 84, grade: 5, label: 'Odličan' },
      { min: 70, grade: 4, label: 'Vrlo dobar' },
      { min: 54, grade: 3, label: 'Dobar' },
      { min: 37, grade: 2, label: 'Dovoljan' },
      { min: 0, grade: 1, label: 'Nedovoljan' }
    ].find(g => pct >= g.min);
    res.json({
      success: true,
      result: {
        studentName, totalPoints, earnedPoints,
        percentage: pct,
        grade: gradeInfo.grade,
        gradeLabel: gradeInfo.label,
        gradedAnswers,
        gradedAt: new Date().toISOString()
      }
    });
  } catch (e) {
    console.error('grade', e);
    res.status(500).json({ error: 'Greška pri ocjenjivanju' });
  }
});

// ── Feedback
app.post('/api/feedback', async (req, res) => {
  try {
    const { result, quizTitle } = req.body;
    const wrongAnswers = (result.gradedAnswers || [])
      .filter(a => !a.isCorrect)
      .map(a => `- "${a.question}"`)
      .join('\n') || 'Nema grešaka!';
    const prompt = `Si nastavnik. Napiši 2-3 rečenice motivirajuće povratne informacije na bosanskom jeziku za učenika.
Kviz: ${quizTitle}
Rezultat: ${result.percentage}%, Ocjena: ${result.grade} (${result.gradeLabel})
Pogrešna pitanja:\n${wrongAnswers}
Budi direktan, konkretan i motivirajući.`;
    const response = await mistral.chat.complete({
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      maxTokens: 200
    });
    res.json({ success: true, feedback: response.choices[0].message.content });
  } catch (e) {
    console.error('feedback', e);
    res.json({ success: true, feedback: '' });
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: `Fajl je prevelik. Maksimalno ${MAX_UPLOAD_MB} MB.` });
  console.error('error', err?.message || err);
  res.status(err?.status || 500).json({ error: err?.message || 'Greška na serveru' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 KvizMajstor pokrenut na portu ${PORT}`));
