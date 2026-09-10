// Regresija za admin panel: `loadMaterials()` se poziva na 4 mjesta u
// public/pages/admin.html (loadAll + poslije dodaj/uredi/sakrij/obriši), a
// funkcija nije bila definisana → ReferenceError, tab Literatura zauvijek
// prazan i crveni toast "loadMaterials is not defined" pri svakoj prijavi.
//
// Test radi dvije stvari:
//   1. Izvršava STVARNI izvor funkcije iz admin.html (bez kopije logike) uz
//      stub-ove za fetch/toast/render i provjerava ponašanje.
//   2. Statički prolazi kroz inline <script> i javlja svaki poziv funkcije koja
//      nije definisana u stranici — da se ista greška ne vrati.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── Pomoćne funkcije za rad sa inline skriptom ───────────────────────────────
function inlineScripts(html) {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].map(m => m[2]);
}

/**
 * Skida komentare i sadržaj stringova, ali ZADRŽAVA izraze unutar `${...}` u
 * template literalima (tamo je stvarni kod, npr. `${filtered.map(m => ...)}`).
 */
function stripLiterals(code) {
  let out = '', i = 0;
  const n = code.length;

  function skipQuote(quote) {                 // '...' ili "..."
    i++;
    while (i < n && code[i] !== quote) i += code[i] === '\\' ? 2 : 1;
    i++;
    return '""';
  }

  function skipTemplate() {                   // `tekst ${ izraz } tekst`
    i++;                                      // otvoreni `
    let expr = '';
    while (i < n && code[i] !== '`') {
      if (code[i] === '\\') { i += 2; continue; }
      if (code[i] === '$' && code[i + 1] === '{') {
        i += 2;
        let depth = 0, inner = '';
        while (i < n) {
          if (code[i] === '{') depth++;
          else if (code[i] === '}') { if (depth === 0) break; depth--; }
          inner += code[i++];
        }
        i++;                                  // zatvoreni }
        expr += '(' + stripLiterals(inner) + ')';
        continue;
      }
      i++;                                    // običan tekst literala → odbaci
    }
    i++;                                      // zatvoreni `
    return expr;
  }

  while (i < n) {
    const c = code[i], d = code[i + 1];
    if (c === '/' && d === '/') { while (i < n && code[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"') { out += skipQuote(c); continue; }
    if (c === '`') { out += skipTemplate(); continue; }
    out += c; i++;
  }
  return out;
}

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function', 'async',
  'else', 'do', 'try', 'new', 'delete', 'void', 'instanceof', 'in', 'of', 'yield', 'case',
  'var', 'let', 'const', 'class', 'get', 'set', 'static', 'export', 'import', 'default', 'super'
]);

/** Imena koja su deklarisana / importovana / parametri u datoj skripti. */
function definedNames(code) {
  const names = new Set();
  const addParams = list => list.split(',')
    .map(s => s.trim().replace(/^\.\.\./, '').replace(/\s*=.*$/, '').trim())
    .filter(s => /^[A-Za-z_$][\w$]*$/.test(s))
    .forEach(s => names.add(s));

  for (const m of code.matchAll(/(?:^|[^.\w$])(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g)) {
    names.add(m[1]); addParams(m[2]);
  }
  for (const m of code.matchAll(/(?:async\s*)?\(([^()]*)\)\s*=>/g)) addParams(m[1]);          // (a, b) => ...
  for (const m of code.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);    // a => ...
  for (const m of code.matchAll(/\bcatch\s*\(([^()]*)\)/g)) addParams(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:let|const|var)\s*\{([^}]*)\}/g))
    m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop().replace(/\s*=.*$/, '').trim())
      .filter(Boolean).forEach(x => names.add(x));
  for (const m of code.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from/g))
    m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach(x => names.add(x));
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|\s+from)/g)) names.add(m[1]);
  for (const m of code.matchAll(/import\s*\*\s*as\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

/** "Goli" pozivi funkcija: `nešto(` — bez `.` ispred i bez ključnih riječi. */
function calledNames(code) {
  const clean = stripLiterals(code);
  const calls = new Set();
  for (const m of clean.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    const before = clean.slice(0, m.index).replace(/\s+$/, '');
    if (before.endsWith('.') || before.endsWith('?.')) continue;          // metod
    if (/(?:^|[^.\w$])new$/.test(before)) continue;                       // konstruktor
    if (/(?:^|[^.\w$])(?:async\s+)?function\s*\*?\s*$/.test(before)) continue; // deklaracija
    if (/(?:^|[^.\w$])(?:get|set)\s*$/.test(before)) continue;
    calls.add(name);
  }
  return calls;
}

/** Izvadi izvor funkcije (po imenu) iz teksta, poštujući vitičaste zagrade. */
function extractFunctionSource(code, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const start = code.search(re);
  assert.notEqual(start, -1, `funkcija ${name}() nije pronađena u izvoru`);
  let i = code.indexOf('{', code.indexOf('(', start));
  let depth = 0;
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return code.slice(start, i);
}

/** Platformski / SDK globali koje stranice koriste bez importa. */
const GLOBALS = new Set([
  'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'Option', 'FormData', 'Blob', 'FileReader', 'URLSearchParams', 'Audio', 'Image', 'Worker',
  'Date', 'JSON', 'Math', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Map', 'Set',
  'Promise', 'Error', 'RegExp', 'Intl', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'atob', 'btoa', 'alert', 'confirm', 'prompt',
  'structuredClone', 'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'AbortController',
  'Event', 'CustomEvent', 'localStorage', 'sessionStorage', 'crypto', 'navigator', 'document',
  'window', 'console', 'SpeechSynthesisUtterance', 'speechSynthesis', 'Notification', 'File',
  'TextEncoder', 'TextDecoder', 'URL', 'WebSocket', 'require', 'process', 'Buffer', 'module'
]);

// ════════════════════════════════════════════════════════════════════════════
// 1) admin.html mora definisati loadMaterials
// ════════════════════════════════════════════════════════════════════════════
const adminHtml = read('public/pages/admin.html');
const adminCode = inlineScripts(adminHtml).join('\n');

test('admin.html definiše loadMaterials() koju i poziva', () => {
  const calls = [...adminCode.matchAll(/(?<![.\w$])loadMaterials\s*\(/g)].length;
  assert.ok(calls >= 4, `očekivano 4+ poziva loadMaterials, nađeno ${calls}`);
  assert.match(adminCode, /(?:async\s+)?function\s+loadMaterials\s*\(/,
    'loadMaterials() se poziva ali nije definisana u admin.html → ReferenceError');
});

// ════════════════════════════════════════════════════════════════════════════
// 2) Stvarni izvor funkcije se izvršava uz stub-ove
// ════════════════════════════════════════════════════════════════════════════
function harness({ fetchImpl }) {
  const calls = { filters: 0, render: 0, drive: 0, toasts: [] };
  const src = extractFunctionSource(adminCode, 'loadMaterials');
  // `materials` / `driveStatusRequested` su module-level let-ovi u stranici;
  // tijelo funkcije je originalni kod iz admin.html, bez prepravki.
  const script = new vm.Script(
    `(function () {\nlet materials = [];\nlet driveStatusRequested = false;\n${src}\n` +
    `return { loadMaterials, get materials() { return materials; } };\n})()`
  );
  const ctx = vm.createContext({
    fetch: fetchImpl,
    authHeaders: async () => ({ Authorization: 'Bearer test-token' }),
    populateMaterialFilters: () => { calls.filters++; },
    filterMaterials: () => { calls.render++; },
    loadDriveStatus: () => { calls.drive++; },
    toast: (msg, kind) => calls.toasts.push({ msg, kind }),
    console: { warn: () => {}, log: () => {}, error: () => {} },
    Error
  });
  return { api: script.runInContext(ctx), calls };
}

test('loadMaterials() puni listu i osvježava filtere + tabelu', async () => {
  const seen = {};
  const { api, calls } = harness({
    fetchImpl: async (url, opts) => {
      seen.url = url; seen.opts = opts;
      return { ok: true, json: async () => ({ success: true, materials: [{ id: 'm1', title: 'Skripta', subject: 'Matematika' }] }) };
    }
  });

  await api.loadMaterials();

  assert.equal(seen.url, '/api/materials');
  assert.deepEqual(seen.opts.headers, { Authorization: 'Bearer test-token' });
  assert.deepEqual(Array.from(api.materials).map(m => m.id), ['m1']);   // Array.from: vm kontekst ima svoj Array.prototype
  assert.equal(calls.filters, 1, 'populateMaterialFilters() mora biti pozvan');
  assert.equal(calls.render, 1, 'filterMaterials() mora biti pozvan (inače tabela ostaje prazna)');
  assert.deepEqual(calls.toasts, []);
});

test('loadMaterials() ne ruši panel kad /api/materials padne (503)', async () => {
  const { api, calls } = harness({
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'Baza nije konfigurisana' }) })
  });

  await api.loadMaterials();   // ne smije baciti — loadAll() hvata i gasi ostatak

  assert.equal(api.materials.length, 0, 'lista mora biti prazna, ne zastarjela');
  assert.equal(calls.render, 1, 'tabela se mora iscrtati i sa praznom listom');
  assert.equal(calls.filters, 1);
  assert.equal(calls.toasts.length, 1);
  assert.equal(calls.toasts[0].kind, 'error');
  assert.match(calls.toasts[0].msg, /Baza nije konfigurisana/);
});

