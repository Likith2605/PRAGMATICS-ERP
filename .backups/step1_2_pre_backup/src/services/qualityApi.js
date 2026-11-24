/**
 * API client for the embedded Quality module.
 * Talks to the ERP's Express backend at http://localhost:3001/api/quality.
 */

const BASE = String(
  import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001/api'
).replace(/\/$/, '') + '/quality';

const request = async (path, options = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Request failed (${res.status})`);
  }
  return res.json();
};

/* Drawings */
export const listDrawings = (search = '') =>
  request(`/drawings${search ? `?search=${encodeURIComponent(search)}` : ''}`);
export const getDrawing = (id) => request(`/drawings/${id}`);
export const createDrawing = (body) => request('/drawings', { method: 'POST', body });
export const updateDrawing = (id, body) => request(`/drawings/${id}`, { method: 'PUT', body });
export const deleteDrawing = (id) => request(`/drawings/${id}`, { method: 'DELETE' });

/* Dimensions */
export const listDimensions = (drawingId) => request(`/drawings/${drawingId}/dimensions`);
export const createDimension = (drawingId, body) =>
  request(`/drawings/${drawingId}/dimensions`, { method: 'POST', body });
export const updateDimension = (id, body) => request(`/dimensions/${id}`, { method: 'PUT', body });
export const deleteDimension = (id) => request(`/dimensions/${id}`, { method: 'DELETE' });

/* Checks */
export const listChecks = (drawingId = '') =>
  request(`/checks${drawingId ? `?drawing_id=${drawingId}` : ''}`);
export const getCheck = (id) => request(`/checks/${id}`);
export const createCheck = (body) => request('/checks', { method: 'POST', body });
export const updateCheck = (id, body) => request(`/checks/${id}`, { method: 'PUT', body });
export const completeCheck = (id) => request(`/checks/${id}/complete`, { method: 'PUT' });
export const deleteCheck = (id) => request(`/checks/${id}`, { method: 'DELETE' });

/* Measurements */
export const saveMeasurement = (dimensionId, body) =>
  request(`/measurements/${dimensionId}`, { method: 'PUT', body });

/* Dispatches */
export const listDispatches = () => request('/dispatches');
export const createDispatch = (body) => request('/dispatches', { method: 'POST', body });
export const deleteDispatch = (id) => request(`/dispatches/${id}`, { method: 'DELETE' });

/* Instruments */
export const listInstruments = () => request('/instruments');
export const createInstrument = (body) => request('/instruments', { method: 'POST', body });
export const deleteInstrument = (id) => request(`/instruments/${id}`, { method: 'DELETE' });

/* Import from ballooning */
export const importFromBallooning = async (projectId, drawingPdf) => {
  const result = await request(`/import/ballooning/${encodeURIComponent(projectId)}`, { method: 'POST' });
  if (!drawingPdf) return result;

  if (!result.mobileSync?.ok || result.mobileSync.skipped) {
    result.mobileSync = {
      ...result.mobileSync,
      ok: false,
      error: result.mobileSync?.error || 'Drawing metadata could not be synced to the mobile QC app.',
    };
    return result;
  }

  const form = new FormData();
  form.append('drawingNo', drawingPdf.drawingNo);
  form.append('drawingPdf', drawingPdf.blob, drawingPdf.fileName);
  try {
    const response = await fetch(`${BASE}/import/ballooning/${encodeURIComponent(projectId)}/drawing-file`, {
      method: 'POST',
      body: form,
    });
    const responseText = await response.text();
    let uploaded;
    try {
      uploaded = JSON.parse(responseText);
    } catch {
      if (response.headers.get('content-type')?.includes('text/html')) {
        throw new Error(
          'The ERP API is still running its older version. Restart the ERP API server, then send the drawing again.'
        );
      }
      throw new Error(`The ERP API returned an unreadable response (${response.status}).`);
    }
    if (!response.ok) throw new Error(uploaded.error || `PDF upload failed (${response.status})`);
    result.mobileSync = {
      ...result.mobileSync,
      ...uploaded.mobileSync,
      ok: Boolean(uploaded.mobileSync?.ok),
      drawingPdf: Boolean(uploaded.mobileSync?.ok),
      error: uploaded.mobileSync?.error,
    };
  } catch (error) {
    result.mobileSync = {
      ...result.mobileSync,
      ok: false,
      drawingPdf: false,
      error: `Drawing imported, but its PDF could not be sent to the mobile QC app: ${error.message}`,
    };
  }
  return result;
};
