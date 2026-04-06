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
      existingQuestions = ''
    } = req.body;

    const num     = parseInt(numQuestions);
    const bIdx    = parseInt(batchIndex);
    const tBatches = parseInt(totalBatches);

    const pdfData = await pdfParse(req.file.buffer);
    const text    = pdfData.text.slice(0, 15000);

    if (text.trim().length < 100)
      return res.status(400).json({ error: 'PDF ne sadrži dovoljno teksta' });

    const diffMap = {
      lako:    'jednostavna pitanja, osnovno razumijevanje',
      srednje: 'pitanja srednje težine, razumijevanje koncepta',
      teško:   'izazovna pitanja, dublje razmišljanje i analiza'
    };

    // ── Tip pitanja ──────────────────────────────────────────────────────────
    let parsedTypes = [];
    try { parsedTypes = JSON.parse(questionTypes); } catch { parsedTypes = [questionTypes]; }

    let typeInstruction = '';
    if (parsedTypes.includes('mixed')) {
      typeInstruction = 'Mješovito: 60% multiple_choice, 25% true_false, 15% multi_answer';
    } else {
      const parts = [];
      if (parsedTypes.includes('multiple_choice')) parts.push('multiple_choice (višestruki odabir, 4 opcije)');
      if (parsedTypes.includes('true_false'))      parts.push('true_false (tačno/netačno)');
      if (parsedTypes.includes('multi_answer'))    parts.push('multi_answer (više tačnih odgovora, 4 opcije)');
      typeInstruction = parts.join(' + ');
    }

    // ── Avoid note za batches ────────────────────────────────────────────────
    let avoidNote = '';
    if (bIdx > 0 && existingQuestions) {
      try {
        const existing = JSON.parse(existingQuestions);
        const titles   = existing.map((q, i) => `${i+1}. ${q.question}`).join('\n');
        avoidNote = `\n\nVAŽNO: Ovo je batch ${bIdx + 1} od ${tBatches}.
Sljedeća pitanja su VEĆ GENERISANA — nemoj ih ponavljati:
${titles}
Generiši POTPUNO DRUGAČIJA pitanja.\n`;
      } catch(e) {}
    }

    // ════════════════════════════════════════════════════════════════════════
    // ✅ PROMPT – eksplicitne instrukcije za raspored tačnih odgovora
    // ════════════════════════════════════════════════════════════════════════
    const prompt = `Si ekspert za obrazovanje. Generiši TAČNO ${num} pitanja za kviz.${avoidNote}

GRADIVO:
${text}

ZAHTJEVI:
- Predmet: ${subject || 'Nije specificiran'}
- Tema: ${topic || 'Iz gradiva'}
- Težina: ${diffMap[difficulty] || diffMap.srednje}
- Tip: ${typeInstruction}
- Jezik: Bosanski/Hrvatski/Srpski

════════════════════════════════════════════════
KRITIČNO – RASPORED TAČNIH ODGOVORA:
════════════════════════════════════════════════
Za multiple_choice i multi_answer pitanja:
- STROGO ZABRANJENO: staviti tačan odgovor uvijek na istu poziciju
- OBAVEZNO: tačni odgovori moraju biti ravnomjerno raspoređeni
- Od ${num} pitanja, otprilike:
  * ${Math.round(num * 0.25)} pitanja neka imaju tačan odgovor kao PRVU opciju u nizu
  * ${Math.round(num * 0.25)} pitanja neka imaju tačan odgovor kao DRUGU opciju u nizu
  * ${Math.round(num * 0.25)} pitanja neka imaju tačan odgovor kao TREĆU opciju u nizu
  * ${Math.round(num * 0.25)} pitanja neka imaju tačan odgovor kao ČETVRTU opciju u nizu
- NEMOJ dodavati slova (A, B, C, D) ispred opcija
- correctAnswer mora biti IDENTIČAN tekst kao u options nizu
- Provjeri NA KRAJU da li si poštovao raspored prije nego vratiš JSON
════════════════════════════════════════════════

FORMAT – vrati SAMO JSON bez ikakvog teksta:
{
  "title": "Naziv kviza",
  "description": "Kratki opis",
  "questions": [
    {
      "id": "q_${bIdx}_1",
      "type": "multiple_choice",
      "question": "Tekst pitanja?",
      "options": ["Opcija 1", "Opcija 2", "Opcija 3", "Opcija 4"],
      "correctAnswer": "Opcija 1",
      "explanation": "Kratko objašnjenje zašto je ovo tačno",
      "points": 1
    },
    {
      "id": "q_${bIdx}_2",
      "type": "true_false",
      "question": "Tvrdnja koja je tačna ili netačna?",
      "options": ["Tačno", "Netačno"],
      "correctAnswer": "Tačno",
      "explanation": "Objašnjenje",
      "points": 1
    },
    {
      "id": "q_${bIdx}_3",
      "type": "multi_answer",
      "question": "Pitanje sa više tačnih odgovora?",
      "options": ["Opcija 1", "Opcija 2", "Opcija 3", "Opcija 4"],
      "correctAnswers": ["Opcija 1", "Opcija 3"],
      "explanation": "Objašnjenje",
      "points": 2
    }
  ]
}

IDs: koristi format q_${bIdx}_1, q_${bIdx}_2 itd.
OBAVEZNO generiši TAČNO ${num} pitanja.`;

    const response = await mistral.chat.complete({
      model:       'mistral-large-latest',
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.7,   // ← povećano sa 0.4 – više randomnosti = bolji mix
      maxTokens:   8000
    });

    let content = response.choices[0].message.content.trim();
    content     = content.replace(/```json|```/g, '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Nevažeći JSON odgovor od AI-a');

    const quiz = JSON.parse(jsonMatch[0]);

    if (!quiz.questions || quiz.questions.length < Math.floor(num * 0.8))
      throw new Error(`AI je generisao samo ${quiz.questions?.length || 0} od ${num} pitanja.`);

    // ════════════════════════════════════════════════════════════════════════
    // ✅ SERVER-SIDE SHUFFLE – drugi sloj zaštite
    //    Čak i ako AI ne posluša prompt, mi sami miješamo opcije
    //    i garantujemo da nema preopterećenih pozicija
    // ════════════════════════════════════════════════════════════════════════
    quiz.questions = quiz.questions.map(q => serverShuffleQuestion(q));
    quiz.questions = serverEnforceDistribution(quiz.questions);

    // Ukloni eventualne prefikse A) B) C) D) koje AI doda unatoč zabrani
    quiz.questions = quiz.questions.map(q => {
      if (!q.options) return q;
      const cleaned = q.options.map(o => o.replace(/^[A-Da-d][\)\.\s]\s*/,'').trim());
      const oldCorrect  = q.correctAnswer;
      const oldCorrects = q.correctAnswers;

      // Mapiramo stari correctAnswer na novi (bez prefiksa)
      const newCorrect = oldCorrect
        ? cleaned[q.options.findIndex(o =>
            o.replace(/^[A-Da-d][\)\.\s]\s*/,'').trim() ===
            oldCorrect.replace(/^[A-Da-d][\)\.\s]\s*/,'').trim()
          )] ?? oldCorrect.replace(/^[A-Da-d][\)\.\s]\s*/,'').trim()
        : undefined;

      const newCorrects = Array.isArray(oldCorrects)
        ? oldCorrects.map(c =>
            cleaned[q.options.findIndex(o =>
              o.replace(/^[A-Da-d][\)\.\s]\s*/,'').trim() ===
              c.replace(/^[A-Da-d][\)\.\s]\s*/,'').trim()
            )] ?? c.replace(/^[A-Da-d][\)\.\s]\s*/,'').trim()
          )
        : undefined;

      return {
        ...q,
        options:        cleaned,
        correctAnswer:  newCorrect,
        correctAnswers: newCorrects,
      };
    });

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

