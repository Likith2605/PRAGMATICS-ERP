import * as XLSX from 'xlsx';

export const buildReportWorkbook = ({
  company = {}, title = 'Report', subTitle = '', period = '', filters = [],
  reportModule = 'Reports', generatedBy = 'User', columns = [], rows = [], footer = [], footerLabel = 'TOTAL',
  summaryTables = []
}) => {
  const address = [company.address, company.phone && `Phone: ${company.phone}`, company.email,
    company.website, company.gstin && `GSTIN: ${company.gstin}`, company.pan && `PAN: ${company.pan}`]
    .filter(Boolean).join('  |  ');
  const metadata = [
    [company.companyName || 'Company'],
    [address || 'Company details not configured'],
    [title],
    [[subTitle, period, ...filters].filter(Boolean).join(' | ')],
    [`Module: ${reportModule} | Generated: ${new Date().toLocaleString('en-IN')} | Prepared by: ${generatedBy}`],
    [],
    columns.map((column) => column.label),
    ...rows.map((row) => columns.map((column) => String(row[column.key] ?? '')))
  ];
  if (footer.length) metadata.push(columns.map((column, index) => index === 0 ? footerLabel : footer[index] ?? ''));
  const worksheet = XLSX.utils.aoa_to_sheet(metadata);
  worksheet['!cols'] = columns.map((column) => ({ wch: Math.min(42, Math.max(14, column.label.length + 4)) }));
  if (columns.length) worksheet['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: 6, c: 0 }, e: { r: Math.max(6, metadata.length - 1), c: columns.length - 1 } })
  };
  worksheet['!freeze'] = { xSplit: 0, ySplit: 7, topLeftCell: 'A8', activePane: 'bottomLeft', state: 'frozen' };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, (title || 'Report').slice(0, 31));
  summaryTables.forEach((summary, index) => {
    const summaryRows = [summary.columns.map((column) => column.label), ...summary.rows.map((row) => summary.columns.map((column) => String(row[column.key] ?? '')))];
    const summarySheet = XLSX.utils.aoa_to_sheet([[company.companyName || 'Company'], [summary.title || `Summary ${index + 1}`], [period], [filters.join(' | ')], [], ...summaryRows]);
    summarySheet['!cols'] = summary.columns.map((column) => ({ wch: Math.min(42, Math.max(14, column.label.length + 4)) }));
    XLSX.utils.book_append_sheet(workbook, summarySheet, `${(summary.title || 'Summary').slice(0, 22)}-${index + 1}`.slice(0, 31));
  });
  return workbook;
};

export const scheduleReportPrint = ({ windowObject = window, setPageSize, currentPageSize }) => {
  setPageSize('all');
  windowObject.setTimeout(() => {
    windowObject.print();
    setPageSize(currentPageSize);
  }, 0);
};
