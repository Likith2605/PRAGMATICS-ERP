import React, { useEffect, useMemo, useState } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { getPreClosedPurchaseOrderRows } from '../../utils/purchaseReportData.js';
import { listPurchaseOrders } from '../../services/procurementIntakeApi.js';
import { formatQuantityByUnit } from '../../utils/reportFilters.js';

const qty = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

const PreClosedPurchaseOrdersPage = () => {
  const [serverOrders, setServerOrders] = useState([]);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let active = true;
    listPurchaseOrders()
      .then((orders) => { if (active) { setServerOrders(orders); setLoadError(''); } })
      .catch((error) => { if (active) setLoadError(`Purchase Orders could not be loaded from PostgreSQL: ${error.message}`); });
    return () => { active = false; };
  }, []);
  const rows = useMemo(() => getPreClosedPurchaseOrderRows(serverOrders), [serverOrders]);
  const suppliers = [...new Set(rows.map((row) => row.supplier).filter(Boolean))].sort();
  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      {loadError && <div role="alert" className="form-error" style={{ marginBottom: 12 }}>{loadError}</div>}
      <ReportRegister
        title="Pre-Closed Purchase Order Report"
        subTitle="Closed POs with remaining quantity. Short-close quantity is shown only when recorded; historic closure is not inferred."
        filename={`Pre-Closed-Purchase-Orders-${new Date().toISOString().slice(0, 10)}`}
        dateField="date"
        rows={rows}
        columns={[
          { key: 'poNumber', label: 'PO Number' },
          { key: 'supplier', label: 'Supplier' },
          { key: 'item', label: 'Material / Item' },
          { key: 'unit', label: 'Unit' },
          { key: 'originalOrderedQty', label: 'Original Ordered Qty', align: 'right', render: (row) => qty(row.originalOrderedQty) },
          { key: 'receivedQty', label: 'Received Qty', align: 'right', render: (row) => qty(row.receivedQty) },
          { key: 'shortClosedQty', label: 'Recorded Short-Close Qty', align: 'right', render: (row) => row.shortClosedQty == null ? '' : qty(row.shortClosedQty) },
          { key: 'closureEvidence', label: 'Closure Evidence' },
          { key: 'closureDate', label: 'Closure Date' },
          { key: 'closureReason', label: 'Closure Reason' },
          { key: 'approvedBy', label: 'Approved By' },
          { key: 'remarks', label: 'Remarks' }
        ]}
        filters={[{ key: 'supplier', placeholder: 'All Suppliers', options: suppliers.map((value) => ({ value, label: value })) }]}
        totals={[
          { colKey: 'originalOrderedQty', render: (items) => formatQuantityByUnit(items, 'originalOrderedQty') },
          { colKey: 'receivedQty', render: (items) => formatQuantityByUnit(items, 'receivedQty') },
          { colKey: 'shortClosedQty', render: (items) => formatQuantityByUnit(items, 'shortClosedQty') }
        ]}
      />
    </div>
  );
};

export default PreClosedPurchaseOrdersPage;
