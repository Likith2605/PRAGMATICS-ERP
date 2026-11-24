import React, { useMemo, useState } from 'react';
import { generateRegisterPDF } from '../services/pdfGenerator.js';
import * as XLSX from 'xlsx';
import { getReportCompanyProfile } from '../utils/reportData.js';
import { buildReportWorkbook } from '../utils/reportExports.js';
import { applyReportFilters, validateReportDateRange } from '../utils/reportFilters.js';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';

const parseINR = (v) => Number(String(v || '').replace(/[^0-9.-]/g, '')) || 0;

const DefaultState = {
  date: new Date().toISOString().slice(0, 10),
  party: '',
  amount: '',
  mode: 'Bank Transfer (NEFT/RTGS)',
  reference: '',
  againstRef: '',
  remarks: ''
};

const AdvanceRegister = ({
  storageKey,
  title,
  filenamer,
  partyLabel,
  prefix,
  againstLabel = 'Against Invoice / Order',
  partyList = null,
  searchQuery = ''
}) => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const [list, setList] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '[]');
    } catch {
      return [];
    }
  });
  const [form, setForm] = useState({ ...DefaultState });
  const [error, setError] = useState('');
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [draftParty, setDraftParty] = useState('');
  const [applied, setApplied] = useState({ from: '', to: '', party: '' });
  const [filterError, setFilterError] = useState('');
  const [groupByParty, setGroupByParty] = useState(false);

  const save = (next) => {
    setList(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  };

  const nextNumber = () => {
    let max = 0;
    list.forEach((a) => {
      const m = String(a.advanceNumber || '').match(/(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    const fy = new Date().getFullYear().toString().slice(-2);
    return `${prefix}-${fy}${String(max + 1).padStart(4, '0')}`;
  };

  const handleAdd = (e) => {
    e.preventDefault();
    if (!form.party.trim()) return setError('Party name is required.');
    if (!form.amount || parseINR(form.amount) <= 0) return setError('Enter a valid advance amount.');
    setError('');
    const rec = {
      advanceNumber: nextNumber(),
      date: form.date,
      party: form.party.trim(),
      amount: parseINR(form.amount),
      mode: form.mode,
      reference: form.reference.trim(),
      againstRef: form.againstRef.trim(),
      remarks: form.remarks.trim()
    };
    const next = [rec, ...list];
    save(next);
    setForm({ ...DefaultState });
  };

  const handleDelete = (idx) => {
    const next = list.filter((_, i) => i !== idx);
    save(next);
  };

  const { filteredRows: datePartyRows, excludedUndated } = useMemo(() => applyReportFilters({
    rows: list, dateField: 'date', from: applied.from, to: applied.to,
    filters: [{ key: 'party', match: (row, value) => row.party === value }], selections: { party: applied.party }
  }), [list, applied]);
  const filteredRows = useMemo(() => {
    const query = String(searchQuery || '').trim().toLocaleLowerCase();
    return query ? datePartyRows.filter((row) => [row.advanceNumber, row.date, row.party, row.amount, row.reference, row.againstRef, row.mode, row.remarks].some((value) => String(value ?? '').toLocaleLowerCase().includes(query))) : datePartyRows;
  }, [datePartyRows, searchQuery]);
  const total = useMemo(() => filteredRows.reduce((acc, a) => acc + parseINR(a.amount), 0), [filteredRows]);
  const activeCriteria = [(applied.from || applied.to) && `Date: ${applied.from || 'any'} to ${applied.to || 'any'}`, applied.party && `${partyLabel}: ${applied.party}`, groupByParty && `Grouped by ${partyLabel}`].filter(Boolean);
  const reportPeriod = `Period: ${applied.from || 'start'} to ${applied.to || 'today'}`;
  const exportCriteria = [...activeCriteria, ...(excludedUndated.length ? [`Undated advances excluded: ${excludedUndated.length}`] : [])];
  const exceptionTables = excludedUndated.length ? [{ title: 'Undated Advance Exceptions', columns: [{ key: 'advanceNumber', header: `${prefix} No.` }, { key: 'exception', header: 'Date Status' }], rows: excludedUndated.map((record) => ({ advanceNumber: record.advanceNumber, exception: 'Missing or invalid advance date' })) }] : [];

  const applyFilters = () => {
    const message = validateReportDateRange(draftFrom, draftTo);
    setFilterError(message);
    if (message) return;
    setApplied({ from: draftFrom, to: draftTo, party: draftParty });
  };
  const resetFilters = () => { setDraftFrom(''); setDraftTo(''); setDraftParty(''); setApplied({ from: '', to: '', party: '' }); setFilterError(''); setGroupByParty(false); };

  const columns = [
    { key: 'advanceNumber', label: `${prefix} No.` },
    { key: 'date', label: 'Date' },
    { key: 'party', label: partyLabel },
    { key: 'amount', label: 'Amount (₹)', align: 'right', render: (r) => r.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 }) },
    { key: 'mode', label: 'Mode' },
    { key: 'reference', label: 'Reference / UTR', render: (r) => r.reference || '-' },
    { key: 'againstRef', label: againstLabel, render: (r) => r.againstRef || '-' }
  ];

  const handlePDF = () => {
    generateRegisterPDF({
      title,
      subTitle: `${partyLabel}wise advance register`,
      columns: columns.map((c) => ({ header: c.label, align: c.align, width: c.width })),
      company: getReportCompanyProfile(),
      logoUrl,
      period: reportPeriod,
      filters: exportCriteria,
      summaryTables: [...(groupByParty ? [{ title: `${partyLabel}-wise Summary`, columns: [{ key: 'party', header: partyLabel }, { key: 'count', header: 'Records' }, { key: 'amount', header: 'Amount (INR)' }], rows: partySummary }] : []), ...exceptionTables],
      rows: filteredRows.map((r) => columns.map((c) => String(c.render ? c.render(r) : r[c.key] ?? ''))),
      footer: columns.map((c, i) => (i === 0 ? 'TOTAL' : c.key === 'amount' ? total.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '')),
      filename: filenamer || title.replace(/\s+/g, '-')
    });
  };
  const handleExcel = () => {
    const workbook = buildReportWorkbook({ company: getReportCompanyProfile(), title, subTitle: `${partyLabel}wise advance register`, period: reportPeriod, filters: exportCriteria, reportModule: 'Finance', columns: columns.map((column) => ({ key: column.key, label: column.label })), rows: filteredRows, summaryTables: [...(groupByParty ? [{ title: `${partyLabel}-wise Summary`, columns: [{ key: 'party', label: partyLabel }, { key: 'count', label: 'Records' }, { key: 'amount', label: 'Amount (INR)' }], rows: partySummary }] : []), ...exceptionTables] });
    XLSX.writeFile(workbook, `${filenamer || title.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };
  const partySummary = Object.values(filteredRows.reduce((map, record) => { map[record.party] = map[record.party] || { party: record.party, count: 0, amount: 0 }; map[record.party].count += 1; map[record.party].amount += parseINR(record.amount); return map; }, {}));

  return (
    <div className="content-block" style={{ marginTop: '16px' }}>
      <div className="block-header">
        <h3 className="block-title">{title}</h3>
        <span className="muted-text">{filteredRows.length} record(s)</span>
      </div>

      <form className="form-grid" onSubmit={handleAdd} style={{ marginBottom: '18px' }}>
        <div className="form-field">
          <label>{partyLabel} Name *</label>
          <input
            type="text"
            className="action-select form-input"
            list={partyList && partyList.length ? `party-list-${prefix}` : undefined}
            value={form.party}
            onChange={(e) => setForm({ ...form, party: e.target.value })}
            placeholder={`e.g. ${partyLabel}`}
          />
          {partyList && partyList.length > 0 && (
            <datalist id={`party-list-${prefix}`}>
              {partyList.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          )}
        </div>
        <div className="form-field">
          <label>Advance Date</label>
          <input
            type="date"
            className="action-select form-input"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
        </div>
        <div className="form-field">
          <label>Amount (₹) *</label>
          <input
            type="number"
            min="0"
            step="0.01"
            className="action-select form-input"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            placeholder="e.g. 50000"
          />
        </div>
        <div className="form-field">
          <label>Payment Mode</label>
          <select
            className="action-select"
            value={form.mode}
            onChange={(e) => setForm({ ...form, mode: e.target.value })}
          >
            <option value="Bank Transfer (NEFT/RTGS)">Bank Transfer (NEFT/RTGS)</option>
            <option value="Cheque">Cheque</option>
            <option value="UPI / Online">UPI / Online</option>
            <option value="Cash">Cash</option>
          </select>
        </div>
        <div className="form-field">
          <label>Reference / UTR No.</label>
          <input
            type="text"
            className="action-select form-input"
            value={form.reference}
            onChange={(e) => setForm({ ...form, reference: e.target.value })}
            placeholder="e.g. UTR-9823412341"
          />
        </div>
        <div className="form-field">
          <label>{againstLabel}</label>
          <input
            type="text"
            className="action-select form-input"
            value={form.againstRef}
            onChange={(e) => setForm({ ...form, againstRef: e.target.value })}
            placeholder="e.g. INV-... / PO-..."
          />
        </div>
        <div className="form-field" style={{ minWidth: '240px' }}>
          <button type="submit" className="button-primary">+ Add Advance</button>
        </div>
      </form>

      {error && <div className="form-error">{error}</div>}

      <div className="report-filter-bar">
        <input aria-label="From date" type="date" className="action-select form-input" value={draftFrom} onChange={(event) => { setDraftFrom(event.target.value); setFilterError(''); }} />
        <span>to</span>
        <input aria-label="To date" type="date" className="action-select form-input" value={draftTo} onChange={(event) => { setDraftTo(event.target.value); setFilterError(''); }} />
        <select aria-label={partyLabel} className="action-select" value={draftParty} onChange={(event) => setDraftParty(event.target.value)}><option value="">All {partyLabel}s</option>{[...new Set(list.map((record) => record.party).filter(Boolean))].sort().map((party) => <option key={party} value={party}>{party}</option>)}</select>
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
      {groupByParty && partySummary.length > 0 && <div className="content-block"><h4>{partyLabel}-wise filtered summary</h4><table className="history-table report-table"><thead><tr><th>{partyLabel}</th><th>Records</th><th>Amount (₹)</th></tr></thead><tbody>{partySummary.map((entry) => <tr key={entry.party}><td>{entry.party}</td><td>{entry.count}</td><td>{entry.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td></tr>)}</tbody></table></div>}
      <div className="report-export-meta">{activeCriteria.length ? activeCriteria.join(' | ') : 'No filters applied'}</div>

      <div className="report-period-label">{reportPeriod}</div>
      <div className="history-table-wrapper">
        <table className="history-table report-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} style={{ textAlign: c.align === 'right' ? 'right' : 'left' }}>{c.label}</th>
              ))}
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 1} className="no-history-row">
                  No advances recorded yet.
                </td>
              </tr>
            ) : (
              filteredRows.map((a) => (
                <tr key={a.advanceNumber || `${a.date}-${a.party}-${a.reference}`}>
                  {columns.map((c) => (
                    <td key={c.key} style={{ textAlign: c.align === 'right' ? 'right' : 'left' }}>
                      {c.render ? c.render(a) : a[c.key] ?? '-'}
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="button-secondary button-small button-delete"
                      onClick={() => handleDelete(list.indexOf(a))}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {filteredRows.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={3} style={{ fontWeight: 'bold', textAlign: 'right' }}>TOTAL {partyLabel.toUpperCase()}:</td>
                <td style={{ fontWeight: 'bold', textAlign: 'right' }}>
                  ₹ {total.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
                <td colSpan={columns.length - 3 + 1}></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
};

export default AdvanceRegister;
