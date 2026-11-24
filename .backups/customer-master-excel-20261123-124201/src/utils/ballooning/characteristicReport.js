import { normalizeCallout } from './calloutFormat.js';

const signedTolerance = (value, sign) => {
  const text = String(value ?? '').trim();
  if (!text || Number.parseFloat(text) === 0) return text;
  if (text.startsWith('+') || text.startsWith('-')) return text;
  return `${sign}${text}`;
};

export const getCharacteristicDisplayValues = (characteristic = {}) => {
  const normalized = normalizeCallout(characteristic);
  return {
    specification:
      characteristic.specification ||
      normalized?.specification ||
      '',
    dimension:
      normalized?.value ||
      characteristic.value ||
      '',
    upperTolerance: signedTolerance(
      normalized?.plusTolerance ?? characteristic.plusTolerance,
      '+'
    ),
    lowerTolerance: signedTolerance(
      normalized?.minusTolerance ?? characteristic.minusTolerance,
      '-'
    ),
    actualMeasurements:
      characteristic.actualValue ??
      characteristic.actualMeasurements ??
      '',
    inspectionResult:
      characteristic.result ??
      characteristic.inspectionResult ??
      ''
  };
};

export const buildCharacteristicReportRows = (characteristics = []) =>
  [...characteristics]
    .sort((a, b) => Number(a.number || 0) - Number(b.number || 0))
    .map((characteristic) => {
      const values = getCharacteristicDisplayValues(characteristic);
      return {
        'Balloon No': characteristic.number ?? '',
        'Dimensions No': values.dimension,
        Description: values.specification,
        'Upper Tolerance': values.upperTolerance,
        'Lower Tolerance': values.lowerTolerance,
        'Actual Measurements': values.actualMeasurements,
        'Inspection Result': values.inspectionResult
      };
    });
