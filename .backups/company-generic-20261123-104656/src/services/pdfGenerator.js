import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import html2canvas from "html2canvas";
import logoUrl from "../assets/logo.png";
import { normalizeRouteCard, formatDateDMY, formatDateTimeDMY } from "../utils/routeCard.js";
import { machineDisplay } from "../utils/storeService.js";
import { computePOTotals, poAmountInWords } from "../utils/poTemplate.js";
import { CLAIM_DRAWBACK_LINE, usdAmountInWords } from "../utils/exportInvoiceService.js";
import { getPOByRef, getPOProgress, getSalesOrderByRef, getQualityCheckForIndent } from "../utils/workflowService.js";
import { getReportCompanyProfile } from '../utils/reportData.js';
import { getCompanyLegalName, getCompanyLogoDataUri } from '../utils/companyBranding.js';
import { OFFICIAL_COMPANY_PROFILE } from '../constants/companyProfile.js';
import { ERP_REPORT_FOOTER } from '../constants/reportFooter.js';

const getStandardDocumentCompany = () => {
  const profile = getReportCompanyProfile();
  const fields = Object.keys(OFFICIAL_COMPANY_PROFILE);
  return {
    ...OFFICIAL_COMPANY_PROFILE,
    ...profile,
    ...Object.fromEntries(fields.map((field) => [
      field,
      String(profile[field] ?? '').trim() ? profile[field] : OFFICIAL_COMPANY_PROFILE[field]
    ]))
  };
};

// Keep the product attribution in a consistent bottom-left position on every
// PDF emitted by this service. Stamp each page after document content is drawn.
const addVyavasthaFooter = (pdf) => {
  const pageCount = pdf.internal.getNumberOfPages();
  const pageHeight = pdf.internal.pageSize.getHeight();
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(71, 85, 105);
    pdf.text(ERP_REPORT_FOOTER, 10, pageHeight - 3);
  }
};

export const generateQuotationPDF = async (payload, options = {}) => {
  const docElement = document.querySelector('.quotation-doc-sheet');
  
  if (!docElement) {
    alert("Could not find the document view on the screen to generate PDF.");
    return;
  }

  try {
    const canvas = await html2canvas(docElement, {
      scale: 2, 
      useCORS: true,
      logging: false,
      backgroundColor: "#ffffff",
      onclone: (clonedDocument) => {
        // The document sheet's bottom outline reads like an extra separator
        // beneath the footer in exported PDFs. Keep the preview styling intact.
        const clonedSheet = clonedDocument.querySelector('.quotation-doc-sheet');
        if (clonedSheet) clonedSheet.style.borderBottom = '0';
      }
    });

    const imgData = canvas.toDataURL('image/png');
    
    // A4 dimensions in mm
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

    let heightLeft = pdfHeight;
    let position = 0;
    
    pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, pdfHeight);
    heightLeft -= pageHeight;
    
    while (heightLeft > 0) {
      position = heightLeft - pdfHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, pdfHeight);
      heightLeft -= pageHeight;
    }

    addVyavasthaFooter(pdf);

    if (options.returnBase64) {
      const base64 = pdf.output('datauristring').split(',')[1];
      return base64;
    }

    if (options.print) {
      window.print();
    } else {
      pdf.save((payload.documentTitle || 'Document') + '.pdf');
    }
  } catch (error) {
    console.error("Error generating PDF via html2canvas:", error);
    alert("Error generating PDF. Check console for details.");
  }
};

/* ============================================================================
   JOB CARD PDF � landscape A4 engineering document
   ========================================================================== */

const loadImage = (url) =>
  new Promise((resolve) => {
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || 120;
          canvas.height = img.naturalHeight || 48;
          canvas.getContext('2d').drawImage(img, 0, 0);
          resolve({
            dataUrl: canvas.toDataURL('image/png'),
            ratio: (img.naturalHeight || 48) / (img.naturalWidth || 120)
          });
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    } catch {
      resolve(null);
    }
  });

const drawStandardDocumentHeader = async (pdf, company, title, reference = '', moduleLabel = title, preparedBy = '') => {
  const M = 10;
  const W = pdf.internal.pageSize.getWidth();
  const generatedAt = new Date().toLocaleString('en-IN');
  const logo = await loadImage(company.logoUrl || getCompanyLogoDataUri() || logoUrl);
  const draw = () => {
    if (logo?.dataUrl) pdf.addImage(logo.dataUrl, 'PNG', M, 7, 22, 13);
    const textX = logo?.dataUrl ? M + 26 : M;
    pdf.setTextColor(30, 58, 95);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.text(String(company.companyName || getCompanyLegalName()), textX, 12);
    const details = [company.address, company.phone && `Phone: ${company.phone}`, company.email, company.website,
      company.gstin && `GSTIN: ${company.gstin}`, company.pan && `PAN: ${company.pan}`].filter(Boolean).join(' | ');
    let detailLines = [];
    if (details) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7.5);
      detailLines = pdf.splitTextToSize(details, W - textX - M);
      pdf.text(detailLines, textX, 16);
    }
    const ruleY = Math.max(25, 18 + detailLines.length * 3.2);
    pdf.setDrawColor(30, 58, 95);
    pdf.setLineWidth(0.5);
    pdf.line(M, ruleY, W - M, ruleY);
    pdf.setTextColor(71, 85, 105);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    const meta = [`${moduleLabel} report`, `Generated ${generatedAt}`, preparedBy && `Prepared by ${preparedBy}`].filter(Boolean).join(' | ');
    pdf.text(pdf.splitTextToSize(meta, W - 2 * M), M, ruleY + 5);
    pdf.setTextColor(15, 23, 42);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.text(title, M, ruleY + 14);
    if (reference) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.text(pdf.splitTextToSize(reference, W - 2 * M), M, ruleY + 19);
    }
    return ruleY + (reference ? 27 : 22);
  };
  return { y: draw(), draw };
};

const addStandardDocumentFooters = (pdf, companyName, documentName) => {
  const pages = pdf.internal.getNumberOfPages();
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  for (let i = 1; i <= pages; i += 1) {
    pdf.setPage(i);
    pdf.setDrawColor(203, 213, 225);
    pdf.setLineWidth(0.25);
    pdf.line(14, H - 13, W - 14, H - 13);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(71, 85, 105);
    pdf.text(`${companyName} · ${documentName}`, 14, H - 8);
    pdf.text(`Page ${i} of ${pages}`, W - 14, H - 8, { align: 'right' });
  }
};

/* ============================================================================
   RFQ (REQUEST FOR QUOTATION) PDF � letterhead RFQ shared with vendors
   ========================================================================== */

export const generateRFQPDF = async ({
  enquiryNumber = '',
  date = '',
  validUntil = '',
  prNumber = '',
  projectId = '',
  projectName = '',
  partName = '',
  jobCardNumber = '',
  vendor = {},
  items = [],
  remarks = '',
  requestedBy = ''
}) => {
  let company = {};
  try {
    company = JSON.parse(localStorage.getItem('companySettings') || '{}');
  } catch {
    company = {};
  }
  const cname = company.companyName || getCompanyLegalName();
  const caddr = company.address || '';
  const cphone = company.phone || '';
  const cemail = company.email || '';
  const cgstin = company.gstin || '';

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 14;

  // Letterhead
  pdf.setTextColor(0, 0, 0);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(15);
  pdf.text(cname, W / 2, 15, { align: 'center' });

  let y = 20;
  if (caddr) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    const addrLines = pdf.splitTextToSize(caddr, W - 2 * M);
    pdf.text(addrLines, W / 2, y, { align: 'center' });
    y += addrLines.length * 3.6;
  }
  const contactLine = [`Ph: ${cphone}`, cemail && `Email: ${cemail}`, cgstin && `GSTIN: ${cgstin}`].filter(Boolean).join('  |  ');
  if (contactLine) {
    pdf.setFontSize(7.5);
    pdf.text(contactLine, W / 2, y, { align: 'center' });
    y += 4;
  }
  pdf.setLineWidth(0.5);
  pdf.line(M, y, W - M, y);
  y += 8;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.text('REQUEST FOR QUOTATION (RFQ)', W / 2, y, { align: 'center' });
  y += 9;

  // Vendor addressed to (left) + enquiry meta (right)
  pdf.setFontSize(9.5);
  pdf.text('To,', M, y);
  y += 5;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.text(vendor.name || '-', M, y);
  y += 5;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  if (vendor.contact) {
    pdf.text(`Attn: ${vendor.contact}`, M, y);
    y += 4;
  }
  const vContact = [`Ph: ${vendor.phone || '-'}`, vendor.email && `Email: ${vendor.email}`].filter(Boolean).join('   ');
  pdf.text(vContact, M, y);

  // Meta block right
  let my = y - (vendor.contact ? 9 : 4);
  const meta = [
    ['Enquiry No:', enquiryNumber || '-'],
    ['Date:', date || '-'],
    ['Valid Until:', validUntil || '-'],
    ['PR Ref:', prNumber || '-'],
    ['Project:', [projectId, projectName].filter(Boolean).join(' - ') || '-'],
    ['Part:', partName || '-']
  ];
  if (jobCardNumber) meta.push(['Job Card:', jobCardNumber]);
  pdf.setFontSize(8.5);
  meta.forEach(([label, value]) => {
    pdf.setFont('helvetica', 'bold');
    pdf.text(label, W - M - 42, my);
    pdf.setFont('helvetica', 'normal');
    pdf.text(String(value), W - M, my, { align: 'right' });
    my += 4.4;
  });

  y = Math.max(y + 8, my + 4);

  // Items table � Rate column blank, to be filled by vendor
  autoTable(pdf, {
    startY: y,
    head: [['Sl', 'Material', 'Specification', 'Qty', 'Unit', 'Rate (?)']],
    body: items.map((it, i) => [
      String(i + 1),
      it.materialName || it.materialId || '',
      it.specification || '-',
      String(it.shortageQty || it.requiredQty || 0),
      it.unit || '',
      ''
    ]),
    theme: 'grid',
    margin: { left: M, right: M, top: 10, bottom: 16 },
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 2, lineColor: [0, 0, 0], lineWidth: 0.15, textColor: [0, 0, 0], valign: 'middle', overflow: 'linebreak' },
    headStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold', halign: 'left' },
    columnStyles: { 0: { cellWidth: 12 }, 3: { cellWidth: 18, halign: 'right' }, 4: { cellWidth: 18 }, 5: { cellWidth: 28 } }
  });

  let ty = (pdf.lastAutoTable?.finalY || y) + 8;
  pdf.setFontSize(8.5);
  if (remarks) {
    pdf.setFont('helvetica', 'bold');
    pdf.text('Remarks:', M, ty);
    pdf.setFont('helvetica', 'normal');
    const remLines = pdf.splitTextToSize(remarks, W - 2 * M - 22);
    pdf.text(remLines, M + 22, ty);
    ty += remLines.length * 4 + 3;
  }

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  const terms = [
    'Terms: 1) Please quote your best rate, delivery days and payment terms.',
    '2) Rates should state clearly whether GST & freight are included or extra.',
    '3) Quotation is valid only until the date mentioned above.',
    '4) Send your quotation to the Purchase Department by email / WhatsApp before the validity date.'
  ];
  terms.forEach((t) => {
    if (ty < H - 34) {
      pdf.text(t, M, ty);
      ty += 4;
    }
  });

  // Signature
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.text('For ' + cname, W - M, H - 34, { align: 'right' });
  if (requestedBy) pdf.text(`Prepared by: ${requestedBy}`, M, H - 27);

  pdf.setFontSize(7.5);
  pdf.text(cname, M, H - 6);
  pdf.text(`Generated on: ${new Date().toLocaleString('en-IN')}`, W - M, H - 6, { align: 'right' });

  addVyavasthaFooter(pdf);

  pdf.save(`RFQ-${enquiryNumber || 'Enquiry'}.pdf`);
};

/* ============================================================================
   GENERIC REGISTER / REPORT PDF � any ERP report (AP, AR, sales, purchase, etc.)
   ========================================================================== */

/** Split `availWidth` between columns based on measured header/body content.
 *  Every column is at least as wide as its longest single word (so text never
 *  breaks mid-word) and the leftover space is shared in proportion to how much
 *  content each column actually holds. The returned widths always sum to
 *  `availWidth`, which keeps the table flush against both margins. */
