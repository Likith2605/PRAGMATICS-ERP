import { putFile, getFile, deleteFile } from '../services/fileApi.js';

/**
 * Project drawing storage.
 *
 * IndexedDB stays as the fast local cache; every drawing is also mirrored to
 * PostgreSQL (`file_blobs` via /api/files) so database backups capture the
 * attachments. Reads fall back to the server when the local cache is empty
 * (fresh browser / restored backup) and re-populate the cache.
 */

const DB_NAME = 'DrawingFilesDB';
const DB_VERSION = 1;
const STORE_NAME = 'drawings';

const serverId = (projectId, drawingNo) =>
  `drawing::${encodeURIComponent(projectId)}::${encodeURIComponent(drawingNo)}`;

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

/** Fire-and-forget upload; the local cache write already succeeded. */
const mirrorToServer = (projectId, drawingNo, dataUrl) => {
  putFile(serverId(projectId, drawingNo), dataUrlToBlob(dataUrl), {
    fileName: `${drawingNo || 'drawing'}`,
    scope: 'drawing',
    metadata: { projectId: String(projectId), drawingNo: String(drawingNo) }
  }).catch((error) => {
    console.warn(`Drawing '${drawingNo}' of project '${projectId}' not yet saved to PostgreSQL:`, error.message);
  });
};

export const saveDrawing = async (projectId, drawingNo, dataUrl) => {
  if (!dataUrl) return;
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(dataUrl, `${projectId}::${drawingNo}`);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  mirrorToServer(projectId, drawingNo, dataUrl);
};

export const saveAllDrawings = async (projectId, items) => {
  const tasks = items
    .filter((item) => item.drawingDataUrl)
    .map((item) => saveDrawing(projectId, item.drawingNo, item.drawingDataUrl));
  await Promise.all(tasks);
};

export const getDrawing = async (projectId, drawingNo) => {
  const db = await openDB();
  const cached = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(`${projectId}::${drawingNo}`);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  if (cached) return cached;

  // Local cache miss (new browser or restored backup) — pull from PostgreSQL.
  try {
    const blob = await getFile(serverId(projectId, drawingNo));
    if (!blob) return null;
    const dataUrl = await blobToDataUrl(blob);
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(dataUrl, `${projectId}::${drawingNo}`);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return dataUrl;
  } catch (error) {
    console.warn('Drawing fetch from PostgreSQL failed:', error.message);
    return null;
  }
};

export const deleteDrawing = async (projectId, drawingNo) => {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(`${projectId}::${drawingNo}`);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  deleteFile(serverId(projectId, drawingNo)).catch(() => {});
};

export const deleteAllDrawings = async (projectId, items) => {
  const tasks = items.map((item) => deleteDrawing(projectId, item.drawingNo));
  await Promise.all(tasks);
};