test('Google Drive status se traži samo pri prvom učitavanju', async () => {
  const { api, calls } = harness({
    fetchImpl: async () => ({ ok: true, json: async () => ({ materials: [] }) })
  });

  await api.loadMaterials();
  await api.loadMaterials();
  await api.loadMaterials();

  assert.equal(calls.drive, 1, 'loadDriveStatus() treba ići jednom, ne poslije svake izmjene');
  assert.equal(calls.render, 3);
});

// ════════════════════════════════════════════════════════════════════════════
// 3) Vidljivost materijala: stvarni izvor iz admin.html se izvršava uz fiksne
//    učenike — admin u tabeli mora tačno vidjeti ko vidi koji materijal.
// ════════════════════════════════════════════════════════════════════════════
function visibilityHarness() {
  // normRazred / materialVisibleTo / visibilityBadge su čiste funkcije u
  // stranici; izvor je originalni kod iz admin.html, bez prepravki.
  const src = ['normRazred', 'materialVisibleTo', 'visibilityBadge']
    .map(n => extractFunctionSource(adminCode, n)).join('\n');
  const script = new vm.Script(
    `(function () {\n${src}\nreturn { normRazred, materialVisibleTo, visibilityBadge };\n})()`
  );
  return script.runInContext(vm.createContext({}));
}

