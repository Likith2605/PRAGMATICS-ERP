/**
 * File storage client for /api/files (PostgreSQL `file_blobs` table).
 *
 * Used by drawingStorage.js and workflowFiles.js so every attachment is
 * mirrored to the database while IndexedDB remains the fast local cache.
 * Server failures are surfaced so missing or unauthorized files cannot appear
 * as successful empty previews.
 */

const getApiBase = () => {
    if (typeof window !== 'undefined' && window.location) {
        if (window.location.port === '5173') {
            return `http://${window.location.hostname || 'localhost'}:3001/api`;
        }
        return '/api';
    }
    return String(import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api');
};

const API_BASE = String(getApiBase()).replace(/\/$/, '');

const REQUEST_TIMEOUT_MS = 30000;

const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result || '');
            const comma = dataUrl.indexOf(',');
            resolve(comma >= 0 ? dataUrl.slice(comma + 1) : '');
        };
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
        reader.readAsDataURL(blob);
    });

const base64ToBlob = (b64, mimeType) => {
    const binary = atob(String(b64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
};

const request = async(path, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${API_BASE}${path}`, {
            ...options,
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `File request failed (${response.status})`);
        return payload;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Uploads a Blob/File to PostgreSQL. Returns the stored metadata.
 * Throws on failure — callers treat it as "server copy pending".
 */
export const putFile = async(id, blob, { fileName, mimeType, scope, metadata, ifAbsent = false } = {}) => {
    const contentBase64 = await blobToBase64(blob);
    const payload = await request(`/files/${encodeURIComponent(id)}`, {
        method: 'PUT',
    body: JSON.stringify({
            fileName: fileName || (blob && blob.name) || 'document',
            mimeType: mimeType || (blob && blob.type) || 'application/octet-stream',
            scope: scope || 'generic',
            metadata: metadata || {},
        contentBase64,
        ifAbsent
        })
    });
    return payload.file;
};

/** Downloads a file from PostgreSQL. Returns a Blob or null when missing. */
export const getFileWithMetadata = async(id) => {
    try {
        const payload = await request(`/files/${encodeURIComponent(id)}`);
        if (typeof payload?.contentBase64 !== 'string') return null;
        const blob = base64ToBlob(payload.contentBase64, payload.mimeType);
        return {
            blob,
            id: payload.id,
            fileName: payload.fileName || '',
            mimeType: payload.mimeType || blob.type,
            metadata: payload.metadata || {},
            checksumSha256: payload.checksumSha256,
            sizeBytes: payload.sizeBytes
        };
    } catch (error) {
        if (String(error.message).includes('not found')) return null;
        throw error;
    }
};

/** Retrieves authenticated binary content with its persisted file metadata. */
export const getFileContentWithMetadata = async(id) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${API_BASE}/files/${encodeURIComponent(id)}/content`, {
            signal: controller.signal,
            headers: authHeaders()
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            if (response.status === 404) return null;
            throw new Error(payload.error || `File request failed (${response.status})`);
        }

        const blob = await response.blob();
        const encodedMetadata = response.headers.get('x-file-metadata') || '';
        let metadata;
        try {
            const base64 = encodedMetadata.replace(/-/g, '+').replace(/_/g, '/');
            const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (character) => character.charCodeAt(0));
            metadata = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            throw new Error('File response metadata is invalid.');
        }
        return {
            blob,
            id: response.headers.get('x-file-id') || '',
            metadata,
            checksumSha256: response.headers.get('x-file-checksum-sha256') || null,
            sizeBytes: Number(response.headers.get('x-file-size-bytes') || blob.size)
        };
    } finally {
        clearTimeout(timer);
    }
};

export const getMissingChecksumInventory = ({ limit = 100, offset = 0 } = {}) =>
    request(`/files/integrity/checksum-review/inventory?limit=${limit}&offset=${offset}`);

export const getFileChecksumReview = (id) =>
    request(`/files/integrity/checksum-review/${encodeURIComponent(id)}`);

export const confirmFileChecksum = (id, verification) => request(
    `/files/integrity/checksum-review/${encodeURIComponent(id)}/verify`,
    { method: 'POST', body: JSON.stringify(verification) }
);

export const getFile = async(id) => (await getFileWithMetadata(id))?.blob || null;

/** Removes the server copy. Missing files resolve without error. */
export const deleteFile = async(id) => {
    try {
        await request(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
        return true;
    } catch {
        return false;
    }
};

export { blobToBase64, base64ToBlob };
import { authHeaders } from '../utils/auth.js';
