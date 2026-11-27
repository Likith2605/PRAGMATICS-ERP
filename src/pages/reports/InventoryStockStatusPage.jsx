import React, { useMemo } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import ReportLoadState from '../../components/ReportLoadState.jsx';
import { useAuthoritativeData } from '../../hooks/useAuthoritativeData.js';
import { listInventoryItems } from '../../services/inventoryApi.js';
import { normalizeInventoryItem } from '../../utils/reportApiData.js';
import { formatQuantityByUnit } from '../../utils/reportFilters.js';

/**
 * Stock Status Report (Phase 2).
 *
 * Shows every inventory item with current qty, available qty, reorder level,
 * shortfall, suggested order qty and status. All shortfall/status math is
 * delegated to the existing getReorderList() engine — this page adds no new
 * calculation, only presentation and filters.
 */

const loadInventoryItems = async () => (await listInventoryItems()).map(normalizeInventoryItem);

const InventoryStockStatusPage = () => {
  const { data: inventoryItems, loading, error } = useAuthoritativeData(loadInventoryItems);
  const { rows, categories } = useMemo(() => {
    const reorderMap = {};
    inventoryItems.forEach((item) => {
      const current = Number(item.currentQty) || 0;
      const reorderLevel = Number(item.reorderLevel) > 0 ? Number(item.reorderLevel) : Number(item.minReorderLevel) || 0;
      const shortfall = Math.max(0, reorderLevel - current);
      if (current <= reorderLevel) reorderMap[item.itemCode] = {
        reorderLevel,
        requiredQty: shortfall,
        suggestedPurchaseQty: Math.max(0, reorderLevel * 2 - current),
        status: current <= 0 ? 'OUT OF STOCK' : 'LOW STOCK'
      };
    });
    const list = inventoryItems.map((it) => {
      const r = reorderMap[it.itemCode];
      const current = Number(it.currentQty) || 0;
      const reserved = Number(it.reservedQty) || 0;
      return {
        itemCode: it.itemCode || '',
        materialName: it.materialName || '',
        category: it.category || 'Uncategorised',
        unit: it.unit || '',
        currentQty: current,
        availableQty: Math.max(0, current - reserved),
        reorderLevel: r ? r.reorderLevel : Number(it.reorderLevel) > 0 ? Number(it.reorderLevel) : Number(it.minReorderLevel) || 0,
        shortfall: r ? r.requiredQty : 0,
        suggested: r ? r.suggestedPurchaseQty : 0,
        status: r ? r.status : 'OK'
      };
    });
    const cats = [...new Set(list.map((r) => r.category))].sort();
    return { rows: list, categories: cats };
  }, [inventoryItems]);

  if (loading || error) return <div className="page-container" style={{ padding: '20px 24px' }}><ReportLoadState loading={loading} error={error} /></div>;
  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <ReportRegister
        title="Stock Status Report"
        subTitle="All items with reorder status, shortfall and suggested order quantity"
        filename={`Stock-Status-${new Date().toISOString().slice(0, 10)}`}
        dateFilters={false}
        dateFilterNote="Date filtering is not applicable to this current inventory snapshot; it is not a dated movement register."
        enableCSV
        columns={[
          { key: 'itemCode', label: 'Item Code' },
          { key: 'materialName', label: 'Item Name' },
          { key: 'category', label: 'Category' },
          { key: 'unit', label: 'Unit' },
          { key: 'currentQty', label: 'Current Qty', align: 'right' },
          { key: 'availableQty', label: 'Available Qty', align: 'right' },
          { key: 'reorderLevel', label: 'Reorder Level', align: 'right' },
          { key: 'shortfall', label: 'Shortfall', align: 'right' },
          { key: 'suggested', label: 'Suggested Order Qty', align: 'right' },
          {
            key: 'status',
            label: 'Status',
            render: (r) => (
              <span
                style={{
                  fontWeight: 700,
                  color: r.status === 'OUT OF STOCK' ? '#b91c1c' : r.status === 'LOW STOCK' ? '#b45309' : '#166534'
                }}
              >
                {r.status}
              </span>
            ),
            renderText: (r) => r.status
          }
        ]}
        rows={rows}
        filters={[
          { key: 'category', placeholder: 'All Categories', options: categories.map((c) => ({ value: c, label: c })) },
          {
            key: 'status',
            placeholder: 'All Statuses',
            options: [
              { value: 'OUT OF STOCK', label: 'Out of Stock' },
              { value: 'LOW STOCK', label: 'Low Stock' },
              { value: 'OK', label: 'OK' }
            ]
          }
        ]}
        totals={[
          { colKey: 'currentQty', render: (rs) => formatQuantityByUnit(rs, 'currentQty') },
          { colKey: 'availableQty', render: (rs) => formatQuantityByUnit(rs, 'availableQty') },
          { colKey: 'shortfall', render: (rs) => formatQuantityByUnit(rs, 'shortfall') },
          { colKey: 'suggested', render: (rs) => formatQuantityByUnit(rs, 'suggested') }
        ]}
      />
    </div>
  );
};

export default InventoryStockStatusPage;
