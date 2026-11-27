import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { saveCustomerToDirectory } from '../utils/customerDirectory.js';
import { validateContactField } from '../../shared/fieldValidation.js';
import { pushNotification } from '../utils/storeService.js';

const blank = { companyName: '', customerName: '', gstin: '', phone: '', email: '', address: '' };

const CustomerRegistrationModal = ({ onClose, onSaved }) => {
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!form.companyName.trim() || !form.customerName.trim()) return setError('Customer / Company Name and Contact Person are required.');
    const issues = [
      ['phone', 'phone'], ['email', 'email'], ['gstin', 'gstin']
    ].map(([field, type]) => validateContactField(type, form[field])).filter(Boolean);
    if (issues.length) return setError(issues[0]);
    setSaving(true);
    try {
      const customer = await saveCustomerToDirectory({ ...form, companyName: form.companyName.trim(), customerName: form.customerName.trim(), address: form.address.trim() });
      pushNotification({ title: 'Customer added', message: 'Customer added successfully.', type: 'success' });
      onSaved?.(customer);
      onClose();
    } catch (saveError) {
      setError(saveError.message || 'Unable to save customer.');
    } finally {
      setSaving(false);
    }
  };
  const fields = [
    ['companyName', 'Customer / Company Name *'], ['customerName', 'Contact Person *'], ['gstin', 'GSTIN'],
    ['phone', 'Phone / Mobile'], ['email', 'Email Address'], ['address', 'Address']
  ];
  return createPortal(<div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,.48)', display: 'grid', placeItems: 'center', padding: 16 }}>
    <form role="dialog" aria-modal="true" aria-labelledby="customer-modal-title" onSubmit={submit} className="content-block" style={{ width: 'min(680px, 100%)', maxHeight: '90vh', overflow: 'auto', padding: 24 }}>
      <div className="customer-registration-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><h2 id="customer-modal-title" style={{ margin: 0 }}>Add New Customer</h2><button type="button" className="button-secondary" onClick={onClose} aria-label="Close">×</button></div>
      <div className="form-grid" style={{ marginTop: 18 }}>{fields.map(([field, label]) => <label key={field} className={`form-field ${field.endsWith('Address') ? 'full-width' : ''}`}><span>{label}</span>{field.endsWith('Address') ? <textarea rows="3" value={form[field]} onChange={(e) => update(field, e.target.value)} /> : <input type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'} value={form[field]} maxLength={field === 'phone' ? 10 : field === 'gstin' ? 15 : undefined} onChange={(e) => update(field, field === 'gstin' ? e.target.value.toUpperCase() : e.target.value)} />}</label>)}</div>
      {error && <div role="alert" style={{ color: '#b91c1c', marginTop: 12 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}><button type="button" className="button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="button-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Customer'}</button></div>
    </form>
  </div>, document.body);
};

export default CustomerRegistrationModal;
