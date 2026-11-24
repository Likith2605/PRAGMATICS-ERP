import { LOGO_DATA_URI } from "./logoDataUri.js";

async function getLogoDataUri() {
  // Use the logo configured in Company Settings when present. The bundled
  // logo remains the fallback so reports still render with no configuration.
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = JSON.parse(localStorage.getItem('companySettings') || '{}');
      const configured = saved && saved.logoDataUrl;
      if (typeof configured === 'string' && /^data:image\//i.test(configured)) return configured;
    }
  } catch { /* fall through to the bundled logo */ }
  return LOGO_DATA_URI;
}

export {
  getLogoDataUri
};
