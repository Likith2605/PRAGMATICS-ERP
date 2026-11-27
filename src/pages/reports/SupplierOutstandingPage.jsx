import React, { useEffect, useMemo, useState } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { listAdvances } from '../../services/advanceApi.js';
import { listSupplierInvoicesApi } from '../../services/procurementIntakeApi.js';
import {
  buildSupplierOutstandingPartySummary,
  buildSupplierOutstandingRows,
  buildSupplierOutstandingSummary,
  sumSupplierOutstanding
} from '../../utils/supplierOutstandingData.js';

const formatAmount = (value, currency) =>
  `${currency} ${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 4 })}`;

const getAgeingBucket = (days) => {
  if (days <= 30) return '0–30 days';
  if (days <= 60) return '31–60 days';
  if (days <= 90) return '61–90 days';
  return '90+ days';
};

const SupplierOutstandingPage = () => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([listSupplierInvoicesApi(), listAdvances('supplier')]).then(([invoices, advances]) => {
      const reportRows = buildSupplierOutstandingRows(invoices, advances)
        .map((row) => ({ ...row, ageingBucket: getAgeingBucket(row.ageDays) }));
      if (active) { setRows(reportRows); setLoadError(''); setLoading(false); }
    }).catch((error) => {
      if (active) {
        setRows([]);
        setLoadError(`Supplier Outstanding data could not be reconciled from PostgreSQL: ${error.message}`);
        setLoading(false);
      }
    });
    return () => { active = false; };
  }, []);

  const suppliers = useMemo(() => [...new Set(rows.map((row) => row.supplierName))].sort(), [rows]);
  const statuses = useMemo(() => [...new Set(rows.map((row) => row.paymentStatus))].sort(), [rows]);
  const buckets = ['0–30 days', '31–60 days', '61–90 days', '90+ days'];

  if (loading) return <div className="page-container" style={{ padding: '20px 24px' }}><div role="status">Loading Supplier Invoice and Advance balances from PostgreSQL…</div></div>;
  if (loadError) return <div className="page-container" style={{ padding: '20px 24px' }}><div role="alert" className="form-error">{loadError}</div></div>;

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <ReportRegister
        title="Supplier Outstanding"
        subTitle="Aged creditor ledger: invoice payments and active supplier advance allocations are reconciled from PostgreSQL"
        filename={`Supplier-Outstanding-${new Date().toISOString().slice(0, 10)}`}
        dateField="date"
        dateFilters={true}
        landscape
        enableCSV={true}
        summaryCards={(filteredRows) => buildSupplierOutstandingSummary(filteredRows).flatMap((summary) => [
          { label: `Payable (${summary.currency})`, value: formatAmount(summary.invoiceAmount, summary.currency), color: '#0f172a', bg: '#f8fafc' },
          { label: `Paid (${summary.currency})`, value: formatAmount(summary.amountPaid, summary.currency), color: '#166534', bg: '#f0fdf4' },
          { label: `Advances Applied (${summary.currency})`, value: formatAmount(summary.advanceAllocated, summary.currency), color: '#1d4ed8', bg: '#eff6ff' },
          { label: `Outstanding (${summary.currency})`, value: formatAmount(summary.outstandingAmount, summary.currency), color: '#b91c1c', bg: '#fef2f2' }
        ])}
        summaryContent={(filteredRows) => {
          const partyRows = buildSupplierOutstandingPartySummary(filteredRows);
          if (!partyRows.length) return null;
          return (
            <div className="content-block" style={{ marginBottom: 12 }}>
              <div className="block-header"><h3 className="block-title">Supplier Totals</h3></div>
              <div className="history-table-wrapper">
                <table className="history-table report-table">
                  <thead><tr>
                    <th>Supplier</th><th>Supplier ID</th><th>Currency</th><th>Invoices</th>
                    <th>Payable</th><th>Paid</th><th>Advances Applied</th><th>Outstanding</th>
                  </tr></thead>
                  <tbody>{partyRows.map((row) => (
                    <tr key={`${row.supplierName}:${row.supplierId}:${row.currency}`}>
                      <td>{row.supplierName}</td><td>{row.supplierId || '—'}</td><td>{row.currency}</td>
                      <td>{filteredRows.filter((item) => item.supplierName === row.supplierName && item.currency === row.currency).length}</td>
                      <td>{formatAmount(row.invoiceAmount, row.currency)}</td>
                      <td>{formatAmount(row.amountPaid, row.currency)}</td>
                      <td>{formatAmount(row.advanceAllocated, row.currency)}</td>
                      <td>{formatAmount(row.outstandingAmount, row.currency)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          );
        }}
        columns={[
          { key: 'supplierName', label: 'Supplier Name', width: 34 },
          { key: 'supplierId', label: 'Supplier ID', width: 20 },
          { key: 'invoiceNumber', label: 'Supplier Bill No.', width: 30 },
          { key: 'date', label: 'Bill Date', width: 20 },
          { key: 'dueDate', label: 'Due Date', width: 20 },
          { key: 'currency', label: 'Currency', width: 14 },
          { key: 'invoiceAmount', label: 'Invoice Amount', width: 28, align: 'right', render: (row) => formatAmount(row.invoiceAmount, row.currency) },
          { key: 'amountPaid', label: 'Payments Applied', width: 28, align: 'right', render: (row) => formatAmount(row.amountPaid, row.currency) },
          { key: 'advanceAllocated', label: 'Advance Allocated', width: 28, align: 'right', render: (row) => formatAmount(row.advanceAllocated, row.currency) },
          { key: 'outstandingAmount', label: 'Outstanding', width: 28, align: 'right', render: (row) => formatAmount(row.outstandingAmount, row.currency) },
          { key: 'paymentStatus', label: 'Invoice Status', width: 20 },
          {
            key: 'ageingBucket',
            label: 'Ageing Bucket',
            width: 30,
            render: (row) => (
              <span style={{
                fontWeight: 600,
                color: row.ageingBucket === '90+ days' ? '#b91c1c'
                  : row.ageingBucket === '61–90 days' ? '#c2410c'
                    : row.ageingBucket === '31–60 days' ? '#b45309' : '#166534'
              }}>{row.ageingBucket}</span>
            ),
            renderText: (row) => row.ageingBucket
          }
        ]}
        rows={rows}
        filters={[
          { key: 'supplierName', placeholder: 'All Suppliers', options: suppliers.map((supplier) => ({ value: supplier, label: supplier })) },
          { key: 'paymentStatus', placeholder: 'All Invoice Statuses', options: statuses.map((status) => ({ value: status, label: status })) },
          { key: 'currency', placeholder: 'All Currencies', options: [...new Set(rows.map((row) => row.currency))].sort().map((currency) => ({ value: currency, label: currency })) },
          { key: 'ageingBucket', placeholder: 'All Ageing Buckets', options: buckets.map((bucket) => ({ value: bucket, label: bucket })) }
        ]}
        totals={[
          { colKey: 'invoiceAmount', render: (filteredRows) => [...new Set(filteredRows.map((row) => row.currency))]
            .map((currency) => `${currency} ${sumSupplierOutstanding(filteredRows.filter((row) => row.currency === currency), 'invoiceAmount').toLocaleString('en-IN', { maximumFractionDigits: 4 })}`).join(' | ') },
          { colKey: 'amountPaid', render: (filteredRows) => [...new Set(filteredRows.map((row) => row.currency))]
            .map((currency) => `${currency} ${sumSupplierOutstanding(filteredRows.filter((row) => row.currency === currency), 'amountPaid').toLocaleString('en-IN', { maximumFractionDigits: 4 })}`).join(' | ') },
          { colKey: 'advanceAllocated', render: (filteredRows) => [...new Set(filteredRows.map((row) => row.currency))]
            .map((currency) => `${currency} ${sumSupplierOutstanding(filteredRows.filter((row) => row.currency === currency), 'advanceAllocated').toLocaleString('en-IN', { maximumFractionDigits: 4 })}`).join(' | ') },
          { colKey: 'outstandingAmount', render: (filteredRows) => [...new Set(filteredRows.map((row) => row.currency))]
            .map((currency) => `${currency} ${sumSupplierOutstanding(filteredRows.filter((row) => row.currency === currency), 'outstandingAmount').toLocaleString('en-IN', { maximumFractionDigits: 4 })}`).join(' | ') }
        ]}
      />
    </div>
  );
};

export default SupplierOutstandingPage;
