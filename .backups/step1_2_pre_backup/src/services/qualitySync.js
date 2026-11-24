import { getSession, getSettings, DEFAULT_SERVER_URL } from '../quality/qualityApi.js';
import api from './ballooningApi';

/**
 * Pushes a completed ballooning project (drawing + dimensions) to the
 * QualityApp server, so quality checking continues on the mobile app.
 *
 * Requires an active QualityApp session (configured on the Quality Report page).
 */

const request = async (base, path, options = {}) => {
  const session = getSession();
  const token = session?.token;

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Request ${path} failed (${res.status}): ${text}`);
  }

  return res.json();
};

/** Get the QualityApp base URL from settings or fallback. */
const getBaseUrl = () => {
  const settings = getSettings();
  return settings?.serverUrl || DEFAULT_SERVER_URL;
};

/** Convert a balloon value string like "Ø 7.2" to a numeric nominal. */
const parseNominal = (valueStr) => {
  if (!valueStr) return 0;
  const cleaned = String(valueStr).replace(/[^\d.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
};

/** Convert a tolerance string like "0.05" to a positive numeric. */
const parseTolerance = (tolStr, sign = 1) => {
  if (!tolStr) return 0;
  const cleaned = String(tolStr).replace(/[^\d.\-]/g, '');
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return 0;
  // tol_upper is always positive, tol_lower is always negative (or zero)
  return sign > 0 ? Math.abs(n) : -Math.abs(n);
};

/**
 * Push a single drawing (and all its balloons/characteristics) to QualityApp.
 *
 * @param {Object} params
 * @param {string} params.projectId   - ERP ballooning project ID
 * @param {string} params.drawingId   - ERP drawing ID
 * @param {Object} params.project     - project record (drawingNumber, partName, customerName, revision, material, etc.)
 * @param {Object} params.drawing     - drawing record
 * @param {Array}  params.characteristics - array of characteristic/balloon records
 * @returns {Object} { ok, drawingId, message, dimensions }
 */
export const pushDrawingToQualityApp = async ({ projectId, drawingId, project, drawing, characteristics }) => {
  const baseUrl = getBaseUrl();
  const session = getSession();

  if (!session?.token) {
    return {
      ok: false,
      message: 'Not connected to QualityApp server. Open the Quality Report page and connect first.',
    };
  }

  // 1. Create (or upsert) the drawing on QualityApp server.
  const drawingPayload = {
    drawing_no: drawing?.drawingNumber || project?.drawingNumber || '',
    part_name: drawing?.partName || project?.partName || '',
    customer: project?.customerName || '',
    revision: project?.revision || '',
    material: project?.material || '',
    unit: project?.unit || 'mm',
    notes: project?.remarks || '',
  };

  if (!drawingPayload.drawing_no) {
    return { ok: false, message: 'Drawing number is missing. Cannot push to QualityApp.' };
  }

  let qcDrawing;
  try {
    const result = await request(baseUrl, '/api/drawings', {
      method: 'POST',
      body: drawingPayload,
    });
    qcDrawing = result?.drawing || result;
    if (!qcDrawing?.id) {
      return { ok: false, message: 'Server did not return a drawing ID.' };
    }
  } catch (err) {
    return { ok: false, message: `Failed to create drawing on QualityApp: ${err.message}` };
  }

  // 2. Push each characteristic as a dimension.
  const dims = (characteristics || [])
    .filter((c) => c.drawingId === drawingId || !c.drawingId)
    .sort((a, b) => (a.number || 0) - (b.number || 0));

  if (dims.length === 0) {
    return {
      ok: true,
      drawingId: qcDrawing.id,
      message: 'Drawing sent, but there were no dimensions to push.',
      dimensions: 0,
    };
  }

  let pushed = 0;
  const errors = [];

  for (const char of dims) {
    const dimPayload = {
      dim_no: char.number || 0,
      description: char.specification || char.remarks || '',
      nominal: parseNominal(char.value),
      nominal_text: char.value || char.specification || '',
      tol_upper: parseTolerance(char.plusTolerance, 1),
      tol_lower: parseTolerance(char.minusTolerance, -1),
    };

    try {
      await request(baseUrl, `/api/drawings/${qcDrawing.id}/dimensions`, {
        method: 'POST',
        body: dimPayload,
      });
      pushed++;
    } catch (err) {
      errors.push(`Dim ${dimPayload.dim_no}: ${err.message}`);
    }
  }

  const message = errors.length > 0
    ? `Pushed ${pushed}/${dims.length} dimensions. Errors: ${errors.join('; ')}`
    : `Successfully pushed drawing and ${pushed} dimensions to QualityApp.`;

  return {
    ok: pushed > 0,
    drawingId: qcDrawing.id,
    message,
    dimensions: pushed,
  };
};

/**
 * Push an entire ballooning project (all drawings + their balloons) to QualityApp.
 *
 * @param {string} projectId - ERP ballooning project ID
 * @returns {Object} { ok, results: [{ drawingId, ok, message, dimensions }] }
 */
export const pushProjectToQualityApp = async (projectId) => {
  const session = getSession();
  if (!session?.token) {
    return {
      ok: false,
      results: [],
      message: 'Not connected to QualityApp server. Open the Quality Report page and connect first.',
    };
  }

  // Load project data from ballooning store.
  const project = await api.get(`/projects/${projectId}`);
  const drawings = await api.get(`/projects/${projectId}/drawings`).catch(() => []);

  const results = [];

  for (const drawing of drawings) {
    // Get characteristics (balloons with dimension data) for this drawing.
    const characteristics = await api
      .get(`/projects/${projectId}/characteristics?drawingId=${drawing._id}`)
      .catch(() => []);

    const drawingChars = characteristics.filter((c) => c.drawingId === drawing._id);

    const result = await pushDrawingToQualityApp({
      projectId,
      drawingId: drawing._id,
      project,
      drawing,
      characteristics: drawingChars,
    });

    results.push({ drawingId: drawing._id, ...result });
  }

  if (results.length === 0) {
    return { ok: false, results, message: 'No drawings found in this project.' };
  }

  const okCount = results.filter((r) => r.ok).length;
  return {
    ok: okCount > 0,
    results,
    message: `Pushed ${okCount}/${results.length} drawings to QualityApp.`,
  };
};