const VIS_STUDENTS = [
  { id: 'u1', displayName: 'Ana',  razred: 'III-T5' },
  { id: 'u2', displayName: 'Bojan', razred: 'iii t5' },   // mala slova + razmak
  { id: 'u3', displayName: 'Ceca', razred: 'III T5' },    // razmak umjesto crtice
  { id: 'u4', displayName: 'Dino', razred: 'IV-T5' },
  { id: 'u5', displayName: 'Ena',  razred: '' },          // bez razreda
];

test('admin.html: normRazred je identičan serverskom normalizeRazred', async () => {
  const { normalizeRazred } = await import('../lib/materials.js');
  const { normRazred } = visibilityHarness();
  for (const v of ['III-T5', 'iii t5', 'III T5', ' iii–t5 ', 'IV-T5', '', null, undefined]) {
    assert.equal(normRazred(v), normalizeRazred(v), `razlika za ${JSON.stringify(v)}`);
  }
});

test('admin.html: materialVisibleTo pogađa ko vidi materijal', () => {
  const { materialVisibleTo } = visibilityHarness();
  // Array.from: vm kontekst ima svoj Array.prototype
  const ids = m => Array.from(materialVisibleTo(m, VIS_STUDENTS)).map(s => s.id);

  assert.deepEqual(ids({ razredi: ['III-T5'], visible: true }), ['u1', 'u2', 'u3']);
  assert.deepEqual(ids({ razredi: [], visible: true }), ['u1', 'u2', 'u3', 'u4', 'u5']);
  assert.deepEqual(ids({ razredi: ['III-T5'], visible: false }), []);
  assert.deepEqual(ids({ razredi: ['III-T6'], visible: true }), [], 'niko nije III-T6');
  assert.deepEqual(ids({ razredi: ['IV-T5'], visible: true }), ['u4']);
  assert.deepEqual(ids(null, VIS_STUDENTS), []);
});

