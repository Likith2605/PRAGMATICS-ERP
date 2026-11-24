import React, { useState, useEffect } from 'react';
import logoUrl from '../assets/logo.png';
import { performAutoSystemBackup } from '../utils/backupManager.js';

export const DEFAULT_COMPANY_SETTINGS = {
  companyName: 'PRAGMATIC ENGINEERS',
  tagline: 'Precision CNC Machining, Tooling & Industrial Automation',
  address: 'NO.17/3A, KRISHNARAJU ESTATE, C K PALYA ROAD BASAVANAPURA, BANNERGATTA ROAD BANGALORE-560083',
  phone: '+91 9880030466',
  email: 'pragmatic.vasudev@gmail.com',
  website: 'www.pragmaticengineers.in',
  gstin: '',
  pan: '',
  state: 'Karnataka (29)',
  msmeNumber: '',
  bankDetails: {
    bankName: '',
    accountName: 'PRAGMATIC ENGINEERS',
    accountNumber: '',
    ifscCode: '',
    branch: '',
    upiId: ''
  },
  prefixes: {
    quotation: 'QT',
    salesOrder: 'SO',
    customerPO: 'CPO',
    jobCard: 'JC',
    purchaseOrder: 'PO',
    deliveryChallan: 'DC',
    customerInvoice: 'INV',
    supplierInvoice: 'SINV'
  },
  standardTerms: {
    quotation: '1. Prices are ex-works PRAGMATIC ENGINEERS factory.\n2. Taxes extra as applicable (GST 18%).\n3. Payment terms: 50% advance, balance against inspection and before dispatch.\n4. Quotation validity: 30 days from date of issue.',
    invoice: '1. Payment due strictly within agreed credit period.\n2. Interest @ 18% p.a. will be charged on overdue payments.\n3. Goods once sold will not be taken back.',
    purchaseOrder: '1. Materials must strictly conform to specifications and drawings provided.\n2. Test certificate and inspection report must accompany the delivery.\n3. Delivery must be made to PRAGMATIC ENGINEERS factory gate during working hours.',
    deliveryChallan: '1. Goods received in good order and condition as per specifications.\n2. Discrepancies if any must be notified within 24 hours of receipt.'
  }
};

