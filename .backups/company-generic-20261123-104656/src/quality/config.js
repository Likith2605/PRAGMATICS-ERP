// Fallback company name for quality reports. The active report builders use
// the synchronised company settings profile; this only covers callers that do
// not supply a company object.
const readCompanyName = () => {
  try {
    if (typeof localStorage === 'undefined') return '';
    const saved = JSON.parse(localStorage.getItem('companySettings') || '{}');
    return String(saved.companyName || saved.legalName || '').trim();
  } catch {
    return '';
  }
};

const COMPANY_NAME = readCompanyName() || "PRAGMATIC ENGINEERS";
const APP_TITLE = COMPANY_NAME;
const DEFAULT_UNIT = "mm";
export {
  APP_TITLE,
  COMPANY_NAME,
  DEFAULT_UNIT
};
