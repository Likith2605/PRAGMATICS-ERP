import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { generateRegisterPDF } from '../services/pdfGenerator.js';
import { buildReportWorkbook } from '../utils/reportExports.js';
import { applyReportFilters, validateReportDateRange } from '../utils/reportFilters.js';
import { getReportCompanyProfile } from '../utils/reportData.js';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl, useCompanyBranding } from '../utils/companyBranding.js';
import { CURRENCIES, money } from '../utils/currency.js';
import { isAdmin } from '../utils/auth.js';
import {
  createAdvance,
  createAdvanceAdjustment,
  deleteAdvance,
  importLegacyAdvances,
  listAdvanceAdjustments,
  listAdvanceAudit,
  listAdvances,
  previewLegacyAdvances,
  reverseAdvanceAdjustment,
  updateAdvance
} from '../services/advanceApi.js';

const initialForm = () => ({
  date: new Date().toISOString().slice(0, 10),
  party: '',
  amount: '',
  currency: 'INR',
  exchangeRateToINR: '1',
  mode: 'Bank Transfer (NEFT/RTGS)',
  reference: '',
  againstRef: '',
  remarks: ''
});
const amountValue = (value) => Number(value) || 0;
const invoiceParty = (invoice, kind) => kind === 'customer'
  ? String(invoice?.company || invoice?.payload?.customerDetails?.companyName || invoice?.payload?.customerDetails?.customerName || '').trim()
  : String(invoice?.vendor || invoice?.payload?.vendorDetails?.companyName || invoice?.payload?.vendorDetails?.vendorName || '').trim();
const invoiceCurrency = (invoice) => String(invoice?.currency || invoice?.payload?.currency || invoice?.payload?.invoiceDetails?.currency || 'INR').toUpperCase();
const invoiceDue = (invoice) => {
  const value = invoice?.payload?.invoiceDetails?.balanceDue;
  return Number.isFinite(Number(value)) ? Number(value) : Number(String(invoice?.balanceDue || '').replace(/[^0-9.-]/g, '')) || 0;
};
const invoiceVersion = (invoice) => Number(invoice?.version || invoice?.recordVersion || 0);

