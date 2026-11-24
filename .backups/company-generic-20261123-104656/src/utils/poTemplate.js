/**
 * Purchase Order template helpers for the "PO to Supplier" format:
 *   - packing charges / freight added at PO level (never inside the shared
 *     calculateTotals used by every other document)
 *   - CGST / SGST shown as split rows with the effective half-rate
 *   - amount in words rendered as "Rs. ... Only."
 */
import { numberToWords } from './numberToWords.js';

const r2 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
};

/**
 * Build the PO-level totals block from the shared totals plus the PO-only
 * charges (packing / freight). Works for legacy POs (missing fields => 0).
 */
export const computePOTotals = (totals = {}, poDetails = {}) => {
  const taxableAmount = r2(totals.taxableAmount);
  const packingCharges = r2(poDetails.packingCharges);
  const freight = r2(poDetails.freight);
  const cgst = r2(totals.cgst);
  const sgst = r2(totals.sgst);
  const subTotal = r2(taxableAmount + packingCharges);
  const grandTotal = r2(subTotal + cgst + sgst + freight);
  /* effective half-rate (18% GST => CGST @ 9%) for the split rows */
  const gstRate = taxableAmount > 0 ? Number(((r2(totals.totalGST) / taxableAmount) * 50).toFixed(2)) : 0;

  return {
    totalAmount: r2(totals.subtotal),
    discount: r2(totals.discount),
    taxableAmount,
    packingCharges,
    subTotal,
    totalGST: r2(totals.totalGST),
    cgst,
    sgst,
    gstRate,
    freight,
    grandTotal
  };
};

/** "Rs. Nineteen Thousand Eight Hundred Eighty Three Only." */
export const poAmountInWords = (value) => {
  const words = numberToWords(value);
  const clean = words
    .replace(/ Rupees and /, ' and ')
    .replace(/ Rupees$/, '');
  return `Rs. ${clean} Only.`;
};
