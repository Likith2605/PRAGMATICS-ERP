import { putFile, getFileWithMetadata, getFileContentWithMetadata, deleteFile } from '../services/fileApi.js';

/**
 * Project drawing storage.
 *
 * PostgreSQL (`file_blobs` via /api/files) is authoritative. IndexedDB is a
 * cache and an explicit, Admin-only source for verified legacy migration.
 * Reads always retrieve PostgreSQL bytes before refreshing that cache.
 */

const DB_NAME = 'DrawingFilesDB';
const DB_VERSION = 1;
const STORE_NAME = 'drawings';

export const getDrawingFileId = (projectId, drawingNo) =>
  `drawing::${encodeURIComponent(projectId)}::${encodeURIComponent(drawingNo)}`;

export const findEmbeddedLegacyDrawing = (records, projectId, drawingNo) => {
  const expectedProjectId = String(projectId || '').trim();
  const expectedDrawingNo = String(drawingNo || '').trim();
  let match = null;

  for (const record of Array.isArray(records) ? records : []) {
    const recordId = String(record?.projectId || record?.id || '').trim();
    if (recordId !== expectedProjectId) continue;

    for (const item of Array.isArray(record?.items) ? record.items : []) {
      if (String(item?.drawingNo || '').trim() !== expectedDrawingNo || !item?.drawingDataUrl) continue;
      const candidate = {
        dataUrl: String(item.drawingDataUrl),
        fileName: String(item.drawingFileName || '')
      };
      if (match && match.dataUrl !== candidate.dataUrl) return { status: 'ambiguous' };
      match = candidate;
    }
  }

  return match ? { status: 'available', ...match } : { status: 'missing' };
};

const openDB = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const dataUrlToBlob = (dataUrl) => {
  const comma = String(dataUrl).indexOf(',');
  const header = String(dataUrl).slice(0, comma);
  const meta = header.slice(header.indexOf(':') + 1, header.indexOf(';'));
  const b64 = String(dataUrl).slice(comma + 1);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: meta || 'application/octet-stream' });
};

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });

const sha256 = async (blob) => {
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
};

const verifyServerAttachment = async (stored, id, projectId, drawingNo) => {
  if (!stored || stored.id !== id ||
      stored.metadata.projectId !== String(projectId) ||
      stored.metadata.drawingNo !== String(drawingNo)) {
    throw new Error(`Drawing attachment identity check failed for '${drawingNo}'.`);
  }
  if (stored.blob.size === 0) throw new Error(`Drawing attachment '${drawingNo}' is empty.`);
  if (stored.blob.type.toLowerCase() === 'application/pdf') {
    const [header, footer] = await Promise.all([
      stored.blob.slice(0, 1024).text(),
      stored.blob.slice(Math.max(0, stored.blob.size - 1024)).text()
    ]);
    if (!header.includes('%PDF-') || !footer.includes('%%EOF')) {
      throw new Error(`Drawing attachment '${drawingNo}' is not a valid PDF.`);
    }
  }
  if (!stored.checksumSha256 || stored.checksumSha256 !== await sha256(stored.blob)) {
    throw new Error(`Drawing attachment integrity check failed for '${drawingNo}'.`);
  }
  return stored;
};

/** Save the durable server copy first. Resolve only after PostgreSQL confirms. */
const saveServerDrawing = (projectId, drawingNo, blob, fileName) =>
  putFile(getDrawingFileId(projectId, drawingNo), blob, {
    fileName: fileName || `${drawingNo || 'drawing'}`,
    scope: 'drawing',
    metadata: { projectId: String(projectId), drawingNo: String(drawingNo) }
  });

export const saveDrawing = async (projectId, drawingNo, dataUrl, fileName = '') => {
  if (!dataUrl) return;
  const blob = dataUrlToBlob(dataUrl);
  const id = getDrawingFileId(projectId, drawingNo);
  const saved = await saveServerDrawing(projectId, drawingNo, blob, fileName);
  if (saved.id !== id || saved.checksumSha256 !== await sha256(blob)) {
    throw new Error(`Drawing '${drawingNo}' was not confirmed by PostgreSQL integrity check.`);
  }
  const verified = await getFileContentWithMetadata(id);
  await verifyServerAttachment(verified, id, projectId, drawingNo);
  if (verified.checksumSha256 !== await sha256(blob) || verified.sizeBytes !== blob.size) {
    throw new Error(`Drawing '${drawingNo}' did not pass PostgreSQL read-back verification.`);
  }
  // IndexedDB is only a cache. A cache failure must not undo a confirmed
  // PostgreSQL save or make the caller believe the durable upload failed.
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(dataUrl, `${projectId}::${drawingNo}`);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn(`Drawing '${drawingNo}' was saved to PostgreSQL but could not be cached locally:`, error.message);
  }
  return { id, drawingNo: String(drawingNo), fileName: fileName || '', sizeBytes: verified.sizeBytes, checksumSha256: verified.checksumSha256 };
};

