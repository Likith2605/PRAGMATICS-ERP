import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildCheckReport,
  buildDispatchReport,
  buildDrawingReport
} from '../quality/qualityApi.js';
import {
  getCheck,
  getDrawing,
  listChecks as listQualityChecksApi,
  listDispatches as listQualityDispatchesApi,
  listDrawings as listQualityDrawingsApi
} from '../services/qualityApi.js';
import { buildQualityReportSnapshot } from '../utils/qualityReportData.js';
import { buildOverallReportHtml, buildReportHtml } from '../quality/report/pdf.js';
import { QUALITY_REPORT_FOOTER } from '../quality/report/footer.js';
import { buildDispatchQrSvg, buildStickerHtml } from '../quality/report/sticker.js';
import { getLogoDataUri } from '../quality/report/logo.js';
import * as XLSX from 'xlsx';
import { getReportCompanyProfile } from '../utils/reportData.js';
import { getCurrentUserInfo } from '../utils/permissions.js';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { generateRegisterPDF } from '../services/pdfGenerator.js';
import { buildReportWorkbook } from '../utils/reportExports.js';
import { applyReportFilters, validateReportDateRange } from '../utils/reportFilters.js';
import ReportFilterPanel from '../components/ReportFilterPanel.jsx';
import './quality-report.css';

const TABS = [
  { key: 'overall', label: 'Overall Report' },
  { key: 'individual', label: 'Individual Report' },
  { key: 'dispatch', label: 'Dispatch Report' }
];

const AUTO_REFRESH_MS = 30000;

const fmtDateTime = (value) => {
  if (!value) return '-';
  const parsed = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('en-IN');
};

const statusBadge = (value) => (
  <span className={`status-badge st-${String(value || '').toLowerCase()}`}>{value || '-'}</span>
);

const loadQualityReportSnapshot = async () => {
  const [drawings, checks, dispatches] = await Promise.all([
    listQualityDrawingsApi(),
    listQualityChecksApi(),
    listQualityDispatchesApi()
  ]);
  const [drawingDetails, checkDetails] = await Promise.all([
    Promise.all(drawings.map((drawing) => getDrawing(drawing.id))),
    Promise.all(checks.map((check) => getCheck(check.id)))
  ]);
  return buildQualityReportSnapshot({ drawings, checks, dispatches, drawingDetails, checkDetails });
};

/* ------------------------------------------------------------------ */
/* Report viewer                                                       */
/* ------------------------------------------------------------------ */

