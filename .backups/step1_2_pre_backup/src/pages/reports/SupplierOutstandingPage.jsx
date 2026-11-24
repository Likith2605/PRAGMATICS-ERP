import React, { useMemo } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { readLocalStorageList } from '../../utils/reportData.js';

const inr = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const getAgeingBucket = (days) => {
  if (days <= 30) return '0–30 days';
  if (days <= 60) return '31–60 days';
  if (days <= 90) return '61–90 days';
  return '90+ days';
};

const SupplierOutstandingPage = () => {
  const { rows, suppliers, statuses, buckets, summary } = useMemo(() => {
    const rawList = readLocalStorageList('supplierInvoiceHistory');
    const now = Date.now();

    let totalPayable = 0;
    let totalPaid = 0;
    let totalOutstanding = 0;
    let overdueCount = 0;

    const list = rawList.map((si) => {
      const supplierName =
        si.vendor ||
        si.payload?.vendorDetails?.companyName ||
        si.payload?.vendorDetails?.vendorName ||
        '-';
      const invoiceNumber =
        si.reference ||
        si.payload?.invoiceDetails?.supplierInvoiceNumber ||
        '-';
      const date =
        si.date ||
        si.payload?.invoiceDetails?.supplierInvoiceDate ||
        '';
      const dueDate =
        si.dueDate ||
        si.payload?.invoiceDetails?.paymentDueDate ||
        '-';
      const invoiceAmount =
        Number(si.payload?.totals?.grandTotal) ||
        Number(String(si.total || '').replace(/[^0-9.-]/g, '')) ||
        0;
      const amountPaid =
        Number(si.payload?.invoiceDetails?.amountPaid) ||
        (si.status === 'Paid' ? invoiceAmount : 0);
      const outstandingAmount = Math.max(0, invoiceAmount - amountPaid);
      const paymentStatus =
        si.status ||
        si.payload?.invoiceDetails?.paymentStatus ||
        (outstandingAmount === 0 ? 'Paid' : amountPaid > 0 ? 'Partially Paid' : 'Pending');

      // Age calculation from invoice date (or due date if preferred)
      let ageDays = 0;
      if (date) {
        const invTime = new Date(date).getTime();
        if (!Number.isNaN(invTime)) {
          ageDays = Math.max(0, Math.floor((now - invTime) / 86400000));
        }
      }
      const ageingBucket = getAgeingBucket(ageDays);

      totalPayable += invoiceAmount;
      totalPaid += amountPaid;
      totalOutstanding += outstandingAmount;
      if (outstandingAmount > 0 && ageDays > 30) overdueCount += 1;

      return {
        supplierName,
        invoiceNumber,
        date,
        dueDate,
        invoiceAmount,
        amountPaid,
        outstandingAmount,
        ageDays,
        ageingBucket,
        paymentStatus
      };
    });

    const suppSet = [...new Set(list.map((r) => r.supplierName).filter((s) => s && s !== '-'))].sort();
    const statusSet = [...new Set(list.map((r) => r.paymentStatus).filter(Boolean))].sort();
    const bucketSet = ['0–30 days', '31–60 days', '61–90 days', '90+ days'];

    return {
      rows: list,
      suppliers: suppSet,
      statuses: statusSet,
      buckets: bucketSet,
      summary: {
        totalInvoices: list.length,
        totalPayable,
        totalPaid,
        totalOutstanding,
        overdueCount
      }
    };
  }, []);

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <ReportRegister
        title="Supplier Outstanding"
        subTitle="Aged creditor ledger: supplier bills, payments, outstanding balances and ageing breakdown"
        filename={`Supplier-Outstanding-${new Date().toISOString().slice(0, 10)}`}
        dateField="date"
        dateFilters={true}
        enableCSV={true}
        summaryCards={(rs) => [
          { label: 'Supplier Bills', value: rs.length, color: '#0369a1', bg: '#f0f9ff' },
          { label: 'Total Payable (₹)', value: `₹ ${inr(rs.reduce((sum, row) => sum + row.invoiceAmount, 0))}`, color: '#0f172a', bg: '#f8fafc' },
          { label: 'Total Paid (₹)', value: `₹ ${inr(rs.reduce((sum, row) => sum + row.amountPaid, 0))}`, color: '#166534', bg: '#f0fdf4' },
          { label: 'Total Outstanding (₹)', value: `₹ ${inr(rs.reduce((sum, row) => sum + row.outstandingAmount, 0))}`, color: '#b91c1c', bg: '#fef2f2' },
          { label: 'Overdue Bills (> 30 Days)', value: rs.filter((row) => row.paymentStatus !== 'Paid' && row.ageDays > 30).length, color: '#b45309', bg: '#fffbeb', subtitle: 'Pending creditor dues' }
        ]}
        columns={[
          { key: 'supplierName', label: 'Supplier Name' },
          { key: 'invoiceNumber', label: 'Supplier Bill No.' },
          { key: 'date', label: 'Bill Date' },
          { key: 'dueDate', label: 'Due Date' },
          { key: 'invoiceAmount', label: 'Bill Amount (₹)', align: 'right', render: (r) => inr(r.invoiceAmount) },
          { key: 'amountPaid', label: 'Paid (₹)', align: 'right', render: (r) => inr(r.amountPaid) },
          { key: 'outstandingAmount', label: 'Outstanding (₹)', align: 'right', render: (r) => inr(r.outstandingAmount) },
          { key: 'ageDays', label: 'Age (Days)', align: 'right' },
          {
            key: 'ageingBucket',
            label: 'Ageing Bucket',
            render: (r) => (
              <span
                style={{
                  fontWeight: 600,
                  color:
                    r.ageingBucket === '90+ days'
                      ? '#b91c1c'
                      : r.ageingBucket === '61–90 days'
                      ? '#c2410c'
                      : r.ageingBucket === '31–60 days'
                      ? '#b45309'
                      : '#166534'
                }}
              >
                {r.ageingBucket}
              </span>
            ),
            renderText: (r) => r.ageingBucket
          },
          {
            key: 'paymentStatus',
            label: 'Payment Status',
            render: (r) => (
              <span
                style={{
                  fontWeight: 700,
                  color:
                    r.paymentStatus === 'Paid'
                      ? '#166534'
                      : r.paymentStatus === 'Partially Paid'
                      ? '#b45309'
                      : '#b91c1c'
                }}
              >
                {r.paymentStatus}
              </span>
            ),
            renderText: (r) => r.paymentStatus
          }
        ]}
        rows={rows}
        filters={[
          { key: 'supplierName', placeholder: 'All Suppliers', options: suppliers.map((s) => ({ value: s, label: s })) },
          { key: 'paymentStatus', placeholder: 'All Statuses', options: statuses.map((s) => ({ value: s, label: s })) },
          { key: 'ageingBucket', placeholder: 'All Ageing Buckets', options: buckets.map((b) => ({ value: b, label: b })) }
        ]}
        totals={[
          { colKey: 'invoiceAmount', render: (rs) => inr(rs.reduce((a, r) => a + r.invoiceAmount, 0)) },
          { colKey: 'amountPaid', render: (rs) => inr(rs.reduce((a, r) => a + r.amountPaid, 0)) },
          { colKey: 'outstandingAmount', render: (rs) => inr(rs.reduce((a, r) => a + r.outstandingAmount, 0)) }
        ]}
      />
    </div>
  );
};

export default SupplierOutstandingPage;
