/**
 * Tally Export Page — Vyapar-style workflow.
 *
 * Single-screen transaction-based export:
 *   1. Select date range (presets or custom)
 *   2. Select transaction types (Sale, Purchase, Credit Note, Debit Note, Receipts, Payments)
 *   3. View actual ERP transactions in a filterable/sortable table
 *   4. Select individual rows (or Select All / Clear All)
 *   5. Click "Export to Tally" — validates, generates master.xml + voucher.xml, downloads
 *   6. Export history with statuses (Generated, Downloaded, Import confirmation pending, Import confirmed, Import failed)
 *
 * Masters are automatically identified from selected transactions — no separate
 * master selection step required.
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  buildTransactionRows,
  mapSelectedToTally,
  generateXml,
  saveExportHistory,
  storeExportFiles,
  fetchExportHistory,
  fetchExportRecord,
  downloadExportFile,
  updateExportStatus,
  downloadXmlContent,
  TransactionTypes,
  TRANSACTION_TYPE_LABELS,
  DEFAULT_SELECTED_TYPES,
  validateDateRange,
  computeDateRange,
  DATE_PRESETS,
  excludePreviouslyExportedRows,
  getPreviouslyExportedVoucherKeys
} from '../services/tallyExportService.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPORT_STATUSES = {
  GENERATED: 'generated',
  DOWNLOADED: 'downloaded',
  IMPORT_PENDING: 'import_pending',
  IMPORT_CONFIRMED: 'import_confirmed',
  IMPORT_FAILED: 'import_failed',
  FAILED: 'failed'
};

const STATUS_LABELS = {
  pending: 'Processing',
  [EXPORT_STATUSES.GENERATED]: 'Generated',
  [EXPORT_STATUSES.DOWNLOADED]: 'Downloaded',
  [EXPORT_STATUSES.IMPORT_PENDING]: 'Import Pending',
  [EXPORT_STATUSES.IMPORT_CONFIRMED]: 'Import Confirmed',
  [EXPORT_STATUSES.IMPORT_FAILED]: 'Import Failed',
  [EXPORT_STATUSES.FAILED]: 'Failed'
};

const STATUS_COLORS = {
  pending: '#2563eb',
  [EXPORT_STATUSES.GENERATED]: '#b45309',
  [EXPORT_STATUSES.DOWNLOADED]: '#166534',
  [EXPORT_STATUSES.IMPORT_PENDING]: '#2563eb',
  [EXPORT_STATUSES.IMPORT_CONFIRMED]: '#15803d',
  [EXPORT_STATUSES.IMPORT_FAILED]: '#b91c1c',
  [EXPORT_STATUSES.FAILED]: '#b91c1c'
};

const DEFAULT_PAGE_SIZE = 25;

const formatCurrency = (amount, currency = 'INR') => {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  }
};

// ---------------------------------------------------------------------------
// Tally Export Page (Vyapar-style)
// ---------------------------------------------------------------------------

const TallyExportPage = () => {
  // ---------- Date range ----------
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [datePeriod, setDatePeriod] = useState('custom');
  const [appliedDatePeriod, setAppliedDatePeriod] = useState(null);
  const [dateFilterApplied, setDateFilterApplied] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [dateError, setDateError] = useState('');

  // ---------- Transaction type selection ----------
  const [selectedTypes, setSelectedTypes] = useState([...DEFAULT_SELECTED_TYPES]);

  const handleToggleType = (key) => {
    setSelectedTypes((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const handleSelectAllTypes = () => {
    const allKeys = Object.values(TransactionTypes);
    if (selectedTypes.length === allKeys.length) {
      setSelectedTypes([]);
    } else {
      setSelectedTypes([...allKeys]);
    }
  };

  const allTypesSelected = selectedTypes.length === Object.values(TransactionTypes).length;

  // ---------- Build transaction rows ----------
  const [transactions, setTransactions] = useState([]);
  const [loadingTransactions, setLoadingTransactions] = useState(false);

  const loadTransactions = useCallback(async () => {
    setLoadingTransactions(true);
    try {
      if (!dateFilterApplied) {
        setTransactions([]);
        return;
      }
      const rows = buildTransactionRows({
        dateFrom,
        dateTo,
        selectedTypes
      });
      setTransactions(rows);
    } catch (err) {
      console.error('Failed to load transactions:', err);
    } finally {
      setLoadingTransactions(false);
    }
  }, [dateFrom, dateTo, dateFilterApplied, selectedTypes]);

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  useEffect(() => {
    setSelectedRowIds((current) => {
      const available = new Set(transactions.map((row) => row.id));
      return new Set([...current].filter((id) => available.has(id)));
    });
    setPage(1);
  }, [transactions]);

  // ---------- Table state: search, sort, filter, pagination, selection ----------
  const [searchQuery, setSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [typeFilter, setTypeFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [selectedRowIds, setSelectedRowIds] = useState(new Set());

  const toggleRowSelection = (id) => {
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllRows = (ids) => {
    setSelectedRowIds((current) => {
      const allSelected = ids.length > 0 && ids.every((id) => current.has(id));
      const next = new Set(current);
      ids.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  };

  const clearSelection = () => setSelectedRowIds(new Set());

  const selectedRows = useMemo(() => {
    const idSet = selectedRowIds;
    return transactions.filter((t) => idSet.has(t.id));
  }, [transactions, selectedRowIds]);

  const selectedAmountByCurrency = useMemo(() => selectedRows.reduce((totals, row) => {
    const currency = row.currency || 'INR';
    totals[currency] = (totals[currency] || 0) + Number(row.amount || 0);
    return totals;
  }, {}), [selectedRows]);

  // Filtered + sorted + paginated
  const filteredTransactions = useMemo(() => {
    let list = [...transactions];

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(
        (t) =>
          String(t.invoiceNo || '').toLowerCase().includes(q) ||
          String(t.partyName || '').toLowerCase().includes(q) ||
          String(t.transactionTypeLabel || '').toLowerCase().includes(q) ||
          String(t.projectId || '').toLowerCase().includes(q)
      );
    }

    // Type filter
    if (typeFilter !== 'all') {
      list = list.filter((t) => t.transactionType === typeFilter);
    }

    // Sort
    list.sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return list;
  }, [transactions, searchQuery, typeFilter, sortKey, sortDir]);

  const paginated = useMemo(() => {
    const start = (page - 1) * DEFAULT_PAGE_SIZE;
    return filteredTransactions.slice(start, start + DEFAULT_PAGE_SIZE);
  }, [filteredTransactions, page]);

  const totalPages = Math.max(1, Math.ceil(filteredTransactions.length / DEFAULT_PAGE_SIZE));

  useEffect(() => { setPage(1); }, [searchQuery, typeFilter]);

  // ---------- Export state ----------
  const [isExporting, setIsExporting] = useState(false);
  const [generatedXml, setGeneratedXml] = useState(null);
  const [exportResult, setExportResult] = useState(null); // { vouchers, invalid, warnings, masters, counts, totals }
  const [showValidation, setShowValidation] = useState(false);
  const [xmlValidation, setXmlValidation] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [exportHistory, setExportHistory] = useState([]);
  const [exportMessage, setExportMessage] = useState(null);
  const [lastExportId, setLastExportId] = useState(null);
  const exportInProgress = useRef(false);
  const previouslyExportedVoucherKeys = useMemo(() => getPreviouslyExportedVoucherKeys(exportHistory || []), [exportHistory]);

  // ---------- Export history loader (declared before handleExportToTally,
  // which references it in its useCallback dependency array) ----------
  const loadExportHistory = useCallback(async () => {
    try {
      const data = await fetchExportHistory();
      setExportHistory(data.exports || []);
    } catch (err) {
      console.warn('Could not load export history:', err.message);
    }
  }, []);

  const handleExportToTally = useCallback(async () => {
    if (datePeriod !== appliedDatePeriod || (datePeriod === 'custom' && (customFrom !== dateFrom || customTo !== dateTo))) {
      setExportMessage({ type: 'warning', text: 'Apply the edited From Date and To Date before exporting.' });
      return;
    }
    if (selectedRows.length === 0) {
      setExportMessage({ type: 'error', text: 'Select at least one transaction before exporting.' });
      return;
    }
    const rangeCheck = dateFrom || dateTo ? validateDateRange(dateFrom, dateTo) : { valid: true, message: '' };
    if (!rangeCheck.valid) {
      setDateError(rangeCheck.message);
      setExportMessage({ type: 'error', text: rangeCheck.message });
      return;
    }
    if (exportInProgress.current) return;
    exportInProgress.current = true;
    setIsExporting(true);
    setExportMessage(null);
    setLastExportId(null);
    let savedExportId = null;
    try {
      const company = JSON.parse(localStorage.getItem('companySettings') || '{}');
      const { rows: exportableRows, duplicates: duplicateRows } = excludePreviouslyExportedRows(selectedRows, exportHistory || []);
      const legacyHistoryCount = (exportHistory || []).filter((record) =>
        !['failed', 'import_failed', 'pending'].includes(record.export_status) && !record.validation_summary?.voucherKeys
      ).length;
      const result = mapSelectedToTally({ selectedRows: exportableRows, company });
      duplicateRows.forEach((row) => result.invalidVouchers.push({ voucher: { uiRow: row, voucherType: row.transactionTypeLabel }, errors: ['Previously generated successfully; excluded to prevent duplicate vouchers.'] }));
      setExportResult(result);
      setShowValidation(result.invalidVouchers.length > 0 || duplicateRows.length > 0);
      if (duplicateRows.length) setExportMessage({ type: 'warning', text: `${duplicateRows.length} previously generated transaction(s) were excluded to prevent duplicates.` });
      if (!result.vouchers.length) {
        setExportMessage({ type: 'error', text: 'No selected transactions passed validation. Review the errors below.' });
        return;
      }

      // Generate XML
      const xml = generateXml({
        masters: result.masters,
        vouchers: result.vouchers,
        company
      });

      if (!xml.masterValid || !xml.voucherValid) {
        setXmlValidation(xml);
        setExportMessage({ type: 'error', text: 'XML validation failed. Review the validation results below.' });
        return;
      }

      setGeneratedXml(xml);
      setXmlValidation(xml);
      const voucherKeys = result.vouchers.map((voucher) => `${voucher.uiRow?.transactionType}:${voucher.uiRow?.invoiceNo}`);
      const totalByCurrency = result.vouchers.reduce((totals, voucher) => {
        const row = exportableRows.find((item) => item.id === voucher.uiRow?.id);
        const currency = row?.currency || 'INR';
        totals[currency] = (totals[currency] || 0) + Number(voucher.totals?.grandTotal || 0);
        return totals;
      }, {});

      // Save export history to server
      const historyData = {
        date_from: dateFrom,
        date_to: dateTo,
        transaction_types: selectedTypes,
        masters_included: ['customerLedger', 'supplierLedger', 'stockItem', 'unit', 'gstLedger'],
        record_counts: result.counts,
        file_names: ['master.xml', 'voucher.xml'],
        export_status: 'pending',
        generated_by: 'ERP User',
        validation_summary: {
          validVouchers: result.vouchers.length,
          invalidVouchers: result.invalidVouchers.length,
          warnings: result.warnings.length,
          errors: result.invalidVouchers.flatMap((v) => v.errors),
          voucherKeys,
          totalByCurrency,
          duplicateExcluded: duplicateRows.map((row) => `${row.transactionType}:${row.invoiceNo}`)
        },
        notes: `Tally export: ${result.vouchers.length} transactions generated, ${dateFrom && dateTo ? `${dateFrom} to ${dateTo}` : 'All dates'}`,
        total_amount: Object.keys(totalByCurrency).length === 1 ? Object.values(totalByCurrency)[0] : 0
      };

      const saved = await saveExportHistory(historyData);
      const exportId = saved.id;
      savedExportId = exportId;
      setLastExportId(exportId);

      // Store XML files on server for re-download
      await storeExportFiles(exportId, {
        masterXml: xml.masterXml,
        voucherXml: xml.voucherXml
      });

      // Finalize only after both XML files were stored successfully.
      await updateExportStatus(exportId, {
        exportStatus: EXPORT_STATUSES.GENERATED,
        notes: 'XML files generated and stored; Tally import has not been confirmed'
      });

      // Trigger browser downloads
      // Files are offered as explicit downloads after generation.

      // Refresh history
      await loadExportHistory();

      const skipped = result.invalidVouchers.length + duplicateRows.length;
      setExportMessage({ type: skipped || legacyHistoryCount ? 'warning' : 'success', text: `${result.vouchers.length} transaction(s) generated successfully. ${skipped ? `${skipped} invalid or previously exported transaction(s) were excluded. ` : ''}${legacyHistoryCount ? `Duplicate matching is unavailable for ${legacyHistoryCount} older export record(s) that lack voucher references. ` : ''}Download master.xml and voucher.xml below. Generated does not mean imported into Tally.` });
    } catch (err) {
      console.error('Export failed:', err);
      if (err.code === 'DUPLICATE_VOUCHERS') setGeneratedXml(null);
      if (savedExportId) { try { await updateExportStatus(savedExportId, { exportStatus: EXPORT_STATUSES.FAILED, notes: `Export storage failed: ${err.message}` }); } catch {} }
      setExportMessage({ type: 'error', text: err.code === 'DUPLICATE_VOUCHERS' ? err.message : `Export failed: ${err.message}` });
    } finally {
      exportInProgress.current = false;
      setIsExporting(false);
    }
  }, [selectedRows, dateFrom, dateTo, customFrom, customTo, datePeriod, appliedDatePeriod, selectedTypes, loadExportHistory, exportHistory]);

  // ---------- Export history ----------
  useEffect(() => {
    loadExportHistory();
  }, [loadExportHistory]);

  const handleUpdateExportStatus = async (id, newStatus) => {
    try {
      await updateExportStatus(id, { exportStatus: newStatus, notes: `Status updated to ${newStatus}` });
      await loadExportHistory();
    } catch (err) {
      console.warn('Status update failed:', err.message);
    }
  };

  const handleReDownload = async (record, fileType) => {
    try {
      await downloadExportFile(record.id, fileType);
      if (record.export_status === EXPORT_STATUSES.GENERATED) {
        await updateExportStatus(record.id, { exportStatus: EXPORT_STATUSES.DOWNLOADED, notes: `${fileType}.xml downloaded from export history; Tally import not confirmed` });
        await loadExportHistory();
      }
    } catch (err) {
      alert('Download failed: ' + err.message);
    }
  };

  const handleConfirmImport = async (record) => {
    if (!window.confirm('Mark this export as Import Confirmed? This records that you have confirmed importing into TallyPrime.')) return;
    await handleUpdateExportStatus(record.id, EXPORT_STATUSES.IMPORT_CONFIRMED);
  };

  const handleMarkImportFailed = async (record) => {
    if (!window.confirm('Mark this export as Import Failed?')) return;
    await handleUpdateExportStatus(record.id, EXPORT_STATUSES.IMPORT_FAILED);
  };

  const handleDeleteExport = async (id) => {
    if (!window.confirm('Delete this export record?')) return;
    try {
      await fetch(`/api/tally-export/history/${id}`, { method: 'DELETE' });
      await loadExportHistory();
    } catch (err) {
      console.warn('Delete failed:', err.message);
    }
  };

  // ---------- Computed UI values ----------
  const applyDateRange = () => {
    if (datePeriod === 'all') {
      setDateError('');
      setDateFrom('');
      setDateTo('');
      setCustomFrom('');
      setCustomTo('');
      setDateFilterApplied(true);
      setAppliedDatePeriod('all');
      setSelectedRowIds(new Set());
      setGeneratedXml(null);
      setExportMessage(null);
      return;
    }
    const check = validateDateRange(customFrom, customTo);
    setDateError(check.message);
    if (!check.valid) return;
    setDateFrom(customFrom);
    setDateTo(customTo);
    setDateFilterApplied(true);
    setAppliedDatePeriod(datePeriod);
    setSelectedRowIds(new Set());
    setGeneratedXml(null);
    setExportMessage(null);
  };

  const downloadGeneratedFile = async (fileType) => {
    const content = fileType === 'master' ? generatedXml?.masterXml : generatedXml?.voucherXml;
    if (!content) return;
    downloadXmlContent(content, fileType === 'master' ? 'master.xml' : 'voucher.xml');
    const priorStatus = exportHistory.find((record) => record.id === lastExportId)?.export_status;
    if (lastExportId && priorStatus === EXPORT_STATUSES.GENERATED) {
      try {
        await updateExportStatus(lastExportId, { exportStatus: EXPORT_STATUSES.DOWNLOADED, notes: `${fileType}.xml downloaded; Tally import not confirmed` });
        await loadExportHistory();
      } catch (error) {
        setExportMessage({ type: 'warning', text: `File downloaded, but export history could not be updated: ${error.message}` });
      }
    }
  };

  const transactionTypeOptions = Object.entries(TRANSACTION_TYPE_LABELS).map(
    ([key, label]) => ({ key, label })
  );

  const hasValidationErrors = exportResult && exportResult.invalidVouchers.length > 0;

  // ---------- Render ----------
  return (
    <div className="page-section" style={{ maxWidth: '1400px', margin: '0 auto' }}>
      {/* ============ HEADER ============ */}
      <div className="page-header" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <p className="eyebrow">Utilities → Export to Tally</p>
            <h1>Export to Tally</h1>
            <p className="page-description">
              Select transactions and generate TallyPrime-compatible XML (master.xml + voucher.xml).
              Import into TallyPrime using the XML Data Interchange feature.
            </p>
          </div>
          <div className="header-actions no-print" style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button
              className="button-secondary"
              onClick={() => setShowHistory(!showHistory)}
              style={{ padding: '8px 16px', fontSize: '13px' }}
            >
              📜 Export History
            </button>
            <button
              className="button-primary"
              onClick={handleExportToTally}
              disabled={isExporting || selectedRows.length === 0}
              style={{ padding: '10px 24px', fontSize: '14px', fontWeight: '700' }}
            >
              {isExporting ? '⏳ Exporting…' : '📤 Export to Tally'}
            </button>
          </div>
        </div>
      </div>

      {exportMessage && (
        <div role="status" style={{ marginBottom: '16px', padding: '12px 14px', borderRadius: '8px', border: `1px solid ${exportMessage.type === 'error' ? '#fecaca' : exportMessage.type === 'success' ? '#bbf7d0' : '#fde68a'}`, background: exportMessage.type === 'error' ? '#fef2f2' : exportMessage.type === 'success' ? '#f0fdf4' : '#fffbeb', color: exportMessage.type === 'error' ? '#b91c1c' : exportMessage.type === 'success' ? '#166534' : '#92400e', fontSize: '13px' }}>
          {exportMessage.text}
        </div>
      )}

      {/* ============ DATE RANGE ============ */}
      <div className="content-block" style={{ marginBottom: '20px' }}>
        <div className="block-header">
          <h2>Date Range</h2>
        </div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'end' }}>
          <label style={{ display: 'grid', gap: '5px', fontSize: '12px', fontWeight: '600', color: '#374151' }}>
            Date Period
            <select value={datePeriod} onChange={(e) => {
              const period = e.target.value;
              setDatePeriod(period);
              if (period !== 'custom') {
                const range = computeDateRange(period);
                setCustomFrom(range.from);
                setCustomTo(range.to);
                setDateError('');
              }
            }} className="input">
              {DATE_PRESETS.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}
            </select>
          </label>
          <label style={{ display: 'grid', gap: '5px', fontSize: '12px', fontWeight: '600', color: '#374151' }}>
            From Date
            <input type="date" value={customFrom} disabled={datePeriod !== 'custom'} onChange={(e) => setCustomFrom(e.target.value)} className="input" />
          </label>
          <label style={{ display: 'grid', gap: '5px', fontSize: '12px', fontWeight: '600', color: '#374151' }}>
            To Date
            <input type="date" value={customTo} disabled={datePeriod !== 'custom'} onChange={(e) => setCustomTo(e.target.value)} className="input" />
          </label>
          <button className="button-primary" onClick={applyDateRange} disabled={loadingTransactions} style={{ padding: '8px 16px' }}>
            {loadingTransactions ? 'Loading…' : 'Apply Filters'}
          </button>
          <span style={{ fontSize: '12px', color: '#64748b' }}>
            Applied: {dateFilterApplied ? (dateFrom && dateTo ? `${dateFrom} to ${dateTo}` : 'All dates') : 'No date range applied'}
          </span>
        </div>
        {dateError && <p role="alert" style={{ color: '#b91c1c', fontSize: '12px', margin: '10px 0 0' }}>{dateError}</p>}
      </div>

      {/* ============ TRANSACTION TYPES ============ */}
      <div className="content-block" style={{ marginBottom: '20px' }}>
        <div className="block-header">
          <h2>Transaction Types</h2>
          <p style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
            Select the types of accounting transactions to include in the export.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="checkbox"
              checked={allTypesSelected}
              onChange={handleSelectAllTypes}
              style={{ width: '16px', height: '16px' }}
            />
            <strong style={{ fontSize: '13px', color: '#0f172a' }}>Select All</strong>
            <span
              style={{ fontSize: '11px', fontWeight: '700', color: allTypesSelected ? '#166534' : '#b45309', marginLeft: '6px' }}
            >
              {selectedTypes.length}/{transactionTypeOptions.length}
            </span>
          </div>
          {transactionTypeOptions.map((opt) => (
            <label
              key={opt.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '13px',
                cursor: 'pointer',
                padding: '6px 12px',
                borderRadius: '6px',
                background: selectedTypes.includes(opt.key) ? '#dbeafe' : 'transparent',
                border: `1px solid ${selectedTypes.includes(opt.key) ? '#2563eb' : '#e2e8f0'}`,
                marginBottom: '6px'
              }}
            >
              <input
                type="checkbox"
                checked={selectedTypes.includes(opt.key)}
                onChange={() => handleToggleType(opt.key)}
                style={{ width: '16px', height: '16px' }}
              />
              <strong>{opt.label}</strong>
            </label>
          ))}
        </div>
      </div>

      {/* ============ TRANSACTION TABLE ============ */}
      <div className="content-block" style={{ marginBottom: '20px' }}>
        <div className="block-header">
          <h2>Transactions</h2>
          <p style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
            Select individual transactions to export. Only selected rows are included in master.xml and voucher.xml.
          </p>
        </div>

        {/* Toolbar */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
          <input
            type="text"
            placeholder="Search invoice no., party, type, project…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input"
            style={{ padding: '8px 12px', fontSize: '13px', flex: 1, minWidth: '240px' }}
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="input"
            style={{ padding: '8px 12px', fontSize: '13px' }}
          >
            <option value="all">All Types</option>
            {transactionTypeOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
          <div style={{ fontSize: '12px', color: '#64748b' }}>
            Showing {paginated.length} of {filteredTransactions.length} transactions
          </div>
          {selectedRowIds.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: '700', color: '#2563eb' }}>
              {selectedRowIds.size} selected · {Object.entries(selectedAmountByCurrency).map(([currency, amount]) => formatCurrency(amount, currency)).join(' + ')}
            </div>
          )}
          <button
            className="button-secondary"
            onClick={() => selectAllRows(paginated.map((t) => t.id))}
            disabled={loadingTransactions}
            style={{ padding: '6px 14px', fontSize: '12px' }}
          >
            {paginated.length > 0 && paginated.every((t) => selectedRowIds.has(t.id)) ? 'Clear Page Selection' : 'Select All on Page'}
          </button>
          <button
            className="button-secondary"
            onClick={clearSelection}
            disabled={selectedRowIds.size === 0}
            style={{ padding: '6px 14px', fontSize: '12px', color: '#b91c1c' }}
          >
            Clear Selection
          </button>
        </div>

        {/* Table */}
        <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px' }}>
          <table className="history-table report-table" style={{ width: '100%', fontSize: '12px' }}>
            <thead>
              <tr>
                <th style={{ width: '40px' }}>
                  <input
                    type="checkbox"
                    checked={paginated.length > 0 && paginated.every((t) => selectedRowIds.has(t.id))}
                    onChange={() => selectAllRows(paginated.map((t) => t.id))}
                  />
                </th>
                <th onClick={() => { setSortKey('date'); setSortDir(sortKey === 'date' ? (sortDir === 'asc' ? 'desc' : 'asc') : 'desc'); }} style={{ cursor: 'pointer' }}>
                  Date {' '}
                  {sortKey === 'date' && (sortDir === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => { setSortKey('invoiceNo'); setSortDir(sortKey === 'invoiceNo' ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc'); }} style={{ cursor: 'pointer' }}>
                  Invoice No.{' '}
                  {sortKey === 'invoiceNo' && (sortDir === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => { setSortKey('partyName'); setSortDir(sortKey === 'partyName' ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc'); }} style={{ cursor: 'pointer' }}>
                  Party Name{' '}
                  {sortKey === 'partyName' && (sortDir === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => { setSortKey('transactionTypeLabel'); setSortDir(sortKey === 'transactionTypeLabel' ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc'); }} style={{ cursor: 'pointer' }}>
                  Type{' '}
                  {sortKey === 'transactionTypeLabel' && (sortDir === 'asc' ? '▲' : '▼')}
                </th>
                <th>Payment Type</th>
                <th>Taxable Amount</th>
                <th>GST</th>
                <th onClick={() => { setSortKey('amount'); setSortDir(sortKey === 'amount' ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc'); }} style={{ cursor: 'pointer' }}>Total Amount</th>
                <th onClick={() => { setSortKey('balance'); setSortDir(sortKey === 'balance' ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc'); }} style={{ cursor: 'pointer' }}>
                  Balance {' '}
                  {sortKey === 'balance' && (sortDir === 'asc' ? '▲' : '▼')}
                </th>
                <th>Export Status</th>
              </tr>
            </thead>
            <tbody>
              {paginated.map((t) => {
                const isSelected = selectedRowIds.has(t.id);
                const voucherKey = `${t.transactionType}:${t.invoiceNo}`;
                const pendingExport = (exportHistory || []).some((record) => record.export_status === 'pending' && (record.validation_summary?.voucherKeys || []).includes(voucherKey));
                const wasExported = previouslyExportedVoucherKeys.has(voucherKey);
                const legacyExportCheck = (exportHistory || []).some((record) => !['failed', 'import_failed', 'pending'].includes(record.export_status) && !record.validation_summary?.voucherKeys);
                return (
                  <tr
                    key={t.id}
                    onClick={(e) => {
                      if (e.target.tagName === 'INPUT') return;
                      toggleRowSelection(t.id);
                    }}
                    style={{
                      background: isSelected ? '#dbeafe' : 'transparent',
                      cursor: 'pointer',
                      transition: 'background 0.2s'
                    }}
                  >
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleRowSelection(t.id);
                        }}
                      />
                    </td>
                    <td>{t.date}</td>
                    <td style={{ fontWeight: '600', fontSize: '11px' }}>{t.invoiceNo}</td>
                    <td>{t.partyName}</td>
                    <td style={{ fontSize: '11px', textTransform: 'capitalize' }}>{t.transactionTypeLabel}</td>
                    <td style={{ fontSize: '11px' }}>{t.paymentType}</td>
                    <td style={{ textAlign: 'right' }}>{t.taxableAmount == null ? 'Not recorded' : formatCurrency(t.taxableAmount, t.currency)}</td>
                    <td style={{ textAlign: 'right' }}>{t.gstAmount == null ? 'Not recorded' : formatCurrency(t.gstAmount, t.currency)}</td>
                    <td style={{ textAlign: 'right' }}>{formatCurrency(t.amount, t.currency)}</td>
                    <td style={{ textAlign: 'right', color: t.balance > 0 ? '#b91c1c' : '#166534', fontWeight: '600' }}>
                      {['sale', 'purchase'].includes(t.transactionType) ? formatCurrency(t.balance, t.currency) : 'N/A'}
                    </td>
                    <td style={{ fontSize: '11px' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: '10px',
                          background: wasExported ? '#fee2e2' : legacyExportCheck ? '#fffbeb' : '#f1f5f9',
                          color: wasExported ? '#b91c1c' : legacyExportCheck ? '#92400e' : '#475569',
                          fontWeight: '600',
                          fontSize: '10px'
                        }}
                      >
                        {pendingExport ? 'Export in progress' : wasExported ? 'Previously exported' : legacyExportCheck ? 'Legacy history not matched' : 'Not exported'}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {paginated.length === 0 && (
                <tr>
                  <td colSpan={11} style={{ textAlign: 'center', padding: '30px', color: '#64748b' }}>
                    {dateFrom && dateTo ? 'No transactions found for the selected date range and types.' : 'Choose a From Date and To Date, then apply the filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px', fontSize: '13px' }}>
            <div>Page {page} of {totalPages}</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                className="button-secondary"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                style={{ padding: '4px 10px', fontSize: '12px' }}
              >
                Prev
              </button>
              <button
                className="button-secondary"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                style={{ padding: '4px 10px', fontSize: '12px' }}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ============ EXPORT ACTION ============ */}
      {transactions.length > 0 && (
        <div className="content-block" style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <strong style={{ fontSize: '13px', color: '#0f172a' }}>
                Ready to export {selectedRowIds.size} transaction(s)
              </strong>
              <p style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                Clicking "Export to Tally" will validate all selected records, automatically identify required masters, and generate master.xml + voucher.xml.
              </p>
            </div>
            <button
              className="button-primary"
              onClick={handleExportToTally}
              disabled={isExporting || selectedRowIds.size === 0}
              style={{ padding: '12px 32px', fontSize: '15px', fontWeight: '700' }}
            >
              {isExporting ? '⏳ Exporting…' : '📤 Export to Tally'}
            </button>
          </div>
        </div>
      )}

      {/* ============ VALIDATION RESULTS (if errors) ============ */}
      {showValidation && exportResult && (
        <div className="content-block" style={{ marginBottom: '20px' }}>
          <div className="block-header">
            <h2>Validation Results</h2>
          </div>
          {exportResult.invalidVouchers.length > 0 && (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', padding: '14px', borderRadius: '8px', marginBottom: '12px' }}>
              <div style={{ fontSize: '13px', fontWeight: '700', color: '#b91c1c', marginBottom: '8px' }}>
                ⚠ {exportResult.invalidVouchers.length} transaction(s) cannot be exported
              </div>
              <ul style={{ margin: '0 0 0 20px', fontSize: '12px', color: '#b91c1c' }}>
                {exportResult.invalidVouchers.map((item, idx) => (
                  <li key={idx} style={{ marginBottom: '6px' }}>
                    <strong>{item.voucher.uiRow?.invoiceNo || 'Unknown'}</strong> ({item.voucher.voucherType}):
                    {item.errors.join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {exportResult.warnings.length > 0 && (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', padding: '14px', borderRadius: '8px', marginBottom: '12px' }}>
              <div style={{ fontSize: '13px', fontWeight: '700', color: '#b45309', marginBottom: '8px' }}>
                ℹ {exportResult.warnings.length} warning(s)
              </div>
              <ul style={{ margin: '0 0 0 20px', fontSize: '12px', color: '#92400e' }}>
                {exportResult.warnings.map((w, idx) => <li key={idx}>{w}</li>)}
              </ul>
            </div>
          )}
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              className="button-secondary"
              onClick={() => setShowValidation(false)}
              style={{ padding: '8px 16px' }}
            >
              Adjust Selection
            </button>
          </div>
        </div>
      )}

      {/* ============ XML GENERATED ============ */}
      {generatedXml && exportResult && (
        <div className="content-block" style={{ marginBottom: '20px' }}>
          <div className="block-header">
            <h2>XML Files Generated</h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '16px' }}>
            <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', fontWeight: '700' }}>master.xml</div>
              <div style={{ fontSize: '13px', fontWeight: '700', color: '#0f172a' }}>{exportResult.masters.customerLedgers.length + exportResult.masters.supplierLedgers.length} ledgers + {exportResult.masters.stockItems.length} items</div>
            </div>
            <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', fontWeight: '700' }}>voucher.xml</div>
              <div style={{ fontSize: '13px', fontWeight: '700', color: '#0f172a' }}>{exportResult.vouchers.length} vouchers</div>
            </div>
            <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', fontWeight: '700' }}>Applied Date Range</div>
              <div style={{ fontSize: '13px', fontWeight: '700', color: '#0f172a' }}>{dateFrom} to {dateTo}</div>
            </div>
            <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', fontWeight: '700' }}>Voucher Total by Currency</div>
              <div style={{ fontSize: '13px', fontWeight: '700', color: '#0f172a' }}>
                {Object.entries(exportResult.vouchers.reduce((totals, voucher) => {
                  const currency = transactions.find((row) => row.id === voucher.uiRow?.id)?.currency || 'INR';
                  totals[currency] = (totals[currency] || 0) + Number(voucher.totals?.grandTotal || 0);
                  return totals;
                }, {})).map(([currency, amount]) => formatCurrency(amount, currency)).join(' + ') || '—'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              className="button-secondary"
              onClick={() => downloadGeneratedFile('master')}
              disabled={isExporting}
              style={{ flex: 1 }}
            >
              📥 Download master.xml
            </button>
            <button
              className="button-secondary"
              onClick={() => downloadGeneratedFile('voucher')}
              disabled={isExporting}
              style={{ flex: 1 }}
            >
              📥 Download voucher.xml
            </button>
          </div>
          {xmlValidation && (
            <div style={{ marginTop: '12px', fontSize: '12px' }}>
              <strong>XML Validation:</strong>
              <ul style={{ margin: '4px 0 0 20px', color: '#64748b' }}>
                <li>
                  master.xml{' '}
                  <span style={{ color: xmlValidation.masterValid ? '#166534' : '#b91c1c', fontWeight: '600' }}>
                    {xmlValidation.masterValid ? '✓ Valid' : '✗ Errors'}
                  </span>
                </li>
                <li>
                  voucher.xml{' '}
                  <span style={{ color: xmlValidation.voucherValid ? '#166534' : '#b91c1c', fontWeight: '600' }}>
                    {xmlValidation.voucherValid ? '✓ Valid' : '✗ Errors'}
                  </span>
                </li>
              </ul>
            </div>
          )}
          <div style={{ marginTop: '16px', background: '#f0f9ff', border: '1px solid #bae6fd', padding: '14px', borderRadius: '8px' }}>
            <strong style={{ fontSize: '13px', color: '#0369a1', display: 'block', marginBottom: '8px' }}>
              📥 TallyPrime Import Instructions
            </strong>
            <ol style={{ fontSize: '12px', color: '#374151', margin: '0 0 0 20px' }}>
              <li>Open TallyPrime → Gateway of Tally → Select your company.</li>
              <li>Go to Import → Masters → import <strong>master.xml</strong> first.</li>
              <li>Choose import behaviour (skip duplicates / overwrite) as needed.</li>
              <li>After masters are imported, go to Import → Vouchers → import <strong>voucher.xml</strong>.</li>
              <li>Verify imported vouchers against the ERP: check voucher numbers, dates, and amounts.</li>
              <li><strong>Important:</strong> Downloading XML does not confirm Tally import. Update the export status below after you confirm import in TallyPrime.</li>
            </ol>
          </div>
        </div>
      )}

      {/* ============ EXPORT HISTORY ============ */}
      {showHistory && (
        <div className="content-block" style={{ marginBottom: '20px' }}>
          <div className="block-header">
            <h2>Export History</h2>
            <span style={{ fontSize: '12px', color: '#64748b' }}>
              Downloading an XML file does not confirm Tally import. Update status manually after reconciling in TallyPrime.
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="history-table report-table" style={{ width: '100%', fontSize: '12px' }}>
              <thead>
                <tr>
                  <th>Export Date</th>
                  <th>Period</th>
                  <th>Types</th>
                  <th>Transactions</th>
                  <th>Total Amount</th>
                  <th>Files</th>
                  <th>Status</th>
                  <th>Errors / Notes</th>
                  <th>Exported By</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(exportHistory || []).map((rec) => (
                  <tr key={rec.id}>
                    <td>{rec.export_date ? new Date(rec.export_date).toLocaleString() : '-'}</td>
                    <td style={{ fontSize: '11px' }}>{rec.date_from} to {rec.date_to}</td>
                    <td style={{ fontSize: '11px', maxWidth: '150px' }}>{(rec.transaction_types || []).map((key) => TRANSACTION_TYPE_LABELS[key] || key).join(', ') || '-'}</td>
                    <td>{Object.values(rec.record_counts || {}).reduce((sum, count) => sum + Number(count || 0), 0)}</td>
                    <td style={{ textAlign: 'right' }}>{rec.validation_summary?.totalByCurrency
                      ? Object.entries(rec.validation_summary.totalByCurrency).map(([currency, amount]) => formatCurrency(amount, currency)).join(' + ')
                      : rec.total_amount ? `${Number(rec.total_amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })} (currency not recorded)` : '-'}</td>
                    <td style={{ fontSize: '11px' }}>{(rec.file_names || []).join(', ') || '-'}</td>
                    <td>
                      <span
                        style={{
                          fontWeight: '600',
                          fontSize: '11px',
                          padding: '2px 8px',
                          borderRadius: '10px',
                          background: STATUS_COLORS[rec.export_status] + '22',
                          color: STATUS_COLORS[rec.export_status]
                        }}
                      >
                        {STATUS_LABELS[rec.export_status] || rec.export_status}
                      </span>
                    </td>
                    <td style={{ fontSize: '11px', color: rec.validation_summary?.errors?.length ? '#b91c1c' : '#64748b', maxWidth: '260px' }}>
                      {[...(rec.validation_summary?.errors || []), rec.notes].filter(Boolean).join('; ') || '-'}
                    </td>
                    <td style={{ fontSize: '11px' }}>{rec.generated_by || 'ERP User'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button
                          className="button-secondary"
                          onClick={() => handleReDownload(rec, 'master')}
                          disabled={isExporting}
                          style={{ fontSize: '11px', padding: '4px 8px' }}
                        >
                          master.xml
                        </button>
                        <button
                          className="button-secondary"
                          onClick={() => handleReDownload(rec, 'voucher')}
                          disabled={isExporting}
                          style={{ fontSize: '11px', padding: '4px 8px' }}
                        >
                          voucher.xml
                        </button>
                        <button
                          className="button-secondary"
                          onClick={() => handleConfirmImport(rec)}
                          style={{ fontSize: '11px', padding: '4px 8px', color: '#15803d' }}
                        >
                          Confirm Import
                        </button>
                        <button
                          className="button-secondary"
                          onClick={() => handleMarkImportFailed(rec)}
                          style={{ fontSize: '11px', padding: '4px 8px', color: '#b91c1c' }}
                        >
                          Mark Failed
                        </button>
                        <button
                          className="button-secondary"
                          onClick={() => handleDeleteExport(rec.id)}
                          style={{ fontSize: '11px', padding: '4px 8px', color: '#b91c1c' }}
                        >
                          🗑️
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default TallyExportPage;
