/**
 * Quality module data bridge.
 *
 * Reads inspection data from the QualityApp server (Express + SQLite) and
 * assembles the exact report payloads the mobile app builds in
 * `src/db/repo.ts` (getCheckReport / getDrawingReport / getDispatch), so the
 * ERP renders byte-identical reports.
 *
 * Server contract (D:\QualityApp\server\index.js):
 *   POST /api/login      { employee_id, password } -> { token, employee }
 *   GET  /api/sync/pull  Authorization: Bearer <token> -> full dataset
 */

const SETTINGS_KEY = 'qc_server_settings';
const SESSION_KEY = 'qc_server_session';
const SNAPSHOT_KEY = 'qc_server_snapshot';

const REQUEST_TIMEOUT_MS = 15000;

const getQualityAppHost = () => {
  if (typeof window !== 'undefined' && window.location?.hostname) {
    return window.location.hostname;
  }
  return 'localhost';
};

export const DEFAULT_SERVER_URL = `http://${getQualityAppHost()}:4000`;

/**
 * The QualityApp server binds to PORT (default 4000) and silently walks up to
 * the next free port when that one is taken, so a second instance lands on
 * 4001 / 4002. These are probed in order when the configured URL is not
 * answering.
 */
const FALLBACK_PORTS = [4000, 4001, 4002];

/* ------------------------------------------------------------------ */
/* Settings / session                                                  */
/* ------------------------------------------------------------------ */

const readJson = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

const dropKey = (key) => {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
};

export const getSettings = () => {
  const stored = readJson(SETTINGS_KEY);
  if (stored) {
    if (typeof window !== 'undefined' && window.location?.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      try {
        const parsed = new URL(stored.url);
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
          stored.url = `${parsed.protocol}//${window.location.hostname}:${parsed.port || 4000}`;
        }
      } catch {
        /* ignore invalid URL */
      }
    }
    return stored;
  }
  return { url: DEFAULT_SERVER_URL, employee_id: '', password: '' };
};

export const saveSettings = (settings) => {
  writeJson(SETTINGS_KEY, settings);
  return settings;
};

export const getSession = () => readJson(SESSION_KEY);
export const getSnapshot = () => readJson(SNAPSHOT_KEY);

const normalizeUrl = (url) => String(url || '').trim().replace(/\/+$/, '');

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

