// ════════════════════════════════════════════════════════════════════════════
// Legacy: materijali uploadovani ranije u Firebase Storage.
// Služi samo da stari zapisi (koji imaju `storagePath`, a nemaju `fileStore`)
// i dalje rade — nema uploada. Novi fajlovi idu na Google Drive.
// ════════════════════════════════════════════════════════════════════════════

import { mimeForExt } from './materials.js';

export function createStorageStore(bucket) {
  if (!bucket) return null;

  return {
    kind:     'storage',
    label:    'Firebase Storage (stari materijali)',
    mode:     'legacy',
    ready:    true,
    readOnly: true,

    async removeMaterial(material = {}) {
      if (material.storagePath) await bucket.file(material.storagePath).delete();
    },

    read: (material) => bucket.file(typeof material === 'string' ? material : material.storagePath)
      .download()
      .then(([buf]) => buf),

    streamTo(req, res, material, opts = {}) {
      const file = bucket.file(material.storagePath);
      res.setHeader('Content-Type', material.mimeType || mimeForExt(material.ext));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Disposition', opts.contentDisposition || 'inline');
      if (material.size) res.setHeader('Content-Length', material.size);
      file.createReadStream()
        .on('error', err => {
          console.error('❌ storage stream:', err.message);
          if (!res.headersSent) res.status(500).end(); else res.end();
        })
        .pipe(res);
    },

    linkFor: () => null
  };
}
