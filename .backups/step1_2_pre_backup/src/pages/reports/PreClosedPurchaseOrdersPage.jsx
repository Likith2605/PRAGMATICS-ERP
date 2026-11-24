import React, { useMemo } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { getPreClosedPurchaseOrderRows } from '../../utils/purchaseReportData.js';
import { formatQuantityByUnit } from '../../utils/reportFilters.js';

const qty = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

const PreClosedPurchaseOrdersPage = () => {
  const rows = useMemo(() => getPreClosedPurchaseOrderRows(), []);
  const suppliers = [...new Set(rows.map((row) => row.supplier).filter(Boolean))].sort();
  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
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
