import { convertToINR } from './currency.js';

// Shared invoice value helpers (extracted from CustomerInvoicePage.jsx so
// report pages reuse the SAME normalization the Sales Register uses).
// CustomerInvoicePage keeps its local (identical) copies for now; switching
// its import to this module is a safe, behaviour-neutral Phase 3 cleanup.

const parseINR = (v) => Number(String(v || '').replace(/[^0-9.-]/g, '')) || 0;

export const invCurrency = (row) => row?.payload?.invoiceDetails?.currency || row?.currency || 'INR';

export const invTotalINR = (row) => {
  const stored = Number(row?.amountINR);
  if (Number.isFinite(stored) && stored > 0) return stored;
  if (invCurrency(row) !== 'INR') return Number(row?.payload?.amountINR) || 0;
  return parseINR(row?.total);
};

export const invReceivedINR = (row) => {
  const stored = Number(row?.receivedINR);
  if (Number.isFinite(stored) && stored > 0) return stored;
  if (invCurrency(row) !== 'INR') return Number(row?.payload?.receivedINR) || 0;
  return parseINR(row?.status === 'Paid' ? row?.total : row?.amountReceived);
};

export const invBalanceINR = (row) => {
  const stored = Number(row?.balanceINR);
  if (Number.isFinite(stored) && stored > 0) return stored;
  if (invCurrency(row) !== 'INR') return Number(row?.payload?.balanceINR) || 0;
  return parseINR(row?.status === 'Paid' ? 0 : row?.balanceDue);
};

const numericValue = (value) => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

const firstNumericValue = (...values) => {
  for (const value of values) {
    const parsed = numericValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
};

/** Outstanding customer-invoice balance, normalized to INR for dashboard totals. */
export const invReceivableINR = (row) => {
  const payload = row?.payload || {};
  const details = payload.invoiceDetails || {};
  const paymentStatuses = [row?.status, details.paymentStatus].map((status) => String(status || '').trim().toLowerCase());
  if (paymentStatuses.includes('paid')) return 0;

  const storedBalanceINR = firstNumericValue(row?.balanceINR, payload.balanceINR);
  if (storedBalanceINR !== null) {
    // Keep using the shared balance normalizer for the common positive-balance case.
    return storedBalanceINR > 0 ? Math.max(0, invBalanceINR(row)) : 0;
  }

  const currency = details.currency || payload.currency || row?.currency || 'INR';
  const exchangeRate = details.exchangeRate ?? payload.exchangeRate ?? row?.exchangeRate;
  const nativeBalance = firstNumericValue(details.balanceDue, row?.balanceDue);
  if (nativeBalance !== null) {
    if (currency === 'INR') return Math.max(0, nativeBalance);
    // If a saved INR balance exists in the payload, the helper above has already handled it.
    return Math.max(0, convertToINR(nativeBalance, currency, exchangeRate));
  }

  // Legacy invoices may predate the explicit balance fields. Derive their balance
  // from the existing total and receipt fields using the invoice's stored FX rate.
  const storedTotalINR = firstNumericValue(row?.amountINR, payload.amountINR);
  const nativeTotal = firstNumericValue(payload.totals?.grandTotal, row?.total) ?? 0;
  const totalINR = storedTotalINR !== null && storedTotalINR > 0
    ? storedTotalINR
    : convertToINR(nativeTotal, currency, exchangeRate);
  const storedReceivedINR = firstNumericValue(row?.receivedINR, payload.receivedINR);
  const nativeReceived = firstNumericValue(details.amountReceived, row?.amountReceived) ?? 0;
  const receivedINR = storedReceivedINR !== null
    ? storedReceivedINR
    : convertToINR(nativeReceived, currency, exchangeRate);
  return Math.max(0, totalINR - receivedINR);
};