const AdvanceRegister = ({
  kind,
  title,
  filenamer,
  partyLabel,
  prefix,
  againstLabel = 'Reference',
  partyList = null,
  searchQuery = '',
  invoiceOptions = [],
  onRefresh = () => {}
}) => {
  const { logoUrl } = useCompanyBranding(defaultLogoUrl);
  const [list, setList] = useState([]);
  const [form, setForm] = useState(initialForm);
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [draftParty, setDraftParty] = useState('');
  const [applied, setApplied] = useState({ from: '', to: '', party: '' });
  const [filterError, setFilterError] = useState('');
  const [groupByParty, setGroupByParty] = useState(false);
  const [adjusting, setAdjusting] = useState(null);
  const [adjustmentForm, setAdjustmentForm] = useState({ invoiceNumber: '', amount: '' });
  const [migrationPreview, setMigrationPreview] = useState(null);
  const [migrationSelection, setMigrationSelection] = useState(new Set());
  const [historyRecord, setHistoryRecord] = useState(null);
  const [adjustmentHistory, setAdjustmentHistory] = useState([]);
  const [auditHistory, setAuditHistory] = useState([]);

  const reload = async () => {
    setLoading(true);
    try {
      const records = await listAdvances(kind);
      setList(records);
      setError('');
      return records;
    } catch (loadError) {
      setList([]);
      setError(`Advances could not be loaded from PostgreSQL: ${loadError.message}`);
      return [];
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, [kind]);

  const filteredInvoices = useMemo(() => invoiceOptions.filter((invoice) =>
    adjusting &&
    invoiceParty(invoice, kind).toLowerCase() === adjusting.party.toLowerCase() &&
    invoiceCurrency(invoice) === adjusting.currency &&
    invoiceDue(invoice) > 0 &&
    invoiceVersion(invoice) > 0
  ), [invoiceOptions, adjusting, kind]);

  const { filteredRows: datePartyRows, excludedUndated } = useMemo(() => applyReportFilters({
    rows: list,
    dateField: 'date',
    from: applied.from,
    to: applied.to,
    filters: [{ key: 'party', match: (row, value) => row.party === value }],
    selections: { party: applied.party }
  }), [list, applied]);
  const filteredRows = useMemo(() => {
    const query = String(searchQuery || '').trim().toLocaleLowerCase();
    return query
      ? datePartyRows.filter((row) => [row.advanceNumber, row.date, row.party, row.amount, row.currency, row.amountINR, row.reference, row.againstRef, row.mode, row.remarks]
        .some((value) => String(value ?? '').toLocaleLowerCase().includes(query)))
      : datePartyRows;
  }, [datePartyRows, searchQuery]);
  const totalINR = useMemo(() => filteredRows.reduce((total, row) => total + amountValue(row.amountINR), 0), [filteredRows]);
  const partySummary = useMemo(() => Object.values(filteredRows.reduce((groups, record) => {
    const key = record.party || '';
    groups[key] = groups[key] || { party: key, count: 0, amountINR: 0 };
    groups[key].count += 1;
    groups[key].amountINR += amountValue(record.amountINR);
    return groups;
  }, {})), [filteredRows]);
  const activeCriteria = [
    (applied.from || applied.to) && `Date: ${applied.from || 'any'} to ${applied.to || 'any'}`,
    applied.party && `${partyLabel}: ${applied.party}`,
    groupByParty && `Grouped by ${partyLabel}`
  ].filter(Boolean);
  const reportPeriod = `Period: ${applied.from || 'start'} to ${applied.to || 'today'}`;

  const resetForm = () => { setForm(initialForm()); setEditing(null); };
  const handleSave = async (event) => {
    event.preventDefault();
    if (!form.party.trim() || !(amountValue(form.amount) > 0)) {
      setError('Party name and a positive advance amount are required.');
      return;
    }
    const data = {
      ...form,
      amount: amountValue(form.amount),
      exchangeRateToINR: form.currency === 'INR' ? 1 : amountValue(form.exchangeRateToINR)
    };
    if (form.currency !== 'INR' && !(data.exchangeRateToINR > 0)) {
      setError('Enter the exchange rate from the advance currency to INR.');
      return;
    }
    setBusy(true);
    try {
      if (editing) await updateAdvance(kind, editing.advanceNumber, data, editing.version);
      else await createAdvance(kind, data, `advance:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`);
      resetForm();
      await reload();
      await onRefresh();
    } catch (saveError) {
      setError(saveError.message || 'Advance save was not confirmed by PostgreSQL.');
    } finally { setBusy(false); }
  };

  const handleEdit = (record) => {
    setEditing(record);
    setForm({
      date: record.date,
      party: record.party,
      amount: String(record.amount),
      currency: record.currency,
      exchangeRateToINR: String(record.exchangeRateToINR),
      mode: record.mode || '',
      reference: record.reference || '',
      againstRef: record.againstRef || '',
      remarks: record.remarks || ''
    });
    setError('');
  };

  const handleDelete = async (record) => {
    const reason = window.prompt(`Reason for deleting ${record.advanceNumber}:`);
    if (!reason?.trim()) return;
    if (!window.confirm(`Soft-delete ${record.advanceNumber}? Its audit history will be retained.`)) return;
    setBusy(true);
    try {
      await deleteAdvance(kind, record.advanceNumber, record.version, reason.trim());
      await reload();
      await onRefresh();
    } catch (deleteError) {
      setError(deleteError.message);
    } finally { setBusy(false); }
  };

  const handleApplyAdjustment = async (event) => {
    event.preventDefault();
    if (!adjusting) return;
    const invoice = filteredInvoices.find((row) => String(row.reference || row.invoiceNumber) === adjustmentForm.invoiceNumber);
    if (!invoice) { setError('Select an active PostgreSQL invoice for this party and currency.'); return; }
    const amount = amountValue(adjustmentForm.amount);
    if (!(amount > 0) || amount > adjusting.balanceAmount) { setError('Adjustment must be positive and cannot exceed the remaining advance balance.'); return; }
    setBusy(true);
    try {
      await createAdvanceAdjustment(kind, adjusting.advanceNumber, {
        invoiceNumber: String(invoice.reference || invoice.invoiceNumber),
        amount,
        version: adjusting.version,
        invoiceVersion: invoiceVersion(invoice),
        idempotencyToken: `advance-adjust:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`
      });
      setAdjusting(null);
      setAdjustmentForm({ invoiceNumber: '', amount: '' });
      await reload();
      await onRefresh();
      setError('');
    } catch (adjustError) {
      setError(adjustError.message || 'Advance adjustment was not confirmed by PostgreSQL.');
    } finally { setBusy(false); }
  };

  const handleLegacyPreview = async () => {
    setBusy(true);
    try {
      setMigrationPreview(await previewLegacyAdvances(kind));
      setMigrationSelection(new Set());
      setError('');
    } catch (previewError) { setError(`Legacy preview failed: ${previewError.message}`); }
    finally { setBusy(false); }
  };
  const handleLegacyImport = async () => {
    setBusy(true);
    try {
      const result = await importLegacyAdvances(kind, [...migrationSelection]);
      setMigrationPreview(null);
      setMigrationSelection(new Set());
      await reload();
      await onRefresh();
      setError(`${result.imported.length} imported; ${result.conflicts.length} conflict(s) left unchanged.`);
    } catch (importError) { setError(`Selected import failed: ${importError.message}`); }
    finally { setBusy(false); }
  };
  const openHistory = async (record) => {
    setBusy(true);
    try {
      const [adjustments, audit] = await Promise.all([
        listAdvanceAdjustments(kind, record.advanceNumber),
        listAdvanceAudit(kind, record.advanceNumber)
      ]);
      setHistoryRecord(record);
      setAdjustmentHistory(adjustments.adjustments || []);
      setAuditHistory(audit.events || []);
      setError('');
    } catch (historyError) {
      setError(`Advance history could not be loaded: ${historyError.message}`);
    } finally { setBusy(false); }
  };
  const handleReverseAdjustment = async (adjustment) => {
    if (!historyRecord || adjustment.voidedAt) return;
    const reason = window.prompt(`Reason for reversing adjustment ${adjustment.id}:`);
    if (!reason?.trim() || !window.confirm(`Reverse the ${adjustment.amount} ${adjustment.currency} adjustment against invoice ${adjustment.invoiceNumber}?`)) return;
    setBusy(true);
    try {
      await reverseAdvanceAdjustment(kind, historyRecord.advanceNumber, adjustment.id, historyRecord.version, reason.trim());
      const records = await reload();
      const updated = records.find((item) => item.advanceNumber === historyRecord.advanceNumber);
      if (updated) await openHistory(updated);
      await onRefresh();
    } catch (reverseError) {
      setError(`Adjustment reversal failed: ${reverseError.message}`);
    } finally { setBusy(false); }
  };

  const columns = [
    { key: 'advanceNumber', label: `${prefix} No.` },
    { key: 'date', label: 'Date' },
    { key: 'party', label: partyLabel },
    { key: 'amount', label: 'Amount' , render: (row) => `${money(row.amount, row.currency)} (${row.currency})` },
    { key: 'amountINR', label: 'Amount (INR)', align: 'right', render: (row) => money(row.amountINR, 'INR') },
    { key: 'appliedAmount', label: 'Applied', align: 'right', render: (row) => `${money(row.appliedAmount, row.currency)} ${row.currency}` },
    { key: 'balanceAmount', label: 'Advance Balance', align: 'right', render: (row) => `${money(row.balanceAmount, row.currency)} ${row.currency}` },
    { key: 'mode', label: 'Mode' },
    { key: 'reference', label: 'Reference / UTR', render: (row) => row.reference || '-' },
    { key: 'againstRef', label: againstLabel, render: (row) => row.againstRef || '-' }
  ];
  const exportCriteria = [...activeCriteria, ...(excludedUndated.length ? [`Undated advances excluded: ${excludedUndated.length}`] : [])];
  const pdfRows = filteredRows.map((row) => columns.map((column) => String(column.render ? column.render(row) : row[column.key] ?? '')));
  const filename = filenamer || title.replace(/\s+/g, '-');
  const handlePDF = () => generateRegisterPDF({
    title,
    subTitle: `${partyLabel}wise advance register`,
    columns: columns.map((column) => ({ header: column.label, align: column.align })),
    company: getReportCompanyProfile(),
    logoUrl,
    period: reportPeriod,
    filters: exportCriteria,
    rows: pdfRows,
    footer: columns.map((column, index) => index === 0 ? 'TOTAL' : column.key === 'amountINR' ? money(totalINR, 'INR') : ''),
    filename
  });
  const handleExcel = () => {
    const workbook = buildReportWorkbook({
      company: getReportCompanyProfile(),
      title,
      subTitle: `${partyLabel}wise advance register`,
      period: reportPeriod,
      filters: exportCriteria,
      reportModule: 'Finance',
      columns: columns.map((column) => ({ key: column.key, label: column.label })),
      rows: filteredRows,
      summaryTables: groupByParty ? [{
        title: `${partyLabel}-wise Summary`,
        columns: [{ key: 'party', label: partyLabel }, { key: 'count', label: 'Records' }, { key: 'amountINR', label: 'Amount (INR)' }],
        rows: partySummary
      }] : []
    });
    XLSX.writeFile(workbook, `${filename}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };
  const applyFilters = () => {
    const message = validateReportDateRange(draftFrom, draftTo);
    setFilterError(message);
    if (!message) setApplied({ from: draftFrom, to: draftTo, party: draftParty });
  };
  const resetFilters = () => {
    setDraftFrom('');
    setDraftTo('');
    setDraftParty('');
    setApplied({ from: '', to: '', party: '' });
    setFilterError('');
    setGroupByParty(false);
  };

  return (
    <div className="content-block" style={{ marginTop: '16px' }}>
      <div className="block-header">
        <h3 className="block-title">{title}</h3>
        <span className="muted-text">{loading ? 'Loading PostgreSQL records…' : `${filteredRows.length} record(s)`}</span>
      </div>

      <form className="form-grid" onSubmit={handleSave} style={{ marginBottom: '18px' }}>
        <div className="form-field">
          <label>{partyLabel} Name *</label>
          <input type="text" className="action-select form-input" list={partyList?.length ? `party-list-${kind}` : undefined}
            value={form.party} onChange={(event) => setForm({ ...form, party: event.target.value })} required />
          {partyList?.length > 0 && <datalist id={`party-list-${kind}`}>{partyList.map((party) => <option key={party} value={party} />)}</datalist>}
        </div>
        <div className="form-field">
          <label>Advance Date</label>
          <input type="date" className="action-select form-input" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} required />
        </div>
        <div className="form-field">
          <label>Amount *</label>
          <input type="number" min="0.0001" step="0.0001" className="action-select form-input" value={form.amount}
            onChange={(event) => setForm({ ...form, amount: event.target.value })} required />
        </div>
        <div className="form-field">
          <label>Currency</label>
          <select className="action-select" value={form.currency} onChange={(event) => setForm({
            ...form, currency: event.target.value, exchangeRateToINR: event.target.value === 'INR' ? '1' : ''
          })}>
            {CURRENCIES.map((currency) => <option key={currency.code} value={currency.code}>{currency.label}</option>)}
          </select>
        </div>
        {form.currency !== 'INR' && (
          <div className="form-field">
            <label>1 {form.currency} to INR *</label>
            <input type="number" min="0.00000001" step="0.00000001" className="action-select form-input"
              value={form.exchangeRateToINR} onChange={(event) => setForm({ ...form, exchangeRateToINR: event.target.value })} required />
          </div>
        )}
        <div className="form-field">
          <label>Payment Mode</label>
          <select className="action-select" value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value })}>
            <option value="Bank Transfer (NEFT/RTGS)">Bank Transfer (NEFT/RTGS)</option>
            <option value="Cheque">Cheque</option>
            <option value="UPI / Online">UPI / Online</option>
            <option value="Cash">Cash</option>
          </select>
        </div>
        <div className="form-field">
          <label>Reference / UTR No.</label>
          <input type="text" className="action-select form-input" value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} />
        </div>
        <div className="form-field">
          <label>{againstLabel} (informational)</label>
          <input type="text" className="action-select form-input" value={form.againstRef} onChange={(event) => setForm({ ...form, againstRef: event.target.value })} />
        </div>
        <div className="form-field">
          <label>Remarks</label>
          <input type="text" className="action-select form-input" value={form.remarks} onChange={(event) => setForm({ ...form, remarks: event.target.value })} />
        </div>
        <div className="form-field" style={{ minWidth: '240px' }}>
          <button type="submit" className="button-primary" disabled={busy || loading}>{editing ? 'Save Advance' : '+ Add Advance'}</button>
          {editing && <button type="button" className="button-secondary" onClick={resetForm}>Cancel Edit</button>}
        </div>
      </form>

      {error && <div role="alert" className="form-error">{error}</div>}
      {isAdmin() && <button type="button" className="button-secondary button-small" disabled={busy} onClick={handleLegacyPreview}>Preview Preserved Legacy Advances</button>}
      {migrationPreview && (
        <div className="content-block">
          <h4>Legacy import preview (no records are imported automatically)</h4>
          <p>Eligible: {migrationPreview.counts.eligible}; Existing: {migrationPreview.counts.existing}; Conflicts: {migrationPreview.counts.conflicts}</p>
          {migrationPreview.eligible.map((entry) => (
            <label key={entry.number} style={{ display: 'block' }}>
              <input type="checkbox" checked={migrationSelection.has(entry.number)} onChange={(event) => {
                setMigrationSelection((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(entry.number); else next.delete(entry.number);
                  return next;
                });
              }} />
              {entry.number} · {entry.payload.party} · {entry.payload.amount} INR
            </label>
          ))}
          {migrationPreview.conflicts.map((item, index) => <div key={`${item.number}-${index}`} className="field-hint">{item.number || '(missing number)'}: {item.reason}</div>)}
          <button type="button" className="button-primary" disabled={busy || migrationSelection.size === 0} onClick={handleLegacyImport}>Import Selected</button>
          <button type="button" className="button-secondary" onClick={() => setMigrationPreview(null)}>Close Preview</button>
        </div>
      )}

      <div className="report-filter-bar">
        <input aria-label="From date" type="date" className="action-select form-input" value={draftFrom} onChange={(event) => { setDraftFrom(event.target.value); setFilterError(''); }} />
        <span>to</span>
        <input aria-label="To date" type="date" className="action-select form-input" value={draftTo} onChange={(event) => { setDraftTo(event.target.value); setFilterError(''); }} />
        <select aria-label={partyLabel} className="action-select" value={draftParty} onChange={(event) => setDraftParty(event.target.value)}>
          <option value="">All {partyLabel}s</option>
          {[...new Set(list.map((record) => record.party).filter(Boolean))].sort().map((party) => <option key={party} value={party}>{party}</option>)}
        </select>
        <label><input type="checkbox" checked={groupByParty} onChange={(event) => setGroupByParty(event.target.checked)} /> Group by {partyLabel}</label>
        <button type="button" className="button-primary button-small" onClick={applyFilters}>Apply Filters</button>
        <button type="button" className="button-secondary button-small" onClick={resetFilters}>Reset Filters</button>
        {filterError && <span className="form-error" role="alert">{filterError}</span>}
        {excludedUndated.length > 0 && <details><summary>{excludedUndated.length} undated advance(s) excluded by the selected range</summary><ul>{excludedUndated.map((record) => <li key={record.advanceNumber}>{record.advanceNumber}: no valid advance date</li>)}</ul></details>}
        {activeCriteria.length > 0 && <span className="field-hint">Filters: {activeCriteria.join(' | ')}</span>}
        <button type="button" className="button-secondary button-small" onClick={handlePDF}>Download PDF</button>
        <button type="button" className="button-secondary button-small" onClick={handleExcel}>Download Excel</button>
        <button type="button" className="button-secondary button-small" onClick={() => window.print()}>Print</button>
      </div>
      {groupByParty && partySummary.length > 0 && (
        <div className="content-block"><h4>{partyLabel}-wise filtered summary</h4>
          <table className="history-table report-table"><thead><tr><th>{partyLabel}</th><th>Records</th><th>Amount (INR)</th></tr></thead>
            <tbody>{partySummary.map((entry) => <tr key={entry.party}><td>{entry.party}</td><td>{entry.count}</td><td>{money(entry.amountINR, 'INR')}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <div className="report-export-meta">{activeCriteria.length ? activeCriteria.join(' | ') : 'No filters applied'}</div>
      <div className="report-period-label">{reportPeriod}</div>
      <div className="history-table-wrapper">
        <table className="history-table report-table">
          <thead><tr>{columns.map((column) => <th key={column.key} style={{ textAlign: column.align === 'right' ? 'right' : 'left' }}>{column.label}</th>)}<th>Action</th></tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={columns.length + 1} className="no-history-row">Loading advances from PostgreSQL…</td></tr>
              : filteredRows.length === 0 ? <tr><td colSpan={columns.length + 1} className="no-history-row">No advances recorded yet.</td></tr>
                : filteredRows.map((record) => (
                  <tr key={record.advanceNumber}>
                    {columns.map((column) => <td key={column.key} style={{ textAlign: column.align === 'right' ? 'right' : 'left' }}>{column.render ? column.render(record) : record[column.key] || '-'}</td>)}
                    <td>
                      <button type="button" className="button-secondary button-small" disabled={busy} onClick={() => handleEdit(record)}>Edit</button>
                      {record.balanceAmount > 0 && <button type="button" className="button-secondary button-small" disabled={busy} onClick={() => { setAdjusting(record); setAdjustmentForm({ invoiceNumber: '', amount: '' }); }}>Adjust</button>}
                      <button type="button" className="button-secondary button-small" disabled={busy} onClick={() => openHistory(record)}>History</button>
                      {isAdmin() && <button type="button" className="button-secondary button-small button-delete" disabled={busy} onClick={() => handleDelete(record)}>Delete</button>}
                    </td>
                  </tr>
                ))}
          </tbody>
          {filteredRows.length > 0 && <tfoot><tr><td colSpan={4} style={{ fontWeight: 'bold', textAlign: 'right' }}>TOTAL ADVANCES (INR EQUIVALENT):</td><td style={{ fontWeight: 'bold', textAlign: 'right' }}>{money(totalINR, 'INR')}</td><td colSpan={columns.length - 5 + 1}></td></tr></tfoot>}
        </table>
      </div>
      {adjusting && (
        <form className="content-block form-grid" onSubmit={handleApplyAdjustment}>
          <h4>Adjust {adjusting.advanceNumber} against an invoice</h4>
          <div className="form-field">
            <label>Invoice *</label>
            <select className="action-select" value={adjustmentForm.invoiceNumber} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, invoiceNumber: event.target.value })} required>
              <option value="">Select matching {adjusting.currency} invoice</option>
              {filteredInvoices.map((invoice) => <option key={invoice.reference || invoice.invoiceNumber} value={invoice.reference || invoice.invoiceNumber}>
                {invoice.reference || invoice.invoiceNumber} · Due {money(invoiceDue(invoice), adjusting.currency)}
              </option>)}
            </select>
            {filteredInvoices.length === 0 && <span className="field-hint">No matching-currency outstanding invoices are available for this party.</span>}
          </div>
          <div className="form-field">
            <label>Adjustment amount ({adjusting.currency}) *</label>
            <input type="number" min="0.0001" max={adjusting.balanceAmount} step="0.0001" className="action-select form-input" value={adjustmentForm.amount}
              onChange={(event) => setAdjustmentForm({ ...adjustmentForm, amount: event.target.value })} required />
          </div>
          <button type="submit" className="button-primary" disabled={busy || filteredInvoices.length === 0}>Apply Advance</button>
          <button type="button" className="button-secondary" onClick={() => setAdjusting(null)}>Cancel</button>
        </form>
      )}
      {historyRecord && (
        <div className="content-block">
          <div className="block-header">
            <h4>Adjustment and audit history · {historyRecord.advanceNumber}</h4>
            <button type="button" className="button-secondary" onClick={() => setHistoryRecord(null)}>Close</button>
          </div>
          <h5>Invoice adjustments</h5>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead><tr><th>Invoice</th><th>Amount</th><th>Created</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>{adjustmentHistory.length ? adjustmentHistory.map((adjustment) => (
                <tr key={adjustment.id}>
                  <td>{adjustment.invoiceNumber}</td><td>{money(adjustment.amount, adjustment.currency)} {adjustment.currency}</td>
                  <td>{adjustment.createdAt}</td><td>{adjustment.voidedAt ? `Reversed · ${adjustment.voidedAt}` : 'Active'}</td>
                  <td>{!adjustment.voidedAt && <button type="button" className="button-secondary button-small" disabled={busy || !isAdmin()} onClick={() => handleReverseAdjustment(adjustment)}>Reverse</button>}</td>
                </tr>
              )) : <tr><td colSpan="5" className="no-history-row">No invoice adjustments recorded.</td></tr>}</tbody>
            </table>
          </div>
          <h5>Audit events</h5>
          <div className="history-table-wrapper">
            <table className="history-table">
              <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Role</th><th>Reason</th></tr></thead>
              <tbody>{auditHistory.length ? auditHistory.map((event, index) => (
                <tr key={`${event.action}-${event.createdAt}-${index}`}><td>{event.createdAt}</td><td>{event.action}</td><td>{event.actor}</td><td>{event.role}</td><td>{event.reason || '—'}</td></tr>
              )) : <tr><td colSpan="5" className="no-history-row">No audit events recorded.</td></tr>}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdvanceRegister;
