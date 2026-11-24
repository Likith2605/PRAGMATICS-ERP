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

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import logoUrl from '../assets/logo.png';

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
  DATE_PRESETS,
  computeDateRange,
  TransactionTypes,
  TRANSACTION_TYPE_LABELS,
  DEFAULT_SELECTED_TYPES
} from '../services/tallyExportService.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPORT_STATUSES = {
  GENERATED: 'generated',
  DOWNLOADED: 'downloaded',
  IMPORT_PENDING: 'import_pending',
  IMPORT_CONFIRMED: 'import_confirmed',
  IMPORT_FAILED: 'import_failed'
};

const STATUS_LABELS = {
  [EXPORT_STATUSES.GENERATED]: 'Generated',
  [EXPORT_STATUSES.DOWNLOADED]: 'Downloaded',
  [EXPORT_STATUSES.IMPORT_PENDING]: 'Import Pending',
  [EXPORT_STATUSES.IMPORT_CONFIRMED]: 'Import Confirmed',
  [EXPORT_STATUSES.IMPORT_FAILED]: 'Import Failed'
};

const STATUS_COLORS = {
  [EXPORT_STATUSES.GENERATED]: '#b45309',
  [EXPORT_STATUSES.DOWNLOADED]: '#166534',
  [EXPORT_STATUSES.IMPORT_PENDING]: '#2563eb',
  [EXPORT_STATUSES.IMPORT_CONFIRMED]: '#15803d',
  [EXPORT_STATUSES.IMPORT_FAILED]: '#b91c1c'
};

const DEFAULT_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Tally Export Page (Vyapar-style)
// ---------------------------------------------------------------------------

