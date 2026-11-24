import { getFinancialYearInfo } from './financialYear.js';

export const getNextSequentialNumber = (prefix, sequenceKey, historyKey, idField, dateInput = new Date()) => {
  const { fyCompact, startYear } = getFinancialYearInfo(dateInput);
  let maxSeq = 0;

  try {
    // 1. Check stored sequence counter
    const stored = Number(localStorage.getItem(sequenceKey) || 0);
    if (!isNaN(stored) && stored > maxSeq) {
      maxSeq = stored;
    }

    // 2. Scan history array to prevent duplicate IDs
    if (historyKey) {
      const history = JSON.parse(localStorage.getItem(historyKey) || '[]');
      if (Array.isArray(history)) {
        history.forEach((item) => {
          const val = item?.[idField] || item?.id || item?.reference;
          if (typeof val === 'string') {
            const match = val.match(/(\d+)$/);
            if (match) {
              const num = parseInt(match[1], 10);
              if (!isNaN(num) && num > maxSeq) {
                maxSeq = num;
              }
            }
          }
        });
      }
    }
  } catch (err) {
    console.error(`Error calculating sequence for ${prefix}:`, err);
  }

  const nextSeq = maxSeq + 1;
  return `${prefix}-${fyCompact}-${String(nextSeq).padStart(4, '0')}`;
};

export const getNextQuotationNumber = () => {
  const year = new Date().getFullYear();
  let maxSeq = 0;

  try {
    const stored = Number(localStorage.getItem('quotationSequence') || 0);
    if (!isNaN(stored) && stored > maxSeq) {
      maxSeq = stored;
    }

    const history = JSON.parse(localStorage.getItem('quotationHistory') || '[]');
    if (Array.isArray(history)) {
      history.forEach((item) => {
        const val = item?.quotationNumber || item?.reference || item?.payload?.quotationDetails?.quotationNumber;
        if (typeof val === 'string') {
          const matchQT = val.match(/^QT\d{4}(\d+)$/i);
          if (matchQT) {
            const num = parseInt(matchQT[1], 10);
            if (!isNaN(num) && num > maxSeq) maxSeq = num;
          } else {
            const match = val.match(/(\d+)$/);
            if (match) {
              const num = parseInt(match[1], 10);
              if (!isNaN(num) && num > maxSeq && num < 1000) maxSeq = num;
            }
          }
        }
      });
    }
  } catch (err) {
    console.error('Error calculating quotation sequence:', err);
  }

  const nextSeq = maxSeq + 1;
  const paddedSeq = String(nextSeq).padStart(2, '0');
  return `QT${year}${paddedSeq}`;
};

export const saveDocSequence = (sequenceKey, currentNumber) => {
  if (!currentNumber) return;
  try {
    const matchQT = String(currentNumber).match(/^QT\d{4}(\d+)$/i);
    let num = 0;
    if (matchQT) {
      num = parseInt(matchQT[1], 10);
    } else {
      const match = String(currentNumber).match(/(\d+)$/);
      if (match) num = parseInt(match[1], 10);
    }

    if (num > 0) {
      const existing = Number(localStorage.getItem(sequenceKey) || 0);
      if (!isNaN(num) && num >= existing) {
        localStorage.setItem(sequenceKey, String(num));
      }
    }
  } catch (err) {
    console.error(`Error saving sequence for ${sequenceKey}:`, err);
  }
};
