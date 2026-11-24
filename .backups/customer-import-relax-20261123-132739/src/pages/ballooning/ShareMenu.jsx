import { useEffect, useRef, useState } from 'react';
import { Loader2, Mail, MessageCircle, ClipboardCheck, X, CheckCircle2, XCircle } from 'lucide-react';

/*
 * Small popover with the share destinations. Clicking one generates the
 * ballooned PDF + inspection Excel, downloads them, then opens the chosen web
 * page in a new tab - the user attaches the files there, because no browser can
 * attach files to WhatsApp Web or a mailto: link on our behalf.
 *
 * The Quality Module option sends the ballooned drawing + dimensions directly
 * into the ERP's embedded Quality Module for inspection.
 */
export default function ShareMenu({ open, onClose, onEmail, onWhatsApp, onQuality }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');
  const [qualityOk, setQualityOk] = useState(false);
  const [mobileSynced, setMobileSynced] = useState(false);

  useEffect(() => {
    if (!open) {
      setBusy('');
      setStatus('');
      setQualityOk(false);
      setMobileSynced(false);
      return undefined;
    }

    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const run = async (kind, handler) => {
    setBusy(kind);
    setStatus('');
    try {
      await handler();
    } catch (err) {
      setStatus(err.message || 'Could not prepare the files.');
    } finally {
      setBusy('');
    }
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-40 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"
    >
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-xs font-medium text-slate-600">Send both files with</span>
        <button type="button" onClick={onClose} className="rounded p-0.5 text-slate-400 hover:bg-slate-100">
          <X size={14} />
        </button>
      </div>

      <button
        type="button"
        onClick={() => run('email', onEmail)}
        disabled={Boolean(busy)}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-slate-700 hover:bg-blue-50 disabled:opacity-60"
      >
        {busy === 'email' ? <Loader2 size={16} className="animate-spin text-blue-600" /> : <Mail size={16} className="text-blue-600" />}
        <span>
          Email
          <span className="block text-[11px] text-slate-400">Opens Gmail in a new tab, files download</span>
        </span>
      </button>

      <button
        type="button"
        onClick={() => run('whatsapp', onWhatsApp)}
        disabled={Boolean(busy)}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-slate-700 hover:bg-emerald-50 disabled:opacity-60"
      >
        {busy === 'whatsapp' ? (
          <Loader2 size={16} className="animate-spin text-emerald-600" />
        ) : (
          <MessageCircle size={16} className="text-emerald-600" />
        )}
        <span>
          WhatsApp
          <span className="block text-[11px] text-slate-400">Opens WhatsApp Web, files download</span>
        </span>
      </button>

      <div className="my-1 border-t border-slate-100" />

      <button
        type="button"
        onClick={async () => {
          setBusy('quality');
          setStatus('');
          setQualityOk(false);
          setMobileSynced(false);
          try {
            const result = await onQuality();
            setQualityOk(true);
            const mobile = result?.mobileSync;
            if (mobile?.ok && !mobile.skipped) setMobileSynced(true);
            if (mobile && !mobile.skipped && !mobile.ok) {
              setStatus(`Imported, but phones could not sync: ${mobile.error}`);
            }
          } catch (err) {
            setStatus(err.message || 'Could not send to Quality Module.');
          } finally {
            setBusy('');
          }
        }}
        disabled={Boolean(busy)}
        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-slate-700 hover:bg-purple-50 disabled:opacity-60"
      >
        {busy === 'quality' ? (
          <Loader2 size={16} className="animate-spin text-purple-600" />
        ) : qualityOk && mobileSynced ? (
          <CheckCircle2 size={16} className="text-green-600" />
        ) : qualityOk && status ? (
          <XCircle size={16} className="text-red-600" />
        ) : qualityOk ? (
          <CheckCircle2 size={16} className="text-green-600" />
        ) : (
          <ClipboardCheck size={16} className="text-purple-600" />
        )}
        <span>
          {qualityOk && status ? 'Imported - mobile sync failed' : qualityOk ? 'Sent to Quality Module' : 'Quality Module'}
          <span className="block text-[11px] text-slate-400">
            {qualityOk && status
              ? 'PDF was not sent to mobile QC'
              : qualityOk
              ? mobileSynced
                ? 'Ballooned PDF + dimensions sent to mobile QC app'
                : 'Drawing imported for inspection'
              : 'Send drawing + dimensions for QC inspection'}
          </span>
        </span>
      </button>

      {status ? <p className="mt-1 px-1 text-[11px] text-red-600">{status}</p> : null}
    </div>
  );
}
