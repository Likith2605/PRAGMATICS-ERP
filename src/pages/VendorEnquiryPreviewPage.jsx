import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl } from '../utils/companyBranding.js';
import { useCompanyBranding } from '../utils/companyBranding.js';
import { generateQuotationPDF } from '../services/pdfGenerator.js';
import { generateRFQExcel } from '../services/excelGenerator.js';
import { dateOnly } from '../utils/storeService.js';
import { hasPendingEnquiryVendor } from '../utils/vendorQuotationVendor.js';
import { getProcurementRecord, listProcurementRecords, updateProcurementRecord } from '../services/procurementIntakeApi.js';

const PdfDownloadIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M12 18v-6" />
    <polyline points="9 15 12 18 15 15" />
  </svg>
);

const ExcelIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M8 13h2" />
    <path d="M14 13h2" />
    <path d="M8 17h2" />
    <path d="M14 17h2" />
  </svg>
);

const PrintIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 6 2 18 2 18 9" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="8" />
  </svg>
);

const WhatsAppIcon = () => (
  <svg viewBox="0 0 448 512" aria-hidden="true">
    <path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z" />
  </svg>
);

const EmailIcon = () => (
  <svg viewBox="0 0 512 512" aria-hidden="true">
    <path d="M48 64C21.5 64 0 85.5 0 112c0 15.1 7.1 29.3 19.2 38.4L236.8 313.6c11.4 8.5 27 8.5 38.4 0L492.8 150.4c12.1-9.1 19.2-23.3 19.2-38.4 0-26.5-21.5-48-48-48H48zM0 176V384c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V176L294.4 339.2c-22.8 17.1-54 17.1-76.8 0L0 176z" />
  </svg>
);

const defaultRfqTerms = [
  '1) Please quote your best rate, delivery days and payment terms.',
  '2) Rates should state clearly whether GST & freight are included or extra.',
  '3) Quotation is valid only until the validity date mentioned above.',
  '4) Send your quotation to the Purchase Department by email / WhatsApp before the validity date.'
];

const getRfqTerms = (enq) => {
  const custom = String(enq?.termsAndConditions || '').trim();
  const lines = custom
    ? custom.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : defaultRfqTerms.slice();
  if (enq?.validUntil && !lines.some((l) => l.includes(enq.validUntil))) {
    lines.push(`${lines.length + 1}) Quotation valid until ${enq.validUntil}.`);
  }
  return lines.length > 0 ? lines : defaultRfqTerms;
};

