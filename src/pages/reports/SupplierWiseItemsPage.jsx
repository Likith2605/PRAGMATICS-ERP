import React, { useEffect, useMemo, useState } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { getSupplierWiseItemRows } from '../../utils/purchaseReportData.js';
import { listPurchaseOrders } from '../../services/procurementIntakeApi.js';
import { formatQuantityByUnit } from '../../utils/reportFilters.js';

const qty = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const money = (value) => Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyByCurrency = (rows, field) => [...new Set(rows.map((row) => row.currency || 'INR'))].map((currency) => `${currency} ${money(rows.filter((row) => (row.currency || 'INR') === currency).reduce((sum, row) => sum + (Number(row[field]) || 0), 0))}`).join(' | ');

const SupplierWiseItemsPage = () => {
  const [serverOrders, setServerOrders] = useState([]);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let active = true;
    listPurchaseOrders()
      .then((orders) => { if (active) { setServerOrders(orders); setLoadError(''); } })
      .catch((error) => { if (active) setLoadError(`Purchase Orders could not be loaded from PostgreSQL: ${error.message}`); });
    return () => { active = false; };
  }, []);
  const rows = useMemo(() => getSupplierWiseItemRows(serverOrders), [serverOrders]);
  const suppliers = [...new Set(rows.map((row) => row.supplier).filter(Boolean))].sort();
  const items = [...new Set(rows.map((row) => row.item).filter(Boolean))].sort();
  const categories = [...new Set(rows.map((row) => row.category).filter(Boolean))].sort();
  const statuses = [...new Set(rows.map((row) => row.status).filter(Boolean))].sort();
  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      {loadError && <div role="alert" className="form-error" style={{ marginBottom: 12 }}>{loadError}</div>}
      <ReportRegister
        title="Supplier-wise Item Report"
        subTitle="PO item lines with ordered, received and pending quantities. Received amounts use the PO progress ledger once per source document, not a direct PO-to-GRN join. Purchase value is before tax."
        filename={`Supplier-Wise-Items-${new Date().toISOString().slice(0, 10)}`}
        dateField="date"
        rows={rows}
        columns={[
          { key: 'supplier', label: 'Supplier' },
          { key: 'item', label: 'Item / Material' },
          { key: 'unit', label: 'Unit' },
          { key: 'currency', label: 'Currency' },
          { key: 'category', label: 'Category' },
          { key: 'poNumber', label: 'PO Number' },
          { key: 'date', label: 'Purchase Date' },
          { key: 'orderedQty', label: 'Ordered Qty', align: 'right', render: (row) => qty(row.orderedQty) },
          { key: 'receivedQty', label: 'Received Qty', align: 'right', render: (row) => qty(row.receivedQty) },
          { key: 'pendingQty', label: 'Pending Qty', align: 'right', render: (row) => qty(row.pendingQty) },
          { key: 'rate', label: 'Purchase Rate', align: 'right', render: (row) => money(row.rate) },
          { key: 'purchaseValue', label: 'Purchase Value (excl. tax)', align: 'right', render: (row) => money(row.purchaseValue) },
          { key: 'status', label: 'PO Status' }
        ]}
        filters={[
          { key: 'supplier', placeholder: 'All Suppliers', options: suppliers.map((value) => ({ value, label: value })) },
          { key: 'item', placeholder: 'All Materials', options: items.map((value) => ({ value, label: value })) },
          { key: 'category', placeholder: 'All Categories', options: categories.map((value) => ({ value, label: value })) },
          { key: 'status', placeholder: 'All PO Statuses', options: statuses.map((value) => ({ value, label: value })) }
        ]}
        totals={[
          { colKey: 'orderedQty', render: (filtered) => formatQuantityByUnit(filtered, 'orderedQty') },
          { colKey: 'receivedQty', render: (filtered) => formatQuantityByUnit(filtered, 'receivedQty') },
          { colKey: 'pendingQty', render: (filtered) => formatQuantityByUnit(filtered, 'pendingQty') },
          { colKey: 'purchaseValue', render: (filtered) => moneyByCurrency(filtered, 'purchaseValue') }
        ]}
      />
    </div>
  );
};

export default SupplierWiseItemsPage;