async function request(url, path, { method = 'GET', token, body } = {}) {
  const base = normalizeUrl(url);
  if (!base) throw new Error('Server URL is required.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON response */
    }

    if (!response.ok) {
      const failure = new Error(data?.error || `Request failed (${response.status}).`);
      failure.status = response.status;
      throw failure;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Server is not connected');
    }
    // fetch() rejects with a TypeError when the host is unreachable, refuses
    // the connection, or the URL is wrong.
    if (error instanceof TypeError) {
      throw new Error('Server is not connected');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const checkHealth = async (url) => {
  const data = await request(url, '/api/health');
  return Boolean(data?.ok ?? data?.status === 'ok');
};

const withPort = (url, port) => {
  try {
    const parsed = new URL(normalizeUrl(url));
    return `${parsed.protocol}//${parsed.hostname}:${port}`;
  } catch {
    return `http://${getQualityAppHost()}:${port}`;
  }
};

/**
 * Finds a reachable QualityApp server, trying the configured URL first and then
 * the ports the server may have fallen back to. Returns null when none answer.
 */
export const discoverServer = async (url) => {
  const candidates = [normalizeUrl(url), ...FALLBACK_PORTS.map((port) => withPort(url, port))];
  const tried = new Set();

  for (const candidate of candidates) {
    if (!candidate || tried.has(candidate)) continue;
    tried.add(candidate);
    try {
      if (await checkHealth(candidate)) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
};

/* ------------------------------------------------------------------ */
/* Connect / refresh                                                   */
/* ------------------------------------------------------------------ */

const loginTo = async (base, employee_id, password) => {
  const session = await request(base, '/api/login', {
    method: 'POST',
    body: { employee_id, password }
  });
  if (!session?.token) throw new Error('Login did not return a token.');
  return session;
};

export const connect = async ({ url, employee_id, password }) => {
  const configured = normalizeUrl(url);
  if (!configured) throw new Error('Server URL is required.');
  if (!employee_id || !password) throw new Error('Employee ID and password are required.');

  const user = String(employee_id).trim();
  const secret = String(password);

  let base = configured;
  let session;
  try {
    session = await loginTo(base, user, secret);
  } catch (error) {
    // The server moves to the next free port when the configured one is taken,
    // so look for it before giving up.
    if (error instanceof TypeError || /not connected/i.test(error.message)) {
      const found = await discoverServer(configured);
      if (!found) throw error;
      session = await loginTo(found, user, secret);
      base = found;
    } else {
      throw error;
    }
  }

  const saved = { url: base, employee_id: user, password: secret };
  saveSettings(saved);
  writeJson(SESSION_KEY, { token: session.token, employee: session.employee || null, url: base });

  const snapshot = await request(base, '/api/sync/pull', { token: session.token });
  writeJson(SNAPSHOT_KEY, snapshot);

  return { session: readJson(SESSION_KEY), snapshot };
};

export const disconnect = async () => {
  const session = getSession();
  if (session?.token && session.url) {
    try {
      await request(session.url, '/api/logout', { method: 'POST', token: session.token });
    } catch {
      /* server may be offline - clearing locally is enough */
    }
  }
  dropKey(SESSION_KEY);
  dropKey(SNAPSHOT_KEY);
};

export const refreshSnapshot = async () => {
  const session = getSession();
  if (!session?.token) throw new Error('Not connected to the quality server.');
  const snapshot = await request(session.url, '/api/sync/pull', { token: session.token });
  writeJson(SNAPSHOT_KEY, snapshot);
  return snapshot;
};

/* ------------------------------------------------------------------ */
/* Snapshot assembly                                                   */
/* ------------------------------------------------------------------ */

const emptySnapshot = () => ({
  employees: [],
  drawings: [],
  dimensions: [],
  checks: [],
  measurements: [],
  dispatches: [],
  instruments: []
});

const index = (list) => new Map((list || []).map((row) => [row.id, row]));

const DRAWING_FIELDS = [
  'drawing_no',
  'part_name',
  'customer',
  'revision',
  'material',
  'unit',
  'invoice_no',
  'invoice_date',
  'drawing_rev_date',
  'po_no',
  'qty',
  'treatment',
  'hardness'
];

const enrichCheck = (check, employees, drawings) => {
  const employee = employees.get(check.checked_by);
  const drawing = drawings.get(check.drawing_id) || {};
  const enriched = {
    ...check,
    inspector_employee_name: employee?.name ?? '',
    inspector_employee_id: employee?.employee_id ?? ''
  };
  for (const field of DRAWING_FIELDS) {
    enriched[field] = drawing[field] ?? '';
  }
  return enriched;
};

const buildRow = (measurement, dimensions, checksById, employees) => {
  const dimension = dimensions.get(measurement.dimension_id) || {};
  const check = checksById.get(measurement.check_id) || {};
  const employee = employees.get(check.checked_by);
  return {
    ...measurement,
    dim_no: dimension.dim_no ?? 0,
    description: dimension.description ?? '',
    nominal: dimension.nominal ?? 0,
    nominal_text: dimension.nominal_text ?? '',
    tol_upper: dimension.tol_upper ?? 0,
    tol_lower: dimension.tol_lower ?? 0,
    checked_at: check.checked_at ?? '',
    inspector_name: check.inspector_name ?? '',
    inspector_employee_name: employee?.name ?? ''
  };
};

/**
 * Mirrors SQL `ORDER BY c.checked_at DESC, c.id DESC, m.id DESC`.
 * checked_at is a fixed-width 'YYYY-MM-DD HH:MM:SS' string, so a plain string
 * comparison reproduces SQLite's TEXT ordering exactly.
 */
const newestFirst = (a, b) => {
  if (a.checked_at !== b.checked_at) return a.checked_at < b.checked_at ? 1 : -1;
  if (a.check_id !== b.check_id) return (b.check_id ?? 0) - (a.check_id ?? 0);
  return (b.id ?? 0) - (a.id ?? 0);
};

const latestPerDimension = (rows) => {
  const best = new Map();
  for (const row of rows) {
    const current = best.get(row.dimension_id);
    if (!current || newestFirst(row, current) < 0) best.set(row.dimension_id, row);
  }
  return [...best.values()].sort((a, b) => a.dim_no - b.dim_no);
};

const reportDimensions = (drawingId, dimensions, measurements, checkIdsByDrawing) => {
  return dimensions
    .filter((dimension) => dimension.drawing_id === drawingId)
    .sort((a, b) => a.dim_no - b.dim_no)
    .map((dimension) => {
      const checked = measurements.some((measurement) => {
        if (measurement.dimension_id !== dimension.id) return false;
        const allowed = checkIdsByDrawing.get(dimension.drawing_id);
        return allowed ? allowed.has(measurement.check_id) : true;
      });
      return {
        id: dimension.id,
        dim_no: dimension.dim_no,
        description: dimension.description,
        nominal: dimension.nominal,
        nominal_text: dimension.nominal_text,
        tol_upper: dimension.tol_upper,
        tol_lower: dimension.tol_lower,
        checked
      };
    });
};

const enrichDispatch = (dispatch, employees) => {
  const employee = employees.get(dispatch.dispatched_by);
  return {
    ...dispatch,
    dispatcher_name: employee?.name ?? '',
    dispatcher_employee_id: employee?.employee_id ?? ''
  };
};

/* ------------------------------------------------------------------ */
/* Public lists                                                        */
/* ------------------------------------------------------------------ */

export const listChecks = () => {
  const data = { ...emptySnapshot(), ...(getSnapshot() || {}) };
  const employees = index(data.employees);
  const drawings = index(data.drawings);
  return (data.checks || [])
    .map((check) => enrichCheck(check, employees, drawings))
    .sort((a, b) => String(b.checked_at).localeCompare(String(a.checked_at)) || b.id - a.id);
};

export const listDrawings = () => {
  const data = { ...emptySnapshot(), ...(getSnapshot() || {}) };
  return [...(data.drawings || [])].sort((a, b) =>
    String(a.drawing_no).localeCompare(String(b.drawing_no))
  );
};

export const listDispatches = () => {
  const data = { ...emptySnapshot(), ...(getSnapshot() || {}) };
  const employees = index(data.employees);
  return (data.dispatches || [])
    .map((dispatch) => enrichDispatch(dispatch, employees))
    .sort((a, b) => String(b.dispatched_at).localeCompare(String(a.dispatched_at)) || b.id - a.id);
};

/* ------------------------------------------------------------------ */
/* Report payloads (mirrors repo.ts)                                   */
/* ------------------------------------------------------------------ */

export const buildCheckReport = (checkId) => {
  const data = { ...emptySnapshot(), ...(getSnapshot() || {}) };
  const employees = index(data.employees);
  const drawings = index(data.drawings);
  const dimensions = index(data.dimensions);
  const checksById = index(data.checks);

  const rawCheck = checksById.get(Number(checkId));
  if (!rawCheck) return null;

  const check = enrichCheck(rawCheck, employees, drawings);
  const drawingId = rawCheck.drawing_id;

  const checkIdsByDrawing = new Map();
  for (const entry of data.checks || []) {
    if (!checkIdsByDrawing.has(entry.drawing_id)) checkIdsByDrawing.set(entry.drawing_id, new Set());
    checkIdsByDrawing.get(entry.drawing_id).add(entry.id);
  }

  const rows = latestPerDimension(
    (data.measurements || [])
      .filter((measurement) => checksById.get(measurement.check_id)?.drawing_id === drawingId)
      .map((measurement) => buildRow(measurement, dimensions, checksById, employees))
  );

  const dims = reportDimensions(drawingId, data.dimensions || [], data.measurements || [], checkIdsByDrawing);

  return { check, rows, dims };
};

export const buildDrawingReport = (drawingId) => {
  const data = { ...emptySnapshot(), ...(getSnapshot() || {}) };
  const id = Number(drawingId);
  const employees = index(data.employees);
  const drawings = index(data.drawings);
  const dimensions = index(data.dimensions);
  const checksById = index(data.checks);

  const drawing = drawings.get(id);
  if (!drawing) return null;

  const checks = (data.checks || [])
    .filter((entry) => entry.drawing_id === id)
    .map((entry) => enrichCheck(entry, employees, drawings))
    .sort(
      (a, b) => String(a.checked_at).localeCompare(String(b.checked_at)) || a.id - b.id
    );

  const rows = latestPerDimension(
    (data.measurements || [])
      .filter((measurement) => checksById.get(measurement.check_id)?.drawing_id === id)
      .map((measurement) => buildRow(measurement, dimensions, checksById, employees))
  );

  const dims = reportDimensions(id, data.dimensions || [], data.measurements || [], new Map());

  return { drawing, checks, rows, dims };
};

export const buildDispatchReport = (dispatchId) => {
  const data = { ...emptySnapshot(), ...(getSnapshot() || {}) };
  const employees = index(data.employees);
  const dispatch = (data.dispatches || []).find((entry) => entry.id === Number(dispatchId));
  if (!dispatch) return null;
  return enrichDispatch(dispatch, employees);
};