const VendorEnquiryPreviewPage = () => {
  const { logoUrl, companyName: brandName, company: brandCompany } = useCompanyBranding(defaultLogoUrl);
  const location = useLocation();
  const navigate = useNavigate();
  const [enquiry, setEnquiry] = useState(null);
  const [quotations, setQuotations] = useState([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareVendorIdx, setShareVendorIdx] = useState(0);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    let id = location.state?.enquiry?.enquiryNumber;
    if (!id) {
      try { id = JSON.parse(localStorage.getItem('currentVendorEnquiry') || '{}')?.enquiryNumber; } catch { /* cache may be malformed; no attachment/data fallback */ }
    }
    if (!id) { setEnquiry(null); return () => { active = false; }; }
    getProcurementRecord('vendorEnquiry', id).then((record) => {
      if (!active) return;
      setEnquiry(record); setShareVendorIdx(0);
      localStorage.setItem('currentVendorEnquiry', JSON.stringify(record));
    }).catch((error) => {
      if (!active) return;
      setEnquiry(null); setMessage(`Enquiry could not be loaded from PostgreSQL: ${error.message}`);
    });
    listProcurementRecords('vendorQuotation').then((rows) => { if (active) setQuotations(rows); }).catch((error) => { if (active) setMessage(`Vendor Quotations could not be loaded from PostgreSQL: ${error.message}`); });
    return () => { active = false; };
  }, [location.state]);

  const vendors = enquiry?.vendors || [];
  const activeVendor = vendors[shareVendorIdx] || vendors[0] || null;

  const rfqDocPayload = () => ({
    documentTitle: `RFQ-${(enquiry && enquiry.enquiryNumber) || 'Enquiry'}`
  });

  const buildRfqMessage = (enq, vendor) => {
    const lines = (enq.items || []).map(
      (it, i) =>
        `${i + 1}. ${it.materialName || it.materialId} — Qty ${it.shortageQty || it.requiredQty} ${it.unit || ''}` +
        `${it.specification ? ` | Spec: ${it.specification}` : ''}`
    );
    return [
      `RFQ – ${enq.enquiryNumber} – ${getCompanyLegalName()}`,
      '',
      `Dear ${(vendor && vendor.contact) || (vendor && vendor.name) || 'Sir/Madam'},`,
      `Please quote your best rates for the following against our enquiry ${enq.enquiryNumber}` +
        `${enq.partName ? ` (Part: ${enq.partName})` : ''}:`,
      ...lines,
      '',
      `Kindly reply with your rate, delivery days and terms before ${enq.validUntil || 'the validity date'}. ` +
        `Full RFQ PDF is attached with this message.`,
      'Regards,',
      `Purchase Department, ${getCompanyLegalName()}`
    ].join('\n');
  };

  const markVendorShared = async (vendorIdx, channel) => {
    if (!enquiry || vendorIdx < 0) return;
    try {
      const nextVendors = (enquiry.vendors || []).map((v, i) =>
        i === vendorIdx ? { ...v, status: 'Sent', sentVia: channel, sentAt: new Date().toISOString() } : v
      );
      const updates = { vendors: nextVendors };
      if (enquiry.status === 'Draft') {
        updates.status = 'Sent';
        updates.sentAt = new Date().toISOString();
      }
      const next = (await updateProcurementRecord('vendorEnquiry', enquiry.enquiryNumber, updates, enquiry.version)).record;
      setEnquiry(next);
      localStorage.setItem('currentVendorEnquiry', JSON.stringify(next));
    } catch (err) {
      console.error(err);
    }
  };

  const handleDownloadPDF = async () => {
    if (!enquiry) return;
    try {
      setMessage('Generating PDF...');
      await generateQuotationPDF(rfqDocPayload());
      setMessage('PDF downloaded successfully!');
      setTimeout(() => setMessage(''), 4000);
    } catch (error) {
      console.error('Download error', error);
      setMessage('Unable to download PDF.');
    }
  };

  const handleDownloadExcel = async () => {
    if (!enquiry) return;
    try {
      setMessage('Generating Excel...');
      const name = await generateRFQExcel(enquiry, activeVendor);
      setMessage(`${name} downloaded!`);
      setTimeout(() => setMessage(''), 4000);
    } catch (error) {
      console.error('Excel download error', error);
      setMessage('Unable to download Excel.');
    }
  };

  const handlePrintPDF = async () => {
    if (!enquiry) return;
    try {
      setMessage('Preparing print...');
      await generateQuotationPDF(rfqDocPayload(), { print: true });
      setMessage('');
    } catch (error) {
      console.error('Print error', error);
      window.print();
    }
  };

  const handleShareWhatsApp = async () => {
    if (!enquiry || !activeVendor) return;
    setShareOpen(false);
    const vendorIdx = vendors.indexOf(activeVendor);
    const phone = String(activeVendor.phone || '').replace(/\D/g, '');
    const text = buildRfqMessage(enquiry, activeVendor);
    try {
      setMessage('Generating PDF...');
      await generateQuotationPDF(rfqDocPayload());
      setMessage('');
    } catch {
      setMessage('');
    }
    const url = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener');
    markVendorShared(vendorIdx, 'WhatsApp');
  };

  const handleShareEmail = async () => {
    if (!enquiry || !activeVendor) return;
    setShareOpen(false);
    const vendorIdx = vendors.indexOf(activeVendor);
    const to = String(activeVendor.email || '').trim();
    const subject = `RFQ ${enquiry.enquiryNumber}${enquiry.partName ? ' - Part ' + enquiry.partName : ''} - ${getCompanyLegalName()}`;
    const body = buildRfqMessage(enquiry, activeVendor);
    try {
      setMessage('Generating PDF...');
      await generateQuotationPDF(rfqDocPayload());
      setMessage('');
    } catch {
      setMessage('');
    }
    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, '_blank', 'noopener');
    markVendorShared(vendorIdx, 'Email');
  };

  const handleMarkSent = async () => {
    if (!enquiry) return;
    if (!window.confirm(`Mark ${enquiry.enquiryNumber} as Sent to vendors?`)) return;
    try {
      const updates = { status: 'Sent', sentAt: new Date().toISOString() };
      const next = (await updateProcurementRecord('vendorEnquiry', enquiry.enquiryNumber, updates, enquiry.version)).record;
      setEnquiry(next);
      localStorage.setItem('currentVendorEnquiry', JSON.stringify(next));
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCreateQuotation = () => {
    if (!enquiry) return;
    if (!hasPendingEnquiryVendor(enquiry, quotations)) {
      alert('All invited vendors already have a quotation recorded for this enquiry.');
      return;
    }
    navigate('/vendor-quotations', {
      state: {
        fromVendorEnquiry: true,
        vendorEnquiry: {
          enquiryNumber: enquiry.enquiryNumber,
          prNumber: enquiry.prNumber,
          projectId: enquiry.projectId,
          projectName: enquiry.projectName,
          partName: enquiry.partName,
          jobCardNumber: enquiry.jobCardNumber,
          requestedBy: enquiry.requestedBy,
          vendors: enquiry.vendors || [],
          items: (enquiry.items || []).map((it) => ({
            materialId: it.materialId || '',
            materialName: it.materialName || '',
            unit: it.unit || 'Nos',
            requiredQty: Number(it.requiredQty) || 0,
            shortageQty: Number(it.shortageQty) || 0,
            specification: it.specification || ''
          })),
          remarks: enquiry.remarks || '',
          status: enquiry.status,
          createdAt: enquiry.createdAt
        }
      }
    });
  };

  if (!enquiry) {
    return (
      <div className="page-section">
        <div className="page-header">
          <div>
            <p className="eyebrow">Preview unavailable</p>
            <h1>Vendor Enquiry Preview</h1>
            <p className="page-description">No enquiry data found. Please open an enquiry from the list.</p>
          </div>
        </div>
        <div className="content-block">
          <button className="button-primary" onClick={() => navigate('/vendor-enquiry')}>
            Back to Vendor Enquiries
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <h1>Vendor Enquiry Preview</h1>
        </div>
        <div className="header-actions no-print">
          <button className="button-secondary" onClick={() => navigate('/vendor-enquiry')}>
            &larr; Back to Enquiries
          </button>
          <button className="button-primary" onClick={handleDownloadPDF}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <PdfDownloadIcon /> Download RFQ PDF
            </span>
          </button>
          <button
            className="button-primary"
            onClick={handleDownloadExcel}
            style={{ background: '#166534', borderColor: '#15803d' }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <ExcelIcon /> Download RFQ Excel
            </span>
          </button>
        </div>
      </div>

      <div className="content-block printable">
        <div className="doc-page-container">
          <article className="quotation-doc-sheet">
            <h1 className="doc-main-title">Request for Quotation (RFQ)</h1>

            <div className="doc-company-box">
              <div className="doc-company-left">
                <div className="doc-company-name">{brandName}</div>
                <div className="doc-company-details">
                  <div>{brandCompany.address}</div>
                  <div>GSTIN: {brandCompany.gstin}</div>
                  <div>Phone: {brandCompany.phone}</div>
                </div>
              </div>
              <div className="doc-company-mid">
                <div>Email: {brandCompany.email}</div>
                <div>State: {brandCompany.state}</div>
              </div>
              <div className="doc-company-logo">
                <img src={logoUrl} alt="Company Logo" />
              </div>
            </div>

            <div className="doc-split-box">
              <div className="doc-half-box doc-half-left">
                <div className="doc-box-header">Vendors Invited:</div>
                <div className="doc-box-body">
                  {vendors.length > 0 ? (
                    vendors.map((v, idx) => (
                      <div key={idx} style={{ marginBottom: idx < vendors.length - 1 ? '8px' : 0 }}>
                        <div className="doc-customer-name" style={{ fontSize: '13px' }}>
                          {idx + 1}. {v.name || '-'}
                        </div>
                        <div className="doc-customer-inline">
                          <span>Contact: {v.contact || '-'}</span>
                          <span>Phone: {v.phone || '-'}</span>
                          <span>Email: {v.email || '-'}</span>
                          <span>Status: {v.status || 'Invited'}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="doc-customer-name">No vendors invited</div>
                  )}
                </div>
              </div>

              <div className="doc-half-box doc-half-right">
                <div className="doc-box-header">Enquiry Details:</div>
                <div className="doc-box-body">
                  <div>
                    Enquiry No.: <strong>{enquiry.enquiryNumber || '-'}</strong>
                  </div>
                    <div>Date: {dateOnly(enquiry.createdAt) || '-'}</div>
                  <div>Valid Until: {enquiry.validUntil || '-'}</div>
                  <div>PR Ref: {enquiry.prNumber || '-'}</div>
                  <div>Project: {enquiry.projectId || '-'}</div>
                  <div>Part: {enquiry.partName || '-'}</div>
                  {enquiry.jobCardNumber && <div>Job Card: {enquiry.jobCardNumber}</div>}
                  <div>Requested By: {enquiry.requestedBy || '-'}</div>
                  <div>Status: {enquiry.status || '-'}</div>
                </div>
              </div>
            </div>

            <table className="doc-items-table">
              <thead>
                <tr>
                  <th className="th-slno text-center">SL.No</th>
                  <th className="text-left">Material</th>
                  <th className="text-left">Specification</th>
                  <th className="text-center">Unit</th>
                  <th className="text-right">Required Qty</th>
                  <th className="text-right">Shortage Qty</th>
                  <th className="text-right">Rate (₹)</th>
                </tr>
              </thead>
              <tbody>
                {(enquiry.items || []).length > 0 ? (
                  (enquiry.items || []).map((it, idx) => (
                    <tr key={idx}>
                      <td className="text-center">{idx + 1}</td>
                      <td className="td-item-desc text-left">
                        <div className="doc-item-title">{it.materialName || it.materialId || '-'}</div>
                      </td>
                      <td className="text-left">{it.specification || '-'}</td>
                      <td className="text-center">{it.unit || '-'}</td>
                      <td className="text-right">{it.requiredQty ?? '-'}</td>
                      <td className="text-right">{it.shortageQty ?? '-'}</td>
                      <td className="text-right"></td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="text-center" style={{ padding: '16px' }}>
                      No materials in this enquiry.
                    </td>
                  </tr>
                )}
                <tr className="doc-total-row">
                  <td colSpan={4} className="text-left font-bold" style={{ paddingLeft: '16px' }}>
                    Total
                  </td>
                  <td className="text-right font-bold">
                    {(enquiry.items || []).reduce((sum, it) => sum + (Number(it.requiredQty) || 0), 0)}
                  </td>
                  <td className="text-right font-bold">
                    {(enquiry.items || []).reduce((sum, it) => sum + (Number(it.shortageQty) || 0), 0)}
                  </td>
                  <td></td>
                </tr>
              </tbody>
            </table>

            <div className="doc-full-box" style={{ margin: '14px 0', border: '1px solid #000', minHeight: '60px', boxSizing: 'border-box' }}>
              <div className="doc-box-title">Remarks</div>
              <div className="doc-box-text" style={{ marginTop: '6px', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                {enquiry.remarks || '-'}
              </div>
            </div>

            <div className="doc-bottom-split">
              <div className="doc-terms-box" style={{ borderTop: '1px solid #000000' }}>
                <div className="doc-box-title">Terms &amp; Conditions</div>
                <div className="doc-terms-list">
                  {getRfqTerms(enquiry).map((line, idx) => (
                    <div key={idx} className="doc-term-item">
                      {line}
                    </div>
                  ))}
                </div>
              </div>

              <div className="doc-sign-box" style={{ borderTop: '1px solid #000000' }}>
                <div className="doc-sign-company">For {brandName}</div>
                <div className="doc-sign-space"></div>
                <div className="doc-sign-line"></div>
              </div>
            </div>

            <div className="doc-sheet-footer">
              <span>Page 1 of 1</span>
            </div>
          </article>
        </div>
      </div>

      <div className="preview-actions no-print" style={{ marginTop: '20px' }}>
        <button
          className="button-primary"
          onClick={handleDownloadPDF}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
        >
          <PdfDownloadIcon /> Download RFQ PDF
        </button>
        <button
          className="button-primary"
          onClick={handleDownloadExcel}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: '#166534', borderColor: '#15803d' }}
        >
          <ExcelIcon /> Download RFQ Excel
        </button>
        <button className="button-secondary" onClick={handlePrintPDF} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <PrintIcon /> Print
        </button>

        {vendors.length > 0 && (
          <select
            className="action-select"
            value={shareVendorIdx}
            onChange={(e) => setShareVendorIdx(Number(e.target.value))}
            title="Share with vendor"
            style={{ width: 'auto', maxWidth: '260px' }}
          >
            {vendors.map((v, idx) => (
              <option key={idx} value={idx}>
                {v.name || `Vendor ${idx + 1}`}
              </option>
            ))}
          </select>
        )}

        <div style={{ position: 'relative' }}>
          <button className="button-secondary" onClick={() => setShareOpen((open) => !open)} disabled={!activeVendor}>
            Share
          </button>
          {shareOpen && (
            <div
              className="share-options"
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: '8px',
                background: '#fff',
                border: '1px solid #e5e7eb',
                borderRadius: '10px',
                padding: '10px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                zIndex: 100,
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                minWidth: '180px'
              }}
            >
              <button className="share-option share-whatsapp" onClick={handleShareWhatsApp}>
                <span className="share-icon">
                  <WhatsAppIcon />
                </span>
                <span className="share-label">WhatsApp</span>
              </button>
              <button className="share-option share-email" onClick={handleShareEmail}>
                <span className="share-icon">
                  <EmailIcon />
                </span>
                <span className="share-label">Email</span>
              </button>
            </div>
          )}
        </div>

        <span style={{ borderLeft: '1px solid #cbd5e1', height: '24px', margin: '0 4px' }} />

        {enquiry.status === 'Draft' && (
          <button
            className="button-secondary"
            onClick={handleMarkSent}
            style={{ color: '#0369a1', borderColor: '#bae6fd', background: '#f0f9ff', fontWeight: '600' }}
          >
            Mark Sent
          </button>
        )}
        {enquiry.status !== 'Closed' && enquiry.status !== 'Cancelled' &&
          hasPendingEnquiryVendor(enquiry, quotations) && (
          <button
            className="button-secondary"
            onClick={handleCreateQuotation}
            style={{ background: '#eff6ff', color: '#1e40af', borderColor: '#bfdbfe', fontWeight: '600' }}
          >
            Create Vendor Quotation
          </button>
        )}

        {message && <div className="field-success no-print" style={{ marginLeft: '12px', fontWeight: 600 }}>{message}</div>}
      </div>
    </div>
  );
};

export default VendorEnquiryPreviewPage;

