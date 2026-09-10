// ════════════════════════════════════════════════════════════════════════════
// Google Drive kao skladište materijala.
//
// Fajl se uplouduje DIREKTNO na Google Drive iz naše stranice:
//   - admin klikne "Dodaj materijal" → server pošalje fajl na Drive
//   - u Drive-u se pojavi fajl sa nazivom materijala (npr. "Skripta — Baze.pdf")
//   - učenik otvara kroz našu stranicu (/m/... ili /api/materials/:id/file)
//   - ADMIN dobije i "Otvori na Google Drive-u" link, ako želi tamo raditi
//
// Nema Google Picker-a niti prebacivanja u Drive da bi se nešto dodalo.
// ════════════════════════════════════════════════════════════════════════════

import { sanitizeFileName, mimeForExt } from './materials.js';

export function createDriveStore(drive, cfg = {}) {
  const {
    label = 'Google Drive',
    shareAnyoneDefault = process.env.GDRIVE_SHARE_ANYONE !== '0'
  } = cfg;

  const store = {
    kind:  'drive',
    label,
    mode:  drive.mode,
    ready: drive.mode !== 'off',

    ping: () => drive.ping(),

    // ── Upload ──────────────────────────────────────────────────────────────
    async uploadMaterial({ materialId, title, description, fileName, ext, mimeType, buffer, share }) {
      const driveName = sanitizeFileName(title ? `${title}.${ext}` : fileName);
      const type      = mimeType || mimeForExt(ext);

      const file = await drive.upload({ name: driveName, mimeType: type, buffer });

      const fields = {
        driveFileId:       file.id,
        driveFolderId:     drive.folderId || null,
        driveWebViewLink:  file.webViewLink || null,
        driveName,
        driveShared:       false,
        driveLocation:     drive.folderId ? 'folder' : 'service-account-drive'
      };

      const wantsShare = share === undefined ? shareAnyoneDefault : !!share;
      if (wantsShare) {
        const shared = await store.shareFile({ ...fields, driveFileId: file.id }, true).catch(() => null);
        if (shared) fields.driveShared = true;
      }

      return fields;
    },

    // ── Brisanje ────────────────────────────────────────────────────────────
    async removeMaterial(material = {}) {
      if (material.driveFileId) await drive.remove(material.driveFileId);
    },

    // ── Čitanje (za skidanje fajla kroz našu stranicu) ───────────────────────
    read: (material) => drive.download(typeof material === 'string' ? material : material.driveFileId),

    // Fajl ide direktno iz Google-a ka browseru (Range prolazi kroz, PDF radi).
    streamTo: (req, res, material, opts = {}) => drive.proxyFile(req, res, {
      fileId:      material.driveFileId,
      fileName:    material.fileName,
      mimeType:    material.mimeType || mimeForExt(material.ext),
      download:    !!opts.download,
      contentType: opts.contentType,
      contentDisposition: opts.contentDisposition
    }),

    // ── Linkovi ─────────────────────────────────────────────────────────────
    // Vraća linkove koje stranica prikazuje. `drive` je pravi Google link.
    linkFor(material = {}) {
      if (!material.driveFileId) return null;
      const driveUrl = material.driveWebViewLink
        || `https://drive.google.com/file/d/${material.driveFileId}/view`;
      return {
        drive:     driveUrl,
        preview:   `https://drive.google.com/file/d/${material.driveFileId}/preview`,
        download:  `https://drive.google.com/uc?export=download&id=${material.driveFileId}`
      };
    },

    // "Svako ko ima link može gledati" — potrebno za javni link bez prijave.
    async shareFile(material = {}, enable = true) {
      if (!material.driveFileId) return false;
      if (enable) {
        await drive.shareAnyone(material.driveFileId, 'reader');
        return true;
      }
      // Isključivanje: ukloni 'anyone' dozvole
      try {
        const list = await drive.api(drive.fileApi(material.driveFileId, '/permissions?fields=permissions(id,type,role)'));
        for (const p of list.permissions || []) {
          if (p.type === 'anyone') {
            await drive.api(
              drive.fileApi(material.driveFileId, `/permissions/${encodeURIComponent(p.id)}?supportsAllDrives=true`),
              { method: 'DELETE' }
            );
          }
        }
      } catch (e) {
        console.warn('⚠️  Skidanje javne dozvole:', e.message);
      }
      return false;
    },

    // Drži naziv na Drive-u u sinku sa nazivom materijala.
    syncMeta(material = {}, upd = {}) {
      if (!material.driveFileId) return Promise.resolve(null);
      const name = upd.title !== undefined
        ? sanitizeFileName(`${upd.title}.${material.ext || 'pdf'}`)
        : undefined;
      const description = upd.description;
      if (name === undefined && description === undefined) return Promise.resolve(null);
      return drive.updateMeta(material.driveFileId, { name, description }).catch(e => {
        console.warn('⚠️  Drive meta:', e.message);
        return null;
      });
    }
  };

  return store;
}
