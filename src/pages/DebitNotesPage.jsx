import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FileText } from 'lucide-react';
import NotificationsPanel from '../components/NotificationsPanel.jsx';
import RecordSearchBar from '../components/RecordSearchBar.jsx';
import { filterDebitCandidates, filterMaterialRecords } from '../utils/historySearch.js';
import { hasPermission } from '../utils/permissions.js';
import {
  listDebitNotes,
  getDebitNoteDetail,
  getDebitNoteCandidates,
  getDebitNoteContext,
  createDebitNote,
  updateDebitNote,
  transitionDebitNote,
  approveDebitNote,
  rejectDebitNote,
  cancelDebitNote,
  debitNoteCreateToken
} from '../services/debitNoteApi.js';
import { saveWorkflowDocument, openWorkflowDocument } from '../utils/workflowFiles.js';
import { generateDebitNotePDF } from '../services/pdfGenerator.js';
import { numberToWords } from '../utils/numberToWords.js';

/** Mirrors workflowService.DEBIT_NOTE_STATUS so the UI keeps the same vocabulary. */
export const DEBIT_NOTE_STATUS = Object.freeze({
  DRAFT: 'Draft',
  REQUESTED: 'Requested',
  PURCHASE_REVIEW: 'Purchase Review',
  ADMIN_REVIEW: 'Admin Approval',
  APPROVED: 'Approved',
  ISSUED: 'Issued',
  SENT_VENDOR: 'Sent to Vendor',
  CLOSED: 'Closed',
  CREATED: 'Created',
  SENT: 'Sent to Purchase',
  RECORDED: 'Recorded by Purchase'
});