export const saveAllDrawings = async (projectId, items) => {
  const tasks = items
    .filter((item) => item.drawingDataUrl)
    .map((item) => saveDrawing(projectId, item.drawingNo, item.drawingDataUrl, item.drawingFileName));
  return Promise.all(tasks);
};

export const getDrawing = async (projectId, drawingNo, fileId = '') => {
  const expectedId = getDrawingFileId(projectId, drawingNo);
  const id = String(fileId || expectedId);
  if (id !== expectedId) throw new Error(`Drawing attachment identity check failed for '${drawingNo}'.`);
  // Always consult PostgreSQL first; a stale local cache can never mask the
  // currently authoritative attachment. Network failure is surfaced to UI.
  const stored = await getFileContentWithMetadata(id);
  if (!stored) return null;
  await verifyServerAttachment(stored, id, projectId, drawingNo);
  const dataUrl = await blobToDataUrl(stored.blob);
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(dataUrl, `${projectId}::${drawingNo}`);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) { console.warn('Drawing was loaded from PostgreSQL but could not be cached:', error.message); }
  return dataUrl;
};

const readCachedDrawing = async (projectId, drawingNo) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(`${projectId}::${drawingNo}`);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
};

/** Read-only preview of old IndexedDB-only drawings; never deletes local data. */
export const previewLegacyDrawings = async (projectId, items) => Promise.all(items.map(async (item) => {
  if (!item.drawingNo) return { drawingNo: '', status: 'no-drawing-number' };
  const id = getDrawingFileId(projectId, item.drawingNo);
  const local = await readCachedDrawing(projectId, item.drawingNo);
  const server = await getFileWithMetadata(id);
  if (server) await verifyServerAttachment(server, id, projectId, item.drawingNo);
  return {
    drawingNo: item.drawingNo,
    status: server ? 'server-present' : local ? 'legacy-local-only' : 'missing-both',
    hasLocalCopy: Boolean(local),
    fileId: server?.id || '',
    fileName: server?.fileName || '',
    sizeBytes: server?.sizeBytes || 0,
    checksumSha256: server?.checksumSha256 || ''
  };
}));

/** Explicit, create-only migration. Existing server attachments are never overwritten. */
export const migrateLegacyDrawing = async (projectId, drawingNo, fileName = '') => {
  const local = await readCachedDrawing(projectId, drawingNo);
  if (!local) return { status: 'missing-both' };
  return migrateDrawingBytes(projectId, drawingNo, local, fileName);
};

/** Explicit Admin recovery path for embedded bytes in an imported legacy row. */
export const migrateLegacyEmbeddedDrawing = async (projectId, drawingNo, dataUrl, fileName = '') => {
  if (!dataUrl) return { status: 'missing-embedded-copy' };
  return migrateDrawingBytes(projectId, drawingNo, dataUrl, fileName);
};

const migrateDrawingBytes = async (projectId, drawingNo, dataUrl, fileName = '') => {
  const id = getDrawingFileId(projectId, drawingNo);
  const existing = await getFileWithMetadata(id);
  if (existing) {
    await verifyServerAttachment(existing, id, projectId, drawingNo);
    return { status: 'server-present-verified', fileId: id, fileName: existing.fileName || fileName, sizeBytes: existing.sizeBytes, checksumSha256: existing.checksumSha256 };
  }
  const blob = dataUrlToBlob(dataUrl);
  const saved = await putFile(getDrawingFileId(projectId, drawingNo), blob, {
    fileName: fileName || drawingNo, scope: 'drawing', metadata: { projectId: String(projectId), drawingNo: String(drawingNo) }, ifAbsent: true
  });
  const verified = await getFileWithMetadata(id);
  await verifyServerAttachment(verified, saved.id, projectId, drawingNo);
  if (verified.checksumSha256 !== await sha256(blob)) throw new Error(`Legacy drawing '${drawingNo}' could not be verified on PostgreSQL.`);
  return { status: 'migrated-and-verified', fileId: id, fileName: verified.fileName || fileName, sizeBytes: verified.sizeBytes, checksumSha256: verified.checksumSha256 };
};

export const deleteDrawing = async (projectId, drawingNo) => {
  // Keep the client copy until the durable server delete is confirmed.
  const deleted = await deleteFile(getDrawingFileId(projectId, drawingNo));
  if (!deleted) throw new Error(`Drawing '${drawingNo}' could not be deleted from PostgreSQL.`);
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(`${projectId}::${drawingNo}`);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const deleteAllDrawings = async (projectId, items) => {
  const tasks = items.map((item) => deleteDrawing(projectId, item.drawingNo));
  await Promise.all(tasks);
};
