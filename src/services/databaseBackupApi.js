import { authHeaders } from '../utils/auth.js';

const apiBase = () => {
  if (typeof window !== 'undefined' && window.location?.port === '5173') {
    return `http://${window.location.hostname || 'localhost'}:3001/api`;
  }
  return '/api';
};

const request = async (path, options = {}) => {
  const response = await fetch(`${apiBase()}/database-backups${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `PostgreSQL backup request failed (${response.status}).`);
  return body;
};

export const getDatabaseBackupStatus = () => request('/status');
export const listDatabaseBackups = async () => (await request('/')).records || [];
export const createDatabaseBackup = async () => (await request('/', { method: 'POST' })).backup;
export const verifyDatabaseBackup = async (id) => (
  await request(`/${encodeURIComponent(id)}/verify`, { method: 'POST' })
).backup;

export const downloadDatabaseBackup = async (id) => {
  const response = await fetch(`${apiBase()}/database-backups/${encodeURIComponent(id)}/download`, {
    headers: authHeaders()
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `PostgreSQL backup download failed (${response.status}).`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `erp-postgres-backup-${id}.dump`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

export const restoreDatabaseBackup = (id, payload) => request(`/${encodeURIComponent(id)}/restore`, {
  method: 'POST',
  body: JSON.stringify(payload)
});
