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
const app       = express();
const upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const mistral   = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// ── Firebase Admin init ──────────────────────────────────────────────────────
let adminAuth = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (serviceAccount.project_id) {
    initializeApp({ credential: cert(serviceAccount) });
    adminAuth = getAuth();
    console.log('✅ Firebase Admin inicijalizovan');
  } else {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT nije postavljen');
  }
} catch(e) {
  console.warn('⚠️  Firebase Admin greška:', e.message);
}

app.use(express.json({ limit: '20mb' }));
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

// ── API: DELETE USER ─────────────────────────────────────────────────────────
app.delete('/api/admin/user/:uid', async (req, res) => {
  if (!adminAuth)
    return res.status(503).json({ error: 'Firebase Admin nije konfigurisan' });
  try {
    await adminAuth.deleteUser(req.params.uid);
    res.json({ success: true });
  } catch(e) {
    if (e.code === 'auth/user-not-found')
      res.json({ success: true, note: 'Korisnik nije bio u Authu' });
    else
      res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

// ── Fisher-Yates shuffle ─────────────────────────────────────────────────────
function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Shuffle opcija jednog pitanja ────────────────────────────────────────────
// Miješa opcije ali čuva koji je tačan odgovor
function serverShuffleQuestion(q) {
  // true_false ne miješamo (Tačno/Netačno ostaje kako jeste)
  if (q.type === 'true_false' || !q.options) return q;

  const correct  = q.correctAnswer;
  const shuffled = fisherYates(q.options);
  return { ...q, options: shuffled, correctAnswer: correct };
}

// ── Enforce distribucija tačnih odgovora ─────────────────────────────────────
// Garantuje da nijedna pozicija (1., 2., 3., 4.) nema više od 35% tačnih
function serverEnforceDistribution(questions) {
  const mcQuestions = questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) =>
      q.type === 'multiple_choice' &&
      Array.isArray(q.options) &&
      q.options.length >= 2
    );

  if (mcQuestions.length < 4) return questions;

  const total     = mcQuestions.length;
  const maxPerPos = Math.ceil(total * 0.35); // max 35% po poziciji

  // Broji koliko puta je svaka pozicija tačna
  const posCount = new Array(4).fill(0);
  mcQuestions.forEach(({ q }) => {
    const pos = q.options.indexOf(q.correctAnswer);
    if (pos >= 0 && pos < 4) posCount[pos]++;
  });

  console.log('📊 Distribucija tačnih odgovora (prije enforce):', {
    'Pozicija 1': posCount[0],
    'Pozicija 2': posCount[1],
    'Pozicija 3': posCount[2],
    'Pozicija 4': posCount[3],
  });

  const result = [...questions];

  // Sortiraj – prvo popravlja najpreopterećenije pozicije
  const sorted = [...mcQuestions].sort((a, b) => {
    const posA = a.q.options.indexOf(a.q.correctAnswer);
    const posB = b.q.options.indexOf(b.q.correctAnswer);
    return (posCount[posB] || 0) - (posCount[posA] || 0);
  });

  sorted.forEach(({ q, i }) => {
    const currentPos = q.options.indexOf(q.correctAnswer);
    if (currentPos < 0 || posCount[currentPos] <= maxPerPos) return;

    // Nađi poziciju sa najmanje tačnih
    const targetPos = posCount
      .map((cnt, pos) => ({ cnt, pos }))
      .filter(({ pos }) => pos !== currentPos && pos < q.options.length)
      .sort((a, b) => a.cnt - b.cnt)[0]?.pos;

    if (targetPos === undefined) return;

    // Swap opcija na ciljanu poziciju
    const newOpts = [...q.options];
    [newOpts[currentPos], newOpts[targetPos]] = [newOpts[targetPos], newOpts[currentPos]];

    posCount[currentPos]--;
    posCount[targetPos]++;

    result[i] = { ...q, options: newOpts };
  });

  console.log('📊 Distribucija tačnih odgovora (poslije enforce):', {
    'Pozicija 1': posCount[0],
    'Pozicija 2': posCount[1],
    'Pozicija 3': posCount[2],
    'Pozicija 4': posCount[3],
  });

  return result;
}

// ── Ukloni A) B) C) D) prefikse iz opcija ───────────────────────────────────
function cleanPrefixes(questions) {
  return questions.map(q => {
    if (!q.options) return q;
    const cleaned = q.options.map(o =>
      o.replace(/^[A-Da-d][\)\.\s]\s*/,'').trim()
    );
    const newCorrect = q.correctAnswer
      ? q.correctAnswer.replace(/^[A-Da-d][\)\.\s]\s*/,'').trim()
      : undefined;
    return {
      ...q,
      options:       cleaned,
      correctAnswer: newCorrect,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// API: GENERATE QUIZ
// ════════════════════════════════════════════════════════════════════════════
app.post('/api/generate-quiz', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: 'PDF fajl je obavezan' });

    const {
      numQuestions      = 10,
      difficulty        = 'srednje',
      questionTypes     = 'multiple_choice',
      subject           = '',
      topic             = '',
      batchIndex        = '0',
      totalBatches      = '1',
      existingQuestions = ''
    } = req.body;

    const num      = parseInt(numQuestions);
    const bIdx     = parseInt(batchIndex);
    const tBatches = parseInt(totalBatches);

    // ── Parsiraj PDF ─────────────────────────────────────────────────────────
    const pdfData = await pdfParse(req.file.buffer);
    const text    = pdfData.text.slice(0, 15000);

    if (text.trim().length < 100)
      return res.status(400).json({ error: 'PDF ne sadrži dovoljno teksta' });

    // ── Težina ───────────────────────────────────────────────────────────────
    const diffMap = {
      lako:    'jednostavna pitanja, osnovno razumijevanje gradiva',
      srednje: 'pitanja srednje težine, razumijevanje koncepta',
      teško:   'izazovna pitanja, dublje razmišljanje i analiza'
    };

    // ── Tip pitanja (samo multiple_choice i true_false) ──────────────────────
    let parsedTypes = [];
    try   { parsedTypes = JSON.parse(questionTypes); }
    catch { parsedTypes = [questionTypes]; }

    let typeInstruction = '';
    if (parsedTypes.includes('mixed')) {
      typeInstruction = 'Mješovito: 70% multiple_choice (višestruki odabir, 4 opcije, SAMO 1 tačan odgovor), 30% true_false (tačno/netačno)';
    } else {
      const parts = [];
      if (parsedTypes.includes('multiple_choice'))
        parts.push('multiple_choice (višestruki odabir, 4 opcije, SAMO 1 tačan odgovor)');
      if (parsedTypes.includes('true_false'))
        parts.push('true_false (tačno/netačno)');
      typeInstruction = parts.length > 0 ? parts.join(' + ') : 'multiple_choice (višestruki odabir, 4 opcije)';
    }

    // ── Avoid note za batches ────────────────────────────────────────────────
    let avoidNote = '';
    if (bIdx > 0 && existingQuestions) {
      try {
        const existing = JSON.parse(existingQuestions);
        const titles   = existing.map((q, i) => `${i+1}. ${q.question}`).join('\n');
        avoidNote = `\n\nVAŽNO: Ovo je batch ${bIdx + 1} od ${tBatches}.
Sljedeća pitanja su VEĆ GENERISANA — nemoj ih ponavljati niti praviti slična:
${titles}
Generiši POTPUNO DRUGAČIJA pitanja koja pokrivaju druge aspekte gradiva.\n`;
      } catch(e) { /* ignoriši */ }
    }

    // ── Prompt ───────────────────────────────────────────────────────────────
    const prompt = `Si ekspert za obrazovanje. Generiši TAČNO ${num} pitanja za kviz na osnovu gradiva.${avoidNote}

GRADIVO:
${text}

ZAHTJEVI:
- Predmet: ${subject || 'Nije specificiran'}
- Tema: ${topic || 'Iz gradiva'}
- Težina: ${diffMap[difficulty] || diffMap.srednje}
- Tip pitanja: ${typeInstruction}
- Jezik: Bosanski/Hrvatski/Srpski
- OBAVEZNO generiši TAČNO ${num} pitanja, ne manje

════════════════════════════════════════════════════════
KRITIČNO – RASPORED TAČNIH ODGOVORA:
════════════════════════════════════════════════════════
Za multiple_choice pitanja OBAVEZNO vrijede sljedeća pravila:
- STROGO ZABRANJENO: staviti tačan odgovor uvijek na istu poziciju
- OBAVEZNO: tačni odgovori moraju biti ravnomjerno raspoređeni
- Od ${num} pitanja otprilike:
  * ${Math.round(num * 0.25)} pitanja: tačan odgovor je PRVA opcija u nizu
  * ${Math.round(num * 0.25)} pitanja: tačan odgovor je DRUGA opcija u nizu
  * ${Math.round(num * 0.25)} pitanja: tačan odgovor je TREĆA opcija u nizu
  * ${Math.round(num * 0.25)} pitanja: tačan odgovor je ČETVRTA opcija u nizu
- NIKADA ne stavljaj tačan odgovor na istu poziciju u većini pitanja
- NEMOJ dodavati slova (A, B, C, D) ispred opcija — samo čisti tekst opcije
- correctAnswer mora biti IDENTIČAN tekst kao odgovarajuća stavka u options nizu
- Svako pitanje ima TAČNO 1 tačan odgovor — NIKADA više
- NE KORISTITI tip multi_answer — ZABRANJENO
════════════════════════════════════════════════════════

Vrati SAMO JSON bez ikakvog teksta, objašnjenja ili markdown-a prije ili poslije:
{
  "title": "Naziv kviza",
  "description": "Kratki opis kviza",
  "questions": [
    {
      "id": "q_${bIdx}_1",
      "type": "multiple_choice",
      "question": "Tekst pitanja?",
      "options": ["Prva opcija", "Druga opcija", "Treća opcija", "Četvrta opcija"],
      "correctAnswer": "Prva opcija",
      "explanation": "Kratko objašnjenje zašto je ovaj odgovor tačan",
      "points": 1
    },
    {
      "id": "q_${bIdx}_2",
      "type": "multiple_choice",
      "question": "Tekst drugog pitanja?",
      "options": ["Prva opcija", "Druga opcija", "Treća opcija", "Četvrta opcija"],
      "correctAnswer": "Treća opcija",
      "explanation": "Kratko objašnjenje",
      "points": 1
    },
    {
      "id": "q_${bIdx}_3",
      "type": "true_false",
      "question": "Tvrdnja koja je tačna ili netačna?",
      "options": ["Tačno", "Netačno"],
      "correctAnswer": "Tačno",
      "explanation": "Kratko objašnjenje",
      "points": 1
    }
  ]
}

IDs moraju biti jedinstveni — koristi format q_${bIdx}_1, q_${bIdx}_2, q_${bIdx}_3 itd.
OBAVEZNO generiši TAČNO ${num} pitanja.`;

    // ── Poziv Mistral AI ─────────────────────────────────────────────────────
    const response = await mistral.chat.complete({
      model:       'mistral-large-latest',
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.7,
      maxTokens:   8000
    });

    // ── Parsiraj odgovor ─────────────────────────────────────────────────────
    let content = response.choices[0].message.content.trim();
    content     = content.replace(/```json|```/g, '').trim();

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Nevažeći JSON odgovor od AI-a');

    const quiz = JSON.parse(jsonMatch[0]);

    if (!quiz.questions || quiz.questions.length < Math.floor(num * 0.8))
      throw new Error(`AI je generisao samo ${quiz.questions?.length || 0} od ${num} traženih pitanja. Pokušaj ponovo.`);

    // ── Server-side obrada ───────────────────────────────────────────────────

    // 1. Ukloni A) B) C) D) prefikse
    quiz.questions = cleanPrefixes(quiz.questions);

    // 2. Fisher-Yates shuffle opcija (čuva tačan odgovor)
    quiz.questions = quiz.questions.map(q => serverShuffleQuestion(q));

    // 3. Enforce distribucija – max 35% po poziciji
    quiz.questions = serverEnforceDistribution(quiz.questions);

    // ── Finalni metadata ─────────────────────────────────────────────────────
    quiz.totalPoints  = quiz.questions.reduce((s, q) => s + (q.points || 1), 0);
    quiz.numQuestions = quiz.questions.length;
    quiz.difficulty   = difficulty;
    quiz.subject      = subject;
    quiz.topic        = topic;

    res.json({ success: true, quiz });

  } catch (e) {
    console.error('❌ generate-quiz greška:', e);
    res.status(500).json({ error: e.message || 'Greška pri generisanju kviza' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// API: GRADE
// ════════════════════════════════════════════════════════════════════════════
app.post('/api/grade', async (req, res) => {
  try {
    const { questions, studentAnswers, studentName } = req.body;
    let totalPoints = 0, earnedPoints = 0;
    const gradedAnswers = [];

    for (const q of questions) {
      const given     = (studentAnswers[q.id] || '').trim();
      const correct   = (q.correctAnswer || '').trim();
      const isCorrect = given === correct;
      const pts       = q.points || 1;

      totalPoints += pts;
      if (isCorrect) earnedPoints += pts;

      gradedAnswers.push({
        questionId:    q.id,
        question:      q.question,
        studentAnswer: given || 'Bez odgovora',
        correctAnswer: correct,
        isCorrect,
        points:        isCorrect ? pts : 0,
        maxPoints:     pts,
        explanation:   q.explanation
      });
    }

    const pct = totalPoints > 0
      ? Math.round((earnedPoints / totalPoints) * 100)
      : 0;

    const gradeInfo = [
      { min: 84, grade: 5, label: 'Odličan'    },
      { min: 70, grade: 4, label: 'Vrlo dobar' },
      { min: 54, grade: 3, label: 'Dobar'      },
      { min: 37, grade: 2, label: 'Dovoljan'   },
      { min: 0,  grade: 1, label: 'Nedovoljan' }
    ].find(g => pct >= g.min);

    res.json({
      success: true,
      result: {
        studentName, totalPoints, earnedPoints,
        percentage: pct,
        grade:      gradeInfo.grade,
        gradeLabel: gradeInfo.label,
        gradedAnswers,
        gradedAt:   new Date().toISOString()
      }
    });

  } catch (e) {
    console.error('❌ grade greška:', e);
    res.status(500).json({ error: 'Greška pri ocjenjivanju' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// API: FEEDBACK
// ════════════════════════════════════════════════════════════════════════════
app.post('/api/feedback', async (req, res) => {
  try {
    const { result, quizTitle } = req.body;

    const wrongAnswers = result.gradedAnswers
      .filter(a => !a.isCorrect)
      .map(a => `- "${a.question}"`)
      .join('\n') || 'Nema grešaka!';

    const prompt = `Si nastavnik. Napiši 2-3 rečenice motivirajuće povratne informacije na bosanskom jeziku za učenika.
Kviz: ${quizTitle}
Rezultat: ${result.percentage}%, Ocjena: ${result.grade} (${result.gradeLabel})
Pogrešna pitanja:\n${wrongAnswers}
Budi direktan, konkretan i motivirajući.`;

    const response = await mistral.chat.complete({
      model:       'mistral-small-latest',
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.7,
      maxTokens:   200
    });

    res.json({ success: true, feedback: response.choices[0].message.content });

  } catch(e) {
    console.error('❌ feedback greška:', e);
    res.json({ success: true, feedback: '' });
  }
});

// ── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 KvizMajstor pokrenut na portu ${PORT}`));