test('admin.html: visibilityBadge upozorava kad materijal ne vidi niko', () => {
  const { visibilityBadge } = visibilityHarness();

  const ok = visibilityBadge({ razredi: ['III-T5'], visible: true }, VIS_STUDENTS);
  assert.match(ok, /3\/5/);

  const none = visibilityBadge({ razredi: ['III-T6'], visible: true }, VIS_STUDENTS);
  assert.match(none, /ne vidi niko/);
  assert.match(none, /0\/5/);

  const hidden = visibilityBadge({ razredi: [], visible: false }, VIS_STUDENTS);
  assert.match(hidden, /sakriveno/);
});

test('admin.html: modal ima brojač vidljivosti, učenici bez razreda su označeni', () => {
  assert.match(adminHtml, /id="mm-vis"/, 'modal mora imati #mm-vis brojač');
  assert.match(adminCode, /updateMaterialVisibility\(\)/, 'brojač se mora osvježavati');
  assert.match(adminHtml, /bez razreda/, 'učenik bez razreda mora biti vidljivo označen');
});

const studentHtml = read('public/pages/student.html');
const studentCode = inlineScripts(studentHtml).join('\n');

test('student.html: upozorenje kad učenik nema razred', () => {
  assert.match(studentHtml, /id="mat-no-razred"/, 'mora postojati #mat-no-razred upozorenje');
  assert.match(studentHtml, /Nemate postavljen razred/, 'poruka mora objašnjavati uzrok');
});

