import React, { useState, useEffect, useRef } from 'react';
import { NEUTRAL_LOGO_DATA_URI as defaultLogoUrl, COMPANY_SETTINGS_KEY } from '../utils/companyBranding.js';
import { performAutoSystemBackup } from '../utils/backupManager.js';
import { useCompanyBranding, notifyCompanyBrandingUpdated } from '../utils/companyBranding.js';
import { saveERPRecord } from '../services/erpStateSync.js';

export const DEFAULT_COMPANY_SETTINGS = {
  // No company-specific defaults: every company configures its own identity.
  companyName: '',
  tagline: '',
  // Uploaded branding is kept with the existing, synchronised company settings.
  logoDataUrl: '',
  address: '',
  phone: '',
  email: '',
  website: '',
  gstin: '',
  pan: '',
  state: '',
  msmeNumber: '',
  bankDetails: {
    bankName: '',
    accountName: '',
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
    quotation: '1. Prices are ex-works as applicable.\n2. Taxes extra as applicable.\n3. Payment terms as agreed.\n4. Quotation validity: 30 days from date of issue.',
    invoice: '1. Payment due strictly within agreed credit period.\n2. Interest @ 18% p.a. will be charged on overdue payments.\n3. Goods once sold will not be taken back.',
    purchaseOrder: '1. Materials must strictly conform to specifications and drawings provided.\n2. Test certificate and inspection report must accompany the delivery.\n3. Delivery must be made to the factory gate during working hours.',
    deliveryChallan: '1. Goods received in good order and condition as per specifications.\n2. Discrepancies if any must be notified within 24 hours of receipt.'
  }
};

const SettingsPage = () => {
  const { logoUrl, companyName: brandName } = useCompanyBranding(defaultLogoUrl);
  const [settings, setSettings] = useState(DEFAULT_COMPANY_SETTINGS);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [activeTab, setActiveTab] = useState('company'); // 'company' | 'bank' | 'terms' | 'prefixes'
  const settingsRef = useRef(settings);
  const savedSnapshotRef = useRef('');

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Stored values always win over the shipped defaults; missing fields are
  // filled from DEFAULT_COMPANY_SETTINGS so older records keep working.
  const loadStoredSettings = () => {
    try {
      const stored = localStorage.getItem(COMPANY_SETTINGS_KEY);
      const parsed = stored ? JSON.parse(stored) : {};
      const safe = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      return { ...DEFAULT_COMPANY_SETTINGS, ...safe };
    } catch {
      return { ...DEFAULT_COMPANY_SETTINGS };
    }
  };

  const applyStoredSettings = () => {
    const loaded = loadStoredSettings();
    setSettings(loaded);
    savedSnapshotRef.current = JSON.stringify(loaded);
  };

  // Load synchronously on mount and again whenever PostgreSQL hydration or
  // another tab changes the shared record. Never overwrite unsaved local edits.
  useEffect(() => {
    applyStoredSettings();
    const onExternalChange = () => {
      if (JSON.stringify(settingsRef.current) === savedSnapshotRef.current) applyStoredSettings();
    };
    window.addEventListener('erp-state-hydrated', onExternalChange);
    window.addEventListener('storage', onExternalChange);
    return () => {
      window.removeEventListener('erp-state-hydrated', onExternalChange);
      window.removeEventListener('storage', onExternalChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist locally first, then confirm the write to PostgreSQL before showing
  // a success message. The shared record is synced to other computers by the
  // existing erpStateSync mechanism.
  const persistSettings = async(next) => {
    try {
      localStorage.setItem(COMPANY_SETTINGS_KEY, JSON.stringify(next));
    } catch (err) {
      console.error('Failed to save company settings locally', err);
      setSaveError('Could not save company settings in this browser. Please check browser storage.');
      setSaveSuccess(false);
      return false;
    }
    notifyCompanyBrandingUpdated();
    const persisted = await saveERPRecord(COMPANY_SETTINGS_KEY, next);
    if (!persisted) {
      setSaveError('Company settings were saved in this browser but could not be confirmed in PostgreSQL. Please try again.');
      setSaveSuccess(false);
      return false;
    }
    savedSnapshotRef.current = JSON.stringify(next);
    setSaveError('');
    try {
      performAutoSystemBackup('Company Settings Updated');
    } catch { /* backup is best-effort; the settings record is already persisted */ }
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3500);
    return true;
  };

  const handleSaveSettings = async(e) => {
    if (e && e.preventDefault) e.preventDefault();
    await persistSettings(settings);
  };

  // Resize before storing so the shared settings record stays well within the
  // localStorage quota and the existing PostgreSQL state-sync size limit.
  const handleLogoFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      window.alert('Please choose an image file for the company logo.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      window.alert('Company logo must be smaller than 2 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDimension = 512;
        const scale = Math.min(1, maxDimension / Math.max(img.width || 1, img.height || 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((img.width || 1) * scale));
        canvas.height = Math.max(1, Math.round((img.height || 1) * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        setSettings((previous) => ({ ...previous, logoDataUrl: canvas.toDataURL('image/png') }));
      };
      img.onerror = () => window.alert('Could not read the selected logo image.');
      img.src = String(reader.result);
    };
    reader.onerror = () => window.alert('Could not read the selected file.');
    reader.readAsDataURL(file);
  };

  const handleResetDefaults = async() => {
    if (window.confirm('Reset all settings to system defaults?')) {
      setSettings(DEFAULT_COMPANY_SETTINGS);
      await persistSettings(DEFAULT_COMPANY_SETTINGS);
    }
  };

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <h1>Company Profile & Settings</h1>
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt={`${brandName} logo`} />
          <button className="button-secondary" type="button" onClick={handleResetDefaults}>
            Reset Defaults
          </button>
          <button className="button-primary" type="button" onClick={handleSaveSettings}>
            Save All Settings
          </button>
        </div>
      </div>

      {saveError && (
        <div
          role="alert"
          style={{
            background: '#fef2f2',
            color: '#991b1b',
            padding: '12px 18px',
            borderRadius: '8px',
            marginBottom: '20px',
            fontWeight: '600',
            border: '1px solid #fecaca'
          }}
        >
          {saveError}
        </div>
      )}

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
                <div className="field-group full-width">
                  <label>Company Logo</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                    <img
                      src={settings.logoDataUrl || logoUrl}
                      alt="Company logo preview"
                      style={{ width: '110px', height: '56px', objectFit: 'contain', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '4px' }}
                    />
                    <input type="file" accept="image/*" onChange={handleLogoFile} aria-label="Upload company logo" />
                    {settings.logoDataUrl && (
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => setSettings((previous) => ({ ...previous, logoDataUrl: '' }))}
                      >
                        Remove Logo
                      </button>
                    )}
                  </div>
                  <small style={{ color: '#64748b' }}>
                    PNG or JPG up to 2 MB. Saved with your company settings and shared with every computer. Use Save All Settings to apply.
                  </small>
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
                    placeholder="e.g. company@hdfcbank"
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
