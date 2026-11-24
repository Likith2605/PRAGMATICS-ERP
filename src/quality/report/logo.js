import { NEUTRAL_LOGO_DATA_URI } from "../../utils/companyBranding.js";

async function getLogoDataUri() {
  // Use the logo configured in Company Settings when present. When no logo is
  // uploaded, return a neutral transparent placeholder — never another
  // company's logo. The bundled legacy logo asset is no longer referenced.
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = JSON.parse(localStorage.getItem('companySettings') || '{}');
      const configured = saved && saved.logoDataUrl;
      if (typeof configured === 'string' && /^data:image\//i.test(configured)) return configured;
    }
  } catch { /* fall through to the neutral placeholder */ }
  return NEUTRAL_LOGO_DATA_URI;
}

export {
  getLogoDataUri
};
