import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import logoUrl from '../assets/logo.png';
import { generateExportInvoicePDF } from '../services/pdfGenerator.js';
import {
  listExportInvoices,
  getExportInvoice,
  createExportInvoice,
  updateExportInvoice,
  deleteExportInvoice,
  previewExportInvoiceNumber,
  getExportProfile,
  saveExportProfile,
  computeExportTotals,
  usdAmountInWords,
  DEFAULT_DECLARATION
} from '../utils/exportInvoiceService.js';

const money = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '0.00');
const emptyItem = { packages: '', description: '', quantity: '', unit: '', rate: '' };

const blankForm = () => {
  const profile = getExportProfile();
  return {
    invoiceNumber: previewExportInvoiceNumber(),
    invoiceDate: new Date().toISOString().slice(0, 10),
    exporterRef: '',
    buyersOrderNo: '',
    buyersOrderDate: '',
    buyer: { name: '', address: '', contactPerson: '', contactNo: '' },
    shipToAddress: '',
    logistics: {
      preCarriage: '',
      placeOfReceipt: '',
      portOfLoading: '',
      finalDestination: '',
      vesselFlight: '',
      portOfDischarge: '',
      marksNumbers: '',
      containerNo: '',
      otherReferences: ''
    },
    countryOfOrigin: profile.countryOfOrigin,
    countryOfDestination: '',
    termsOfDelivery: profile.deliveryTerms,
    paymentTerms: profile.paymentTerms,
    netWeight: '',
    grossWeight: '',
    declaration: DEFAULT_DECLARATION,
    swiftCode: profile.swiftCode || '',
    status: 'Draft',
    source: null,
    items: [{ ...emptyItem }]
  };
};

const payloadToForm = (payload) => ({
  invoiceNumber: payload.invoiceNumber || '',
  invoiceDate: payload.invoiceDate || '',
  exporterRef: payload.exporterRef || '',
  buyersOrderNo: payload.buyersOrderNo || '',
  buyersOrderDate: payload.buyersOrderDate || '',
  buyer: {
    name: payload.buyer?.name || '',
    address: payload.buyer?.address || '',
    contactPerson: payload.buyer?.contactPerson || '',
    contactNo: payload.buyer?.contactNo || ''
  },
  shipToAddress: payload.shipToAddress || '',
  logistics: {
    preCarriage: payload.logistics?.preCarriage || '',
    placeOfReceipt: payload.logistics?.placeOfReceipt || '',
    portOfLoading: payload.logistics?.portOfLoading || '',
    finalDestination: payload.logistics?.finalDestination || '',
    vesselFlight: payload.logistics?.vesselFlight || '',
    portOfDischarge: payload.logistics?.portOfDischarge || '',
    marksNumbers: payload.logistics?.marksNumbers || '',
    containerNo: payload.logistics?.containerNo || '',
    otherReferences: payload.logistics?.otherReferences || ''
  },
  countryOfOrigin: payload.countryOfOrigin || '',
  countryOfDestination: payload.countryOfDestination || '',
  termsOfDelivery: payload.termsOfDelivery || '',
  paymentTerms: payload.paymentTerms || '',
  netWeight: payload.netWeight || '',
  grossWeight: payload.grossWeight || '',
  declaration: payload.declaration || DEFAULT_DECLARATION,
  swiftCode: payload.bankDetails?.swiftCode || '',
  status: payload.status || 'Draft',
  source: payload.source || null,
  items: (payload.items || []).map((it) => ({
    packages: it.packages || '',
    description: it.description || '',
    quantity: it.quantity ?? '',
    unit: it.unit || '',
    rate: it.rate ?? ''
  }))
});

