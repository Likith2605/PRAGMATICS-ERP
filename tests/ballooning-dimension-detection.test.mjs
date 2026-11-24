import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import * as autoTableModule from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import {
  normalizeCallout,
  parseCalloutText
} from '../src/utils/ballooning/calloutFormat.js';
import {
  describeDimensionPosition,
  rankDimensionCandidates
} from '../src/utils/ballooning/dimensionCandidateReview.js';
import { buildCharacteristicReportRows } from '../src/utils/ballooning/characteristicReport.js';

const notations = [
  ['25', 25, 'Dimension'],
  ['25.50', 25.5, 'Dimension'],
  ['Ø25', 25, 'Diameter'],
  ['R12', 12, 'Radius'],
  ['25 ±0.05', 25, 'Dimension'],
  ['25 +0.02/-0.01', 25, 'Dimension'],
  ['25 +0.02', 25, 'Dimension'],
  ['25 -0.01', 25, 'Dimension'],
  ['45°', 45, 'Angle'],
  ['M10', 10, 'Thread'],
  ['4 × Ø8', 8, 'Diameter']
];

for (const [notation, nominal, type] of notations) {
  const parsed = parseCalloutText(notation);
  const normalized = normalizeCallout({
    specification: notation,
    value: notation
  }, { prefer: 'spec' });
  assert.equal(parsed.confident, true, `${notation} should parse confidently`);
  assert.equal(parsed.nominalNum, nominal, `${notation} nominal`);
  assert.equal(normalized.type, type, `${notation} type`);
  assert.ok(normalized.value.includes(type === 'Diameter' ? 'Ø' : type === 'Radius' ? 'R' : type === 'Thread' ? 'M' : type === 'Angle' ? '°' : String(nominal)),
    `${notation} keeps its engineering notation`);
}

const bilateral = normalizeCallout({
  specification: '25 +0.02/-0.01',
  value: '25'
}, { prefer: 'spec' });
assert.equal(bilateral.plusTolerance, '0.02');
assert.equal(bilateral.minusTolerance, '0.01');
assert.equal(bilateral.upperLimit, '25.02');
assert.equal(bilateral.lowerLimit, '24.99');

const symmetric = normalizeCallout({
  specification: '25 ±0.05',
  value: '25'
}, { prefer: 'spec' });
assert.equal(symmetric.plusTolerance, '0.05');
assert.equal(symmetric.minusTolerance, '0.05');

const clearMatch = rankDimensionCandidates([
  {
    text: 'Ø25',
    specification: 'Ø25',
    source: 'pdf',
    score: 300,
    distance: 4,
    centerX: 100,
    centerY: 100,
    width: 24,
    height: 12
  }
]);
assert.equal(clearMatch.requiresConfirmation, false);

const nearbyMatches = rankDimensionCandidates([
  {
    text: '25',
    specification: '25',
    source: 'pdf',
    score: 210,
    distance: 22,
    centerX: 100,
    centerY: 100,
    width: 18,
    height: 12
  },
  {
    text: '45°',
    specification: '45°',
    source: 'pdf',
    score: 190,
    distance: 28,
    centerX: 122,
    centerY: 100,
    width: 22,
    height: 12
  }
]);
assert.equal(nearbyMatches.requiresConfirmation, true);
assert.equal(nearbyMatches.candidates.length, 2);
assert.equal(
  describeDimensionPosition(nearbyMatches.candidates[1], {
    x1: 100,
    y1: 100,
    x2: 100,
    y2: 100
  }),
  'right of mark (22 px)'
);

const repeatedValues = rankDimensionCandidates([
  {
    text: '25',
    specification: '25',
    source: 'pdf',
    score: 205,
    centerX: 100,
    centerY: 100
  },
  {
    text: '25',
    specification: '25',
    source: 'pdf',
    score: 195,
    centerX: 122,
    centerY: 100
  }
]);
assert.equal(repeatedValues.candidates.length, 2);
assert.equal(repeatedValues.requiresConfirmation, true);

const lowConfidence = rankDimensionCandidates([
  {
    text: 'R12',
    specification: 'R12',
    source: 'ocr-normal',
    score: 240,
    confidence: 42,
    centerX: 100,
    centerY: 100
  }
]);
assert.equal(lowConfidence.requiresConfirmation, true);

const duplicateReading = rankDimensionCandidates([
  {
    text: 'Ø25',
    specification: 'Ø25',
    rawText: 'Ø25',
    source: 'ocr-normal',
    score: 220,
    confidence: 92,
    centerX: 100,
    centerY: 100
  },
  {
    text: 'Ø25',
    specification: 'Ø25',
    rawText: 'Ø25',
    source: 'ocr-cw90',
    score: 210,
    confidence: 90,
    centerX: 101,
    centerY: 101
  }
]);
assert.equal(duplicateReading.candidates.length, 1);
assert.equal(duplicateReading.requiresConfirmation, false);

const characteristics = [
  {
    number: 2,
    value: '4 × Ø 8',
    specification: '4 × Ø8',
    plusTolerance: '0.02',
    minusTolerance: '0.01',
    actualValue: '8.005',
    result: 'PASS'
  },
  {
    number: 1,
    value: '25',
    specification: '25 +0.02/-0.01',
    plusTolerance: '0.02',
    minusTolerance: '0.01',
    actualValue: '25.03',
    result: 'FAIL'
  }
];
const reportRows = buildCharacteristicReportRows(characteristics);
assert.deepEqual(reportRows.map((row) => row['Balloon No']), [1, 2]);
assert.equal(reportRows[0]['Dimensions No'], '25');
assert.equal(reportRows[0].Description, '25 +0.02/-0.01');
assert.equal(reportRows[0]['Upper Tolerance'], '+0.02');
assert.equal(reportRows[0]['Lower Tolerance'], '-0.01');
assert.equal(reportRows[0]['Actual Measurements'], '25.03');
assert.equal(reportRows[0]['Inspection Result'], 'FAIL');
assert.equal(reportRows[1]['Dimensions No'], '4 × Ø 8');

const worksheet = XLSX.utils.json_to_sheet(reportRows);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, worksheet, 'Characteristics');
const workbookCopy = XLSX.read(
  XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }),
  { type: 'array' }
);
const excelRows = XLSX.utils.sheet_to_json(
  workbookCopy.Sheets.Characteristics
);
assert.deepEqual(excelRows, reportRows);

const pdf = new jsPDF();
autoTableModule.default.default(pdf, {
  head: [Object.keys(reportRows[0])],
  body: reportRows.map((row) => Object.values(row)),
  styles: { fontSize: 8, cellPadding: 2, halign: 'left', overflow: 'linebreak' }
});
const pdfOutput = pdf.output();
for (const value of [
  '4 × Ø 8',
  '25 +0.02/-0.01',
  '+0.02',
  '-0.01',
  '25.03',
  'FAIL',
  'PASS'
]) {
  assert.ok(pdfOutput.includes(value), `PDF contains ${value}`);
}

console.log('Ballooning dimension detection and characteristic export tests passed.');
