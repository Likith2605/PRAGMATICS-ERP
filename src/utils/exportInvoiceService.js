/**
 * Export Invoice (Invoice cum Packing List) — export sales document.
 *
 * Fully isolated module with its own localStorage keys; it never touches the
 * shared calculation, wording, backup or any other module. Amounts are in USD
 * and the amount-in-words is rendered plain ("Eight Hundred Fifty Only.")
 * exactly as per the attached export invoice specification.
 */
import { numberToWords } from './numberToWords.js';
import { isAdmin } from './auth.js';
import { getCompanyProfile } from './companyBranding.js';

const HISTORY_KEY = 'exportInvoiceHistory';
const SEQ_KEY = 'exportInvoiceSequence';
const PROFILE_KEY = 'exportCompanyProfile';

const readLS = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const writeLS = (key, value) => localStorage.setItem(key, JSON.stringify(value));

const r2 = (n) => (Number.isFinite(Number(n)) ? Number(Number(n).toFixed(2)) : 0);

/* ------------------------------- static text ------------------------------- */

export const DEFAULT_DECLARATION =
  'We declare that the particulars given above are true and correct and that the items are of Indian origin.';

export const CLAIM_DRAWBACK_LINE = 'We intend to claim rewards under Duty Drawback Scheme.';

export const CLAIM_MEIS_LINE = 'We intend to claim rewards under MEIS / RODTEP scheme.';

export const lutDeclarationText = (lutNumber) =>
  `We have not availed facility of bond under Rule 96A of CGST Rules, 2017 for export of goods / services ` +
  `and we undertake to pay un-utilised Input Tax Credit / accumulated ITC on such supplies before the date ` +
  `of furnishing of statement of outward supplies in FORM GSTR-1 for the month in which the said export ` +
  `supplies are made.${lutNumber ? ` (LUT No. ${lutNumber})` : ''}`;

/* --------------------------------- profile --------------------------------- */

export const DEFAULT_EXPORT_PROFILE = {
  contactPerson: '',
  contactNo: '',
  iecNumber: '',
  lutNumber: '',
  swiftCode: '',
  countryOfOrigin: 'INDIA',
  deliveryTerms: 'Ex-works',
  paymentTerms: 'OTHERS, 30 DAYS'
};

export const getExportProfile = () => ({ ...DEFAULT_EXPORT_PROFILE, ...readLS(PROFILE_KEY, {}) });

export const saveExportProfile = (profile) => {
  const merged = { ...getExportProfile(), ...profile };
  writeLS(PROFILE_KEY, merged);
  return merged;
};

/* -------------------------------- numbering -------------------------------- */

const currentFY = () => {
  const d = new Date();
  const startYear = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  const a = String(startYear % 100).padStart(2, '0');
  const b = String((startYear + 1) % 100).padStart(2, '0');
  return `${a}-${b}`;
};

export const exportInvoiceNumberForSeq = (seq) => `GST/${currentFY()}/${String(seq).padStart(3, '0')}`;

/** The number the next New invoice will get (does not consume the sequence). */
export const previewExportInvoiceNumber = () => exportInvoiceNumberForSeq(Number(readLS(SEQ_KEY, 0)) + 1);

/* --------------------------------- totals ---------------------------------- */

export const computeExportTotals = (items = []) => {
  const rows = (Array.isArray(items) ? items : [])
    .filter((it) => String(it?.description || '').trim())
    .map((it) => {
      const quantity = Number(it.quantity) || 0;
      const rate = Number(it.rate) || 0;
      return { ...it, quantity, rate, amount: r2(quantity * rate) };
    });
  const amountUSD = r2(rows.reduce((sum, row) => sum + row.amount, 0));
  return { rows, amountUSD };
};

/** "Eight Hundred Fifty Only." — plain words as per the export invoice format. */
export const usdAmountInWords = (value) => {
  const words = numberToWords(value);
  const clean = words.replace(/ Rupees and /, ' and ').replace(/ Rupees$/, '').trim();
  return `${clean || 'Zero'} Only.`;
};

/* ------------------------------- validation -------------------------------- */

export const validateExportInvoice = (data = {}) => {
  if (!String(data.invoiceNumber || '').trim()) throw new Error('Invoice Number is required.');
  if (!String(data.invoiceDate || '').trim()) throw new Error('Invoice Date is required.');
  if (!String(data.buyer?.name || data.buyerName || '').trim()) throw new Error('Buyer (Bill To) name is required.');
  const items = computeExportTotals(data.items || []).rows;
  if (items.length === 0) throw new Error('Add at least one item with a description.');
  return true;
};

/* ---------------------------------- CRUD ----------------------------------- */

