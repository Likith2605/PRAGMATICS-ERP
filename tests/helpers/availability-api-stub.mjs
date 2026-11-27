const records = new Map();
const vendors = [];
export const storeAuditEntries = [];
let vendorSequence = 0;
const read = (key, fallback = []) => {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(key) || 'null');
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
};
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});
const linesFor = (soNumber) => {
  const salesOrder = read('salesOrderHistory').find((row) => String(row.reference) === String(soNumber));
  if (!salesOrder) return [];
  const inventory = read('inventoryItems');
  return (salesOrder.payload?.items || []).map((item, index) => {
    const code = String(item.itemCode || '').trim();
    const name = String(item.itemName || '').trim();
    const stock = inventory.find((entry) =>
      (code && String(entry.itemCode || '').toLowerCase() === code.toLowerCase()) ||
      (name && entry.itemName && String(entry.itemName).toLowerCase() === name.toLowerCase())
    );
    const availableStock = Number(stock?.currentQty) || 0;
    const orderedQty = Number(item.quantity) || 0;
    const shortageQty = Math.max(0, orderedQty - availableStock);
    return {
      lineNo: index + 1,
      materialCode: code || stock?.itemCode || '',
      materialName: name || '-',
      drawingNo: item.drawingNo || '',
      hsnSac: item.hsnSac || '',
      unit: item.unit || stock?.unit || 'Nos',
      orderedQty,
      availableStock,
      requiredQty: orderedQty,
      availableQty: Math.min(availableStock, orderedQty),
      shortageQty,
      purchaseQty: shortageQty,
      status: shortageQty > 0 ? 'Purchase Required' : 'Available',
      inventoryMatched: Boolean(stock)
    };
  });
};

const existing = read('soMaterialAvailabilityChecks');
if (Array.isArray(existing)) existing.forEach((record) => records.set(String(record.soNumber), { ...record, recordVersion: record.recordVersion || 1 }));

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input), 'http://localhost');
  const path = url.pathname;
  if (path === '/api/store/audit' && options.method === 'POST') {
    const entry = JSON.parse(options.body || '{}');
    storeAuditEntries.push(entry);
    return jsonResponse({ record: entry }, 201);
  }
  if (path === '/api/masters/vendors' && (!options.method || options.method === 'GET')) {
    return jsonResponse({ records: vendors });
  }
  if (path === '/api/masters/vendors' && options.method === 'POST') {
    const body = JSON.parse(options.body || '{}');
    const data = body.data || {};
    vendorSequence += 1;
    const record = {
      ...data,
      id: `test-vendor-${vendorSequence}`,
      seq: vendorSequence,
      vendorCode: `V-${String(vendorSequence).padStart(4, '0')}`,
      version: 1
    };
    vendors.unshift(record);
    return jsonResponse({ record }, 201);
  }
  if (path === '/api/sales-orders' && (!options.method || options.method === 'GET')) {
    return jsonResponse({
      records: read('salesOrderHistory').map((row) => ({
        ...row,
        reference: row.reference,
        payload: row.payload
      }))
    });
  }
  if (path === '/api/inventory/items' && (!options.method || options.method === 'GET')) {
    return jsonResponse({
      records: read('inventoryItems').map((row) => ({
        item_code: row.itemCode || row.id,
        material_name: row.itemName,
        category: row.category || 'Raw Material',
        unit: row.unit || 'Nos',
        current_qty: row.currentQty,
        reorder_level: row.reorderLevel || 0,
        unit_price: row.unitPrice || 0,
        hsn_code: row.hsnSac || '',
        location: row.location || '',
        payload: {
          id: row.id,
          itemCode: row.itemCode,
          itemName: row.itemName,
          description: row.description || '',
          category: row.category || 'Raw Material',
          specification: row.specification || row.spec || '',
          spec: row.spec || row.specification || '',
          unit: row.unit || 'Nos',
          reservedQty: row.reservedQty || 0
        },
        version: row.version || 1
      }))
    });
  }
  if (path === '/api/records/soMaterialAvailabilityChecks' && (!options.method || options.method === 'GET')) {
    return jsonResponse({
      records: [...records.values()].map((record) => ({
        data: record,
        id: record.soNumber,
        version: record.recordVersion,
        updatedAt: record.checkedAt,
        updatedBy: record.checkedBy
      }))
    });
  }
  const match = path.match(/^\/api\/availability-checks\/([^/]+)(?:\/production-notified)?$/);
  if (match && options.method === 'PUT') {
    const soNumber = decodeURIComponent(match[1]);
    const body = JSON.parse(options.body || '{}');
    const previous = records.get(soNumber);
    const expected = Number(body.version);
    if ((previous?.recordVersion || 0) !== expected) return jsonResponse({ error: 'stale version' }, 409);
    const salesOrder = read('salesOrderHistory').find((row) => String(row.reference) === soNumber);
    if (!salesOrder) return jsonResponse({ error: `Sales Order ${soNumber} not found.` }, 409);
    const record = {
      soNumber,
      projectId: salesOrder.payload?.soDetails?.projectId || '',
      customer: salesOrder.payload?.customerDetails?.companyName || salesOrder.company || '',
      orderDate: salesOrder.payload?.soDetails?.soDate || salesOrder.date || '',
      deliveryDate: salesOrder.payload?.soDetails?.deliveryDate || '',
      status: 'Checked',
      lines: linesFor(soNumber),
      remarks: String(body.remarks || ''),
      checkedBy: 'Test Store',
      checkedByEmpId: '',
      checkedByDept: 'Store Department',
      checkedAt: new Date().toISOString(),
      checkedDate: new Date().toISOString().slice(0, 10),
      productionNotified: previous?.productionNotified || false,
      productionNotifiedAt: previous?.productionNotifiedAt || '',
      history: [...(previous?.history || []), { action: 'Availability check saved' }],
      recordVersion: expected + 1
    };
    records.set(soNumber, record);
    return jsonResponse({ record });
  }
  if (match && options.method === 'POST') {
    const soNumber = decodeURIComponent(match[1]);
    const previous = records.get(soNumber);
    if (!previous) return jsonResponse({ error: 'Availability check not found.' }, 404);
    const record = { ...previous, productionNotified: true, productionNotifiedAt: new Date().toISOString(), recordVersion: previous.recordVersion + 1 };
    records.set(soNumber, record);
    return jsonResponse({ record });
  }
  return jsonResponse({ success: true });
};
