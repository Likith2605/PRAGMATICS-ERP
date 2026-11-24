import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { readLocalStorageList } from '../utils/reportData.js';
import { invTotalINR, invBalanceINR } from '../utils/invoiceValues.js';
import { generateRegisterPDF } from '../services/pdfGenerator.js';
import CustomerRegistrationModal from '../components/CustomerRegistrationModal.jsx';
import { readCustomerDirectory } from '../utils/customerDirectory.js';
import { matchesCustomerSearch } from '../utils/customerSearch.js';
import ExcelImportDialog, { downloadImportTemplate } from '../components/ExcelImportDialog.jsx';
import { Download, Upload, Trash2 } from 'lucide-react';
import { saveCustomerToDirectory } from '../utils/customerDirectory.js';
import { appendAuditLog } from '../utils/storeService.js';
import { saveERPRecord, getERPRecord, deleteCustomerDirectoryRecord, resetERPStateSyncBaseline } from '../services/erpStateSync.js';
import { isAdmin } from '../utils/auth.js';
import { CUSTOMER_EXCEL_COLUMNS, mapCustomerExcelRow, validateCustomerExcelRow } from '../utils/customerExcelImport.js';

/**
 * Customers — Vyapar-style Parties page.
 *
 *  - Left: searchable party list with "You'll Get" balances, filter tabs
 *    (All / You'll Get / Settled), avatar initials and phone numbers.
 *  - Right: party details — balance card, quick action buttons (new
 *    Quotation / Sales Order / Challan / Invoice) and a chronological
 *    transaction ledger grouped by month, with a Download Ledger PDF
 *    (statement of account) button.
 *
 * Data is read from quotationHistory, salesOrderHistory,
 * deliveryChallanHistory, customerInvoiceHistory and exportInvoiceHistory.
 *
 * Same safeguard rules as List of Customers (reports/CustomerListPage):
 * links between master records and transactions use EXACT normalized-name
 * equality only (trimmed, whitespace-collapsed, case-insensitive). Partial /
 * fuzzy matching is used ONLY in the search box (filtering), never to merge
 * records.
 */

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();

const parseINR = (v) => Number(String(v || '').replace(/[^0-9.-]/g, '')) || 0;

const DOC = {
  QT: { label: 'Quotation', color: '#0369a1', bg: '#e0f2fe' },
  SO: { label: 'Sales Order', color: '#1d4ed8', bg: '#dbeafe' },
  DC: { label: 'Delivery Challan', color: '#b45309', bg: '#fef3c7' },
  INV: { label: 'Tax Invoice', color: '#166534', bg: '#dcfce7' },
  EINV: { label: 'Export Invoice', color: '#7c3aed', bg: '#ede9fe' }
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CUSTOMER_IMPORT_EXAMPLE = ['1','Example Manufacturing Ltd','10 Industrial Road, Bengaluru','29ABCDE1234F1Z5','9880030466','Asha Kumar','9876543210','asha@example.com','VEND-001'];
const CUSTOMER_IMPORT_INSTRUCTIONS = [
  'Only Customer Name is required. All other columns are optional, may be blank and may be repeated across customers.',
  'Tel No. is the customer phone; Contact Person No is the contact person\'s own phone number.',
  'Exact duplicate customer rows are shown as warnings; the administrator chooses whether to import them.',
  'Heading matching is case-insensitive and tolerates minor spacing/punctuation differences.'
];

const relDate = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(d || '-');
};

const monthLabel = (d) => {
  const m = /^(\d{4})-(\d{2})/.exec(String(d || ''));
  if (!m) return 'Older / Undated';
  const y = Number(m[1]);
  const mi = Number(m[2]) - 1;
  if (mi < 0 || mi > 11) return 'Older / Undated';
  return `${MONTHS[mi]} ${y}`;
};

