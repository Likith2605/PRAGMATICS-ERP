import React, { useState } from 'react';
import { generateQuotationPDF } from '../services/pdfGenerator.js';

const API_URL = 'http://localhost:3001';

const EmailQuotationModal = ({ quotationData, onClose }) => {
  if (!quotationData) return null;

  const customer = quotationData.customerDetails || {};
  const quotation = quotationData.quotationDetails || {};
  const quotationNumber = quotation.quotationNumber || '';
  const projectId = quotation.projectId || '';

  const [to, setTo] = useState(customer.email || '');
  const [subject, setSubject] = useState(
    `Quotation ${quotationNumber}${projectId ? ' - Project ' + projectId : ''} - Pragmatic Engineers`
  );
  const [body, setBody] = useState(
    `Dear Sir/Madam,\n\nPlease find attached our quotation for the above-mentioned project.\n\nProject ID: ${projectId || 'N/A'}\nQuotation No: ${quotationNumber || 'N/A'}\n\nKindly review the attached quotation and let us know if you require any further information or clarification.\n\nRegards,\nPRAGMATIC ENGINEERS\npragmatic.vasudev@gmail.com`
  );
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const handleSend = async () => {
    if (!to.trim()) return;

    try {
      setSending(true);
      setResult(null);

      const pdfPayload = {
        ...quotationData,
        documentTitle: 'Quotation',
        forTitle: 'Quotation For:',
        detailsTitle: 'Quotation Details:',
        documentDetails: [
          { label: 'Quotation No.', value: quotationNumber || '-' },
          { label: 'Date', value: quotation.quotationDate || '-' },
          { label: 'Place Of Supply', value: quotation.placeOfSupply || '-' },
          { label: 'Project ID', value: projectId }
        ]
      };

      const pdfBase64 = await generateQuotationPDF(pdfPayload, { returnBase64: true });
      if (!pdfBase64) {
        setResult({ success: false, error: 'Unable to send quotation. Please try again.' });
        setSending(false);
        return;
      }

      const fileName = `Quotation_${quotationNumber || 'Document'}.pdf`;
      const htmlBody = body.replace(/\n/g, '<br>');

      const response = await fetch(`${API_URL}/api/send-quotation-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to.trim(), subject, htmlBody, pdfBase64, fileName })
      });

      const data = await response.json();
      if (data.success) {
        setResult({ success: true });
      } else {
        setResult({ success: false, error: 'Unable to send quotation. Please try again.' });
      }
    } catch {
      setResult({ success: false, error: 'Unable to send quotation. Please try again.' });
    } finally {
      setSending(false);
    }
  };

  const fileName = `Quotation_${quotationNumber || 'Document'}.pdf`;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 9999
    }} onClick={(e) => { if (e.target === e.currentTarget && !sending) onClose(); }}>
      <div style={{
        background: '#fff', borderRadius: '10px', width: '500px',
        boxShadow: '0 10px 40px rgba(0,0,0,0.25)', overflow: 'hidden'
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 20px', borderBottom: '1px solid #e5e7eb'
        }}>
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>Email Quotation</h3>
          {!sending && (
            <button onClick={onClose} style={{
              background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: '#6b7280'
            }}>&times;</button>
          )}
        </div>

        <div style={{ padding: '16px 20px' }}>
          {result?.success ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#166534', marginBottom: '16px' }}>
                Quotation sent successfully.
              </div>
              <button onClick={onClose} style={{
                padding: '8px 24px', background: '#166534', color: '#fff', border: 'none',
                borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px'
              }}>Close</button>
            </div>
          ) : (
            <>
              {result?.error && (
                <div style={{
                  background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px',
                  padding: '10px 12px', marginBottom: '14px', color: '#991b1b', fontSize: '13px'
                }}>
                  {result.error}
                </div>
              )}

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>To</label>
                <input
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 10px', border: '1px solid #d1d5db',
                    borderRadius: '6px', fontSize: '13px', boxSizing: 'border-box'
                  }}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 10px', border: '1px solid #d1d5db',
                    borderRadius: '6px', fontSize: '13px', boxSizing: 'border-box'
                  }}
                />
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>Message</label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={8}
                  style={{
                    width: '100%', padding: '8px 10px', border: '1px solid #d1d5db',
                    borderRadius: '6px', fontSize: '13px', resize: 'vertical',
                    fontFamily: 'inherit', boxSizing: 'border-box'
                  }}
                />
              </div>

              <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '16px' }}>
                Attachment: {fileName}
              </div>

              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button
                  onClick={onClose}
                  disabled={sending}
                  style={{
                    padding: '7px 18px', background: '#f9fafb', border: '1px solid #d1d5db',
                    borderRadius: '6px', cursor: sending ? 'not-allowed' : 'pointer',
                    fontSize: '13px', fontWeight: 600, color: '#374151'
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSend}
                  disabled={sending || !to.trim()}
                  style={{
                    padding: '7px 20px', background: sending ? '#93c5fd' : '#2563eb',
                    color: '#fff', border: 'none', borderRadius: '6px',
                    cursor: sending || !to.trim() ? 'not-allowed' : 'pointer',
                    fontSize: '13px', fontWeight: 600
                  }}
                >
                  {sending ? 'Sending...' : 'Send Email'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default EmailQuotationModal;
