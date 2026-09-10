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

test('student.html: upozorenje kad učenik nema razred', () => {
  const studentHtml = read('public/pages/student.html');
  assert.match(studentHtml, /id="mat-no-razred"/, 'mora postojati #mat-no-razred upozorenje');
  assert.match(studentHtml, /Nemate postavljen razred/, 'poruka mora objašnjavati uzrok');
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
}