const ExportInvoicePage = () => {
  const location = useLocation();
  const [mode, setMode] = useState('list'); // 'list' | 'create' | 'view'
  const [list, setList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [editingRef, setEditingRef] = useState(null);
  const [profile, setProfile] = useState(() => getExportProfile());
  const [form, setForm] = useState(blankForm);

  useEffect(() => {
    setList(listExportInvoices());
  }, []);

  /* ------------------------------------------------------------------
   * Sales Order → Export Invoice (same connection pattern as Sales Order
   * → Customer Invoice). Buyer, buyer's order refs, items (description /
   * qty / unit) and the SO reference flow in; the USD rate stays blank for
   * the export person to enter. The export format/PDF itself is unchanged.
   * ------------------------------------------------------------------ */
  useEffect(() => {
    if (location.state?.fromSalesOrder && location.state?.salesOrder) {
      const so = location.state.salesOrder;
      const source = {
        soNumber: so.soDetails?.soNumber || '',
        quotationRef: so.soDetails?.quotationRef || '',
        projectId: so.soDetails?.projectId || ''
      };
      setProfile(getExportProfile());
      setForm({
        ...blankForm(),
        buyersOrderNo: so.soDetails?.customerPoNumber || '',
        buyersOrderDate: so.soDetails?.customerPoDate || '',
        buyer: {
          name: so.customerDetails?.companyName || so.customerDetails?.customerName || '',
          address: so.customerDetails?.address || '',
          contactPerson: '',
          contactNo: so.customerDetails?.contactNumber || ''
        },
        shipToAddress: so.soDetails?.placeOfSupply || '',
        logistics: {
          ...blankForm().logistics,
          otherReferences: so.soDetails?.soNumber || ''
        },
        source,
        items: (so.items || [])
          .filter((it) => String(it?.itemName || it?.itemCode || '').trim())
          .map((it) => ({
            packages: '',
            description: it.itemName || it.itemCode || '',
            quantity: it.quantity ?? '',
            unit: it.unit || '',
            rate: ''
          }))
      });
      setEditingRef(null);
      setSelected(null);
      setMode('create');
    }
  }, [location.state]);

  const totals = useMemo(() => computeExportTotals(form.items), [form.items]);
  const amountWords = useMemo(() => usdAmountInWords(totals.amountUSD), [totals.amountUSD]);

  const setField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));
  const setNested = (field, key, value) =>
    setForm((prev) => ({ ...prev, [field]: { ...prev[field], [key]: value } }));

  const handleFieldChange = (index, field, value) =>
    setForm((prev) => {
      const items = [...prev.items];
      items[index] = { ...items[index], [field]: value };
      return { ...prev, items };
    });

  const openCreate = () => {
    setProfile(getExportProfile());
    setForm(blankForm());
    setEditingRef(null);
    setSelected(null);
    setMode('create');
  };

  const openView = (reference) => {
    const entry = getExportInvoice(reference);
    if (!entry) return;
    setSelected(entry);
    setForm(payloadToForm(entry.payload));
    setMode('view');
  };

  const openEdit = () => {
    if (!selected) return;
    setProfile(getExportProfile());
    setForm(payloadToForm(selected.payload));
    setEditingRef(selected.reference);
    setMode('create');
  };

  const handleSave = (e) => {
    e.preventDefault();
    try {
      saveExportProfile(profile);
      const data = { ...form, swiftCode: profile.swiftCode };
      const entry = editingRef ? updateExportInvoice(editingRef, data) : createExportInvoice(data);
      setList(listExportInvoices());
      setSelected(entry);
      setForm(payloadToForm(entry.payload));
      setEditingRef(null);
      setMode('view');
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelete = (reference) => {
    if (!window.confirm(`Delete Export Invoice ${reference}?`)) return;
    deleteExportInvoice(reference);
    setList(listExportInvoices());
    setSelected(null);
    setMode('list');
  };

  const handleDownloadPDF = async () => {
    if (!selected) return;
    try {
      await generateExportInvoicePDF(selected.payload);
    } catch {
      alert('Error generating PDF.');
    }
  };

  const handlePrintPDF = async () => {
    if (!selected) return;
    try {
      await generateExportInvoicePDF(selected.payload, { print: true });
    } catch {
      window.print();
    }
  };

  const ItemRows = (
    <tbody>
      {form.items.map((item, idx) => {
        const amount = (Number(item.quantity) || 0) * (Number(item.rate) || 0);
        return (
          <tr key={idx} className="item-row">
            <td style={{ textAlign: 'center', fontWeight: 'bold' }}>{idx + 1}</td>
            <td>
              <input
                type="text"
                placeholder="e.g. 20 CTNS"
                value={item.packages}
                onChange={(e) => handleFieldChange(idx, 'packages', e.target.value)}
              />
            </td>
            <td>
              <input
                type="text"
                placeholder="Description of Goods"
                value={item.description}
                onChange={(e) => handleFieldChange(idx, 'description', e.target.value)}
              />
            </td>
            <td>
              <input
                type="number"
                value={item.quantity}
                onChange={(e) => handleFieldChange(idx, 'quantity', e.target.value)}
              />
            </td>
            <td>
              <input
                type="text"
                placeholder="Kg / Nos"
                value={item.unit}
                onChange={(e) => handleFieldChange(idx, 'unit', e.target.value)}
              />
            </td>
            <td>
              <input
                type="number"
                value={item.rate}
                onChange={(e) => handleFieldChange(idx, 'rate', e.target.value)}
              />
            </td>
            <td>
              <input
                type="text"
                readOnly
                value={money(amount)}
                style={{ background: '#e5e7eb', cursor: 'not-allowed' }}
              />
            </td>
            <td className="action-column">
              <button
                type="button"
                className="button-secondary button-small button-delete"
                onClick={() => setForm((prev) => ({ ...prev, items: prev.items.filter((_, i) => i !== idx) }))}
                disabled={form.items.length === 1}
              >
                Remove
              </button>
            </td>
          </tr>
        );
      })}
    </tbody>
  );

  return (
    <div className="page-section">
      <div className="page-header">
        <div>
          <p className="eyebrow">Export Documentation</p>
          <h1>
            {mode === 'create'
              ? editingRef
                ? `Edit Export Invoice: ${editingRef}`
                : 'Create Export Invoice'
              : mode === 'view'
              ? `Export Invoice: ${selected?.reference || ''}`
              : 'Export Invoices'}
          </h1>
          {mode === 'list' && (
            <p className="page-description">
              Invoice cum Packing List for export shipments — buyer, logistics, USD line items, bank and
              declaration as per the export invoice specification.
            </p>
          )}
        </div>
        <div className="header-actions no-print">
          <img className="page-header-logo" src={logoUrl} alt="PRAGMATIC ENGINEERS logo" />
          {mode !== 'list' ? (
            <button className="button-secondary" onClick={() => setMode('list')}>
              Back to List
            </button>
          ) : (
            <button className="button-primary" onClick={openCreate}>
              + New Export Invoice
            </button>
          )}
        </div>
      </div>

      {/* ---------------------------------- list ---------------------------------- */}
      {mode === 'list' && (
        <div className="form-section">
          <table className="item-table">
            <thead>
              <tr>
                <th>Invoice No.</th>
                <th>Date</th>
                <th>Buyer (Bill To)</th>
                <th className="text-right">Amount (USD)</th>
                <th>Status</th>
                <th className="action-column">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '18px', color: '#64748b' }}>
                    No export invoices yet. Click "New Export Invoice" to create one.
                  </td>
                </tr>
              )}
              {list.map((entry) => (
                <tr key={entry.reference}>
                  <td style={{ fontWeight: 600 }}>{entry.reference}</td>
                  <td>{entry.date || '-'}</td>
                  <td>{entry.buyer || entry.payload?.buyer?.name || '-'}</td>
                  <td className="text-right">USD {money(entry.payload?.totals?.amountUSD)}</td>
                  <td>{entry.status || 'Draft'}</td>
                  <td className="action-column">
                    <button
                      type="button"
                      className="button-secondary button-small"
                      onClick={() => openView(entry.reference)}
                    >
                      Open
                    </button>{' '}
                    <button
                      type="button"
                      className="button-secondary button-small button-delete"
                      onClick={() => handleDelete(entry.reference)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --------------------------------- create --------------------------------- */}
      {mode === 'create' && (
        <form onSubmit={handleSave}>
          <div className="form-section">
            <div className="section-heading">
              <h3>Invoice Details</h3>
            </div>
            <div className="section-grid">
              <div className="field-group">
                <label>Invoice No.</label>
                <input
                  type="text"
                  value={form.invoiceNumber}
                  onChange={(e) => setField('invoiceNumber', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Invoice Date</label>
                <input
                  type="date"
                  value={form.invoiceDate}
                  onChange={(e) => setField('invoiceDate', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Exporter Ref</label>
                <input
                  type="text"
                  value={form.exporterRef}
                  onChange={(e) => setField('exporterRef', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Buyer's Order No.</label>
                <input
                  type="text"
                  value={form.buyersOrderNo}
                  onChange={(e) => setField('buyersOrderNo', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Buyer's Order Date</label>
                <input
                  type="date"
                  value={form.buyersOrderDate}
                  onChange={(e) => setField('buyersOrderDate', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Status</label>
                <select value={form.status} onChange={(e) => setField('status', e.target.value)}>
                  <option value="Draft">Draft</option>
                  <option value="Issued">Issued</option>
                </select>
              </div>
              {form.source?.soNumber && (
                <div className="field-group">
                  <label>Source Sales Order</label>
                  <div>
                    {form.source.soNumber}
                    {form.source.quotationRef ? ` (Quotation: ${form.source.quotationRef})` : ''}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="form-section">
            <div className="section-heading">
              <h3>Export Profile (IEC / LUT / Bank SWIFT)</h3>
            </div>
            <div className="section-grid">
              <div className="field-group">
                <label>Contact Person</label>
                <input
                  type="text"
                  value={profile.contactPerson}
                  onChange={(e) => setProfile({ ...profile, contactPerson: e.target.value })}
                />
              </div>
              <div className="field-group">
                <label>Contact No.</label>
                <input
                  type="text"
                  value={profile.contactNo}
                  onChange={(e) => setProfile({ ...profile, contactNo: e.target.value })}
                />
              </div>
              <div className="field-group">
                <label>IEC NO.</label>
                <input
                  type="text"
                  value={profile.iecNumber}
                  onChange={(e) => setProfile({ ...profile, iecNumber: e.target.value })}
                />
              </div>
              <div className="field-group">
                <label>LUT NO.</label>
                <input
                  type="text"
                  value={profile.lutNumber}
                  onChange={(e) => setProfile({ ...profile, lutNumber: e.target.value })}
                />
              </div>
              <div className="field-group">
                <label>SWIFT Code</label>
                <input
                  type="text"
                  value={profile.swiftCode}
                  onChange={(e) => setProfile({ ...profile, swiftCode: e.target.value })}
                />
              </div>
              <div className="field-group full-width">
                <small className="field-hint">
                  Bank name, branch and account number are taken from Company Settings. Profile values are
                  saved with the invoice.
                </small>
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="section-heading">
              <h3>Buyer (Bill To) &amp; Ship To</h3>
            </div>
            <div className="section-grid">
              <div className="field-group">
                <label>Buyer Name *</label>
                <input
                  type="text"
                  value={form.buyer.name}
                  onChange={(e) => setNested('buyer', 'name', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Buyer Contact Person</label>
                <input
                  type="text"
                  value={form.buyer.contactPerson}
                  onChange={(e) => setNested('buyer', 'contactPerson', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Buyer Contact No.</label>
                <input
                  type="text"
                  value={form.buyer.contactNo}
                  onChange={(e) => setNested('buyer', 'contactNo', e.target.value)}
                />
              </div>
              <div className="field-group full-width">
                <label>Buyer Address</label>
                <textarea
                  rows="2"
                  value={form.buyer.address}
                  onChange={(e) => setNested('buyer', 'address', e.target.value)}
                />
              </div>
              <div className="field-group full-width">
                <label>Ship To (Consignee Address)</label>
                <textarea
                  rows="2"
                  value={form.shipToAddress}
                  onChange={(e) => setField('shipToAddress', e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="section-heading">
              <h3>Shipping &amp; Logistics</h3>
            </div>
            <div className="section-grid">
              <div className="field-group">
                <label>Pre-Carriage by</label>
                <input
                  type="text"
                  value={form.logistics.preCarriage}
                  onChange={(e) => setNested('logistics', 'preCarriage', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Place of Receipt</label>
                <input
                  type="text"
                  value={form.logistics.placeOfReceipt}
                  onChange={(e) => setNested('logistics', 'placeOfReceipt', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Port of Loading</label>
                <input
                  type="text"
                  value={form.logistics.portOfLoading}
                  onChange={(e) => setNested('logistics', 'portOfLoading', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Port of Discharge</label>
                <input
                  type="text"
                  value={form.logistics.portOfDischarge}
                  onChange={(e) => setNested('logistics', 'portOfDischarge', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Final Destination</label>
                <input
                  type="text"
                  value={form.logistics.finalDestination}
                  onChange={(e) => setNested('logistics', 'finalDestination', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Vessel / Flight No.</label>
                <input
                  type="text"
                  value={form.logistics.vesselFlight}
                  onChange={(e) => setNested('logistics', 'vesselFlight', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Marks &amp; Numbers</label>
                <input
                  type="text"
                  value={form.logistics.marksNumbers}
                  onChange={(e) => setNested('logistics', 'marksNumbers', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Container No.</label>
                <input
                  type="text"
                  value={form.logistics.containerNo}
                  onChange={(e) => setNested('logistics', 'containerNo', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Other Reference(s)</label>
                <input
                  type="text"
                  value={form.logistics.otherReferences}
                  onChange={(e) => setNested('logistics', 'otherReferences', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Country of Origin</label>
                <input
                  type="text"
                  value={form.countryOfOrigin}
                  onChange={(e) => setField('countryOfOrigin', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Country of Final Destination</label>
                <input
                  type="text"
                  value={form.countryOfDestination}
                  onChange={(e) => setField('countryOfDestination', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Terms of Delivery</label>
                <input
                  type="text"
                  value={form.termsOfDelivery}
                  onChange={(e) => setField('termsOfDelivery', e.target.value)}
                />
              </div>
              <div className="field-group">
                <label>Payment Terms</label>
                <input
                  type="text"
                  value={form.paymentTerms}
                  onChange={(e) => setField('paymentTerms', e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="section-heading">
              <h3>Items (USD)</h3>
            </div>
            <div className="item-table-wrapper">
              <table className="item-table">
                <thead>
                  <tr>
                    <th style={{ width: '40px' }}>SL.No</th>
                    <th style={{ width: '150px' }}>No. &amp; Kind of Packages</th>
                    <th>Description of Goods</th>
                    <th style={{ width: '110px' }}>Quantity</th>
                    <th style={{ width: '100px' }}>Unit</th>
                    <th style={{ width: '120px' }}>Rate (USD)</th>
                    <th style={{ width: '140px' }}>Amount (USD)</th>
                    <th className="action-column">Action</th>
                  </tr>
                </thead>
                {ItemRows}
                <tfoot>
                  <tr>
                    <td colSpan={7}>
                      <button
                        type="button"
                        className="button-secondary button-small"
                        onClick={() => setForm((prev) => ({ ...prev, items: [...prev.items, { ...emptyItem }] }))}
                      >
                        + Add Item
                      </button>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="tax-summary">
              <div className="tax-summary-row">
                <span>Net Weight</span>
                <input
                  type="text"
                  value={form.netWeight}
                  onChange={(e) => setField('netWeight', e.target.value)}
                  className="discount-input"
                />
              </div>
              <div className="tax-summary-row">
                <span>Gross Weight</span>
                <input
                  type="text"
                  value={form.grossWeight}
                  onChange={(e) => setField('grossWeight', e.target.value)}
                  className="discount-input"
                />
              </div>
              <div className="tax-summary-row total">
                <span>Total Invoice Value</span>
                <strong>USD {money(totals.amountUSD)}</strong>
              </div>
              <div className="amount-in-words">
                <span>Amount Chargeable in words</span>
                <p>{amountWords}</p>
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="section-heading">
              <h3>Declaration</h3>
            </div>
            <div className="field-group full-width">
              <textarea
                rows="3"
                value={form.declaration}
                onChange={(e) => setField('declaration', e.target.value)}
              />
            </div>
          </div>

          <div className="form-actions">
            <button type="button" className="button-secondary" onClick={() => setMode('list')}>
              Cancel
            </button>
            <button type="submit" className="button-primary">
              {editingRef ? 'Update Export Invoice' : 'Save Export Invoice'}
            </button>
          </div>
        </form>
      )}

      {/* ---------------------------------- view ---------------------------------- */}
      {mode === 'view' && selected && (
        <div>
          <div
            className="no-print"
            style={{ display: 'flex', gap: '10px', marginBottom: '20px', justifyContent: 'flex-end' }}
          >
            <button className="button-primary" onClick={handleDownloadPDF}>
              Download PDF
            </button>
            <button className="button-secondary" onClick={handlePrintPDF}>
              Print
            </button>
            <button className="button-secondary" onClick={openEdit}>
              Edit
            </button>
            <button
              className="button-secondary button-delete"
              onClick={() => handleDelete(selected.reference)}
            >
              Delete
            </button>
          </div>

          <div className="form-section">
            <div className="section-heading">
              <h3>
                {selected.reference} — {selected.payload?.invoiceDate || ''}
              </h3>
            </div>
            <div className="section-grid">
              <div className="field-group">
                <label>Status</label>
                <div>{selected.payload?.status || 'Draft'}</div>
              </div>
              <div className="field-group">
                <label>Source Sales Order</label>
                <div>{selected.payload?.source?.soNumber || '-'}</div>
              </div>
              <div className="field-group">
                <label>Exporter Ref</label>
                <div>{selected.payload?.exporterRef || '-'}</div>
              </div>
              <div className="field-group">
                <label>Buyer's Order No.</label>
                <div>
                  {selected.payload?.buyersOrderNo || '-'}{' '}
                  {selected.payload?.buyersOrderDate ? `Dated: ${selected.payload.buyersOrderDate}` : ''}
                </div>
              </div>
              <div className="field-group">
                <label>Payment Terms</label>
                <div>{selected.payload?.paymentTerms || '-'}</div>
              </div>
              <div className="field-group full-width">
                <label>Buyer (Bill To)</label>
                <div>
                  <strong>{selected.payload?.buyer?.name || '-'}</strong>
                  <div>{selected.payload?.buyer?.address || ''}</div>
                  <div>
                    Contact: {selected.payload?.buyer?.contactPerson || '-'} |{' '}
                    {selected.payload?.buyer?.contactNo || '-'}
                  </div>
                </div>
              </div>
              <div className="field-group full-width">
                <label>Ship To</label>
                <div>{selected.payload?.shipToAddress || '-'}</div>
              </div>
              <div className="field-group">
                <label>Port of Loading</label>
                <div>{selected.payload?.logistics?.portOfLoading || '-'}</div>
              </div>
              <div className="field-group">
                <label>Port of Discharge</label>
                <div>{selected.payload?.logistics?.portOfDischarge || '-'}</div>
              </div>
              <div className="field-group">
                <label>Vessel / Flight</label>
                <div>{selected.payload?.logistics?.vesselFlight || '-'}</div>
              </div>
              <div className="field-group">
                <label>Country of Destination</label>
                <div>{selected.payload?.countryOfDestination || '-'}</div>
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="section-heading">
              <h3>Items</h3>
            </div>
            <table className="item-table">
              <thead>
                <tr>
                  <th>SL.No</th>
                  <th>Packages</th>
                  <th>Description of Goods</th>
                  <th className="text-right">Quantity</th>
                  <th className="text-right">Rate (USD)</th>
                  <th className="text-right">Amount (USD)</th>
                </tr>
              </thead>
              <tbody>
                {(selected.payload?.items || []).map((it, idx) => (
                  <tr key={idx}>
                    <td style={{ textAlign: 'center' }}>{idx + 1}</td>
                    <td>{it.packages || '-'}</td>
                    <td>{it.description || '-'}</td>
                    <td className="text-right">
                      {it.quantity}
                      {it.unit ? ` ${it.unit}` : ''}
                    </td>
                    <td className="text-right">{money(it.rate)}</td>
                    <td className="text-right">{money(it.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="tax-summary">
              <div className="tax-summary-row total">
                <span>Total Invoice Value</span>
                <strong>USD {money(selected.payload?.totals?.amountUSD)}</strong>
              </div>
              <div className="amount-in-words">
                <span>Amount Chargeable in words</span>
                <p>{selected.payload?.amountInWords || '-'}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExportInvoicePage;
