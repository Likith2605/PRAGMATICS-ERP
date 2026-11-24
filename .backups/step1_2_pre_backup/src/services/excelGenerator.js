import ExcelJS from 'exceljs';
import { dateOnly } from '../utils/storeService.js';

const RFQ_TERMS_FALLBACK = [
  '1) Please quote your best rate, delivery days and payment terms.',
  '2) Rates should state clearly whether GST & freight are included or extra.',
  '3) Quotation is valid only until the validity date mentioned above.',
  '4) Send your quotation to the Purchase Department by email / WhatsApp before the validity date.'
];

const getRfqTerms = (enquiry) => {
  const custom = String(enquiry?.termsAndConditions || '').trim();
  const lines = custom
    ? custom.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : RFQ_TERMS_FALLBACK.slice();
  if (enquiry?.validUntil && !lines.some((l) => l.includes(enquiry.validUntil))) {
    lines.push(`${lines.length + 1}) Quotation valid until ${enquiry.validUntil}.`);
  }
  return lines.length > 0 ? lines : RFQ_TERMS_FALLBACK;
};

const THIN = { style: 'thin', color: { argb: 'FF000000' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const LOCKED = { locked: true };
const UNLOCKED = { locked: false };

const applyBorder = (cell) => {
  cell.border = BORDER;
};

const styleCell = (cell, { bold = false, fill = null, align = 'left', size = 10, wrap = false, protection = LOCKED, numberFormat = null } = {}) => {
  cell.font = { name: 'Calibri', size, bold, color: { argb: 'FF000000' } };
  cell.alignment = { vertical: 'middle', horizontal: align, wrapText: wrap };
  if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  cell.protection = protection;
  applyBorder(cell);
  if (numberFormat) cell.numFmt = numberFormat;
};

const mergeText = (ws, range, text, opts = {}) => {
  ws.mergeCells(range);
  const [start] = range.split(':');
  const cell = ws.getCell(start);
  cell.value = text;
  styleCell(cell, { align: 'center', ...opts, protection: opts.protection || LOCKED });
  const [row, col] = start.match(/([A-Z]+)(\d+)/).slice(1);
  const [endRow, endCol] = range.split(':')[1].match(/([A-Z]+)(\d+)/).slice(1);
  for (let r = Number(row); r <= Number(endRow); r += 1) {
    for (let c = columnToIndex(col); c <= columnToIndex(endCol); c += 1) {
      applyBorder(ws.getCell(r, c));
      ws.getCell(r, c).protection = opts.protection || LOCKED;
    }
  }
};

const columnToIndex = (letters) => {
  let n = 0;
  for (let i = 0; i < letters.length; i += 1) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n;
};

export async function generateRFQExcel(enquiry, vendor = null) {
  if (!enquiry) throw new Error('No enquiry data');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Pragmatic Engineers';
  workbook.created = new Date();

  const ws = workbook.addWorksheet('RFQ', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  ws.columns = [
    { width: 6 },
    { width: 32 },
    { width: 34 },
    { width: 8 },
    { width: 13 },
    { width: 13 },
    { width: 14 },
    { width: 16 },
    { width: 16 }
  ];

  let row = 1;

  mergeText(ws, `A${row}:I${row}`, 'PRAGMATIC ENGINEERS', { bold: true, size: 16, fill: 'FF1E293B', protection: LOCKED });
  ws.getRow(row).height = 26;
  row += 1;

  mergeText(ws, `A${row}:I${row}`, 'NO.17/3A, KRISHNARAJU ESTATE, C K PALYA ROAD BASAVANAPURA, BANNERGATTA ROAD BANGALORE-560083', { size: 9 });
  row += 1;
  mergeText(ws, `A${row}:I${row}`, 'GSTIN: 29AKWPP8736E1ZA  |  Phone: +91 9880030466  |  Email: pragmatic.vasudev@gmail.com  |  State: Karnataka', { size: 9 });
  row += 1;

  mergeText(ws, `A${row}:I${row}`, 'REQUEST FOR QUOTATION (RFQ)', { bold: true, size: 13, fill: 'FFDBEAFE' });
  ws.getRow(row).height = 22;
  row += 2;

  const metaStart = row;
  const meta = [
    ['Enquiry No.', enquiry.enquiryNumber || '-', 'Date', dateOnly(enquiry.createdAt) || '-'],
    ['Valid Until', enquiry.validUntil || '-', 'PR Ref', enquiry.prNumber || '-'],
    ['Project', `${enquiry.projectId || '-'}${enquiry.projectName ? ' - ' + enquiry.projectName : ''}`, 'Part', enquiry.partName || '-'],
    ['Job Card', enquiry.jobCardNumber || '-', 'Requested By', enquiry.requestedBy || '-']
  ];
  meta.forEach(([l1, v1, l2, v2]) => {
    const r = ws.getRow(row);
    r.getCell(1).value = l1;
    styleCell(r.getCell(1), { bold: true, fill: 'FFF1F5F9', wrap: true });
    ws.mergeCells(row, 1, row, 2);
    applyBorder(ws.getCell(row, 2));
    ws.getCell(row, 2).protection = LOCKED;
    r.getCell(3).value = v1;
    styleCell(r.getCell(3), { wrap: true });
    ws.mergeCells(row, 3, row, 5);
    for (let c = 4; c <= 5; c += 1) {
      applyBorder(ws.getCell(row, c));
      ws.getCell(row, c).protection = LOCKED;
    }
    r.getCell(6).value = l2;
    styleCell(r.getCell(6), { bold: true, fill: 'FFF1F5F9', wrap: true });
    r.getCell(7).value = v2;
    styleCell(r.getCell(7), { wrap: true });
    ws.mergeCells(row, 7, row, 9);
    for (let c = 8; c <= 9; c += 1) {
      applyBorder(ws.getCell(row, c));
      ws.getCell(row, c).protection = LOCKED;
    }
    ws.getRow(row).height = 18;
    row += 1;
  });
  void metaStart;

  row += 1;

  mergeText(ws, `A${row}:I${row}`, `To: ${vendor ? vendor.name : (enquiry.vendors && enquiry.vendors[0] ? enquiry.vendors[0].name : 'Vendor')}`, { bold: true, fill: 'FFF8FAFC' });
  row += 1;
  if (vendor || (enquiry.vendors && enquiry.vendors[0])) {
    const v = vendor || enquiry.vendors[0];
    mergeText(ws, `A${row}:I${row}`, `Contact: ${v.contact || '-'}  |  Phone: ${v.phone || '-'}  |  Email: ${v.email || '-'}`, { size: 9 });
    row += 1;
  }

  row += 1;

  mergeText(
    ws,
    `A${row}:I${row}`,
    'VENDOR INSTRUCTIONS: Type your Rate in the yellow "Rate" cells only — Amount calculates automatically (Shortage Qty x Rate). You may overwrite Amount for lump-sum quotes, and use the Remarks column.',
    { bold: true, fill: 'FFFFF3C4', wrap: true, size: 10 }
  );
  ws.getRow(row).height = 34;
  row += 2;

  const headerRow = row;
  const headers = ['Sl.NO', 'Material', 'Specification', 'Unit', 'Required Qty', 'Shortage Qty', 'Rate (type here)', 'Amount (auto / type here)', 'Remarks (type here)'];
  headers.forEach((h, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = h;
    styleCell(cell, {
      bold: true,
      fill: 'FF1E293B',
      align: i >= 4 ? 'right' : (i === 0 ? 'center' : 'left'),
      wrap: true,
      protection: LOCKED
    });
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  });
  ws.getRow(headerRow).height = 28;
  row += 1;

  const items = enquiry.items || [];
  items.forEach((it, idx) => {
    const r = ws.getRow(row);
    r.getCell(1).value = idx + 1;
    styleCell(r.getCell(1), { align: 'center' });
    r.getCell(2).value = it.materialName || it.materialId || '';
    styleCell(r.getCell(2), { wrap: true });
    r.getCell(3).value = it.specification || '';
    styleCell(r.getCell(3), { wrap: true });
    r.getCell(4).value = it.unit || '';
    styleCell(r.getCell(4), { align: 'center' });
    r.getCell(5).value = Number(it.requiredQty) || 0;
    styleCell(r.getCell(5), { align: 'right' });
    r.getCell(6).value = Number(it.shortageQty) || 0;
    styleCell(r.getCell(6), { align: 'right' });

    const rateCell = r.getCell(7);
    rateCell.value = null;
    styleCell(rateCell, { align: 'right', fill: 'FFFFFDE7', numberFormat: '#,##0.00', protection: UNLOCKED });

    const amountCell = r.getCell(8);
    amountCell.value = { formula: `IF(G${row}="","",F${row}*G${row})` };
    styleCell(amountCell, { align: 'right', fill: 'FFFFFDE7', numberFormat: '#,##0.00', protection: UNLOCKED });

    r.getCell(9).value = '';
    styleCell(r.getCell(9), { wrap: true, protection: UNLOCKED });

    r.height = 20;
    row += 1;
  });

  if (items.length === 0) {
    mergeText(ws, `A${row}:I${row}`, 'No materials in this enquiry.', { align: 'center' });
    row += 1;
  }

  const totalRow = row;
  ws.mergeCells(row, 1, row, 4);
  const totalLabel = ws.getCell(row, 1);
  totalLabel.value = 'Total';
  styleCell(totalLabel, { bold: true, align: 'right', fill: 'FFF1F5F9' });
  for (let c = 2; c <= 4; c += 1) {
    applyBorder(ws.getCell(row, c));
    ws.getCell(row, c).protection = LOCKED;
  }
  if (items.length > 0) {
    const first = row - items.length;
    ws.getCell(row, 5).value = { formula: `SUM(E${first}:E${row - 1})` };
    ws.getCell(row, 6).value = { formula: `SUM(F${first}:F${row - 1})` };
    ws.getCell(row, 8).value = { formula: `SUM(H${first}:H${row - 1})` };
  } else {
    ws.getCell(row, 5).value = 0;
    ws.getCell(row, 6).value = 0;
    ws.getCell(row, 8).value = 0;
  }
  styleCell(ws.getCell(row, 5), { bold: true, align: 'right', fill: 'FFF1F5F9' });
  styleCell(ws.getCell(row, 6), { bold: true, align: 'right', fill: 'FFF1F5F9' });
  ws.getCell(row, 7).value = null;
  styleCell(ws.getCell(row, 7), { fill: 'FFF1F5F9' });
  styleCell(ws.getCell(row, 8), { bold: true, align: 'right', fill: 'FFF1F5F9', numberFormat: '#,##0.00' });
  ws.getCell(row, 9).value = null;
  styleCell(ws.getCell(row, 9), { fill: 'FFF1F5F9' });
  row += 2;

  ws.mergeCells(row, 1, row, 9);
  const remarksTitle = ws.getCell(row, 1);
  remarksTitle.value = 'Remarks (from PRAGMATIC ENGINEERS)';
  styleCell(remarksTitle, { bold: true, fill: 'FFF1F5F9' });
  for (let c = 2; c <= 9; c += 1) {
    applyBorder(ws.getCell(row, c));
    ws.getCell(row, c).protection = LOCKED;
  }
  row += 1;
  ws.mergeCells(row, 1, row, 9);
  const remarksCell = ws.getCell(row, 1);
  remarksCell.value = enquiry.remarks || '-';
  styleCell(remarksCell, { wrap: true });
  remarksCell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
  for (let c = 2; c <= 9; c += 1) {
    applyBorder(ws.getCell(row, c));
    ws.getCell(row, c).protection = LOCKED;
  }
  ws.getRow(row).height = 36;
  row += 2;

  ws.mergeCells(row, 1, row, 9);
  const termsTitle = ws.getCell(row, 1);
  termsTitle.value = 'Terms & Conditions';
  styleCell(termsTitle, { bold: true, fill: 'FFF1F5F9' });
  for (let c = 2; c <= 9; c += 1) {
    applyBorder(ws.getCell(row, c));
    ws.getCell(row, c).protection = LOCKED;
  }
  row += 1;
  getRfqTerms(enquiry).forEach((t) => {
    ws.mergeCells(row, 1, row, 9);
    const cell = ws.getCell(row, 1);
    cell.value = t;
    styleCell(cell, { size: 9, wrap: true });
    cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
    for (let c = 2; c <= 9; c += 1) {
      applyBorder(ws.getCell(row, c));
      ws.getCell(row, c).protection = LOCKED;
    }
    ws.getRow(row).height = 16;
    row += 1;
  });

  row += 1;
  ws.mergeCells(row, 1, row, 9);
  const note = ws.getCell(row, 1);
  note.value = 'Reminder: only yellow cells (Rate / Amount / Remarks) can be edited.';
  note.font = { name: 'Calibri', size: 9, bold: true, italic: true, color: { argb: 'FFB45309' } };
  note.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  ws.getRow(row).height = 30;

  ws.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 0 }];

  await ws.protect('RFQ2026', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    autoFilter: false,
    sort: false
  });

  const fileName = `RFQ-${enquiry.enquiryNumber || 'Enquiry'}.xlsx`;
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return fileName;
}
