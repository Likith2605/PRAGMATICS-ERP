import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import { CUSTOMER_PO_EXCEL_COLUMNS, parseCustomerPOExcelRows, readCustomerPOWorkbook } from '../utils/customerPOExcelImport.js';
import { buildInventoryImportTemplateWorkbook } from '../utils/inventoryExcelImport.js';

const esc = (v) => /^[=+@\-\t\r]/.test(String(v ?? '')) ? `'${v}` : v;

export const downloadImportTemplate = (title, columns, example, instructions) => {
  const wb = XLSX.utils.book_new();
  if (title === 'Inventory Items') {
    XLSX.writeFile(buildInventoryImportTemplateWorkbook(example), `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-import-template.xlsx`);
    return;
  }
  if (title === 'Customer Purchase Orders') {
    const sheet = XLSX.utils.aoa_to_sheet([CUSTOMER_PO_EXCEL_COLUMNS]);
    sheet['!cols'] = [8, 18, 14, 28, 42, 14, 20, 18, 16, 18, 28].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, sheet, 'Import');
    XLSX.writeFile(wb, `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-import-template.xlsx`);
    return;
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([columns, example].map((row) => row.map(esc))), 'Import');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Instructions'], ...instructions.map((line) => [line])]), 'Instructions');
  XLSX.writeFile(wb, `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-import-template.xlsx`);
};

