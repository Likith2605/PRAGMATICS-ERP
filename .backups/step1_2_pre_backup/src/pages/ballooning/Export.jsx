import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Download, FileText, Table2, Send, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import api from '../../services/ballooningApi';
import { importFromBallooning } from '../../services/qualityApi';

export default function Export() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  const exportData = async () => {
    await api.post(`/projects/${id}/export`, { type: 'pdf' });
    alert('Export started');
  };

  const sendToQuality = async () => {
    setSyncing(true);
    setSyncResult(null);

    try {
      const result = await importFromBallooning(id);
      const count = result.imported?.length || 0;
      const dims = result.imported?.reduce((sum, d) => sum + (d.dimensions || 0), 0) || 0;
      const mobile = result.mobileSync;
      let mobileNote = '';
      if (mobile && !mobile.skipped) {
        mobileNote = mobile.ok
          ? ` Sent to the mobile QC app (${mobile.drawings} drawing(s), ${mobile.dimensions} dimension(s)) - phones receive it live.`
          : ` Warning: the mobile QC app could not be reached (${mobile.error}). Click Send again once the QC server is running.`;
      }
      setSyncResult({
        ok: !mobile || mobile.ok || Boolean(mobile.skipped),
        message: `Imported ${count} drawing(s) with ${dims} dimension(s) into the Quality Module.${mobileNote}`,
      });
    } catch (err) {
      setSyncResult({
        ok: false,
        message: `Import failed: ${err.message}`,
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-semibold">Export</h1>
      <p className="text-slate-600">Generate ballooned drawing output and inspection reports.</p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <button onClick={exportData} className="rounded-lg border border-slate-300 p-4 text-left flex items-center gap-3 hover:bg-slate-50">
          <FileText size={18} />
          <span>Export Ballooned Drawing PDF</span>
        </button>
        <button onClick={exportData} className="rounded-lg border border-slate-300 p-4 text-left flex items-center gap-3 hover:bg-slate-50">
          <Table2 size={18} />
          <span>Export Inspection Report Excel</span>
        </button>
      </div>

      {/* Send to Quality Module section */}
      <div className="mt-8 border-t border-slate-200 pt-6">
        <h2 className="text-lg font-semibold text-slate-800">Quality Module</h2>
        <p className="mt-1 text-sm text-slate-500">
          Import this ballooned drawing into the ERP's Quality Module for inspection.
        </p>

        <button
          onClick={sendToQuality}
          disabled={syncing}
          className="mt-4 flex items-center gap-3 rounded-lg bg-blue-600 px-6 py-3 text-white font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {syncing ? (
            <>
              <Loader2 size={18} className="animate-spin" />
              <span>Importing...</span>
            </>
          ) : (
            <>
              <Send size={18} />
              <span>Send to Quality Module</span>
            </>
          )}
        </button>

        {syncResult && (
          <div
            className={`mt-4 flex items-start gap-3 rounded-lg border p-4 ${
              syncResult.ok
                ? 'border-green-300 bg-green-50 text-green-800'
                : 'border-red-300 bg-red-50 text-red-800'
            }`}
          >
            {syncResult.ok ? (
              <CheckCircle2 size={20} className="mt-0.5 shrink-0" />
            ) : (
              <XCircle size={20} className="mt-0.5 shrink-0" />
            )}
            <div>
              <p className="font-medium">{syncResult.ok ? 'Success' : 'Failed'}</p>
              <p className="mt-1 text-sm">{syncResult.message}</p>
              {syncResult.ok && (
                <button
                  onClick={() => navigate('/quality-module')}
                  className="mt-2 text-sm font-medium text-blue-600 hover:underline"
                >
                  Go to Quality Module &rarr;
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
