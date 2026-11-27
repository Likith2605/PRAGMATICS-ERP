import React from 'react';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';

const money = (val) => {
  return Number(val || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};

const VendorQuotationPreview = ({ vendorQuotation = {} }) => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const activeCompany = brandCompany;

  const vqNumber = vendorQuotation.quotationNumber || '-';
  const vqDate = vendorQuotation.quotationDate || vendorQuotation.createdAt?.slice(0, 10) || '-';
  const vendorName = vendorQuotation.vendorName || '-';
  const vendorContact = vendorQuotation.vendorContact || '-';
  const vendorEmail = vendorQuotation.vendorEmail || '-';
  const enquiryNumber = vendorQuotation.enquiryNumber || '-';
  const indentNumber = vendorQuotation.indentNumber || '-';
  const soNumber = vendorQuotation.soNumber || '-';
  const deliveryDays = vendorQuotation.deliveryDays ?? '-';
  const deliveryDate = vendorQuotation.deliveryDate || '-';
  const paymentTerms = vendorQuotation.paymentTerms || '-';
  const validity = vendorQuotation.validity || '-';
  const otherTerms = vendorQuotation.otherTerms || '';
  const remarks = vendorQuotation.remarks || '-';
  const items = (vendorQuotation.items || []).filter((it) => it.materialName || it.unitPrice);
  const lineAmounts = items.map((item) => {
    const quantity = Number(item.quotedQty ?? item.requiredQty) || 0;
    const gross = quantity * (Number(item.unitPrice) || 0);
    const discount = Number(item.discount) || 0;
    const discountAmount = Number(item.discountAmount ?? (gross * discount / 100)) || 0;
    const net = Number(item.totalPrice ?? (gross - discountAmount)) || 0;
    const taxPct = Number(item.taxPct ?? item.tax) || 0;
    const tax = Number(item.taxAmount ?? (net * taxPct / 100)) || 0;
    return { gross, discountAmount, net, tax, taxPct };
  });
  const subtotal = Number(vendorQuotation.subtotal ?? lineAmounts.reduce((sum, line) => sum + line.gross, 0));
  const discountAmount = Number(vendorQuotation.discountAmount ?? lineAmounts.reduce((sum, line) => sum + line.discountAmount, 0));
  const taxableAmount = Number(vendorQuotation.totalAmount ?? (subtotal - discountAmount));
  const taxAmount = Number(vendorQuotation.taxAmount ?? lineAmounts.reduce((sum, line) => sum + line.tax, 0));
  const grandTotal = Number(vendorQuotation.totalWithTax ?? (taxableAmount + taxAmount));

  return (
    <div className="doc-page-container">
      <article className="quotation-doc-sheet">
        {/* Document Title */}
        <h1 className="doc-main-title">Vendor Quotation</h1>

        {/* Company Header Box */}
        <div className="doc-company-box">
          <div className="doc-company-left">
            <div className="doc-company-name">{activeCompany.companyName}</div>
            <div className="doc-company-details">
              <div>{activeCompany.address}</div>
              <div>GSTIN: {activeCompany.gstin}</div>
              <div>Phone: {activeCompany.phone}</div>
            </div>
          </div>
          <div className="doc-company-mid">
            <div>Email: {activeCompany.email}</div>
            <div>State: {activeCompany.state}</div>
          </div>
          <div className="doc-company-logo">
            <img src={logoUrl} alt="Company Logo" />
          </div>
        </div>

        {/* Vendor & Details Split Box */}
        <div className="doc-split-box">
          <div className="doc-half-box doc-half-left">
            <div className="doc-box-header">Vendor Details:</div>
            <div className="doc-box-body">
              <div className="doc-customer-name">{vendorName}</div>
              <div className="doc-customer-inline">
                <span>Contact: {vendorContact}</span>
                <span>Email: {vendorEmail}</span>
              </div>
            </div>
          </div>

          <div className="doc-half-box doc-half-right">
            <div className="doc-box-header">Quotation Details:</div>
            <div className="doc-box-body">
              <div>VQ No.: <strong>{vqNumber}</strong></div>
              <div>Date: {vqDate}</div>
              <div>Enquiry Ref: {enquiryNumber}</div>
              <div>Purchase Indent: {indentNumber}</div>
              <div>Sales Order: {soNumber}</div>
              <div>Delivery: {deliveryDays} days</div>
              <div>Delivery Date: {deliveryDate}</div>
              <div>Payment Terms: {paymentTerms}</div>
              <div>Validity: {validity}</div>
            </div>
          </div>
        </div>

        {/* Items Table */}
        <table className="doc-items-table">
          <thead>
            <tr>
              <th className="th-slno">SL.No</th>
              <th className="text-left">Material Description</th>
              <th className="text-center">Unit</th>
              <th className="text-right">Required Qty</th>
              <th className="text-right">Quoted Qty</th>
              <th className="text-right">Unit Price (₹)</th>
              <th className="text-right">Discount %</th>
              <th className="text-right">Tax %</th>
              <th className="text-right">Tax (₹)</th>
              <th className="text-right">Net (₹)</th>
            </tr>
          </thead>
          <tbody>
            {items.length > 0 ? (
              items.map((item, index) => (
                <tr key={index}>
                  <td className="text-center">{index + 1}</td>
                  <td className="td-item-desc text-left">
                    <div className="doc-item-title">{item.materialName || '-'}</div>
                    {item.materialId && (
                      <div className="doc-item-sec-line">
                        <span className="doc-sec-label">ID:</span> {item.materialId}
                      </div>
                    )}
                  </td>
                  <td className="text-center">{item.unit || '-'}</td>
                  <td className="text-right">{item.requiredQty || '-'}</td>
                  <td className="text-right">{item.quotedQty || item.requiredQty || '-'}</td>
                  <td className="text-right">{money(item.unitPrice)}</td>
                  <td className="text-right">{Number(item.discount) || 0}%</td>
                  <td className="text-right">{lineAmounts[index].taxPct}%</td>
                  <td className="text-right">{money(lineAmounts[index].tax)}</td>
                  <td className="text-right">{money(lineAmounts[index].net)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={10} className="text-center" style={{ padding: '16px' }}>
                  No items.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Notes & Summary */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: '0px', marginTop: '14px', marginBottom: '14px' }}>
          <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '14px', paddingRight: '14px' }}>
            <div className="doc-full-box" style={{ margin: 0, border: '1px solid #000', minHeight: '60px', flex: 'auto', boxSizing: 'border-box' }}>
              <div className="doc-box-title">Remarks</div>
              <div className="doc-box-text" style={{ marginTop: '6px', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                {remarks}
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
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Total Materials</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>{items.length}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Delivery Days</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>{deliveryDays}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Subtotal</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>{money(subtotal)}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Discount</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>-{money(discountAmount)}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Taxable Amount</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>{money(taxableAmount)}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Tax</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>{money(taxAmount)}</td>
              </tr>
              <tr style={{ background: '#e2e8f0', fontWeight: 'bold' }}>
                <td style={{ padding: '6px 10px', borderRight: '1.5px solid #0f172a', fontSize: '12.5px', color: '#0f172a' }}>TOTAL</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', fontSize: '13px', color: '#0f172a' }}>{money(grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Bottom Terms & Signature */}
        <div className="doc-bottom-split">
          <div className="doc-terms-box">
            <div className="doc-box-title">Terms &amp; Conditions</div>
            <div className="doc-terms-list">
              <div className="doc-term-item">Payment terms: {paymentTerms}</div>
              <div className="doc-term-item">Quotation validity: {validity}</div>
              {otherTerms && <div className="doc-term-item" style={{ whiteSpace: 'pre-wrap' }}>{otherTerms}</div>}
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
          <span>Page 1 of 1</span>
        </div>
      </article>
    </div>
  );
};

export default VendorQuotationPreview;