test('student.html: nedostajući logout element ne smije prekinuti inicijalizaciju literature', () => {
  // Regresija stvarnog uzroka praznog taba: stranica je radila
  // document.getElementById('logout-btn').onclick = ... iako taj element nije
  // postojao. TypeError je zaustavljao modul prije `let materials`, pa auth
  // callback nije mogao prikazati ni materijal ni empty/error poruku.
  assert.match(studentHtml, /id="logout-btn"/, '#logout-btn koji skripta povezuje mora postojati');
  assert.doesNotMatch(studentCode,
    /document\.getElementById\(['"]logout-btn['"]\)\.onclick\s*=/,
    'event handler se ne smije postavljati direktno na mogući null');
  assert.match(studentCode, /if\s*\(logoutBtn\)\s*\{[\s\S]*?logoutBtn\.addEventListener\(/,
    'logout povezivanje mora biti null-safe');

  const stateIdx = studentCode.indexOf('let materials = []');
  const authIdx  = studentCode.indexOf('onAuthStateChanged(auth');
  assert.ok(stateIdx > -1 && stateIdx < authIdx,
    'stanje literature mora biti inicijalizovano prije auth callbacka');

  assert.match(studentHtml, /id="materials-grid"[\s\S]*?Učitavanje literature…/,
    'početna poruka mora postojati i bez izvršenog JavaScripta');
});

// ════════════════════════════════════════════════════════════════════════════
// 3b) student.html: literatura se učitava NEZAVISNO od ostatka stranice, a
//     greška pri učitavanju mora biti VIDILJIVA (ne samo u konzoli).
//     Ranije: loadMaterials() je visio na kraju loadData(), pa je pad bilo
//     kog Firestore upita ostavljao tab Literatura prazan bez poruke; pad
//     /api/materials bi pokazao "Nema materijala" — kao da ga stvarno nema.
// ════════════════════════════════════════════════════════════════════════════
test('student.html: loadMaterials() ne visi na kraju loadData()', () => {
  // stripLiterals skida komentare — gleda se samo stvarni kod
  const loadDataSource = stripLiterals(extractFunctionSource(studentCode, 'loadData'));
  assert.doesNotMatch(loadDataSource, /(?<![.\w$])loadMaterials\s*\(/,
    'pad bilo kog Firestore upita u loadData() ne smije ostaviti literaturu praznom');

  const authIdx  = studentCode.indexOf('onAuthStateChanged(auth');
  const loadIdx  = studentCode.indexOf('await loadData()');
  assert.ok(authIdx > -1 && loadIdx > -1, 'onAuthStateChanged i loadData() moraju postojati');
  const handler = stripLiterals(studentCode.slice(authIdx, loadIdx));
  assert.match(handler, /(?<![.\w$])loadMaterials\s*\(\s*u\s*\)/,
    'loadMaterials(u) se mora zvati direktno iz onAuthStateChanged, nezavisno od loadData()');
});

test('student.html: loadMaterials je izložena na window (inline onclick "Pokušaj ponovo")', () => {
  assert.match(studentCode, /window\.loadMaterials\s*=\s*loadMaterials\b/,
    'modul nije u globalnom scope-u — bez window.loadMaterials retry dugme ne radi');
});

// ════════════════════════════════════════════════════════════════════════════
// 3c) student.html: učenik NEMA direktan pristup Google Drive-u. Stranica mu
//     nudi samo „Otvori" (novi prozor) i „Preuzmi" — oba kroz naš server;
//     Drive link dobija isključivo administrator.
// ════════════════════════════════════════════════════════════════════════════
test('student.html: učenik nema Drive dugme — samo „Otvori" i „Preuzmi"', () => {
  assert.match(studentCode, /title="Otvori u novom prozoru"/, 'dugme „Otvori" (novi prozor) mora postojati');
  assert.match(studentCode, /Preuzmi\s*<\/button>/, 'dugme „Preuzmi" mora postojati');
  assert.doesNotMatch(studentCode, /openMaterialDrive/, 'Drive logika ne smije postojati na studentskoj stranici');
  assert.doesNotMatch(studentCode, /m\.drive\s*\?/, 'render kartice ne smije zavisiti od Drive linka');
});

/** Izvršava STVARNI izvor loadMaterials() iz student.html uz stub-ove. */
function studentMaterialsHarness({ fetchImpl }) {
  const calls = { renders: 0, errors: [] };
  const src = extractFunctionSource(studentCode, 'loadMaterials');
  const script = new vm.Script(
    `(function () {\nlet materials = ['stale'];\n${src}\n` +
    `return { loadMaterials, get materials() { return materials; } };\n})()`
  );
  // <select id="mat-subject"> — dovoljno options/remove/appendChild za kod iz stranice
  const sel = {
    options: [{ value: '', text: 'Svi predmeti' }],
    remove(i) { this.options.splice(i, 1); },
    appendChild(o) { this.options.push(o); }
  };
  const ctx = vm.createContext({
    fetch: fetchImpl,
    auth: { currentUser: { getIdToken: async () => 'test-token' } },
    renderMaterials: () => { calls.renders++; },
    renderMaterialsError: (msg) => { calls.errors.push(String(msg)); },
    Option: function (value, text) { this.value = value; this.text = text; },
    document: { getElementById: (id) => id === 'mat-subject' ? sel : null },
    console: { warn: () => {} },
    Error
  });
  return { api: script.runInContext(ctx), calls, sel };
}

test('student.html: loadMaterials() puni listu, filter predmeta i renderuje', async () => {
  const seen = {};
  const { api, calls, sel } = studentMaterialsHarness({
    fetchImpl: async (url, opts) => {
      seen.url = url; seen.opts = opts;
      return { ok: true, json: async () => ({ materials: [
        { id: 'm1', title: 'Skripta iz matematike', subject: 'Matematika' },
        { id: 'm2', title: 'Pripremnice',           subject: 'Fizika' },
        { id: 'm3', title: 'Bez predmeta',          subject: '' }
      ] }) };
    }
  });

  await api.loadMaterials();

  assert.equal(seen.url, '/api/materials');
  // objekat je nastao u vm kontekstu → poredi se polje, ne prototip (deepStrictEqual)
  assert.equal(seen.opts.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(Array.from(api.materials).map(m => m.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(sel.options.map(o => o.value), ['', 'Fizika', 'Matematika'],
    'filter predmeta se puni, sortiran, bez praznih');
  assert.equal(calls.renders, 1, 'renderMaterials() mora biti pozvan');
  assert.deepEqual(calls.errors, []);
});

test('student.html: pad /api/materials prikazuje grešku, ne "Nema materijala"', async () => {
  const { api, calls } = studentMaterialsHarness({
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'Baza nije konfigurisana' }) })
  });

  await api.loadMaterials();   // ne smije baciti

  assert.equal(api.materials.length, 0, 'lista mora biti prazna, ne zastarjela');
  assert.deepEqual(calls.errors, ['Baza nije konfigurisana'],
    'renderMaterialsError() mora biti pozvan sa porukom servera');
  assert.equal(calls.renders, 0, '"Nema materijala" se ne smije iscrtati preko greške');
});

test('student.html: renderMaterialsError() ispisan je na stranici, escaped, s retry', () => {
  const src = extractFunctionSource(studentCode, 'renderMaterialsError');
  const script = new vm.Script(`(function () {\n${src}\nreturn { renderMaterialsError };\n})()`);
  const els = {};
  const el  = id => (els[id] ??= { innerHTML: '', style: {} });
  const api = script.runInContext(vm.createContext({
    document: { getElementById: el },
    String, Error
  }));

  api.renderMaterialsError('Baza nije konfigurisana');

  const html = els['materials-grid'].innerHTML;
  assert.match(html, /Literatura se nije učitala/, 'naslov greške mora biti vidljiv');
  assert.match(html, /Greška: Baza nije konfigurisana/, 'poruka servera mora biti vidljiva');
  assert.match(html, /Pokušaj ponovo/, 'mora postojati retry dugme');
  assert.match(html, /onclick="loadMaterials\(\)"/, 'retry ponovo zove loadMaterials()');
  assert.equal(els['mat-no-razred'].style.display, 'none',
    'banner "bez razreda" se skriva — uzrok je greška, ne razred');

  // poruka ide u innerHTML → mora biti escaped (server je vrati, ne smije postati HTML)
  api.renderMaterialsError('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(els['materials-grid'].innerHTML, /<img src=x/, 'poruka mora biti escaped');
  assert.match(els['materials-grid'].innerHTML, /&lt;img src=x/);
});

// ════════════════════════════════════════════════════════════════════════════
// 4) Nijedna stranica ne smije zvati nedefinisanu funkciju
// ════════════════════════════════════════════════════════════════════════════
const PAGES = ['public/pages/admin.html', 'public/pages/student.html'];

for (const page of PAGES) {
  test(`${page}: nema poziva nedefinisanih funkcija`, () => {
    const code = stripLiterals(inlineScripts(read(page)).join('\n'));
    const missing = [...calledNames(code)].filter(n => !definedNames(code).has(n) && !GLOBALS.has(n)).sort();
    assert.deepEqual(missing, [], `pozvane su funkcije koje nigdje nisu definisane: ${missing.join(', ')}`);
  });

  test(`${page}: svi statički getElementById ciljevi postoje u HTML-u`, () => {
    const html = read(page);
    const ids = new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map(m => m[1]));
    const referenced = new Set(
      [...inlineScripts(html).join('\n').matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)]
        .map(m => m[1])
    );
    const missing = [...referenced].filter(id => !ids.has(id)).sort();
    assert.deepEqual(missing, [],
      `getElementById ciljevi ne postoje; direktan pristup može prekinuti cijeli modul: ${missing.join(', ')}`);
  });
}