const measureColumnWidths = (pdf, {
  headers,
  bodyRows = [],
  footerRow = [],
  availWidth,
  fontSize = 8.5,
  headerFontSize = 8.5,
  pad = 3.6
}) => {
  const count = headers.length;
  if (!count || availWidth <= 0) return [];
  const sample = bodyRows.slice(0, 60);
  const desired = [];
  const minimums = [];

  for (let i = 0; i < count; i += 1) {
    const header = String(headers[i] ?? '');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(headerFontSize);
    let widest = pdf.getTextWidth(header);
    let longestWord = header.split(/\s+/).filter(Boolean)
      .reduce((max, word) => Math.max(max, pdf.getTextWidth(word)), 0);

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(fontSize);
    const values = sample.map((row) => String(row[i] ?? '')).filter(Boolean);
    const footerText = String(footerRow[i] ?? '');
    if (footerText) values.push(footerText);
    for (const value of values) {
      widest = Math.max(widest, Math.min(pdf.getTextWidth(value), availWidth * 0.4));
      longestWord = Math.max(longestWord, value.split(/\s+/).filter(Boolean)
        .reduce((max, word) => Math.max(max, pdf.getTextWidth(word)), 0));
    }

    desired.push(Math.max(widest + pad, 9));
    // Never size a column below its longest single word unless the words
    // genuinely cannot fit side by side (scaled down below in that case).
    minimums.push(longestWord + pad);
  }

  const minTotal = minimums.reduce((sum, width) => sum + width, 0);
  const scale = minTotal > availWidth ? availWidth / minTotal : 1;
  const mins = minimums.map((width) => width * scale);
  const widths = [...mins];
  let remaining = availWidth - mins.reduce((sum, width) => sum + width, 0);
  for (let pass = 0; pass < 8 && remaining > 0.01; pass += 1) {
    const headroom = desired.map((value, i) => Math.max(0, value - widths[i]));
    const totalHeadroom = headroom.reduce((sum, value) => sum + value, 0);
    if (totalHeadroom <= 0.01) break;
    const shareWidth = Math.min(remaining, totalHeadroom);
    headroom.forEach((value, i) => { widths[i] += (shareWidth * value) / totalHeadroom; });
    remaining -= shareWidth;
  }
  if (remaining > 0.01) {
    widths.forEach((width, i) => { widths[i] = width + remaining / count; });
  }
  const drift = availWidth - widths.reduce((sum, width) => sum + width, 0);
  const widestIndex = widths.indexOf(Math.max(...widths));
  widths[widestIndex] += drift;
  return widths;
};

