// ─── RAZREDNI PREGLED ────────────────────────────────────────────────────────
// Čista logika za izvještaj po odjeljenjima (razredima).
// Nema DOM-a ni Firebase-a — namjerno, da se može testirati bez servera.

export const UNASSIGNED_LABEL = 'Nije dodijeljen';
export const PASS_THRESHOLD   = 54; // % — "Dovoljan" i više

// ─── Normalizacija naziva razreda ─────────────────────────────────────────────
export function normalizeRazred(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

// ─── Grupisanje rezultata po učeniku (userId → [results]) ────────────────────
export function groupResultsByStudent(results = []) {
  const map = new Map();
  for (const r of results) {
    const uid = r?.userId;
    if (!uid) continue;
    if (!map.has(uid)) map.set(uid, []);
    map.get(uid).push(r);
  }
  return map;
}

// ─── Prosjek niza brojeva (vrati null ako je prazno) ─────────────────────────
function avg(nums) {
  const clean = nums.filter(n => Number.isFinite(n));
  if (!clean.length) return null;
  return clean.reduce((s, n) => s + n, 0) / clean.length;
}

// ─── Distribucija ocjena 1..5 ─────────────────────────────────────────────────
export function gradeDistribution(grades = []) {
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const g of grades) {
    const gi = Math.round(Number(g));
    if (gi >= 1 && gi <= 5) dist[gi]++;
  }
  return dist;
}

