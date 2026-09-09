// ─── E2E: RAZREDNI PREGLED U PRAVOM DOMU ─────────────────────────────────────
// Uzima STVARNI inline modul iz public/pages/admin.html, transformiše njegove
// `import` deklaracije u parametre (jsdom ne izvršava type="module"), i pokreće
// ga nad stvarnim DOM stablom stranice. Time se testuje pravi render kod,
// a ne njegova kopija.
//
//   node tests/e2e/admin-class-report.test.mjs
//
// Zahtijeva jsdom:  npm i -D jsdom

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  buildClassReport, sortClassRows, buildInactiveByClass,
  classReportToCSV, fmtPct, fmtNum, UNASSIGNED_LABEL,
} from '../../public/js/class-report.js';
import { buildDemoData } from '../../public/js/demo-data.js';
import { fileURLToPath as _f } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO      = path.resolve(__dirname, '..', '..');
const ADMIN_HTML = path.join(REPO, 'public/pages/admin.html');

// ─── harness ─────────────────────────────────────────────────────────────────
let passed = 0, failed = 0; const fails = [];
function test(name, fn) {
  try { fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  catch (e) { console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message.split('\n').slice(0,4).join('\n      ')}`); failed++; fails.push(name); }
}
const ok = (v, m) => { if (!v) throw new Error(m || 'očekivano istina'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'nejednako'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

// ─── 1) čista logika na demo podacima ─────────────────────────────────────────
console.log('\n\x1b[1m1. Logika izvještaja na demo podacima\x1b[0m');
const demo = buildDemoData();
const { rows, summary } = buildClassReport(demo.students, demo.results);

test('demo skup sadrži više odjeljenja i dovoljno rezultata', () => {
  ok(rows.length >= 5, `očekivano ≥5 odjeljenja, dobijeno ${rows.length}`);
  ok(demo.results.length > 20, `očekivano >20 rezultata, dobijeno ${demo.results.length}`);
});
test('svaki učenik je uračunan točno jednom', () => {
  eq(rows.reduce((n, r) => n + r.studentCount, 0), demo.students.length);
});
test('odjeljenje bez razreda postoji', () => {
  ok(rows.some(r => r.razred === UNASSIGNED_LABEL), 'fali grupa bez razreda');
});
test('sve brojke su u validnom rasponu', () => {
  for (const r of rows) {
    if (r.avgPercentage !== null) ok(r.avgPercentage >= 0 && r.avgPercentage <= 100, `${r.razred} % van opsega`);
    if (r.avgGrade !== null) ok(r.avgGrade >= 1 && r.avgGrade <= 5, `${r.razred} ocjena van opsega`);
    ok(r.passRate >= 0 && r.passRate <= 100, `${r.razred} položenost van opsega`);
    eq(r.activeCount + r.inactiveCount, r.studentCount, `${r.razred} aktivni+neaktivni`);
    ok(!Number.isNaN(summary.participation), 'NaN u sažetku');
  }
});
test('CSV ima red za svako odjeljenje', () => {
  eq(classReportToCSV(rows).split('\n').length, rows.length + 1);
});
test('sortiranje je monotono', () => {
  const d = sortClassRows(rows, 'avg-desc');
  for (let i = 1; i < d.length; i++) {
    if (d[i].avgPercentage === null) continue;
    ok((d[i - 1].avgPercentage ?? 999) >= d[i].avgPercentage, 'pogrešan redoslijed');
  }
});

// ─── 2) stvarni render kroz pravi kod stranice ────────────────────────────────
console.log('\n\x1b[1m2. Render pravog koda iz admin.html (jsdom)\x1b[0m');

const html = fs.readFileSync(ADMIN_HTML, 'utf8');
const moduleSrc = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
ok(moduleSrc, 'nije pronađen inline modul u admin.html');

// Importi → parametri funkcije
const IMPORT_RE = /^import\s+(\{[\s\S]*?\}|\w+)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
const names = [];
const stripped = moduleSrc.replace(IMPORT_RE, (_m, clause) => {
  const inner = clause.trim().startsWith('{') ? clause.slice(1, -1) : clause;
  for (const raw of inner.split(',')) {
    const n = raw.trim();
    if (n) names.push(n.includes(' as ') ? n.split(/\s+as\s+/)[1].trim() : n);
  }
  return '';
});
// Ostali import oblici (npr. bez -t; ili više linija) — ne smiju ostati
ok(!/^\s*import\s/m.test(stripped), 'neki import nije transformisan:\n' + stripped.match(/^\s*import.*$/m)?.[0]);

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(e.message || String(e)));
vc.on('error', (...a) => errors.push(a.join(' ')));

const dom = new JSDOM(html, {
  url: 'http://localhost/admin?demo=1&cr=1',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;

const fbStub = {
  auth: { get uid() { return null; } },
  db: {},
  onAuthStateChanged: () => () => {},
  signOut: async () => {},
  collection: () => ({}), doc: () => ({}), getDoc: async () => ({ data: () => ({}) }),
  getDocs: async () => ({ docs: [] }),
  query: () => ({}), orderBy: () => ({}),
  updateDoc: async () => { throw new Error('onemogućeno u testu'); },
  deleteDoc: async () => { throw new Error('onemogućeno u testu'); },
};
// utils.js se izvodi U jsdom prozoru da bi live helperi (toast, btnLoad)
// radili nad stvarnim document objektom, a ne nad Node globalima
const utilsSrc = fs.readFileSync(path.join(REPO, 'public/js/utils.js'), 'utf8')
  .replace(/^export\s+/gm, '');
const UTIL_FNS = ['toast','gradeBadge','fmtDate','fmtDateTime','pctColor','btnLoad','btnReset','showLoading','hideLoading'];
const utils = {};
for (const fn of UTIL_FNS) {
  const m = utilsSrc.match(new RegExp(`function ${fn}\\s*\\([\\s\\S]*?\\n\\}`));
  if (m) utils[fn] = window.eval(`(${m[0]})`);
}

const imports = { ...utils, auth: fbStub.auth, db: fbStub.db, onAuthStateChanged: fbStub.onAuthStateChanged, signOut: fbStub.signOut, collection: fbStub.collection, doc: fbStub.doc, getDoc: fbStub.getDoc, getDocs: fbStub.getDocs, query: fbStub.query, orderBy: fbStub.orderBy, updateDoc: fbStub.updateDoc, deleteDoc: fbStub.deleteDoc, buildClassReport, sortClassRows, buildInactiveByClass, classReportToCSV, fmtPct, fmtNum, UNASSIGNED_LABEL, buildDemoData };

const missing = names.filter(n => !(n in imports));
ok(missing.length === 0, 'nedostaju stubovi za: ' + missing.join(', '));

window.eval(`window.__moduleErrors = [];`);
const args = names.map(n => imports[n]);

const runner = window.eval(`(async (${names.join(', ')}) => {
  try {
${stripped}
  } catch (e) { window.__moduleErrors.push(String(e && e.stack || e)); }
})`);

// ES modul najprije EXECUTIRA cijelo tijelo pa tek onda poziva funkcije —
// harness mora oponašati to: pokrećemo IIFE bez čekanja i pustimo event loop.
let bootError = null;
try {
  const p = runner(...args);
  p?.catch?.(e => { bootError = e; });
} catch (e) { bootError = e; }
const settled = async (cond, tries = 80) => {
  for (let i = 0; i < tries; i++) { if (cond()) return true; await new Promise(r => setTimeout(r, 25)); }
  return false;
};
await settled(() => window.document.querySelector('#cr-wrap table'));
// modul ima još koda nakon prvog awaita (prebacivanje kartice) — pustiti ga do kraja
await settled(() => window.document.getElementById('page-classreport').classList.contains('active')
                && typeof window.renderClassReport === 'function');

test('inline modul se izvršava bez izuzetaka', () => {
  ok(!bootError, 'boot: ' + (bootError?.stack || bootError?.message || bootError));
  eq(window.__moduleErrors.length, 0, 'modul greške: ' + window.__moduleErrors[0]?.split('\n').slice(0, 4).join(' | '));
});

const doc = window.document;
test('sve interaktivne funkcije su izložene na window (inline handleri)', () => {
  for (const fn of ['renderClassReport','exportClassReportCSV','filterStudents','filterResults','filterQuizzes','switchPage','openStudentDetail','openEditStudent']) {
    ok(typeof window[fn] === 'function', `window.${fn} nedostaje — HTML ga zove iz inline handler-a`);
  }
});

const resetControls = () => {
  doc.getElementById('cr-search').value = '';
  doc.getElementById('cr-sort').value = 'razred';
  doc.getElementById('cr-threshold').value = '54';
  doc.getElementById('cr-only-active').checked = false;
  window.renderClassReport();
};


test('kartica "Razredi" je aktivna (?cr=1)', () => {
  ok(doc.getElementById('page-classreport').classList.contains('active'), 'page-classreport nije aktivan');
});
test('tablica je renderirana s tačno onoliko redova koliko ima odjeljenja', () => {
  const trs = doc.querySelectorAll('#cr-wrap tbody tr');
  eq(trs.length, rows.length, 'broj redova');
  eq(doc.querySelectorAll('#cr-wrap thead th').length, 8, 'broj kolona');
});
test('svaki red sadrži naziv razreda i broj učenika', () => {
  const trs = [...doc.querySelectorAll('#cr-wrap tbody tr')];
  for (const r of rows) {
    const tr = trs.find(t => t.textContent.includes(r.razred));
    ok(tr, `nedostaje red za ${r.razred}`);
    ok(tr.textContent.includes(String(r.studentCount)), `${r.razred}: fali broj učenika`);
  }
});
test('sažetak ima 5 kartica s nepraznim vrijednostima', () => {
  const cards = doc.querySelectorAll('#cr-summary .cr-card');
  eq(cards.length, 5, 'broj kartica');
  ok([...cards].every(c => c.querySelector('.cr-card-v').textContent.trim().length > 0), 'prazna kartica');
  ok([...cards].some(c => /%$/.test(c.querySelector('.cr-card-v').textContent.trim())), 'nijedna kartica nema procenat');
});
test('traka raspodjele ocjena se generiše', () => {
  ok(doc.querySelectorAll('#cr-wrap .cr-stack').length > 0, 'nema .cr-stack');
  ok(doc.querySelectorAll('#cr-wrap .cr-seg').length > 0, 'nema segmenata');
});
test('sekcija neaktivnih ima tačno onoliko čipova koliko ih logika vraća', () => {
  const groups = buildInactiveByClass(rows);
  ok(groups.length > 0, 'očekujemo bar jedno odjeljenje s neaktivnima');
  const expect = groups.reduce((s, g) => s + g.names.length, 0);
  eq(doc.querySelectorAll('#cr-inactive-list .cr-chip').length, expect, 'broj čipova');
});
test('XSS: zlonamjerni naziv razreda se eskapira', () => {
  const students = window.__demo.students;
  const before = students.length;
  window.__pwned = false;
  students.push({
    id: 'evil', displayName: '<script>window.__pwned=2<\/script>', email: 'x@y.z',
    role: 'student', razred: '<img src=x onerror="window.__pwned=1">', smjer: '',
  });
  try {
    window.renderClassReport();
    const wrap = doc.getElementById('cr-wrap');
    eq(wrap.querySelectorAll('img').length, 0, 'sirovi <img> je ubačen u DOM');
    ok(wrap.textContent.includes('<img src=x'), 'naziv je izgubljen umjesto eskapiran');
    ok(!window.__pwned, 'onerror je izvršen');
    ok(doc.querySelectorAll('#cr-wrap tbody tr').length === rows.length + 1, 'red nije dodat');
  } finally {
    students.length = before;
    resetControls();
  }
});
test('pretraga suzi i vraća listu', () => {
  const all = doc.querySelectorAll('#cr-wrap tbody tr').length;
  ok(all >= 4, `očekujemo bar 4 odjeljenja u demu, dobijeno ${all}`);
  doc.getElementById('cr-search').value = 'II-P';
  window.renderClassReport();
  const some = doc.querySelectorAll('#cr-wrap tbody tr').length;
  ok(some >= 1 && some < all, `filtrirano ${some} od ${all}`);
  eq(doc.getElementById('cr-count').textContent, `${some} ${some === 1 ? 'odjeljenje' : 'odjeljenja'}`, 'brojač ne prati prikaz');
  doc.getElementById('cr-search').value = 'zzzz-nema-nic';
  window.renderClassReport();
  eq(doc.querySelectorAll('#cr-wrap tbody tr').length, 0, 'nepostojeći filter mora isprazniti');
  ok(doc.getElementById('cr-wrap').textContent.includes('Nema odjeljenja'), 'fali empty state');
  resetControls();
  eq(doc.querySelectorAll('#cr-wrap tbody tr').length, rows.length, 'lista se nije vratila na punu');
});
test('ček "samo odjeljenja s rezultatima" radi', () => {
  const before = doc.querySelectorAll('#cr-wrap tbody tr').length;
  const expect = rows.filter(r => r.resultCount > 0).length;
  ok(expect > 0 && expect < rows.length, `demo mora imati i praznih i punih odjeljenja (dobijeno ${expect}/${rows.length})`);
  doc.getElementById('cr-only-active').checked = true;
  window.renderClassReport();
  eq(doc.querySelectorAll('#cr-wrap tbody tr').length, expect, 'broj nakon filtra');
  ok(doc.querySelectorAll('#cr-wrap tbody tr').length <= before, 'ček ne smije povećati listu');
  resetControls();
  eq(doc.querySelectorAll('#cr-wrap tbody tr').length, before, 'stanje se ne vraća');
});
test('promjena praga mijenja izračun položenih', () => {
  doc.getElementById('cr-threshold').value = '84';
  window.renderClassReport();
  ok(doc.getElementById('cr-wrap').textContent.includes('prag 84%'), 'prag se ne vidi');
  const strictRows = buildClassReport(demo.students, demo.results, { passThreshold: 84 }).rows;
  const strictTotal = strictRows.reduce((s, r) => s + r.passedCount, 0);
  const looseTotal = rows.reduce((s, r) => s + r.passedCount, 0);
  ok(strictTotal < looseTotal, 'prag 84% ne smije dati više položenih');
  resetControls();
});
test('sortiranje u UI-u je isto kao u logici', () => {
  doc.getElementById('cr-sort').value = 'students-desc';
  window.renderClassReport();
  const shown = [...doc.querySelectorAll('#cr-wrap tbody tr')].map(t => parseInt(t.children[1].textContent, 10));
  eq(shown[0], Math.max(...shown), 'najveće odjeljenje nije prvo');
  resetControls();
});
test('badge u sidebaru broji odjeljenja', () => {
  eq(doc.getElementById('sb-class-count').textContent, String(rows.length));
});
test('izvoz CSV generiše datoteku i ne baca grešku', () => {
  let created = null, revoked = false;
  window.URL.createObjectURL = (b) => { created = b; return 'blob:test'; };
  window.URL.revokeObjectURL = () => { revoked = true; };
  let clicked = false;
  const origCreate = window.document.createElement.bind(window.document);
  window.document.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === 'a') el.click = () => { clicked = true; };
    return el;
  };
  window.exportClassReportCSV();
  window.document.createElement = origCreate;
  ok(created, 'Blob nije kreiran');
  ok(clicked, 'download nije pokrenut');
  ok(revoked, 'URLObject nije pušten');
  eq(created.type, 'text/csv;charset=utf-8');
});
test('ostali tabovi i dalje rade (regresija)', () => {
  ok(doc.querySelectorAll('#students-wrap tbody tr').length > 0, 'tablica učenika je prazna');
  ok(doc.querySelectorAll('#results-wrap tbody tr').length > 0, 'tablica rezultata je prazna');
  eq(doc.getElementById('s-students').textContent, String(demo.students.length), 'stat kartica učenika');
  eq(doc.getElementById('s-results').textContent, String(demo.results.length), 'stat kartica rezultata');
});
test('konzola nema novih grešaka', () => {
  const real = errors.filter(e => !/Could not load|not implemented|Could not parse CSS/i.test(e));
  ok(real.length === 0, real.slice(0, 2).join(' | '));
});

window.close();
console.log(`\n  ${passed} prošlo, ${failed} palo${failed ? ' → ' + fails.join(', ') : ''}\n`);
process.exit(failed ? 1 : 0);
