import React from 'react';
import logoUrl from '../assets/logo.png';
import { OFFICIAL_COMPANY_PROFILE } from '../constants/companyProfile.js';

const money = (val) => {
  return Number(val || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};

const VendorQuotationPreview = ({ vendorQuotation = {} }) => {
  const activeCompany = OFFICIAL_COMPANY_PROFILE;

  const vqNumber = vendorQuotation.quotationNumber || '-';
  const vqDate = vendorQuotation.createdAt?.slice(0, 10) || '-';
  const vendorName = vendorQuotation.vendorName || '-';
  const vendorContact = vendorQuotation.vendorContact || '-';
  const vendorEmail = vendorQuotation.vendorEmail || '-';
  const enquiryNumber = vendorQuotation.enquiryNumber || '-';
  const deliveryDays = vendorQuotation.deliveryDays || '-';
  const paymentTerms = vendorQuotation.paymentTerms || '-';
  const validity = vendorQuotation.validity || '-';
  const remarks = vendorQuotation.remarks || '-';
  const totalAmount = vendorQuotation.totalAmount || 0;

  const items = (vendorQuotation.items || []).filter((it) => it.materialName || it.unitPrice);

  return (
    <div className="doc-page-container">
      <article className="quotation-doc-sheet">
        {/* Document Title */}
        <h1 className="doc-main-title">Vendor Quotation</h1>

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
              <div>Delivery: {deliveryDays} days</div>
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
              <th className="text-right">Total (₹)</th>
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
                  <td className="text-right">{money(item.totalPrice)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="text-center" style={{ padding: '16px' }}>
                  No items.
                </td>
              </tr>
            )}

            {/* Total Row */}
            <tr className="doc-total-row">
              <td colSpan={6} className="text-left font-bold" style={{ paddingLeft: '16px' }}>
                Grand Total
              </td>
              <td className="text-right font-bold">{money(totalAmount)}</td>
            </tr>
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
              <tr style={{ borderBottom: '1px solid #cbd5e1', background: '#f8fafc' }}>
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Payment Terms</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>{paymentTerms || '-'}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #cbd5e1' }}>
                <td style={{ padding: '5px 10px', fontWeight: '500', borderRight: '1px solid #cbd5e1' }}>Validity</td>
                <td style={{ padding: '5px 10px', textAlign: 'right' }}>{validity || '-'}</td>
              </tr>
              <tr style={{ background: '#e2e8f0', fontWeight: 'bold' }}>
                <td style={{ padding: '6px 10px', borderRight: '1.5px solid #0f172a', fontSize: '12.5px', color: '#0f172a' }}>TOTAL</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', fontSize: '13px', color: '#0f172a' }}>{money(totalAmount)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Bottom Terms & Signature */}
        <div className="doc-bottom-split">
          <div className="doc-terms-box">
            <div className="doc-box-title">Terms &amp; Conditions</div>
            <div className="doc-terms-list">
              <div className="doc-term-item">This is a vendor quotation received for material procurement.</div>
              <div className="doc-term-item">Prices are exclusive of applicable taxes unless mentioned otherwise.</div>
              <div className="doc-term-item">Delivery timeline starts from the date of purchase order.</div>
              <div className="doc-term-item">Payment terms as mentioned above.</div>
              <div className="doc-term-item">Quotation valid until: {validity || 'Not specified'}</div>
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
          <span>This is a computer generated document.</span>
          <span>Page 1 of 1</span>
        </div>
      </article>
    </div>
  );
};

export default VendorQuotationPreview;

