/**
 * Flat, duplicate-safe sequential number generator for the Warehouse / Store module.
 * Numbers look like MR-000001, SI-000458, SR-000125, PR-000125.
 * It scans both a stored counter and the history key so no number is ever reused,
 * even if records are deleted or the counter is lost.
 */

export const generateSequentialNumber = ({
  prefix = 'MR',
  sequenceKey,
  historyKey,
  idField = 'mrNumber',
  pad = 6
}) => {
  let maxSeq = 0;

  try {
    const stored = Number(localStorage.getItem(sequenceKey) || 0);
    if (!Number.isNaN(stored) && stored > maxSeq) maxSeq = stored;
  } catch (err) {
    console.error(`storeSequencer(${prefix}): counter read failed`, err);
  }

  if (historyKey) {
    try {
      const history = JSON.parse(localStorage.getItem(historyKey) || '[]');
      if (Array.isArray(history)) {
        history.forEach((item) => {
          const value = item?.[idField] || item?.id || item?.reference;
          if (!value) return;
          const m = String(value).match(/(\d+)\s*$/);
          if (m) {
            const n = parseInt(m[1], 10);
            if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
          }
        });
      }
    } catch (err) {
      console.error(`storeSequencer(${prefix}): history scan failed`, err);
    }
  }

  const next = maxSeq + 1;
  return `${prefix}-${String(next).padStart(pad, '0')}`;
};

export const saveSequenceCounter = (sequenceKey, number) => {
  if (!number) return;
  const m = String(number).match(/(\d+)\s*$/);
  if (!m) return;
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n)) return;
  try {
    const existing = Number(localStorage.getItem(sequenceKey) || 0);
    if (n > existing) localStorage.setItem(sequenceKey, String(n));
  } catch (err) {
    console.error(`storeSequencer: counter save failed`, err);
  }
};

export const readCounter = (sequenceKey) => {
  try {
    return Number(localStorage.getItem(sequenceKey) || 0);
  } catch {
    return 0;
  }
};