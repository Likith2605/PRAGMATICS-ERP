import React, { useEffect, useState } from 'react';
import { getCompanyLegalName, getCompanyProfile } from '../utils/companyBranding.js';
import { useLocation, useNavigate } from 'react-router-dom';
import { generateQuotationPDF } from '../services/pdfGenerator.js';
import VendorQuotationPreview from '../components/VendorQuotationPreview.jsx';

const PdfDownloadIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M12 18v-6" />
    <polyline points="9 15 12 18 15 15" />
  </svg>
);

const PrintIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 6 2 18 2 18 9" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="8" />
  </svg>
);

const EditIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
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

const VendorQuotationPreviewPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [vqData, setVqData] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (location.state?.vendorQuotation) {
      setVqData(location.state.vendorQuotation);
      return;
    }
    const localData = localStorage.getItem('currentVendorQuotation');
    if (localData) {
      try {
        setVqData(JSON.parse(localData));
      } catch (error) {
        console.error('Unable to parse saved vendor quotation', error);
        setVqData(null);
      }
    }
  }, [location.state]);

  const handleDownloadPDF = async () => {
    if (!vqData) return;
    try {
      setDownloading(true);
      setMessage('Generating PDF...');
      await generateQuotationPDF({ documentTitle: `VendorQuotation-${vqData.quotationNumber || 'VQ'}` });
      setMessage('PDF downloaded successfully!');
      setTimeout(() => setMessage(''), 4000);
    } catch (error) {
      console.error('Download error', error);
      setMessage('Unable to download PDF.');
    } finally {
      setDownloading(false);
    }
  };

  const handlePrintPDF = async () => {
    if (!vqData) return;
    try {
      await generateQuotationPDF({ documentTitle: `VendorQuotation-${vqData.quotationNumber || 'VQ'}` }, { print: true });
    } catch (error) {
      console.error('Print error', error);
      window.print();
    }
  };

  const handleShareWhatsApp = async () => {
    if (!vqData) return;
    setShareOpen(false);

    const text = `Dear Sir/Madam,

Please find attached the vendor quotation received.

VQ No: ${vqData.quotationNumber || 'N/A'}
Enquiry Ref: ${vqData.enquiryNumber || 'N/A'}
Vendor: ${vqData.vendorName || 'N/A'}
Total: ₹${Number(vqData.totalAmount || 0).toFixed(2)}
Delivery: ${vqData.deliveryDays || '-'} days

Kindly review the attached vendor quotation.

Regards,
${getCompanyLegalName()}
${getCompanyProfile().email}`;

    try {
      setMessage('Generating PDF...');
      await generateQuotationPDF({ documentTitle: `VendorQuotation-${vqData.quotationNumber || 'VQ'}` });
      setMessage('');
    } catch {
      setMessage('');
    }

    const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener');
  };

  const handleShareEmail = async () => {
    if (!vqData) return;
    setShareOpen(false);

    const to = vqData.vendorEmail || '';
    const subject = `Vendor Quotation ${vqData.quotationNumber || ''} - ${vqData.enquiryNumber || ''} - ${getCompanyLegalName()}`;
    const body = `Dear Sir/Madam,

Please find attached the vendor quotation received.

VQ No: ${vqData.quotationNumber || 'N/A'}
Enquiry Ref: ${vqData.enquiryNumber || 'N/A'}
Vendor: ${vqData.vendorName || 'N/A'}
Total: ₹${Number(vqData.totalAmount || 0).toFixed(2)}
Delivery: ${vqData.deliveryDays || '-'} days

Kindly review the attached vendor quotation.

Regards,
${getCompanyLegalName()}
${getCompanyProfile().email}`;

    try {
      setMessage('Generating PDF...');
      await generateQuotationPDF({ documentTitle: `VendorQuotation-${vqData.quotationNumber || 'VQ'}` });
      setMessage('');
    } catch {
      setMessage('');
    }

    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, '_blank', 'noopener');
  };

  if (!vqData) {
    return (
      <div className="page-section">
        <div className="page-header">
          <div>
            <p className="eyebrow">Preview unavailable</p>
            <h1>Vendor Quotation Preview</h1>
            <p className="page-description">No vendor quotation data found. Please receive a quotation first.</p>
          </div>
        </div>
        <div className="content-block">
          <button className="button-primary" onClick={() => navigate('/vendor-quotations')}>
            Back to Vendor Quotations
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <h1>Vendor Quotation Preview</h1>
        </div>
        <div className="header-actions no-print">
          <button className="button-secondary" onClick={() => navigate('/vendor-quotations')}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              Back to Quotations
            </span>
          </button>
          <button className="button-primary" onClick={handleDownloadPDF} disabled={downloading}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <PdfDownloadIcon /> {downloading ? 'Downloading...' : 'Download PDF'}
            </span>
          </button>
        </div>
      </div>

      <div className="content-block printable">
        <VendorQuotationPreview vendorQuotation={vqData} />
      </div>

      <div className="preview-actions no-print" style={{ marginTop: '20px' }}>
        <button className="button-primary" onClick={handleDownloadPDF} disabled={downloading} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <PdfDownloadIcon /> {downloading ? 'Downloading...' : 'Download PDF'}
        </button>
        <button className="button-secondary" onClick={handlePrintPDF} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <PrintIcon /> Print
        </button>
        <div style={{ position: 'relative' }}>
          <button className="button-secondary" onClick={() => setShareOpen((open) => !open)}>
            Share
          </button>
          {shareOpen && (
            <div className="share-options" style={{ position: 'absolute', top: '100%', left: 0, marginTop: '8px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '10px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)', zIndex: 100, display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '180px' }}>
              <button className="share-option share-whatsapp" onClick={handleShareWhatsApp}>
                <span className="share-icon"><WhatsAppIcon /></span>
                <span className="share-label">WhatsApp</span>
              </button>
              <button className="share-option share-email" onClick={handleShareEmail}>
                <span className="share-icon"><EmailIcon /></span>
                <span className="share-label">Email</span>
              </button>
            </div>
          )}
        </div>

        <span style={{ borderLeft: '1px solid #cbd5e1', height: '24px', margin: '0 4px' }} />

        <button
          className="button-secondary"
          onClick={() => navigate('/vendor-quotations')}
          style={{ background: '#eff6ff', color: '#1e40af', borderColor: '#bfdbfe', fontWeight: '600' }}
        >
          Back to Vendor Quotations
        </button>

        {message && <div className="field-success no-print" style={{ marginLeft: '12px', fontWeight: 600 }}>{message}</div>}
      </div>
    </div>
  );
};

export default VendorQuotationPreviewPage;
