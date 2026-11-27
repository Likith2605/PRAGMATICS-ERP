import React, { useEffect, useMemo, useState } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { listMasters } from '../../services/masterApi.js';
import { listSalesOrders } from '../../services/salesOrderApi.js';
import { listCustomerInvoices } from '../../services/customerInvoiceApi.js';
import { invTotalINR } from '../../utils/invoiceValues.js';

/**
 * List of Customers (Phase 2).
 *
 * Safeguard rules (approved with this phase):
 *  - Customer masters come from the central customerDirectory record;
 *    transaction-derived customers (PostgreSQL sales orders / customer invoices)
 *    are listed separately; source remains available as a filter.
 *  - Customers are linked across sources ONLY on exact normalized-name equality
 *    (trimmed, whitespace-collapsed, case-insensitive). Names that merely look
 *    similar are NEVER merged — each remains a separate row.
 *  - This page deliberately does NOT use findMasterCustomer()'s partial
 *    matching, which can attach the wrong customer to similar names.
 */

// Exact-match normalization only. No partial/substring logic.
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();

const CustomerListPage = () => {
  const [salesOrders, setSalesOrders] = useState([]);
  const [customerInvoices, setCustomerInvoices] = useState([]);
  const [masterCustomers, setMasterCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      listSalesOrders().catch((err) => {
        console.warn('Failed to load sales orders for customer list:', err);
        throw err;
      }),
      listCustomerInvoices().catch((err) => {
        console.warn('Failed to load customer invoices for customer list:', err);
        throw err;
      }),
      listMasters('customers').catch((err) => {
        console.warn('Failed to load customer masters from PostgreSQL:', err);
        throw err;
      })
    ]).then(([soList, invList, customerList]) => {
      if (!active) return;
      setSalesOrders(Array.isArray(soList) ? soList : []);
      setCustomerInvoices(Array.isArray(invList) ? invList : []);
      setMasterCustomers(Array.isArray(customerList) ? customerList : []);
      setError('');
    }).catch((err) => {
      if (active) setError(err.message || 'Unable to load customer data from PostgreSQL.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const rows = useMemo(() => {
    const master = masterCustomers;

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
    salesOrders.forEach((so) => addTx(so.company || so.customerName || so.customer || so.payload?.customerDetails?.companyName || so.payload?.customerDetails?.customerName, { order: true }));
    customerInvoices.forEach((inv) => addTx(inv.company || inv.customerName || inv.customer || inv.payload?.customerDetails?.companyName || inv.payload?.customerDetails?.customerName, { invoice: inv }));

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
          orders: t.orders,
          invoices: t.invoices,
          invoiced: t.invoiced
        });
      });

    return out;
  }, [salesOrders, customerInvoices, masterCustomers]);

  const inr = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const masterCount = rows.filter((r) => r.source !== 'Transactions').length;
  const customerNames = [...new Set(rows.map((row) => row.company).filter(Boolean))].sort();

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      {error && <div role="alert" className="form-error">{error}</div>}

      <ReportRegister
        title="List of Customers"
        subTitle={loading ? 'Loading customer orders and invoices from PostgreSQL...' : `${rows.length} customer record(s) · ${masterCount} in master directory`}
        filename={`Customer-List-${new Date().toISOString().slice(0, 10)}`}
        dateFilters={false}
        landscape
        columns={[
          { key: 'company', label: 'Company Name', width: 55 },
          { key: 'contactPerson', label: 'Contact Person', width: 32, render: (r) => r.contactPerson || '-' },
          { key: 'phone', label: 'Phone', width: 27, render: (r) => r.phone || '-' },
          { key: 'email', label: 'Email', width: 58, render: (r) => r.email || '-' },
          { key: 'gstin', label: 'GSTIN', width: 34, render: (r) => r.gstin || '-' },
          { key: 'orders', label: 'Orders', width: 20, align: 'right' },
          { key: 'invoices', label: 'Invoices', width: 22, align: 'right' },
          { key: 'invoiced', label: 'Invoiced (INR)', width: 27, align: 'right', render: (r) => inr(r.invoiced) }
        ]}
        rows={rows}
        filters={[
          { key: 'company', placeholder: 'All Customers', options: customerNames.map((value) => ({ value, label: value })) }
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
