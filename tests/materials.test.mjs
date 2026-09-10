import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import {
  fileExt, isAllowedFile, mimeForExt, isInlineExt, sanitizeFileName,
  chunkBuffer, joinChunks, parseRange, canAccessMaterial, publicMaterial,
  contentDisposition, CHUNK_BYTES, normalizeRazred, parseRazredi
} from '../lib/materials.js';

test('fileExt / isAllowedFile', () => {
  assert.equal(fileExt('Skripta.PDF'), 'pdf');
  assert.equal(fileExt('poglavlje 3.docx'), 'docx');
  assert.equal(fileExt('bez ekstenzije'), '');
  assert.equal(fileExt('arhiva.pdf.exe'), 'exe');

  assert.ok(isAllowedFile('a.pdf'));
  assert.ok(isAllowedFile('a.DOCX'));
  assert.ok(!isAllowedFile('a.exe'));
  assert.ok(!isAllowedFile('a.pdf.exe'));
});

test('mimeForExt / isInlineExt', () => {
  assert.equal(mimeForExt('pdf'), 'application/pdf');
  assert.equal(mimeForExt('docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(mimeForExt('xyz'), 'application/octet-stream');
  assert.ok(isInlineExt('PDF'));
  assert.ok(!isInlineExt('docx'));
});

test('sanitizeFileName sklanja opasne znakove', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitizeFileName('a:b*c?.pdf'), 'a_b_c_.pdf');
  assert.equal(sanitizeFileName(''), 'dokument');
  assert.ok(sanitizeFileName('x'.repeat(400)).length <= 180);
});

test('chunkBuffer / joinChunks vraćaju identične bajtove', () => {
  const buf = crypto.randomBytes(200_000);
  const parts = chunkBuffer(buf, 64 * 1024);
  assert.equal(parts.length, Math.ceil(200_000 / (64 * 1024)));
  assert.ok(parts.every(p => typeof p === 'string'));
  assert.deepEqual(joinChunks(parts), buf);
});

test('chunkBuffer sa praznim fajlom i joinChunks sa đubre ulazom', () => {
  assert.deepEqual(chunkBuffer(Buffer.alloc(0)), ['']);
  assert.equal(joinChunks([]).length, 0);
  assert.equal(joinChunks(null).length, 0);
});

test('chunkBuffer poštuje default 700 KB (Firestore limit 1 MiB)', () => {
  assert.ok(CHUNK_BYTES < 1024 * 1024);
  const parts = chunkBuffer(Buffer.alloc(CHUNK_BYTES + 10), CHUNK_BYTES);
  assert.equal(parts.length, 2);
  // base64 od 700 KB mora ostati ispod 1 MiB po dokumentu
  assert.ok(Buffer.byteLength(parts[0]) < 1024 * 1024);
});

test('parseRange: normalni, granični i neispravni slučajevi', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=100-', 1000), { start: 100, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=500-9999', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=0-0', 1000), { start: 0, end: 0 });
  assert.deepEqual(parseRange('bytes=1000-', 1000), { unsatisfiable: true });
  assert.equal(parseRange('bytes=abc', 1000), null);
  assert.equal(parseRange('items=0-10', 1000), null);
  assert.equal(parseRange('bytes=900-100', 1000), null);
});

test('normalizeRazred / parseRazredi izjednačavaju crticu, razmak i veličinu slova', () => {
  assert.equal(normalizeRazred(' iii-t5 '), 'III-T5');
  assert.equal(normalizeRazred('III–T5'), 'III-T5');   // en-dash
  assert.equal(normalizeRazred('iii t5'), 'III T5');
  assert.deepEqual(parseRazredi('["III-T5","IV-T5"]'), ['III-T5', 'IV-T5']);
  assert.deepEqual(parseRazredi('III-T5, IV-T5'), ['III-T5', 'IV-T5']);
  assert.deepEqual(parseRazredi('[]'), []);
  assert.deepEqual(parseRazredi(null), []);
});

test('canAccessMaterial: razredi, vidljivost, admin', () => {
  const student = { role: 'student', razred: 'III-1' };
  const admin   = { role: 'admin',   razred: '' };

  assert.ok(canAccessMaterial({ razredi: [] }, student));
  assert.ok(canAccessMaterial({ razredi: ['III-1', 'IV-2'] }, student));
  assert.ok(!canAccessMaterial({ razredi: ['IV-2'] }, student));
  assert.ok(!canAccessMaterial({ razredi: [], visible: false }, student));
  assert.ok(canAccessMaterial({ razredi: [], visible: false }, admin));
  assert.ok(canAccessMaterial({ razredi: ['IV-2'] }, admin));
  assert.ok(canAccessMaterial({ razredi: [] }, {}));   // "za sve razrede" vidi svaki prijavljeni
  assert.ok(!canAccessMaterial({}, null));

  // strogo označen razred, ali drugačiji zapis — učenik I DALJE vidi
  assert.ok(canAccessMaterial({ razredi: [' iii–t5 '] }, { role: 'student', razred: 'III-T5' }));
  assert.ok(canAccessMaterial({ razredi: '["III-T5"]' }, { role: 'student', razred: 'III-T5' }));
  assert.ok(!canAccessMaterial({ razredi: ['III-T5'] }, { role: 'student', razred: 'IV-T5' }));
  assert.ok(!canAccessMaterial({ razredi: ['III-T5'] }, { role: 'student', razred: '' }));
});

test('publicMaterial ne curi internu putanju ni Drive ID učenicima', () => {
  const material = {
    id: 'm1', title: 'Skripta', ext: 'pdf', fileName: 's.pdf', size: 10,
    storagePath: 'materials/m1/s.pdf', driveFileId: 'DRIVE_ID',
    shareToken: 'abc', chunks: 3, visible: true
  };
  const forStudent = publicMaterial(material, { isAdmin: false });
  const json = JSON.stringify(forStudent);

  assert.ok(!json.includes('DRIVE_ID'));
  assert.ok(!json.includes('materials/m1/s.pdf'));
  assert.equal(forStudent.shareToken, undefined);
  assert.equal(forStudent.inlineView, true);

  const forAdmin = publicMaterial(material, { isAdmin: true });
  assert.equal(forAdmin.shareToken, 'abc');
  assert.equal(forAdmin.chunks, 3);
});

test('contentDisposition je bezbjedan za navodnike i naša slova', () => {
  const cd = contentDisposition('Skripta "Baze" — III.pdf', true);
  assert.ok(cd.startsWith('attachment;'));
  assert.ok(cd.includes("filename*=UTF-8''"));
  assert.ok(!cd.includes('\n'));
  assert.ok(cd.includes('%E2%80%94'));       // — je enkodirana
  assert.ok(contentDisposition('a.pdf', false).startsWith('inline;'));
});
