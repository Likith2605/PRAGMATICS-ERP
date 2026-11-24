import * as XLSX from 'xlsx';

export const buildReportWorkbook = ({
  company = {}, title = 'Report', subTitle = '', period = '', filters = [],
  reportModule = 'Reports', generatedBy = 'User', showPreparedBy = true, showReportMeta = true, columns = [], rows = [], footer = [], footerLabel = 'TOTAL',
  summaryTables = []
}) => {
  const address = [company.address, company.phone && `Phone: ${company.phone}`, company.email,
    company.website, company.gstin && `GSTIN: ${company.gstin}`, company.pan && `PAN: ${company.pan}`]
    .filter(Boolean).join('  |  ');
  const metadata = [
    [company.companyName || 'Company'],
    [address || 'Company details not configured'],
    [title]
  ];
  if (showReportMeta) metadata.push([[subTitle, period, ...filters].filter(Boolean).join(' | ')], [`Module: ${reportModule} | Generated: ${new Date().toLocaleString('en-IN')}${showPreparedBy && generatedBy ? ` | Prepared by: ${generatedBy}` : ''}`]);
  else if (period) metadata.push([period]);
  metadata.push([]);
  const headerRow = metadata.length;
  metadata.push(columns.map((column) => column.label), ...rows.map((row) => columns.map((column) => String(row[column.key] ?? ''))));
  if (footer.length) metadata.push(columns.map((column, index) => index === 0 ? footerLabel : footer[index] ?? ''));
  const worksheet = XLSX.utils.aoa_to_sheet(metadata);
  worksheet['!cols'] = columns.map((column) => ({ wch: Math.min(42, Math.max(14, column.label.length + 4)) }));
  if (columns.length) worksheet['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: Math.max(headerRow, metadata.length - 1), c: columns.length - 1 } })
  };
  worksheet['!freeze'] = { xSplit: 0, ySplit: headerRow + 1, topLeftCell: `A${headerRow + 2}`, activePane: 'bottomLeft', state: 'frozen' };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, (title || 'Report').slice(0, 31));
  summaryTables.forEach((summary, index) => {
    const summaryRows = [summary.columns.map((column) => column.label), ...summary.rows.map((row) => summary.columns.map((column) => String(row[column.key] ?? '')))];
    const summaryMetadata = [[company.companyName || 'Company'], [summary.title || `Summary ${index + 1}`]];
    if (showReportMeta) summaryMetadata.push([period], [filters.join(' | ')]);
    summaryMetadata.push([], ...summaryRows);
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryMetadata);
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
