import React from 'react';
import { getTemplateColumns } from '../utils/quotationTemplates.js';
import logoUrl from '../assets/logo.png';

import { OFFICIAL_COMPANY_PROFILE } from '../constants/companyProfile.js';
import { isForeignCurrency, moneyPlain } from '../utils/currency.js';

const money = (val) => {
  return Number(val || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};

const QuotationPreview = ({
  companyDetails = {},
  customerDetails = {},
  quotationDetails = {},
  termsAndConditions = '',
  items = [],
  totals = {},
  amountInWords = ''
}) => {
  const activeCompany = {
    ...OFFICIAL_COMPANY_PROFILE,
    ...companyDetails,
    companyName: OFFICIAL_COMPANY_PROFILE.companyName,
    address: OFFICIAL_COMPANY_PROFILE.address,
    phone: OFFICIAL_COMPANY_PROFILE.phone,
    email: OFFICIAL_COMPANY_PROFILE.email
  };

  const templateCols = getTemplateColumns(quotationDetails.quotationTemplate);
  const primaryCols = templateCols.filter((c) => !c.secondary);
  const secondaryCols = templateCols.filter((c) => c.secondary);

  const currencyCode = quotationDetails.currency || 'INR';
  const taxMode = quotationDetails.taxMode || 'intra';
  const showMoney = (val) =>
    isForeignCurrency(currencyCode) ? `${currencyCode} ${moneyPlain(val, currencyCode)}` : money(val);

  const printableItems = items.filter((item) => {
    const hasName = Boolean(item.itemName?.trim());
    const hasQty = Number(item.quantity) > 0;
    const hasPrice = Number(item.unitPrice) > 0;
    const hasGst = Number(item.gst) > 0;
    const hasAmount = Number(item.amount) > 0;
    return hasName || hasQty || hasPrice || hasGst || hasAmount;
  });

  const totalQty = printableItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const firstItem = printableItems[0] || {};
  const gstRate = Number(firstItem.gst || 0);
  const halfGST = gstRate / 2;

  const termsLines = String(termsAndConditions || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <div className="doc-page-container">
      <article className="quotation-doc-sheet">
        {/* Document Title */}
        <h1 className="doc-main-title">Quotation</h1>

        {/* Company Header Box */}
        <div className="doc-company-box">
            <div className="doc-company-left">
              <div className="doc-company-name">PRAGMATIC ENGINEERS</div>
              <div className="doc-company-details">
                <div>NO.17/3A, KRISHNARAJU ESTATE, C K PALYA ROAD BASAVANAPURA, BANNERGATTA ROAD BANGALORE-560083</div>
                <div>GSTIN: 29AKWPP8736E1ZA</div>
                <div>Phone: +91 9880030466</div>
              </div>
            </div>
            <div className="doc-company-mid">
              <div>Email: pragmatic.vasudev@gmail.com</div>
              <div>State: Karnataka</div>
            </div>
            <div className="doc-company-logo">
              <img src={logoUrl} alt="Company Logo" />
            </div>
          </div>

          {/* Quotation For & Quotation Details Split Box */}
        <div className="doc-split-box">
          <div className="doc-half-box doc-half-left">
            <div className="doc-box-header">Quotation For:</div>
            <div className="doc-box-body">
              <div className="doc-customer-name">
                {customerDetails.companyName || customerDetails.customerName || '-'}
              </div>
              <div className="doc-customer-address">{customerDetails.address || '-'}</div>
              <div className="doc-customer-inline">
                <span>Contact No: {customerDetails.contactNumber || '-'}</span>
                <span>State: {customerDetails.state || '-'}</span>
              </div>
            </div>
          </div>

          <div className="doc-half-box doc-half-right">
            <div className="doc-box-header">Quotation Details:</div>
            <div className="doc-box-body">
              <div>
                Quotation No.: <strong>{quotationDetails.quotationNumber || '-'}</strong>
              </div>
              <div>Date: {quotationDetails.quotationDate || '-'}</div>
              <div>Place Of Supply: {quotationDetails.placeOfSupply || '-'}</div>
              <div>
                Currency: <strong>{currencyCode}</strong>
                {isForeignCurrency(currencyCode) && quotationDetails.exchangeRate
                  ? ` (1 ${currencyCode} = ${quotationDetails.exchangeRate} INR)`
                  : ''}
              </div>
              <div>
                Tax:{' '}
                {taxMode === 'inter'
                  ? 'IGST (inter-state)'
                  : taxMode === 'export'
                  ? 'Export / LUT - zero rated'
                  : 'CGST + SGST'}
              </div>
              {quotationDetails.projectId && <div>Project ID: {quotationDetails.projectId}</div>}
            </div>
          </div>
        </div>

        {/* Items Table */}
        <table className="doc-items-table">
          <thead>
            <tr>
              <th className="th-slno">SL.No</th>
              {primaryCols.map((col) => (
                <th
                  key={col.id}
                  className={`th-${col.id} ${
                    col.type === 'number' || col.id === 'amount' || col.id === 'gst' || col.id === 'unitPrice' || col.id === 'quantity'
                      ? 'text-right'
                      : col.id === 'unit' || col.id === 'slNo'
                      ? 'text-center'
                      : 'text-left'
                  }`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {printableItems.length > 0 ? (
              printableItems.map((item, index) => (
                <tr key={index}>
                  <td className="text-center">{index + 1}</td>
                  {primaryCols.map((col) => {
                    if (col.id === 'itemName') {
                      return (
                        <td key={col.id} className="td-item-desc text-left">
                          <div className="doc-item-title">{item.itemName || '-'}</div>
                          {secondaryCols.map((secCol) => {
                            const val = item[secCol.id];
                            if (!val || String(val).trim() === '') return null;
                            return (
                              <div key={secCol.id} className="doc-item-sec-line">
                                <span className="doc-sec-label">{secCol.label}:</span> {String(val).trim()}
                              </div>
                            );
                          })}
                          {(() => {
                            const subParts = (Array.isArray(item.subParts) ? item.subParts : []).filter(
                              (sp) => sp && String(sp.description || '').trim() !== ''
                            );
                            if (subParts.length === 0) return null;
                            return (
                              <div className="doc-sub-parts">
                                <div className="doc-sub-parts-title">Sub Parts</div>
                                {subParts.map((sp, spIndex) => (
                                  <div key={spIndex} className="doc-sub-part-line">
                                    {spIndex + 1}. {String(sp.description).trim()}{' '}
                                    <span className="doc-sub-part-qty">Qty: {sp.quantity || 1}</span>
                                  </div>
                                ))}
                              </div>
                            );
                          })()}
                        </td>
                      );
                    }

                    let cellVal = item[col.id] || '';
                    if (col.id === 'unitPrice' || col.id === 'amount') {
                      cellVal = showMoney(item[col.id]);
                    } else if (col.id === 'gst' && item[col.id]) {
                      cellVal = `${item[col.id]}%`;
                    }

                    return (
                      <td
                        key={col.id}
                        className={`${
                          col.type === 'number' || col.id === 'amount' || col.id === 'gst' || col.id === 'unitPrice' || col.id === 'quantity'
                            ? 'text-right'
                            : col.id === 'unit'
                            ? 'text-center'
                            : 'text-left'
                        }`}
                      >
                        {cellVal}
                      </td>
                    );
                  })}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={primaryCols.length + 1} className="text-center" style={{ padding: '16px' }}>
                  No items added yet.
                </td>
              </tr>
            )}

            {/* Total Row */}
            {(() => {
              const qtyIndex = primaryCols.findIndex((c) => c.id === 'quantity');
              const spanCount = qtyIndex !== -1 ? qtyIndex + 1 : 2;
              const afterSpanCols = primaryCols.slice(spanCount - 1);

              return (
                <tr className="doc-total-row">
                  <td colSpan={spanCount} className="text-left font-bold" style={{ paddingLeft: '16px' }}>
                    Total
                  </td>
                  {afterSpanCols.map((col) => {
                    if (col.id === 'quantity') {
                      return (
                        <td key={col.id} className="text-right font-bold">
                          {totalQty}
                        </td>
                      );
                    }
                    if (col.id === 'gst') {
                      return (
                        <td key={col.id} className="text-right font-bold">
                          {showMoney(totals.totalGST)}
                        </td>
                      );
                    }
                    if (col.id === 'amount') {
                      return (
                        <td key={col.id} className="text-right font-bold">
                          {showMoney(totals.subtotal)}
                        </td>
                      );
                    }
                    return <td key={col.id}></td>;
                  })}
                </tr>
              );
            })()}
          </tbody>
        </table>

        {/* Side-by-Side: Amount In Words (Left) & Summary Table (Right) */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: '0px', marginTop: '14px', marginBottom: '14px' }}>
                    <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '14px', paddingRight: '14px' }}>
                      <div className="doc-full-box" style={{ margin: 0, border: '1px solid #000', minHeight: '60px', flex: 'auto', boxSizing: 'border-box' }}>
                        <div className="doc-box-title">Amount In Words</div>
                        <div className="doc-box-text" style={{ fontWeight: '500', marginTop: '6px', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                          {amountInWords || 'Zero Rupees Only'}
                        </div>
                      </div>
                      <div className="doc-full-box" style={{ margin: 0, border: '1px solid #000', minHeight: '60px', flex: 'auto', boxSizing: 'border-box' }}>
                          <div className="doc-box-title">Notes</div>
                        <div className="doc-box-text" style={{ marginTop: '6px', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                          {quotationDetails?.notes || '-'}
                        </div>
                      </div>
                    </div>

          <table
            style={{
              width: '280px',
              flexShrink: 0,
              borderCollapse: 'collapse',
              border: '1.5px solid #0f172a',
              fontSize: '12px',
              color: '#0f172a'
            }}
          >
            <tbody>
              <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Subtotal</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>{showMoney(totals.subtotal)}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Taxable</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>{showMoney(totals.taxableAmount || totals.subtotal)}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #cbd5e1', background: '#f8fafc' }}>
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Tax rate</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>{gstRate ? `${gstRate}%` : '0%'}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Tax Amount</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>{showMoney(totals.totalGST)}</td>
              </tr>
              <tr style={{ borderBottom: '1.5px solid #0f172a', background: '#f8fafc' }}>
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Other</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>{showMoney(totals.otherCharges || 0)}</td>
              </tr>
              <tr style={{ background: '#e2e8f0', fontWeight: 'bold' }}>
                <td style={{ padding: '6px 10px', borderRight: '1.5px solid #0f172a', fontSize: '12.5px', color: '#0f172a' }}>TOTAL</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', fontSize: '13px', color: '#0f172a' }}>{showMoney(totals.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        

        {/* Bottom Terms & Conditions and Signature Split Box */}
        <div className="doc-bottom-split">
          <div className="doc-terms-box">
            <div className="doc-box-title">Terms &amp; Conditions</div>
            <div className="doc-terms-list">
              {termsLines.length > 0 ? (
                termsLines.map((line, idx) => (
                  <div key={idx} className="doc-term-item">
                    {line}
                  </div>
                ))
              ) : (
                <div className="doc-term-item">N/A</div>
              )}
            </div>
          </div>

          <div className="doc-sign-box">
            <div className="doc-sign-company">For {activeCompany.companyName}</div>
            <div className="doc-sign-space"></div>
            <div className="doc-sign-line"></div>
          </div>
        </div>

        {/* Document Footer */}
        <div className="doc-sheet-footer">
          <span>This is a computer generated quotation.</span>
          <span>Page 1 of 1</span>
        </div>
      </article>
    </div>
  );
};

export default QuotationPreview;

