import React, { useMemo } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { getInventoryItems } from '../../utils/storeService.js';
import { formatQuantityByUnit } from '../../utils/reportFilters.js';

/**
 * List of Items (Phase 2).
 *
 * Item master list with a missing-information audit: flags items lacking
 * HSN/SAC, unit, reorder level or unit cost. Read-only over the same
 * inventoryItems data the Inventory page uses.
 */

const missingFields = (it) => {
  const gaps = [];
  if (!String(it.hsnSac || '').trim()) gaps.push('HSN/SAC');
  if (!String(it.unit || '').trim()) gaps.push('Unit');
  if (!(Number(it.reorderLevel) > 0 || Number(it.minReorderLevel) > 0)) gaps.push('Reorder Level');
  if (!(Number(it.unitCost) > 0)) gaps.push('Unit Cost');
  return gaps;
};

const ItemListPage = () => {
  const { rows, categories } = useMemo(() => {
    const list = getInventoryItems().map((it) => {
      const gaps = missingFields(it);
      return {
        itemCode: it.itemCode || '',
        materialName: it.materialName || '',
        category: it.category || 'Uncategorised',
        unit: it.unit || '',
        hsnSac: it.hsnSac || '',
        currentQty: Number(it.currentQty) || 0,
        reorderLevel: Number(it.reorderLevel) > 0 ? Number(it.reorderLevel) : Number(it.minReorderLevel) || 0,
        unitCost: Number(it.unitCost) || 0,
        missing: gaps.join(', ')
      };
    });
    const cats = [...new Set(list.map((r) => r.category))].sort();
    return { rows: list, categories: cats };
  }, []);

  const incomplete = rows.filter((r) => r.missing).length;

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <ReportRegister
        title="List of Items"
        subTitle={`${rows.length} item(s) · ${incomplete} with missing information`}
        filename={`Item-List-${new Date().toISOString().slice(0, 10)}`}
        dateFilters={false}
        dateFilterNote="Date filtering is not applicable to item master data."
        enableCSV
        columns={[
          { key: 'itemCode', label: 'Item Code' },
          { key: 'materialName', label: 'Item Name' },
          { key: 'category', label: 'Category' },
          { key: 'unit', label: 'Unit' },
          { key: 'hsnSac', label: 'HSN/SAC' },
          { key: 'currentQty', label: 'Current Qty', align: 'right' },
          { key: 'reorderLevel', label: 'Reorder Level', align: 'right' },
          { key: 'unitCost', label: 'Unit Cost (₹)', align: 'right' },
          {
            key: 'missing',
            label: 'Missing Information',
            render: (r) => (r.missing ? <span style={{ color: '#b91c1c', fontWeight: 600 }}>{r.missing}</span> : <span style={{ color: '#166534' }}>Complete</span>),
            renderText: (r) => r.missing || 'Complete'
          }
        ]}
        rows={rows}
        filters={[
          { key: 'category', placeholder: 'All Categories', options: categories.map((c) => ({ value: c, label: c })) },
          { key: 'missing', placeholder: 'All Items', options: [{ value: 'missing', label: 'Missing info only' }] , match: (r, v) => (v === 'missing' ? !!r.missing : true) }
        ]}
        totals={[{ colKey: 'currentQty', render: (rs) => formatQuantityByUnit(rs, 'currentQty') }]}
      />
    </div>
  );
};

export default ItemListPage;
