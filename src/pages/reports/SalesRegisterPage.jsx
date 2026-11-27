import React, { useEffect, useMemo, useState } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { listCustomerInvoices } from '../../services/customerInvoiceApi.js';
import { invTotalINR, invReceivedINR, invBalanceINR } from '../../utils/invoiceValues.js';

const inr = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const formatInvoiceQty = (rows) => {
  const totals = rows.reduce((map, row) => {
    Object.entries(row.quantityByUnit || {}).forEach(([unit, quantity]) => map.set(unit, (map.get(unit) || 0) + quantity));
    return map;
  }, new Map());
  return [...totals.entries()].map(([unit, quantity]) => `${inr(quantity)} ${unit}`).join(' | ') || '0';
};

const SalesRegisterPage = () => {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    listCustomerInvoices()
      .then((records) => {
        if (!active) return;
        setInvoices(Array.isArray(records) ? records : []);
        setError('');
      })
      .catch((err) => {
        if (!active) return;
        console.error('Failed to load customer invoices from PostgreSQL:', err);
        setError('Unable to load authoritative sales register data from PostgreSQL.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const { rows, customers, summary } = useMemo(() => {
    const rawList = invoices;
    let totalTurnover = 0;
    let totalReceived = 0;
    let totalOutstanding = 0;

    const list = rawList.map((inv) => {
      const invoiceNumber = inv.reference || inv.payload?.invoiceDetails?.invoiceNumber || '-';
      const date = inv.date || inv.payload?.invoiceDetails?.invoiceDate || '';
      const customerName =
        inv.company ||
        inv.payload?.customerDetails?.companyName ||
        inv.payload?.customerDetails?.customerName ||
        '-';
      const projectId = inv.payload?.invoiceDetails?.projectId || '-';
      const items = inv.payload?.items || [];
      const itemDetails =
        items.map((it) => it.itemName || it.itemDescription).filter(Boolean).join(', ') || '-';
      const quantity = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
      const quantityByUnit = items.reduce((map, item) => {
        const unit = String(item.unit || 'Unit not recorded'); map[unit] = (map[unit] || 0) + (Number(item.quantity) || 0); return map;
      }, {});
      const taxableAmount =
        Number(inv.payload?.totals?.taxableAmount ?? inv.payload?.totals?.subtotal) || 0;
      const gst = Number(inv.payload?.totals?.totalGST) || 0;
      const total = invTotalINR(inv);
      const paid = invReceivedINR(inv);
      const outstanding = invBalanceINR(inv);

      totalTurnover += total;
      totalReceived += paid;
      totalOutstanding += outstanding;

      return {
        invoiceNumber,
        date,
        customerName,
        projectId,
        itemDetails,
        quantity,
        quantityByUnit,
        taxableAmount,
        gst,
        total,
        paid,
        outstanding
      };
    });

    const custSet = [...new Set(list.map((r) => r.customerName).filter((c) => c && c !== '-'))].sort();

    return {
      rows: list,
      customers: custSet,
      summary: {
        totalInvoices: list.length,
        totalTurnover,
        totalReceived,
        totalOutstanding
      }
    };
  }, [invoices]);

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      {error && (
        <div style={{ background: '#fee2e2', border: '1px solid #f87171', color: '#991b1b', padding: '10px 14px', borderRadius: '6px', marginBottom: '14px', fontSize: '13px' }}>
          {error}
        </div>
      )}
      <ReportRegister
        title="Sales Register"
        subTitle={loading ? 'Loading authoritative sales data from PostgreSQL...' : 'Customer-wise invoice register with taxable amounts, GST, and totals'}
        filename={`Sales-Register-${new Date().toISOString().slice(0, 10)}`}
        dateField="date"
        dateFilters={true}
        filtersDropdown
        summaryCards={(rs) => [
          { label: 'Total Invoices', value: rs.length, color: '#0369a1', bg: '#f0f9ff' },
          { label: 'Total Sales (₹)', value: `₹ ${inr(rs.reduce((sum, row) => sum + row.total, 0))}`, color: '#0f172a', bg: '#f8fafc' },
          { label: 'Total Received (₹)', value: `₹ ${inr(rs.reduce((sum, row) => sum + row.paid, 0))}`, color: '#166534', bg: '#f0fdf4' },
          { label: 'Total Outstanding (₹)', value: `₹ ${inr(rs.reduce((sum, row) => sum + row.outstanding, 0))}`, color: '#b91c1c', bg: '#fef2f2' }
        ]}
        columns={[
          { key: 'invoiceNumber', label: 'Invoice No.' },
          { key: 'date', label: 'Date' },
          { key: 'customerName', label: 'Customer Name' },
          { key: 'projectId', label: 'Project ID' },
          { key: 'itemDetails', label: 'Item Details' },
          { key: 'quantity', label: 'Qty by Unit', align: 'right', render: (row) => formatInvoiceQty([row]), renderText: (row) => formatInvoiceQty([row]) },
          { key: 'taxableAmount', label: 'Taxable (₹)', align: 'right', render: (r) => inr(r.taxableAmount) },
          { key: 'gst', label: 'GST (₹)', align: 'right', render: (r) => inr(r.gst) },
          { key: 'total', label: 'Total (₹)', align: 'right', render: (r) => inr(r.total) },
          { key: 'paid', label: 'Paid (₹)', align: 'right', render: (r) => inr(r.paid) },
          { key: 'outstanding', label: 'Outstanding (₹)', align: 'right', render: (r) => inr(r.outstanding) }
        ]}
        rows={rows}
        filters={[
          { key: 'customerName', placeholder: 'All Customers', options: customers.map((c) => ({ value: c, label: c })) },
        ]}
        totals={[
          { colKey: 'quantity', render: (rs) => formatInvoiceQty(rs) },
          { colKey: 'taxableAmount', render: (rs) => inr(rs.reduce((a, r) => a + r.taxableAmount, 0)) },
          { colKey: 'gst', render: (rs) => inr(rs.reduce((a, r) => a + r.gst, 0)) },
          { colKey: 'total', render: (rs) => inr(rs.reduce((a, r) => a + r.total, 0)) },
          { colKey: 'paid', render: (rs) => inr(rs.reduce((a, r) => a + r.paid, 0)) },
          { colKey: 'outstanding', render: (rs) => inr(rs.reduce((a, r) => a + r.outstanding, 0)) }
        ]}
      />
    </div>
  );
};

export default SalesRegisterPage;
