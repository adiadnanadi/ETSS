import express from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { Mistral } from '@mistralai/mistralai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── PAGE ROUTES ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'login.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'admin.html')));
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'student.html')));
app.get('/create-quiz', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'create-quiz.html')));
app.get('/take-quiz', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'take-quiz.html')));
app.get('/result', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'result.html')));

// ─── API: HEALTH ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ─── API: GENERATE QUIZ ──────────────────────────────────────────────────────
app.post('/api/generate-quiz', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'PDF fajl je obavezan' });

    const { numQuestions = 10, difficulty = 'srednje', questionTypes = 'multiple_choice', subject = '', topic = '' } = req.body;

    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text.slice(0, 12000);

    if (text.trim().length < 100)
      return res.status(400).json({ error: 'PDF ne sadrži dovoljno teksta' });

    const diffMap = { lako: 'jednostavna pitanja, osnovno razumijevanje', srednje: 'pitanja srednje težine, razumijevanje koncepta', teško: 'izazovna pitanja, dublje razmišljanje i analiza' };
    const typeMap = { multiple_choice: 'ISKLJUČIVO višestruki odabir (4 opcije, 1 tačan odgovor)', true_false: 'ISKLJUČIVO tačno/netačno pitanja', mixed: 'mješovito: 70% višestruki odabir, 30% tačno/netačno' };

    const prompt = `Si ekspert za obrazovanje. Generiši ${numQuestions} pitanja za kviz na osnovu gradiva.

GRADIVO:
${text}

ZAHTJEVI:
- Predmet: ${subject || 'Nije specificiran'}
- Tema: ${topic || 'Iz gradiva'}
- Težina: ${diffMap[difficulty] || diffMap.srednje}
- Tip: ${typeMap[questionTypes] || typeMap.multiple_choice}
- Jezik: Bosanski/Hrvatski/Srpski

Vrati SAMO JSON, bez markdown backtick-ova, bez objašnjenja:
{
  "title": "Naziv kviza",
  "description": "Kratki opis",
  "questions": [
    {
      "id": "q1",
      "type": "multiple_choice",
      "question": "Tekst pitanja?",
      "options": ["A) Opcija 1", "B) Opcija 2", "C) Opcija 3", "D) Opcija 4"],
      "correctAnswer": "A) Opcija 1",
      "explanation": "Kratko objašnjenje",
      "points": 1
    }
  ]
}
Za tačno/netačno type="true_false", options=["Tačno","Netačno"].`;

    const response = await mistral.chat.complete({
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      maxTokens: 4000
    });

    let content = response.choices[0].message.content.trim();
    content = content.replace(/```json|```/g, '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Nevažeći JSON odgovor');

    const quiz = JSON.parse(jsonMatch[0]);
    quiz.totalPoints = quiz.questions.reduce((s, q) => s + (q.points || 1), 0);
    quiz.numQuestions = quiz.questions.length;
    quiz.difficulty = difficulty;
    quiz.subject = subject;
    quiz.topic = topic;

    res.json({ success: true, quiz });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Greška pri generisanju' });
  }
});

// ─── API: GRADE ──────────────────────────────────────────────────────────────
app.post('/api/grade', async (req, res) => {
  try {
    const { questions, studentAnswers, studentName } = req.body;
    let totalPoints = 0, earnedPoints = 0;
    const gradedAnswers = [];

    for (const q of questions) {
      const given = (studentAnswers[q.id] || '').trim();
      const correct = (q.correctAnswer || '').trim();
      const isCorrect = given === correct;
      const pts = q.points || 1;
      totalPoints += pts;
      if (isCorrect) earnedPoints += pts;
      gradedAnswers.push({ questionId: q.id, question: q.question, studentAnswer: given || 'Bez odgovora', correctAnswer: correct, isCorrect, points: isCorrect ? pts : 0, maxPoints: pts, explanation: q.explanation });
    }

    const pct = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;
    const gradeInfo = [{ min: 90, grade: 5, label: 'Odličan' }, { min: 75, grade: 4, label: 'Vrlo dobar' }, { min: 60, grade: 3, label: 'Dobar' }, { min: 50, grade: 2, label: 'Dovoljan' }, { min: 0, grade: 1, label: 'Nedovoljan' }].find(g => pct >= g.min);

    res.json({ success: true, result: { studentName, totalPoints, earnedPoints, percentage: pct, grade: gradeInfo.grade, gradeLabel: gradeInfo.label, gradedAnswers, gradedAt: new Date().toISOString() } });
  } catch (e) {
    res.status(500).json({ error: 'Greška pri ocjenjivanju' });
  }
});

// ─── API: FEEDBACK ───────────────────────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  try {
    const { result, quizTitle } = req.body;
    const wrongAnswers = result.gradedAnswers.filter(a => !a.isCorrect).map(a => `- "${a.question}"`).join('\n') || 'Nema grešaka!';
    const prompt = `Si nastavnik. Napiši 2-3 rečenice motivirajuće povratne informacije na bosanskom za učenika.
Kviz: ${quizTitle}
Rezultat: ${result.percentage}%, Ocjena: ${result.grade} (${result.gradeLabel})
Greške:\n${wrongAnswers}
Budi direktan i motivirajući.`;

    const response = await mistral.chat.complete({ model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }], temperature: 0.7, maxTokens: 200 });
    res.json({ success: true, feedback: response.choices[0].message.content });
  } catch {
    res.json({ success: true, feedback: '' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 KvizMajstor pokrenut na portu ${PORT}`));
