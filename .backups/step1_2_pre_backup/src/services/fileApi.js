/**
 * File storage client for /api/files (PostgreSQL `file_blobs` table).
 *
 * Used by drawingStorage.js and workflowFiles.js so every attachment is
 * mirrored to the database while IndexedDB remains the fast local cache.
 * All server failures degrade gracefully: the local cache keeps working and
 * callers can re-attempt later (the next read refreshes from PostgreSQL).
 */

const API_BASE = String(
    import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api').replace(/\/$/, '');

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
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
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
export const putFile = async(id, blob, { fileName, mimeType, scope, metadata } = {}) => {
    const contentBase64 = await blobToBase64(blob);
    const payload = await request(`/files/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({
            fileName: fileName || (blob && blob.name) || 'document',
            mimeType: mimeType || (blob && blob.type) || 'application/octet-stream',
            scope: scope || 'generic',
            metadata: metadata || {},
            contentBase64
        })
    });
    return payload.file;
};

/** Downloads a file from PostgreSQL. Returns a Blob or null when missing. */
export const getFile = async(id) => {
    try {
        const payload = await request(`/files/${encodeURIComponent(id)}`);
        if (!payload?.contentBase64) return null;
        return base64ToBlob(payload.contentBase64, payload.mimeType);
    } catch (error) {
        if (String(error.message).includes('not found')) return null;
        throw error;
    }
};

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
