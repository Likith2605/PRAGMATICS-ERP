/**
 * TallyPrime XML Serializer — converts mapped Tally objects (from tallyMapper.js)
 * into TallyPrime-compatible XML strings for import.
 *
 * Output format follows the official Tally XML Data Interchange specification:
 *
 *   <ENVELOPE>
 *     <HEADER>
 *       <VERSION>1</VERSION>
 *       <TALLYREQUEST>Import</TALLYREQUEST>
 *       <TYPE>Data</TYPE>
 *       <ID>Company</ID>
 *     </HEADER>
 *     <BODY>
 *       <IMPORTDATA>
 *         <REQUESTDESC>
 *           <REPORTNAME>All Masters</REPORTNAME>
 *           <STATICVARIABLES><SVCURRENTCOMPANY>...</SVCURRENTCOMPANY></STATICVARIABLES>
 *         </REQUESTDESC>
 *         <REQUESTDATA>
 *           <TALLYMESSAGE><LEDGER NAME="..." ACTION="Create">...</LEDGER></TALLYMESSAGE>
 *           ...
 *         </REQUESTDATA>
 *       </IMPORTDATA>
 *     </BODY>
 *   </ENVELOPE>
 *
 * For vouchers, REPORTNAME = "Voucher" and elements are <VOUCHER ...> instead of <LEDGER>.
 *
 * This module is PURE: it takes JavaScript objects and returns XML strings.
 * It never writes to storage or the network.
 *
 * Text content passed as children is XML-escaped by callers using xmlEscape().
 * Pre-formed XML strings (from nested el() calls) are NOT escaped.
 */

import { xmlEscape, tallyDate, r2 } from './tallyMapper.js';

// Re-export helpers used by the UI
export { xmlEscape, tallyDate, r2 };

// ---------------------------------------------------------------------------
// Low-level XML builders
// ---------------------------------------------------------------------------

/** Build an XML element with attributes and children.
 *  Children are NOT escaped — callers must pass xmlEscape()'d text for
 *  unsafe values. Pre-formed XML strings (nested el() results) are safe.
 */
const el = (tag, attrs = {}, children = '') => {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => (v === null || v === undefined ? '' : ` ${k}="${String(v)}"`))
    .join('');
  const childStr = Array.isArray(children) ? children.join('') : String(children);
  if (childStr === '' || childStr === null || childStr === undefined) {
    return `<${tag}${attrStr} />`;
  }
  return `<${tag}${attrStr}>${childStr}</${tag}>`;
};

