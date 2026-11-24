export const calculateLineAmount = (quantity, unitPrice) => {
  const amount = Number(quantity) * Number(unitPrice);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
};

export const calculateGSTAmount = (amount, gstPercent) => {
  const gstValue = (Number(amount) * Number(gstPercent)) / 100;
  return Number.isFinite(gstValue) ? Number(gstValue.toFixed(2)) : 0;
};

export const TAX_MODES = {
  intra: 'intra',
  inter: 'inter',
  export: 'export'
};

export const calculateTotals = (items, discount = 0, taxMode = 'intra') => {
  const subtotal = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const discountValue = Number(discount) || 0;
  const taxableAmount = Math.max(0, subtotal - discountValue);
  
  const discountRatio = subtotal > 0 ? taxableAmount / subtotal : 1;
  const grossGST = items.reduce((sum, item) => sum + Number(item.gstAmount || 0), 0) * discountRatio;

  const mode = TAX_MODES[taxMode] || TAX_MODES.intra;
  const totalGST = mode === TAX_MODES.export ? 0 : grossGST;
  const igst = mode === TAX_MODES.inter ? totalGST : 0;
  const cgst = mode === TAX_MODES.intra ? Number((totalGST / 2).toFixed(2)) : 0;
  const sgst = mode === TAX_MODES.intra ? Number((totalGST / 2).toFixed(2)) : 0;
  const grandTotal = Number((taxableAmount + totalGST).toFixed(2));

  return {
    subtotal: Number(subtotal.toFixed(2)),
    discount: Number(discountValue.toFixed(2)),
    taxableAmount: Number(taxableAmount.toFixed(2)),
    totalGST,
    cgst,
    sgst,
    igst,
    taxMode: mode,
    grandTotal
  };
};
