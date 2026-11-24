/**
 * Project-tagged drawing lookups.
 *
 * The Enquiry / Project Request screen stores the drawing PDF in IndexedDB
 * under `${projectId}::${drawingNo}` (drawingStorage.js) and keeps only the
 * file name on the enquiry record (items[].drawingFileName). Any screen that
 * lets the user choose a Project ID can therefore auto-fetch the drawing
 * instead of asking for another upload:
 *
 *   getDrawingInfo(projectId, drawingNo) -> { found, drawingNo, fileName, dataUrl }
 *   openDrawing(projectId, drawingNo)    -> opens the PDF (alert when missing)
 *   attachDrawing(projectId, drawingNo)  -> copies the PDF into WorkflowFilesDB
 *                                           and returns the attachment meta, so
 *                                           the file travels with the record
 *
 * A project may hold several drawings; callers pick the drawing number from
 * the enquiry lines (or the header field they already auto-filled).
 */
import { getDrawing } from './drawingStorage.js';
import { viewDrawingFile } from './fileViewer.js';
import { saveWorkflowDocument } from './workflowFiles.js';

/** File name recorded on the enquiry item (localStorage fallback for the name). */
const enquiryFileName = (projectId, drawingNo) => {
  try {
    const projects = JSON.parse(localStorage.getItem('projectRequests') || '[]');
    const project = projects.find((p) => String(p.projectId) === String(projectId));
    const item = (project?.items || []).find(
      (i) => String(i.drawingNo || '').trim() === String(drawingNo || '').trim()
    );
    return item?.drawingFileName || '';
  } catch {
    return '';
  }
};

export const getDrawingInfo = async (projectId, drawingNo) => {
  const pid = String(projectId || '').trim();
  const dwg = String(drawingNo || '').trim();
  const empty = { found: false, projectId: pid, drawingNo: dwg, fileName: '', dataUrl: '' };
  if (!pid || !dwg) return empty;
  let dataUrl = '';
  try {
    dataUrl = (await getDrawing(pid, dwg)) || '';
  } catch (err) {
    console.error('Drawing lookup failed', err);
  }
  if (!dataUrl) return empty;
  return {
    found: true,
    projectId: pid,
    drawingNo: dwg,
    fileName: enquiryFileName(pid, dwg) || `${dwg}.pdf`,
    dataUrl
  };
};

/** Open the stored drawing PDF; explains where to upload it when missing. */
export const openDrawing = async (projectId, drawingNo) => {
  const info = await getDrawingInfo(projectId, drawingNo);
  if (!info.found) {
    window.alert(
      `No drawing PDF found for ${drawingNo || 'this project'}. Upload it from the Enquiry / Project Request screen.`
    );
    return false;
  }
  viewDrawingFile(info.dataUrl, info.fileName);
  return true;
};

const dataUrlToFile = (dataUrl, fileName) => {
  const parts = String(dataUrl).split(',');
  const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'application/pdf';
  const binary = atob(parts[1] || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName || 'drawing.pdf', { type: mime });
};

/** Turn a stored drawing data-URL into an uploadable File. */
export const drawingToFile = (dataUrl, fileName) => dataUrlToFile(dataUrl, fileName);

/**
 * Copy the enquiry drawing into the workflow attachment store so it is saved
 * on the record (requirement, job card, …) like a manually uploaded file.
 * Returns the attachment meta, or null when nothing is stored for the pair.
 */
export const attachDrawing = async (projectId, drawingNo) => {
  const info = await getDrawingInfo(projectId, drawingNo);
  if (!info.found) return null;
  try {
    const file = dataUrlToFile(info.dataUrl, info.fileName);
    const meta = await saveWorkflowDocument(file);
    return { ...meta, source: 'enquiry drawing', drawingNo: info.drawingNo, projectId: info.projectId };
  } catch (err) {
    console.error('Could not attach the enquiry drawing', err);
    return null;
  }
};

/** True when the given attachment list already carries this auto-fetched drawing. */
export const hasEnquiryDrawing = (attachments, drawingNo) =>
  (attachments || []).some(
    (d) => d && d.source === 'enquiry drawing' && String(d.drawingNo) === String(drawingNo)
  );
