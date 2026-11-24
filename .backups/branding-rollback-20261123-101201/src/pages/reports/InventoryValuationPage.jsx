import React, { useMemo } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { getItemStockOverview } from '../../utils/storeService.js';
import { formatQuantityByUnit } from '../../utils/reportFilters.js';

/**
 * Stock Valuation Summary (Phase 2).
 *
 * Item-wise and category-wise stock value. Valuation uses each item's CURRENT
 * unit cost (currentQty × unitCost) via the existing engines — it is NOT a
 * historical issue-time valuation. The disclosure is shown on the page.
 */

const inr = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const categorySummaryRows = (rows) => Object.values(rows.reduce((map, row) => {
  const key = `${row.category}::${row.unit || 'Unit not recorded'}`;
  map[key] = map[key] || { key, category: row.category, unit: row.unit || 'Unit not recorded', qty: 0, value: 0 };
  map[key].qty += row.currentQty; map[key].value += row.stockValue; return map;
}, {}));

const InventoryValuationPage = () => {
  const rows = useMemo(() => {
    const overview = getItemStockOverview().map((it) => ({
      itemCode: it.itemCode || '',
      materialName: it.materialName || '',
      category: it.category || 'Uncategorised',
      unit: it.unit || '',
      currentQty: Number(it.currentQty) || 0,
      unitCost: Number(it.unitCost) || 0,
      stockValue: Number(it.stockValue) || 0,
      stockStatus: it.stockStatus || 'Not recorded'
    }));
    return overview;
  }, []);

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <div className="content-block" style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '12px', color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: '6px', padding: '8px 10px' }}>
          ⚠ <strong>Valuation basis:</strong> values are calculated as <em>current quantity × current unit cost</em>.
          They are <strong>not historical issue-time valuations</strong> — if an item's unit cost has changed,
          past issues are re-valued at today's cost.
        </div>
      </div>

      <ReportRegister
        title="Item-wise Stock Valuation"
        subTitle="Current quantity × current unit cost"
        filename={`Stock-Valuation-${new Date().toISOString().slice(0, 10)}`}
        dateFilters={false}
        dateFilterNote="Date filtering is not applicable to this current quantity and current-cost snapshot."
        enableCSV
        columns={[
          { key: 'itemCode', label: 'Item Code' },
          { key: 'materialName', label: 'Item Name' },
          { key: 'category', label: 'Category' },
          { key: 'unit', label: 'Unit' },
          { key: 'currentQty', label: 'Current Qty', align: 'right' },
          { key: 'unitCost', label: 'Unit Cost (₹)', align: 'right', render: (r) => inr(r.unitCost) },
          { key: 'stockValue', label: 'Stock Value (₹)', align: 'right', render: (r) => inr(r.stockValue) }
        ]}
        rows={rows}
        summaryCards={(filteredRows) => {
          const quantity = formatQuantityByUnit(filteredRows, 'currentQty');
          return [
            { label: 'Items', value: filteredRows.length },
            { label: 'Current Stock Qty', value: quantity || '0' },
            { label: 'Current Stock Value (₹)', value: `₹ ${inr(filteredRows.reduce((sum, row) => sum + row.stockValue, 0))}` },
            { label: 'Low Stock', value: filteredRows.filter((row) => row.stockStatus === 'Low Stock').length },
            { label: 'Out of Stock', value: filteredRows.filter((row) => row.stockStatus === 'Out of Stock').length }
          ];
        }}
        summaryContent={(filteredRows) => {
          const groups = categorySummaryRows(filteredRows);
          return <div className="content-block" style={{ marginBottom: 14 }}><div className="block-header"><h3 className="block-title">Category-wise Summary</h3><span className="muted-text">filtered rows, split by unit</span></div><div className="history-table-wrapper"><table className="history-table report-table"><thead><tr><th>Category</th><th>Unit</th><th>Quantity</th><th>Value (₹)</th></tr></thead><tbody>{groups.map((row) => <tr key={row.key}><td>{row.category}</td><td>{row.unit}</td><td>{inr(row.qty)}</td><td>{inr(row.value)}</td></tr>)}</tbody></table></div></div>;
        }}
        summaryTables={(filteredRows) => [{ title: 'Category-wise Summary', columns: [{ key: 'category', label: 'Category' }, { key: 'unit', label: 'Unit' }, { key: 'qty', label: 'Quantity' }, { key: 'value', label: 'Value (INR)' }], rows: categorySummaryRows(filteredRows) }]}
        filters={[
          {
            key: 'category',
            placeholder: 'All Categories',
            options: [...new Set(rows.map((r) => r.category))].sort().map((c) => ({ value: c, label: c }))
          }
        ]}
        totals={[
          { colKey: 'currentQty', render: (rs) => formatQuantityByUnit(rs, 'currentQty') },
          { colKey: 'stockValue', render: (rs) => rs.reduce((a, r) => a + r.stockValue, 0) }
        ]}
      />
    </div>
  );
};

export default InventoryValuationPage;
