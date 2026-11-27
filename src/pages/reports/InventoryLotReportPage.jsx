import React, { useMemo } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import ReportLoadState from '../../components/ReportLoadState.jsx';
import { useAuthoritativeData } from '../../hooks/useAuthoritativeData.js';
import { listAllStockLedger, listInventoryItems, listInventoryLots } from '../../services/inventoryApi.js';
import { normalizeInventoryBatch, normalizeInventoryItem, normalizeStockLedgerEntry } from '../../utils/reportApiData.js';
import {
  getExpiredLotRows,
  getInventoryLotFilterOptions,
  getLocationLotLedgerRows,
  getLotAvailabilityRows,
  getLotDimensionRows,
  getLotWiseStockRows,
  getPresentLotDimensions
} from '../../utils/inventoryReportData.js';
import { formatQuantityByUnit } from '../../utils/reportFilters.js';

const REPORTS = {
  locationLedger: { title: 'Location Wise Lot Ledger', description: 'Each recorded batch movement by storage location, including transfers and adjustments.', dateFilters: true, rows: getLocationLotLedgerRows },
  stockStatement: { title: 'Lot Wise Stock Statement', description: 'Accepted inventory lots with received, issued, adjustment, and current closing quantities.', dateFilterNote: 'Date filtering is not applicable to the current lot stock snapshot.', rows: getLotWiseStockRows },
  expiredLots: { title: 'Lots Expired Beyond Shelf Life', description: 'Only lots with an explicit expiry date that is past today. Materials without a defined shelf life are excluded.', dateFilterNote: 'This is a current stock snapshot filtered by recorded expiry date; it is not a movement-date report.', rows: getExpiredLotRows },
  availability: { title: 'Lot Wise Stock Availability', description: 'Physical quantity is shown separately from reserved, blocked, rejected, and usable stock. Lot reservations are labelled when the source records do not allocate them by batch.', dateFilterNote: 'Date filtering is not applicable to the current lot availability snapshot.', rows: getLotAvailabilityRows },
  dimensions: { title: 'Lot Wise Stock Statement with Dimensions', description: 'Only dimensions present in the source records are shown.', dateFilterNote: 'Date filtering is not applicable to the current lot stock snapshot.', rows: getLotDimensionRows }
};

const qty = (value) => value === '' || value === null || value === undefined ? '' : Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const loadInventoryLotData = async () => {
  const [items, batches, ledger] = await Promise.all([
    listInventoryItems(),
    listInventoryLots(),
    listAllStockLedger()
  ]);
  return {
    items: items.map(normalizeInventoryItem),
    batches: batches.map(normalizeInventoryBatch),
    transactions: ledger.map(normalizeStockLedgerEntry)
  };
};

