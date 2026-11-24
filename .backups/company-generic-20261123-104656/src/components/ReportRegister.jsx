import React, { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import defaultLogoUrl from '../assets/logo.png';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { generateRegisterPDF } from '../services/pdfGenerator.js';
import { exportToCSV } from '../utils/csvExporter.js';
import { getReportCompanyProfile } from '../utils/reportData.js';
import { getCurrentUserInfo } from '../utils/permissions.js';
import { buildReportWorkbook, scheduleReportPrint } from '../utils/reportExports.js';
import { applyReportFilters, validateReportDateRange } from '../utils/reportFilters.js';
import ReportFilterPanel from './ReportFilterPanel.jsx';

const ReportRegister = ({
  title,
  subTitle = '',
  filename,
  columns = [],
  rows = [],
  dateField = 'date',
  dateFilters = true,
  dateFilterNote = '',
  filters = [],
  totals = [],
  footerLabel = 'TOTAL',
  enableCSV = false,
  summaryCards = [],
  summaryContent,
  summaryTables = [],
  landscape,
  enableGrouping = true,
  defaultPageSize = 50,
  showPreparedBy = true,
  filtersDropdown = true,
  hideFilterActions = false,
  autoApplyFilters = false,
  pdfOnly = false,
  hidePagination = false,
  showPrint = false,
  disableCommonFilters = false,
  excludeCommonFilterKeys = [],
  toolbarSearchValue,
  onToolbarSearchChange,
  toolbarSearchPlaceholder = 'Search',
  showSearch = true
}) => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [draftSel, setDraftSel] = useState({});
  const [draftSearch, setDraftSearch] = useState('');
  const [applied, setApplied] = useState({ from: '', to: '', selections: {}, search: '' });
  const [filterError, setFilterError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [groupBy, setGroupBy] = useState('');
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [page, setPage] = useState(1);
  const company = getReportCompanyProfile();
  const reportUser = getCurrentUserInfo();
  const generatedBy = reportUser.employee?.name || reportUser.auth?.username || 'User';
  const reportModule = ({ sales: 'Sales', purchase: 'Purchase', inventory: 'Inventory', production: 'Production', outsource: 'Outsourcing', masters: 'Masters' })[window.location.pathname.split('/')[2]] || 'Reports';
  const companyAddress = [company.address, company.phone && `Phone: ${company.phone}`, company.email,
    company.website, company.gstin && `GSTIN: ${company.gstin}`, company.pan && `PAN: ${company.pan}`]
    .filter(Boolean).join('  |  ');

  const commonFilterDefinitions = [
    ['customer', 'Customer', ['customer', 'customerName', 'customerCompany']],
    ['employee', 'Employee', ['employee', 'employeeName', 'issuedTo', 'returnedBy', 'receivedBy', 'dispatcher_name', 'inspector_employee_name']],
    ['supplier', 'Supplier', ['supplier', 'supplierName', 'vendor', 'vendorName']],
    ['item', 'Item / Material', ['item', 'itemName', 'material', 'materialName', 'itemCode', 'materialId']],
    ['jobCardNumber', 'Job Card', ['jobCardNumber']],
    ['projectId', 'Project', ['projectId']],
    ['status', 'Status', ['status', 'paymentStatus', 'orderStatus', 'dispatchStatus', 'qcStatus']]
  ];
  const commonFilters = useMemo(() => disableCommonFilters ? [] : commonFilterDefinitions.flatMap(([key, label, fields]) => {
    if (excludeCommonFilterKeys.includes(key)) return [];
    const alreadyProvided = filters.some((filter) => fields.includes(filter.key));
    if (alreadyProvided) return [];
    const values = [...new Set(rows.flatMap((row) => fields.map((field) => row?.[field]).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())))].sort((a, b) => a.localeCompare(b));
    if (values.length < 2) return [];
    return [{ key: `__common_${key}`, label, placeholder: `All ${label}`, options: values.map((value) => ({ value, label: value })), match: (row, value) => fields.some((field) => String(row?.[field] ?? '').trim() === value) }];
  }), [rows, filters, disableCommonFilters, excludeCommonFilterKeys]);
  const reportFilters = [...filters, ...commonFilters];
  const groupDefinitions = [
    ['customer', 'Customer', ['customer', 'customerName', 'customerCompany']],
    ['project', 'Project', ['projectId', 'projectName']],
    ['supplier', 'Supplier', ['supplier', 'supplierName', 'vendor', 'vendorName']],
    ['item', 'Item / Material', ['item', 'itemName', 'material', 'materialName', 'itemCode', 'materialId']],
    ['jobCard', 'Job Card', ['jobCardNumber']],
    ['employee', 'Employee', ['employee', 'employeeName', 'issuedTo', 'returnedBy', 'receivedBy', 'dispatcher_name', 'inspector_employee_name']],
    ['status', 'Status', ['status', 'paymentStatus', 'orderStatus', 'dispatchStatus', 'qcStatus']]
  ];
  const groupOptions = enableGrouping ? groupDefinitions.flatMap(([key, label, fields]) => {
    const values = [...new Set(rows.flatMap((row) => fields.map((field) => row?.[field]).filter((value) => typeof value === 'string' && value.trim() && value.trim() !== '-').map((value) => value.trim())))].sort();
    return values.length > 1 ? [{ key, label, fields, values }] : [];
  }) : [];
  const selectedGroup = groupOptions.find((group) => group.key === groupBy);
  const groupValue = (row) => selectedGroup?.fields.map((field) => String(row?.[field] || '').trim()).find(Boolean) || 'Identity not recorded';

  const cellText = (row, col) => (col.render ? col.render(row) : row[col.key] ?? '');
  const exportCellText = (row, col) => {
    if (col.renderText) return col.renderText(row);
    const rendered = cellText(row, col);
    if (typeof rendered === 'string' || typeof rendered === 'number') return String(rendered);
    return row[col.key] != null ? String(row[col.key]) : '';
  };
  const pad = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : v;
  };

  const { filteredRows: filtered, excludedUndated } = useMemo(() => applyReportFilters({
    rows, dateField, dateFilters, from: applied.from, to: applied.to,
    filters: reportFilters, selections: applied.selections, search: applied.search, columns
  }), [rows, dateField, dateFilters, applied, reportFilters, columns]);

  const sortedRows = useMemo(() => {
    if (!sortCol && !selectedGroup) return filtered;
    const col = columns.find((c) => c.key === sortCol);
    return [...filtered].sort((a, b) => {
      if (selectedGroup) {
        const groupCompare = groupValue(a).localeCompare(groupValue(b), undefined, { numeric: true, sensitivity: 'base' });
        if (groupCompare) return groupCompare;
      }
      if (!sortCol) return 0;
      const valA = col?.renderText ? col.renderText(a) : (a[sortCol] ?? '');
      const valB = col?.renderText ? col.renderText(b) : (b[sortCol] ?? '');
      const numA = Number(valA);
      const numB = Number(valB);
      const isNum = Number.isFinite(numA) && Number.isFinite(numB) && valA !== '' && valB !== '';
      let cmp = 0;
      if (isNum) {
        cmp = numA - numB;
      } else {
        cmp = String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortCol, sortDir, columns, selectedGroup]);
  const groupSummary = useMemo(() => selectedGroup ? Object.entries(filtered.reduce((map, row) => {
    const value = groupValue(row); map[value] = (map[value] || 0) + 1; return map;
  }, {})).map(([value, count]) => ({ value, count })) : [], [filtered, selectedGroup]);
  const exportSummaryTables = [
    ...(typeof summaryTables === 'function' ? summaryTables(filtered) : summaryTables),
    ...(groupSummary.length ? [{ title: `${selectedGroup.label}-wise Summary`, columns: [{ key: 'value', label: selectedGroup.label }, { key: 'count', label: 'Records' }], rows: groupSummary }] : []),
    ...(excludedUndated.length ? [{ title: 'Undated / Invalid Date Exceptions', columns: [{ key: 'reference', label: 'Reference' }, { key: 'dateStatus', label: 'Date Status' }], rows: excludedUndated.map((row, index) => ({ reference: row.reference || row.invoiceNumber || row.poNumber || row.issueNumber || row.returnNumber || row.mrNumber || row.jobCardNumber || `Row ${index + 1}`, dateStatus: 'Missing or invalid date value' })) }] : [])
  ];

  const totalPages = pageSize === 'all' ? 1 : Math.ceil(sortedRows.length / Number(pageSize)) || 1;
  const safePage = Math.min(Math.max(1, page), totalPages);

  const pagedRows = useMemo(() => {
    if (pageSize === 'all') return sortedRows;
    const size = Number(pageSize);
    const start = (safePage - 1) * size;
    return sortedRows.slice(start, start + size);
  }, [sortedRows, safePage, pageSize]);

  const totalValues = useMemo(() => {
    return totals.map((t) => ({ colKey: t.colKey, value: t.render(filtered) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, totals]);

  const handleSort = (colKey) => {
    if (sortCol === colKey) {
      if (sortDir === 'asc') setSortDir('desc');
      else {
        setSortCol(null);
        setSortDir('asc');
      }
    } else {
      setSortCol(colKey);
      setSortDir('asc');
    }
    setPage(1);
  };

  const applyFilters = () => {
    const error = validateReportDateRange(draftFrom, draftTo);
    setFilterError(error);
    if (error) return;
    setApplied({ from: draftFrom, to: draftTo, selections: { ...draftSel }, search: draftSearch.trim() });
    setPage(1);
    setFiltersOpen(false);
  };
  const updateDraftSelection = (key, value) => {
    const next = { ...draftSel, [key]: value };
    setDraftSel(next);
    if (autoApplyFilters) {
      setApplied((previous) => ({ ...previous, selections: next }));
      setPage(1);
    }
  };

  const resetFilters = () => {
    setDraftFrom(''); setDraftTo(''); setDraftSel({});
    setApplied({ from: '', to: '', selections: {}, search: draftSearch.trim() });
    setFilterError(''); setGroupBy(''); setPage(1);
    setFiltersOpen(false);
  };
  const activeCriteria = [
    dateFilters && (applied.from || applied.to) ? `Order Date: ${applied.from || 'any'} to ${applied.to || 'any'}` : '',
    ...Object.entries(applied.selections).filter(([, value]) => value).map(([key, value]) => `${reportFilters.find((filter) => filter.key === key)?.placeholder || key}: ${value}`),
    selectedGroup && `Grouped by ${selectedGroup.label}`,
    applied.search && `Search: ${applied.search}`
  ].filter(Boolean);
  const reportPeriod = (() => {
    if (dateFilters) return `Period: ${applied.from || 'start'} to ${applied.to || 'today'}`;
    const now = new Date();
    return `Report date: ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  })();
  const exportCriteria = [...activeCriteria, ...(excludedUndated.length ? [`Undated or invalid date rows excluded: ${excludedUndated.length}`] : [])];
  const resetDisabled = !draftFrom && !draftTo && !Object.values(draftSel).some(Boolean) && !activeCriteria.some((criterion) => !criterion.startsWith('Search:')) && !groupBy;
  const handlePDF = () => {
    const pdfRows = sortedRows.map((r) => columns.map((c) => exportCellText(r, c)));
    const footerCells = columns.map((c, i) => {
      if (i === 0) return footerLabel;
      const t = totalValues.find((x) => x.colKey === c.key);
      return t ? pad(t.value) : '';
    });
    generateRegisterPDF({
      title,
      subTitle: '',
      period: reportPeriod,
      company: getReportCompanyProfile(),
      logoUrl,
      filters: exportCriteria,
      generatedBy,
      showPreparedBy,
      showReportMeta: false,
      titleAlign: 'center',
      reportModule,
      columns: columns.map((c) => ({ header: c.label, align: c.align, width: c.width })),
      rows: pdfRows,
      footer: footerCells,
      summaryTables: exportSummaryTables.map((table) => ({ ...table, columns: table.columns.map((column) => ({ header: column.label, key: column.key })) })),
      landscape,
      filename: filename || `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}-${new Date().toISOString().slice(0, 10)}`
    });
  };

  const handleExcel = async () => {
    const exportCompany = getReportCompanyProfile();
    const workbook = buildReportWorkbook({
      company: exportCompany, title, subTitle: '',
      period: reportPeriod,
      filters: [], reportModule: '', generatedBy: '', showPreparedBy: false, showReportMeta: false,
      columns: columns.map((column) => ({ key: column.key, label: column.label })),
      rows: sortedRows.map((row) => Object.fromEntries(columns.map((column) => [column.key, exportCellText(row, column)]))),
      summaryTables: exportSummaryTables,
      footer: totals.length ? columns.map((column, index) => index === 0 ? footerLabel : totalValues.find((value) => value.colKey === column.key)?.value ?? '') : []
    });
    XLSX.writeFile(workbook, `${filename || title.replace(/[^a-zA-Z0-9_-]/g, '_')}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const handlePrint = () => {
    scheduleReportPrint({ windowObject: window, setPageSize, currentPageSize: pageSize });
  };

  return (
    <div className="content-block report-register">
      <div className="report-print-header">
        <img src={company.logoUrl || logoUrl} alt="Company logo" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
        <div><strong>{company.companyName || 'Company name not configured'}</strong><div>{companyAddress || 'Company details not configured'}</div></div>
      </div>
      <div className="block-header report-register-heading">
        <h3 className="block-title report-register-title">{title}</h3>
        <span className="muted-text report-register-count">
          {filtered.length} record(s){filtered.length !== rows.length ? ` (filtered from ${rows.length})` : ''}
        </span>
      </div>
      {!dateFilters && dateFilterNote && <div className="field-hint" style={{ marginBottom: 8 }}>{dateFilterNote}</div>}

      {(typeof summaryCards === 'function' ? summaryCards(filtered) : summaryCards)?.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fit, minmax(190px, 1fr))`,
            gap: '12px',
            marginBottom: '16px'
          }}
        >
          {(typeof summaryCards === 'function' ? summaryCards(filtered) : summaryCards).map((c, i) => (
            <div
              key={i}
              style={{
                background: c.bg || '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: '10px',
                padding: '12px 16px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.03)'
              }}
            >
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {c.label}
              </div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: c.color || '#0f172a', marginTop: '4px' }}>
                {c.value}
              </div>
              {c.subtitle && (
                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                  {c.subtitle}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {typeof summaryContent === 'function' ? summaryContent(filtered) : summaryContent}
      {groupSummary.length > 0 && <div className="content-block" style={{ marginBottom: 12 }}><div className="block-header"><h3 className="block-title">{selectedGroup.label}-wise Summary</h3><span className="muted-text">record counts from applied filters</span></div><div className="history-table-wrapper"><table className="history-table report-table"><thead><tr><th>{selectedGroup.label}</th><th>Records</th></tr></thead><tbody>{groupSummary.map((entry) => <tr key={entry.value}><td>{entry.value}</td><td>{entry.count}</td></tr>)}</tbody></table></div></div>}
      {excludedUndated.length > 0 && (
        <details className="content-block" style={{ marginBottom: 12, color: '#92400e' }}>
          <summary>{excludedUndated.length} undated or invalid-date row(s) excluded by the selected date range</summary>
          <div className="history-table-wrapper" style={{ marginTop: 8 }}>
            <table className="history-table report-table"><thead><tr><th>Reference</th><th>Date status</th></tr></thead><tbody>
              {excludedUndated.map((row, index) => <tr key={index}><td>{row.reference || row.invoiceNumber || row.poNumber || row.issueNumber || row.returnNumber || row.mrNumber || row.jobCardNumber || `Row ${index + 1}`}</td><td>Missing or invalid date value</td></tr>)}
            </tbody></table>
          </div>
        </details>
      )}
      {filterError && <div className="form-error" role="alert" style={{ marginBottom: 8 }}>{filterError}</div>}

      <div className="report-filter-bar">
        {onToolbarSearchChange && <input
          type="search"
          className="action-select form-input search-input"
          placeholder={toolbarSearchPlaceholder}
          aria-label={toolbarSearchPlaceholder}
          value={toolbarSearchValue || ''}
          onChange={(event) => onToolbarSearchChange(event.target.value)}
          style={{ minWidth: '220px' }}
        />}
        {showSearch && !onToolbarSearchChange && <input
          type="search"
          className="action-select form-input search-input"
          placeholder="Search records"
          aria-label="Search records"
          value={draftSearch}
          onChange={(event) => {
            const value = event.target.value;
            setDraftSearch(value);
            setApplied((previous) => ({ ...previous, search: value.trim() }));
            setPage(1);
          }}
          style={{ minWidth: '200px' }}
        />}
        {filtersDropdown ? (
          <ReportFilterPanel open={filtersOpen} onOpenChange={setFiltersOpen} onApply={applyFilters} onReset={resetFilters} resetDisabled={resetDisabled} ariaLabel={`${title} filters`}>
            {dateFilters && <>
              <label className="report-filter-dropdown__date"><span>From Date</span><input type="date" className="action-select form-input" value={draftFrom} onChange={(e) => { setDraftFrom(e.target.value); setFilterError(''); }} aria-label="From date" /></label>
              <label className="report-filter-dropdown__date"><span>To Date</span><input type="date" className="action-select form-input" value={draftTo} onChange={(e) => { setDraftTo(e.target.value); setFilterError(''); }} aria-label="To date" /></label>
            </>}
            {reportFilters.map((f) => <label className="report-filter-dropdown__select" key={f.key}>
              <span>{f.label || f.placeholder || 'Filter'}</span>
              <select className="action-select" value={draftSel[f.key] || ''} onChange={(e) => updateDraftSelection(f.key, e.target.value)}>
                <option value="">{f.placeholder || 'All'}</option>{(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>)}
            {groupOptions.length > 0 && <label className="report-filter-dropdown__select"><span>Group By</span><select className="action-select" aria-label="Group by" value={groupBy} onChange={(event) => setGroupBy(event.target.value)}><option value="">No grouping</option>{groupOptions.map((option) => <option key={option.key} value={option.key}>Group by {option.label}</option>)}</select></label>}
          </ReportFilterPanel>
        ) : (        <>
        {dateFilters && (
          <>
            <input
              type="date"
              className="action-select form-input search-input"
              value={draftFrom}
              onChange={(e) => { setDraftFrom(e.target.value); setFilterError(''); }}
              aria-label="From date"
            />
            <span className="muted-text">to</span>
            <input
              type="date"
              className="action-select form-input search-input"
              value={draftTo}
              onChange={(e) => { setDraftTo(e.target.value); setFilterError(''); }}
              aria-label="To date"
            />
          </>
        )}
        {reportFilters.map((f) => (
          <select
            key={f.key}
            className="action-select"
            value={draftSel[f.key] || ''}
            onChange={(e) => updateDraftSelection(f.key, e.target.value)}
          >
            <option value="">{f.placeholder || 'All'}</option>
            {(f.options || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ))}
        {groupOptions.length > 0 && <select className="action-select" aria-label="Group by" value={groupBy} onChange={(event) => setGroupBy(event.target.value)}><option value="">No grouping</option>{groupOptions.map((option) => <option key={option.key} value={option.key}>Group by {option.label}</option>)}</select>}
        {!hideFilterActions && <>
          <button type="button" className="button-primary button-small" onClick={applyFilters}>Apply Filters</button>
          <button type="button" className="button-secondary button-small" onClick={resetFilters} disabled={resetDisabled}>Reset Filters</button>
        </>}
          </>
        )}
        <button type="button" className="button-secondary button-small" onClick={handlePDF} title={`Download ${title} as PDF`}>
          Download PDF
        </button>
        {!pdfOnly && <button type="button" className="button-secondary button-small" onClick={handleExcel} title={`Download ${title} as Excel`}>Download Excel</button>}
        {!pdfOnly && enableCSV && <button type="button" className="button-secondary button-small" onClick={() => {
          const headers = columns.map((c) => ({ label: c.label, key: c.key }));
          const csvRows = sortedRows.map((r) => Object.fromEntries(columns.map((c) => [c.key, exportCellText(r, c)])));
          exportToCSV(filename || title.replace(/[^a-zA-Z0-9_-]/g, '_'), headers, csvRows);
        }}>Download CSV</button>}
        {(!pdfOnly || showPrint) && <button type="button" className="button-secondary button-small" onClick={handlePrint} title={`Print all filtered rows for ${title}`}>
          Print
        </button>}
      </div>

      <div className="report-period-label">{reportPeriod}</div>
      <div className="history-table-wrapper">
        <table className="history-table report-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => handleSort(c.key)}
                  style={{
                    textAlign: c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left',
                    cursor: 'pointer',
                    userSelect: 'none'
                  }}
                  title={`Click to sort by ${c.label}`}
                >
                  {c.label}
                  <span style={{ marginLeft: '4px', fontSize: '10px', color: sortCol === c.key ? '#2563eb' : '#94a3b8' }}>
                    {sortCol === c.key ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pagedRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="no-history-row">
                  No records for the selected period / filter.
                </td>
              </tr>
            ) : (
              pagedRows.map((r, idx) => (
                <tr key={idx}>
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      style={{
                        textAlign: c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left'
                      }}
                    >
                      {cellText(r, c)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {totals.length > 0 && (
            <tfoot>
              <tr>
                {columns.map((c, i) => {
                  if (i === 0) {
                    return (
                      <td key={c.key} style={{ fontWeight: 'bold', textAlign: 'right' }}>
                        {footerLabel}:
                      </td>
                    );
                  }
                  const t = totalValues.find((x) => x.colKey === c.key);
                  return (
                    <td key={c.key} style={{ fontWeight: 'bold', textAlign: c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left' }}>
                      {t ? pad(t.value) : ''}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {!hidePagination && sortedRows.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '10px',
            marginTop: '12px',
            fontSize: '12px',
            color: '#64748b'
          }}
        >
          <div>
            Showing {pageSize === 'all' ? 1 : (safePage - 1) * Number(pageSize) + 1} to{' '}
            {pageSize === 'all' ? sortedRows.length : Math.min(safePage * Number(pageSize), sortedRows.length)} of{' '}
            {sortedRows.length} records
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>Rows per page:</span>
            <select
              className="action-select"
              value={pageSize}
              onChange={(e) => {
                setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value));
                setPage(1);
              }}
              style={{ padding: '3px 8px', fontSize: '12px', minWidth: '70px', height: '28px' }}
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value="all">All</option>
            </select>
            <button
              type="button"
              className="button-secondary button-small"
              disabled={safePage <= 1 || pageSize === 'all'}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              style={{ opacity: safePage <= 1 || pageSize === 'all' ? 0.5 : 1, padding: '3px 9px' }}
            >
              Previous
            </button>
            <span>
              Page {safePage} of {totalPages}
            </span>
            <button
              type="button"
              className="button-secondary button-small"
              disabled={safePage >= totalPages || pageSize === 'all'}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              style={{ opacity: safePage >= totalPages || pageSize === 'all' ? 0.5 : 1, padding: '3px 9px' }}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReportRegister;