export const generateRegisterPDF = async ({
  title = 'Report',
  subTitle = '',
  period = '',
  companyName = getCompanyLegalName(),
  company = {},
  logoUrl = '',
  filters = [],
  generatedBy = 'User',
  showPreparedBy = true,
  showReportMeta = true,
  footerText = ERP_REPORT_FOOTER,
  showPageNumber = true,
  titleAlign = 'left',
  reportModule = 'Reports',
  columns = [],
  rows = [],
  footer = [],
  summaryTables = [],
  filename = 'Report',
  landscape,
  options = {}
}) => {
  try {
    // Wide registers (more than 8 columns) render unreadably in portrait A4,
    // so they switch to landscape unless the caller forces an orientation.
    const useLandscape = landscape === true || (landscape !== false && columns.length > 8);
    const pdf = new jsPDF({ orientation: useLandscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
    const W = pdf.internal.pageSize.getWidth();
    const H = pdf.internal.pageSize.getHeight();
    const M = 10;
    const contentW = W - M * 2;

    // Standard PDF fonts cannot encode '₹' - jsPDF maps it to a stray glyph
    // and letter-spaces the rest of the run, so spell the currency out.
    const currencySafe = (value) => (typeof value === 'string' ? value.replace(/₹/g, 'INR') : value);
    title = currencySafe(title);
    subTitle = currencySafe(subTitle);
    period = currencySafe(period);
    filters = filters.map(currencySafe);
    columns = columns.map((column) => ({ ...column, header: currencySafe(column.header) }));
    rows = rows.map((row) => row.map(currencySafe));
    footer = footer.map(currencySafe);

    const profile = { companyName, ...company };
    const logoSource = getCompanyLogoDataUri() || profile.logoDataUrl || logoUrl || profile.logoUrl;
    let logoData = null;
    if (logoSource && /^data:image\//i.test(logoSource)) {
      logoData = logoSource;
    } else if (logoSource) {
      try {
        const response = await fetch(logoSource);
        if (response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = '';
          bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
          logoData = `data:image/png;base64,${btoa(binary)}`;
        }
      } catch { /* Report export remains available when a logo cannot be loaded. */ }
    }

    // Keep the reporting date/period on its own centered line above every report
    // table; non-date context and other metadata remain left aligned beneath it.
    const isDatePeriod = /^\s*(?:period|report date|date|as of)\s*:/i.test(period);
    const periodContext = period && !isDatePeriod ? period : '';
    const now = new Date();
    const generatedDate = `Report date: ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const centeredDateText = isDatePeriod ? period : generatedDate;
    const metaText = showReportMeta
      ? [reportModule, periodContext, ...filters, showPreparedBy && generatedBy ? `Prepared by: ${generatedBy}` : ''].filter(Boolean).join(' | ')
      : periodContext;
    const subLineHeight = 3.4;   // 8pt helvetica line height in mm
    const metaLineHeight = 3.2;  // 7.5pt helvetica line height in mm
    const subLines = subTitle ? pdf.splitTextToSize(subTitle, contentW).length : 0;
    const metaLines = metaText ? pdf.splitTextToSize(metaText, contentW).length : 0;
    const dateLines = centeredDateText ? pdf.splitTextToSize(centeredDateText, contentW).length : 0;
    const dateY = subLines ? 36 + subLines * subLineHeight + 1.5 : 36;
    const metaY = dateLines ? dateY + dateLines * metaLineHeight + 1.5 : dateY;
    const tableY = Math.max(42, (metaLines ? metaY + metaLines * metaLineHeight + 4
      : dateLines ? dateY + dateLines * metaLineHeight + 4
        : subLines ? 36 + subLines * subLineHeight + 4 : 42));

    const drawHeader = (pageNumber) => {
      if (logoData) pdf.addImage(logoData, 'PNG', M, 7, 22, 13);
      const textX = logoData ? M + 26 : M;
      pdf.setTextColor(30, 58, 95);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(12);
      pdf.text(profile.companyName || getCompanyLegalName(), textX, 12);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7.5);
      const details = [profile.address, profile.phone && `Phone: ${profile.phone}`, profile.email, profile.website,
        profile.gstin && `GSTIN: ${profile.gstin}`, profile.pan && `PAN: ${profile.pan}`].filter(Boolean).join(' | ');
      const detailLines = pdf.splitTextToSize(details || 'Company details not configured', W - textX - M);
      pdf.text(detailLines.slice(0, 2), textX, 16);
      pdf.setDrawColor(30, 58, 95);
      pdf.setLineWidth(0.5);
      pdf.line(M, 24, W - M, 24);
      pdf.setTextColor(0, 0, 0);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(12);
      pdf.text(title, titleAlign === 'center' ? W / 2 : M, 31, { align: titleAlign === 'center' ? 'center' : 'left' });
      if (subTitle) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(8);
        pdf.text(pdf.splitTextToSize(subTitle, contentW), M, 36);
      }
      if (centeredDateText) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7.5);
        pdf.text(pdf.splitTextToSize(centeredDateText, contentW), W / 2, dateY, { align: 'center' });
      }
      if (metaText) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7.5);
        pdf.text(pdf.splitTextToSize(metaText, contentW), M, metaY);
      }
    };

    pdf.setFillColor(255, 255, 255);
    pdf.setTextColor(0, 0, 0);

    // Measure content and allocate the page width so no column is squeezed
    // into mid-word breaks (callers may still pin explicit widths).
    const explicitWidths = columns.map((column) => (Number(column.width) > 0 ? Number(column.width) : 0));
    const fixedTotal = explicitWidths.reduce((sum, width) => sum + width, 0);
    const flexibleIndexes = columns.map((_, index) => index).filter((index) => !explicitWidths[index]);
    const flexibleWidth = Math.max(contentW - fixedTotal, flexibleIndexes.length * 9);
    const measuredWidths = measureColumnWidths(pdf, {
      headers: flexibleIndexes.map((index) => columns[index].header),
      bodyRows: rows.map((row) => flexibleIndexes.map((index) => row[index])),
      footerRow: flexibleIndexes.map((index) => footer[index]),
      availWidth: flexibleWidth
    });
    const columnWidths = explicitWidths.slice();
    flexibleIndexes.forEach((columnIndex, position) => {
      columnWidths[columnIndex] = measuredWidths[position] || flexibleWidth / Math.max(flexibleIndexes.length, 1);
    });

    autoTable(pdf, {
      startY: tableY,
      head: [columns.map((c) => c.header)],
      body: rows,
      foot: footer.length ? [footer] : undefined,
      theme: 'grid',
      margin: { left: M, right: M, top: tableY, bottom: 16 },
      rowPageBreak: 'avoid',
      styles: {
        font: 'helvetica',
        fontSize: 8.5,
        cellPadding: 1.6,
        lineColor: [0, 0, 0],
        lineWidth: 0.15,
        textColor: [0, 0, 0],
        valign: 'middle',
        overflow: 'linebreak'
      },
      headStyles: {
        fillColor: [209, 213, 219],
        textColor: [15, 23, 42],
        fontStyle: 'bold',
        fontSize: 8.5,
        halign: 'center',
        minCellHeight: 7
      },
      footStyles: {
        fillColor: [226, 232, 240],
        textColor: [15, 23, 42],
        fontStyle: 'bold',
        fontSize: 8.5,
        minCellHeight: 7
      },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: columns.reduce((acc, c, i) => {
        acc[i] = { halign: c.align || 'left', cellWidth: columnWidths[i] || 'auto', valign: 'middle' };
        return acc;
      }, {}),
      didParseCell: (data) => {
        const column = columns[data.column.index];
        if (data.section === 'head') {
          data.cell.styles.halign = 'center';
        } else if (column?.align) {
          // columnStyles only reach body cells, so totals need it here too.
          data.cell.styles.halign = column.align;
        }
        if (data.section !== 'body' && columnWidths[data.column.index]) {
          data.cell.styles.cellWidth = columnWidths[data.column.index];
        }
      },
      showHead: 'everyPage',
      showFoot: 'everyPage',
      didDrawPage: (data) => {
        drawHeader(data.pageNumber);
      }
    });

    for (const summary of summaryTables) {
      if (!summary?.columns?.length || !summary.rows?.length) continue;
      let summaryY = (pdf.lastAutoTable?.finalY || tableY) + 8;
      // Push overflowing summaries to a fresh page instead of cramming them
      // against the bottom edge (the title used to be orphaned that way).
      if (summaryY > H - 45) {
        pdf.addPage();
        summaryY = tableY;
      }
      const summaryBody = summary.rows.map((row) => summary.columns.map((column) => currencySafe(String(row[column.key] ?? ''))));
      const summaryWidths = measureColumnWidths(pdf, {
        headers: summary.columns.map((column) => currencySafe(column.header ?? column.label)),
        bodyRows: summaryBody,
        availWidth: contentW,
        fontSize: 8,
        pad: 3.4
      });
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.text(currencySafe(summary.title) || 'Filtered Summary', M, summaryY);
      autoTable(pdf, {
        startY: summaryY + 3,
        head: [summary.columns.map((column) => currencySafe(column.header ?? column.label))],
        body: summaryBody,
        theme: 'grid',
        margin: { left: M, right: M, top: tableY, bottom: 16 },
        rowPageBreak: 'avoid',
        styles: {
          font: 'helvetica',
          fontSize: 8,
          cellPadding: 1.5,
          lineColor: [0, 0, 0],
          lineWidth: 0.15,
          textColor: [0, 0, 0],
          valign: 'middle',
          overflow: 'linebreak'
        },
        headStyles: {
          fillColor: [209, 213, 219],
          textColor: [15, 23, 42],
          fontStyle: 'bold',
          halign: 'center',
          minCellHeight: 6.5
        },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: summary.columns.reduce((acc, column, index) => {
          acc[index] = { cellWidth: summaryWidths[index] || 'auto', halign: 'left' };
          return acc;
        }, {}),
        didParseCell: (data) => {
          if (data.section !== 'body' && summaryWidths[data.column.index]) {
            data.cell.styles.cellWidth = summaryWidths[data.column.index];
          }
        },
        didDrawPage: (data) => drawHeader(data.pageNumber)
      });
    }

    const pages = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i += 1) {
      pdf.setPage(i);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7.5);
      pdf.setTextColor(71, 85, 105);
      pdf.text(footerText, M, H - 6);
      if (showPageNumber) pdf.text(`Page ${i} of ${pages}`, W - M, H - 6, { align: 'right' });
    }

    if (options.returnBase64) {
      return pdf.output('datauristring').split(',')[1];
    }
    if (options.print) {
      pdf.autoPrint();
      window.open(pdf.output('bloburl'), '_blank');
      return;
    }
    pdf.save(filename + '.pdf');
  } catch (error) {
    console.error('Error generating report PDF:', error);
    alert('Error generating report PDF. Check console for details.');
  }
};

export const generateRouteCardPDF = async (jc, options = {}) => {
  try {
    const data = normalizeRouteCard(jc);
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = pdf.internal.pageSize.getWidth();
    const H = pdf.internal.pageSize.getHeight();
    const M = 7;
    const contentW = W - M * 2;
    const BLACK = [0, 0, 0];

    const setPen = (w = 0.2) => {
      pdf.setDrawColor(...BLACK);
      pdf.setLineWidth(w);
    };
    const print = (txt) => {
      if (txt === null || txt === undefined || txt === '') return '-';
      return String(txt);
    };

    let y = M;

    const headerH = 30;
    const logoW = 44;
    const logo = await loadImage(getCompanyLogoDataUri() || logoUrl);

    setPen(0.4);
    pdf.rect(M, y, contentW, headerH, 'S');
    const logoColW = contentW * 0.2;
    const infoColW = contentW * 0.26;
    pdf.line(M + logoColW, y, M + logoColW, y + headerH);
    pdf.line(M + contentW - infoColW, y, M + contentW - infoColW, y + headerH);

    if (logo && logo.dataUrl) {
      const logoH = Math.min(headerH - 6, logoW * logo.ratio);
      const logoX = M + (logoColW - logoW) / 2;
      const logoY = y + (headerH - logoH) / 2;
      try {
        pdf.addImage(logo.dataUrl, 'PNG', logoX, logoY, logoW, logoH);
      } catch {
        void 0;
      }
    }

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(22);
    const title = 'JOB CARD';
    const titleW = pdf.getTextWidth(title);
    pdf.text(title, M + logoColW + (contentW - logoColW - infoColW) / 2 - titleW / 2, y + headerH / 2 + 4);

    const infoX = M + contentW - infoColW;
    const labelX = infoX + 4;
    const valueRight = M + contentW - 4;
    const headerRows = [
      ['Doc No:', print(data.docNo)],
      ['Rev No:', print(data.revNo)],
      ['Date:', formatDateDMY(data.docDate) || '-']
    ];
    headerRows.forEach(([label, value], index) => {
      const rowY = y + 8 + index * 7;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9.5);
      pdf.text(label, labelX, rowY);

      // Keep values right-aligned within the information panel. Long legacy
      // document numbers are reduced to fit the available value column.
      const valueX = labelX + 22;
      const maxValueWidth = valueRight - valueX;
      let valueFontSize = 9.5;
      pdf.setFont('helvetica', 'normal');
      while (valueFontSize > 6.5 && pdf.getTextWidth(value) > maxValueWidth) {
        valueFontSize -= 0.5;
        pdf.setFontSize(valueFontSize);
      }
      pdf.text(value, valueRight, rowY, { align: 'right' });
    });

    y += headerH;

    const drawInfoRow = (cells) => {
      const cellH = 12;
      const cellW = contentW / cells.length;
      cells.forEach((cell, i) => {
        const cx = M + i * cellW;
        setPen(0.25);
        pdf.rect(cx, y, cellW, cellH, 'S');
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(7.8);
        pdf.text(cell.label, cx + 2, y + 4.4);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(10);
        pdf.text(print(cell.value), cx + 2, y + 9.8);
      });
      y += cellH;
    };

    drawInfoRow([
      { label: 'PO NO', value: data.poNo },
      { label: 'PART NAME', value: data.partName },
      { label: 'DRAWING REV', value: data.drawingRev },
      { label: 'CUSTOMER', value: data.customer }
    ]);

    drawInfoRow([
      { label: 'INV NO', value: data.invNo },
      { label: 'PART NUMBER', value: data.partNumber },
      { label: 'LOT QTY', value: data.lotQty },
      { label: 'MATERIAL', value: data.material }
    ]);

    const certH = 9;
    setPen(0.25);
    pdf.rect(M, y, contentW, certH, 'S');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8.4);
    const certLabel = 'MATERIAL TEST CERTIFICATE NO- ';
    pdf.text(certLabel, M + 2, y + 5.6);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    const labelW = pdf.getTextWidth(certLabel);
    pdf.text(print(data.materialCertNo), M + 2 + labelW, y + 5.6);
    y += certH + 2;

    const body = (data.processes || []).map((p) => [
      print(p.process),
      print(machineDisplay(p.machineId || p.machineName || p.machineNo)),
      print(p.inputQty),
      print(p.outputQty),
      print(p.reworkQty),
      print(p.rejectQty),
      print(formatDateTimeDMY(p.startTime)),
      print(formatDateTimeDMY(p.endTime)),
      print(p.operator),
      print(p.status || 'Pending')
    ]);
    if (body.length === 0) body.push(new Array(10).fill('-'));

    autoTable(pdf, {
      startY: y,
      head: [[
        'Process', 'Machine Name', 'Input QTY', 'Output QTY', 'Rework QTY',
        'Reject QTY', 'Start Date & Time', 'End Date & Time', 'Operator / Inspector', 'Status'
      ]],
      body,
      theme: 'grid',
      margin: { left: M, right: M, top: M, bottom: 10 },
      styles: {
        font: 'helvetica',
        fontSize: 9,
        cellPadding: 1.5,
        lineColor: BLACK,
        lineWidth: 0.18,
        textColor: BLACK,
        halign: 'center',
        valign: 'middle',
        overflow: 'linebreak'
      },
      headStyles: {
        fillColor: [255, 255, 255],
        textColor: BLACK,
        fontStyle: 'bold',
        fontSize: 8.6,
        halign: 'center',
        lineColor: BLACK,
        lineWidth: 0.25,
        minCellHeight: 9
      },
      bodyStyles: {
        fillColor: [255, 255, 255],
        lineColor: BLACK,
        lineWidth: 0.18,
        minCellHeight: 7.5
      },
      columnStyles: {
        0: { cellWidth: 44, halign: 'left' },
        1: { cellWidth: 26 },
        2: { cellWidth: 23 },
        3: { cellWidth: 23 },
        4: { cellWidth: 23 },
        5: { cellWidth: 23 },
        6: { cellWidth: 27 },
        7: { cellWidth: 27 },
        8: { cellWidth: 44 },
        9: { cellWidth: 23 }
      },
      showHead: 'everyPage',
      rowPageBreak: 'avoid'
    });

    const pages = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i += 1) {
      pdf.setPage(i);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7.5);
      pdf.text(`${getCompanyLegalName()} - Job Card`, M, H - 6);
      pdf.text(`Page ${i} of ${pages}`, W - M, H - 6, { align: 'right' });
    }

    addVyavasthaFooter(pdf);

    const docTitle = `RouteCard-${data.jobCardNumber || data.poNo || 'Document'}`;

    if (options.returnBase64) {
      return pdf.output('datauristring').split(',')[1];
    }

    if (options.print) {
      pdf.autoPrint();
      window.open(pdf.output('bloburl'), '_blank');
      return;
    }

    pdf.save(docTitle + '.pdf');
  } catch (error) {
    console.error('Error generating Job Card PDF:', error);
    alert('Error generating Job Card PDF. Check console for details.');
  }
};

/* ============================================================================
   DEBIT NOTE PDF — vendor credit claim for material rejected at Quality Check
   ========================================================================== */

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
};

export const generateDebitNotePDF = async (note, options = {}) => {
  try {
    const company = getStandardDocumentCompany();
    const cname = company.companyName || getCompanyLegalName();
    const caddr = company.address || '';
    const cphone = company.phone || '';
    const cemail = company.email || '';
    const cgstin = company.gstin || '';

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = pdf.internal.pageSize.getWidth();
    const H = pdf.internal.pageSize.getHeight();
    const M = 14;

    /* ---- shared company header and document title ---- */
    const header = await drawStandardDocumentHeader(pdf, company, 'DEBIT NOTE',
      `${note.debitNoteNumber || 'Draft'}${note.debitNoteDate ? ` | ${note.debitNoteDate}` : ''}`,
      'Debit Note', note.createdBy || '');
    let y = header.y;

    /* ---- issue status ---- */
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    pdf.text(
      `Status: ${note.status || 'Draft'}${note.status === 'Draft' ? '  —  NOT YET ISSUED TO VENDOR' : ''}`,
      W / 2,
      y,
      { align: 'center' }
    );
    y += 7;

    /* ---- vendor (left) + document meta (right) ---- */
    pdf.setFontSize(9.5);
    pdf.text('To,', M, y);
    y += 5;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text(note.vendor || '-', M, y);
    y += 5;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    if (note.vendorGstNumber) {
      pdf.text(`GSTIN: ${note.vendorGstNumber}`, M, y);
      y += 4;
    }
    if (note.vendorAddress) {
      const vLines = pdf.splitTextToSize(note.vendorAddress, 92);
      pdf.text(vLines, M, y);
      y += vLines.length * 4;
    }

    /* Draws a `label   value` row inside a fixed-width column block. The value
       font shrinks (and only then truncates) so a long value can never run
       into its own label, and values stay aligned down the column. */
    const kvRow = (x, rowY, w, label, value, opt = {}) => {
      const size = opt.size || 8.5;
      const labelW = opt.labelW || w * 0.46;
      const gap = 1.6;
      const valueW = w - labelW - gap;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(size);
      pdf.text(String(label), x, rowY);
      let val = value === undefined || value === null || value === '' ? '-' : String(value);
      pdf.setFont('helvetica', 'normal');
      let s = size;
      while (s > 5 && pdf.getTextWidth(val) > valueW) s -= 0.25;
      if (pdf.getTextWidth(val) > valueW) {
        while (val.length > 1 && pdf.getTextWidth(`${val}...`) > valueW) val = val.slice(0, -1);
        val = `${val}...`;
      }
      pdf.setFontSize(s);
      if (opt.align === 'right') pdf.text(val, x + w, rowY, { align: 'right' });
      else pdf.text(val, x + labelW + gap, rowY);
      pdf.setFontSize(size);
    };

    const metaW = 66;
    const metaX = W - M - metaW;
    let my = y - 5;
    const meta = [
      ['Debit Note No:', note.debitNoteNumber],
      ['Debit Note Date:', note.debitNoteDate],
      ['Against Invoice:', note.invoiceNumber],
      ['Invoice Date:', note.invoiceDate],
      ['PO No:', note.poNumber],
      ['Receipt No:', note.receiptNumber],
      ['QC No:', note.qcNumber],
      ['Rejection Report:', note.rejectionNumber],
      ['Indent No:', note.indentNumber],
      ['SO No:', note.soNumber],
      ['Project:', note.projectId]
    ];
    meta.forEach(([label, value]) => {
      kvRow(metaX, my, metaW, label, value, { size: 8.5, labelW: 30 });
      my += 4.4;
    });

    y = Math.max(y + 6, my + 4);

    /* ---- reason block ---- */
    const reasonText = (note.qualityRemarks || note.remarks || '').trim();
    if (reasonText) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text('Reason for debit:', M, y);
      pdf.setFont('helvetica', 'normal');
      const rLines = pdf.splitTextToSize(reasonText, W - 2 * M - 34);
      pdf.text(rLines, M + 34, y);
      y += rLines.length * 4 + 4;
    }

    /* ---- items table ---- */
    autoTable(pdf, {
      startY: y,
      head: [['Sl', 'Material / HSN', 'Rejected Qty', 'Debit Qty', 'Unit', 'Rate', 'Taxable Amt', 'GST', 'GST Amt', 'Total']],
      body: (note.items || []).map((it, i) => [
        String(i + 1),
        `${it.materialName || '-'}${it.hsnSac ? `\nHSN: ${it.hsnSac}` : ''}${it.reason ? `\nReason: ${it.reason}` : ''}`,
        Number(it.rejectedQty || 0).toFixed(3).replace(/\.000$/, ''),
        Number(it.debitQty || 0).toFixed(3).replace(/\.000$/, ''),
        it.unit || '',
        money(it.unitPrice),
        money(it.amount),
        `${Number(it.gstPercent || 0).toFixed(2).replace(/\.00$/, '')}%`,
        money(it.gstAmount),
        money(it.lineTotal)
      ]),
      theme: 'grid',
      margin: { left: M, right: M, top: 10, bottom: 18 },
      styles: {
        font: 'helvetica',
        fontSize: 7.6,
        cellPadding: 1.6,
        lineColor: [0, 0, 0],
        lineWidth: 0.15,
        textColor: [0, 0, 0],
        valign: 'middle',
        overflow: 'linebreak'
      },
      headStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold', halign: 'center' },
      columnStyles: {
        0: { cellWidth: 9, halign: 'center' },
        1: { cellWidth: 34 },
        2: { halign: 'right' },
        3: { halign: 'right' },
        4: { cellWidth: 11, halign: 'center' },
        5: { halign: 'right' },
        6: { halign: 'right' },
        7: { halign: 'center' },
        8: { halign: 'right' },
        9: { halign: 'right' }
      },
      showHead: 'everyPage',
      rowPageBreak: 'avoid',
      margin: { left: M, right: M, top: 52, bottom: 18 },
      didDrawPage: ({ pageNumber }) => {
        if (pdf.internal.getCurrentPageInfo().pageNumber > 1) { header.draw(); return; }
        if (pageNumber > 1) {
          pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(51, 65, 85);
          pdf.text(`${cname}  ·  DEBIT NOTE ${note.debitNoteNumber || ''}`, M, 12);
          pdf.setDrawColor(203, 213, 225); pdf.line(M, 16, W - M, 16);
        }
      }
    });

    /* ---- totals ---- */
    let ty = (pdf.lastAutoTable?.finalY || y) + 7;
    if (ty > H - 65) {
      pdf.addPage();
      header.draw();
      ty = 52;
    }
    const totalW = 62;
    const totalX = W - M - totalW;
    const totalRows = [
      ['Taxable Amount', money(note.subtotal)],
      ['CGST', money(note.cgst)],
      ['SGST', money(note.sgst)],
      ['Total GST', money(note.totalGST)]
    ];
    totalRows.forEach(([label, value]) => {
      kvRow(totalX, ty, totalW, label, value, { size: 8.5, labelW: 32, align: 'right' });
      ty += 4.4;
    });

    pdf.setDrawColor(0, 0, 0);
    pdf.setLineWidth(0.4);
    pdf.line(totalX, ty, W - M, ty);
    ty += 5;
    kvRow(totalX, ty, totalW, 'Total Debit Value', `INR ${money(note.grandTotal)}`, {
      size: 10, labelW: 32, align: 'right'
    });
    ty += 6;

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    const words = pdf.splitTextToSize(note.amountInWords || '', W - 2 * M);
    pdf.text(words, M, ty);
    ty += words.length * 4 + 4;

    if (note.remarks) {
      pdf.setFont('helvetica', 'bold');
      pdf.text('Remarks:', M, ty);
      pdf.setFont('helvetica', 'normal');
      const remLines = pdf.splitTextToSize(note.remarks, W - 2 * M - 24);
      pdf.text(remLines, M + 24, ty);
      ty += remLines.length * 4 + 3;
    }

    const historyEntries = Array.isArray(note.history) ? note.history : [];
    if (historyEntries.length) {
      if (ty > H - 48) { pdf.addPage(); header.draw(); ty = 52; }
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8.5);
      pdf.text('Approval / Activity History', M, ty);
      ty += 4;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7.5);
      historyEntries.forEach((entry) => {
        const line = [entry.action, entry.name || entry.userName || entry.username, entry.at, entry.details].filter(Boolean).join(' · ');
        const lines = pdf.splitTextToSize(line, W - 2 * M);
        if (ty + lines.length * 3.5 > H - 22) { pdf.addPage(); header.draw(); ty = 52; }
        pdf.text(lines, M, ty);
        ty += lines.length * 3.5 + 1;
      });
    }

    /* ---- signature ---- */
    if (ty > H - 42) { pdf.addPage(); header.draw(); ty = 52; }
    const sigY = Math.max(ty + 6, H - 32);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.text(`For ${cname}`, W - M, sigY, { align: 'right' });
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    if (note.issuedBy) pdf.text(`Issued by: ${note.issuedBy}`, W - M, sigY + 10, { align: 'right' });
    if (note.adminApprovedBy || note.adminApprovedAt) {
      pdf.text(`Approved by: ${[note.adminApprovedBy, note.adminApprovedAt].filter(Boolean).join(' · ')}`, W - M, sigY + 15, { align: 'right' });
    }
    pdf.setFontSize(8);
    pdf.text(`Prepared by: ${note.createdBy || '-'}`, M, sigY + 6);
    pdf.text(`Generated on: ${new Date().toLocaleString('en-IN')}`, M, sigY + 10);

    /* ---- footer on every page ---- */
    addStandardDocumentFooters(pdf, cname, `Debit Note ${note.debitNoteNumber || ''}`);
    addVyavasthaFooter(pdf);

    if (options.returnBase64) {
      return pdf.output('datauristring').split(',')[1];
    }
    if (options.print) {
      pdf.autoPrint();
      window.open(pdf.output('bloburl'), '_blank');
      return;
    }

    pdf.save(`DebitNote-${note.debitNoteNumber || 'Draft'}.pdf`);
  } catch (error) {
    console.error('Error generating Debit Note PDF:', error);
    alert('Error generating Debit Note PDF. Check console for details.');
  }
};

/** Purchase Indent document output; reads the supplied workflow record only. */
export const generatePurchaseIndentPDF = async (indent, options = {}) => {
  try {
    const company = getStandardDocumentCompany();
    const cname = company.companyName || getCompanyLegalName();
    const so = indent.soNumber ? getSalesOrderByRef(indent.soNumber) : null;
    const po = indent.poNumber ? getPOByRef(indent.poNumber) : null;
    const qc = getQualityCheckForIndent(indent.indentNumber);
    const customer = so?.payload?.customerDetails || {};
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = pdf.internal.pageSize.getWidth();
    const H = pdf.internal.pageSize.getHeight();
    const M = 14;
    const header = await drawStandardDocumentHeader(pdf, company, 'PURCHASE INDENT',
      `${indent.indentNumber || ''}${indent.indentDate ? ` | ${indent.indentDate}` : ''}`,
      'Purchase Indent', indent.createdBy || '');
    let y = header.y;

    const infoRows = [
      ['Requirement / PR Reference', indent.requirementNumber], ['Sales Order Number', indent.soNumber],
      ['Customer', indent.customer || customer.companyName || customer.customerName],
      ['Production Job', indent.productionJob], ['Required Date', indent.requiredDate],
      ['Delivery Date', indent.deliveryDate], ['Created By', [indent.createdBy, indent.createdByDept].filter(Boolean).join(' · ')],
      ['Submitted At', indent.submittedAt], ['Linked Purchase Order', indent.poNumber],
      ['PO Date', po?.date || po?.createdAt], ['PO Supplier', po?.payload?.vendorDetails?.companyName],
      ['Approval Status', indent.adminApprovedAt ? 'Approved' : (indent.status || 'Pending')],
      ['Approved By', indent.adminApprovedBy], ['Approved At', indent.adminApprovedAt],
      ['Approval Remarks', indent.adminApprovedRemarks], ['QC Status', qc?.status || indent.qcStatus],
      ['QC Number', qc?.qcNumber || indent.qcNumber], ['QC Inspector', qc?.inspector],
      ['QC Inspection Date', qc?.inspectionDate], ['QC Sent At', indent.sentToQCAt], ['QC Remarks', qc?.remarks]
    ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
    autoTable(pdf, {
      startY: y, head: [['Document Information', 'Recorded Value']],
      body: infoRows.map(([label, value]) => [label, String(value)]),
      theme: 'grid', margin: { left: M, right: M, top: 52, bottom: 18 },
      styles: { font: 'helvetica', fontSize: 8, cellPadding: 2, lineColor: [203, 213, 225], lineWidth: 0.2, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: { 0: { cellWidth: 52, fontStyle: 'bold' } },
      showHead: 'everyPage', rowPageBreak: 'avoid',
      didDrawPage: ({ pageNumber }) => {
        if (pdf.internal.getCurrentPageInfo().pageNumber > 1) { header.draw(); return; }
        if (pageNumber > 1) {
          pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(51, 65, 85);
          pdf.text(`${cname}  ·  PURCHASE INDENT ${indent.indentNumber || ''}`, M, 12);
          pdf.setDrawColor(203, 213, 225); pdf.line(M, 16, W - M, 16);
        }
      }
    });
    y = (pdf.lastAutoTable?.finalY || y) + 7;

    if (qc?.items?.length) {
      if (y > H - 48) { pdf.addPage(); header.draw(); y = 52; }
      autoTable(pdf, {
        startY: y, head: [['QC Material', 'UOM', 'Inspected Qty', 'Passed Qty', 'Rejected Qty', 'Result']],
        body: qc.items.map((line) => [line.materialName || line.materialCode || '', line.unit || '', line.receivedQty ?? '', line.acceptedQty ?? '', line.rejectedQty ?? '', line.result || '']),
        theme: 'grid', margin: { left: M, right: M, top: 52, bottom: 18 },
        styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.7, lineColor: [203, 213, 225], lineWidth: 0.15, overflow: 'linebreak' },
        headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold' },
        showHead: 'everyPage', rowPageBreak: 'avoid',
        didDrawPage: () => { if (pdf.internal.getCurrentPageInfo().pageNumber > 1) header.draw(); }
      });
      y = (pdf.lastAutoTable?.finalY || y) + 6;
    }

    const customerLines = [customer.companyName || customer.customerName, customer.address, customer.state,
      customer.gstin || customer.gstNumber, customer.phone || customer.contactNumber, customer.email].filter(Boolean);
    if (customerLines.length) {
      if (y > H - 35) { pdf.addPage(); header.draw(); y = 52; }
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(15, 23, 42);
      pdf.text('Customer Details', M, y); y += 4;
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8);
      customerLines.forEach((line) => { const wrapped = pdf.splitTextToSize(String(line), W - 2 * M); pdf.text(wrapped, M, y); y += wrapped.length * 3.5; });
      y += 3;
    }

    if (y > H - 48) { pdf.addPage(); header.draw(); y = 52; }
    const itemRows = (indent.items || []).map((item, index) => [
      String(index + 1), item.materialCode || '', item.materialName || '',
      [item.description, item.specification, item.drawingNo, item.remarks].filter(Boolean).join('\n'), item.unit || '',
      item.requiredQty ?? item.orderedQty ?? '', item.orderedQty ?? '', item.availableQty ?? '', item.purchaseQty ?? '',
      item.requiredDate || '', item.source || ''
    ]);
    autoTable(pdf, {
      startY: y, head: [['#', 'Code', 'Material', 'Description / Specification', 'UOM', 'Required', 'Ordered', 'Available', 'Purchase Qty', 'Required Date', 'Source']],
      body: itemRows,
      theme: 'grid', margin: { left: M, right: M, top: 52, bottom: 18 },
      styles: { font: 'helvetica', fontSize: 6.8, cellPadding: 1.7, lineColor: [203, 213, 225], lineWidth: 0.15, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold', halign: 'center' },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: { 0: { cellWidth: 7, halign: 'center' }, 1: { cellWidth: 17 }, 2: { cellWidth: 27 }, 3: { cellWidth: 32 }, 4: { cellWidth: 10, halign: 'center' }, 5: { cellWidth: 13, halign: 'right' }, 6: { cellWidth: 12, halign: 'right' }, 7: { cellWidth: 13, halign: 'right' }, 8: { cellWidth: 15, halign: 'right' }, 9: { cellWidth: 18 }, 10: { cellWidth: 17 } },
      showHead: 'everyPage', rowPageBreak: 'avoid',
      didDrawPage: ({ pageNumber }) => {
        if (pdf.internal.getCurrentPageInfo().pageNumber > 1) { header.draw(); return; }
        if (pageNumber > 1) {
          pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(51, 65, 85);
          pdf.text(`${cname}  ·  PURCHASE INDENT ${indent.indentNumber || ''}`, M, 12);
          pdf.setDrawColor(203, 213, 225); pdf.line(M, 16, W - M, 16);
        }
      }
    });
    y = (pdf.lastAutoTable?.finalY || y) + 6;

    const textBlocks = [
      ['Reason / Remarks', indent.reason], ['Store Remarks', indent.storeRemarks], ['Purchase Remarks', indent.purchaseRemarks],
      ['Source Workflow', indent.requirementNumber
        ? `Production Requirement ${indent.requirementNumber} | Store Review | Purchase Indent ${indent.indentNumber}${indent.poNumber ? ` | Purchase Order ${indent.poNumber}` : ''}`
        : (indent.soNumber ? `Sales Order ${indent.soNumber} | Material Availability Check | Purchase Indent ${indent.indentNumber}${indent.poNumber ? ` | Purchase Order ${indent.poNumber}` : ''}` : indent.sourceType)],
      ['QC Reference', indent.qcNumber || indent.qcStatus],
      ['QC Information', indent.qcRemarks]
    ].filter(([, value]) => value);
    if (textBlocks.length) {
      if (y > H - 45) { pdf.addPage(); header.draw(); y = 52; }
      autoTable(pdf, {
        startY: y, body: textBlocks.map(([label, value]) => [label, String(value)]),
        theme: 'grid', margin: { left: M, right: M, top: 52, bottom: 18 },
        styles: { font: 'helvetica', fontSize: 8, cellPadding: 2, lineColor: [203, 213, 225], lineWidth: 0.15, overflow: 'linebreak', valign: 'top' },
        columnStyles: { 0: { cellWidth: 38, fontStyle: 'bold' } },
        rowPageBreak: 'avoid',
        didDrawPage: ({ pageNumber }) => {
          if (pdf.internal.getCurrentPageInfo().pageNumber > 1) { header.draw(); return; }
          if (pageNumber > 1) {
            pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(51, 65, 85);
            pdf.text(`${cname}  |  PURCHASE INDENT ${indent.indentNumber || ''}`, M, 12);
            pdf.setDrawColor(203, 213, 225); pdf.line(M, 16, W - M, 16);
          }
        }
      });
      y = (pdf.lastAutoTable?.finalY || y) + 6;
    }

    const history = Array.isArray(indent.history) ? indent.history : [];
    if (history.length) {
      if (y > H - 38) { pdf.addPage(); header.draw(); y = 52; }
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.text('Approval / Workflow History', M, y); y += 4;
      autoTable(pdf, {
        startY: y, head: [['Date / Time', 'Action', 'By', 'Details']],
        body: history.map((entry) => [entry.at || '', entry.action || '', entry.name || entry.username || entry.user || '', entry.details || '']),
        theme: 'grid', margin: { left: M, right: M, top: 52, bottom: 18 },
        styles: { font: 'helvetica', fontSize: 7, cellPadding: 1.6, lineColor: [203, 213, 225], lineWidth: 0.15, overflow: 'linebreak', valign: 'top' },
        headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold' },
        showHead: 'everyPage', rowPageBreak: 'avoid',
        didDrawPage: () => { if (pdf.internal.getCurrentPageInfo().pageNumber > 1) header.draw(); }
      });
      y = (pdf.lastAutoTable?.finalY || y) + 6;
    }

    if (y > H - 34) { pdf.addPage(); header.draw(); y = 52; }
    const signatureY = Math.max(y + 10, H - 32);
    pdf.setDrawColor(100, 116, 139); pdf.setLineWidth(0.25);
    pdf.line(M, signatureY, M + 54, signatureY);
    pdf.line(W - M - 54, signatureY, W - M, signatureY);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8);
    pdf.text('Prepared By', M, signatureY + 4);
    pdf.text('Approved By', W - M, signatureY + 4, { align: 'right' });
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5);
    if (indent.createdBy) pdf.text(String(indent.createdBy), M, signatureY + 8);
    const approver = [indent.adminApprovedBy, indent.adminApprovedAt].filter(Boolean).join(' · ');
    if (approver) pdf.text(approver, W - M, signatureY + 8, { align: 'right' });
    addStandardDocumentFooters(pdf, cname, `Purchase Indent ${indent.indentNumber || ''}`);
    addVyavasthaFooter(pdf);

    if (options.returnBase64) return pdf.output('datauristring').split(',')[1];
    if (options.preview) return pdf.output('bloburl');
    if (options.print) {
      pdf.autoPrint();
      window.open(pdf.output('bloburl'), '_blank');
      return;
    }
    pdf.save(`PurchaseIndent-${indent.indentNumber || 'Draft'}.pdf`);
  } catch (error) {
    console.error('Error generating Purchase Indent PDF:', error);
    if (typeof alert === 'function') alert('Error generating Purchase Indent PDF. Check console for details.');
  }
};

/* ============================================================================
   MATERIAL RECEIPT / TAX INVOICE PDF — Pragmatic letterhead with the company
   logo, supplier + receipt meta grid, materials table carrying the Batch / Lot
   and shelf-life columns, GST priced from the PO, amount in words, signature
   block and the page footer. Same house style as the Debit Note report.
   ========================================================================== */

export const generateMaterialReceiptPDF = async (receipt, options = {}) => {
  try {
    let company = {};
    try {
      company = JSON.parse(localStorage.getItem('companySettings') || '{}');
    } catch {
      company = {};
    }
    const cname = company.companyName || getCompanyLegalName();
    const caddr = company.address || '';
    const cphone = company.phone || '';
    const cemail = company.email || '';
    const cgstin = company.gstin || '29AKWPP8736E1ZA';

    const poPayload = getPOByRef(receipt?.poNumber)?.payload || {};
    const poItems = Array.isArray(poPayload.items) ? poPayload.items : [];
    const vendor = poPayload.vendorDetails?.companyName || receipt?.vendor || '-';
    const vendorGstin = poPayload.vendorDetails?.gstNumber || poPayload.vendorDetails?.gstin || '';

    const matchPoItem = (line) =>
      poItems.find(
        (i) =>
          (line.materialCode && String(i.itemCode || '').toLowerCase() === String(line.materialCode).toLowerCase()) ||
          (!line.materialCode && String(i.itemName || '').toLowerCase() === String(line.materialName || '').toLowerCase())
      ) || null;

    /* every receipt line, priced from the Purchase Order it was received against */
    const rows = (receipt?.items || []).map((l) => {
      const pi = matchPoItem(l);
      const rate = Number(pi?.unitPrice) || 0;
      const gstPct = Number(pi?.gst) || 0;
      const qty = Number(l.receivedQty) || 0;
      const taxable = qty * rate;
      const gstAmt = (taxable * gstPct) / 100;
      return { line: l, rate, gstPct, qty, taxable, gstAmt, total: taxable + gstAmt };
    });
    const subtotal = rows.reduce((a, r) => a + r.taxable, 0);
    const totalGST = rows.reduce((a, r) => a + r.gstAmt, 0);
    const grandTotal = subtotal + totalGST;

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = pdf.internal.pageSize.getWidth();
    const H = pdf.internal.pageSize.getHeight();
    const M = 12;

    /* ---- letterhead: Pragmatic logo left, company block centred ---- */
    pdf.setTextColor(0, 0, 0);
    let y = 11;
    const logo = await loadImage(getCompanyLogoDataUri() || logoUrl);
    if (logo && logo.dataUrl) {
      const logoW = 34;
      const logoH = Math.min(22, logoW * logo.ratio);
      pdf.addImage(logo.dataUrl, 'PNG', M, y, logoW, logoH);
    }
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(15);
    pdf.text(cname, W / 2, y + 6, { align: 'center' });
    let cy = y + 11;
    if (caddr) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      const addrLines = pdf.splitTextToSize(caddr, W - 2 * M - 76);
      pdf.text(addrLines, W / 2, cy, { align: 'center' });
      cy += addrLines.length * 3.6;
    }
    const contactLine = [`Ph: ${cphone}`, cemail && `Email: ${cemail}`, cgstin && `GSTIN: ${cgstin}`]
      .filter(Boolean)
      .join('  |  ');
    if (contactLine) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7.5);
      pdf.text(contactLine, W / 2, cy, { align: 'center' });
      cy += 4;
    }
    y = Math.max(y + 24, cy);
    pdf.setLineWidth(0.5);
    pdf.line(M, y, W - M, y);
    y += 8;

    /* ---- title + status ---- */
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(13);
    pdf.text('TAX INVOICE / MATERIAL RECEIPT', W / 2, y, { align: 'center' });
    y += 6;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    pdf.text(
      `Receipt ${receipt?.receiptNumber || '-'}  ·  ${receipt?.receiptDate || ''}  ·  Status: ${
        receipt?.status || '-'
      }${receipt?.postedToInventory ? '  ·  Added to inventory' : ''}`,
      W / 2,
      y,
      { align: 'center' }
    );
    y += 9;

    /* ---- supplier (left) + receipt meta (right) ---- */
    pdf.setFontSize(9.5);
    pdf.text('Supplier / Vendor:', M, y);
    y += 5;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text(vendor, M, y);
    y += 5;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    if (vendorGstin) {
      pdf.text(`GSTIN: ${vendorGstin}`, M, y);
      y += 4;
    }
    const leftLines = [
      receipt?.dcNumber ? `DC: ${receipt.dcNumber}${receipt.dcDate ? ` · ${receipt.dcDate}` : ''}` : '',
      receipt?.vehicleNumber ? `Vehicle: ${receipt.vehicleNumber}` : '',
      receipt?.deliveredBy ? `Delivered by: ${receipt.deliveredBy}` : '',
      receipt?.transporter ? `Transporter: ${receipt.transporter}` : ''
    ].filter(Boolean);
    leftLines.forEach((t) => {
      pdf.text(t, M, y);
      y += 4;
    });

    /* `label  value` row inside a fixed-width column (value shrinks, then
       truncates, so a long value never runs into its own label). */
    const kvRow = (x, rowY, w, label, value, opt = {}) => {
      const size = opt.size || 8.5;
      const labelW = opt.labelW || w * 0.46;
      const gap = 1.6;
      const valueW = w - labelW - gap;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(size);
      pdf.text(String(label), x, rowY);
      let val = value === undefined || value === null || value === '' ? '-' : String(value);
      pdf.setFont('helvetica', 'normal');
      let s = size;
      while (s > 5 && pdf.getTextWidth(val) > valueW) s -= 0.25;
      if (pdf.getTextWidth(val) > valueW) {
        while (val.length > 1 && pdf.getTextWidth(`${val}...`) > valueW) val = val.slice(0, -1);
        val = `${val}...`;
      }
      pdf.setFontSize(s);
      if (opt.align === 'right') pdf.text(val, x + w, rowY, { align: 'right' });
      else pdf.text(val, x + labelW + gap, rowY);
      pdf.setFontSize(size);
    };

    const metaW = 74;
    const metaX = W - M - metaW;
    let my = y - 5;
    const meta = [
      ['Receipt No:', receipt?.receiptNumber],
      ['Receipt Date:', receipt?.receiptDate],
      ['PO No:', receipt?.poNumber],
      ['Vendor Invoice No:', receipt?.invoiceNumber],
      ['Invoice Date:', receipt?.invoiceDate],
      ['DC No / Date:', receipt?.dcNumber ? `${receipt.dcNumber} ${receipt.dcDate || ''}` : ''],
      ['Vehicle:', receipt?.vehicleNumber],
      ['Project:', receipt?.projectId],
      ['Sales Order:', receipt?.soNumber],
      ['Indent No:', receipt?.indentNumber],
      ['Quality Check:', receipt?.qcNumber],
      ['Inventory Posted:', receipt?.postedToInventory ? 'Yes' : 'No'],
      ...(receipt?.isReplacement ? [['Replacement For:', receipt.rejectionNumber || receipt.originalReceiptNumber]] : []),
      ...(receipt?.debitNoteNumber ? [['Debit Note:', receipt.debitNoteNumber]] : [])
    ];
    meta.forEach(([label, value]) => {
      kvRow(metaX, my, metaW, label, value, { size: 8.5, labelW: 32 });
      my += 4.4;
    });
    y = Math.max(y + 6, my + 4);

    /* ---- remarks ---- */
    if (receipt?.remarks) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text('Remarks:', M, y);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8.5);
      const remLines = pdf.splitTextToSize(receipt.remarks, W - 2 * M - 24);
      pdf.text(remLines, M + 24, y);
      y += remLines.length * 4 + 3;
    }
    y += 3;

    /* ---- materials table: quantity + Batch / Lot + shelf life + value ---- */
    autoTable(pdf, {
      startY: y,
      head: [['Sl', 'Material', 'Unit', 'PO Qty', 'Recd', 'Batch No', 'Lot No', 'Mfg / Expiry', 'Rate', 'Taxable', 'Total']],
      body: rows.map((r, i) => [
        String(i + 1),
        `${r.line.materialName || '-'}${r.gstPct ? `\nGST ${r.gstPct}%` : ''}`,
        r.line.unit || 'Nos',
        Number(r.line.orderedQty || 0).toFixed(0),
        r.qty.toFixed(0),
        r.line.batchNumber || '—',
        r.line.lotNumber || '—',
        `${r.line.mfgDate || '—'}\n${r.line.expiryDate || '—'}`,
        money(r.rate),
        money(r.taxable),
        money(r.total)
      ]),
      styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.6, lineColor: [180, 180, 180], lineWidth: 0.1 },
      headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold', halign: 'center' },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        0: { cellWidth: 8, halign: 'center' },
        1: { cellWidth: 40 },
        2: { cellWidth: 11, halign: 'center' },
        3: { cellWidth: 12, halign: 'right' },
        4: { cellWidth: 12, halign: 'right' },
        5: { cellWidth: 21 },
        6: { cellWidth: 19 },
        7: { cellWidth: 24 },
        8: { cellWidth: 12, halign: 'right' },
        9: { cellWidth: 14, halign: 'right' },
        10: { cellWidth: 13, halign: 'right' }
      },
      showHead: 'everyPage',
      rowPageBreak: 'avoid'
    });

    /* ---- totals ---- */
    let ty = (pdf.lastAutoTable?.finalY || y) + 7;
    const totalW = 66;
    const totalX = W - M - totalW;
    [
      ['Taxable Amount', money(subtotal)],
      ['Total GST', money(totalGST)]
    ].forEach(([label, value]) => {
      kvRow(totalX, ty, totalW, label, value, { size: 8.5, labelW: 32, align: 'right' });
      ty += 4.4;
    });
    pdf.setDrawColor(0, 0, 0);
    pdf.setLineWidth(0.4);
    pdf.line(totalX, ty, W - M, ty);
    ty += 5;
    kvRow(totalX, ty, totalW, 'Total Invoice Value', `INR ${money(grandTotal)}`, {
      size: 10,
      labelW: 32,
      align: 'right'
    });
    ty += 6;

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    const words = pdf.splitTextToSize(poAmountInWords(grandTotal), W - 2 * M - 4);
    pdf.text(words, M, ty);
    ty += words.length * 4 + 4;

    /* ---- quality / posting note ---- */
    const qcNote = receipt?.qcNumber
      ? `Quality Check ${receipt.qcNumber} (${receipt.qcStatus || 'recorded'}) · ${
          receipt.postedToInventory ? 'material added to inventory' : 'inventory posting pending'
        }`
      : 'Quality inspection required before inventory posting.';
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(8);
    const qcLines = pdf.splitTextToSize(qcNote, W - 2 * M);
    pdf.text(qcLines, M, ty);
    ty += qcLines.length * 4 + 3;

    /* ---- signature ---- */
    const sigY = Math.max(ty + 6, H - 32);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.text(`For ${cname}`, W - M, sigY, { align: 'right' });
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.5);
    pdf.text('Store signature', W - M, sigY + 12, { align: 'right' });
    pdf.setLineWidth(0.3);
    pdf.line(W - M - 45, sigY + 10, W - M, sigY + 10);
    pdf.setFontSize(8);
    pdf.text(`Entered by: ${receipt?.createdBy || '-'}${receipt?.createdAt ? ` · ${receipt.createdAt}` : ''}`, M, sigY + 6);
    pdf.text(`Generated on: ${new Date().toLocaleString('en-IN')}`, M, sigY + 10);

    /* ---- footer on every page ---- */
    const pages = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i += 1) {
      pdf.setPage(i);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      pdf.text(`${cname} — Material Receipt ${receipt?.receiptNumber || ''}`, M, H - 8);
      pdf.text(`Page ${i} of ${pages}`, W - M, H - 8, { align: 'right' });
    }

    addVyavasthaFooter(pdf);

    if (options.returnBase64) {
      return pdf.output('datauristring').split(',')[1];
    }
    if (options.print) {
      pdf.autoPrint();
      window.open(pdf.output('bloburl'), '_blank');
      return;
    }

    pdf.save(`MaterialReceipt-${receipt?.receiptNumber || 'Draft'}.pdf`);
  } catch (error) {
    console.error('Error generating Material Receipt PDF:', error);
    if (typeof alert === 'function') alert('Error generating Material Receipt PDF. Check console for details.');
  }
};

/* ============================================================================
   PURCHASE ORDER PDF — "PO to Supplier" reference format
   Red serif title above the frame, GSTIN strip + centred navy company block,
   TO vendor | PO details (P.O No / Date, Your Ref, Ship To) row, salutation +
   intro, materials table with dark-red header, Terms | totals grid, amount in
   words, signature block and the reference footer.
   ========================================================================== */

const poMoney = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.00';
  const neg = n < 0;
  const parts = Math.abs(n).toFixed(2).split('.');
  return `${neg ? '-' : ''}${parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${parts[1]}`;
};

/** shrink a single line until it fits maxW — returns the text + font size */
const fitLine = (pdf, value, maxW, size, min = 5.2) => {
  let text = value === undefined || value === null || value === '' ? '-' : String(value);
  let s = size;
  pdf.setFontSize(s);
  while (s > min && pdf.getTextWidth(text) > maxW) {
    s -= 0.25;
    pdf.setFontSize(s);
  }
  if (pdf.getTextWidth(text) > maxW) {
    while (text.length > 1 && pdf.getTextWidth(`${text}...`) > maxW) text = text.slice(0, -1);
    text = `${text}...`;
  }
  return { text, size: s };
};

export const generatePurchaseOrderPDF = async (payload, options = {}) => {
  try {
    const po = payload?.poDetails || {};
    const vendor = payload?.vendorDetails || {};
    const items = Array.isArray(payload?.items) ? payload.items : [];
    let company = payload?.companyDetails && Object.keys(payload.companyDetails).length ? payload.companyDetails : {};
    if (!Object.keys(company).length) {
      try {
        company = JSON.parse(localStorage.getItem('companySettings') || '{}');
      } catch {
        company = {};
      }
    }
    const cname = company.companyName || getCompanyLegalName();
    const caddr = company.address || '';
    const cgstin = company.gstin || '29AKWPP8736E1ZA';
    const pt = computePOTotals(payload?.totals || {}, po);

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = pdf.internal.pageSize.getWidth();
    const H = pdf.internal.pageSize.getHeight();

    /* geometry taken from the reference "PO to Supplier" sheet (mm) */
    const FX0 = 9.3;
    const FX1 = 201.9;
    const FY0 = 12.9;
    const FY1 = 282.9;
    const FW = FX1 - FX0;
    const FCX = FX0 + FW / 2;
    const SPLIT = 113.0; /* left (TO) | right (PO details) */
    const TERM_X = 138.4; /* terms | totals */

    const setF = (style, size, color = [0, 0, 0]) => {
      pdf.setFont('helvetica', style);
      pdf.setFontSize(size);
      pdf.setTextColor(color[0], color[1], color[2]);
    };
    const hline = (x1, x2, yy, lw = 0.3) => {
      pdf.setDrawColor(0, 0, 0);
      pdf.setLineWidth(lw);
      pdf.line(x1, yy, x2, yy);
    };
    const vline = (x, y1, y2, lw = 0.3) => {
      pdf.setDrawColor(0, 0, 0);
      pdf.setLineWidth(lw);
      pdf.line(x, y1, x, y2);
    };

    /* ---- title sits above the frame ---- */
    pdf.setFont('times', 'bold');
    pdf.setFontSize(12.4);
    pdf.setTextColor(128, 0, 0);
    pdf.text('PURCHASE ORDER', FCX, 12.0, { align: 'center' });

    /* =============== section A: GSTIN strip + company block =============== */
    setF('bold', 6.8);
    pdf.text('GSTIN No :', FX0 + 0.7, FY0 + 4.4);
    const gst = fitLine(pdf, cgstin, 45, 6.8);
    pdf.text(gst.text, FX0 + 18.6, FY0 + 4.4);

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(16.6);
    pdf.setTextColor(0, 0, 128);
    pdf.text(cname, FCX, FY0 + 13.9, { align: 'center' });

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9.1);
    pdf.setTextColor(0, 0, 0);
    let cy = FY0 + 23.3;
    const addrLines = caddr ? pdf.splitTextToSize(String(caddr), FW - 26) : [];
    addrLines.forEach((l) => {
      pdf.text(l, FCX, cy, { align: 'center' });
      cy += 5.55;
    });
    const mail = company.email ? `E-mail: ${company.email}` : company.phone ? `Phone: ${company.phone}` : '';
    if (mail) {
      pdf.text(mail, FCX, cy, { align: 'center' });
      cy += 5.55;
    }
    const yA = Math.max(48.9, cy - 4.25);
    hline(FX0, FX1, yA, 0.35);

    /* =============== section B: TO vendor | PO details + Ship To ========== */
    const topB = yA;
    const rowLines = [topB + 6.43, topB + 12.42, topB + 18.25, topB + 23.9, topB + 29.7];
    const poProgress = getPOProgress(po.poNumber);
    const detailRows = [
      ['P.O No', po.poNumber || '-'],
      ['P.O Date', po.poDate || '-'],
      ['Your Ref No.', po.yourRefNo || po.quotationRef || '-'],
      ['Your Ref Date', po.yourRefDate || po.quotationDate || '-'],
      ['Status', poProgress.status || po.poStatus || '-']
    ];
    const shipLines = [
      po.shipToName || '',
      cname,
      po.shipToAddress || po.deliveryAddress || '',
      po.shipToMobile ? `Mobile:  ${po.shipToMobile}` : ''
    ].filter(Boolean);

    const vName = vendor.companyName || vendor.vendorName || '-';
    const vAddrLines = vendor.address ? pdf.splitTextToSize(String(vendor.address), SPLIT - FX0 - 8) : [];
    const leftEnd = vAddrLines.length ? topB + 12.7 + (vAddrLines.length - 1) * 4.5 : topB + 6.4;
    const shipTop = rowLines[4];
    const shipEnd = shipTop + 6.6 + Math.max(shipLines.length - 1, 0) * 3.45;
    const yB = Math.max(95.05, leftEnd + 13.6, shipEnd + 2.4);

    /* right box: 4 detail rows + Ship To block */
    rowLines.forEach((yy) => hline(SPLIT, FX1, yy, 0.3));
    vline(SPLIT, topB, yB, 0.35);
    const labelX = SPLIT + 1.1;
    const colonX = 137.8;
    const valX = 140.8;
    detailRows.forEach(([label, value], i) => {
      const rTop = i === 0 ? topB : rowLines[i - 1];
      const baseline = rTop + (rowLines[i] - rTop) / 2 + 1.3;
      setF('normal', 7.6);
      pdf.text(label, labelX, baseline);
      pdf.text(':', colonX, baseline);
      setF('bold', 7.6);
      const fit = fitLine(pdf, value, FX1 - 1.5 - valX, 7.6);
      pdf.setFontSize(fit.size);
      pdf.text(fit.text, valX, baseline);
    });
    setF('bold', 7.0);
    const shipLabel = 'Ship To Address :';
    pdf.text(shipLabel, labelX, shipTop + 2.8);
    pdf.setDrawColor(0, 0, 0);
    pdf.setLineWidth(0.15);
    pdf.line(labelX, shipTop + 3.55, labelX + pdf.getTextWidth(shipLabel), shipTop + 3.55);
    let shy = shipTop + 6.6;
    shipLines.forEach((l) => {
      setF('bold', 6.0);
      const fit = fitLine(pdf, l, FX1 - labelX - 2, 6.0);
      pdf.setFontSize(fit.size);
      pdf.text(fit.text, labelX + 0.5, shy);
      shy += 3.45;
    });

    /* left box: TO + vendor + GST / phone / e-mail rows anchored to the bottom */
    setF('bold', 7.6);
    pdf.text('TO', FX0 + 0.7, topB + 2.75);
    const nameFit = fitLine(pdf, String(vName).toUpperCase(), SPLIT - FX0 - 7, 7.6);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(nameFit.size);
    pdf.text(nameFit.text, FX0 + 6.2, topB + 6.4);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.6);
    let vy = topB + 12.7;
    vAddrLines.forEach((l) => {
      pdf.text(l, FX0 + 6.6, vy);
      vy += 4.5;
    });
    const contactRows = [
      ['GST No', vendor.gstNumber || '-'],
      ['Phone No', vendor.contactNumber || vendor.phone || '-'],
      ['Email ID', vendor.email || '-']
    ];
    const rowY = [yB - 10.95, yB - 6.45, yB - 2.75];
    contactRows.forEach(([k, v], i) => {
      setF('normal', 6.8);
      pdf.text(k, FX0 + 6.6, rowY[i]);
      pdf.text(':', FX0 + 22.4, rowY[i]);
      const fit = fitLine(pdf, v, SPLIT - (FX0 + 25) - 3, 6.8);
      pdf.setFontSize(fit.size);
      pdf.text(fit.text, FX0 + 25, rowY[i]);
    });
    hline(FX0, FX1, yB, 0.35);

    /* ==================== section C: salutation + intro ==================== */
    const salY = yB + 3.75;
    setF('normal', 7.6);
    pdf.text('Dear Sir/ Madam,', FX0 + 0.6, salY);
    const intro =
      'We take pleasure in placing our order with you for the supply of the following items against the ' +
      'subject PO in accordance with the terms and conditions mentioned.';
    let iy = salY + 4.55;
    pdf.splitTextToSize(intro, 124).forEach((l) => {
      pdf.text(l, FX0 + 0.6, iy);
      iy += 4.55;
    });
    const yCBase = Math.max(116.4, iy + 1.5);
    const summaryRows = [
      `Ordered Quantity: ${poProgress.ordered} | Original Received: ${poProgress.originalArrived} | Original Accepted: ${poProgress.originalAccepted} | Rejected: ${poProgress.rejected} | Replacement Received: ${poProgress.replacementArrived}`,
      `Replacement Accepted: ${poProgress.replacementAccepted} | Total Accepted: ${poProgress.totalAccepted} | Physical Receipt Balance: ${poProgress.physicalReceiptBalance} | Accepted Quantity Shortage: ${poProgress.acceptedQuantityShortage} | QC Pending: ${poProgress.qcPending}`
    ];
    setF('normal', 5.8);
    summaryRows.forEach((line, index) => {
      const fit = fitLine(pdf, line, FX1 - FX0 - 1.2, 5.8);
      pdf.setFontSize(fit.size);
      pdf.text(fit.text, FX0 + 0.6, yCBase + 2.2 + index * 3.1);
    });
    const yC = yCBase + 8.2;

    /* ======================= materials table ============================== */
    const n = Math.max(items.length, 1);
    let minRow = (205.5 - yC - 9.4) / n;
    minRow = Math.max(7, Math.min(minRow, 95));

    autoTable(pdf, {
      startY: yC,
      head: [['Sl', 'Description of Materials', 'HSN/\nSAC', 'QTY', 'UOM', 'Rate', 'Disc\n%', 'Unit Price', 'Total']],
      body: items.map((it, i) => {
        const qty = Number(it.quantity) || 0;
        const rate = Number(it.unitPrice) || 0;
        const disc = Number(it.discountPct) || 0;
        const namePart = [it.itemName, it.drawingNo].filter(Boolean).join('-');
        const desc = namePart ? `(${namePart})` : '-';
        return [
          String(i + 1),
          desc,
          it.hsnSac || '-',
          String(parseFloat(qty.toFixed(3))),
          it.unit || 'Nos',
          poMoney(rate),
          disc ? String(disc) : '',
          poMoney(rate * (1 - disc / 100)),
          poMoney(it.amount)
        ];
      }),
      theme: 'grid',
      margin: { left: FX0, right: W - FX1, top: 10, bottom: 18 },
      styles: {
        font: 'helvetica',
        fontSize: 6.8,
        cellPadding: 1.4,
        lineColor: [0, 0, 0],
        lineWidth: 0.25,
        textColor: [0, 0, 0],
        valign: 'top',
        overflow: 'linebreak'
      },
      headStyles: {
        fillColor: [255, 255, 255],
        textColor: [128, 0, 0],
        fontStyle: 'bold',
        halign: 'center',
        fontSize: 7.8,
        cellPadding: 1.1
      },
      bodyStyles: { fontStyle: 'bold', minCellHeight: minRow },
      columnStyles: {
        0: { cellWidth: 5.1, halign: 'center' },
        1: { cellWidth: 71.5, halign: 'left' },
        2: { cellWidth: 18.3, halign: 'center' },
        3: { cellWidth: 12.7, halign: 'center' },
        4: { cellWidth: 9.2, halign: 'center' },
        5: { cellWidth: 18.9, halign: 'right' },
        6: { cellWidth: 10.5, halign: 'right' },
        7: { cellWidth: 22.1, halign: 'right' },
        8: { cellWidth: 24.3, halign: 'right' }
      },
      showHead: 'everyPage',
      rowPageBreak: 'avoid'
    });
    const yT = pdf.lastAutoTable?.finalY || yC;

    /* ============ lower half: terms | totals, words, signature ============= */
    const termsLines = [];
    const termsText = String(po.termsAndConditions || '').trim();
    if (termsText) {
      termsText
        .split(/\r?\n/)
        .filter((t) => t.trim())
        .forEach((t) => {
          pdf.splitTextToSize(t, TERM_X - FX0 - 2.5).forEach((l) => termsLines.push(l));
        });
    }
    const words = poAmountInWords(pt.grandTotal).replace(/^Rs\.\s*/, '');

    const drawBottom = (top) => {
      const rowH = 6.05;
      const rows = [
        ['Total Amount', pt.totalAmount],
        ...(pt.discount > 0 ? [['Discount', -pt.discount]] : []),
        ['Packing Charges', pt.packingCharges],
        ['Sub Total', pt.subTotal],
        ...(pt.totalGST > 0 ? [[`CGST@${pt.gstRate}%`, pt.cgst], [`SGST@${pt.gstRate}%`, pt.sgst]] : []),
        null,
        ['FREIGHT', pt.freight]
      ];
      const rowsEnd = top + rows.length * rowH + 7.3;
      const headY = top + 4.8;
      const termsStartY = top + 9.6;
      const termsEnd = termsLines.length
        ? termsStartY + (termsLines.length - 1) * 4.5 + 3
        : headY + 3;
      const sigY = Math.max(rowsEnd, termsEnd);
      const wordsLines = pdf.splitTextToSize(words, TERM_X - FX0 - 2.5);
      const wordsEnd = sigY + 13.5 + (wordsLines.length - 1) * 4.3 + 3;
      if (wordsEnd > FY1 - 1) return false;

      /* terms side */
      setF('bold', 7.6);
      const head = 'Terms & Conditions: -';
      pdf.text(head, FX0 + 0.5, headY);
      pdf.setDrawColor(0, 0, 0);
      pdf.setLineWidth(0.15);
      pdf.line(FX0 + 0.5, headY + 0.4, FX0 + 0.5 + pdf.getTextWidth(head), headY + 0.4);
      setF('normal', 7.6);
      let ty = termsStartY;
      termsLines.forEach((l) => {
        pdf.text(l, FX0 + 1.0, ty);
        ty += 4.5;
      });

      /* totals grid (label | value divider continues the Unit Price | Total rule) */
      vline(FX0 + 5.1 + 71.5 + 18.3 + 12.7 + 9.2 + 18.9 + 10.5 + 22.1, top, sigY, 0.3);
      rows.forEach((r, i) => {
        const rTop = top + i * rowH;
        if (r) {
          setF('bold', 7.2);
          pdf.text(r[0], TERM_X + 1.3, rTop + 4.7);
          setF('bold', 7.0);
          pdf.text(poMoney(r[1]), FX1 - 1.2, rTop + 4.7, { align: 'right' });
        }
        hline(TERM_X, FX1, rTop + rowH, 0.3);
      });
      setF('bold', 7.6);
      pdf.text('GRAND TOTAL', TERM_X + 1.3, sigY - 2.4);
      setF('bold', 7.2);
      pdf.text(poMoney(pt.grandTotal), FX1 - 1.2, sigY - 2.4, { align: 'right' });

      hline(FX0, FX1, sigY, 0.35);
      vline(TERM_X, top, FY1, 0.35);

      /* amount in words */
      setF('normal', 6.8);
      const wLabel = 'Total Purchase Value In Amount : Rs';
      pdf.text(wLabel, FX0 + 0.5, sigY + 7.4);
      pdf.setLineWidth(0.15);
      pdf.line(FX0 + 0.5, sigY + 7.75, FX0 + 0.5 + pdf.getTextWidth(wLabel), sigY + 7.75);
      setF('normal', 6.8);
      let wy = sigY + 13.5;
      wordsLines.forEach((l) => {
        pdf.text(l, FX0 + 0.5, wy);
        wy += 4.3;
      });

      /* signature */
      setF('bold', 8.3);
      const nameW = pdf.getTextWidth(cname);
      pdf.text(cname, FX1 - 1.2, sigY + 5.1, { align: 'right' });
      setF('bold', 9.1);
      const forW = pdf.getTextWidth('For');
      pdf.text('For', FX1 - 1.2 - nameW - 8 - forW, sigY + 5.1);
      return true;
    };

    if (!drawBottom(yT)) {
      pdf.addPage();
      drawBottom(25);
    }

    const finish = () => {
      const pages = pdf.internal.getNumberOfPages();
      for (let i = 1; i <= pages; i += 1) {
        pdf.setPage(i);
        pdf.setDrawColor(0, 0, 0);
        pdf.setLineWidth(0.35);
        pdf.rect(FX0, FY0, FW, FY1 - FY0, 'S');
        pdf.setFont('times', 'normal');
        pdf.setFontSize(8.8);
        pdf.setTextColor(0, 0, 0);
        pdf.setFont('times', 'bold');
        pdf.setFontSize(7.1);
        pdf.text(`Page ${i} of ${pages}`, FX1, 286.1, { align: 'right' });
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(5.6);
      }
      addVyavasthaFooter(pdf);
      if (options.returnBase64) return pdf.output('datauristring').split(',')[1];
      /* Hand the document back as a Blob so the caller can store / forward it
         (used by "Save Purchase Order → send PDF to the Store Department"). */
      if (options.blob) return pdf.output('blob');
      if (options.print) {
        pdf.autoPrint();
        window.open(pdf.output('bloburl'), '_blank');
        return undefined;
      }
      const safeName = String(po.poNumber || 'Draft').replace(/[\\/:*?"<>|]+/g, '-');
      pdf.save(`PurchaseOrder-${safeName}.pdf`);
      return undefined;
    };

    return finish();
  } catch (error) {
    console.error('Error generating Purchase Order PDF:', error);
    alert('Error generating Purchase Order PDF. Check console for details.');
    return undefined;
  }
};

/* ============================================================================
   EXPORT INVOICE PDF — "Invoice cum Packing List" reference format
   Exporter | invoice meta + exporter ref header, Buyer | Ship To + country of
   origin row, logistics grid, customs table (no row rules), Rule 96A band,
   weights, amount chargeable + MEIS claim, bank, declaration, signature.
   ========================================================================== */

export const generateExportInvoicePDF = async (inv, options = {}) => {
  try {
    const profile = inv?.exportProfile || {};
    const company = inv?.companyDetails || {};
    const bank = inv?.bankDetails || {};
    const logistics = inv?.logistics || {};
    const buyer = inv?.buyer || {};
    const items = Array.isArray(inv?.items) ? inv.items : [];
    const cname = company.companyName || getCompanyLegalName();
    const words = inv?.amountInWords || usdAmountInWords(inv?.totals?.amountUSD || 0);

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = pdf.internal.pageSize.getWidth();
    const H = pdf.internal.pageSize.getHeight();

    const FL = 7;
    const FT = 19;
    const FR = 203;
    const FB = H - 6.4; /* 290.6 */
    const XV = 107.2; /* exporter | right block */
    const XV2 = 155.9; /* invoice meta | exporter ref */
    /* table columns: marks | packages | description | qty | rate | amount */
    const COLS = [FL, 30.4, 53.7, 133.5, 157.5, 178.2, FR];
    const DESC_L = COLS[2];
    const DESC_R = COLS[3];
    const QTY_X = COLS[4];
    const AMT_X = COLS[5];

    const setF = (style, size, color = [0, 0, 0], family = 'helvetica') => {
      pdf.setFont(family, style);
      pdf.setFontSize(size);
      pdf.setTextColor(color[0], color[1], color[2]);
    };
    const hline = (x1, x2, yy, lw = 0.3) => {
      pdf.setDrawColor(0, 0, 0);
      pdf.setLineWidth(lw);
      pdf.line(x1, yy, x2, yy);
    };
    const vline = (x, y1, y2, lw = 0.3) => {
      pdf.setDrawColor(0, 0, 0);
      pdf.setLineWidth(lw);
      pdf.line(x, y1, x, y2);
    };
    const kv = (label, value, x, colonX, valX, yy, size, maxW, bold = false) => {
      setF('normal', size);
      pdf.text(label, x, yy);
      pdf.text(':', colonX, yy);
      setF(bold ? 'bold' : 'normal', size);
      const fit = fitLine(pdf, value, maxW, size);
      pdf.setFontSize(fit.size);
      pdf.text(fit.text, valX, yy);
    };

    const finish = () => {
      const pages = pdf.internal.getNumberOfPages();
      for (let i = 1; i <= pages; i += 1) {
        pdf.setPage(i);
        pdf.setDrawColor(0, 0, 0);
        pdf.setLineWidth(0.5);
        pdf.rect(7, 19, W - 14, H - 6.4 - 19, 'S');
        if (pages > 1) {
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(7);
          pdf.setTextColor(0, 0, 0);
          pdf.text(`Page ${i} of ${pages}`, FR, FB + 3.4, { align: 'right' });
        }
      }
      addVyavasthaFooter(pdf);
      if (options.returnBase64) return pdf.output('datauristring').split(',')[1];
      if (options.print) {
        pdf.autoPrint();
        window.open(pdf.output('bloburl'), '_blank');
        return undefined;
      }
      const safeName = String(inv?.invoiceNumber || 'Draft').replace(/[\\/:*?"<>|]+/g, '-');
      pdf.save(`ExportInvoice-${safeName}.pdf`);
      return undefined;
    };

    /* ------------------------------- title ------------------------------- */
    setF('bold', 9.9);
    pdf.text('INVOICE CUM PACKING LIST', W / 2, 14.9, { align: 'center' });
    if (inv?.status === 'Draft') {
      setF('normal', 7);
      pdf.text('DRAFT — NOT YET ISSUED', W / 2, 17.6, { align: 'center' });
    }

    /* ============ row 1: exporter | invoice meta | exporter ref ========== */
    setF('normal', 7.6);
    pdf.text('Exporter', FL + 1.2, FT + 2.9);
    setF('bold', 8.6);
    pdf.text(':', FL + 18.0, FT + 2.9);
    setF('bold', 10.6);
    const expName = fitLine(pdf, cname, XV - (FL + 21.5) - 3, 10.6);
    pdf.setFontSize(expName.size);
    pdf.text(expName.text, FL + 21.5, FT + 3.4);

    setF('normal', 6.8);
    let ey = FT + 7.5;
    const expAddr = company.address ? pdf.splitTextToSize(String(company.address), XV - FL - 5) : [];
    expAddr.forEach((l) => {
      pdf.text(l, FL + 1.2, ey);
      ey += 3.94;
    });
    if (company.email) {
      pdf.text(`E-mail: ${company.email}`, FL + 1.2, ey);
      ey += 3.94;
    }
    const expContactY = Math.max(FT + 21.9, ey + 1.8);
    pdf.text(
      `Contact Person :  ${profile.contactPerson || '-'}, Contact No : ${profile.contactNo || '-'}`,
      FL + 1.0,
      expContactY
    );
    const y1 = Math.max(FT + 31.15, expContactY + 3.0);

    const r1Div = FT + 8.7;
    const r1Mid = FT + 25.6;

    /* invoice meta cell */
    const metaX = XV + 1.0;
    setF('bold', 6.8);
    pdf.text('Invoice No. & Date', metaX, FT + 2.4);
    setF('bold', 7.6);
    const invFit = fitLine(pdf, `${inv?.invoiceNumber || '-'} / ${inv?.invoiceDate || '-'}`, XV2 - metaX - 2, 7.6);
    pdf.setFontSize(invFit.size);
    pdf.text(invFit.text, XV + 4.0, FT + 7.5);

    setF('normal', 6.8);
    pdf.text("Buyer's Order No. & Date", metaX, FT + 14.3);
    setF('normal', 8.9);
    const orderFit = fitLine(pdf, inv?.buyersOrderNo || '-', XV2 - (XV + 4.0) - 2, 8.9);
    pdf.setFontSize(orderFit.size);
    pdf.text(orderFit.text, XV + 4.0, FT + 18.5);
    setF('normal', 7.7);
    const orderDateFit = fitLine(pdf, inv?.buyersOrderDate || '-', XV2 - (XV + 4.0) - 2, 7.7);
    pdf.setFontSize(orderDateFit.size);
    pdf.text(orderDateFit.text, XV + 4.0, FT + 24.5);

    /* exporter ref cell */
    setF('normal', 6.8);
    pdf.text('Exporter Ref.', XV2 + 5.5, FT + 2.2);
    const iecFit = fitLine(pdf, `IEC NO.: ${profile.iecNumber || '-'}`, FR - (XV2 + 4.25) - 2, 6.8);
    pdf.setFontSize(iecFit.size);
    pdf.text(iecFit.text, XV2 + 4.25, FT + 7.1);
    kv('GST No', company.gstin || '-', XV2 + 0.9, 167.0, 169.7, FT + 12.6, 6.8, FR - 172.7);
    kv('PAN No', company.pan || '-', XV2 + 0.9, 167.0, 169.7, FT + 19.0, 6.8, FR - 172.7);
    const lutFit = fitLine(pdf, `LUT NO : ${profile.lutNumber || '-'}`, FR - (XV2 + 0.6) - 2, 6.8);
    pdf.setFontSize(lutFit.size);
    pdf.text(lutFit.text, XV2 + 0.6, FT + 24.4);

    /* other reference strip */
    setF('normal', 8.6, [0, 0, 0], 'times');
    pdf.text('Other reference(s):', XV + 1.0, r1Mid + 4.0);
    setF('bold', 8.6, [0, 0, 0], 'times');
    const refFit = fitLine(pdf, logistics.otherReferences || '-', FR - (XV + 30.4) - 2, 8.6);
    pdf.setFontSize(refFit.size);
    pdf.text(refFit.text, XV + 30.4, r1Mid + 4.0);

    hline(XV, XV2, r1Div, 0.3);
    hline(XV, FR, r1Mid, 0.3);
    vline(XV2, FT, r1Mid, 0.3);
    hline(FL, FR, y1, 0.35);

    /* ============= row 2: Buyer (Bill To) | Ship To + country ============= */
    const bTop = y1;
    setF('bold', 7.6);
    pdf.text('Buyer (Bill To) :', FL + 1.0, bTop + 3.75);
    setF('bold', 7.6);
    const bName = fitLine(pdf, buyer.name || '-', XV - FL - 3.5, 7.6);
    pdf.setFontSize(bName.size);
    pdf.text(bName.text, FL + 1.0, bTop + 9.05);
    setF('bold', 6.8);
    let by = bTop + 15.05;
    const bAddr = buyer.address ? pdf.splitTextToSize(String(buyer.address), XV - FL - 3.5) : [];
    bAddr.forEach((l) => {
      pdf.text(l, FL + 1.0, by);
      by += 3.97;
    });
    const bContactY = Math.max(bTop + 30.85, by + 1.9);
    kv('Contact Person', buyer.contactPerson || '-', FL + 1.0, FL + 23.8, FL + 25.9, bContactY, 6.8, XV - (FL + 25.9) - 3);
    const bContactNoY = bContactY + 4.4;
    kv('Contact No', buyer.contactNo || '-', FL + 1.0, FL + 23.8, FL + 25.9, bContactNoY, 6.8, XV - (FL + 25.9) - 3);

    setF('bold', 7.6);
    pdf.text('Ship To :', XV + 1.0, bTop + 4.45);
    setF('bold', 6.8);
    let sy = bTop + 10.25;
    const shipTo = String(inv?.shipToAddress || '').trim();
    const shipAddr = shipTo ? pdf.splitTextToSize(shipTo, FR - XV - 3) : ['-'];
    shipAddr.forEach((l) => {
      pdf.text(l, XV + 1.0, sy);
      sy += 3.97;
    });
    const divY = Math.max(bTop + 25.75, sy + 1.0);
    const r2 = Math.max(bTop + 36.35, divY + 10.7, bContactNoY + 1.0);
    hline(XV, FR, divY, 0.3);
    const midX = 154.8;
    vline(midX, divY, r2, 0.3);
    setF('normal', 6.8);
    pdf.text('Country of origin of goods', XV + (midX - XV) / 2, divY + 3.8, { align: 'center' });
    pdf.text('Country of final destination', midX + (FR - midX) / 2, divY + 3.8, { align: 'center' });
    setF('bold', 7.6);
    const originFit = fitLine(pdf, inv?.countryOfOrigin || '-', midX - XV - 4, 7.6);
    pdf.setFontSize(originFit.size);
    pdf.text(originFit.text, XV + (midX - XV) / 2, divY + 9.0, { align: 'center' });
    const destFit = fitLine(pdf, inv?.countryOfDestination || '-', FR - midX - 4, 7.6);
    pdf.setFontSize(destFit.size);
    pdf.text(destFit.text, midX + (FR - midX) / 2, divY + 9.0, { align: 'center' });
    hline(FL, FR, r2, 0.35);

    /* ==================== row 3: logistics grid =========================== */
    const r3 = r2 + 30;
    /* continuous exporter | right-block divider down to the table (target x=107.2) */
    vline(XV, FT, r3, 0.3);
    const l1 = r2 + 10.32;
    const l2 = r2 + 19.84;
    hline(FL, FR, l1, 0.3);
    hline(FL, FR, l2, 0.3);
    const L2X = 52.1;
    vline(L2X, r2, r3, 0.3);

    const leftCells = [
      ['Pre-Carriage by', logistics.preCarriage, r2 + 3.7, r2 + 9.2],
      ['Place of Receipt by pre-carrier', logistics.placeOfReceipt, r2 + 3.7, r2 + 9.2],
      ['Vessel / Flight No.', logistics.vesselFlight, r2 + 13.5, r2 + 19.0],
      ['Port of Loading', logistics.portOfLoading, r2 + 13.5, r2 + 19.0],
      ['Port of Discharge', logistics.portOfDischarge, r2 + 22.9, r2 + 28.7],
      ['Final Destination', logistics.finalDestination, r2 + 22.9, r2 + 28.7]
    ];
    leftCells.forEach(([label, value, ly, vy], i) => {
      const x = i % 2 === 0 ? FL + 1.2 : L2X + 1.0;
      const w = (i % 2 === 0 ? L2X : XV) - x - 2;
      setF('normal', 6.8);
      pdf.text(label, x, ly);
      setF('bold', 7.6);
      const fit = fitLine(pdf, value || '-', w, 7.6);
      pdf.setFontSize(fit.size);
      pdf.text(fit.text, x + 0.7, vy);
    });

    const rLabel = 'Terms of Delivery :';
    setF('bold', 7.6);
    pdf.text(rLabel, XV + 1.0, r2 + 6.3);
    let rValX = XV + 1.0 + pdf.getTextWidth(rLabel) + 2.5;
    setF('bold', 6.8);
    const tFit = fitLine(pdf, inv?.termsOfDelivery || '-', FR - rValX - 2, 6.8);
    pdf.setFontSize(tFit.size);
    pdf.text(tFit.text, rValX, r2 + 6.3);
    const pLabel = 'Payment Terms  :';
    setF('bold', 7.6);
    pdf.text(pLabel, XV + 1.0, r2 + 15.5);
    rValX = XV + 1.0 + pdf.getTextWidth(pLabel) + 2.5;
    setF('bold', 6.8);
    const pFit = fitLine(pdf, inv?.paymentTerms || '-', FR - rValX - 2, 6.8);
    pdf.setFontSize(pFit.size);
    pdf.text(pFit.text, rValX, r2 + 15.5);
    setF('normal', 7.6);
    const claimFit = fitLine(pdf, CLAIM_DRAWBACK_LINE, FR - XV - 3, 7.6);
    pdf.setFontSize(claimFit.size);
    pdf.text(claimFit.text, XV + 1.0, r2 + 25.3);

    /* ========================= customs table ============================= */
    const T3 = r3;
    const HEAD_H = 12.6;
    const headBottom = T3 + HEAD_H;
    hline(FL, FR, T3, 0.35);
    hline(FL, FR, headBottom, 0.35);

    const headerCells = [
      ['Marks &', 'Numbers.', 'Container no.'],
      ['No. & Kind', 'of Packages'],
      ['Description of Goods'],
      ['Total', 'Quantity'],
      ['RATE', 'USD'],
      ['AMOUNT', 'USD']
    ];
    setF('bold', 6.8);
    headerCells.forEach((lines, ci) => {
      const cx = (COLS[ci] + COLS[ci + 1]) / 2;
      let hy = T3 + 3.4;
      lines.forEach((l) => {
        pdf.text(l, cx, hy, { align: 'center' });
        hy += 3.97;
      });
    });

    let byy = headBottom + 4.1;
    items.forEach((it, i) => {
      const descLines = pdf.splitTextToSize(String(it.description || '-'), DESC_R - (DESC_L + 7.94) - 1.5);
      const rowCount = Math.max(descLines.length, 1);
      setF('normal', 6.8);
      pdf.text(String(i + 1), (COLS[0] + COLS[1]) / 2, byy, { align: 'center' });
      const pkgFit = fitLine(pdf, it.packages || '-', COLS[2] - COLS[1] - 3, 6.8);
      pdf.setFontSize(pkgFit.size);
      pdf.text(pkgFit.text, (COLS[1] + COLS[2]) / 2, byy, { align: 'center' });
      const qty = Number(it.quantity) || 0;
      const qtyFit = fitLine(pdf, `${qty}${it.unit ? ` ${it.unit}` : ''}`, COLS[4] - COLS[3] - 3, 6.8);
      pdf.setFontSize(qtyFit.size);
      pdf.text(qtyFit.text, (COLS[3] + COLS[4]) / 2, byy, { align: 'center' });
      setF('normal', 6.8);
      pdf.text(poMoney(it.rate), (COLS[4] + COLS[5]) / 2, byy, { align: 'center' });
      pdf.text(poMoney(it.amount), (COLS[5] + COLS[6]) / 2, byy, { align: 'center' });
      /* description with the "n )" item prefix and hanging indent */
      setF('normal', 7.6);
      const num = String(i + 1);
      pdf.text(num, DESC_L + 2.35, byy);
      pdf.text(')', DESC_L + 2.35 + pdf.getTextWidth(num) + 1.0, byy);
      descLines.forEach((l, li) => pdf.text(l, DESC_L + 7.94, byy + li * 4.5));
      byy += Math.max(rowCount, 1) * 4.5;
    });

    const bottomH = 54.5;
    const availEnd = Math.min(T3 + 119.3, FB - bottomH);
    const needBreak = byy + 1.5 > availEnd;
    const bodyEnd = needBreak ? byy + 1.5 : availEnd;
    hline(FL, DESC_R, bodyEnd, 0.3);
    vline(COLS[1], T3, bodyEnd, 0.3);
    vline(COLS[2], T3, bodyEnd, 0.3);
    vline(DESC_R, T3, needBreak ? bodyEnd : FB, 0.35);
    vline(QTY_X, T3, needBreak ? bodyEnd : bodyEnd + 16.05, 0.3);
    vline(AMT_X, T3, needBreak ? bodyEnd : bodyEnd + 21.95, 0.3);

    /* ============ lower block: Rule 96A, weights, totals ================= */
    const drawBottom = (top) => {
      const h1 = top + 10.49;
      const y3 = top + 16.05;
      const rA = y3 + 18.08;
      const rB = y3 + 27.43;
      const rR = y3 + 5.9;

      hline(FL, DESC_R, h1, 0.3);
      hline(FL, FR, y3, 0.35);
      hline(FL, DESC_R, rA, 0.3);
      hline(FL, DESC_R, rB, 0.3);
      hline(AMT_X, FR, rR, 0.3);
      vline(DESC_R, top, FB, 0.35);
      vline(QTY_X, top, y3, 0.3);
      vline(AMT_X, top, rR, 0.3);

      /* Rule 96A export undertaking */
      setF('normal', 6.8);
      pdf.text('SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT', FL + 1.7, top + 4.5);
      pdf.text('PAYMENT OF IGST AS PER RULE 96A OF CGST RULES,2017. ARN-DT : 07-09-2019', FL + 1.7, top + 8.5);

      /* weights */
      setF('normal', 6.8);
      pdf.text('NET WEIGHT :', FL + 1.6, top + 14.4);
      pdf.text(inv?.netWeight || '-', FL + 23.1, top + 14.4);
      pdf.text('GROSS WEIGHT :', FL + 63.5, top + 14.4);
      pdf.text(inv?.grossWeight || '-', FL + 88.3, top + 14.4);

      /* amount chargeable + MEIS claim */
      setF('bold', 8.6, [0, 0, 0], 'times');
      pdf.text('Amount Chargeable :', FL + 1.4, y3 + 4.1);
      setF('normal', 6.8, [0, 0, 0], 'times');
      pdf.text('(in Words / currency)', FL + 1.4, y3 + 8.3);
      setF('bold', 8.6, [0, 0, 0], 'times');
      const wordsFit = fitLine(pdf, `USD ${words}`, DESC_R - 43.8 - 2, 8.6, 6.2);
      pdf.setFontSize(wordsFit.size);
      pdf.text(wordsFit.text, 43.8, y3 + 4.2);
      setF('bold', 8.6, [0, 0, 0], 'times');
      pdf.text('We intend to claim rewards under Merchandise Exports from India Scheme', FL + 1.4, y3 + 13.3);
      pdf.text('(MEIS) and Duty Drawback Scheme and RODTEP', FL + 1.4, y3 + 17.3);

      /* bank */
      setF('bold', 7.7, [0, 0, 0], 'times');
      pdf.text(`Bank Name : ${bank.bankName || '-'}. Branch : ${bank.branch || '-'}.`, FL + 1.4, y3 + 21.8);
      pdf.text(`A/c No  : ${bank.accountNumber || '-'}. SWIFT Code : ${bank.swiftCode || '-'}`, FL + 1.4, y3 + 25.5);

      /* declaration */
      setF('bold', 6.8, [0, 0, 0], 'times');
      pdf.text('Declaration :', FL + 1.4, y3 + 29.9);
      setF('normal', 6.0);
      pdf.splitTextToSize(String(inv?.declaration || ''), DESC_R - FL - 3.5).forEach((l, li) => {
        pdf.text(l, FL + 1.4, y3 + 34.1 + li * 3.5);
      });

      /* total value + signature */
      setF('normal', 7.6);
      pdf.text('Total Amount (USD)', AMT_X - 0.5, y3 + 4.3, { align: 'right' });
      setF('bold', 8.6, [0, 0, 0], 'times');
      pdf.text(poMoney(inv?.totals?.amountUSD), FR - 4.3, y3 + 4.2, { align: 'right' });
      setF('bold', 9.1);
      const nameW = pdf.getTextWidth(cname);
      pdf.text(cname, FR - 1.5, FB - 11.5, { align: 'right' });
      const forW = pdf.getTextWidth('For');
      pdf.text('For', FR - 1.5 - nameW - 8 - forW, FB - 11.5);
      return true;
    };

    if (needBreak) {
      pdf.addPage();
      hline(FL, DESC_R, FT + 5, 0.35);
      drawBottom(FT + 5);
    } else {
      drawBottom(bodyEnd);
    }

    return finish();
  } catch (error) {
    console.error('Error generating Export Invoice PDF:', error);
    alert('Error generating Export Invoice PDF. Check console for details.');
    return undefined;
  }
};
