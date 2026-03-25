import express from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { Mistral } from '@mistralai/mistralai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// ── Firebase Admin init ──────────────────────────────────────────────────────
let adminAuth = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (serviceAccount.project_id) {
    initializeApp({ credential: cert(serviceAccount) });
    adminAuth = getAuth();
    console.log('✅ Firebase Admin inicijalizovan');
  } else {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT nije postavljen — brisanje iz Autha neće raditi');
  }
} catch(e) {
  console.warn('⚠️  Firebase Admin greška:', e.message);
}

app.use(express.json({ limit: '20mb' }));

// Correct MIME types
app.use((req, res, next) => {
  if (req.path.endsWith('.css')) res.type('text/css');
  else if (req.path.endsWith('.js')) res.type('application/javascript');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ── PAGE ROUTES ──────────────────────────────────────────────────────────────
app.get('/',            (req, res) => res.sendFile(path.join(__dirname, 'public/pages/login.html')));
app.get('/login',       (req, res) => res.sendFile(path.join(__dirname, 'public/pages/login.html')));
app.get('/admin',       (req, res) => res.sendFile(path.join(__dirname, 'public/pages/admin.html')));
app.get('/student',     (req, res) => res.sendFile(path.join(__dirname, 'public/pages/student.html')));
app.get('/create-quiz', (req, res) => res.sendFile(path.join(__dirname, 'public/pages/create-quiz.html')));
app.get('/take-quiz',   (req, res) => res.sendFile(path.join(__dirname, 'public/pages/take-quiz.html')));
app.get('/result',      (req, res) => res.sendFile(path.join(__dirname, 'public/pages/result.html')));

// ── API: HEALTH ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true }));
// ── API: DELETE USER FROM AUTH ───────────────────────────────────────────────
app.delete('/api/admin/user/:uid', async (req, res) => {
  if (!adminAuth) {
    return res.status(503).json({ error: 'Firebase Admin nije konfigurisan' });
  }
  try {
    await adminAuth.deleteUser(req.params.uid);
    res.json({ success: true });
  } catch(e) {
    // Ako korisnik ne postoji u Authu, to je ok — možda je već obrisan
    if (e.code === 'auth/user-not-found') {
      res.json({ success: true, note: 'Korisnik nije bio u Authu' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

// ── API: GENERATE QUIZ ───────────────────────────────────────────────────────
app.post('/api/generate-quiz', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'PDF fajl je obavezan' });

    const {
      numQuestions = 10,
      difficulty = 'srednje',
      questionTypes = 'multiple_choice',
      subject = '',
      topic = '',
      batchIndex = '0',
      totalBatches = '1',
      existingQuestions = ''   // JSON string liste već generisanih pitanja
    } = req.body;

    const num = parseInt(numQuestions);
    const bIdx = parseInt(batchIndex);
    const tBatches = parseInt(totalBatches);

    const pdfData = await pdfParse(req.file.buffer);
    // Povećaj limit teksta — za veće kvizove treba više konteksta
    const text = pdfData.text.slice(0, 15000);

    if (text.trim().length < 100)
      return res.status(400).json({ error: 'PDF ne sadrži dovoljno teksta' });

    const diffMap = {
      lako:   'jednostavna pitanja, osnovno razumijevanje',
      srednje: 'pitanja srednje težine, razumijevanje koncepta',
      teško:  'izazovna pitanja, dublje razmišljanje i analiza'
    };
    const typeMap = {
      multiple_choice: 'ISKLJUČIVO višestruki odabir (4 opcije, 1 tačan odgovor)',
      true_false:      'ISKLJUČIVO tačno/netačno pitanja',
      mixed:           'mješovito: 70% višestruki odabir, 30% tačno/netačno'
    };

    // Ako je batch > 0, recite AI-u koja pitanja su već napravljena
    let avoidNote = '';
    if (bIdx > 0 && existingQuestions) {
      try {
        const existing = JSON.parse(existingQuestions);
        const titles = existing.map((q, i) => `${i+1}. ${q.question}`).join('\n');
        avoidNote = `\n\nVAŽNO: Ovo je batch ${bIdx + 1} od ${tBatches}. Sljedeća pitanja su VEĆ GENERISANA — nemoj ih ponavljati niti praviti slična:\n${titles}\n\nGeneriši POTPUNO DRUGAČIJA pitanja koja pokrivaju druge aspekte gradiva.\n`;
      } catch(e) {}
    }

    const prompt = `Si ekspert za obrazovanje. Generiši TAČNO ${num} pitanja za kviz na osnovu gradiva.${avoidNote}

GRADIVO:
${text}

ZAHTJEVI:
- Predmet: ${subject || 'Nije specificiran'}
- Tema: ${topic || 'Iz gradiva'}
- Težina: ${diffMap[difficulty] || diffMap.srednje}
- Tip: ${typeMap[questionTypes] || typeMap.multiple_choice}
- Jezik: Bosanski/Hrvatski/Srpski
- OBAVEZNO generiši TAČNO ${num} pitanja, ne manje

Vrati SAMO JSON, bez markdown backtick-ova, bez ikakvog teksta prije ili poslije:
{
  "title": "Naziv kviza",
  "description": "Kratki opis",
  "questions": [
    {
      "id": "q_${bIdx}_1",
      "type": "multiple_choice",
      "question": "Tekst pitanja?",
      "options": ["A) Opcija 1", "B) Opcija 2", "C) Opcija 3", "D) Opcija 4"],
      "correctAnswer": "A) Opcija 1",
      "explanation": "Kratko objašnjenje",
      "points": 1
    }
  ]
}
Za tačno/netačno: type="true_false", options=["Tačno","Netačno"].
IDs moraju biti jedinstveni — koristi format q_${bIdx}_1, q_${bIdx}_2, itd.`;

    const response = await mistral.chat.complete({
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      maxTokens: 8000   // ← ovo je bio glavni problem! 4000 nije dovoljno za 25 pitanja
    });

    let content = response.choices[0].message.content.trim();
    content = content.replace(/```json|```/g, '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Nevažeći JSON odgovor od AI-a');

    const quiz = JSON.parse(jsonMatch[0]);

    // Validacija — provjeri da ima dovoljno pitanja
    if (!quiz.questions || quiz.questions.length < Math.floor(num * 0.8)) {
      throw new Error(`AI je generisao samo ${quiz.questions?.length || 0} od ${num} traženih pitanja. Pokušaj ponovo.`);
    }

    quiz.totalPoints  = quiz.questions.reduce((s, q) => s + (q.points || 1), 0);
    quiz.numQuestions = quiz.questions.length;
    quiz.difficulty   = difficulty;
    quiz.subject      = subject;
    quiz.topic        = topic;

    res.json({ success: true, quiz });
  } catch (e) {
    console.error('generate-quiz greška:', e);
    res.status(500).json({ error: e.message || 'Greška pri generisanju' });
  }
});

// ── API: GRADE ───────────────────────────────────────────────────────────────
app.post('/api/grade', async (req, res) => {
  try {
    const { questions, studentAnswers, studentName } = req.body;
    let totalPoints = 0, earnedPoints = 0;
    const gradedAnswers = [];

    for (const q of questions) {
      const given   = (studentAnswers[q.id] || '').trim();
      const correct = (q.correctAnswer || '').trim();
      const isCorrect = given === correct;
      const pts = q.points || 1;
      totalPoints += pts;
      if (isCorrect) earnedPoints += pts;
      gradedAnswers.push({
        questionId: q.id, question: q.question,
        studentAnswer: given || 'Bez odgovora',
        correctAnswer: correct, isCorrect,
        points: isCorrect ? pts : 0, maxPoints: pts,
        explanation: q.explanation
      });
    }

    const pct = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;
    const gradeInfo = [
      { min: 84, grade: 5, label: 'Odličan' },
      { min: 70, grade: 4, label: 'Vrlo dobar' },
      { min: 54, grade: 3, label: 'Dobar' },
      { min: 37, grade: 2, label: 'Dovoljan' },
      { min: 0,  grade: 1, label: 'Nedovoljan' }
    ].find(g => pct >= g.min);

    res.json({ success: true, result: {
      studentName, totalPoints, earnedPoints,
      percentage: pct, grade: gradeInfo.grade,
      gradeLabel: gradeInfo.label, gradedAnswers,
      gradedAt: new Date().toISOString()
    }});
  } catch (e) {
    res.status(500).json({ error: 'Greška pri ocjenjivanju' });
  }
});

// ── API: FEEDBACK ────────────────────────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  try {
    const { result, quizTitle } = req.body;
    const wrongAnswers = result.gradedAnswers
      .filter(a => !a.isCorrect)
      .map(a => `- "${a.question}"`)
      .join('\n') || 'Nema grešaka!';

    const prompt = `Si nastavnik. Napiši 2-3 rečenice motivirajuće povratne informacije na bosanskom za učenika.
Kviz: ${quizTitle}
Rezultat: ${result.percentage}%, Ocjena: ${result.grade} (${result.gradeLabel})
Greške:\n${wrongAnswers}
Budi direktan i motivirajući.`;

    const response = await mistral.chat.complete({
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      maxTokens: 200
    });
    res.json({ success: true, feedback: response.choices[0].message.content });
  } catch {
    res.json({ success: true, feedback: '' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 KvizMajstor pokrenut na portu ${PORT}`));
