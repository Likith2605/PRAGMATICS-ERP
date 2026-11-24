export const getNextBalloonNumber = (balloons) => (balloons.length ? Math.max(...balloons.map((b) => b.number)) + 1 : 1);

export const calculateResult = (actual, lower, upper) => {
  const numeric = Number(actual);
  if (Number.isNaN(numeric)) return 'NOT INSPECTED';
  if (numeric >= Number(lower) && numeric <= Number(upper)) return 'PASS';
  return 'FAIL';
};

/*
  Drawing number for a stored drawing.

  Uploads made before the Enquiry link existed never stored a drawingNo -
  for those the file name IS the drawing number ("NA98N8.pdf" → "NA98N8").
  An explicitly linked drawingNo always wins.
*/
export const drawingNumberFor = (drawing) => {
  const explicit = String(drawing?.drawingNo || '').trim();
  if (explicit) return explicit;

  const fileName = String(drawing?.fileName || '').trim();
  if (!fileName) return '';

  return fileName.replace(/\.[^.]+$/, '').trim();
};