const itemsSummary = (t) => {
  const raw = t.raw || {};
  if (t.kind === 'EINV') {
    const items = raw.payload?.items || [];
    if (items.length === 0) return '-';
    const first = items[0]?.description || items[0]?.itemName || '';
    return items.length > 1 ? `${first} +${items.length - 1} more` : first || '-';
  }
  const items = raw.payload?.items || [];
  if (items.length === 0) return '-';
  const first = items[0]?.itemName || items[0]?.item || '';
  if (!first) return `${items.length} item(s)`;
  return items.length > 1 ? `${first} +${items.length - 1} more` : first;
};

// Amount (INR) used for "You'll Get" math. Export invoices are USD and are
// NOT converted; they are shown separately and excluded from INR totals.
const txTotalINR = (t) => {
  if (t.kind === 'INV') return invTotalINR(t.raw);
  if (t.kind === 'EINV') return 0;
  if (t.kind === 'QT') return parseINR(t.raw?.total);
  return Number(t.raw?.amountINR) || 0;
};

const amountCell = (t) => {
  if (t.kind === 'EINV') {
    const usd = Number(t.raw?.payload?.totals?.amountUSD) || 0;
    return <span style={{ fontWeight: 700, color: '#0f172a' }}>${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>;
  }
  const total = txTotalINR(t);
  const cur = t.raw?.currency && t.raw.currency !== 'INR' ? t.raw.currency : '';
  return (
    <>
      <span style={{ fontWeight: 700, color: '#0f172a' }}>{`₹${total.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}</span>
      {cur ? <span style={{ color: '#9ca3af', fontSize: '10px', display: 'block' }}>{t.raw.total}</span> : null}
    </>
  );
};

const statusColor = (s) => {
  const v = String(s || '').toLowerCase();
  if (v.includes('paid') && !v.includes('un') && !v.includes('partial')) return { color: '#15803d', bg: '#dcfce7' };
  if (v.includes('partial')) return { color: '#b45309', bg: '#fef3c7' };
  if (v.includes('unpaid') || v.includes('pending') || v.includes('due')) return { color: '#b91c1c', bg: '#fee2e2' };
  if (v.includes('converted')) return { color: '#7c3aed', bg: '#ede9fe' };
  return { color: '#0369a1', bg: '#e0f2fe' };
};

const AVATAR = ['#2563eb', '#0f766e', '#b45309', '#7c3aed', '#be123c', '#0369a1', '#4d7c0f'];
const avatarColor = (name) => {
  const s = norm(name);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR[h % AVATAR.length];
};

const CustomersPage = () => {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [listFilter, setListFilter] = useState('ALL'); // ALL | GET | SETTLED
  const [selectedKey, setSelectedKey] = useState('');
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [showExcelImport, setShowExcelImport] = useState(false);
  const [deleteCustomerTarget, setDeleteCustomerTarget] = useState(null);
  const [deleteCustomerBusy, setDeleteCustomerBusy] = useState(false);
  const [customerActionMessage, setCustomerActionMessage] = useState(null);
  const deleteCustomerInFlight = useRef(false);
  const lastRemoteDirectory = useRef(null);
  const adminUser = isAdmin();
  const customerImportColumns = CUSTOMER_EXCEL_COLUMNS;
  const importCustomers = async (rows) => {
    const before = localStorage.getItem('customerDirectory');
    let added = 0;
    try {
      for (const row of rows) {
        const mapped = mapCustomerExcelRow(row);
        saveCustomerToDirectory({
          slNo: mapped['Sl No'],
          companyName: mapped['Customer Name'],
          address: mapped['Address'],
          billingAddress: mapped['Address'],
          gstin: mapped['GST No'],
          gstNumber: mapped['GST No'],
          phone: mapped['Tel No.'],
          customerName: mapped['Contact Person'],
          contactPerson: mapped['Contact Person'],
          contactPersonPhone: mapped['Contact Person No'],
          contactNo: mapped['Contact Person No'],
          email: mapped['E-Mail'],
          customerCode: mapped['Vendor Code'],
          vendorCode: mapped['Vendor Code']
        }, { silent: true });
        added += 1;
      }
    } catch (error) {
      if (before == null) localStorage.removeItem('customerDirectory'); else localStorage.setItem('customerDirectory', before);
      throw error;
    }

    // Explicitly confirm the whole directory in PostgreSQL before reporting
    // success. The background mirror may also write this key; the write is an
    // idempotent whole-record upsert, so no customer is inserted twice.
    const persisted = await saveERPRecord('customerDirectory', readCustomerDirectory(), { withError: true });
    if (!persisted.ok) {
      if (before == null) localStorage.removeItem('customerDirectory'); else localStorage.setItem('customerDirectory', before);
      try { await saveERPRecord('customerDirectory', before == null ? [] : JSON.parse(before)); } catch { /* best effort rollback */ }
      throw new Error(persisted.error || 'Database save failed. Customers were not saved.');
    }

    window.dispatchEvent(new CustomEvent('customer-directory-updated'));
    appendAuditLog({ action: 'CUSTOMERS IMPORTED', reference: `${added} customer(s)`, details: `${added} customer records imported from Excel and confirmed in PostgreSQL.` });
    return { success: added, skipped: 0, persisted: true };
  };

  const confirmDeleteCustomer = async () => {
    const target = deleteCustomerTarget;
    if (!adminUser || !target?.id || deleteCustomerInFlight.current) return;
    deleteCustomerInFlight.current = true;
    setDeleteCustomerBusy(true);
    setCustomerActionMessage(null);
    try {
      const current = readCustomerDirectory();
      if (!current.some((customer) => String(customer?.id || '') === String(target.id))) {
        setCustomerActionMessage({ type: 'error', text: 'This customer is no longer in the directory. Refresh the page and try again.' });
        return;
      }
      const result = await deleteCustomerDirectoryRecord(target.id);
      if (!result.ok) {
        const linked = result.status === 409 || /transaction|business history|referenced/i.test(result.error || '');
        setCustomerActionMessage({
          type: 'error',
          text: linked
            ? 'This customer has transaction history and cannot be permanently deleted. Keep the customer record to preserve its linked history.'
            : result.error || 'Customer deletion failed. Please try again.'
        });
        return;
      }
      const latest = readCustomerDirectory();
      localStorage.setItem('customerDirectory', JSON.stringify(latest.filter((customer) => String(customer?.id || '') !== String(target.id))));
      resetERPStateSyncBaseline();
      window.dispatchEvent(new CustomEvent('customer-directory-updated'));
      setSelectedKey('');
      setCustomerActionMessage({ type: 'success', text: 'Customer deleted successfully.' });
      setDeleteCustomerTarget(null);
    } catch (error) {
      setCustomerActionMessage({ type: 'error', text: error?.message || 'Customer deletion failed. Please try again.' });
    } finally {
      deleteCustomerInFlight.current = false;
      setDeleteCustomerBusy(false);
    }
  };
  const [customerRevision, setCustomerRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setCustomerRevision((value) => value + 1);
    window.addEventListener('customer-directory-updated', refresh);
    window.addEventListener('erp-state-hydrated', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('customer-directory-updated', refresh);
      window.removeEventListener('erp-state-hydrated', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let polling = false;
    const syncDirectory = async () => {
      if (polling) return;
      polling = true;
      try {
        const remoteValue = await getERPRecord('customerDirectory');
        if (!mounted || !Array.isArray(remoteValue)) return;
        const previous = lastRemoteDirectory.current;
        const current = readCustomerDirectory();
        const identity = (record) => record?.id ? `id:${record.id}` : `legacy:${JSON.stringify(record)}`;
        const previousIds = new Set((previous || []).map(identity));
        const localOnly = previous ? current.filter((record) => !previousIds.has(identity(record))) : [];
        const next = previous ? [...remoteValue, ...localOnly] : remoteValue;
        lastRemoteDirectory.current = remoteValue;
        if (JSON.stringify(current) !== JSON.stringify(next)) {
          localStorage.setItem('customerDirectory', JSON.stringify(next));
          resetERPStateSyncBaseline();
          window.dispatchEvent(new CustomEvent('customer-directory-updated'));
          if (localOnly.length) await saveERPRecord('customerDirectory', next);
        }
      } catch { /* A transient sync failure must not interrupt customer work. */ }
      finally { polling = false; }
    };
    syncDirectory();
    const interval = window.setInterval(syncDirectory, 5000);
    window.addEventListener('focus', syncDirectory);
    return () => {
      mounted = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', syncDirectory);
    };
  }, []);

  // Vyapar behaviour: side-by-side panes on wide screens; on narrow screens
  // the party list and the details screen are separate views (tap to open,
  // ← Back to the list).
  const [wide, setWide] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(min-width: 1080px)').matches : true
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1080px)');
    const onChange = (e) => setWide(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const { customers } = useMemo(() => {
    // Index transactions under the EXACT normalized bill-to name.
    const txMap = {};
    const addTx = (name, doc) => {
      const k = norm(name);
      if (!k) return;
      const rec = txMap[k] || (txMap[k] = { rawName: String(name).trim(), tx: [] });
      rec.tx.push(doc);
    };

    readLocalStorageList('quotationHistory').forEach((qt) =>
      addTx(qt.company || qt.payload?.customerDetails?.companyName || qt.payload?.customerDetails?.customerName, { kind: 'QT', raw: qt })
    );
    readLocalStorageList('salesOrderHistory').forEach((so) =>
      addTx(so.company || so.payload?.customerDetails?.companyName || so.payload?.customerDetails?.customerName, { kind: 'SO', raw: so })
    );
    readLocalStorageList('deliveryChallanHistory').forEach((dc) =>
      addTx(dc.company || dc.payload?.customerDetails?.companyName || dc.payload?.customerDetails?.customerName, { kind: 'DC', raw: dc })
    );
    readLocalStorageList('customerInvoiceHistory').forEach((inv) =>
      addTx(inv.company || inv.payload?.customerDetails?.companyName || inv.payload?.customerDetails?.customerName, { kind: 'INV', raw: inv })
    );
    readLocalStorageList('exportInvoiceHistory').forEach((einv) =>
      addTx(einv.buyer || einv.payload?.buyer?.name || einv.payload?.buyerName, { kind: 'EINV', raw: einv })
    );

    const countFor = (rec) => {
      const out = { quotations: 0, orders: 0, challans: 0, invoices: 0, exports: 0, invoiced: 0, outstanding: 0, txCount: 0 };
      (rec?.tx || []).forEach((t) => {
        out.txCount += 1;
        if (t.kind === 'QT') out.quotations += 1;
        if (t.kind === 'SO') out.orders += 1;
        if (t.kind === 'DC') out.challans += 1;
        if (t.kind === 'INV') {
          out.invoices += 1;
          out.invoiced += invTotalINR(t.raw);
          out.outstanding += invBalanceINR(t.raw);
        }
        if (t.kind === 'EINV') out.exports += 1;
      });
      return out;
    };

    // Only customer master records saved in the central customerDirectory are
    // shown. Transaction histories are indexed above solely for each customer's
    // ledger; they never create master rows on their own.
    const list = [];
    readCustomerDirectory().forEach((m, i) => {
      const keys = [norm(m.companyName), norm(m.customerName)].filter(Boolean);
      const name = m.companyName || m.customerName || '';
      const ownKey = m.id || `${keys[0] || 'customer'}-${i}`;
      if (list.some((entry) => entry.key === ownKey)) return;
      const txs = keys.flatMap((k) => txMap[k]?.tx || []);
      list.push({ key: ownKey, id: m.id, name, source: txs.length ? 'Master + Transactions' : 'Customer Directory', contactPerson: m.customerName || m.contactPerson || '', phone: m.phone || '', email: m.email || '', gstin: m.gstin || '', address: (m.address || m.billingAddress || '').replace(/\n/g, ', '), txs, ...countFor({ tx: txs }) });
    });

    list.sort((a, b) => a.name.localeCompare(b.name));
    return { customers: list };
  }, [customerRevision]);

  // Search by party name OR phone number (Vyapar-style). Substring matching is
  // allowed here — search only changes what is visible, never merges records.
  const q = norm(query);
  const filtered = useMemo(() => {
    let rows = customers.filter((customer) => !q || matchesCustomerSearch(customer, query));
    if (listFilter === 'GET') rows = rows.filter((c) => c.outstanding > 0);
    if (listFilter === 'SETTLED') rows = rows.filter((c) => c.outstanding <= 0 && (c.txCount > 0));
    return rows;
  }, [customers, q, listFilter, query]);

  // Searching a specific party (single match) opens their ledger directly.
  const activeKey = selectedKey || (q && filtered.length === 1 ? filtered[0].key : '');
  const active = filtered.find((c) => c.key === activeKey) || customers.find((c) => c.key === activeKey);

  // Ledger: newest first, grouped by month like Vyapar's transaction list.
  const ledgerGroups = useMemo(() => {
    if (!active) return [];
    const rows = [...active.txs]
      .sort((a, b) => String(b.raw?.date || '').localeCompare(String(a.raw?.date || '')))
      .map((t) => ({
        ...t,
        type: DOC[t.kind].label,
        date: relDate(t.raw?.date),
        sortDate: String(t.raw?.date || ''),
        reference: t.raw?.reference || '-',
        against:
          t.kind === 'QT'
            ? t.raw?.projectId || t.raw?.payload?.quotationDetails?.projectId || '-'
            : t.kind === 'SO'
              ? t.raw?.quotationRef && t.raw.quotationRef !== '-'
                ? `Qt ${t.raw.quotationRef}`
                : '-'
              : t.kind === 'DC'
                ? t.raw?.salesOrderRef && t.raw.salesOrderRef !== '-'
                  ? `SO ${t.raw.salesOrderRef}`
                  : '-'
                : t.raw?.quotationRef && t.raw.quotationRef !== '-'
                  ? `Qt ${t.raw.quotationRef}`
                  : '-'
      }));
    const groups = [];
    rows.forEach((t) => {
      const label = monthLabel(t.sortDate);
      let g = groups.find((x) => x.label === label);
      if (!g) {
        g = { label, items: [] };
        groups.push(g);
      }
      g.items.push(t);
    });
    return groups;
  }, [active]);

  const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  const downloadLedger = () => {
    if (!active) return;
    const rows = ledgerGroups.flatMap((g) =>
      g.items.map((t) => [t.date, t.type, t.reference, t.against, String(t.raw?.total ?? ''), String(t.raw?.status || '-')])
    );
    generateRegisterPDF({
      title: `Statement of Account — ${active.name}`,
      subTitle: `${active.invoices} invoice(s) · Outstanding: ${inr(active.outstanding)} (You'll Get)`,
      period: '',
      columns: [
        { header: 'Date' },
        { header: 'Type' },
        { header: 'Reference' },
        { header: 'Against' },
        { header: 'Amount', align: 'right' },
        { header: 'Status' }
      ],
      rows,
      footer: [],
      filename: `Statement-${(active.name || 'Customer').replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}-${new Date().toISOString().slice(0, 10)}`
    });
  };

  const collectTotal = filtered.reduce((a, c) => a + c.outstanding, 0);

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <h2 className="page-title">Customers</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button type="button" className="button-primary" onClick={() => setShowCustomerModal(true)} style={{ whiteSpace: 'nowrap' }}>＋ Add New Customer</button>
          <button type="button" className="button-secondary" onClick={() => setShowExcelImport(true)} style={{ whiteSpace: 'nowrap' }}><Upload size={16}/> Import Excel</button>
          <button type="button" className="button-secondary" onClick={() => downloadImportTemplate('Customers', customerImportColumns, CUSTOMER_IMPORT_EXAMPLE, CUSTOMER_IMPORT_INSTRUCTIONS)} style={{ whiteSpace: 'nowrap' }}><Download size={16}/> Download Template</button>
          <div style={{ position: 'relative' }}>
            <input
              type="search"
              className="form-input search-input"
              placeholder="🔍  Search Party Name or Phone Number…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: '300px', paddingLeft: '30px' }}
              aria-label="Search parties by name or phone number"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                title="Clear search"
                style={{
                  position: 'absolute',
                  right: '6px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  color: '#64748b',
                  fontWeight: 700,
                  fontSize: '15px'
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>
      {customerActionMessage && !deleteCustomerTarget && <div role="status" style={{ margin: '12px 0', padding: '10px 12px', borderRadius: 8, color: customerActionMessage.type === 'success' ? '#166534' : '#991b1b', background: customerActionMessage.type === 'success' ? '#f0fdf4' : '#fef2f2', border: `1px solid ${customerActionMessage.type === 'success' ? '#bbf7d0' : '#fecaca'}` }}>{customerActionMessage.text}</div>}
      {showCustomerModal && <CustomerRegistrationModal onClose={() => setShowCustomerModal(false)} onSaved={() => { setQuery(''); setListFilter('ALL'); setSelectedKey(''); }} />}
      {showExcelImport && <ExcelImportDialog
        title="Customers"
        columns={customerImportColumns}
        example={CUSTOMER_IMPORT_EXAMPLE}
        instructions={CUSTOMER_IMPORT_INSTRUCTIONS}
          validate={validateCustomerExcelRow}
        onImport={importCustomers}
        mapRow={mapCustomerExcelRow}
        onClose={() => setShowExcelImport(false)}
      />}
      {deleteCustomerTarget && <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleteCustomerBusy) setDeleteCustomerTarget(null); }} style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(15,23,42,.55)', display: 'grid', placeItems: 'center', padding: 16 }}>
        <section role="alertdialog" aria-modal="true" aria-labelledby="delete-customer-title" aria-describedby="delete-customer-message" className="content-block" style={{ width: 'min(440px, 100%)', padding: 24, background: '#fff' }}>
          <h2 id="delete-customer-title" style={{ margin: '0 0 10px', fontSize: 20, color: '#0f172a' }}>Delete Customer?</h2>
          <p id="delete-customer-message" style={{ margin: '0 0 20px', color: '#475569', lineHeight: 1.6 }}>Are you sure you want to delete this customer? This action cannot be undone.</p>
          {customerActionMessage && <div role="alert" style={{ marginBottom: 16, padding: 10, borderRadius: 7, color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', fontSize: 13 }}>{customerActionMessage.text}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="button-secondary" disabled={deleteCustomerBusy} onClick={() => { setDeleteCustomerTarget(null); setCustomerActionMessage(null); }}>Cancel</button>
            <button type="button" className="button-primary" disabled={deleteCustomerBusy} onClick={confirmDeleteCustomer} style={{ background: '#b91c1c', borderColor: '#b91c1c' }}>{deleteCustomerBusy ? 'Deleting…' : 'Delete Customer'}</button>
          </div>
        </section>
      </div>}
      <div className="muted-text" style={{ margin: '4px 0 12px' }}>
        {filtered.length} party(s) on record{collectTotal > 0 ? ` · total to collect: ${inr(collectTotal)}` : ''} — tap a party to view
        their transactions and ledger.
      </div>

      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: wide ? 'wrap' : 'nowrap', flexDirection: wide ? 'row' : 'column' }}>
        {/* Parties list — Vyapar style (screen 1 on narrow displays) */}
        {(wide || !active) && (
        <div
          className="content-block"
          style={{
            padding: '12px',
            ...(wide ? { flex: '1 1 340px', minWidth: '320px' } : { width: '100%' })
          }}
        >
          <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
            {[
              ['ALL', 'All Parties'],
              ['GET', "You'll Get"],
              ['SETTLED', 'Settled']
            ].map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => setListFilter(k)}
                style={{
                  border: '1px solid ' + (listFilter === k ? '#e11d48' : '#e2e8f0'),
                  background: listFilter === k ? '#fff1f2' : '#fff',
                  color: listFilter === k ? '#be123c' : '#475569',
                  fontWeight: 600,
                  fontSize: '12px',
                  borderRadius: '999px',
                  padding: '5px 12px',
                  cursor: 'pointer'
                }}
              >
                {lbl}
              </button>
            ))}
          </div>

          <div style={{ maxHeight: '66vh', overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '40px 16px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
                No parties match your search.
              </div>
            ) : (
              filtered.map((c) => (
                <div
                  key={c.key}
                  onClick={() => setSelectedKey(c.key)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '10px 8px',
                    borderRadius: '10px',
                    cursor: 'pointer',
                    background: c.key === active?.key ? '#fff1f2' : 'transparent',
                    borderBottom: '1px solid #f1f5f9'
                  }}
                >
                  <div
                    style={{
                      width: '38px',
                      height: '38px',
                      borderRadius: '10px',
                      background: avatarColor(c.name),
                      color: '#fff',
                      fontWeight: 700,
                      fontSize: '16px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0
                    }}
                  >
                    {(c.name || '?').trim().charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: '13px', color: '#0f172a', textAlign: 'left' }}>{c.name}</div>
                    <div style={{ fontSize: '11px', color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' }}>
                      {c.phone || `${c.txCount} transaction(s) · ${c.orders} orders · ${c.invoices} invoices`}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    {c.outstanding > 0 ? (
                      <>
                        <div style={{ fontWeight: 800, fontSize: '13px', color: '#e11d48' }}>{inr(c.outstanding)}</div>
                        <div style={{ fontSize: '10px', fontWeight: 700, color: '#e11d48' }}>You&apos;ll Get</div>
                      </>
                    ) : c.txCount > 0 ? (
                      <div style={{ fontSize: '10px', fontWeight: 700, color: '#15803d' }}>No Dues</div>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        )}

        {/* Party details — Vyapar style (screen 2 on narrow displays) */}
        {(wide || active) && (
        <div className="content-block" style={wide ? { flex: '2 1 660px', minWidth: '430px' } : { width: '100%' }}>
          {!active ? (
            <div
              style={{
                padding: '56px 20px',
                textAlign: 'center',
                color: '#64748b',
                fontSize: '13px',
                lineHeight: 1.7
              }}
            >
              <div style={{ fontSize: '30px', marginBottom: '8px' }}>👥</div>
              Select a party {wide ? 'from the list on the left' : 'from the party list'} to view
              <br />
              their full transaction ledger.
            </div>
          ) : (
            <>
              {/* Balance card */}
              <div
                style={{
                  border: '1px solid #e2e8f0',
                  borderRadius: '12px',
                  padding: '14px 16px',
                  background: active.outstanding > 0 ? '#fff5f5' : '#f1f8f4',
                  display: 'flex',
                  gap: '14px',
                  alignItems: 'center',
                  flexWrap: 'wrap'
                }}
              >
                <div style={{ flex: 1, minWidth: '180px', textAlign: 'left' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: '#64748b' }}>{active.name}</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '2px' }}>
                    <span style={{ fontSize: '26px', fontWeight: 800, color: active.outstanding > 0 ? '#e11d48' : '#15803d' }}>
                      {inr(active.outstanding)}
                    </span>
                    <span style={{ fontSize: '12px', fontWeight: 700, color: active.outstanding > 0 ? '#e11d48' : '#15803d' }}>
                      {active.outstanding > 0 ? "You'll Get" : 'No Dues'}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                    {active.txCount} transaction(s) · {inr(active.invoiced)} invoiced · {active.source}
                  </div>
                </div>
                <div style={{ flex: 2, minWidth: '240px', textAlign: 'left' }}>
                  {[
                    active.phone ? `Phone: ${active.phone}` : null,
                    active.email ? `Email: ${active.email}` : null,
                    active.gstin ? `GSTIN: ${active.gstin}` : null,
                    active.address ? `Address: ${active.address}` : null,
                    active.contactPerson ? `Contact: ${active.contactPerson}` : null
                  ]
                    .filter(Boolean)
                    .map((line) => (
                      <div
                        key={line}
                        style={{
                          fontSize: '11.5px',
                          color: '#334155',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}
                        title={line}
                      >
                        {line}
                      </div>
                    ))}
                </div>
              </div>

              {/* Quick actions — Vyapar's +Sale / +Payment In row */}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '12px 0' }}>
                <ActionBtn icon="＋" label="Quotation" onClick={() => navigate('/quotation')} />
                <ActionBtn icon="＋" label="Sales Order" onClick={() => navigate('/sales-order')} />
                <ActionBtn icon="＋" label="Delivery Challan" onClick={() => navigate('/delivery-challan')} />
                <ActionBtn icon="＋" label="Tax Invoice" onClick={() => navigate('/customer-invoice')} />
                <span style={{ flex: 1 }} />
                {adminUser && active.id && <button type="button" className="button-secondary button-small" title="Delete Customer" onClick={() => { setCustomerActionMessage(null); setDeleteCustomerTarget(active); }} style={{ color: '#b91c1c', borderColor: '#fecaca' }}><Trash2 size={14} aria-hidden="true" /> Delete</button>}
                <button type="button" className="button-secondary button-small" onClick={downloadLedger} title="Download ledger as PDF (statement of account)">
                  ⬇ Download Ledger PDF
                </button>
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={() => {
                    setSelectedKey('');
                    setQuery('');
                  }}
                >
                  ← Back
                </button>
              </div>

              {/* Transaction ledger */}
              <div className="block-header">
                <h3 className="block-title" style={{ fontSize: '13.5px' }}>Transaction History</h3>
                <span className="muted-text">newest first</span>
              </div>
              <div style={{ maxHeight: '46vh', overflowY: 'auto' }}>
                {ledgerGroups.length === 0 ? (
                  <div style={{ padding: '40px 16px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
                    No transactions recorded for this party yet.
                  </div>
                ) : (
                  ledgerGroups.map((g) => (
                    <div key={g.label}>
                      <div
                        style={{
                          fontSize: '11px',
                          fontWeight: 800,
                          color: '#64748b',
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          margin: '10px 0 6px',
                          borderBottom: '1px dashed #e2e8f0',
                          paddingBottom: '3px',
                          textAlign: 'left'
                        }}
                      >
                        {g.label}
                      </div>
                      {g.items.map((t, idx) => {
                        const d = DOC[t.kind];
                        const st = statusColor(t.raw?.status);
                        const due = t.kind === 'INV' ? invBalanceINR(t.raw) : 0;
                        const amt = amountCell(t);
                        return (
                          <div
                            key={`${t.kind}-${t.reference}-${idx}`}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '12px',
                              padding: '9px 6px',
                              borderBottom: '1px solid #f1f5f9'
                            }}
                          >
                            <div style={{ width: '84px', flexShrink: 0, fontSize: '11.5px', color: '#475569', fontWeight: 600, textAlign: 'left' }}>
                              {t.date}
                            </div>
                            <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                <span
                                  style={{
                                    fontSize: '10px',
                                    fontWeight: 800,
                                    color: '#fff',
                                    background: d.color,
                                    borderRadius: '5px',
                                    padding: '2px 7px',
                                    letterSpacing: '0.03em'
                                  }}
                                >
                                  {d.label.toUpperCase()}
                                </span>
                                <span style={{ fontSize: '12.5px', fontWeight: 700, color: '#0f172a' }}>{t.reference}</span>
                                <span style={{ fontSize: '11px', color: '#94a3b8' }}>· {t.against}</span>
                              </div>
                              <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {itemsSummary(t)}
                              </div>
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0 }}>
                              {amt}
                              {t.kind === 'INV' && due > 0 && (
                                <div style={{ fontSize: '10px', fontWeight: 700, color: '#e11d48' }}>Due {inr(due)}</div>
                              )}
                              <span
                                style={{
                                  display: 'inline-block',
                                  marginTop: '2px',
                                  fontSize: '10px',
                                  fontWeight: 700,
                                  color: st.color,
                                  background: st.bg,
                                  borderRadius: '999px',
                                  padding: '1px 8px'
                                }}
                              >
                                {t.raw?.status || '-'}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
        )}
      </div>
    </div>
  );
};

const ActionBtn = ({ icon, label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    title={`Create a new ${label}`}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      border: '1px solid #dc2626',
      background: '#dc2626',
      color: '#fff',
      fontWeight: 700,
      fontSize: '12px',
      borderRadius: '8px',
      padding: '7px 12px',
      cursor: 'pointer'
    }}
  >
    <span style={{ fontSize: '13px' }}>{icon}</span>
    {label}
  </button>
);

export default CustomersPage;
