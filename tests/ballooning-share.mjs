/*
 * Tests for ballooning share (ballooned PDF + inspection Excel together).
 *   node --test "tests/ballooning-share.mjs"
 */
import test from 'node:test';
import assert from 'node:assert';
import nodemailer from 'nodemailer';

// Node has Blob/File but not FileReader, so shim the small slice we use.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
        this.onload?.();
      });
    }
  };
}

const {
  blobToBase64,
  canShareFiles,
  shareFiles,
  openWhatsApp,
  openWhatsAppWeb,
  openWebmail,
  saveBlob,
  PDF_MIME,
  XLSX_MIME
} = await import('../src/utils/ballooning/shareExport.js');

const withNavigator = (value, fn) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (value === undefined) delete globalThis.navigator;
  else Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
};

const PDF_BYTES = Buffer.from('%PDF-1.4 fake pdf payload');
const XLSX_BYTES = Buffer.from('PK fake xlsx payload');

test('blobToBase64 returns clean base64 with no data URL prefix', async () => {
  const b64 = await blobToBase64(new Blob([PDF_BYTES], { type: PDF_MIME }));
  assert.ok(!b64.includes(','), 'base64 payload must not include the data URL prefix');
  assert.strictEqual(Buffer.from(b64, 'base64').toString(), PDF_BYTES.toString());
});

test('server attachment mapping keeps both files with names, types and bytes', async () => {
  const requested = [
    { fileName: 'ballooned.pdf', contentType: PDF_MIME, contentBase64: PDF_BYTES.toString('base64') },
    { fileName: 'Ballooning_Report.xlsx', contentType: XLSX_MIME, contentBase64: XLSX_BYTES.toString('base64') }
  ];

  // Identical construction used by the /api/send-quotation-email handler.
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const info = await transport.sendMail({
    from: 'a@b.com',
    to: 'c@d.com',
    subject: 'Ballooned Drawing & Inspection Report',
    html: 'hi',
    attachments: requested.map((item) => ({
      filename: item.fileName || 'attachment',
      content: Buffer.from(item.contentBase64 || '', 'base64'),
      contentType: item.contentType || 'application/octet-stream'
    }))
  });

  const message = JSON.parse(info.message);
  assert.strictEqual(message.attachments.length, 2, 'one mail must carry both files');
  assert.strictEqual(message.attachments[0].filename, 'ballooned.pdf');
  assert.strictEqual(message.attachments[1].filename, 'Ballooning_Report.xlsx');
  assert.strictEqual(message.attachments[0].contentType, PDF_MIME);
  assert.strictEqual(message.attachments[1].contentType, XLSX_MIME);
  assert.strictEqual(Buffer.from(message.attachments[0].content, 'base64').toString(), PDF_BYTES.toString());
  assert.strictEqual(Buffer.from(message.attachments[1].content, 'base64').toString(), XLSX_BYTES.toString());
});

test('canShareFiles is false when the browser cannot share files', () => {
  withNavigator(undefined, () => {
    assert.strictEqual(canShareFiles([new File([], 'a.pdf')]), false);
  });
});

test('shareFiles reports unsupported on desktop so the caller downloads instead', async () => {
  const result = await withNavigator(undefined, () =>
    shareFiles({ files: [new File([], 'a.pdf')], title: 't', text: 'm' })
  );
  assert.strictEqual(result, 'unsupported');
});

test('shareFiles passes both files to a single navigator.share call', async () => {
  const seen = [];
  await withNavigator(
    { share: async (data) => seen.push(data.files.length), canShare: () => true },
    async () => {
      const files = [new File([], 'a.pdf'), new File([], 'b.xlsx')];
      assert.strictEqual(canShareFiles(files), true);
      const result = await shareFiles({ files, title: 't', text: 'm' });
      assert.strictEqual(result, 'shared');
    }
  );
  assert.deepStrictEqual(seen, [2], 'navigator.share must receive the PDF and the Excel together');
});

test('shareFiles treats a dismissed share sheet as cancelled, not failed', async () => {
  const abort = () => {
    const err = new Error('dismissed');
    err.name = 'AbortError';
    throw err;
  };
  const result = await withNavigator({ share: async () => abort(), canShare: () => true }, () =>
    shareFiles({ files: [new File([], 'a.pdf')] })
  );
  assert.strictEqual(result, 'cancelled');
});