const ReportViewer = ({ report, onClose }) => {
  const frameRef = useRef(null);

  const print = () => {
    const frame = frameRef.current;
    if (frame?.contentWindow) {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }
  };

  const exportExcel = async () => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    const profile = getReportCompanyProfile();
    const workbook = XLSX.utils.book_new();
    const tables = [...doc.querySelectorAll('table')];
    const worksheetList = tables.length ? tables : [null];
    worksheetList.forEach((table, index) => {
      const sheetName = (tables.length > 1 ? `Report ${index + 1}` : report.title).replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31) || 'Report';
      const rowData = table
        ? [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th,td')].map((cell) => cell.innerText.trim()))
        : [...doc.querySelectorAll('.row')].map((row) => [...row.querySelectorAll('.label,.value')].map((cell) => cell.innerText.trim()));
      const aoa = [
        [profile.companyName || 'Company'],
        [[profile.address, profile.phone, profile.email, profile.website, profile.gstin && `GSTIN: ${profile.gstin}`, profile.pan && `PAN: ${profile.pan}`].filter(Boolean).join(' | ')],
        [report.title],
        [`Generated: ${new Date().toLocaleString('en-IN')}`],
        [],
        ...rowData
      ];
      const sheet = XLSX.utils.aoa_to_sheet(aoa);
      const maxCols = Math.max(1, ...aoa.map((row) => row.length));
      sheet['!cols'] = Array.from({ length: maxCols }, (_, col) => ({ wch: Math.min(44, Math.max(14, ...aoa.map((row) => String(row[col] || '').length + 2))) }));
      if (rowData.length && table?.querySelector('thead')) {
        const headerRow = 5;
        sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: Math.max(headerRow, aoa.length - 1), c: maxCols - 1 } }) };
        sheet['!freeze'] = { xSplit: 0, ySplit: headerRow + 1, topLeftCell: `A${headerRow + 2}`, activePane: 'bottomLeft', state: 'frozen' };
      }
      XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
    });
    XLSX.writeFile(workbook, `${report.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.xlsx`);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.65)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 1000
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '10px 16px',
          background: '#fff',
          borderBottom: '1px solid #e2e8f0'
        }}
      >
        <strong style={{ color: '#0f172a' }}>{report.title}</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="button-secondary button-small" onClick={exportExcel}>Download Excel</button>
          <button type="button" className="button-secondary button-small" onClick={print}>
            Print / Save PDF
          </button>
          <button type="button" className="button-primary button-small" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <iframe
        ref={frameRef}
        title={report.title}
        srcDoc={report.html}
        style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }}
      />
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const QualityReportPage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const [tab, setTab] = useState('overall');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [groupBy, setGroupBy] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({ from: '', to: '', search: '', customer: '', employee: '', status: '' });
  const [filterError, setFilterError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [records, setRecords] = useState({ individual: [], overall: [], dispatch: [] });
  const [reportData, setReportData] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastSync, setLastSync] = useState(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const generatedBy = getCurrentUserInfo().employee?.name || 'User';

  const pullLatest = useCallback(loadQualityReportSnapshot, []);
  const publishSnapshot = (snapshot) => {
    setReportData(snapshot);
    setRecords({
      individual: snapshot.checks,
      overall: snapshot.drawings,
      dispatch: snapshot.dispatches
    });
  };
  const clearSnapshot = () => {
    setReportData(null);
    setRecords({ individual: [], overall: [], dispatch: [] });
    setReport(null);
  };

  useEffect(() => {
    let active = true;
    pullLatest().then((snapshot) => {
      if (!active) return;
      publishSnapshot(snapshot);
      setLastSync(new Date());
    }).catch((err) => {
      if (!active) return;
      clearSnapshot();
      setError(`Quality report data could not be loaded from PostgreSQL: ${err.message}`);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [pullLatest]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const snapshot = await pullLatest();
        publishSnapshot(snapshot);
        setError('');
        setLastSync(new Date());
      } catch (err) {
        clearSnapshot();
        setError(`Quality report data could not be loaded from PostgreSQL: ${err.message}`);
      }
    };
    const id = setInterval(tick, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, pullLatest]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const onWake = () => {
      if (document.hidden) return;
      pullLatest()
        .then((snapshot) => {
          publishSnapshot(snapshot);
          setError('');
          setLastSync(new Date());
        })
        .catch((err) => {
          clearSnapshot();
          setError(`Quality report data could not be loaded from PostgreSQL: ${err.message}`);
        });
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [autoRefresh, pullLatest]);

  const refresh = async () => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const snapshot = await pullLatest();
      publishSnapshot(snapshot);
      setLastSync(new Date());
      setMessage('Updated from PostgreSQL.');
    } catch (err) {
      clearSnapshot();
      setError(`Quality report data could not be loaded from PostgreSQL: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const viewIndividual = async (record) => {
    const payload = buildCheckReport(record.id, reportData);
    if (!payload) {
      setMessage('That report is no longer available. Refresh and try again.');
      return;
    }
    const logo = await getLogoDataUri();
    const company = getReportCompanyProfile();
    setReport({
      title: `Inspection Report QIR-${payload.check.id}`,
      html: buildReportHtml(payload, logo, company, generatedBy)
    });
  };

  const viewOverall = async (record) => {
    const payload = buildDrawingReport(record.id, reportData);
    if (!payload) {
      setMessage('That report is no longer available. Refresh and try again.');
      return;
    }
    const logo = await getLogoDataUri();
    const company = getReportCompanyProfile();
    setReport({
      title: `Overall Report ${payload.drawing.drawing_no}`,
      html: buildOverallReportHtml(payload, logo, company, generatedBy)
    });
  };

  const viewDispatch = async (record) => {
    const payload = buildDispatchReport(record.id, reportData);
    if (!payload) {
      setMessage('That report is no longer available. Refresh and try again.');
      return;
    }
    const qrSvg = await buildDispatchQrSvg(payload);
    const [logo, company] = await Promise.all([getLogoDataUri(), Promise.resolve(getReportCompanyProfile())]);
    setReport({
      title: `Dispatch Sticker ${payload.dispatch_no}`,
      html: buildStickerHtml(payload, qrSvg, company, logo)
    });
  };

  const qualityColumns = tab === 'dispatch'
    ? [{ key: 'dispatch_no', label: 'Dispatch No' }, { key: 'drawing_no', label: 'Drawing' }, { key: 'part_name', label: 'Part' }, { key: 'po_no', label: 'PO' }, { key: 'qty', label: 'Qty' }, { key: 'dispatched_at', label: 'Dispatched' }]
    : [{ key: 'drawing_no', label: 'Drawing' }, { key: 'part_name', label: 'Part' }, { key: tab === 'individual' ? 'checked_at' : 'drawing_rev_date', label: tab === 'individual' ? 'Checked On' : 'Revision Date' }, { key: tab === 'individual' ? 'result' : 'customer', label: tab === 'individual' ? 'Result' : 'Customer' }, { key: tab === 'individual' ? 'inspector_employee_name' : 'po_no', label: tab === 'individual' ? 'Inspector' : 'PO' }];
  const dateField = tab === 'individual' ? 'checked_at' : tab === 'dispatch' ? 'dispatched_at' : 'drawing_rev_date';
  const qualitySource = records[tab] || [];
  const qualityDimensions = useMemo(() => {
    const fieldSets = [
      ['customer', 'Customer', ['customer']],
      ['employee', 'Employee', tab === 'dispatch' ? ['dispatcher_name'] : ['inspector_employee_name', 'inspector_name']],
      ['status', 'Status', tab === 'individual' ? ['result'] : ['status']]
    ];
    return fieldSets.flatMap(([key, label, fields]) => {
      const values = [...new Set(qualitySource.flatMap((record) => fields.map((field) => record[field]).filter((value) => value !== null && value !== undefined && String(value).trim()).map((value) => String(value).trim())))].sort();
      return values.length ? [{ key: `quality_${key}`, label, placeholder: `All ${label}s`, options: values.map((value) => ({ value, label: value })), valueForRecord: (record) => fields.map((field) => String(record[field] ?? '').trim()).find(Boolean) || 'Identity not recorded', match: (record, value) => fields.some((field) => String(record[field] ?? '').trim() === value) }] : [];
    });
  }, [qualitySource, tab]);
  const qualitySelections = {
    quality_customer: appliedFilters.customer,
    quality_employee: appliedFilters.employee,
    quality_status: appliedFilters.status
  };
  const { filteredRows: visible, excludedUndated } = useMemo(() => applyReportFilters({
    rows: qualitySource, dateField, from: appliedFilters.from, to: appliedFilters.to,
    filters: qualityDimensions, selections: qualitySelections, search: appliedFilters.search, columns: qualityColumns
  }), [qualitySource, dateField, appliedFilters, qualityDimensions, qualityColumns]);
  const activeGroup = qualityDimensions.find((filter) => filter.key === groupBy);
  const groupedQualityRows = activeGroup ? [...visible].sort((a, b) => activeGroup.valueForRecord(a).localeCompare(activeGroup.valueForRecord(b))) : visible;
  const qualityGroupSummary = activeGroup ? Object.values(visible.reduce((map, row) => { const name = activeGroup.valueForRecord(row); map[name] = map[name] || { name, count: 0 }; map[name].count += 1; return map; }, {})) : [];

  const applyQualityFilters = () => {
    const error = validateReportDateRange(fromDate, toDate);
    setFilterError(error);
    if (error) return;
    setAppliedFilters({ from: fromDate, to: toDate, search, customer: customerFilter, employee: employeeFilter, status: statusFilter });
    setFiltersOpen(false);
  };
  const resetQualityFilters = () => {
    setFromDate(''); setToDate(''); setCustomerFilter(''); setEmployeeFilter(''); setStatusFilter('');
    setAppliedFilters({ from: '', to: '', search: search.trim(), customer: '', employee: '', status: '' }); setFilterError(''); setGroupBy('');
    setFiltersOpen(false);
  };
  const activeQualityCriteria = [
    (appliedFilters.from || appliedFilters.to) && `Date: ${appliedFilters.from || 'any'} to ${appliedFilters.to || 'any'}`,
    appliedFilters.customer && `Customer: ${appliedFilters.customer}`,
    appliedFilters.employee && `Employee: ${appliedFilters.employee}`,
    appliedFilters.status && `Status: ${appliedFilters.status}`,
    appliedFilters.search && `Search: ${appliedFilters.search}`,
    activeGroup && `Grouped by ${activeGroup.label}`
  ].filter(Boolean);
  const qualityExportCriteria = [...activeQualityCriteria, ...(excludedUndated.length ? [`Undated/invalid-date records excluded: ${excludedUndated.length}`] : [])];
  const qualityExceptionTables = excludedUndated.length ? [{ title: 'Undated / Invalid Date Exceptions', columns: [{ key: 'reference', header: 'Reference' }, { key: 'dateStatus', header: 'Date Status' }], rows: excludedUndated.map((record) => ({ reference: record.drawing_no || record.dispatch_no || record.id, dateStatus: `Missing or invalid ${dateField}` })) }] : [];

  const exportQualityRows = () => {
    const company = getReportCompanyProfile();
    const exportRows = groupedQualityRows.map((record) => qualityColumns.map((column) => String(record[column.key] ?? '')));
    generateRegisterPDF({ title: `Quality ${TABS.find((entry) => entry.key === tab)?.label || 'Report'}`, subTitle: '', period: `Period: ${appliedFilters.from || 'start'} to ${appliedFilters.to || 'today'}`, company, logoUrl, showPreparedBy: false, showReportMeta: false, footerText: QUALITY_REPORT_FOOTER, showPageNumber: false, columns: qualityColumns.map((column) => ({ header: column.label })), rows: exportRows, summaryTables: [...(activeGroup ? [{ title: `${activeGroup.label}-wise Summary`, columns: [{ key: 'name', header: activeGroup.label }, { key: 'count', header: 'Records' }], rows: qualityGroupSummary }] : []), ...qualityExceptionTables], filename: `Quality-${tab}-${new Date().toISOString().slice(0, 10)}` });
  };
  const exportQualityExcel = () => {
    const workbook = buildReportWorkbook({ company: getReportCompanyProfile(), title: `Quality ${TABS.find((entry) => entry.key === tab)?.label || 'Report'}`, subTitle: `${visible.length} filtered record(s)`, period: `Period: ${appliedFilters.from || 'start'} to ${appliedFilters.to || 'today'}`, filters: qualityExportCriteria, reportModule: 'Quality', generatedBy, columns: qualityColumns, rows: groupedQualityRows, summaryTables: [...(activeGroup ? [{ title: `${activeGroup.label}-wise Summary`, columns: [{ key: 'name', label: activeGroup.label }, { key: 'count', label: 'Records' }], rows: qualityGroupSummary }] : []), ...qualityExceptionTables] });
    XLSX.writeFile(workbook, `Quality-${tab}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const drawingSuggestions = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return records.overall
      .filter((drawing) =>
        [drawing.id, drawing.drawing_no, drawing.part_name, drawing.customer]
          .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
          .some((value) => String(value).toLowerCase().includes(term))
      )
      .slice(0, 8);
  }, [records.overall, search]);

  const chooseDrawing = (drawing) => {
    const value = String(drawing.drawing_no);
    setSearch(value);
    setAppliedFilters((previous) => ({ ...previous, search: value }));
    setSuggestOpen(false);
  };

  const handleSearchKeys = (event) => {
    if (event.key === 'Escape') {
      setSuggestOpen(false);
      return;
    }
    if (!suggestOpen || drawingSuggestions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveSuggestion((index) => (index + 1) % drawingSuggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveSuggestion((index) => (index - 1 + drawingSuggestions.length) % drawingSuggestions.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      chooseDrawing(drawingSuggestions[activeSuggestion]);
    }
  };

  return (
    <section className="page-section quality-report-page">
      <div className="page-header">
        <h1 className="page-title">Quality Report</h1>
      </div>

      <div className="list-filters" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={tab === entry.key ? 'button-primary button-small' : 'button-secondary button-small'}
            onClick={() => {
              setTab(entry.key);
              setGroupBy('');
              setSearch('');
              setFromDate(''); setToDate(''); setCustomerFilter(''); setEmployeeFilter(''); setStatusFilter(''); setFilterError('');
              setAppliedFilters({ from: '', to: '', search: '', customer: '', employee: '', status: '' });
            }}
          >
            {entry.label}
          </button>
        ))}

        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <input
            className="search-input"
            style={{ maxWidth: 260 }}
            value={search}
            onChange={(event) => {
              const value = event.target.value;
              setSearch(value);
              setAppliedFilters((previous) => ({ ...previous, search: value }));
              setSuggestOpen(true);
              setActiveSuggestion(0);
            }}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => window.setTimeout(() => setSuggestOpen(false), 150)}
            onKeyDown={handleSearchKeys}
            placeholder="Search drawing no..."
          />
          {suggestOpen && drawingSuggestions.length > 0 ? (
            <ul
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                zIndex: 40,
                margin: 0,
                padding: 0,
                listStyle: 'none',
                width: 300,
                maxHeight: 260,
                overflowY: 'auto',
                background: '#fff',
                border: '1px solid #cbd5e1',
                borderRadius: 6,
                boxShadow: '0 10px 25px rgba(15, 23, 42, 0.18)'
              }}
            >
              {drawingSuggestions.map((drawing, index) => (
                <li key={drawing.id}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseDrawing(drawing)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 12px',
                      border: 0,
                      background: index === activeSuggestion ? '#eff6ff' : 'transparent',
                      cursor: 'pointer'
                    }}
                  >
                    <strong style={{ color: '#0f172a' }}>{drawing.drawing_no}</strong>
                    <span style={{ color: '#64748b', fontSize: 12 }}>
                      {' '}
                      &middot; {drawing.part_name || '-'}
                      {drawing.customer ? ` · ${drawing.customer}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <ReportFilterPanel open={filtersOpen} onOpenChange={setFiltersOpen} onApply={applyQualityFilters} onReset={resetQualityFilters} ariaLabel="Quality report filters">
          <label className="report-filter-dropdown__date"><span>From Date</span><input type="date" className="action-select form-input" aria-label="From date" value={fromDate} onChange={(event) => { setFromDate(event.target.value); setFilterError(''); }} /></label>
          <label className="report-filter-dropdown__date"><span>To Date</span><input type="date" className="action-select form-input" aria-label="To date" value={toDate} onChange={(event) => { setToDate(event.target.value); setFilterError(''); }} /></label>
          {qualityDimensions.map((filter) => {
            const value = filter.key === 'quality_customer' ? customerFilter : filter.key === 'quality_employee' ? employeeFilter : statusFilter;
            const setter = filter.key === 'quality_customer' ? setCustomerFilter : filter.key === 'quality_employee' ? setEmployeeFilter : setStatusFilter;
            return <label className="report-filter-dropdown__select" key={filter.key}><span>{filter.label}</span><select className="action-select" aria-label={filter.label} value={value} onChange={(event) => setter(event.target.value)}><option value="">{filter.placeholder}</option>{filter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
          })}
          {(qualityDimensions.some((filter) => filter.key === 'quality_customer') || qualityDimensions.some((filter) => filter.key === 'quality_employee')) && <label className="report-filter-dropdown__select"><span>Group By</span><select className="action-select" aria-label="Group by" value={groupBy} onChange={(event) => setGroupBy(event.target.value)}><option value="">No grouping</option>{qualityDimensions.filter((filter) => ['quality_customer', 'quality_employee'].includes(filter.key)).map((filter) => <option key={filter.key} value={filter.key}>Group by {filter.label}</option>)}</select></label>}
        </ReportFilterPanel>                <button type="button" className="button-secondary button-small" onClick={exportQualityRows} disabled={loading || Boolean(error)}>Download PDF</button>
        <button type="button" className="button-secondary button-small" onClick={exportQualityExcel} disabled={loading || Boolean(error)}>Download Excel</button>
        <button type="button" className="button-secondary button-small" onClick={() => window.print()}>Print</button>
        <button type="button" className="button-secondary button-small" onClick={refresh} disabled={busy}>
          {busy ? 'Syncing...' : 'Refresh'}
        </button>
        <label className="field-hint" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.target.checked)}
          />
          Auto refresh ({AUTO_REFRESH_MS / 1000}s)
        </label>
        {lastSync ? <span className="field-hint">Updated {lastSync.toLocaleTimeString('en-IN')}</span> : null}
      </div>

      {loading ? <p role="status" className="field-hint">Loading quality reports from PostgreSQL...</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="field-hint">{message}</p> : null}
      {filterError ? <p className="form-error" role="alert">{filterError}</p> : null}
      {!loading && !error && <>
      {activeQualityCriteria.length > 0 ? <p className="field-hint">Filters: {activeQualityCriteria.join(' | ')}</p> : null}
      {excludedUndated.length > 0 ? <details className="content-block"><summary>{excludedUndated.length} records excluded because {dateField} is missing or invalid</summary><ul>{excludedUndated.map((record) => <li key={record.id}>{record.drawing_no || record.dispatch_no || record.id}: no valid {dateField}</li>)}</ul></details> : null}
      {qualityGroupSummary.length > 0 ? <div className="content-block"><h3 className="block-title">{activeGroup.label}-wise Summary</h3><table className="history-table report-table"><thead><tr><th>{activeGroup.label}</th><th>Records</th></tr></thead><tbody>{qualityGroupSummary.map((entry) => <tr key={entry.name}><td>{entry.name}</td><td>{entry.count}</td></tr>)}</tbody></table></div> : null}

      {visible.length === 0 ? (
        <div className="empty-state">
          <p>No records found.</p>
        </div>
      ) : (
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                {tab === 'dispatch' ? (
                  <>
                    <th>Dispatch No</th>
                    <th>Drawing</th>
                    <th>Part</th>
                    <th>PO</th>
                    <th>Qty</th>
                    <th>Dispatched</th>
                  </>
                ) : (
                  <>
                    <th>Drawing</th>
                    <th>Part</th>
                    <th>{tab === 'individual' ? 'Checked On' : 'Rev / Date'}</th>
                    <th>{tab === 'individual' ? 'Result' : 'Customer'}</th>
                    <th>{tab === 'individual' ? 'Inspector' : 'PO'}</th>
                  </>
                )}
                <th />
              </tr>
            </thead>
            <tbody>
                {groupedQualityRows.map((record) => (
                <tr key={record.id}>
                  {tab === 'dispatch' ? (
                    <>
                      <td>{record.dispatch_no}</td>
                      <td>{record.drawing_no}</td>
                      <td>{record.part_name}</td>
                      <td>{record.po_no || '-'}</td>
                      <td>{record.qty || '-'}</td>
                      <td>{fmtDateTime(record.dispatched_at)}</td>
                    </>
                  ) : (
                    <>
                      <td>{record.drawing_no}</td>
                      <td>{record.part_name}</td>
                      <td>
                        {tab === 'individual'
                          ? fmtDateTime(record.checked_at)
                          : `${record.revision || '-'} / ${record.drawing_rev_date || '-'}`}
                      </td>
                      <td>{tab === 'individual' ? statusBadge(record.result) : record.customer || '-'}</td>
                      <td>
                        {tab === 'individual'
                          ? record.inspector_name || record.inspector_employee_name || '-'
                          : record.po_no || '-'}
                      </td>
                    </>
                  )}
                  <td className="action-column">
                    <div className="table-actions">
                      <button
                        type="button"
                        className="button-primary button-small"
                        onClick={() => {
                          if (tab === 'individual') viewIndividual(record);
                          else if (tab === 'overall') viewOverall(record);
                          else viewDispatch(record);
                        }}
                      >
                        View
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>}

      {report ? <ReportViewer report={report} onClose={() => setReport(null)} /> : null}
    </section>
  );
};

export default QualityReportPage;
