import React, { useMemo } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { readLocalStorageList } from '../../utils/reportData.js';
import { calculateSalesOrderAgeing, formatMoneyByCurrency, formatQuantityMap, sumQuantityMaps } from '../../utils/salesOrderAgeing.js';

const money = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const SalesOrderAgeingPage = () => {
  const { rows, exceptions } = useMemo(() => calculateSalesOrderAgeing(
    readLocalStorageList('salesOrderHistory'),
    readLocalStorageList('deliveryChallanHistory')
  ), []);
  const customers = [...new Set(rows.map((row) => row.customerName).filter((value) => value && value !== '-'))].sort();
  const statuses = [...new Set(rows.map((row) => row.orderStatus).filter(Boolean))].sort();
  const buckets = ['0–30 days', '31–60 days', '61–90 days', '90+ days'];
  const renderExceptions = (filteredRows) => {
    const visibleRefs = new Set(filteredRows.flatMap((row) => [row.soNumber, ...(row.salesOrderAliases || [])]));
    const visible = exceptions.filter((exception) => !exception.salesOrderRef || visibleRefs.has(exception.salesOrderRef));
    if (!visible.length) return null;
    return <details className="content-block" style={{ marginTop: 12 }}><summary>{visible.length} delivery allocation exception(s)</summary><div className="history-table-wrapper"><table className="history-table report-table"><thead><tr><th>Challan</th><th>Sales Order Ref</th><th>Item</th><th>UOM</th><th>Quantity</th><th>Exception</th></tr></thead><tbody>{visible.map((exception, index) => <tr key={`${exception.challan}-${index}`}><td>{exception.challan || '-'}</td><td>{exception.salesOrderRef || 'Unlinked'}</td><td>{exception.item || '-'}</td><td>{exception.unit || '-'}</td><td>{exception.quantity ?? ''}</td><td>{exception.reason}</td></tr>)}</tbody></table></div></details>;
  };
  const exceptionTable = (filteredRows) => {
    const visibleRefs = new Set(filteredRows.flatMap((row) => [row.soNumber, ...(row.salesOrderAliases || [])]));
    const visible = exceptions.filter((exception) => !exception.salesOrderRef || visibleRefs.has(exception.salesOrderRef));
    return visible.length ? [{ title: 'Delivery Allocation Exceptions', columns: [
      { key: 'challan', label: 'Challan' }, { key: 'salesOrderRef', label: 'Sales Order Ref' }, { key: 'item', label: 'Item' },
      { key: 'unit', label: 'UOM' }, { key: 'quantity', label: 'Quantity' }, { key: 'reason', label: 'Exception' }
    ], rows: visible }] : [];
  };

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <ReportRegister
        title="Sales Order Status & Ageing"
        showPreparedBy={false}
        filename={`Sales-Order-Ageing-${new Date().toISOString().slice(0, 10)}`}
        dateField="orderDate"
        dateFilters
        landscape
        enableCSV
        summaryCards={(filtered) => [
          { label: 'Total Sales Orders', value: filtered.length, color: '#0369a1', bg: '#f0f9ff' },
          { label: 'Order Value', value: formatMoneyByCurrency(filtered), color: '#0f172a', bg: '#f8fafc' },
          { label: 'Ordered Quantity', value: formatQuantityMap(sumQuantityMaps(filtered, 'orderedByUnit')), color: '#475569', bg: '#f8fafc' },
          { label: 'Allocated Challan Quantity', value: formatQuantityMap(sumQuantityMaps(filtered, 'deliveredByUnit')), color: '#166534', bg: '#f0fdf4' },
          { label: 'Known Pending Quantity', value: formatQuantityMap(sumQuantityMaps(filtered, 'pendingByUnit')), color: '#b45309', bg: '#fffbeb', subtitle: 'Affected UOMs are marked unavailable per order' },
          { label: 'Over-delivery', value: formatQuantityMap(sumQuantityMaps(filtered, 'overDeliveredByUnit')), color: '#b91c1c', bg: '#fef2f2' },
          { label: 'Ageing > 60 Days with Known Pending', value: filtered.filter((row) => row.ageDays > 60 && [...row.pendingByUnit.values()].some((quantity) => quantity > 0)).length, color: '#b91c1c', bg: '#fef2f2' }
        ]}
        columns={[
          { key: 'soNumber', label: 'SO No.', width: 25 },
          { key: 'customerName', label: 'Customer', width: 28 },
          { key: 'projectId', label: 'Project', width: 22 },
          { key: 'orderDate', label: 'Order Date', width: 18 },
          { key: 'orderValue', label: 'Order Value', width: 22, align: 'right', render: (row) => `${row.orderValueCurrency} ${money(row.orderValue)}`, renderText: (row) => `${row.orderValueCurrency} ${money(row.orderValue)}` },
          { key: 'orderedQty', label: 'Ordered Qty', width: 18, align: 'right' },
          { key: 'deliveredQty', label: 'Delivered Qty', width: 24, align: 'right' },
          { key: 'pendingQty', label: 'Pending Qty', width: 18, align: 'right' },
          { key: 'overDeliveredQty', label: 'Over-delivery', width: 18, align: 'right' },
          { key: 'allocationStatus', label: 'Allocation', width: 36 },
          { key: 'orderStatus', label: 'Status', width: 20 },
          { key: 'ageingBucket', label: 'Ageing Bucket', width: 28 }
        ]}
        rows={rows}
        filters={[
          { key: 'customerName', placeholder: 'All Customers', options: customers.map((value) => ({ value, label: value })) },
          { key: 'orderStatus', placeholder: 'All Statuses', options: statuses.map((value) => ({ value, label: value })) },
          { key: 'ageingBucket', placeholder: 'All Ageing Buckets', options: buckets.map((value) => ({ value, label: value })) }
        ]}
        summaryContent={renderExceptions}
        summaryTables={exceptionTable}
        totals={[
          { colKey: 'orderValue', render: (filtered) => formatMoneyByCurrency(filtered) },
          { colKey: 'orderedQty', render: (filtered) => formatQuantityMap(sumQuantityMaps(filtered, 'orderedByUnit')) },
          { colKey: 'deliveredQty', render: (filtered) => formatQuantityMap(sumQuantityMaps(filtered, 'deliveredByUnit')) },
          { colKey: 'pendingQty', render: (filtered) => formatQuantityMap(sumQuantityMaps(filtered, 'pendingByUnit')) },
          { colKey: 'overDeliveredQty', render: (filtered) => formatQuantityMap(sumQuantityMaps(filtered, 'overDeliveredByUnit')) }
        ]}
      />
    </div>
  );
};

export default SalesOrderAgeingPage;
