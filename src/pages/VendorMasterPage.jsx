import React, { useEffect, useMemo, useState } from 'react';
import { generateRegisterPDF } from '../services/pdfGenerator.js';
import { VENDOR_CATEGORIES } from '../utils/vendorMaster.js';
import { listMasters, createMaster, updateMaster, deleteMaster } from '../services/masterApi.js';
import { getAllVendorEnquiries, getAllVendorQuotations } from '../utils/storeService.js';
import { listPurchaseOrders, listSupplierInvoicesApi } from '../services/procurementIntakeApi.js';
import { listAdvances } from '../services/advanceApi.js';
import { listPurchaseReturns } from '../services/commercialReturnsApi.js';
import { isAdmin } from '../utils/auth.js';

const EMPTY_FORM = { product: '', name: '', vendorCode: '', address: '', contactPerson: '', phone: '', email: '' };

const norm = (v) => String(v || '').trim().toLowerCase();

const VendorMasterPage = () => {
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editSeq, setEditSeq] = useState(null);
  const [editVersion, setEditVersion] = useState(0);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');

  const refresh = async () => {
    const records = await listMasters('vendors');
    setVendors(records);
    setLoadError('');
    return records;
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    listMasters('vendors')
      .then((records) => { if (active) { setVendors(records); setLoadError(''); } })
      .catch((err) => { if (active) setLoadError(err.message || 'Vendors could not be loaded from PostgreSQL.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const productOptions = useMemo(() => {
    const set = new Set(VENDOR_CATEGORIES.slice(1));
    vendors.forEach((vendor) => { if (vendor.product) set.add(vendor.product); });
    return [...set];
  }, [vendors]);

  /* Usage counts come from PostgreSQL-backed lists (Purchase Orders and
   * Supplier Invoices are owned by the API); the browser copies are caches of
   * those confirmed responses. */
  const [serverPOs, setServerPOs] = useState([]);
  const [serverInvoices, setServerInvoices] = useState([]);
  const [serverAdvances, setServerAdvances] = useState([]);
  const [serverReturns, setServerReturns] = useState([]);
  const [usageLoadError, setUsageLoadError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([listPurchaseOrders(), listSupplierInvoicesApi(), listAdvances('supplier'), listPurchaseReturns()])
      .then(([orders, invoices, advances, returns]) => {
        if (!active) return;
        setServerPOs(orders);
        setServerInvoices(invoices);
        setServerAdvances(advances);
        setServerReturns(returns);
        setUsageLoadError('');
      })
      .catch((error) => { if (active) setUsageLoadError(`Usage counts could not be loaded from PostgreSQL: ${error.message}`); });
    return () => { active = false; };
  }, []);

  const usageSources = useMemo(
    () => ({
      pos: serverPOs,
      bills: serverInvoices,
      advances: serverAdvances,
      returns: serverReturns,
      enquiries: getAllVendorEnquiries(),
      quotations: getAllVendorQuotations()
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vendors, serverPOs, serverInvoices, serverAdvances, serverReturns]
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
        norm(v.contactPerson).includes(q) ||
        norm(v.phone).includes(q) ||
        norm(v.email).includes(q)
      );
    });
  }, [vendors, search, category]);

  const openAdd = () => {
    setEditSeq(null);
    setEditVersion(0);
    setForm(EMPTY_FORM);
    setError('');
    setShowModal(true);
  };

  const openEdit = (v) => {
    setEditSeq(v.seq);
    setEditVersion(Number(v.version) || 1);
    setForm({
      product: v.product || '',
      name: v.name || '',
      vendorCode: v.vendorCode || '',
      address: v.address || '',
      contactPerson: v.contactPerson || '',
      phone: v.phone || '',
      email: v.email || ''
    });
    setError('');
    setShowModal(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) return setError('Vendor name is required.');
    const payload = {
      product: form.product.trim() || 'Other',
      name: form.name.trim(),
      vendorCode: form.vendorCode.trim(),
      address: form.address.trim(),
      contactPerson: form.contactPerson.trim(),
      phone: form.phone.trim(),
      email: form.email.trim()
    };
    setBusy(true);
    try {
      if (editSeq != null) {
        const vendor = vendors.find((v) => String(v.seq) === String(editSeq));
        if (!vendor) throw new Error('Vendor record is no longer available. Refresh and try again.');
        await updateMaster('vendors', vendor.id, payload, editVersion);
      } else {
        await createMaster('vendors', payload);
      }
      await refresh();
      setShowModal(false);
    } catch (err) {
      if (err.status === 409) {
        setError(`${err.message} The PostgreSQL copy was kept. Refreshing the list.`);
        refresh().catch(() => {});
      } else setError(err.message || 'Vendor could not be saved. Please try again.');
    } finally { setBusy(false); }
  };

  const handleDelete = async (v) => {
    const u = usageFor(v.name);
    if (u.total > 0) { window.alert(`Supplier ${v.name} is referenced by ${u.total} business record(s) and cannot be deleted.`); return; }
    const warn = `Delete unused supplier "${v.name}" from the Vendor Master?`;
    if (!window.confirm(warn)) return;
    setBusy(true);
    try {
      await deleteMaster('vendors', v.id, Number(v.version) || 1, 'Deleted unused supplier from Vendor Master');
      await refresh();
    } catch (err) {
      window.alert(err.message || 'Vendor could not be deleted.');
      if (err.status === 409) refresh().catch(() => {});
    } finally { setBusy(false); }
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
      {usageLoadError && <div role="alert" className="form-error" style={{ marginBottom: 12 }}>{usageLoadError}</div>}
      {loadError && <div role="alert" className="form-error" style={{ marginBottom: 12 }}>{loadError} <button type="button" className="button-secondary button-small" onClick={() => refresh().catch((err) => setLoadError(err.message))}>Retry</button></div>}
      <div className="page-header">
        <div>
          <h1 className="page-title">Vendor Master</h1>
        </div>
        <div className="header-actions">
          <button type="button" className="button-primary" onClick={openAdd} disabled={loading || busy}>
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
          <button type="button" className="button-secondary button-small" onClick={handlePDF} disabled={loading}>
            Download PDF
          </button>
          <button type="button" className="button-secondary button-small" onClick={() => window.print()} disabled={loading}>
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
                <th>Contact Details</th>
                <th>Used In</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="no-history-row">Loading vendors from PostgreSQL…</td></tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="no-history-row">
                    {vendors.length === 0 ? 'No vendors on record. Add the first vendor.' : 'No vendors match the search / category.'}
                  </td>
                </tr>
              ) : (
                filtered.map((v) => {
                  const u = usageFor(v.name);
                  return (
                    <tr key={v.id}>
                      <td>{v.seq}</td>
                      <td>{v.product || '-'}</td>
                      <td>
                        <strong>{v.name}</strong>
                      </td>
                      <td>{v.address || '-'}</td>
                      <td>
                        {v.contactPerson || v.phone || v.email ? (
                          <>
                            {v.contactPerson && <div>{v.contactPerson}</div>}
                            {v.phone && <div>{v.phone}</div>}
                            {v.email && <div>{v.email}</div>}
                          </>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="vendor-usage-cell">{usageLabel(u)}</td>
                      <td>
                        <button type="button" className="button-secondary button-small" onClick={() => openEdit(v)} disabled={busy}>
                          Edit
                        </button>{' '}
                        {isAdmin() && u.total === 0 && <button type="button" className="button-secondary button-small danger" onClick={() => handleDelete(v)} disabled={busy}>
                          Delete
                        </button>}
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
              <div className="form-field">
                <label>Vendor Code</label>
                <input
                  type="text"
                  className="action-select form-input"
                  value={form.vendorCode}
                  onChange={(e) => setForm({ ...form, vendorCode: e.target.value })}
                  placeholder="Preserved from the vendor master"
                />
              </div>
              <div className="form-field">
                <label>Contact Person</label>
                <input
                  type="text"
                  className="action-select form-input"
                  value={form.contactPerson}
                  onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
                  placeholder="Contact person"
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
                  placeholder="e.g. +91 9876543210"
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
                <button type="submit" className="button-primary" disabled={busy}>
                  {busy ? 'Saving…' : editSeq != null ? 'Save Changes' : '+ Add Vendor'}
                </button>
                <button type="button" className="button-secondary" onClick={() => setShowModal(false)} disabled={busy}>
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
