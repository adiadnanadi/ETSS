// ════════════════════════════════════════════════════════════════════════════
// Čiste pomoćne funkcije za modul "Literatura".
// Nema Expressa, nema Firestore-a, nema Firebasea — lako se testira.
// ════════════════════════════════════════════════════════════════════════════

export const MATERIAL_MIME = {
  pdf:  'application/pdf',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt:  'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt:  'text/plain'
};

export const ALLOWED_EXT = Object.keys(MATERIAL_MIME);

// Formati koje browser sam prikaže (Word/PPT se preuzimaju).
export const INLINE_EXT = ['pdf', 'txt'];

// Firestore dokument može imati max 1 MiB. 700 KiB sirovog fajla ~ 934 KB kao
// base64, plus imena polja — ostaje sigurna rezerva ispod limita.
export const CHUNK_BYTES = 700 * 1024;

export function fileExt(name = '') {
  const clean = String(name).split(/[?#]/)[0];
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(clean);
  return m ? m[1].toLowerCase() : '';
}

export function isAllowedFile(name = '') {
  return ALLOWED_EXT.includes(fileExt(name));
}

export function mimeForExt(ext = '') {
  return MATERIAL_MIME[String(ext).toLowerCase()] || 'application/octet-stream';
}

export function isInlineExt(ext = '') {
  return INLINE_EXT.includes(String(ext).toLowerCase());
}

export function sanitizeFileName(name = '') {
  const base = String(name)
    .replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001F<>:"|?*]+/g, '_')
    .trim();
  return base.slice(0, 180) || 'dokument';
}

// ── Dijeljenje fajla na chunk-ove (base64 stringovi) ─────────────────────────
export function chunkBuffer(buffer, chunkBytes = CHUNK_BYTES) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || '');
  if (chunkBytes <= 0) throw new Error('chunkBytes mora biti > 0');
  if (buffer.length === 0) return [''];
  const parts = [];
  for (let i = 0; i < buffer.length; i += chunkBytes) {
    parts.push(buffer.subarray(i, i + chunkBytes).toString('base64'));
  }
  return parts;
}

export function joinChunks(chunks = []) {
  if (!Array.isArray(chunks) || chunks.length === 0) return Buffer.alloc(0);
  return Buffer.concat(chunks.map(c => Buffer.from(String(c || ''), 'base64')));
}

// ── HTTP Range (potrebno da PDF čitač radi "skrolaj/direktno na stranu") ─────
// Vraća: null = nema range-a (pošalji cijeli fajl),
//        { start, end } = isječak, { unsatisfiable: true } = traži 416.
export function parseRange(header, size) {
  if (!header || typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;

  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  let start, end;
  if (rawStart === '') {                       // bytes=-500  (zadnjih 500)
    const suffix = parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end   = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end   = rawEnd === '' ? size - 1 : Math.min(parseInt(rawEnd, 10), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (size > 0 && start >= size) return { unsatisfiable: true };
  if (start > end) return null;
  return { start, end };
}

// ── Ko smije vidjeti materijal ───────────────────────────────────────────────
export function canAccessMaterial(material = {}, user = {}) {
  if (!material || !user) return false;
  if (user.role === 'admin') return true;
  if (material.visible === false) return false;
  const razredi = material.razredi;
  if (!Array.isArray(razredi) || razredi.length === 0) return true;
  return razredi.includes(user.razred);
}

export function contentDisposition(fileName, download = false) {
  const name  = sanitizeFileName(fileName);
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ── Šta klijent smije vidjeti (ne curimo storage putanje ni tajne) ───────────
export function publicMaterial(material = {}, { isAdmin = false } = {}) {
  const out = {
    id:          material.id,
    title:       material.title || '',
    description: material.description || '',
    subject:     material.subject || '',
    razredi:     Array.isArray(material.razredi) ? material.razredi : [],
    fileName:    material.fileName || '',
    ext:         material.ext || fileExt(material.fileName),
    mimeType:    material.mimeType || mimeForExt(material.ext),
    size:        material.size || 0,
    visible:     material.visible !== false,
    downloads:   material.downloads || 0,
    createdAt:   material.createdAt || null,
    updatedAt:   material.updatedAt || null,
    uploadedBy:  material.uploadedBy || null,
    uploadedByName: material.uploadedByName || '',
    inlineView:  isInlineExt(material.ext)
  };

  if (isAdmin) {
    out.shareToken    = material.shareToken || null;
    out.shareEnabled  = material.shareEnabled !== false;
    out.fileStore     = material.fileStore || (material.storagePath ? 'storage' : 'firestore');
    out.chunks        = material.chunks || 0;
    out.fileSizeOk    = material.fileSizeOk !== false;
  }
  return out;
}
