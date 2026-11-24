/*
 * Helpers for sharing generated ballooning output (ballooned PDF + inspection
 * Excel) from the browser.
 *
 * Email goes through the small Express/nodemailer server in `server.js`
 * (default http://localhost:3001), which now accepts an array of attachments.
 *
 * WhatsApp uses the Web Share API when the browser supports sharing files -
 * that is the only way to actually attach a file to WhatsApp from a web page.
 * Desktop browsers do not implement it and `wa.me` links are text only, so we
 * fall back to downloading both files and opening WhatsApp with a message that
 * tells the user to attach them.
 */

export const EMAIL_API_URL = 'http://localhost:3001';

export const PDF_MIME = 'application/pdf';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });

export const saveBlob = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const canShareFiles = (files) => {
  if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
  try {
    return navigator.canShare({ files });
  } catch {
    return false;
  }
};

/* 'shared' | 'unsupported' | 'cancelled' | 'failed' */
export const shareFiles = async ({ files, title, text }) => {
  if (!canShareFiles(files)) return 'unsupported';
  try {
    await navigator.share({ files, title, text });
    return 'shared';
  } catch (err) {
    const name = err && err.name;
    if (name === 'AbortError' || name === 'NotAllowedError') return 'cancelled';
    return 'failed';
  }
};

export const openWhatsApp = ({ phone = '', text = '' }) => {
  const digits = String(phone).replace(/\D/g, '');
  const url = digits
    ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
    : `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener');
};

/* WhatsApp Web in a new tab. Falls back to the chat list when no number is known. */
export const openWhatsAppWeb = ({ phone = '', text = '' }) => {
  const digits = String(phone).replace(/\D/g, '');
  const url = digits
    ? `https://web.whatsapp.com/send?phone=${digits}&text=${encodeURIComponent(text)}`
    : 'https://web.whatsapp.com/';
  window.open(url, '_blank', 'noopener');
  return url;
};

/*
 * Opens Gmail's compose window in a new tab with subject and body prefilled.
 *
 * A `mailto:` link is not a page: opened with target="_blank" the browser
 * creates a tab it has nothing to render, so you get a blank "Untitled" tab.
 * Gmail's compose deep link is a real page, so that is what we navigate to.
 * Files are not and cannot be pre-attached - they are downloaded first and
 * the user attaches them here.
 */
export const openWebmail = ({ to = '', cc = '', subject = '', body = '' }) => {
  const url = new URL('https://mail.google.com/mail/u/0/');
  const params = url.searchParams;

  if (String(to).trim()) params.set('to', String(to).trim());
  if (String(cc).trim()) params.set('cc', String(cc).trim());
  params.set('su', subject || '');
  params.set('body', body || '');
  params.set('tf', 'cm');

  const target = url.toString();
  window.open(target, '_blank', 'noopener');
  return target;
};

export const sendEmailWithAttachments = async ({
  to,
  cc = '',
  bcc = '',
  subject = '',
  body = '',
  attachments = [],
  apiUrl = EMAIL_API_URL
}) => {
  if (!to || !String(to).trim()) throw new Error('Recipient email address is required.');
  if (!attachments.length) throw new Error('There is nothing to attach.');

  let response;
  try {
    response = await fetch(`${apiUrl}/api/send-quotation-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: String(to).trim(),
        cc: String(cc).trim() || undefined,
        bcc: String(bcc).trim() || undefined,
        subject,
        htmlBody: body,
        attachments: await Promise.all(
          attachments.map(async (item) => ({
            fileName: item.fileName,
            contentType: item.contentType,
            contentBase64: await blobToBase64(item.blob)
          }))
        )
      })
    });
  } catch {
    throw new Error(
      `Could not reach the email server at ${apiUrl}. Start it with "npm run server" and try again.`
    );
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.error || 'Failed to send the email.');
  }
  return data;
};
