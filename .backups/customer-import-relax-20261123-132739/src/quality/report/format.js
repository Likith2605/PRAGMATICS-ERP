function fmt(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "-";
  }
  let s = n.toFixed(digits).replace(/\.?0+$/, "");
  if (n === 0) {
    s = s.replace("-0", "0");
  }
  return s;
}
function fmtSigned(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "-";
  }
  return (n < 0 ? "" : "+") + fmt(n, digits);
}
function normalizedTolerances(tolUpper, tolLower) {
  return {
    upper: Number(tolUpper) || 0,
    lower: Number(tolLower) || 0
  };
}
function limits(nominal, tolUpper, tolLower) {
  const n = Number(nominal) || 0;
  const upperValue = Number(tolUpper) || 0;
  const lowerValue = Number(tolLower) || 0;
  if (upperValue > 0 && lowerValue > 0) {
    return {
      min: n,
      max: n + Math.max(upperValue, lowerValue)
    };
  }
  if (upperValue < 0 && lowerValue < 0) {
    return {
      min: n + Math.min(upperValue, lowerValue),
      max: n
    };
  }
  return {
    min: n + Math.min(upperValue, lowerValue),
    max: n + Math.max(upperValue, lowerValue)
  };
}
function isInTolerance(actual, nominal, tolUpper, tolLower) {
  const { min, max } = limits(nominal, tolUpper, tolLower);
  const EPS = 1e-9;
  return actual >= min - EPS && actual <= max + EPS;
}
function toleranceText(tolUpper, tolLower, digits = 3) {
  const upper = Number(tolUpper) || 0;
  const lower = Number(tolLower) || 0;
  if (upper === -lower) {
    return `± ${fmt(Math.abs(upper), digits)}`;
  }
  return `${fmtSigned(upper, digits)} / ${fmtSigned(lower, digits)}`;
}
function formatDate(iso) {
  return iso.replace("T", " ");
}
function samplesOf(row) {
  return [row.sample1, row.sample2, row.sample3, row.sample4, row.sample5, row.sample6, row.sample7, row.sample8, row.sample9, row.sample10];
}
function isSampleSet(value) {
  return value !== null && Number.isFinite(value);
}
function isNumericSpec(text) {
  const t = text.trim();
  if (t === "") return false;
  const n = Number(t);
  return Number.isFinite(n);
}
function parseStatuses(raw, count) {
  const parts = raw ? raw.split("|") : [];
  const result = [];
  for (let i = 0; i < count; i++) {
    const val = (parts[i] ?? "").trim();
    result.push(val === "OK" || val === "NOT OK" ? val : "");
  }
  return result;
}
function statusesPass(statuses) {
  const filled = statuses.filter((s) => s === "OK" || s === "NOT OK");
  return filled.length > 0 && filled.every((s) => s === "OK");
}
export {
  fmt,
  fmtSigned,
  formatDate,
  isInTolerance,
  isNumericSpec,
  isSampleSet,
  limits,
  normalizedTolerances,
  parseStatuses,
  samplesOf,
  statusesPass,
  toleranceText
};
