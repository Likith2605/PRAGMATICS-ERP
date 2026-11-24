/**
 * Workflow document attachments
 * (Tax Invoices, Delivery Challans, inspection photos, rejection documents).
 *
 * Metadata lives on the owning record (materialReceipts / qualityChecks /
 * rejectionReports); the binary payload is cached in IndexedDB so localStorage
 * quota is never exhausted, and mirrored to PostgreSQL (`file_blobs` via
 * /api/files) so database backups capture every attachment. On a local cache
 * miss the file is fetched from the server and re-cached.
 */

import { putFile, getFile, deleteFile } from '../services/fileApi.js';

const DB_NAME = 'WorkflowFilesDB';
const DB_VERSION = 1;
const STORE_NAME = 'workflowFiles';

const openDB = () =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export const createDocumentId = () =>
  `wfdoc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const saveWorkflowDocument = async (file) => {
  const id = createDocumentId();
  const meta = {
    id,
    name: file.name || 'document',
    type: file.type || 'application/octet-stream',
    size: file.size || 0,
    uploadedAt: new Date().toISOString()
  };
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(file, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Fire-and-forget: local cache succeeded; push the authoritative copy.
  putFile(id, file, { fileName: meta.name, mimeType: meta.type, scope: 'workflow', metadata: meta })
    .catch((error) => console.warn(`Workflow document '${id}' not yet saved to PostgreSQL:`, error.message));

  return meta;
};

export const getWorkflowDocument = async (id) => {
  try {
    const db = await openDB();
    const cached = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (cached) return cached;
  } catch {
    /* IndexedDB unavailable — fall through to the server copy. */
  }

  // Local cache miss (new browser / restored backup) — pull from PostgreSQL.
  try {
    const blob = await getFile(id);
    if (!blob) return null;
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return blob;
  } catch (error) {
    console.warn('Workflow document fetch from PostgreSQL failed:', error.message);
    return null;
  }
};

export const deleteWorkflowDocument = async (id) => {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore – storage unavailable */
  }
  deleteFile(id).catch(() => {});
};

export const openWorkflowDocument = async (doc) => {
  if (!doc?.id) return;
  try {
    const blob = await getWorkflowDocument(doc.id);
    if (!blob) {
      window.open(`about:blank`);
      return;
    }
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    console.error('Failed to open workflow document', err);
  }
};
