/**
 * Client for the QualityApp sync server - the backend the mobile QC app
 * syncs with (normally http://localhost:4000).
 *
 * Two directions:
 *   - pushToQualityServer(): ERP -> phones. Sends ballooned drawings +
 *     dimensions using the mobile sync protocol (upsert by drawing_no /
 *     dim_no), so every connected phone receives them live (socket.io) and
 *     on its periodic sync pull.
 *   - pullFromQualityServer(): phones -> ERP. Fetches the full sync payload
 *     (checks, measurements, dispatches, instruments + tombstones) so the
 *     ERP can mirror inspection results recorded on the mobile app.
 *
 * Configuration (all optional - sensible defaults for local development):
 *   QC_SERVER_URL          e.g. http://localhost:4000 or http://192.168.1.6:4000
 *   QC_SYNC_EMPLOYEE_ID    employee used for the service login (default ADMIN)
 *   QC_SYNC_PASSWORD       password for that employee (default admin123)
 *
 * NOTE: env values are read lazily (on first use), because this module is
 * evaluated before `dotenv/config` (imported via server/database.js) has run.
 */

let cachedConfig = null;

function config() {
  if (!cachedConfig) {
    cachedConfig = {
      url: String(process.env.QC_SERVER_URL || 'http://localhost:4000').replace(/\/+$/, ''),
      employeeId: process.env.QC_SYNC_EMPLOYEE_ID || 'ADMIN',
      password: process.env.QC_SYNC_PASSWORD || 'admin123',
      timeoutMs: Number(process.env.QC_SYNC_TIMEOUT_MS || 15000),
    };
  }
  return cachedConfig;
}

let cachedToken = null;

async function qcFetch(path, { method = 'GET', token, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config().timeoutMs);
  try {
    const res = await fetch(`${config().url}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

async function login() {
  const { ok, json } = await qcFetch('/api/login', {
    method: 'POST',
    body: { employee_id: config().employeeId, password: config().password },
  });
  if (!ok || !json?.token) {
    throw new Error(json?.error || `QC server login failed (HTTP ${ok ? 'no token' : 'error'})`);
  }
  cachedToken = json.token;
  return cachedToken;
}

async function qcRequest(path, options = {}, retried = false) {
  if (!cachedToken) await login();
  const { status, ok, json } = await qcFetch(path, { ...options, token: cachedToken });
  if (status === 401 && !retried) {
    // Token no longer valid (e.g. sessions were cleared) - log in once and retry.
    cachedToken = null;
    return qcRequest(path, options, true);
  }
  if (!ok) throw new Error(json?.error || `QC server responded with HTTP ${status}`);
  return json;
}

export function getQcServerUrl() {
  return config().url;
}

/**
 * Pull the full mobile sync payload from the QC server.
 * Throws on failure (auth/network/HTTP errors).
 */
export async function pullFromQualityServer() {
  return qcRequest('/api/sync/pull');
}

/**
 * Push drawings + dimensions to the QC sync server.
 * Never throws - returns { ok, server, ... } so the ERP import can succeed
 * locally even when the mobile QC server is temporarily unreachable.
 */
export async function pushToQualityServer({ drawings = [], dimensions = [] }) {
  if (!drawings.length && !dimensions.length) {
    return { ok: true, server: getQcServerUrl(), drawings: 0, dimensions: 0, skipped: true };
  }
  try {
    await qcRequest('/api/sync/push', {
      method: 'POST',
      body: { drawings, dimensions },
    });
    console.log(
      `[QC-SYNC] Pushed ${drawings.length} drawing(s), ${dimensions.length} dimension(s) to ${getQcServerUrl()}`
    );
    return { ok: true, server: getQcServerUrl(), drawings: drawings.length, dimensions: dimensions.length };
  } catch (err) {
    console.log(`[QC-SYNC] Push to mobile QC server (${getQcServerUrl()}) failed: ${err.message}`);
    return { ok: false, server: getQcServerUrl(), error: err.message };
  }
}

/**
 * Upload a drawing attachment after its drawing record has been synced.
 * The mobile app downloads files exposed as /uploads/... during sync.
 */
export async function uploadDrawingToQualityServer({ drawing_no, filename, data }) {
  try {
    const result = await qcRequest('/api/upload', {
      method: 'POST',
      body: { drawing_no, filename, data },
    });
    console.log(`[QC-SYNC] Uploaded ${filename} for drawing ${drawing_no} to ${getQcServerUrl()}`);
    return { ok: true, server: getQcServerUrl(), drawing_no, filename, url: result?.url };
  } catch (err) {
    console.log(`[QC-SYNC] PDF upload to mobile QC server (${getQcServerUrl()}) failed: ${err.message}`);
    return { ok: false, server: getQcServerUrl(), error: err.message };
  }
}