const TallyExportPage = () => {
  const navigate = useNavigate();

  // ---------- Date range ----------
  const [datePreset, setDatePreset] = useState('current_fy');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const { from: dateFrom, to: dateTo } = useMemo(
    () => computeDateRange(datePreset, customFrom, customTo),
    [datePreset, customFrom, customTo]
  );

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
  }, [dateFrom, dateTo, selectedTypes]);

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

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
    if (selectedRowIds.size === ids.length && ids.length > 0) {
      setSelectedRowIds(new Set());
    } else {
      setSelectedRowIds(new Set(ids));
    }
  };

  const clearSelection = () => setSelectedRowIds(new Set());

  const selectedRows = useMemo(() => {
    const idSet = selectedRowIds;
    return transactions.filter((t) => idSet.has(t.id));
  }, [transactions, selectedRowIds]);

  const selectedAmount = useMemo(
    () => selectedRows.reduce((sum, r) => sum + r.amount, 0),
    [selectedRows]
  );

  // Filtered + sorted + paginated
  const filteredTransactions = useMemo(() => {
    let list = [...transactions];

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(
        (t) =>
          t.invoiceNo.toLowerCase().includes(q) ||
          t.partyName.toLowerCase().includes(q) ||
          t.transactionTypeLabel.toLowerCase().includes(q) ||
          t.projectId.toLowerCase().includes(q)
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

  // ---------- Export state ----------
  const [isExporting, setIsExporting] = useState(false);
  const [generatedXml, setGeneratedXml] = useState(null);
  const [exportResult, setExportResult] = useState(null); // { vouchers, invalid, warnings, masters, counts, totals }
  const [showValidation, setShowValidation] = useState(false);
  const [xmlValidation, setXmlValidation] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [exportHistory, setExportHistory] = useState([]);

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
    if (selectedRows.length === 0) {
      alert('Please select at least one transaction to export.');
      return;
    }

    setIsExporting(true);
    try {
      const company = JSON.parse(localStorage.getItem('companySettings') || '{}');
      const result = mapSelectedToTally({ selectedRows, company });

      // Validation errors block export
      if (result.invalidVouchers.length > 0) {
        setExportResult(result);
        setShowValidation(true);
        setIsExporting(false);
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
        setIsExporting(false);
        alert('XML validation failed. Please check the generated XML structure.');
        return;
      }

      setGeneratedXml(xml);
      setExportResult(result);
      setShowValidation(false);

      // Save export history to server
      const historyData = {
        date_from: dateFrom,
        date_to: dateTo,
        transaction_types: selectedTypes,
        masters_included: ['customerLedger', 'supplierLedger', 'stockItem', 'unit', 'gstLedger'],
        record_counts: result.counts,
        file_names: ['master.xml', 'voucher.xml'],
        export_status: EXPORT_STATUSES.GENERATED,
        generated_by: 'ERP User',
        validation_summary: {
          validVouchers: result.vouchers.length,
          invalidVouchers: result.invalidVouchers.length,
          warnings: result.warnings.length,
          errors: result.invalidVouchers.flatMap((v) => v.errors)
        },
        notes: `Tally export: ${selectedRows.length} transactions, ${dateFrom} to ${dateTo}`,
        total_amount: result.totals.totalGrand
      };

      const saved = await saveExportHistory(historyData);
      const exportId = saved.id;

      // Store XML files on server for re-download
      await storeExportFiles(exportId, {
        masterXml: xml.masterXml,
        voucherXml: xml.voucherXml
      });

      // Mark as downloaded
      await updateExportStatus(exportId, {
        exportStatus: EXPORT_STATUSES.DOWNLOADED,
        notes: 'XML files generated and downloaded'
      });

      // Trigger browser downloads
      downloadXmlContent(xml.masterXml, 'master.xml');
      setTimeout(() => downloadXmlContent(xml.voucherXml, 'voucher.xml'), 500);

      // Refresh history
      await loadExportHistory();

      alert(
        `Export complete!\n\nmaster.xml and voucher.xml have been downloaded.\n\n` +
        `Transactions exported: ${result.vouchers.length}\n` +
        `Total amount: ₹${result.totals.totalGrand.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n\n` +
        'Import into TallyPrime: masters first (master.xml), then vouchers (voucher.xml).'
      );
    } catch (err) {
      console.error('Export failed:', err);
      alert('Export failed: ' + err.message);
    } finally {
      setIsExporting(false);
    }
  }, [selectedRows, dateFrom, dateTo, selectedTypes, loadExportHistory]);

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
  const dateRange = computeDateRange(datePreset, customFrom, customTo);
  const presetLabel = DATE_PRESETS.find((p) => p.key === datePreset)?.label || 'Custom';
  const isCustom = datePreset === 'custom';

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

      {/* ============ DATE RANGE ============ */}
      <div className="content-block" style={{ marginBottom: '20px' }}>
        <div className="block-header">
          <h2>Date Range</h2>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          {DATE_PRESETS.map((p) => {
            const active = datePreset === p.key;
            return (
              <button
                key={p.key}
                onClick={() => setDatePreset(p.key)}
                className={active ? 'button-primary' : 'button-secondary'}
                style={{
                  padding: '6px 14px',
                  fontSize: '12px',
                  fontWeight: active ? '700' : '600',
                  borderRadius: '6px'
                }}
              >
                {p.label}
              </button>
            );
          })}
          {isCustom && (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <label style={{ fontSize: '12px', fontWeight: '600', color: '#374151' }}>From:</label>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="input"
                style={{ padding: '6px 10px', fontSize: '12px' }}
              />
              <label style={{ fontSize: '12px', fontWeight: '600', color: '#374151' }}>To:</label>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="input"
                style={{ padding: '6px 10px', fontSize: '12px' }}
              />
            </div>
          )}
          <div style={{ fontSize: '12px', color: '#64748b', marginLeft: '8px' }}>
            {dateRange.from} to {dateRange.to}
          </div>
        </div>
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
              onClick={() => handleToggleType(opt.key)}
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
              {selectedRowIds.size} selected · ₹{selectedAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </div>
          )}
          <button
            className="button-secondary"
            onClick={() => selectAllRows(filteredTransactions.map((t) => t.id))}
            disabled={loadingTransactions}
            style={{ padding: '6px 14px', fontSize: '12px' }}
          >
            {selectedRowIds.size === filteredTransactions.length && filteredTransactions.length > 0 ? 'Clear Selection' : 'Select All on Page'}
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
                    checked={selectedRowIds.size === filteredTransactions.length && filteredTransactions.length > 0}
                    onChange={() => selectAllRows(filteredTransactions.map((t) => t.id))}
                  />
                </th>
                <th onClick={() => setSortKey(sortKey === 'date' ? 'date' : sortKey === 'date' ? 'date' : 'date')} style={{ cursor: 'pointer' }}>
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
                <th onClick={() => { setSortKey('amount'); setSortDir(sortKey === 'amount' ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc'); }} style={{ cursor: 'pointer' }}>
                  Amount (₹) {' '}
                  {sortKey === 'amount' && (sortDir === 'asc' ? '▲' : '▼')}
                </th>
                <th onClick={() => { setSortKey('balance'); setSortDir(sortKey === 'balance' ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc'); }} style={{ cursor: 'pointer' }}>
                  Balance (₹) {' '}
                  {sortKey === 'balance' && (sortDir === 'asc' ? '▲' : '▼')}
                </th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {paginated.map((t) => {
                const isSelected = selectedRowIds.has(t.id);
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
                    <td style={{ textAlign: 'right' }}>{t.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                    <td style={{ textAlign: 'right', color: t.balance > 0 ? '#b91c1c' : '#166534', fontWeight: '600' }}>
                      {t.balance.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    </td>
                    <td style={{ fontSize: '11px' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: '10px',
                          background: t.status === 'Paid' || t.status === 'Received' ? '#dcfce7' : '#fef3c7',
                          color: t.status === 'Paid' || t.status === 'Received' ? '#166534' : '#b45309',
                          fontWeight: '600',
                          fontSize: '10px'
                        }}
                      >
                        {t.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {paginated.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', padding: '30px', color: '#64748b' }}>
                    No transactions found for the selected date range and types.
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
            {exportResult.vouchers.length > 0 && (
              <button
                className="button-primary"
                onClick={async () => {
                  // Skip validation screen, proceed to generate
                  setShowValidation(false);
                  // Re-run export (will regenerate XML since we have result)
                  // For simplicity, call the export function again but it will re-validate
                  // Instead, directly generate XML from current result
                  const company = JSON.parse(localStorage.getItem('companySettings') || '{}');
                  const xml = generateXml({
                    masters: exportResult.masters,
                    vouchers: exportResult.vouchers,
                    company
                  });
                  setGeneratedXml(xml);
                  setXmlValidation({
                    masterValid: xml.masterValid,
                    voucherValid: xml.voucherValid,
                    masterErrors: xml.masterErrors,
                    voucherErrors: xml.voucherErrors
                  });
                  setIsExporting(true);
                  try {
                    const historyData = {
                      date_from: dateFrom,
                      date_to: dateTo,
                      transaction_types: selectedTypes,
                      masters_included: ['customerLedger', 'supplierLedger', 'stockItem', 'unit', 'gstLedger'],
                      record_counts: exportResult.counts,
                      file_names: ['master.xml', 'voucher.xml'],
                      export_status: EXPORT_STATUSES.GENERATED,
                      generated_by: 'ERP User',
                      validation_summary: {
                        validVouchers: exportResult.vouchers.length,
                        invalidVouchers: exportResult.invalidVouchers.length,
                        warnings: exportResult.warnings.length
                      },
                      notes: `Tally export: ${selectedRowIds.size} transactions`,
                      total_amount: exportResult.totals.totalGrand
                    };
                    const saved = await saveExportHistory(historyData);
                    const exportId = saved.id;
                    await storeExportFiles(exportId, { masterXml: xml.masterXml, voucherXml: xml.voucherXml });
                    await updateExportStatus(exportId, { exportStatus: EXPORT_STATUSES.DOWNLOADED, notes: 'XML downloaded' });
                    downloadXmlContent(xml.masterXml, 'master.xml');
                    setTimeout(() => downloadXmlContent(xml.voucherXml, 'voucher.xml'), 500);
                    await loadExportHistory();
                    alert('Export complete! master.xml and voucher.xml downloaded.');
                  } catch (err) {
                    alert('Export failed: ' + err.message);
                  } finally {
                    setIsExporting(false);
                  }
                }}
                disabled={isExporting}
                style={{ padding: '8px 16px' }}
              >
                Export Valid Transactions
              </button>
            )}
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
              <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', fontWeight: '700' }}>Total Amount</div>
              <div style={{ fontSize: '13px', fontWeight: '700', color: '#0f172a' }}>₹{exportResult.totals.totalGrand.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              className="button-secondary"
              onClick={() => downloadXmlContent(generatedXml.masterXml, 'master.xml')}
              disabled={isExporting}
              style={{ flex: 1 }}
            >
              📥 Download master.xml
            </button>
            <button
              className="button-secondary"
              onClick={() => downloadXmlContent(generatedXml.voucherXml, 'voucher.xml')}
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
                  <th>Exported By</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(exportHistory || []).map((rec) => (
                  <tr key={rec.id}>
                    <td>{rec.export_date ? new Date(rec.export_date).toLocaleString() : '-'}</td>
                    <td style={{ fontSize: '11px' }}>{rec.date_from} to {rec.date_to}</td>
                    <td style={{ fontSize: '11px', maxWidth: '150px' }}>{(rec.transaction_types || []).join(', ') || '-'}</td>
                    <td>{JSON.stringify(rec.record_counts || {})}</td>
                    <td style={{ textAlign: 'right' }}>{rec.total_amount ? Number(rec.total_amount).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '-'}</td>
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