test('openWhatsApp builds a wa.me link with and without a phone number', () => {
  const opened = [];
  const previous = globalThis.window;
  globalThis.window = { open: (url) => opened.push(url) };
  try {
    openWhatsApp({ phone: '+91 98450 12345', text: 'hello there' });
    openWhatsApp({ phone: '', text: 'hello there' });
  } finally {
    globalThis.window = previous;
  }
  assert.ok(opened[0].startsWith('https://wa.me/919845012345?text='), `got ${opened[0]}`);
  assert.ok(opened[1].startsWith('https://wa.me/?text='), `got ${opened[1]}`);
  assert.ok(opened[0].includes('hello%20there'), 'message must be url encoded');
});

test('openWhatsAppWeb opens WhatsApp Web in a new tab', () => {
  const opened = [];
  const previous = globalThis.window;
  globalThis.window = { open: (url, target, rel) => opened.push({ url, target, rel }) };
  try {
    const withNumber = openWhatsAppWeb({ phone: '+91 98450 12345', text: 'hello there' });
    const withoutNumber = openWhatsAppWeb({ phone: '', text: 'hello there' });
    assert.ok(
      withNumber.startsWith('https://web.whatsapp.com/send?phone=919845012345&text='),
      `got ${withNumber}`
    );
    assert.ok(withNumber.includes('hello%20there'), 'message must be url encoded');
    assert.strictEqual(withoutNumber, 'https://web.whatsapp.com/', 'no number should open the chat list');
    assert.ok(opened.every((o) => o.target === '_blank'), 'must open in a new tab');
    assert.ok(opened.every((o) => o.rel === 'noopener'), 'must not leak the opener');
  } finally {
    globalThis.window = previous;
  }
});

test('openWebmail opens Gmail compose in a new tab with prefilled fields', () => {
  const opened = [];
  const previousWindow = globalThis.window;
  globalThis.window = { open: (url, target, rel) => opened.push({ url, target, rel }) };

  try {
    const url = openWebmail({
      to: 'buyer@example.com',
      cc: 'qc@example.com',
      subject: 'Ballooned Drawing & Inspection Report - 111',
      body: 'Line one\nLine two'
    });

    assert.ok(url.startsWith('https://mail.google.com/mail/u/0/'), `got ${url}`);
    assert.ok(url.includes('to=buyer%40example.com'), `got ${url}`);
    assert.ok(url.includes('cc=qc%40example.com'), `got ${url}`);
    assert.ok(url.includes('su=Ballooned+Drawing+%26+Inspection+Report+-+111') || url.includes('su=Ballooned%20Drawing%20%26%20Inspection%20Report%20-%20111'), `got ${url}`);
    assert.ok(url.includes('body='), `got ${url}`);
    assert.ok(url.includes('tf=cm'), `got ${url}`);
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0].target, '_blank');
    assert.strictEqual(opened[0].rel, 'noopener');
  } finally {
    globalThis.window = previousWindow;
  }
});

test('openWebmail tolerates missing recipient and still opens compose', () => {
  const opened = [];
  const previousWindow = globalThis.window;
  globalThis.window = { open: (url) => opened.push(url) };
  try {
    const url = openWebmail({ to: '', subject: 's', body: 'b' });
    assert.ok(url.startsWith('https://mail.google.com/mail/u/0/'), `got ${url}`);
    assert.ok(!url.includes('to='), 'empty to must be omitted');
    assert.ok(url.includes('tf=cm'));
    assert.strictEqual(opened.length, 1);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('saveBlob triggers a download and cleans up the object URL', () => {
  const created = [];
  const revoked = [];
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousUrl = globalThis.URL;

  globalThis.URL = {
    createObjectURL: (blob) => { created.push(blob); return 'blob:fake'; },
    revokeObjectURL: (url) => revoked.push(url)
  };
  globalThis.document = {
    body: { appendChild: () => {} },
    createElement: () => ({ href: '', download: '', click() { this.clicked = true; }, remove() { this.removed = true; } })
  };
  globalThis.window = { setTimeout: (fn) => fn() };

  try {
    saveBlob(new Blob(['x'], { type: PDF_MIME }), 'ballooned.pdf');
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.URL = previousUrl;
  }

  assert.strictEqual(created.length, 1, 'must create one object URL for the file');
  assert.deepStrictEqual(revoked, ['blob:fake'], 'must revoke the object URL');
});
