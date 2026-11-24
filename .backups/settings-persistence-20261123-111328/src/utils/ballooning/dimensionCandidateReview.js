const candidateText = (candidate) =>
  String(candidate.specification || candidate.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleUpperCase();

const candidateCenter = (candidate) => ({
  x: Number(candidate.centerX),
  y: Number(candidate.centerY)
});

const sameReading = (left, right) => {
  if (candidateText(left) !== candidateText(right)) return false;

  const a = candidateCenter(left);
  const b = candidateCenter(right);
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return false;

  const nearDistance = Math.hypot(a.x - b.x, a.y - b.y);
  const leftIsOcr = String(left.source || '').startsWith('ocr');
  const rightIsOcr = String(right.source || '').startsWith('ocr');
  if (!leftIsOcr && !rightIsOcr) return false;

  const samePass = left.source === right.source;
  const sameRawText = String(left.rawText || '') === String(right.rawText || '');
  return samePass && sameRawText
    ? nearDistance <= 2
    : nearDistance <= 8;
};

const candidateConfidence = (candidate) => {
  if (candidate.source === 'pdf') return 100;
  return Number(candidate.confidence ?? candidate.ocrConfidence ?? 0);
};

export const rankDimensionCandidates = (
  candidates,
  {
    ambiguityScoreGap = 35,
    lowConfidenceThreshold = 60,
    maxCandidates = 5
  } = {}
) => {
  const unique = [];

  for (const candidate of [...(candidates || [])].sort(
    (a, b) => Number(b.score || 0) - Number(a.score || 0)
  )) {
    const duplicate = unique.find((existing) =>
      sameReading(existing, candidate)
    );
    if (!duplicate) unique.push(candidate);
  }

  const ranked = unique
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, maxCandidates)
    .map((candidate, index) => ({
      ...candidate,
      candidateId:
        candidate.candidateId ||
        `dimension-${index}-${Math.round(Number(candidate.centerX) || 0)}-${Math.round(Number(candidate.centerY) || 0)}-${candidateText(candidate)}`
    }));

  const best = ranked[0];
  const runnerUp = ranked[1];
  const lowConfidence = best
    ? best.needsVerification ||
      (String(best.source || '').startsWith('ocr') &&
        candidateConfidence(best) < lowConfidenceThreshold)
    : false;
  const closeAlternative =
    !!runnerUp &&
    Number(best.score || 0) - Number(runnerUp.score || 0) <=
      ambiguityScoreGap;

  return {
    candidates: ranked,
    requiresConfirmation: Boolean(best && (lowConfidence || closeAlternative))
  };
};

export const describeDimensionPosition = (candidate, rect) => {
  const centerX = Number(candidate.centerX);
  const centerY = Number(candidate.centerY);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
    return 'position unavailable';
  }

  const markX = (Number(rect.x1) + Number(rect.x2)) / 2;
  const markY = (Number(rect.y1) + Number(rect.y2)) / 2;
  const deltaX = centerX - markX;
  const deltaY = centerY - markY;
  const horizontal =
    Math.abs(deltaX) < 8 ? '' : deltaX < 0 ? 'left' : 'right';
  const vertical =
    Math.abs(deltaY) < 8 ? '' : deltaY < 0 ? 'above' : 'below';
  const relation = [vertical, horizontal].filter(Boolean).join('-') || 'at mark';
  const distance = Math.round(Math.hypot(deltaX, deltaY));
  return distance && relation !== 'at mark'
    ? `${relation} of mark (${distance} px)`
    : 'at mark';
};
