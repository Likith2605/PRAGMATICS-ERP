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
