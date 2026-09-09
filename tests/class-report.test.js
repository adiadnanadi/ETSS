// Testovi za public/js/class-report.js
// Pokreće se s: node tests/class-report.test.js   (bez ijedne zavisnosti)
import assert from 'node:assert/strict';
import {
  buildClassReport,
  gradeDistribution,
  normalizeRazred,
  sortClassRows,
  summarizeRows,
  buildInactiveByClass,
  classReportToCSV,
  fmtPct,
  fmtNum,
  UNASSIGNED_LABEL,
} from '../public/js/class-report.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  catch (e) { console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`); failed++; }
}

// ── Fiksni podaci ─────────────────────────────────────────────────────────────
const students = [
  { id: 'u1', displayName: 'Amina Hodžić',  razred: 'I-T5', role: 'student' },
  { id: 'u2', displayName: 'Benjamin Karić', razred: 'I-T5', role: 'student' },
  { id: 'u3', displayName: 'Cvjeta Mujić',   razred: 'I-T5', role: 'student' },
  { id: 'u4', displayName: 'Dino Softić',    razred: 'II-S2', role: 'student' },
  { id: 'u5', displayName: 'Ema Begić',      razred: 'II-S2', role: 'student' },
  { id: 'u6', displayName: 'Adminenko',      razred: 'I-T5', role: 'admin' }, // mora biti ignorisan
  { id: 'u7', displayName: 'Faris Bezrazred', razred: '',   role: 'student' },
];

const results = [
  { userId: 'u1', percentage: 92, grade: 5, completedAt: '2026-09-01T10:00:00Z' },
  { userId: 'u1', percentage: 78, grade: 4, completedAt: '2026-09-02T10:00:00Z' },
  { userId: 'u2', percentage: 40, grade: 1, completedAt: '2026-09-01T11:00:00Z' },
  // u3 — nijedan kviz
  { userId: 'u4', percentage: 55, grade: 2, completedAt: '2026-09-03T09:00:00Z' },
  { userId: 'u4', percentage: 61, grade: 3, completedAt: '2026-09-04T09:00:00Z' },
  // u5 — nijedan kviz
  { userId: 'u6', percentage: 100, grade: 5, completedAt: '2026-09-01T09:00:00Z' }, // admin, ignoriši
];

console.log('\n\x1b[1mclass-report.js\x1b[0m');

// ── normalizeRazred ───────────────────────────────────────────────────────────
test('normalizuje razmak i prazne vrijednosti', () => {
  assert.equal(normalizeRazred('  I - T5  '), 'I - T5');
  assert.equal(normalizeRazred(null), '');
  assert.equal(normalizeRazred(undefined), '');
  assert.equal(normalizeRazred(0), '0');
});

// ── gradeDistribution ─────────────────────────────────────────────────────────
test('distribucija odbacuje nevažeće ocjene', () => {
  const d = gradeDistribution([5, 5, 3.2, 1, 0, 9, null, 'x']);
  assert.deepEqual(d, { 1: 1, 2: 0, 3: 1, 4: 0, 5: 2 });
  assert.equal(d[3], 1, '3.2 se zaokružuje na 3, ne na 4');
});

// ── buildClassReport ──────────────────────────────────────────────────────────
const { rows, summary } = buildClassReport(students, results);
const r1 = rows.find(r => r.razred === 'I-T5');
const r2 = rows.find(r => r.razred === 'II-S2');

test('grupiše po razredu i izbacuje admina', () => {
  assert.equal(rows.length, 3, 'I-T5, II-S2 i "Nije dodijeljen"');
  assert.equal(r1.studentCount, 3, 'admin ne smije ući u brojku');
  assert.equal(r1.resultCount, 3, 'samo rezultati učenika, bez adminovih');
});

test('prosjek procenta se računa po rezultatima, ne po učenicima', () => {
  // I-T5: 92, 78, 40 → 70
  assert.equal(Math.round(r1.avgPercentage), 70);
  // II-S2: 55, 61 → 58
  assert.equal(Math.round(r2.avgPercentage), 58);
});

test('aktivni i neaktivni učenici', () => {
  assert.equal(r1.activeCount, 2);
  assert.equal(r1.inactiveCount, 1);
  assert.deepEqual(r1.inactiveStudents, ['Cvjeta Mujić']);
  assert.deepEqual(r2.inactiveStudents, ['Ema Begić']);
});

test('prag polaganja koristi 54%', () => {
  // I-T5: Amina (92,78) polaže, Benjamin (40) ne → 1/3
  assert.equal(r1.passedCount, 1);
  assert.equal(Math.round(r1.passRate), 33);
  // II-S2: Dino (55,61) polaže, Ema nikad → 1/2
  assert.equal(r2.passedCount, 1);
  assert.equal(Math.round(r2.passRate), 50);
});