// ─── Izvještaj po razredu ─────────────────────────────────────────────────────
// students: [{ id, displayName, razred, smjer, role }]
// results:  [{ userId, percentage, grade, completedAt }]
export function buildClassReport(students = [], results = [], opts = {}) {
  const passThreshold = Number.isFinite(opts.passThreshold)
    ? opts.passThreshold
    : PASS_THRESHOLD;

  const roster = students
    .filter(s => s && (s.role === undefined || s.role === 'student'))
    .map(s => ({ ...s, razred: normalizeRazred(s.razred) }));

  const byStudent = groupResultsByStudent(results);

  const groups = new Map();
  for (const s of roster) {
    const key = s.razred || UNASSIGNED_LABEL;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const rows = [...groups.entries()].map(([razred, members]) => {
    const resultCount   = members.length ? members.reduce((n, s) => n + (byStudent.get(s.id)?.length || 0), 0) : 0;
    const allResults    = members.flatMap(s => byStudent.get(s.id) || []);
    const percentages   = allResults.map(r => Number(r.percentage)).filter(Number.isFinite);
    const grades        = allResults.map(r => Number(r.grade)).filter(Number.isFinite);
    const activeStudents = members.filter(s => (byStudent.get(s.id)?.length || 0) > 0);
    const dist          = gradeDistribution(grades);
    const total         = members.length;

    // Udio učenika koji su barem jednom riješili kviz
    const participation = total > 0 ? (activeStudents.length / total) * 100 : 0;

    // "Položilo" = barem jedan rezultat iznad praga
    const passedStudents = activeStudents.filter(s =>
      (byStudent.get(s.id) || []).some(r => Number(r.percentage) >= passThreshold)
    );
    const passRate = total > 0 ? (passedStudents.length / total) * 100 : 0;

    // Najbolji učenik odjeljenja po prosjeku procenta
    const perStudent = members.map(s => {
      const sr = byStudent.get(s.id) || [];
      return {
        id:            s.id,
        displayName:   s.displayName || '—',
        avgPercentage: avg(sr.map(r => Number(r.percentage))),
        solved:        sr.length,
      };
    }).filter(s => Number.isFinite(s.avgPercentage));

    const topStudent = perStudent.length
      ? perStudent.sort((a, b) => b.avgPercentage - a.avgPercentage)[0]
      : null;

    // Učenici bez ijednog riješenog kviza — na nastavniku je da ih potakne
    const inactive = members
      .filter(s => !(byStudent.get(s.id)?.length > 0))
      .map(s => s.displayName || '—')
      .sort((a, b) => a.localeCompare(b, 'bs'));

    return {
      razred,
      studentCount:    total,
      activeCount:     activeStudents.length,
      inactiveCount:   inactive.length,
      inactiveStudents: inactive,
      resultCount,
      avgPercentage:   avg(percentages),
      avgGrade:        avg(grades),
      participation,
      passThreshold,
      passRate,
      passedCount:     passedStudents.length,
      gradeDist:       dist,
      topStudent,
      students:        members.map(s => s.displayName || '—'),
    };
  });

  const summary = summarizeRows(rows);

  return { rows, summary };
}

// ─── Zagrebački zbroj svih odjeljenja ─────────────────────────────────────────
export function summarizeRows(rows = []) {
  const totals = rows.reduce((acc, r) => {
    acc.classes        += 1;
    acc.studentCount   += r.studentCount;
    acc.activeCount    += r.activeCount;
    acc.inactiveCount  += r.inactiveCount;
    acc.resultCount    += r.resultCount;
    acc.passedCount    += r.passedCount;
    return acc;
  }, { classes: 0, studentCount: 0, activeCount: 0, inactiveCount: 0, resultCount: 0, passedCount: 0 });

  const allPercentages = [];
  const allGrades      = [];
  for (const r of rows) {
    if (Number.isFinite(r.avgPercentage)) allPercentages.push({ v: r.avgPercentage, n: r.resultCount || 1 });
    if (Number.isFinite(r.avgGrade))      allGrades.push({ v: r.avgGrade, n: r.resultCount || 1 });
  }
  const weighted = (arr) => {
    const n = arr.reduce((s, x) => s + x.n, 0);
    return n > 0 ? arr.reduce((s, x) => s + x.v * x.n, 0) / n : null;
  };

  return {
    ...totals,
    avgPercentage: weighted(allPercentages),
    avgGrade:      weighted(allGrades),
    participation: totals.studentCount > 0 ? (totals.activeCount / totals.studentCount) * 100 : 0,
    passRate:      totals.studentCount > 0 ? (totals.passedCount / totals.studentCount) * 100 : 0,
  };
}

// ─── Sortiranje i filtriranje redova ─────────────────────────────────────────
const SORTERS = {
  'razred':       (a, b) => a.razred.localeCompare(b.razred, 'bs'),
  'students-desc':(a, b) => b.studentCount - a.studentCount,
  'avg-desc':     (a, b) => (b.avgPercentage ?? -1) - (a.avgPercentage ?? -1),
  'avg-asc':      (a, b) => (a.avgPercentage ?? 999) - (b.avgPercentage ?? 999),
  'pass-desc':    (a, b) => b.passRate - a.passRate,
  'pass-asc':     (a, b) => a.passRate - b.passRate,
  'activity-desc':(a, b) => b.resultCount - a.resultCount,
};

export function sortClassRows(rows = [], sortKey = 'razred') {
  const fn = SORTERS[sortKey] || SORTERS['razred'];
  return [...rows].sort(fn);
}

// ─── Učenici bez riješenog kviza, grupisani po razredu ────────────────────────
export function buildInactiveByClass(rows = []) {
  return rows
    .filter(r => r.inactiveCount > 0)
    .map(r => ({ razred: r.razred, names: r.inactiveStudents }))
    .sort((a, b) => b.names.length - a.names.length);
}

// ─── Formatiranje ─────────────────────────────────────────────────────────────
export function fmtPct(v) {
  return Number.isFinite(v) ? `${Math.round(v)}%` : '—';
}
export function fmtNum(v, digits = 1) {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

// ─── CSV ─────────────────────────────────────────────────────────────────────
export function classReportToCSV(rows = []) {
  const header = [
    'Razred', 'Učenika', 'Aktivnih', 'Neaktivnih', 'Riješenih kvizova',
    'Prosječan %', 'Prosječna ocjena', 'Udio učenika koji su riješili %', 'Položilo %',
    'Ocjena 5', 'Ocjena 4', 'Ocjena 3', 'Ocjena 2', 'Ocjena 1',
  ];
  const lines = rows.map(r => [
    r.razred,
    r.studentCount,
    r.activeCount,
    r.inactiveCount,
    r.resultCount,
    Number.isFinite(r.avgPercentage) ? Math.round(r.avgPercentage) : '',
    Number.isFinite(r.avgGrade) ? r.avgGrade.toFixed(2) : '',
    Math.round(r.participation),
    Math.round(r.passRate),
    r.gradeDist[5], r.gradeDist[4], r.gradeDist[3], r.gradeDist[2], r.gradeDist[1],
  ]);
  return [header, ...lines]
    .map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}