const badgeClass = (status) => `status-badge st-${String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
const num = (v) => Number(v) || 0;
const money = (v) => num(v).toFixed(2);

/* ------------------------------ create / edit form ------------------------------ */

const DebitNoteForm = ({ context, existing, onDone, onError }) => {
  const navigate = useNavigate();
  const [date, setDate] = useState(existing?.debitNoteDate || new Date().toISOString().slice(0, 10));
  const [remarks, setRemarks] = useState(existing?.remarks || '');
  const [docs, setDocs] = useState(existing?.documents || []);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createToken] = useState(() => debitNoteCreateToken());
  const [qty, setQty] = useState(() => {
    const seed = {};
    (context.lines || []).forEach((l) => {
      seed[l.materialCode || l.materialName] = existing
        ? num((existing.items || []).find((i) => (i.materialCode || i.materialName) === (l.materialCode || l.materialName))?.debitQty)
        : l.remainingQty;
    });
    return seed;
  });

  const keyOf = (l) => l.materialCode || l.materialName;
  const setLineQty = (line, value) =>
    setQty((prev) => ({ ...prev, [keyOf(line)]: value === '' ? '' : Number(value) }));

  // Live client-side validation mirrors the service-layer rules exactly.
  const errors = useMemo(() => {
    const list = [];
    if (!context.hasSource)
      list.push('No Material Arrival or Material Receipt / Tax Invoice is linked to this Rejection Report yet.');
    context.lines.forEach((l) => {
      if (l.remainingQty <= 0) return;
      if (l.priceMissing) list.push(`PO ${context.rejection.poNumber} has no rate for "${l.materialName}".`);
      const v = Number(qty[keyOf(l)]);
      if (v > l.remainingQty + 1e-9)
        list.push(`"${l.materialName}": debit qty exceeds the ${l.remainingQty} ${l.unit} still unclaimed.`);
      if (v < 0) list.push(`"${l.materialName}": debit qty cannot be negative.`);
    });
    const anyQty = context.lines.some((l) => Number(qty[keyOf(l)]) > 0);
    if (!anyQty) list.push('Enter a debit quantity for at least one material.');
    return list;
  }, [context, qty]);

  const totals = useMemo(() => {
    const items = context.lines
      .map((l) => {
        const debitQty = num(qty[keyOf(l)]);
        const amount = Number((debitQty * l.unitPrice).toFixed(2));
        const gstAmount = Number(((amount * l.gstPercent) / 100).toFixed(2));
        return { ...l, debitQty, amount, gstAmount, lineTotal: Number((amount + gstAmount).toFixed(2)) };
      })
      .filter((i) => i.debitQty > 0);
    const subtotal = Number(items.reduce((a, i) => a + i.amount, 0).toFixed(2));
    const totalGST = Number(items.reduce((a, i) => a + i.gstAmount, 0).toFixed(2));
    const grandTotal = Number((subtotal + totalGST).toFixed(2));
    return { items, subtotal, totalGST, cgst: Number((totalGST / 2).toFixed(2)), grandTotal };
  }, [context.lines, qty]);

  const handleFiles = async (fileList) => {
    setUploading(true);
    try {
      const added = [];
      for (const file of Array.from(fileList || [])) {
        const meta = await saveWorkflowDocument(file);
        added.push({ ...meta, kind: 'Debit Note' });
      }
      setDocs((prev) => [...prev, ...added]);
    } catch (err) {
      onError(err);
    } finally {
      setUploading(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (saving || errors.length > 0) return;
    setSaving(true);
    try {
      const payload = {
        rejectionNumber: context.rejection.rejectionNumber,
        debitNoteDate: date,
        remarks,
        documents: docs,
        items: context.lines
          .filter((l) => num(qty[keyOf(l)]) > 0)
          .map((l) => ({ materialCode: l.materialCode, materialName: l.materialName, debitQty: num(qty[keyOf(l)]) }))
      };
      const response = existing
        ? await updateDebitNote(existing.debitNoteNumber, existing.version, payload)
        : await createDebitNote(payload, createToken);
      onDone(response.record);
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="quotation-form" onSubmit={submit}>
      <div className="form-section">
        <div className="section-heading">
          <h3>Debit Note Header</h3>
        </div>
        <p style={{ margin: '0 0 14px', fontSize: '12.5px', color: '#475569' }}>
          Every linked document below is fetched automatically from the Purchase Order, Material Receipt, Quality
          Check and Rejection Report. Only the date, quantities and remarks are entered here.
        </p>
        <div className="section-grid">
          <div className="field-group">
            <label>Debit Note Number</label>
            <input readOnly value={existing?.debitNoteNumber || 'Generated on save'} />
          </div>
          <div className="field-group">
            <label>Debit Note Date *</label>
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field-group">
            <label>Rejection Report</label>
            <input readOnly value={context.rejection.rejectionNumber} />
          </div>
          <div className="field-group">
            <label>Vendor</label>
            <input readOnly value={context.vendor || '—'} />
          </div>
          <div className="field-group">
            <label>Vendor GSTIN</label>
            <input readOnly value={context.vendorDetails?.gstNumber || '—'} />
          </div>
          <div className="field-group">
            <label>Vendor Tax Invoice</label>
            <input readOnly value={context.invoiceNumber || '—'} />
          </div>
          <div className="field-group">
            <label>Material Receipt</label>
            <input readOnly value={context.receipt?.receiptNumber || 'Not recorded'} />
          </div>
          <div className="field-group">
            <label>Quality Check</label>
            <input readOnly value={context.qc?.qcNumber || '—'} />
          </div>
          <div className="field-group">
            <label>Purchase Order</label>
            <input readOnly value={context.rejection.poNumber || '—'} />
          </div>
        </div>
      </div>

      {!context.hasSource && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: '8px',
            marginBottom: '16px',
            fontWeight: 600,
            background: '#fee2e2',
            color: '#b91c1c'
          }}
        >
          A Debit Note claims money against the delivery that brought the rejected material, so the Material Arrival
          (or Material Receipt / Tax Invoice) must be recorded first. Record it from the Purchase Indent screen — this
          action will not create a receipt.
          <div style={{ marginTop: '8px' }}>
            <button
              type="button"
              className="button-small button-secondary"
              onClick={() => navigate('/material-receipts', { state: { newReceiptFor: context.rejection.poNumber } })}
            >
              Record Tax Invoice / Material Receipt
            </button>
          </div>
        </div>
      )}

      <div className="form-section">
        <div className="section-heading">
          <h3>Rejected Materials</h3>
        </div>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>SL.No</th>
                <th>Material</th>
                <th>HSN</th>
                <th>Unit</th>
                <th>Rejected Qty</th>
                <th>Already Debited</th>
                <th>Available Qty</th>
                <th>Debit Qty *</th>
                <th>Rate (PO)</th>
                <th>GST %</th>
                <th>Taxable Amt</th>
                <th>GST Amt</th>
                <th>Line Total</th>
                <th>Rejection Reason</th>
              </tr>
            </thead>
            <tbody>
              {context.lines.map((l, idx) => {
                const k = keyOf(l);
                const debitQty = num(qty[k]);
                const amount = Number((debitQty * l.unitPrice).toFixed(2));
                const gstAmount = Number(((amount * l.gstPercent) / 100).toFixed(2));
                const fullyClaimed = l.remainingQty <= 0;
                return (
                  <tr key={k}>
                    <td>{idx + 1}</td>
                    <td>
                      <strong>{l.materialName}</strong>
                    </td>
                    <td>{l.hsnSac || '—'}</td>
                    <td>{l.unit}</td>
                    <td style={{ color: '#b91c1c', fontWeight: 700 }}>{num(l.rejectedQty)}</td>
                    <td>{num(l.debitedQty)}</td>
                    <td>
                      <strong>{num(l.remainingQty)}</strong>
                    </td>
                    <td>
                      {fullyClaimed ? (
                        <span style={{ color: '#166534', fontWeight: 700 }}>Fully debited</span>
                      ) : l.priceMissing ? (
                        <span style={{ color: '#b91c1c', fontWeight: 700 }}>No PO rate</span>
                      ) : (
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          max={l.remainingQty}
                          value={qty[k]}
                          onChange={(e) => setLineQty(l, e.target.value)}
                          style={{ width: '96px' }}
                        />
                      )}
                    </td>
                    <td>{l.priceMissing ? <span style={{ color: '#b91c1c' }}>Missing</span> : money(l.unitPrice)}</td>
                    <td>{num(l.gstPercent).toFixed(2).replace(/\.00$/, '')}%</td>
                    <td>{debitQty > 0 ? money(amount) : '—'}</td>
                    <td>{debitQty > 0 ? money(gstAmount) : '—'}</td>
                    <td>
                      <strong>{debitQty > 0 ? money(amount + gstAmount) : '—'}</strong>
                    </td>
                    <td>{l.reason || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ marginTop: '10px', fontSize: '12.5px', color: '#475569' }}>
          Price and GST are read from Purchase Order <strong>{context.rejection.poNumber}</strong> and cannot be
          edited here. A material whose PO rate is missing must have the rate added to the PO first.
        </p>
      </div>

      <div className="form-section">
        <div className="section-heading">
          <h3>Totals</h3>
        </div>
        <div className="section-grid">
          <div className="field-group">
            <label>Taxable Amount</label>
            <input readOnly value={money(totals.subtotal)} />
          </div>
          <div className="field-group">
            <label>CGST</label>
            <input readOnly value={money(totals.cgst)} />
          </div>
          <div className="field-group">
            <label>SGST</label>
            <input readOnly value={money(totals.totalGST - totals.cgst)} />
          </div>
          <div className="field-group">
            <label>Total Debit Value</label>
            <input readOnly value={money(totals.grandTotal)} />
          </div>
          <div className="field-group full-width">
            <label>Amount in words</label>
            <input readOnly value={`${numberToWords(totals.grandTotal)} only`} />
          </div>
          <div className="field-group full-width">
            <label>Remarks</label>
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} />
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="section-heading">
          <h3>Supporting Documents</h3>
        </div>
        <div className="field-group">
          <label>Attach rejection photo / DC / credit note copy</label>
          <input type="file" multiple onChange={(e) => handleFiles(e.target.files)} disabled={uploading} />
        </div>
        {docs.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' }}>
            {docs.map((d) => (
              <span key={d.id} className={badgeClass('Attached')}>
                {d.kind}: {d.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {errors.length > 0 && (
        <ul style={{ margin: '0 0 16px', paddingLeft: '20px', color: '#b91c1c', fontSize: '13px', fontWeight: 600 }}>
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="form-actions">
        <button type="button" className="button-secondary" onClick={() => onDone(null)}>
          ← Cancel
        </button>
        <button type="submit" className="button-primary" disabled={errors.length > 0 || saving}>
          {saving ? 'Saving…' : existing ? 'Save Debit Note' : 'Create Debit Note'}
        </button>
      </div>
    </form>
  );
};

/* --------------------------------- details view --------------------------------- */

const DebitNoteDetail = ({ note, pendingReplacement = 0, onBack, onRefresh, flash, canCreate }) => {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const isDraft = note.status === DEBIT_NOTE_STATUS.DRAFT;
  const canRecord = hasPermission('debitnote.record');
  const isAdmin = hasPermission('*') || hasPermission('debitnote.admin_approve');
  const canApproveAdmin = isAdmin;
  const D = DEBIT_NOTE_STATUS;
  const closeBlocked = pendingReplacement > 0;

  /** Run an API transition; success is announced only after the server confirms it. */
  const run = async (action, okMessage) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await onRefresh();
      flash('ok', okMessage);
    } catch (err) {
      flash('err', err.message);
      if (err.current) await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const actionButton = (label, action, message, className = 'button-primary', title = '') => (
    <button className={className} title={title} disabled={busy} onClick={() => run(action, message)}>
      {label}
    </button>
  );

  return (
    <div>
      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Debit Note {note.debitNoteNumber}</h3>
          <span className={badgeClass(note.status)}>{note.status}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
          <div>
            <strong>Date:</strong> {note.debitNoteDate}
          </div>
          <div>
            <strong>Vendor:</strong> {note.vendor || '—'}
          </div>
          <div>
            <strong>Vendor GSTIN:</strong> {note.vendorGstNumber || '—'}
          </div>
          <div>
            <strong>Vendor Invoice:</strong> {note.invoiceNumber || '—'}
          </div>
          <div>
            <strong>Invoice Date:</strong> {note.invoiceDate || '—'}
          </div>
          <div>
            <strong>Material Receipt:</strong> {note.receiptNumber || '—'}
          </div>
          <div>
            <strong>Quality Check:</strong> {note.qcNumber || '—'}
          </div>
          <div>
            <strong>Rejection Report:</strong> {note.rejectionNumber || '—'}
          </div>
          <div>
            <strong>Purchase Order:</strong> {note.poNumber || '—'}
          </div>
          <div>
            <strong>Purchase Indent:</strong> {note.indentNumber || '—'}
          </div>
          <div>
            <strong>Inspector:</strong> {note.inspector || '—'}
          </div>
          <div>
            <strong>Project:</strong> {note.projectId || '—'}
          </div>
          <div>
            <strong>Prepared By:</strong> {note.createdBy} · {note.createdAt}
          </div>
          {note.requestedBy && (
            <div>
              <strong>Requested By:</strong> {note.requestedBy} · {note.requestedAt}
            </div>
          )}
          {note.reviewedBy && (
            <div>
              <strong>Reviewed By:</strong> {note.reviewedBy} · {note.reviewedAt}
            </div>
          )}
          {note.purchaseAuthorizedBy && (
            <div>
              <strong>Authorised By (Purchase):</strong> {note.purchaseAuthorizedBy} · {note.purchaseAuthorizedAt}
            </div>
          )}
          {note.adminApprovedBy && (
            <div>
              <strong>Approved By (Admin):</strong> {note.adminApprovedBy} · {note.adminApprovedAt}
            </div>
          )}
          {note.approvedBy && !note.adminApprovedBy && (
            <div>
              <strong>Approved By:</strong> {note.approvedBy} · {note.approvedAt}
            </div>
          )}
          {note.sentToVendorBy && (
            <div>
              <strong>Sent to Vendor By:</strong> {note.sentToVendorBy} · {note.sentToVendorAt}
            </div>
          )}
          {note.closedBy && (
            <div>
              <strong>Closed By:</strong> {note.closedBy} · {note.closedAt}
            </div>
          )}
          {note.issuedBy && (
            <div>
              <strong>Issued By:</strong> {note.issuedBy} · {note.issuedAt}
            </div>
          )}
        </div>
        {note.qualityRemarks && (
          <p style={{ marginTop: '10px' }}>
            <strong>Quality remarks:</strong> {note.qualityRemarks}
          </p>
        )}
        {note.remarks && (
          <p style={{ marginTop: '6px' }}>
            <strong>Remarks:</strong> {note.remarks}
          </p>
        )}
      </div>

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Debit Items</h3>
          <span className={badgeClass('Created')}>{note.items.length} material(s)</span>
        </div>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>SL.No</th>
                <th>Material</th>
                <th>HSN</th>
                <th>Unit</th>
                <th>Rejected Qty</th>
                <th>Debit Qty</th>
                <th>Rate</th>
                <th>GST %</th>
                <th>Taxable Amt</th>
                <th>GST Amt</th>
                <th>Line Total</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {note.items.map((it, idx) => (
                <tr key={idx}>
                  <td>{idx + 1}</td>
                  <td>
                    <strong>{it.materialName}</strong>
                  </td>
                  <td>{it.hsnSac || '—'}</td>
                  <td>{it.unit}</td>
                  <td>{num(it.rejectedQty)}</td>
                  <td style={{ fontWeight: 700 }}>{num(it.debitQty)}</td>
                  <td>{money(it.unitPrice)}</td>
                  <td>{num(it.gstPercent).toFixed(2).replace(/\.00$/, '')}%</td>
                  <td>{money(it.amount)}</td>
                  <td>{money(it.gstAmount)}</td>
                  <td>
                    <strong>{money(it.lineTotal)}</strong>
                  </td>
                  <td>{it.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Totals</h3>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
          <div>
            <strong>Taxable Amount:</strong> {money(note.subtotal)}
          </div>
          <div>
            <strong>CGST:</strong> {money(note.cgst)}
          </div>
          <div>
            <strong>SGST:</strong> {money(note.sgst)}
          </div>
          <div>
            <strong>Total GST:</strong> {money(note.totalGST)}
          </div>
          <div>
            <strong>Total Debit Value:</strong> {money(note.grandTotal)}
          </div>
        </div>
        <p style={{ marginTop: '8px' }}>
          <strong>In words:</strong> {note.amountInWords}
        </p>
      </div>

      {note.documents?.length > 0 && (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">Documents</h3>
            <span className={badgeClass('Attached')}>{note.documents.length} file(s)</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {note.documents.map((d) => (
              <button key={d.id} type="button" className="button-secondary button-small" onClick={() => openWorkflowDocument(d)}>
                <FileText size={14} aria-hidden="true" /> {d.kind}: {d.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">Linked Documents</h3>
          <span className="muted-text">Read-only back-references</span>
        </div>
        <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
          {note.poNumber && (
            <button className="button-secondary button-small" onClick={() => navigate('/purchase-order', { state: { openPO: note.poNumber } })}>
              Purchase Order {note.poNumber}
            </button>
          )}
          {note.receiptNumber && (
            <button className="button-secondary button-small" onClick={() => navigate('/material-receipts', { state: { openReceipt: note.receiptNumber } })}>
              Material Receipt {note.receiptNumber}
            </button>
          )}
          {note.qcNumber && (
            <button className="button-secondary button-small" onClick={() => navigate('/quality-checks', { state: { openQC: note.qcNumber } })}>
              Quality Check {note.qcNumber}
            </button>
          )}
          {note.rejectionNumber && (
            <button className="button-secondary button-small" onClick={() => navigate('/material-receipts', { state: { openRejection: note.rejectionNumber } })}>
              Rejection Report {note.rejectionNumber}
            </button>
          )}
        </div>
      </div>

      {note.vendorNotice && (
        <div className="content-block">
          <div className="block-header">
            <h3 className="block-title">
              Rejection Notice sent to {note.vendorNotice.vendor || note.vendor || 'Vendor'}
            </h3>
            <span className="muted-text">
              {note.vendorNotice.sentBy} · {note.vendorNotice.sentAt}
            </span>
          </div>
          <p style={{ marginTop: 0 }}>
            Forwarded by the Purchase Department with Debit Note {note.debitNoteNumber} — why the material was
            rejected:
          </p>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead>
                <tr>
                  <th>SL.No</th>
                  <th>Material</th>
                  <th>Rejected Qty</th>
                  <th>Debit Qty</th>
                  <th>Reason for Rejection</th>
                </tr>
              </thead>
              <tbody>
                {(note.vendorNotice.lines || []).map((l, i) => (
                  <tr key={`${note.debitNoteNumber}-vendor-notice-${i}`}>
                    <td>{i + 1}</td>
                    <td>{l.materialName}</td>
                    <td>
                      {num(l.rejectedQty)} {l.unit}
                    </td>
                    <td>
                      {num(l.debitQty)} {l.unit}
                    </td>
                    <td>{l.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {note.vendorNotice.qualityRemarks && (
            <p style={{ marginTop: '10px' }}>
              <strong>Quality remarks:</strong> {note.vendorNotice.qualityRemarks}
            </p>
          )}
          <p className="muted-text" style={{ marginBottom: 0 }}>
            Refs — Rejection Report {note.vendorNotice.rejectionNumber || '—'} · QC{' '}
            {note.vendorNotice.qcNumber || '—'} · Receipt {note.vendorNotice.receiptNumber || '—'} · PO{' '}
            {note.vendorNotice.poNumber || '—'}
          </p>
        </div>
      )}

      <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
        <button className="button-secondary" onClick={onBack}>
          ← Back
        </button>
        <button
          className="button-secondary"
          onClick={() => generateDebitNotePDF(note, { print: true })}
        >
          Print / View PDF
        </button>
        <button className="button-secondary" onClick={() => generateDebitNotePDF(note)}>
          Download PDF
        </button>
        {isDraft && canCreate && actionButton(
          'Submit for Admin Approval',
          () => transitionDebitNote(note.debitNoteNumber, 'submit', note.version),
          `Debit Note ${note.debitNoteNumber} sent to the Admin for approval.`,
          'button-secondary',
          'The Admin must approve the Debit Note before the Purchase Department may issue it'
        )}
        {note.status === D.REQUESTED && canRecord && actionButton(
          'Start Purchase Review',
          () => transitionDebitNote(note.debitNoteNumber, 'review', note.version),
          `Purchase review started on Debit Note ${note.debitNoteNumber}.`
        )}
        {note.status === D.PURCHASE_REVIEW && canRecord && actionButton(
          'Authorise & Send to Admin',
          () => transitionDebitNote(note.debitNoteNumber, 'authorise', note.version),
          `Debit Note ${note.debitNoteNumber} authorised by Purchase — sent to the Admin for approval.`,
          'button-primary',
          'Purchase authorises the Debit Note and sends it to the Admin for approval'
        )}
        {note.status === D.ADMIN_REVIEW && canApproveAdmin && actionButton(
          'Approve & Send to Purchase',
          () => approveDebitNote(note.debitNoteNumber, note.version),
          `Debit Note ${note.debitNoteNumber} approved by Admin — sent to Purchase to issue and send it to ${note.vendor || 'the vendor'} with the rejection reasons.`,
          'button-primary',
          'Admin approval hands the Debit Note over to the Purchase Department'
        )}
        {note.status === D.ADMIN_REVIEW && !canApproveAdmin && (
          <span className="status-badge st-admin-approval">Awaiting Admin approval</span>
        )}
        {note.status === D.APPROVED && canRecord && actionButton(
          'Issue Debit Note',
          () => transitionDebitNote(note.debitNoteNumber, 'issue', note.version),
          `Debit Note ${note.debitNoteNumber} issued to ${note.vendor || 'vendor'}.`,
          'button-primary',
          'Only the Purchase Department may issue an Admin-approved Debit Note'
        )}
        {[D.ISSUED, D.CREATED, D.SENT].includes(note.status) && canRecord && actionButton(
          'Send to Vendor (with Rejection Reasons)',
          () => transitionDebitNote(note.debitNoteNumber, 'send', note.version),
          `Debit Note ${note.debitNoteNumber} sent to ${note.vendor || 'the vendor'} with the rejection reasons.`,
          'button-primary',
          'Forwards the Debit Note to the vendor together with the rejection reasons'
        )}
        {[D.SENT_VENDOR, D.RECORDED].includes(note.status) && canRecord && !closeBlocked && actionButton(
          'Close Debit Note',
          () => transitionDebitNote(note.debitNoteNumber, 'close', note.version),
          `Debit Note ${note.debitNoteNumber} closed.`,
          'button-primary',
          'Close this Debit Note'
        )}
        {[D.SENT_VENDOR, D.RECORDED].includes(note.status) && closeBlocked && (
          <span className="status-badge st-pending-store" title="Store must receive the replacement and Quality must inspect it first">
            Close available after {pendingReplacement} replacement unit(s) pass Quality Check
          </span>
        )}
        {[D.DRAFT, D.REQUESTED, D.PURCHASE_REVIEW, D.ADMIN_REVIEW].includes(note.status) && canCreate && actionButton(
          'Cancel Debit Note',
          async () => {
            const reason = window.prompt('Reason for cancelling this Debit Note (optional):') || '';
            await cancelDebitNote(note.debitNoteNumber, note.version, reason);
          },
          `Debit Note ${note.debitNoteNumber} cancelled.`,
          'button-secondary'
        )}
        {[D.DRAFT, D.REQUESTED, D.PURCHASE_REVIEW, D.ADMIN_REVIEW].includes(note.status) && canRecord && actionButton(
          'Reject Debit Note',
          async () => {
            const reason = window.prompt('Reason for rejecting this Debit Note:');
            if (!reason) throw new Error('A rejection reason is required.');
            await rejectDebitNote(note.debitNoteNumber, note.version, reason);
          },
          `Debit Note ${note.debitNoteNumber} rejected.`,
          'button-secondary'
        )}
      </div>

      <div className="content-block">
        <div className="block-header">
          <h3 className="block-title">History</h3>
        </div>
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Date / Time</th>
                <th>User</th>
                <th>Department</th>
                <th>Action</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {(note.history || []).length === 0 ? (
                <tr>
                  <td colSpan="5" className="no-history-row">
                    No history yet.
                  </td>
                </tr>
              ) : (
                (note.history || [])
                  .slice()
                  .reverse()
                  .map((h, idx) => (
                    <tr key={idx}>
                      <td>{h.at}</td>
                      <td>{h.by || h.name}</td>
                      <td>{h.dept}</td>
                      <td>{h.action}</td>
                      <td>{h.details || '—'}</td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

/* ---------------------------------- page shell ---------------------------------- */

const DebitNotesPage = () => {
  const location = useLocation();
  const [openNo, setOpenNo] = useState(location.state?.openDebitNote || null);
  const [creatingFor, setCreatingFor] = useState(location.state?.newDebitNoteFor || '');
  const [message, setMessage] = useState(null);
  const [notes, setNotes] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [note, setNote] = useState(null);
  const [pendingReplacement, setPendingReplacement] = useState(0);
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [candidateSearch, setCandidateSearch] = useState('');
  const [notesSearch, setNotesSearch] = useState('');

  const flash = (type, text) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 7000);
  };

  const reloadLists = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [nextNotes, nextCandidates] = await Promise.all([listDebitNotes(), getDebitNoteCandidates()]);
      setNotes(nextNotes);
      setCandidates(nextCandidates);
    } catch (err) {
      setLoadError(err.message || 'Unable to load Debit Notes from the server.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reloadLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const state = location.state;
    if (!state) return;
    if (state.newDebitNoteFor) {
      setNote(null);
      setOpenNo(null);
      setCreatingFor(state.newDebitNoteFor);
    } else if (state.openDebitNote) {
      setContext(null);
      setCreatingFor('');
      setOpenNo(state.openDebitNote);
    }
  }, [location.state]);

  useEffect(() => {
    if (!openNo) {
      setNote(null);
      setPendingReplacement(0);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    getDebitNoteDetail(openNo)
      .then((result) => {
        if (cancelled) return;
        setNote(result.record);
        setPendingReplacement(Number(result.replacementProgress?.pendingQty) || 0);
      })
      .catch((err) => {
        if (cancelled) return;
        flash('err', err.message);
        setNote(null);
        setOpenNo(null);
      })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNo]);

  useEffect(() => {
    if (!creatingFor) {
      setContext(null);
      return;
    }
    let cancelled = false;
    setContextLoading(true);
    getDebitNoteContext(creatingFor)
      .then((result) => { if (!cancelled) setContext(result); })
      .catch((err) => {
        if (cancelled) return;
        flash('err', err.message);
        setCreatingFor('');
      })
      .finally(() => { if (!cancelled) setContextLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatingFor]);

  const refreshDetail = async () => {
    if (openNo) {
      const result = await getDebitNoteDetail(openNo);
      setNote(result.record);
      setPendingReplacement(Number(result.replacementProgress?.pendingQty) || 0);
    }
    await reloadLists();
  };

  const filteredCandidates = filterDebitCandidates(candidates, candidateSearch);
  const filteredNotes = filterMaterialRecords(notes, notesSearch, ['rejectionNumber','debitNoteNumber','poNumber','qcNumber','receiptNumber','vendor','debitNoteDate','status']);
  const canCreate = hasPermission('debitnote.create');
  const isStoreUser = hasPermission('store.module') && !hasPermission('purchase.order');

  return (
    <section className={`page-section${isStoreUser ? ' store-screen' : ''}`}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Debit Notes</h1>
        </div>
        <div className="header-actions">
          <NotificationsPanel />
        </div>
      </div>

      {message && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: '8px',
            marginBottom: '16px',
            fontWeight: 600,
            background: message.type === 'ok' ? '#dcfce7' : '#fee2e2',
            color: message.type === 'ok' ? '#166534' : '#b91c1c'
          }}
        >
          {message.text}
        </div>
      )}

      {loading && (
        <div className="content-block">
          <p className="muted-text">Loading Debit Notes from PostgreSQL…</p>
        </div>
      )}
      {!loading && loadError && (
        <div className="content-block">
          <p style={{ color: '#b91c1c', fontWeight: 600 }}>{loadError}</p>
          <button className="button-secondary button-small" onClick={reloadLists}>Retry</button>
        </div>
      )}
      {detailLoading && !note && (
        <div className="content-block"><p className="muted-text">Loading Debit Note…</p></div>
      )}
      {contextLoading && !context && (
        <div className="content-block"><p className="muted-text">Loading rejection details…</p></div>
      )}

      {note && (
        <DebitNoteDetail
          note={note}
          pendingReplacement={pendingReplacement}
          canCreate={canCreate}
          flash={flash}
          onRefresh={refreshDetail}
          onBack={() => setOpenNo(null)}
        />
      )}

      {!note && context && (
        <>
          <div className="page-header" style={{ marginBottom: '12px' }}>
            <div>
              <h2 className="page-title" style={{ fontSize: '18px' }}>
                New Debit Note — Rejection Report {context.rejection.rejectionNumber}
              </h2>
              <p className="page-description">
                Rejected {context.totalRejectedQty} · Already debited {context.totalDebitedQty} · Available{' '}
                {context.totalRemainingQty}
              </p>
            </div>
            <div className="header-actions">
              <button className="button-secondary" onClick={() => setCreatingFor('')}>
                ← Cancel
              </button>
            </div>
          </div>
          <DebitNoteForm
            key={context.rejection.rejectionNumber}
            context={context}
            existing={null}
            onError={(err) => flash('err', err.message)}
            onDone={(saved) => {
              if (!saved) {
                setCreatingFor('');
                return;
              }
              setCreatingFor('');
              setOpenNo(saved.debitNoteNumber);
              setNote(saved);
              setPendingReplacement(0);
              reloadLists();
              flash('ok', `Debit Note ${saved.debitNoteNumber} saved as draft for ${saved.vendor || 'vendor'}.`);
            }}
          />
        </>
      )}

      {!note && !context && (
        <>
          {canCreate && candidates.length > 0 && (
            <div className="content-block">
              <div className="block-header">
                <h3 className="block-title">Rejections Awaiting Debit Note ({candidates.length})</h3>
                <span className="muted-text">Only rejected material with an unclaimed balance is listed</span>
              </div>
              <RecordSearchBar value={candidateSearch} onChange={setCandidateSearch} placeholder="Search rejection report, PO, QC, receipt, vendor..." label="Search rejections awaiting debit note" />
              <div className="history-table-wrapper">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>Rejection Report</th>
                      <th>Date</th>
                      <th>PO</th>
                      <th>QC</th>
                      <th>Receipt</th>
                      <th>Vendor</th>
                      <th>Rejected Qty</th>
                      <th>Debited</th>
                      <th>Available</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCandidates.length === 0 && <tr><td colSpan="10" className="no-history-row">No rejections match your search.</td></tr>}
                    {filteredCandidates.map((c) => (
                      <tr key={c.rejection.rejectionNumber}>
                        <td>
                          <strong>{c.rejection.rejectionNumber}</strong>
                        </td>
                        <td>{c.rejection.rejectionDate}</td>
                        <td>{c.rejection.poNumber || '—'}</td>
                        <td>{c.rejection.qcNumber || '—'}</td>
                        <td>{c.receipt?.receiptNumber || <span style={{ color: '#b91c1c' }}>Not recorded</span>}</td>
                        <td>{c.vendor || '—'}</td>
                        <td style={{ color: '#b91c1c', fontWeight: 700 }}>{num(c.totalRejectedQty)}</td>
                        <td>{num(c.totalDebitedQty)}</td>
                        <td>
                          <strong>{num(c.totalRemainingQty)}</strong>
                        </td>
                        <td>
                          <button className="button-small button-primary" onClick={() => setCreatingFor(c.rejection.rejectionNumber)}>
                            Create Debit Note
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {canCreate && candidates.length === 0 && (
            <div className="content-block">
              <p style={{ color: '#475569', fontSize: '13px' }}>
                No rejection currently has unclaimed rejected quantity. Debit Notes become available once a Quality
                Check records rejected material and its tax invoice is stored.
              </p>
            </div>
          )}

          <div className="content-block">
            <div className="block-header">
              <h3 className="block-title">Debit Notes ({notes.length})</h3>
            </div>
            <RecordSearchBar value={notesSearch} onChange={setNotesSearch} placeholder="Search debit note, PO, QC, receipt, vendor, status..." label="Search debit notes" />
            <div className="history-table-wrapper">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Debit Note</th>
                    <th>Date</th>
                    <th>Vendor</th>
                    <th>Invoice</th>
                    <th>PO</th>
                    <th>Receipt</th>
                    <th>QC</th>
                    <th>Rejection</th>
                    <th>Qty</th>
                    <th>Debit Value</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNotes.length === 0 ? (
                    <tr>
                      <td colSpan="12" className="no-history-row">
                        {notes.length ? 'No debit notes match your search.' : 'No debit notes raised yet.'}
                      </td>
                    </tr>
                  ) : (
                    filteredNotes.map((d) => (
                      <tr key={d.debitNoteNumber}>
                        <td>
                          <strong>{d.debitNoteNumber}</strong>
                        </td>
                        <td>{d.debitNoteDate}</td>
                        <td>{d.vendor || '—'}</td>
                        <td>{d.invoiceNumber || '—'}</td>
                        <td>{d.poNumber || '—'}</td>
                        <td>{d.receiptNumber || '—'}</td>
                        <td>{d.qcNumber || '—'}</td>
                        <td>{d.rejectionNumber || '—'}</td>
                        <td>{num(d.totalDebitQty)}</td>
                        <td>
                          <strong>{money(d.grandTotal)}</strong>
                        </td>
                        <td>
                          <span className={badgeClass(d.status)}>{d.status}</span>
                        </td>
                        <td>
                          <button className="button-small button-secondary" onClick={() => setOpenNo(d.debitNoteNumber)}>
                            Open
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
};

export default DebitNotesPage;
