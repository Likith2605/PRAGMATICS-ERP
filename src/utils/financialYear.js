/**
 * Financial Year utility functions for the ERP.
 * Standard Indian Financial Year: April 1st to March 31st.
 */

export const getFinancialYearInfo = (dateInput = new Date()) => {
  let validDate = new Date(dateInput);
  if (isNaN(validDate.getTime())) {
    validDate = new Date();
  }

  const month = validDate.getMonth(); // 0 = Jan, 1 = Feb, 2 = Mar, 3 = Apr ... 11 = Dec
  const fullYear = validDate.getFullYear();

  // If month is April (3) or later, FY starts this calendar year.
  // If month is Jan-Mar (0-2), FY started previous calendar year.
  const startYear = month >= 3 ? fullYear : fullYear - 1;
  const endYear = startYear + 1;

  const startYearShort = String(startYear).slice(-2);
  const endYearShort = String(endYear).slice(-2);

  return {
    startYear,
    endYear,
    fyCode: `${startYear}-${endYearShort}`,       // e.g. "2026-27"
    fyShort: `${startYearShort}-${endYearShort}`, // e.g. "26-27"
    fyCompact: `${startYearShort}${endYearShort}`,// e.g. "2627"
    fyLabel: `FY ${startYear}-${endYearShort}`,   // e.g. "FY 2026-27"
    startDate: `${startYear}-04-01`,
    endDate: `${endYear}-03-31`
  };
};

/**
 * Returns formatted Project ID for a given sequence number and date based on Financial Year.
 * E.g., for seq 8 in FY 2026-27 -> "PE-2627-0008" (or "PE-2026-27-0008")
 */
export const formatFYProjectId = (seq, dateInput = new Date()) => {
  const { fyCompact } = getFinancialYearInfo(dateInput);
  return `PE-${fyCompact}-${String(seq).padStart(4, '0')}`;
};

/**
 * Helper to get the Financial Year label from any date string
 */
export const getFYLabelFromDate = (dateStr) => {
  if (!dateStr) return getFinancialYearInfo().fyLabel;
  return getFinancialYearInfo(dateStr).fyLabel;
};
