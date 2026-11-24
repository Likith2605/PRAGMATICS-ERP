import React, { useMemo, useState } from 'react';
import { generateRegisterPDF } from '../services/pdfGenerator.js';
import {
  getVendorMaster,
  addVendorToMaster,
  updateVendorInMaster,
  deleteVendorFromMaster,
  getProductCategories
} from '../utils/vendorMaster.js';
import { getAllVendorEnquiries, getAllVendorQuotations } from '../utils/storeService.js';

const EMPTY_FORM = { product: '', name: '', address: '', phone: '', email: '' };

const loadList = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
};

const norm = (v) => String(v || '').trim().toLowerCase();

const VendorMasterPage = () => {
  const [vendors, setVendors] = useState(() => getVendorMaster());
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editSeq, setEditSeq] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');

  const productOptions = useMemo(() => getProductCategories().slice(1), [vendors]);

  const usageSources = useMemo(
    () => ({
      pos: loadList('supplierPOHistory'),
      bills: loadList('supplierInvoiceHistory'),
      advances: loadList('supplierAdvanceHistory'),
      returns: loadList('purchaseReturnHistory'),
      enquiries: getAllVendorEnquiries(),
      quotations: getAllVendorQuotations()
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vendors]
  );

  const usageFor = (name) => {
    const n = norm(name);
    const eq = (v) => norm(v) === n;
    const po = usageSources.pos.filter((r) => eq(r.vendor) || eq(r.vendorDetails?.companyName)).length;
    const bill = usageSources.bills.filter((r) => eq(r.vendor) || eq(r.vendorDetails?.companyName)).length;
    const adv = usageSources.advances.filter((r) => eq(r.party)).length;
    const ret = usageSources.returns.filter((r) => eq(r.returnedTo) || eq(r.supplier)).length;
    const enq = usageSources.enquiries.filter((r) => (r.vendors || []).some((v) => eq(v.name))).length;
    const vq = usageSources.quotations.filter((r) => eq(r.vendorName)).length;
    return { po, bill, adv, ret, enq, vq, total: po + bill + adv + ret + enq + vq };
  };

  const filtered = useMemo(() => {
    const q = norm(search);
    return vendors.filter((v) => {
      if (category && norm(v.product) !== norm(category)) return false;
      if (!q) return true;
      return (
        norm(v.name).includes(q) ||
        norm(v.product).includes(q) ||
        norm(v.address).includes(q) ||
        norm(v.phone).includes(q) ||
        norm(v.email).includes(q)
      );
    });
  }, [vendors, search, category]);

  const openAdd = () => {
    setEditSeq(null);
    setForm(EMPTY_FORM);
    setError('');
    setShowModal(true);
  };

  const openEdit = (v) => {
    setEditSeq(v.seq);
    setForm({
      product: v.product || '',
      name: v.name || '',
      address: v.address || '',
      phone: v.phone || '',
      email: v.email || ''
    });
    setError('');
    setShowModal(true);
  };

  const handleSave = (e) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) return setError('Vendor name is required.');
    try {
      const payload = {
        product: form.product.trim() || 'Other',
        name: form.name.trim(),
        address: form.address.trim(),
        phone: form.phone.trim(),
        email: form.email.trim()
      };
      if (editSeq != null) updateVendorInMaster(editSeq, payload);
      else addVendorToMaster(payload);
      setVendors(getVendorMaster());
      setShowModal(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = (v) => {
    const u = usageFor(v.name);
    const warn =
      u.total > 0
        ? `"${v.name}" is used in ${u.total} record(s) — PO ${u.po}, Bill ${u.bill}, Advance ${u.adv}, Return ${u.ret}, Enquiry ${u.enq}, Quotation ${u.vq}.\n\nDelete from Vendor Master anyway? Existing documents keep their saved copy.`
        : `Delete vendor "${v.name}" from the Vendor Master?`;
    if (!window.confirm(warn)) return;
    deleteVendorFromMaster(v.seq);
    setVendors(getVendorMaster());
  };

  const usageLabel = (u) => {
    const parts = [];
    if (u.po) parts.push(`PO ${u.po}`);
    if (u.bill) parts.push(`Bill ${u.bill}`);
    if (u.adv) parts.push(`Adv ${u.adv}`);
    if (u.ret) parts.push(`Ret ${u.ret}`);
    if (u.enq) parts.push(`Enq ${u.enq}`);
    if (u.vq) parts.push(`VQ ${u.vq}`);
    return parts.length ? parts.join(' · ') : '—';
  };

  const handlePDF = () => {
    const cols = [
      { header: 'Sl.No' },
      { header: 'Product / Service' },
      { header: 'Vendor Name' },
      { header: 'Address' },
      { header: 'Phone' },
      { header: 'Email' },
      { header: 'POs', align: 'right' },
      { header: 'Bills', align: 'right' },
      { header: 'Advances', align: 'right' },
      { header: 'Returns', align: 'right' },
      { header: 'Enquiries', align: 'right' },
      { header: 'Quotations', align: 'right' }
    ];
    generateRegisterPDF({
      title: 'Vendor Master',
      subTitle: `${filtered.length} vendor(s)`,
      period: `Filter: ${category || 'All Categories'}${search ? ` · Search: "${search}"` : ''}`,
      columns: cols,
      rows: filtered.map((v) => {
        const u = usageFor(v.name);
        return [
          String(v.seq),
          v.product || '',
          v.name,
          v.address || '-',
          v.phone || '-',
          v.email || '-',
          String(u.po),
          String(u.bill),
          String(u.adv),
          String(u.ret),
          String(u.enq),
          String(u.vq)
        ];
      }),
      footer: ['TOTAL', '', `${filtered.length} vendors`, '', '', '', '', '', '', '', '', ''],
      filename: `Vendor-Master-${new Date().toISOString().slice(0, 10)}`
    });
  };

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <div className="eyebrow">Purchase</div>
          <h1 className="page-title">Vendor Master</h1>
          <p className="page-description">
            Central vendor list shared by Purchase Orders, Supplier Bills, Advances, Purchase Returns, Vendor Enquiries and Vendor
            Quotations. Selecting a vendor from this master keeps every purchase document connected.
          </p>
        </div>
        <div className="header-actions">
          <button type="button" className="button-primary" onClick={openAdd}>
            + Add Vendor
          </button>
        </div>
      </div>

      <div className="content-block report-register">
        <div className="block-header">
          <h3 className="block-title">Vendors</h3>
          <span className="muted-text">
            {filtered.length} shown / {vendors.length} total
          </span>
        </div>

        <div className="report-filter-bar">
          <input
            type="text"
            className="action-select form-input search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name / product / address / phone / email..."
          />
          <select className="action-select" value={category} onChange={(e) => setCategory(e.target.value === 'All Categories' ? '' : e.target.value)}>
            <option value="">All Categories</option>
            {productOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button type="button" className="button-secondary button-small" onClick={handlePDF}>
            Download PDF
          </button>
          <button type="button" className="button-secondary button-small" onClick={() => window.print()}>
            Print
          </button>
        </div>

        <div className="history-table-wrapper">
          <table className="history-table report-table">
            <thead>
              <tr>
                <th>SL.No</th>
                <th>Product / Service</th>
                <th>Vendor Name</th>
                <th>Address</th>
                <th>Contact (Phone / Email)</th>
                <th>Used In</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="no-history-row">
                    No vendors match the search / category.
                  </td>
                </tr>
              ) : (
                filtered.map((v) => {
                  const u = usageFor(v.name);
                  return (
                    <tr key={v.seq}>
                      <td>{v.seq}</td>
                      <td>{v.product || '-'}</td>
                      <td>
                        <strong>{v.name}</strong>
                      </td>
                      <td>{v.address || '-'}</td>
                      <td>
                        {v.phone || v.email ? (
                          <>
                            {v.phone && <div>{v.phone}</div>}
                            {v.email && <div>{v.email}</div>}
                          </>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="vendor-usage-cell">{usageLabel(u)}</td>
                      <td>
                        <button type="button" className="button-secondary button-small" onClick={() => openEdit(v)}>
                          Edit
                        </button>{' '}
                        <button type="button" className="button-secondary button-small danger" onClick={() => handleDelete(v)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <div className="template-modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="template-modal" onClick={(e) => e.stopPropagation()}>
            <div className="template-modal-header">
              <h3>{editSeq != null ? `Edit Vendor #${editSeq}` : 'Add Vendor'}</h3>
              <button type="button" className="template-modal-close" onClick={() => setShowModal(false)} aria-label="Close">
                &times;
              </button>
            </div>

            <form className="form-grid" onSubmit={handleSave}>
              <div className="form-field">
                <label>Product / Service</label>
                <input
                  type="text"
                  className="action-select form-input"
                  list="vendor-master-products"
                  value={form.product}
                  onChange={(e) => setForm({ ...form, product: e.target.value })}
                  placeholder="e.g. Machining, Hardware"
                />
                <datalist id="vendor-master-products">
                  {productOptions.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </div>
              <div className="form-field">
                <label>Vendor Name *</label>
                <input
                  type="text"
                  className="action-select form-input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Company name"
                />
              </div>
              <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                <label>Address</label>
                <input
                  type="text"
                  className="action-select form-input"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="Street, area, city - PIN"
                />
              </div>
              <div className="form-field">
                <label>Phone (WhatsApp)</label>
                <input
                  type="tel"
                  className="action-select form-input"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="e.g. +91 9880030466"
                />
              </div>
              <div className="form-field">
                <label>Email</label>
                <input
                  type="email"
                  className="action-select form-input"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="purchase@vendor.com"
                />
              </div>

              {error && (
                <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                  <div className="form-error">{error}</div>
                </div>
              )}

              <div className="form-field" style={{ gridColumn: '1 / -1', display: 'flex', gap: '10px' }}>
                <button type="submit" className="button-primary">
                  {editSeq != null ? 'Save Changes' : '+ Add Vendor'}
                </button>
                <button type="button" className="button-secondary" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
};

export default VendorMasterPage;
