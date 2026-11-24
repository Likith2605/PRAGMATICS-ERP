import React, { useMemo } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { getMasterCustomerList } from '../../utils/customerMaster.js';
import { readLocalStorageList } from '../../utils/reportData.js';
import { invTotalINR } from '../../utils/invoiceValues.js';

/**
 * List of Customers (Phase 2).
 *
 * Safeguard rules (approved with this phase):
 *  - Master-directory records (masterCustomers.json via customerMaster.js) and
 *    transaction-derived customers (salesOrderHistory / customerInvoiceHistory)
 *    are listed with an explicit "Source" column.
 *  - Customers are linked across sources ONLY on exact normalized-name equality
 *    (trimmed, whitespace-collapsed, case-insensitive). Names that merely look
 *    similar are NEVER merged — each remains a separate row.
 *  - This page deliberately does NOT use findMasterCustomer()'s partial
 *    matching, which can attach the wrong customer to similar names.
 */

// Exact-match normalization only. No partial/substring logic.
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();

const readHistory = (key) => readLocalStorageList(key);

const CustomerListPage = () => {
  const rows = useMemo(() => {
    const master = getMasterCustomerList();

    // Transaction-derived customers, grouped by EXACT normalized company name.
    const txMap = {};
    const addTx = (name, { order = false, invoice = null }) => {
      const k = norm(name);
      if (!k) return;
      txMap[k] = txMap[k] || { rawName: String(name).trim(), orders: 0, invoices: 0, invoiced: 0 };
      if (order) txMap[k].orders += 1;
      if (invoice) {
        txMap[k].invoices += 1;
        txMap[k].invoiced += invTotalINR(invoice);
      }
    };
    readHistory('salesOrderHistory').forEach((so) => addTx(so.company || so.customerName || so.customer || so.payload?.customerDetails?.companyName || so.payload?.customerDetails?.customerName, { order: true }));
    readHistory('customerInvoiceHistory').forEach((inv) => addTx(inv.company || inv.customerName || inv.customer || inv.payload?.customerDetails?.companyName || inv.payload?.customerDetails?.customerName, { invoice: inv }));

    const out = [];
    const matchedTxKeys = new Set();

    // 1. Master-directory rows (matched to transactions on exact name only).
    master.forEach((m, i) => {
      const keys = [norm(m.companyName), norm(m.customerName)].filter(Boolean);
      const exact = keys.map((k) => txMap[k]).filter(Boolean);
      keys.forEach((k) => matchedTxKeys.add(k));
      out.push({
        rowKey: `master-${i}`,
        company: m.companyName || m.customerName || '',
        source: exact.length > 0 ? 'Master + Transactions' : 'Master Directory',
        contactPerson: m.contactPerson || '',
        phone: m.phone || m.contactNumber || '',
        email: m.email || '',
        gstin: m.gstin || m.gstNumber || '',
        address: (m.address || '').replace(/\n/g, ' '),
        orders: exact.reduce((a, t) => a + t.orders, 0),
        invoices: exact.reduce((a, t) => a + t.invoices, 0),
        invoiced: exact.reduce((a, t) => a + t.invoiced, 0)
      });
    });

    // 2. Transaction-only customers (no EXACT master match) — kept separate.
    Object.keys(txMap)
      .filter((k) => !matchedTxKeys.has(k))
      .sort((a, b) => txMap[b].invoiced - txMap[a].invoiced)
      .forEach((k) => {
        const t = txMap[k];
        out.push({
          rowKey: `tx-${k}`,
          company: t.rawName,
          source: 'Transactions',
          contactPerson: '',
          phone: '',
          email: '',
          gstin: '',
          address: '',
          orders: t.orders,
          invoices: t.invoices,
          invoiced: t.invoiced
        });
      });

    return out;
  }, []);

  const inr = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const masterCount = rows.filter((r) => r.source !== 'Transactions').length;
  const customerNames = [...new Set(rows.map((row) => row.company).filter(Boolean))].sort();

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <div className="content-block" style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '12px', color: '#64748b', lineHeight: 1.5 }}>
          <strong>Master Directory</strong> records come from the customer master list; <strong>Transactions</strong>{' '}
          records were derived from sales orders and invoices. Records are linked across sources only when the company
          name matches <em>exactly</em> (ignoring case and extra spaces) — similar-sounding names are never merged.
        </div>
      </div>

      <ReportRegister
        title="List of Customers"
        subTitle={`${rows.length} customer record(s) · ${masterCount} in master directory`}
        filename={`Customer-List-${new Date().toISOString().slice(0, 10)}`}
        dateFilters={false}
        dateFilterNote="Date filtering is not applicable to the master-directory snapshot; transaction counts are aggregated across recorded history."
        enableCSV
        columns={[
          { key: 'company', label: 'Company Name' },
          {
            key: 'source',
            label: 'Source',
            render: (r) => (
              <span
                style={{
                  fontWeight: 600,
                  fontSize: '11px',
                  color: r.source === 'Transactions' ? '#7c3aed' : r.source === 'Master + Transactions' ? '#166534' : '#0369a1',
                  background: r.source === 'Transactions' ? '#ede9fe' : r.source === 'Master + Transactions' ? '#dcfce7' : '#e0f2fe',
                  borderRadius: '999px',
                  padding: '2px 8px',
                  whiteSpace: 'nowrap'
                }}
              >
                {r.source}
              </span>
            ),
            renderText: (r) => r.source
          },
          { key: 'contactPerson', label: 'Contact Person', render: (r) => r.contactPerson || '-' },
          { key: 'phone', label: 'Phone', render: (r) => r.phone || '-' },
          { key: 'email', label: 'Email', render: (r) => r.email || '-' },
          { key: 'gstin', label: 'GSTIN', render: (r) => r.gstin || '-' },
          { key: 'orders', label: 'Orders', align: 'right' },
          { key: 'invoices', label: 'Invoices', align: 'right' },
          { key: 'invoiced', label: 'Total Invoiced (INR)', align: 'right', render: (r) => inr(r.invoiced) }
        ]}
        rows={rows}
        filters={[
          { key: 'company', placeholder: 'All Customers', options: customerNames.map((value) => ({ value, label: value })) },
          {
            key: 'source',
            placeholder: 'All Sources',
            options: [
              { value: 'Master Directory', label: 'Master Directory' },
              { value: 'Master + Transactions', label: 'Master + Transactions' },
              { value: 'Transactions', label: 'Transactions only' }
            ]
          },
          { key: 'gstin', placeholder: 'GSTIN: Any', options: [{ value: 'missing', label: 'Missing GSTIN' }], match: (r, v) => (v === 'missing' ? !r.gstin : true) }
        ]}
        totals={[
          { colKey: 'orders', render: (rs) => rs.reduce((a, r) => a + r.orders, 0) },
          { colKey: 'invoices', render: (rs) => rs.reduce((a, r) => a + r.invoices, 0) },
          { colKey: 'invoiced', render: (rs) => rs.reduce((a, r) => a + r.invoiced, 0) }
        ]}
      />
    </div>
  );
};

export default CustomerListPage;
