// ─── DEMO PODACI ─────────────────────────────────────────────────────────────
// Služi SAMO za pregled novog UI-a. Aktivira se isključivo kada je u URL-u
// ?demo=1, inače se nijedan red koda iz ovog fajla ne izvrši u aplikaciji.

// Svaki razred iz ALL_RAZREDI je zastupljen; zadnja dvosmijena je "bez razreda"
const RAZREDI = ['I-T5', 'II-S2', 'II-P', 'III-S1', 'III-T3', 'III-T5', 'III-T6', 'IV-T3', 'IV-T5', ''];
const IMENA = [
  'Amina Hodžić', 'Benjamin Karić', 'Cvjeta Mujić', 'Dino Softić', 'Ema Begić',
  'Faris Alispahić', 'Gorana Jurišić', 'Haris Zulić', 'Imra Delić', 'Jasmin Bećirević',
  'Kemal Duraković', 'Lamija Sarajlić', 'Merima Hadžić', 'Nedim Karahodžić', 'Olga Vidović',
  'Petar Kovačević', 'Ramiza Softić', 'Samir Halilović', 'Tarik Bajrić', 'Una Krdžu',
];

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pctToGrade = (p) =>
  p >= 84 ? 5 : p >= 70 ? 4 : p >= 54 ? 3 : p >= 37 ? 2 : 1;
const gradeLabel = (g) =>
  ({ 5: 'Odličan', 4: 'Vrlo dobar', 3: 'Dobar', 2: 'Dovoljan', 1: 'Nedovoljan' }[g] || '');

export function buildDemoData(seed = 42) {
  const rnd = mulberry32(seed);
  const quizzes = [
    { id: 'k1', title: 'Vektorne operacije', subject: 'Matematika', topic: 'Vektori', difficulty: 'srednje', timeLimit: 30, status: 'active', numQuestions: 12, totalPoints: 12, createdAt: '2026-09-01T08:00:00Z' },
    { id: 'k2', title: 'Os novoga doba', subject: 'Historija', topic: 'Renesansa', difficulty: 'lako', timeLimit: 20, status: 'active', numQuestions: 10, totalPoints: 10, createdAt: '2026-09-02T08:00:00Z' },
    { id: 'k3', title: 'Periodni sistem elemenata', subject: 'Hemija', topic: 'Elementi', difficulty: 'teško', timeLimit: 45, status: 'active', numQuestions: 15, totalPoints: 15, createdAt: '2026-09-03T08:00:00Z' },
    { id: 'k4', title: 'Osnove elektrotehnike', subject: 'Elektrotehnika', topic: 'Kola', difficulty: 'srednje', timeLimit: 35, status: 'inactive', numQuestions: 8, totalPoints: 8, createdAt: '2026-09-04T08:00:00Z' },
  ];

  const students = IMENA.map((name, i) => ({
    id: `u${i + 1}`,
    displayName: name,
    email: `${name.toLowerCase().replace(/č|ć/g, 'c').replace(/š/g, 's').replace(/ž/g, 'z').replace(/đ/g, 'd').split(' ')[0]}.${i}@skola.ba`,
    role: 'student',
    razred: RAZREDI[i % RAZREDI.length],
    smjer: i % 3 === 0 ? 'Računarski tehničar' : 'Elektrotehničar',
    createdAt: `2026-08-${String(10 + (i % 15)).padStart(2, '0')}T09:00:00Z`,
  }));

  const results = [];
  let n = 0;
  for (const s of students) {
    // dva odjeljenja namjerno zaostaju — da se vidi "bez kviza" sekcija
    const lagging = s.razred === 'III-T6' || s.razred === 'IV-T5' || !s.razred;
    const solveRate = lagging ? 0.12 : 0.78;
    for (const q of quizzes) {
      n++;
      if (rnd() > solveRate) continue;
      const total = q.totalPoints;
      const earned = Math.max(0, Math.min(total, Math.round(total * (0.25 + rnd() * 0.72))));
      const percentage = Math.round((earned / total) * 100);
      const grade = pctToGrade(percentage);
      results.push({
        id: `r${n}`,
        userId: s.id,
        quizId: q.id,
        quizTitle: q.title,
        quizSubject: q.subject,
        studentName: s.displayName,
        razred: s.razred,
        earnedPoints: earned,
        totalPoints: total,
        percentage,
        grade,
        gradeLabel: gradeLabel(grade),
        completedAt: `2026-09-0${1 + (n % 8)}T1${n % 9}:30:00Z`,
      });
    }
  }

  return { quizzes, results, students };
}
