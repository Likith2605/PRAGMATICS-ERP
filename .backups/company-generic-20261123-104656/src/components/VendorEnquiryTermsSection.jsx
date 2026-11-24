import React from 'react';
import TermsTemplateEditor, { loadTermsTemplates } from './TermsTemplateEditor.jsx';

const RFQ_TERMS_TEMPLATES_KEY = 'vendorEnquiryTermsTemplates';

const DEFAULT_TEMPLATES = [
  {
    id: 'rfq-default',
    number: 1,
    name: 'Standard RFQ Terms',
    content:
      '1) Please quote your best rate, delivery days and payment terms.\n' +
      '2) Rates should state clearly whether GST & freight are included or extra.\n' +
      '3) Quotation is valid only until the validity date mentioned above.\n' +
      '4) Send your quotation to the Purchase Department by email / WhatsApp before the validity date.'
  },
  {
    id: 'rfq-machining',
    number: 2,
    name: 'Machining / Turning Vendors',
    content:
      '1) Quote rate per piece in INR, GST extra, freight extra.\n' +
      '2) State material grade, heat treatment and process details in your quote.\n' +
      '3) Mention inspection / CMM report availability with supply.\n' +
      '4) Delivery days from receipt of order must be clearly stated.\n' +
      '5) Payment terms: 30 days from invoice after successful receipt.\n' +
      '6) Quotation valid until the validity date mentioned above.'
  },
  {
    id: 'rfq-hardware',
    number: 3,
    name: 'Hardware / Fasteners Vendors',
    content:
      '1) Quote best rate with brand / grade details.\n' +
      '2) GST and freight to be shown separately (or state if inclusive).\n' +
      '3) Delivery: ex-stock or number of days from order.\n' +
      '4) Payment terms to be mentioned in your quotation.\n' +
      '5) Quotation valid until the validity date mentioned above.'
  }
];

export const loadRfqTermsTemplates = () => loadTermsTemplates(RFQ_TERMS_TEMPLATES_KEY, DEFAULT_TEMPLATES);

/** Vendor Enquiry (RFQ) terms — the shared editor with the RFQ templates. */
const VendorEnquiryTermsSection = ({ value, onChange }) => (
  <div className="form-section" style={{ marginTop: '20px' }}>
    <div className="section-heading">
      <h3>Terms &amp; Conditions</h3>
    </div>
    <TermsTemplateEditor
      value={value}
      onChange={onChange}
      storageKey={RFQ_TERMS_TEMPLATES_KEY}
      defaultTemplates={DEFAULT_TEMPLATES}
      newTemplatePrefix="RFQ Template"
      addModalTitle="Add Terms & Conditions Template"
      addModalSubtitle="Create a reusable RFQ template for future vendor enquiries."
      hint="Choose a different template per enquiry/vendor, edit as needed, or add your own with ＋ Add Template."
    />
  </div>
);

export default VendorEnquiryTermsSection;
