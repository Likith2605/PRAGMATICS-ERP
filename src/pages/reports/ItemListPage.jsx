import React, { useMemo, useState } from 'react';
import ReportRegister from '../../components/ReportRegister.jsx';
import { getInventoryItems } from '../../utils/storeService.js';
import { formatQuantityByUnit } from '../../utils/reportFilters.js';

const ItemListPage = () => {
  const rows = useMemo(() => {
    const list = getInventoryItems().map((it) => {
      return {
        itemCode: it.itemCode || '',
        materialName: it.materialName || '',
        category: it.category || 'Uncategorised',
        unit: it.unit || '',
        hsnSac: it.hsnSac || '',
        currentQty: Number(it.currentQty) || 0,
        unitCost: Number(it.unitCost) || 0
      };
    });
    return list;
  }, []);
  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <ReportRegister
        title="List of Items"
        subTitle={`${rows.length} item(s)`}
        filename={`Item-List-${new Date().toISOString().slice(0, 10)}`}
        dateFilters={false}
        dateFilterNote="Date filtering is not applicable to item master data."
        disableCommonFilters
        pdfOnly
        showPrint
        hidePagination
        defaultPageSize="all"
        columns={[
          { key: 'itemCode', label: 'Item Code' },
          { key: 'materialName', label: 'Item Name' },
          { key: 'category', label: 'Category' },
          { key: 'unit', label: 'Unit' },
          { key: 'hsnSac', label: 'HSN/SAC' },
          { key: 'currentQty', label: 'Current Qty', align: 'right' },
          { key: 'unitCost', label: 'Unit Cost (₹)', align: 'right' },
        ]}
        rows={filteredRows}
        totals={[{ colKey: 'currentQty', render: (rs) => formatQuantityByUnit(rs, 'currentQty') }]}
      />
    </div>
  );
};

export default ItemListPage;