const buildPayload = (data) => {
  const { rows, amountUSD } = computeExportTotals(data.items || []);
  const profile = getExportProfile();
  const company = getCompanyProfile();
  const bank = company.bankDetails || {};

  return {
    invoiceNumber: String(data.invoiceNumber || '').trim(),
    invoiceDate: data.invoiceDate || '',
    exporterRef: data.exporterRef || '',
    buyersOrderNo: data.buyersOrderNo || '',
    buyersOrderDate: data.buyersOrderDate || '',
    buyer: {
      name: String(data.buyer?.name || data.buyerName || '').trim(),
      address: data.buyer?.address || data.buyerAddress || '',
      contactPerson: data.buyer?.contactPerson || '',
      contactNo: data.buyer?.contactNo || ''
    },
    shipToAddress: data.shipToAddress || '',
    logistics: {
      preCarriage: data.logistics?.preCarriage || '',
      placeOfReceipt: data.logistics?.placeOfReceipt || '',
      portOfLoading: data.logistics?.portOfLoading || '',
      finalDestination: data.logistics?.finalDestination || '',
      vesselFlight: data.logistics?.vesselFlight || '',
      portOfDischarge: data.logistics?.portOfDischarge || '',
      marksNumbers: data.logistics?.marksNumbers || '',
      containerNo: data.logistics?.containerNo || '',
      otherReferences: data.logistics?.otherReferences || ''
    },
    countryOfOrigin: data.countryOfOrigin || profile.countryOfOrigin,
    countryOfDestination: data.countryOfDestination || '',
    termsOfDelivery: data.termsOfDelivery || profile.deliveryTerms,
    paymentTerms: data.paymentTerms || profile.paymentTerms,
    items: rows,
    netWeight: data.netWeight || '',
    grossWeight: data.grossWeight || '',
    declaration: data.declaration || DEFAULT_DECLARATION,
    companyDetails: {
      companyName: company.companyName || '',
      address: company.address || '',
      email: company.email || '',
      phone: company.phone || '',
      gstin: company.gstin || '',
      pan: company.pan || ''
    },
    exportProfile: {
      contactPerson: profile.contactPerson,
      contactNo: profile.contactNo,
      iecNumber: profile.iecNumber,
      lutNumber: profile.lutNumber
    },
    bankDetails: {
      bankName: bank.bankName || '',
      branch: bank.branch || '',
      accountNumber: bank.accountNumber || '',
      swiftCode: data.swiftCode !== undefined ? data.swiftCode : profile.swiftCode
    },
    totals: { amountUSD },
    amountInWords: usdAmountInWords(amountUSD),
    status: data.status || 'Draft',
    /* reference chain of the source document (e.g. Sales Order → Export Invoice) */
    source: data.source || null
  };
};

export const createExportInvoice = (data = {}) => {
  validateExportInvoice(data);
  const seq = Number(readLS(SEQ_KEY, 0)) + 1;
  const payload = buildPayload({ ...data, invoiceNumber: data.invoiceNumber || exportInvoiceNumberForSeq(seq) });
  const reference = payload.invoiceNumber;

  const list = listExportInvoices();
  if (list.some((i) => String(i.reference) === String(reference)))
    throw new Error(`Export Invoice ${reference} already exists.`);

  writeLS(SEQ_KEY, seq);
  const entry = {
    reference,
    date: payload.invoiceDate,
    buyer: payload.buyer.name,
    status: payload.status,
    payload,
    createdAt: new Date().toISOString()
  };
  writeLS(HISTORY_KEY, [entry, ...list]);
  return entry;
};

export const updateExportInvoice = (reference, data = {}) => {
  validateExportInvoice(data);
  const list = listExportInvoices();
  const idx = list.findIndex((i) => String(i.reference) === String(reference));
  if (idx === -1) throw new Error(`Export Invoice ${reference} not found.`);

  const payload = buildPayload({ ...data, invoiceNumber: data.invoiceNumber || reference });
  if (String(payload.invoiceNumber) !== String(reference)) {
    if (list.some((i) => String(i.reference) === String(payload.invoiceNumber)))
      throw new Error(`Export Invoice ${payload.invoiceNumber} already exists.`);
  }

  const entry = {
    ...list[idx],
    reference: payload.invoiceNumber,
    date: payload.invoiceDate,
    buyer: payload.buyer.name,
    status: payload.status,
    payload,
    updatedAt: new Date().toISOString()
  };
  list[idx] = entry;
  writeLS(HISTORY_KEY, list);
  return entry;
};

export const getExportInvoice = (reference) =>
  listExportInvoices().find((i) => String(i.reference) === String(reference)) || null;

export const deleteExportInvoice = (reference) => {
  throw new Error('Export invoices must be cancelled through the controlled workflow; permanent deletion is not permitted.');
};

export const cancelExportInvoice = (reference, reason) => {
  if (!isAdmin()) throw new Error('Permission denied: only an Admin can cancel an Export Invoice.');
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) throw new Error('A cancellation reason is required.');
  const list = listExportInvoices();
  const index = list.findIndex((entry) => String(entry.reference) === String(reference));
  if (index < 0) throw new Error(`Export Invoice ${reference} not found.`);
  if (list[index].status === 'Cancelled') throw new Error('This Export Invoice is already cancelled.');
  list[index] = { ...list[index], status: 'Cancelled', cancelReason: cleanReason, updatedAt: new Date().toISOString() };
  writeLS(HISTORY_KEY, list);
  try {
    const reasons = JSON.parse(localStorage.getItem('erp_state_action_reasons') || '{}');
    reasons[HISTORY_KEY] = cleanReason;
    localStorage.setItem('erp_state_action_reasons', JSON.stringify(reasons));
  } catch { /* sync will request the reason again */ }
  return list[index];
};

export const listExportInvoices = () => {
  const list = readLS(HISTORY_KEY, []);
  return Array.isArray(list) ? list : [];
};