const InventoryLotReportPage = ({ reportType }) => {
  const config = REPORTS[reportType];
  const { data, loading, error } = useAuthoritativeData(loadInventoryLotData, reportType, { items: [], batches: [], transactions: [] });
  const rows = useMemo(() => config.rows(data), [config, data]);
  if (loading || error) return <div className="page-container" style={{ padding: '20px 24px' }}><ReportLoadState loading={loading} error={error} /></div>;
  const filters = getInventoryLotFilterOptions(rows);
  const dimensionKeys = reportType === 'dimensions' ? getPresentLotDimensions(rows) : [];
  let columns;
  let totals = [];

  if (reportType === 'locationLedger') {
    columns = [
      { key: 'date', label: 'Date' }, { key: 'material', label: 'Material' }, { key: 'itemCode', label: 'Item Code' },
      { key: 'lot', label: 'Lot / Batch' }, { key: 'location', label: 'Location' }, { key: 'reference', label: 'Reference' },
      { key: 'movement', label: 'Movement' }, { key: 'openingQty', label: 'Opening', align: 'right', render: (row) => qty(row.openingQty) },
      { key: 'inwardQty', label: 'Inward', align: 'right', render: (row) => qty(row.inwardQty) },
      { key: 'outwardQty', label: 'Outward', align: 'right', render: (row) => qty(row.outwardQty) },
      { key: 'transferInQty', label: 'Transfer In', align: 'right', render: (row) => qty(row.transferInQty) },
      { key: 'transferOutQty', label: 'Transfer Out', align: 'right', render: (row) => qty(row.transferOutQty) },
      { key: 'adjustmentQty', label: 'Adjustment', align: 'right', render: (row) => qty(row.adjustmentQty) },
      { key: 'closingQty', label: 'Closing', align: 'right', render: (row) => qty(row.closingQty) }, { key: 'unit', label: 'Unit' }
    ];
  } else if (reportType === 'stockStatement') {
    columns = [
      { key: 'material', label: 'Material' }, { key: 'itemCode', label: 'Item Code' }, { key: 'lot', label: 'Lot / Batch' },
      { key: 'supplierBatchNumber', label: 'Supplier Batch' }, { key: 'location', label: 'Location' },
      { key: 'openingQty', label: 'Opening Qty', align: 'right', render: (row) => qty(row.openingQty) },
      { key: 'receivedQty', label: 'Received Qty', align: 'right', render: (row) => qty(row.receivedQty) },
      { key: 'issuedQty', label: 'Issued Qty', align: 'right', render: (row) => qty(row.issuedQty) },
      { key: 'adjustments', label: 'Adjustments', align: 'right', render: (row) => qty(row.adjustments) },
      { key: 'closingQty', label: 'Closing Qty', align: 'right', render: (row) => qty(row.closingQty) },
      { key: 'qcStatus', label: 'QC / Stock Status' }, { key: 'expiryDate', label: 'Expiry Date' }, { key: 'unit', label: 'Unit' }
    ];
    totals = [{ colKey: 'receivedQty', render: (items) => formatQuantityByUnit(items, 'receivedQty') }, { colKey: 'closingQty', render: (items) => formatQuantityByUnit(items, 'closingQty') }];
  } else if (reportType === 'expiredLots') {
    columns = [
      { key: 'material', label: 'Material' }, { key: 'itemCode', label: 'Item Code' }, { key: 'lot', label: 'Lot / Batch' },
      { key: 'supplierBatchNumber', label: 'Supplier Batch' }, { key: 'expiryDate', label: 'Expiry Date' },
      { key: 'physicalQty', label: 'Quantity', align: 'right', render: (row) => qty(row.physicalQty) },
      { key: 'location', label: 'Location' }, { key: 'status', label: 'Stock Status' }
    ];
    totals = [{ colKey: 'physicalQty', render: (items) => formatQuantityByUnit(items, 'physicalQty') }];
  } else if (reportType === 'availability') {
    columns = [
      { key: 'material', label: 'Material' }, { key: 'itemCode', label: 'Item Code' }, { key: 'lot', label: 'Lot / Batch' },
      { key: 'supplierBatchNumber', label: 'Supplier Batch' }, { key: 'location', label: 'Warehouse' },
      { key: 'physicalQty', label: 'Physical Qty', align: 'right', render: (row) => qty(row.physicalQty) },
      { key: 'reservedDisplay', label: 'Reserved Qty', align: 'right', render: (row) => typeof row.reservedDisplay === 'number' ? qty(row.reservedDisplay) : row.reservedDisplay },
      { key: 'blockedQty', label: 'Blocked Qty', align: 'right', render: (row) => qty(row.blockedQty) },
      { key: 'rejectedQty', label: 'Rejected Qty', align: 'right', render: (row) => qty(row.rejectedQty) },
      { key: 'usableDisplay', label: 'Usable Available Qty', align: 'right', render: (row) => typeof row.usableDisplay === 'number' ? qty(row.usableDisplay) : row.usableDisplay },
      { key: 'qcStatus', label: 'QC Status' }
    ];
    totals = [{ colKey: 'physicalQty', render: (items) => formatQuantityByUnit(items, 'physicalQty') }, { colKey: 'usableDisplay', render: (items) => items.every((row) => typeof row.usableDisplay === 'number') ? formatQuantityByUnit(items, 'usableDisplay') : 'Not fully allocated by lot' }];
  } else {
    columns = [
      { key: 'material', label: 'Material' }, { key: 'itemCode', label: 'Item Code' }, { key: 'lot', label: 'Lot / Batch' },
      { key: 'supplierBatchNumber', label: 'Supplier Batch' }, { key: 'location', label: 'Location' },
      ...dimensionKeys.map((key) => ({ key: `dimension_${key}`, label: key[0].toUpperCase() + key.slice(1), render: (row) => row.dimensions[key] || '', renderText: (row) => row.dimensions[key] || '' })),
      { key: 'physicalQty', label: 'Closing Qty', align: 'right', render: (row) => qty(row.physicalQty) }, { key: 'qcStatus', label: 'Status' }
    ];
    totals = [{ colKey: 'physicalQty', render: (items) => formatQuantityByUnit(items, 'physicalQty') }];
  }

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <ReportRegister
        title={config.title}
        subTitle={config.description}
        filename={`${config.title.replace(/[^a-zA-Z0-9_-]/g, '-')}-${new Date().toISOString().slice(0, 10)}`}
        rows={rows}
        dateFilters={Boolean(config.dateFilters)}
        dateFilterNote={config.dateFilterNote}
        dateField="date"
        columns={columns}
        filters={[
          { key: 'material', placeholder: 'All Materials', options: filters.materials.map((value) => ({ value, label: value })) },
          { key: 'lot', placeholder: 'All Lots', options: filters.lots.map((value) => ({ value, label: value })) },
          { key: 'location', placeholder: 'All Locations', options: filters.locations.map((value) => ({ value, label: value })) },
          { key: 'status', placeholder: 'All Statuses', options: filters.statuses.map((value) => ({ value, label: value })) }
        ]}
        totals={totals}
      />
    </div>
  );
};

export default InventoryLotReportPage;