/** Build a Tally envelope wrapper around REQUESTDATA content. */
const buildEnvelope = (reportName, companyName, requestDataXml) => {
  const company = xmlEscape(companyName || '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Company</ID>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>${xmlEscape(reportName)}</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        ${requestDataXml}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
};

// ---------------------------------------------------------------------------
// Master XML builders
// ---------------------------------------------------------------------------

/** Serialize a ledger object to <LEDGER> XML. */
const ledgerToXml = (ledger) => {
  const openingBalance = r2(ledger.openingBalance || 0);
  const isDeemedPositive = ledger.isDeemedPositive ? 'Yes' : 'No';

  // Address lines: split multi-line address into ADDRESS.1..ADDRESS.4
  const addrLines = (ledger.address || '').split(/\n/).slice(0, 4);
  while (addrLines.length < 4) addrLines.push('');

  const gstin = ledger.gstin || '';
  const pan = ledger.pan || '';

  return el('TALLYMESSAGE', {}, [
    el('LEDGER', { NAME: xmlEscape(ledger.name), ACTION: 'Create' }, [
      el('NAME', {}, xmlEscape(ledger.name)),
      el('PARENT', {}, xmlEscape(ledger.parent || 'Sundry Debtors')),
      el('OPENINGBALANCE', {}, String(openingBalance)),
      el('ISDEEMEDPOSITIVE', {}, isDeemedPositive),
      el('GSTIN', {}, xmlEscape(gstin)),
      el('PAN', {}, xmlEscape(pan)),
      el('ADDRESS.1', {}, xmlEscape(addrLines[0])),
      el('ADDRESS.2', {}, xmlEscape(addrLines[1])),
      el('ADDRESS.3', {}, xmlEscape(addrLines[2])),
      el('ADDRESS.4', {}, xmlEscape(addrLines[3])),
      el('CITY', {}, xmlEscape(ledger.city || '')),
      el('PINCODE', {}, xmlEscape(ledger.pincode || '')),
      el('STATE', {}, xmlEscape(ledger.state || '')),
      el('COUNTRY', {}, xmlEscape(ledger.country || 'India')),
      el('MOBILE', {}, xmlEscape(ledger.phone || '')),
      el('EMAIL', {}, xmlEscape(ledger.email || '')),
      el('GSTREGISTRATIONTYPE', {}, xmlEscape(ledger.gstRegistrationType || 'Unregistered'))
    ])
  ]).replace(/\n/g, '');
};

/** Serialize a stock item object to <STOCKITEM> XML. */
const stockItemToXml = (item) => {
  return el('TALLYMESSAGE', {}, [
    el('STOCKITEM', { NAME: xmlEscape(item.name), ACTION: 'Create' }, [
      el('NAME', {}, xmlEscape(item.name)),
      el('PARENT', {}, xmlEscape(item.parent || 'Primary')),
      el('UNITNAME', {}, xmlEscape(item.unit || 'Nos')),
      el('HSNCODE', {}, xmlEscape(item.hsnSac || '')),
      el('OPENINGBALANCE', {}, String(r2(item.openingBalance || 0))),
      el('RATE', {}, String(r2(item.gstRate || 0)))
    ])
  ]).replace(/\n/g, '');
};

/** Serialize a unit object to <UNIT> XML. */
const unitToXml = (unit) => {
  return el('TALLYMESSAGE', {}, [
    el('UNIT', { NAME: xmlEscape(unit.name), ACTION: 'Create' }, [
      el('NAME', {}, xmlEscape(unit.name)),
      el('PARENTUNIT', {}, xmlEscape(unit.parent || 'Number')),
      el('DECIMALPLACES', {}, String(unit.decimalPlaces || 0))
    ])
  ]).replace(/\n/g, '');
};

/**
 * Build master.xml content.
 * Includes: LEDGER (customers + suppliers), STOCKITEM, UNIT
 */
export const buildMasterXml = ({ customers = [], suppliers = [], stockItems = [], units = [], companyName }) => {
  const ledgerXml = [...customers, ...suppliers]
    .map((l) => ledgerToXml(l))
    .join('\n');

  const stockItemXml = stockItems.map((i) => stockItemToXml(i)).join('\n');
  const unitXml = units.map((u) => unitToXml(u)).join('\n');

  const requestData = [ledgerXml, stockItemXml, unitXml].filter(Boolean).join('\n');

  return buildEnvelope('All Masters', companyName, requestData);
};

// ---------------------------------------------------------------------------
// Voucher XML builders
// ---------------------------------------------------------------------------

/** Serialize a single accounting allocation to <ALLLOCATIONS> XML. */
const accountingAllocationToXml = (alloc) => {
  const amount = r2(alloc.amount || 0);
  const isPositive = alloc.isDeemedPositive ? 'Yes' : 'No';

  let xml = el('ALLLOCATIONS', [], [
    el('LEDGERNAME', {}, xmlEscape(alloc.ledgerName || '')),
    el('ISDEEMEDPOSITIVE', {}, isPositive),
    el('AMOUNT', {}, String(amount))
  ]);

  // Bill allocation for party ledgers (tracks invoice reference)
  if (alloc.billAllocation) {
    const ba = alloc.billAllocation;
    xml += el('BILLALLOCATIONS', [], [
      el('NAME', {}, xmlEscape(ba.name || '')),
      el('BILLTYPE', {}, xmlEscape(ba.billType || 'New Ref')),
      el('AMOUNT', {}, String(r2(ba.amount || 0)))
    ]);
  }

  return xml;
};

/** Serialize a single inventory allocation to <ALLLOCATIONS> XML. */
const inventoryAllocationToXml = (alloc) => {
  const qty = r2(alloc.quantity || 0);
  const rate = r2(alloc.rate || 0);
  const amount = r2(alloc.amount || 0);
  const gstPercent = r2(alloc.gstPercent || 0);
  const gstAmount = r2(alloc.gstAmount || 0);

  return el('ALLLOCATIONS', [], [
    el('STOCKITEMNAME', {}, xmlEscape(alloc.stockItemName || '')),
    el('ISDEEMEDPOSITIVE', {}, alloc.isDeemedPositive ? 'Yes' : 'No'),
    el('RATE', {}, String(rate)),
    el('AMOUNT', {}, String(amount)),
    el('QUANTITY', {}, String(qty)),
    el('UNITNAME', {}, xmlEscape(alloc.unit || 'Nos')),
    el('GSTPERCENT', {}, String(gstPercent)),
    el('GSTAMOUNT', {}, String(gstAmount))
  ]);
};

/** Serialize a voucher object to <VOUCHER> XML. */
const voucherToXml = (voucher) => {
  const date = voucher.date || '';
  const effDate = voucher.effectiveDate || date;
  const voucherType = xmlEscape(voucher.voucherType || 'Sales');
  const voucherNumber = xmlEscape(voucher.voucherNumber || '');
  const reference = xmlEscape(voucher.reference || '');
  const narration = xmlEscape(voucher.narration || '');
  const isInvoice = voucher.isInvoice ? 'Yes' : 'No';
  const isDeemedPositive = voucher.isDeemedPositive ? 'Yes' : 'No';

  const accountingXml = (voucher.accountingAllocations || [])
    .map((a) => accountingAllocationToXml(a))
    .join('\n');

  const inventoryXml = (voucher.inventoryAllocations || [])
    .map((a) => inventoryAllocationToXml(a))
    .join('\n');

  // For sales/purchase vouchers, mark as invoice
  const invoiceTag = voucher.isInvoice ? el('ISINVOICE', {}, isInvoice) : '';

  return el('TALLYMESSAGE', {}, [
    el('VOUCHER', {
      VCHTYPE: voucherType,
      ACTION: 'Create'
    }, [
      el('DATE', {}, xmlEscape(date)),
      el('EFFECTIVEDATE', {}, xmlEscape(effDate)),
      el('VOUCHERTYPENAME', {}, voucherType),
      el('VOUCHERNUMBER', {}, voucherNumber),
      el('REFERENCE', {}, reference),
      el('NARRATION', {}, narration),
      invoiceTag,
      el('ISDEEMEDPOSITIVE', {}, isDeemedPositive),
      el('ACCOUNTINGALLOCATIONS', [], accountingXml),
      el('INVENTORYALLOCATIONS', [], inventoryXml)
    ])
  ]).replace(/\n/g, '');
};

/**
 * Build voucher.xml content.
 * Includes all vouchers of selected types.
 */
export const buildVoucherXml = ({ vouchers = [], companyName }) => {
  const voucherXml = vouchers.map((v) => voucherToXml(v)).join('\n');
  return buildEnvelope('Voucher', companyName, voucherXml);
};

// ---------------------------------------------------------------------------
// XML validation (basic well-formedness + Tally structure checks)
// ---------------------------------------------------------------------------

/**
 * Validate that a string is well-formed XML and contains expected Tally elements.
 * Returns { valid: boolean, errors: string[] }
 */
export const validateTallyXml = (xmlString, type = 'master') => {
  const errors = [];

  if (!xmlString || !xmlString.trim()) {
    errors.push('XML content is empty');
    return { valid: false, errors };
  }

  // Check for ENVELOPE wrapper
  if (!xmlString.includes('<ENVELOPE>')) errors.push('Missing <ENVELOPE> root element');
  if (!xmlString.includes('</ENVELOPE>')) errors.push('Missing closing </ENVELOPE>');
  if (!xmlString.includes('<HEADER>')) errors.push('Missing <HEADER>');
  if (!xmlString.includes('<BODY>')) errors.push('Missing <BODY>');
  if (!xmlString.includes('<IMPORTDATA>')) errors.push('Missing <IMPORTDATA>');
  if (!xmlString.includes('<REQUESTDATA>')) errors.push('Missing <REQUESTDATA>');

  // Check report name matches type
  const expectedReport = type === 'master' ? 'All Masters' : 'Voucher';
  if (!xmlString.includes(`<REPORTNAME>${expectedReport}</REPORTNAME>`)) {
    errors.push(`Missing or incorrect <REPORTNAME> (expected "${expectedReport}")`);
  }

  // Check TALLYMESSAGE elements exist
  const tallyMessageCount = (xmlString.match(/<TALLYMESSAGE/g) || []).length;
  if (tallyMessageCount === 0) errors.push('No <TALLYMESSAGE> elements found');

  // Check for balanced opening/closing tags (basic)
  // Match opening tags: <TagName ...> (including dotted names like ADDRESS.1)
  // Match self-closing: <TagName ... />
  // Match closing: </TagName>
  const openTagRegex = /<([a-zA-Z][a-zA-Z0-9.]*)(?:\s[^>]*)?>/g;
  const closeTagRegex = /<\/([a-zA-Z][a-zA-Z0-9.]*)>/g;
  const selfClosingRegex = /<([a-zA-Z][a-zA-Z0-9.]*)(?:\s[^>]*)?\/>/g;

  const openMatches = xmlString.match(openTagRegex) || [];
  const closeMatches = xmlString.match(closeTagRegex) || [];
  const selfClosingMatches = xmlString.match(selfClosingRegex) || [];

  // Count opening tags that are NOT self-closing
  const regularOpenCount = openMatches.length - selfClosingMatches.length;
  if (regularOpenCount !== closeMatches.length) {
    errors.push(`Tag imbalance: ${regularOpenCount} regular opening vs ${closeMatches.length} closing (plus ${selfClosingMatches.length} self-closing)`);
  }

  // Check for unescaped ampersands in text (common issue)
  const badAmp = xmlString.match(/&(?![a-zA-Z]+;)/g);
  if (badAmp && badAmp.length > 0) {
    errors.push(`Found ${badAmp.length} unescaped ampersand (&) — must be &amp;`);
  }

  return { valid: errors.length === 0, errors };
};