export default function ExcelImportDialog({ title, columns, example, instructions, validate, onImport, onClose, allowDrop = true, existingRecords = [], mapRow = null, warningKey = null, existingWarningKeys = [] }) {
  const inputRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [sourceRowOffset, setSourceRowOffset] = useState(0);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [summary, setSummary] = useState(null);
  const [serverRejected, setServerRejected] = useState([]);
  const [serverOutcomes, setServerOutcomes] = useState([]);
  const [importStats, setImportStats] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const isCustomerPO = title === 'Customer Purchase Orders';
  const results = useMemo(() => {
    if (isCustomerPO) return parseCustomerPOExcelRows(rows, validate, sourceRowOffset);
    const keyFields = title === 'Inventory Items' ? ['Item Code'] : [];
    const counts = new Map();
    keyFields.forEach((field) => rows.forEach((row, index) => { const key = String(row[field] || '').trim().toLowerCase(); if (key && !counts.has(`${field}:${key}`)) counts.set(`${field}:${key}`, index); }));
    const warningFirstIndex = new Map();
    if (warningKey) rows.forEach((row, index) => {
      const key = warningKey(row);
      if (key && !warningFirstIndex.has(key)) warningFirstIndex.set(key, index);
    });
    const existingWarningSet = new Set(existingWarningKeys);
    const groupHeaders = new Map();
    if (title === 'Customer Purchase Orders') rows.forEach((row, index) => {
      const key = String(row['Customer PO Number'] || '').trim().toLowerCase();
      if (!key) return;
      const prior = groupHeaders.get(key);
      if (!prior) groupHeaders.set(key, { indexes: [index] });
      else prior.indexes.push(index);
    });
    const inconsistentRows = new Set();
    groupHeaders.forEach(({ indexes }) => {
      const distinct = new Set(indexes.map((index) => ['PO Date', 'Project ID', 'Customer Code', 'Customer Name', 'Delivery Date'].map((field) => String(rows[index][field] || '').trim().toLowerCase()).join('|')));
      if (distinct.size > 1) indexes.forEach((index) => inconsistentRows.add(index));
    });
    const evaluated = rows.map((row, i) => {
      const errors = validate(row, i) || [];
      keyFields.forEach((field) => {
        const key = String(row[field] || '').trim().toLowerCase();
        const firstIndex = counts.get(`${field}:${key}`);
        if (key && firstIndex !== undefined && i > firstIndex && !errors.some((error) => error.includes(field) && /duplicate/i.test(error))) errors.push(`Duplicate ${field} in file; first occurrence will be imported`);
      });
      if (inconsistentRows.has(i)) errors.push('Rows for this Customer PO Number must use the same date, project, customer and delivery date');
      const warnings = [];
      if (warningKey) {
        const key = warningKey(row);
        if (key && existingWarningSet.has(key)) warnings.push('Exact duplicate of an existing customer — warning only');
        else if (key && warningFirstIndex.get(key) !== undefined && i > warningFirstIndex.get(key)) warnings.push('Exact duplicate of another row in this file — warning only');
      }
      return { row, rowNumber: i + 2, errors, warnings };
    });
    if (title === 'Customer Purchase Orders') {
      const byPO = new Map();
      evaluated.forEach((entry, index) => {
        const key = String(entry.row['Customer PO Number'] || '').trim().toLowerCase();
        if (key) { if (!byPO.has(key)) byPO.set(key, []); byPO.get(key).push(index); }
      });
      byPO.forEach((indexes) => {
        if (indexes.some((index) => evaluated[index].errors.length)) indexes.forEach((index) => {
          if (!evaluated[index].errors.length) evaluated[index].errors.push('This Customer PO has another invalid item row; no part of the PO will be imported');
        });
      });
    }
    return evaluated;
  }, [rows, validate, title, isCustomerPO, sourceRowOffset, warningKey, existingWarningKeys]);
  const existingByPONumber = useMemo(() => new Map(existingRecords.map((record) => [String(record.reference || record.poNumber || '').trim().toLowerCase(), record])), [existingRecords]);
  const previewGroups = useMemo(() => isCustomerPO ? results.map((group) => {
    const existing = existingByPONumber.get(String(group.poNumber || '').trim().toLowerCase());
    const conflicts = [];
    if (existing) {
      if (String(existing.customerName || existing.company || '').trim().toLowerCase() !== String(group.customerName || '').trim().toLowerCase()) conflicts.push('Customer Name conflicts with the existing PO header; review required.');
      if (String(existing.date || '').slice(0, 10) !== String(group.poDate || '').slice(0, 10)) conflicts.push('PO Date conflicts with the existing PO header; review required.');
    }
    const storedItems = Array.isArray(existing?.payload?.items) ? existing.payload.items : [];
    const pendingItems = [];
    const itemStatuses = [];
    let skippedItems = 0;
    const same = (stored, incoming) => {
      const number = (value) => Number.isFinite(Number(value)) ? Number(value).toFixed(8) : '';
      return String(stored?.description || stored?.itemName || stored?.itemDescription || '').trim().toLowerCase() === String(incoming.description || '').trim().toLowerCase() &&
        number(stored?.quantity) === number(incoming.quantity) &&
        number(stored?.deliveredQuantity ?? stored?.deliveredQty) === number(incoming.deliveredQuantity) &&
        number(stored?.balanceQuantity ?? stored?.balanceQty) === number(incoming.balanceQuantity) &&
        number(stored?.unitPrice) === number(incoming.unitPrice) && number(stored?.amount) === number(incoming.amount);
    };
    group.items.forEach((item) => {
      if (storedItems.some((stored) => same(stored, item)) || pendingItems.some((pending) => same(pending, item))) {
        skippedItems += 1;
        itemStatuses.push('Identical item exists; this row will be skipped.');
      } else {
        pendingItems.push(item);
        itemStatuses.push('New item row.');
      }
    });
    return { ...group, existing, conflicts, itemStatuses, previewNewItems: pendingItems.length, previewSkippedItems: skippedItems };
  }) : [], [isCustomerPO, results, existingByPONumber]);
  const errorsFor = (group) => [...(group.errors || []), ...(group.conflicts || [])];
  const valid = isCustomerPO ? previewGroups.filter((group) => !errorsFor(group).length) : results.filter((r) => !r.errors.length);
  const invalid = isCustomerPO
    ? previewGroups.filter((group) => errorsFor(group).length).map((group) => ({ ...group, errors: errorsFor(group) }))
    : results.filter((r) => r.errors.length);
  const importable = isCustomerPO ? valid : valid.filter((row) => includeDuplicates || !row.warnings.length);
  const skippedDuplicates = isCustomerPO ? 0 : valid.length - importable.length;
  const duplicate = isCustomerPO
    ? new Set([
      ...results.filter((r) => r.errors.some((e) => /duplicate/i.test(e))).map((r) => r.poNumber.trim().toLowerCase()),
      ...serverRejected.filter((r) => r.status === 'duplicate').map((r) => String(r.poNumber || '').trim().toLowerCase())
    ].filter(Boolean)).size
    : title === 'Customer Purchase Orders'
    ? new Set(results.filter((r) => r.errors.some((e) => /duplicate/i.test(e))).map((r) => String(r.row['Customer PO Number'] || `row-${r.rowNumber}`).trim().toLowerCase())).size
    : results.filter((r) => (r.warnings || []).length).length;
  const missing = isCustomerPO
    ? new Set(results.filter((r) => r.errors.some((e) => /required|mandatory|missing/i.test(e))).map((r) => r.poNumber.trim().toLowerCase() || `row-${r.rowNumber}`)).size
    : title === 'Customer Purchase Orders'
    ? new Set(results.filter((r) => r.errors.some((e) => /required|mandatory|missing/i.test(e))).map((r) => String(r.row['Customer PO Number'] || `row-${r.rowNumber}`).trim().toLowerCase())).size
    : results.filter((r) => r.errors.some((e) => /required|mandatory|missing/i.test(e))).length;
  const totalRecords = results.length;
  const validRecords = valid.length;
  const invalidRecords = totalRecords - validRecords;
  const totalItemRows = isCustomerPO ? results.reduce((sum, group) => sum + group.items.length, 0) : 0;
  const previewStats = isCustomerPO ? {
    newHeaders: previewGroups.filter((group) => !group.errors.length && !group.conflicts.length && !group.existing).length,
    existingHeaders: previewGroups.filter((group) => !group.errors.length && !group.conflicts.length && group.existing && group.previewNewItems > 0).length,
    newItems: previewGroups.filter((group) => !group.errors.length && !group.conflicts.length).reduce((sum, group) => sum + group.previewNewItems, 0),
    skippedItems: previewGroups.reduce((sum, group) => sum + group.previewSkippedItems, 0),
    invalid: invalidRecords
  } : null;

  const readFile = async (file) => {
    if (!file) return;
    setServerRejected([]);
    setServerOutcomes([]);
    setImportStats(null);
    setRows([]);
    setSourceRowOffset(0);
    setIncludeDuplicates(false);
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) { setRows([]); setFileName(file.name); setSummary({ error: 'Choose an .xlsx, .xls, or .csv file.' }); return; }
    setBusy(true); setSummary(null); setFileName(file.name);
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array', cellDates: true, formula: false, dense: title !== 'Customer Purchase Orders' });
      if (title === 'Customer Purchase Orders') {
        const detected = readCustomerPOWorkbook(wb);
        if (!detected.populatedRows) throw new Error(`Worksheet "${detected.sheetName}" has the required headings at row ${detected.headerRowNumber}, but no PO item rows follow them.`);
        setRows(detected.rows);
        setSourceRowOffset(detected.headerRowNumber - 1);
        return;
      }
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const parsed = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false, blankrows: false });
      if (parsed.length > 5000) throw new Error('Files are limited to 5,000 data rows.');
      if (!parsed.length) throw new Error('The first sheet has no data rows.');
      const projectRow = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [String(k).trim(), typeof v === 'string' ? v.trim() : v]));
      const normalized = parsed
        .map((row) => mapRow ? mapRow(title === 'Customers' ? row : projectRow(row)) : projectRow(row))
        .filter((row) => title !== 'Customers' || Object.values(row).some((value) => value !== null && value !== undefined && value !== ''));
      setRows(normalized);
    } catch (error) { setRows([]); setSummary({ error: error.message || 'Could not read this file.' }); }
    finally { setBusy(false); }
  };
  const downloadErrors = () => {
    const data = isCustomerPO
      ? [
        ...invalid.flatMap((group) => group.rows.map((row) => ({ ...row, 'Import Errors': group.errors.join('; ') }))),
        ...serverRejected.flatMap((outcome) => {
          const group = results.find((entry) => entry.poNumber.toLowerCase() === String(outcome.poNumber || '').toLowerCase());
          return (group?.rows || []).map((row) => ({ ...row, 'Import Errors': (outcome.errors || ['Database rejected this PO.']).join('; ') }));
        })
      ]
      : invalid.map(({ row, rowNumber, errors }) => ({ 'Source Row': rowNumber, ...row, 'Import Errors': errors.join('; ') }));
    const ws = XLSX.utils.json_to_sheet(data.map((record) => Object.fromEntries(Object.entries(record).map(([k, v]) => [k, esc(v)]))));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Rejected Rows'); XLSX.writeFile(wb, `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-import-errors.xlsx`);
  };
  const confirm = async () => {
    if (!importable.length || busy || savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    setSaving(true);
    setSummary(null);
    try {
      const result = await onImport(importable.map((r) => r.row));
      const outcomes = result?.outcomes || [];
      setServerOutcomes(outcomes);
      setServerRejected(outcomes.filter((outcome) => ['duplicate', 'review', 'invalid', 'failed'].includes(outcome.status)));
      setImportStats({
        newHeaders: result?.newHeaders ?? result?.imported ?? 0,
        existingHeaders: result?.existingHeaders ?? 0,
        newItems: result?.newItems ?? 0,
        skippedItems: result?.skippedItems ?? 0,
        invalid: (result?.invalid ?? 0) + (result?.conflicts ?? 0) + invalid.length
      });
      setSummary({
        completed: true,
        success: result?.newHeaders ?? result?.imported ?? result?.success ?? 0,
        skipped: (result?.skippedItems ?? result?.skipped ?? 0) + skippedDuplicates,
        failed: result?.failed || 0
      });
      if (result?.persisted) {
        window.setTimeout(() => onClose(), 1200);
      }
    }
    catch (error) { setSummary({ error: error.message || 'Save failed. No records were saved. Please review and try again.' }); }
    finally {
      savingRef.current = false;
      setSaving(false);
      setBusy(false);
    }
  };
  return createPortal(<div role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()} style={{ position: 'fixed', inset: 0, zIndex: 1400, background: 'rgba(15,23,42,.55)', display: 'grid', placeItems: 'center', padding: 16 }}>
    <section role="dialog" aria-modal="true" aria-labelledby="excel-import-title" className={`content-block${title === 'Customers' ? ' customer-excel-import' : ''}`} style={{ width: 'min(1080px, 100%)', maxHeight: '92vh', overflow: 'auto', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}><h2 id="excel-import-title" style={{ margin: 0 }}>Import {title}</h2><button type="button" className="button-secondary" onClick={onClose} disabled={busy} aria-label="Close"><X size={17}/></button></header>
      <p style={{ color: '#64748b', margin: '8px 0 16px' }}>Upload .xlsx, .xls, or .csv Â· Maximum 5,000 rows. Existing records are skipped.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}><button type="button" className="button-secondary" onClick={() => downloadImportTemplate(title, columns, example, instructions)}><Download size={16}/> Download Template</button><button type="button" className="button-secondary" onClick={() => inputRef.current?.click()}><Upload size={16}/> Choose File</button><input ref={inputRef} hidden type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { const file = e.target.files?.[0]; if (isCustomerPO) e.target.value = ''; readFile(file); }}/><span style={{ alignSelf: 'center', color: '#475569' }}>{fileName}</span></div>
      {allowDrop && <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); readFile(e.dataTransfer.files?.[0]); }} style={{ border: `1px dashed ${dragging ? '#2563eb' : '#94a3b8'}`, borderRadius: 8, padding: 12, color: '#64748b', marginBottom: 12, textAlign: 'center' }}><FileSpreadsheet size={16}/> Drop a spreadsheet here</div>}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '12px 0', color: '#334155' }}><span>Total {isCustomerPO ? 'PO records' : 'records'}: {totalRecords}</span>{isCustomerPO && <span>Total item rows: {totalItemRows}</span>}<span>{isCustomerPO ? 'Valid records' : 'Valid'}: {validRecords}</span><span>{isCustomerPO ? 'Invalid records' : 'Invalid'}: {invalidRecords}</span><span>{isCustomerPO ? 'Duplicate PO numbers' : warningKey ? 'Duplicate warnings' : 'Duplicate'}: {duplicate}</span><span>Missing required: {missing}</span></div>
      {isCustomerPO && rows.length > 0 && <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '8px 0', color: '#334155' }}><span>New PO headers: {importStats?.newHeaders ?? previewStats.newHeaders}</span><span>Existing PO headers receiving items: {importStats?.existingHeaders ?? previewStats.existingHeaders}</span><span>New item rows: {importStats?.newItems ?? previewStats.newItems}</span><span>Existing item rows skipped: {importStats?.skippedItems ?? previewStats.skippedItems}</span><span>Invalid records: {importStats?.invalid ?? previewStats.invalid}</span></div>}
      {busy && <div style={{ margin: '12px 0', color: '#1d4ed8', fontSize: 13 }}>
        {saving ? 'Saving customers…' : 'Reading spreadsheet…'}
        <progress style={{ width: '100%', display: 'block', marginTop: 6 }} />
      </div>}
      {summary && <div role={summary.error ? 'alert' : 'status'} style={{ padding: 12, margin: '12px 0', background: summary.error ? '#fef2f2' : '#f0fdf4', color: summary.error ? '#b91c1c' : '#166534' }}>{summary.error || (isCustomerPO
          ? `Import complete · ${summary.success} new PO header(s) · ${importStats?.existingHeaders || 0} existing header(s) updated · ${importStats?.newItems || 0} new item row(s) · ${importStats?.skippedItems || 0} identical item row(s) skipped · ${importStats?.invalid || 0} invalid / review record(s)`
          : `Save complete · ${summary.success} customer(s) saved · ${summary.skipped || 0} skipped (duplicate/invalid) · ${invalid.length} invalid row(s)`)}</div>}
      {isCustomerPO && rows.length > 0 && <div style={{ overflow: 'auto', maxHeight: 380, border: '1px solid #e2e8f0' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}><thead><tr>{['PO No', 'PO Date', 'Customer Name', 'Item Rows', 'Status / Validation'].map((c) => <th key={c} style={{ position: 'sticky', top: 0, background: '#f8fafc', padding: 8, textAlign: 'left' }}>{c}</th>)}</tr></thead><tbody>{previewGroups.map((group, index) => { const serverError = serverRejected.find((outcome) => String(outcome.poNumber || '').toLowerCase() === group.poNumber.toLowerCase()); const serverOutcome = serverOutcomes.find((outcome) => String(outcome.poNumber || '').toLowerCase() === group.poNumber.toLowerCase()); const errors = [...errorsFor(group), ...(serverError?.errors || [])]; const status = errors.length ? errors.join('; ') : serverOutcome?.message || (group.existing ? `Existing PO header · ${group.previewNewItems} new item row(s) · ${group.previewSkippedItems} identical item row(s) skipped` : 'New PO header'); return <React.Fragment key={`${group.poNumber}-${group.rowNumber}-${index}`}><tr><td style={{ padding: 8, borderTop: '1px solid #e2e8f0', background: errors.length ? '#fee2e2' : undefined }}>{group.poNumber || '(Missing PO No)'}</td><td style={{ padding: 8, borderTop: '1px solid #e2e8f0' }}>{String(group.poDate || '')}</td><td style={{ padding: 8, borderTop: '1px solid #e2e8f0' }}>{group.customerName}</td><td style={{ padding: 8, borderTop: '1px solid #e2e8f0' }}>{group.items.length}</td><td style={{ padding: 8, borderTop: '1px solid #e2e8f0', color: errors.length ? '#b91c1c' : '#15803d' }}>{status}</td></tr>{group.items.map((item, itemIndex) => <tr key={`${group.rowNumber}-item-${itemIndex}`}><td colSpan="2" style={{ padding: 6, borderTop: '1px solid #f1f5f9', color: '#64748b' }}>Item {itemIndex + 1}</td><td colSpan="3" style={{ padding: 6, borderTop: '1px solid #f1f5f9', color: '#334155' }}>{item.description} · {group.conflicts.length ? 'Review required' : group.itemStatuses[itemIndex]} · Qty {Number.isFinite(item.quantity) ? item.quantity : '—'} · Price {Number.isFinite(item.unitPrice) ? item.unitPrice : '—'} · Amount {Number.isFinite(item.amount) ? item.amount : '—'}</td></tr>)}</React.Fragment>;})}</tbody></table></div>}
      {!isCustomerPO && rows.length > 0 && <div style={{ overflow: 'auto', maxHeight: 380, border: '1px solid #e2e8f0' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}><thead><tr>{columns.map((c) => <th key={c} style={{ position: 'sticky', top: 0, background: '#f8fafc', padding: 8, textAlign: 'left' }}>{c}</th>)}</tr></thead><tbody>{results.map(({ row, rowNumber, errors, warnings }) => { const messages = [...errors, ...warnings].join('; '); return <tr key={rowNumber}>{columns.map((col) => { const value = row[col] ?? ''; const hasError = errors.some((err) => err.toLowerCase().includes(col.toLowerCase())); return <td key={col} title={messages || undefined} style={{ padding: 8, borderTop: '1px solid #e2e8f0', background: hasError ? '#fee2e2' : undefined }}>{String(value)}</td> })}</tr> })}</tbody></table></div>}
      <div style={{ color: '#64748b', fontSize: 12, marginTop: 12 }}>{instructions.map((line) => <div key={line}>{line}</div>)}</div>
      {!isCustomerPO && duplicate > 0 && !summary?.completed && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, color: '#92400e', fontSize: 13 }}>
          <input type="checkbox" checked={includeDuplicates} onChange={(event) => setIncludeDuplicates(event.target.checked)} />
          Import {duplicate} exact-duplicate row(s) too (duplicates are warnings, not automatic rejections)
        </label>
      )}
      <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>{(invalid.length > 0 || serverRejected.length > 0) && <button className="button-secondary" type="button" onClick={downloadErrors}>Download Error Report</button>}<button className="button-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>{!summary?.completed && <button className="button-primary" type="button" onClick={confirm} disabled={busy || !importable.length} style={title === 'Customers' ? { minWidth: 170 } : undefined}>{saving ? 'Saving…' : title === 'Customers' ? `Save Customers (${importable.length})` : `Confirm Import (${importable.length})`}</button>}</footer>
    </section>
  </div>, document.body);
}