const SettingsPage = () => {
  const [settings, setSettings] = useState(DEFAULT_COMPANY_SETTINGS);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState('company'); // 'company' | 'bank' | 'terms' | 'prefixes'

  // Load from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('companySettings');
      if (stored) {
        setSettings(JSON.parse(stored));
      } else {
        localStorage.setItem('companySettings', JSON.stringify(DEFAULT_COMPANY_SETTINGS));
      }
    } catch {
      setSettings(DEFAULT_COMPANY_SETTINGS);
    }
  }, []);

  const handleSaveSettings = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    try {
      localStorage.setItem('companySettings', JSON.stringify(settings));
      performAutoSystemBackup('Company Settings Updated');
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3500);
    } catch (err) {
      console.error('Failed to save settings', err);
    }
  };

  const handleResetDefaults = () => {
    if (window.confirm('Reset all settings to system defaults?')) {
      setSettings(DEFAULT_COMPANY_SETTINGS);
      localStorage.setItem('companySettings', JSON.stringify(DEFAULT_COMPANY_SETTINGS));
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    }
  };

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <h1>Company Profile & Settings</h1>
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
          <button className="button-secondary" type="button" onClick={handleResetDefaults}>
            Reset Defaults
          </button>
          <button className="button-primary" type="button" onClick={handleSaveSettings}>
            Save All Settings
          </button>
        </div>
      </div>

      {saveSuccess && (
        <div
          style={{
            background: '#dcfce7',
            color: '#166534',
            padding: '12px 18px',
            borderRadius: '8px',
            marginBottom: '20px',
            fontWeight: '600',
            border: '1px solid #bbf7d0',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
        >
          ✓ Settings successfully saved! All generated documents and invoices will now reflect these updated details.
        </div>
      )}

      <div className="content-block">
        {/* Navigation Tabs */}
        <div style={{ display: 'flex', gap: '10px', borderBottom: '1px solid #e5e7eb', paddingBottom: '14px', marginBottom: '22px' }}>
          <button
            className={activeTab === 'company' ? 'button-primary' : 'button-secondary'}
            onClick={() => setActiveTab('company')}
            style={{ padding: '8px 18px' }}
          >
            1. Company Profile & GSTIN
          </button>
          <button
            className={activeTab === 'bank' ? 'button-primary' : 'button-secondary'}
            onClick={() => setActiveTab('bank')}
            style={{ padding: '8px 18px' }}
          >
            2. Bank Account Details (For Invoices)
          </button>
          <button
            className={activeTab === 'prefixes' ? 'button-primary' : 'button-secondary'}
            onClick={() => setActiveTab('prefixes')}
            style={{ padding: '8px 18px' }}
          >
            3. Document Prefixes & Formats
          </button>
          <button
            className={activeTab === 'terms' ? 'button-primary' : 'button-secondary'}
            onClick={() => setActiveTab('terms')}
            style={{ padding: '8px 18px' }}
          >
            4. Default Standard Terms
          </button>
        </div>

        <form onSubmit={handleSaveSettings}>
          {/* Tab 1: Company Profile */}
          {activeTab === 'company' && (
            <div className="form-section">
              <div className="section-heading">
                <h3>Legal Entity & Plant Information</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Company Legal Name *</label>
                  <input
                    type="text"
                    required
                    value={settings.companyName}
                    onChange={(e) => setSettings({ ...settings, companyName: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Business Tagline / Subtitle</label>
                  <input
                    type="text"
                    value={settings.tagline}
                    onChange={(e) => setSettings({ ...settings, tagline: e.target.value })}
                  />
                </div>
                <div className="field-group full-width">
                  <label>Factory / Plant Address *</label>
                  <input
                    type="text"
                    required
                    value={settings.address}
                    onChange={(e) => setSettings({ ...settings, address: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Official Phone Number</label>
                  <input
                    type="text"
                    value={settings.phone}
                    onChange={(e) => setSettings({ ...settings, phone: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Official Email Address</label>
                  <input
                    type="email"
                    value={settings.email}
                    onChange={(e) => setSettings({ ...settings, email: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>Company Website</label>
                  <input
                    type="text"
                    value={settings.website}
                    onChange={(e) => setSettings({ ...settings, website: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>GSTIN Number *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 29ABCDE1234F1Z5"
                    value={settings.gstin}
                    onChange={(e) => {
                      const val = e.target.value.toUpperCase().trim();
                      let derivedPan = settings.pan;
                      if (val.length === 15 && (!settings.pan || settings.pan.trim() === '')) {
                        derivedPan = val.slice(2, 12);
                      }
                      setSettings({ ...settings, gstin: val, pan: derivedPan });
                    }}
                  />
                </div>
                <div className="field-group">
                  <label>PAN Number</label>
                  <input
                    type="text"
                    placeholder="e.g. ABCDE1234F"
                    value={settings.pan}
                    onChange={(e) => setSettings({ ...settings, pan: e.target.value.toUpperCase().trim() })}
                  />
                </div>
                <div className="field-group">
                  <label>State & State Code</label>
                  <input
                    type="text"
                    value={settings.state}
                    onChange={(e) => setSettings({ ...settings, state: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label>MSME / Udyam Registration No.</label>
                  <input
                    type="text"
                    value={settings.msmeNumber}
                    onChange={(e) => setSettings({ ...settings, msmeNumber: e.target.value })}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: Bank Details */}
          {activeTab === 'bank' && (
            <div className="form-section">
              <div className="section-heading">
                <h3>Bank Account & Payment Details (Printed on Invoices & Quotations)</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Bank Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. HDFC Bank / SBI / ICICI Bank"
                    value={settings.bankDetails?.bankName || ''}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        bankDetails: { ...settings.bankDetails, bankName: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Account Holder / Beneficiary Name *</label>
                  <input
                    type="text"
                    required
                    value={settings.bankDetails?.accountName || ''}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        bankDetails: { ...settings.bankDetails, accountName: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Account Number *</label>
                  <input
                    type="text"
                    required
                    value={settings.bankDetails?.accountNumber || ''}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        bankDetails: { ...settings.bankDetails, accountNumber: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>IFSC Code *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. HDFC0001234"
                    value={settings.bankDetails?.ifscCode || ''}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        bankDetails: { ...settings.bankDetails, ifscCode: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group full-width">
                  <label>Bank Branch Name & City</label>
                  <input
                    type="text"
                    value={settings.bankDetails?.branch || ''}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        bankDetails: { ...settings.bankDetails, branch: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>UPI ID (For QR Code / Quick Pay)</label>
                  <input
                    type="text"
                    placeholder="e.g. pragmatics@hdfcbank"
                    value={settings.bankDetails?.upiId || ''}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        bankDetails: { ...settings.bankDetails, upiId: e.target.value }
                      })
                    }
                  />
                </div>
              </div>

              {/* Preview Box */}
              <div
                style={{
                  background: '#f8fafc',
                  border: '1px dashed #cbd5e1',
                  padding: '16px',
                  borderRadius: '8px',
                  marginTop: '20px'
                }}
              >
                <div style={{ fontWeight: 'bold', color: '#0f172a', marginBottom: '8px' }}>
                  Invoice Payment Box Preview:
                </div>
                <div style={{ fontSize: '13px', color: '#334155', lineHeight: '1.6' }}>
                  <div><strong>Beneficiary:</strong> {settings.bankDetails?.accountName || settings.companyName}</div>
                  <div><strong>Bank:</strong> {settings.bankDetails?.bankName} (Branch: {settings.bankDetails?.branch})</div>
                  <div><strong>A/C No:</strong> {settings.bankDetails?.accountNumber} | <strong>IFSC:</strong> {settings.bankDetails?.ifscCode}</div>
                  {settings.bankDetails?.upiId && <div><strong>UPI ID:</strong> {settings.bankDetails.upiId}</div>}
                </div>
              </div>
            </div>
          )}

          {/* Tab 3: Prefixes */}
          {activeTab === 'prefixes' && (
            <div className="form-section">
              <div className="section-heading">
                <h3>Document Number Prefixes</h3>
              </div>
              <div className="section-grid">
                <div className="field-group">
                  <label>Quotation Prefix</label>
                  <input
                    type="text"
                    value={settings.prefixes?.quotation || 'QT'}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        prefixes: { ...settings.prefixes, quotation: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Customer PO Prefix</label>
                  <input
                    type="text"
                    value={settings.prefixes?.customerPO || 'CPO'}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        prefixes: { ...settings.prefixes, customerPO: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Sales Order Prefix</label>
                  <input
                    type="text"
                    value={settings.prefixes?.salesOrder || 'SO'}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        prefixes: { ...settings.prefixes, salesOrder: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Production Job Card Prefix</label>
                  <input
                    type="text"
                    value={settings.prefixes?.jobCard || 'JC'}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        prefixes: { ...settings.prefixes, jobCard: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Supplier Purchase Order Prefix</label>
                  <input
                    type="text"
                    value={settings.prefixes?.purchaseOrder || 'PO'}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        prefixes: { ...settings.prefixes, purchaseOrder: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Delivery Challan Prefix</label>
                  <input
                    type="text"
                    value={settings.prefixes?.deliveryChallan || 'DC'}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        prefixes: { ...settings.prefixes, deliveryChallan: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group">
                  <label>Customer Tax Invoice Prefix</label>
                  <input
                    type="text"
                    value={settings.prefixes?.customerInvoice || 'INV'}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        prefixes: { ...settings.prefixes, customerInvoice: e.target.value }
                      })
                    }
                  />
                </div>
              </div>
            </div>
          )}

          {/* Tab 4: Standard Terms */}
          {activeTab === 'terms' && (
            <div className="form-section">
              <div className="section-heading">
                <h3>Default Terms & Conditions by Module</h3>
              </div>
              <div className="section-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="field-group full-width">
                  <label>Quotation Default Terms</label>
                  <textarea
                    rows="4"
                    value={settings.standardTerms?.quotation || ''}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        standardTerms: { ...settings.standardTerms, quotation: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group full-width">
                  <label>Customer Tax Invoice Default Terms</label>
                  <textarea
                    rows="3"
                    value={settings.standardTerms?.invoice || ''}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        standardTerms: { ...settings.standardTerms, invoice: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group full-width">
                  <label>Purchase Order (Supplier) Default Terms</label>
                  <textarea
                    rows="3"
                    value={settings.standardTerms?.purchaseOrder || ''}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        standardTerms: { ...settings.standardTerms, purchaseOrder: e.target.value }
                      })
                    }
                  />
                </div>
                <div className="field-group full-width">
                  <label>Delivery Challan Default Terms</label>
                  <textarea
                    rows="3"
                    value={settings.standardTerms?.deliveryChallan || ''}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        standardTerms: { ...settings.standardTerms, deliveryChallan: e.target.value }
                      })
                    }
                  />
                </div>
              </div>
            </div>
          )}

          <div className="form-actions" style={{ marginTop: '24px' }}>
            <button type="button" className="button-secondary" onClick={handleResetDefaults}>
              Reset Defaults
            </button>
            <button type="submit" className="button-primary">
              Save Company Settings
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SettingsPage;