// ════════════════════════════════════════════════════════════════════════════
// ✅ HELPER – Fisher-Yates shuffle
// ════════════════════════════════════════════════════════════════════════════
function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ════════════════════════════════════════════════════════════════════════════
// ✅ HELPER – Shuffle opcija jednog pitanja, čuva koji je tačan
// ════════════════════════════════════════════════════════════════════════════
function serverShuffleQuestion(q) {
  if (q.type === 'true_false' || !q.options) return q;

  if (q.type === 'multi_answer') {
    const correctSet = new Set(
      Array.isArray(q.correctAnswers) ? q.correctAnswers : [q.correctAnswer]
    );
    const combined = fisherYates(q.options.map(o => ({ text:o, correct:correctSet.has(o) })));
    return {
      ...q,
      options:        combined.map(c => c.text),
      correctAnswers: combined.filter(c => c.correct).map(c => c.text),
    };
  }

  // multiple_choice
  const correct  = q.correctAnswer;
  const shuffled = fisherYates(q.options);
  return { ...q, options: shuffled, correctAnswer: correct };
}

// ════════════════════════════════════════════════════════════════════════════
// ✅ HELPER – Enforce distribucija: max 35% tačnih na istoj poziciji
//
//  Algoritam:
//  1. Broji koliko puta je svaka pozicija tačna
//  2. Prolazi kroz pitanja sortirana po "najgore" poziciji
//  3. Swapuje tačan odgovor na poziciju koja ima najmanje tačnih
// ════════════════════════════════════════════════════════════════════════════
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
  const numOpts   = 4;
  const maxPerPos = Math.ceil(total * 0.35); // max 35% po poziciji

  // Broji pozicije
  const posCount = new Array(numOpts).fill(0);
  mcQuestions.forEach(({ q }) => {
    const pos = q.options.indexOf(q.correctAnswer);
    if (pos >= 0 && pos < numOpts) posCount[pos]++;
  });

  console.log('📊 Distribucija tačnih odgovora (prije enforce):', posCount);

  const result = [...questions];

  // Sortiraj po "najgore" – prvo popravlja najpreopterećenije
  const sorted = [...mcQuestions].sort((a, b) => {
    const posA = a.q.options.indexOf(a.q.correctAnswer);
    const posB = b.q.options.indexOf(b.q.correctAnswer);
    return (posCount[posB] || 0) - (posCount[posA] || 0);
  });

  sorted.forEach(({ q, i }) => {
    const currentPos = q.options.indexOf(q.correctAnswer);
    if (currentPos < 0 || posCount[currentPos] <= maxPerPos) return;

    // Nađi najmanje korištenu poziciju
    const targetPos = posCount
      .map((cnt, pos) => ({ cnt, pos }))
      .filter(({ pos }) => pos !== currentPos && pos < q.options.length)
      .sort((a, b) => a.cnt - b.cnt)[0]?.pos;

    if (targetPos === undefined) return;

    // Swap opcija
    const newOpts = [...q.options];
    [newOpts[currentPos], newOpts[targetPos]] = [newOpts[targetPos], newOpts[currentPos]];

    posCount[currentPos]--;
    posCount[targetPos]++;

    result[i] = { ...q, options: newOpts };
  });

  console.log('📊 Distribucija tačnih odgovora (poslije enforce):', posCount);

  return result;
}
