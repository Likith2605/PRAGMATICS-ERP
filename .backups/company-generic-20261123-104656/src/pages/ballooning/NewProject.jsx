import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/ballooningApi';
import { getAllProjectsSummary, getFullProjectData } from '../../utils/projectTracker';
import { getDrawingInfo, openDrawing, drawingToFile } from '../../utils/drawingLookup';

export default function NewProject() {
  const navigate = useNavigate();
  const fileRef = useRef(null);

  const [projectList, setProjectList] = useState([]);
  const [availableDrawingNumbers, setAvailableDrawingNumbers] = useState([]);

  const [form, setForm] = useState({
    projectId: '',
    drawingNumber: '',
    partName: '',
    customerName: '',
    revision: '',
    drawingDate: '',
    material: '',
    customerPO: '',
    remarks: ''
  });

  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  /* File the user picked on the upload field (an empty choice falls back to the
     enquiry drawing stored for the selected Project ID + Drawing No). */
  const [userFile, setUserFile] = useState('');

  /* Drawing PDF stored with the Enquiry for the chosen Project ID + Drawing No. */
  const [enquiryDrawing, setEnquiryDrawing] = useState(null);

  useEffect(() => {
    const pid = form.projectId;
    const dwg = form.drawingNumber;
    if (!pid || !dwg) {
      setEnquiryDrawing(null);
      return undefined;
    }
    let alive = true;
    (async () => {
      let info = { found: false, drawingNo: dwg, fileName: '', dataUrl: '' };
      try {
        info = await getDrawingInfo(pid, dwg);
      } catch (error) {
        console.error('Drawing auto-fetch failed', error);
      }
      if (!alive) return;
      setEnquiryDrawing({
        found: info.found,
        drawingNo: info.drawingNo,
        fileName: info.fileName,
        file: info.found ? drawingToFile(info.dataUrl, info.fileName) : null
      });
    })();
    return () => {
      alive = false;
    };
  }, [form.projectId, form.drawingNumber]);

  useEffect(() => {
    try {
      setProjectList(getAllProjectsSummary() || []);
    } catch (error) {
      console.error('Unable to load projects', error);
      setProjectList([]);
    }
  }, []);

  const set = (field) => (e) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleProjectIdChange = (e) => {
    const selectedProjectId = e.target.value;
    const summary = projectList.find((p) => p.projectId === selectedProjectId);
    const fullData = selectedProjectId ? getFullProjectData(selectedProjectId) : null;

    const drawings = (fullData?.items || summary?.items || [])
      .map((item) => item.drawingNo)
      .filter((dn) => dn && dn.trim());

    setAvailableDrawingNumbers(drawings);

    const firstItem = (fullData?.items || summary?.items || [])[0] || null;

    setForm((prev) => ({
      ...prev,
      projectId: selectedProjectId,
      drawingNumber: '',
      partName: firstItem?.itemName || '',
      material: firstItem?.materialSpec || firstItem?.material || '',
      customerName:
        fullData?.customerDetails?.customerName ||
        fullData?.customerDetails?.companyName ||
        summary?.customerName ||
        summary?.companyName ||
        '',
      customerPO: fullData?.customerPoNumber || summary?.customerPoNumber || '',
      remarks: fullData?.projectRequest?.engineeringNotes || prev.remarks
    }));
  };

  const handleDrawingNumberChange = (e) => {
    const selectedDrawingNo = e.target.value;
    setForm((prev) => ({ ...prev, drawingNumber: selectedDrawingNo }));

    const fullData = getFullProjectData(form.projectId);
    const items = fullData?.items || [];
    const matchedItem = items.find(
      (item) => item.drawingNo === selectedDrawingNo
    );

    if (matchedItem) {
      setForm((prev) => ({
        ...prev,
        partName: matchedItem.itemName || prev.partName,
        material: matchedItem.materialSpec || matchedItem.material || prev.material
      }));
      return;
    }

    /* Selection cleared → fall back to the project's first item. */
    if (!selectedDrawingNo) {
      const firstItem = items[0] || null;
      setForm((prev) => ({
        ...prev,
        partName: firstItem?.itemName || '',
        material: firstItem?.materialSpec || firstItem?.material || ''
      }));
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');

    try {
      const project = await api.post('/projects', {
        ...form,
        createdBy: 'Admin User'
      });

      const file = fileRef.current?.files?.[0] || enquiryDrawing?.file || null;

      if (file) {
        const formData = new FormData();
        formData.append('drawing', file);
        formData.append('drawingNo', form.drawingNumber || '');
        await api.upload(`/projects/${project._id}/drawing`, formData);
      }

      setMessage(
        file && !fileRef.current?.files?.[0]
          ? 'Project saved — enquiry drawing attached automatically'
          : 'Project saved'
      );

      navigate(`/ballooning/project/${project._id}`);
    } catch (error) {
      setMessage(error.message || 'Failed to save project');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Create New Inspection Project</h1>
      </div>

      {message ? <div className="mb-4 rounded bg-slate-50 p-3 text-slate-700">{message}</div> : null}

      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-sm text-slate-600">Project ID *</span>
          <select
            required
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
            value={form.projectId}
            onChange={handleProjectIdChange}
          >
            <option value="">Select Project ID</option>
            {projectList.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.projectId}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm text-slate-600">Drawing No</span>
          <select
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
            value={form.drawingNumber}
            onChange={handleDrawingNumberChange}
            disabled={!form.projectId}
          >
            <option value="">Select Drawing Number</option>
            {availableDrawingNumbers.map((dn) => (
              <option key={dn} value={dn}>
                {dn}
              </option>
            ))}
          </select>
          {form.projectId && form.drawingNumber ? (
            <div className="mt-1 flex items-center gap-2 text-xs">
              <button
                type="button"
                className="text-blue-700 underline"
                title="Open the drawing PDF stored with the Enquiry"
                onClick={() => openDrawing(form.projectId, form.drawingNumber)}
              >
                ⧉ View enquiry drawing
              </button>
              {enquiryDrawing && !enquiryDrawing.found && (
                <span className="text-slate-500">
                  No PDF stored — upload it from the Enquiry screen
                </span>
              )}
            </div>
          ) : null}
        </label>

        <label className="block">
          <span className="text-sm text-slate-600">Part Name</span>
          <input readOnly className="mt-1 w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2" value={form.partName} placeholder="Auto-filled from enquiry" />
        </label>

        <label className="block">
          <span className="text-sm text-slate-600">Customer</span>
          <input readOnly className="mt-1 w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2" value={form.customerName} placeholder="Auto-filled from enquiry" />
        </label>

        <label className="block">
          <span className="text-sm text-slate-600">Revision</span>
          <input className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" value={form.revision} onChange={set('revision')} />
        </label>

        <label className="block">
          <span className="text-sm text-slate-600">Drawing Rev Date</span>
          <input type="date" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" value={form.drawingDate} onChange={set('drawingDate')} />
        </label>

        <label className="block">
          <span className="text-sm text-slate-600">Material</span>
          <input readOnly className="mt-1 w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2" value={form.material} placeholder="Auto-filled from enquiry" />
        </label>

        <label className="block">
          <span className="text-sm text-slate-600">PO No</span>
          <input readOnly className="mt-1 w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2" value={form.customerPO} placeholder="Auto-filled from linked Customer PO" />
        </label>

        <label className="md:col-span-2 block">
          <span className="text-sm text-slate-600">Notes</span>
          <textarea className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" rows="3" value={form.remarks} onChange={set('remarks')} />
        </label>

        <label className="md:col-span-2 block">
          <span className="text-sm text-slate-600">Drawing Image / PDF</span>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,application/pdf"
            className="mt-1 w-full text-sm"
            onChange={(e) => setUserFile(e.target.files?.[0]?.name || '')}
          />
          {enquiryDrawing?.found && !userFile && (
            <span className="mt-1 block text-xs text-slate-600">
              No file chosen → the enquiry drawing{' '}
              <span className="font-medium">{enquiryDrawing.fileName}</span> is attached automatically.{' '}
              <button
                type="button"
                className="text-blue-700 underline"
                onClick={() => openDrawing(form.projectId, form.drawingNumber)}
              >
                View it
              </button>
            </span>
          )}
        </label>

        <div className="md:col-span-2 flex gap-3">
          <button type="button" className="rounded-lg border border-slate-300 px-4 py-2">Save Draft</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-60">
            {saving ? 'Saving...' : 'Continue'}
          </button>
        </div>
      </form>
    </div>
  );
}