test('prag polaganja se može promijeniti', () => {
  const stricter = buildClassReport(students, results, { passThreshold: 80 });
  const s1 = stricter.rows.find(r => r.razred === 'I-T5');
  assert.equal(s1.passedCount, 1); // Amina 92 ≥ 80, Benjamin 40 < 80
  const s2 = stricter.rows.find(r => r.razred === 'II-S2');
  assert.equal(s2.passedCount, 0); // Dino max 61 < 80
});

test('najbolji učenik odjeljenja', () => {
  assert.equal(r1.topStudent.displayName, 'Amina Hodžić');
  assert.equal(Math.round(r1.topStudent.avgPercentage), 85);
});

test('razredni raspored ocjena', () => {
  assert.deepEqual(r1.gradeDist, { 1: 1, 2: 0, 3: 0, 4: 1, 5: 1 });
});

test('učenici bez razreda idu u posebnu grupu', () => {
  const rn = rows.find(r => r.razred === UNASSIGNED_LABEL);
  assert.ok(rn, 'mora postojati grupa "Nije dodijeljen"');
  assert.equal(rn.studentCount, 1);
  assert.equal(rn.resultCount, 0);
  assert.equal(rn.avgPercentage, null, 'bez rezultata → null, ne 0');
  assert.equal(fmtPct(rn.avgPercentage), '—');
});

test('prazan skup podataka ne ruši funkciju', () => {
  const empty = buildClassReport([], []);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.summary.classes, 0);
  assert.equal(empty.summary.avgPercentage, null);
  assert.equal(empty.summary.participation, 0);
  assert.equal(buildClassReport().rows.length, 0);
});

// ── summarizeRows ─────────────────────────────────────────────────────────────
test('sažetak je ponderisan brojem rezultata', () => {
  assert.equal(summary.classes, 3);
  assert.equal(summary.studentCount, 6, '5 sa razredom + 1 bez razreda, admin isključen');
  assert.equal(summary.resultCount, 5);
  assert.equal(summary.activeCount, 3);
  // ponderisano: (70*3 + 58*2) / 5 = 65.2
  assert.equal(Math.round(summary.avgPercentage), 65);
  assert.equal(fmtNum(summary.avgGrade, 2), '3.00');
});

// ── sortClassRows ─────────────────────────────────────────────────────────────
test('sortira po zadatom ključu i ne mijenja ulaz', () => {
  const src = [...rows];

  const asc = sortClassRows(rows, 'avg-asc');
  assert.ok(Number.isFinite(asc[0].avgPercentage), 'najlošiji ide prvi');
  assert.equal(asc[asc.length - 1].avgPercentage, null, 'razred bez podataka ide zadnji');

  const desc = sortClassRows(rows, 'avg-desc');
  assert.equal(desc[0].avgPercentage, Math.max(...rows.map(r => r.avgPercentage ?? -Infinity)));

  const byStudents = sortClassRows(rows, 'students-desc');
  assert.equal(byStudents[0].studentCount, Math.max(...rows.map(r => r.studentCount)));

  assert.deepEqual(rows.map(r => r.razred), src.map(r => r.razred), 'ulaz mora biti nepromijenjen');
  assert.deepEqual(sortClassRows(rows, 'nepostojece').map(r => r.razred), sortClassRows(rows, 'razred').map(r => r.razred));
});

// ── buildInactiveByClass ──────────────────────────────────────────────────────
test('neaktivni grupisani i sortirani po veličini', () => {
  const inact = buildInactiveByClass(rows);
  assert.equal(inact.length, 3);
  assert.ok(inact.every(g => g.names.length > 0));
});

// ── classReportToCSV ──────────────────────────────────────────────────────────
test('CSV ima zaglavlje + jedan red po razredu', () => {
  const csv = classReportToCSV(rows);
  const lines = csv.split('\n');
  assert.equal(lines.length, rows.length + 1);
  assert.ok(lines[0].startsWith('"Razred","Učenika"'));
  assert.equal(lines[1].split(',').length, 14);
  assert.ok(lines[1].includes('"I-T5"'));
});

test('CSV citira navodnike u nazivu razreda', () => {
  const csv = classReportToCSV([{
    razred: 'X"Y', studentCount: 0, activeCount: 0, inactiveCount: 0, resultCount: 0,
    avgPercentage: null, avgGrade: null, participation: 0, passRate: 0, passedCount: 0,
    gradeDist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, students: [], inactiveStudents: [],
  }]);
  assert.ok(csv.includes('"X""Y"'));
});

// ── Rezultat ──────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} prošlo, ${failed} palo\n`);
if (failed > 0) process.exit(1);
