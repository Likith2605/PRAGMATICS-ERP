import 'dotenv/config';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required; refusing reconciliation outside the test database.');
if (decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\/+/, '')) !== 'vyavastha_test') {
  throw new Error('Refusing reconciliation outside vyavastha_test.');
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const identity = await pool.query('SELECT current_database() AS name');
if (identity.rows[0]?.name !== 'vyavastha_test') {
  await pool.end();
  throw new Error('Refusing reconciliation: SELECT current_database() is not vyavastha_test.');
}

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

try {
  const snapshotResult = await pool.query(`
    SELECT storage_key,data
    FROM erp_state
    WHERE storage_key IN (
      'salesOrderHistory','customerInvoiceHistory','materialRequests','storeIssueHistory',
      'materialReturnHistory','storeAuditLog','inventoryBatches','stockTransfers','stockVerifications'
    )
  `);
  const snapshots = Object.fromEntries(
    snapshotResult.rows.map((row) => [row.storage_key, Array.isArray(row.data) ? row.data : null])
  );

  const sales = await pool.query(
    'SELECT so_number,payload,deleted_at,version FROM sales_orders'
  );
  const invoices = await pool.query(
    'SELECT invoice_number,payload,deleted_at,version FROM customer_invoices'
  );
  const batches = await pool.query(
    'SELECT id,item_code,batch_number,lot_number,available_qty,status FROM inventory_batches'
  );

  const activeSales = sales.rows.filter((row) => !row.deleted_at);
  const salesById = new Map(activeSales.map((row) => [String(row.so_number).toLowerCase(), row]));
  const salesLegacy = [...new Set((snapshots.salesOrderHistory || [])
    .map((row) => String(row?.payload?.soDetails?.soNumber || row?.reference || '').trim())
    .filter(Boolean))];
  const salesConflicts = [];
  const salesMissing = [];
  const salesExisting = [];
  for (const number of salesLegacy) {
    const row = salesById.get(number.toLowerCase());
    if (!row) {
      salesMissing.push(number);
      continue;
    }
    const legacy = (snapshots.salesOrderHistory || []).find((item) =>
      String(item?.payload?.soDetails?.soNumber || item?.reference || '').trim().toLowerCase() === number.toLowerCase());
    if (canonical(row.payload) === canonical(legacy?.payload)) salesExisting.push(number);
    else salesConflicts.push(number);
  }
  const salesLegacySet = new Set(salesLegacy.map((value) => value.toLowerCase()));
  const salesOnlyPostgres = activeSales
    .map((row) => String(row.so_number))
    .filter((value) => !salesLegacySet.has(value.toLowerCase()));

  const activeInvoices = invoices.rows.filter((row) => !row.deleted_at);
  const invoicesById = new Map(activeInvoices.map((row) => [String(row.invoice_number).toLowerCase(), row]));
  const invoiceLegacy = [...new Set((snapshots.customerInvoiceHistory || [])
    .map((row) => String(row?.payload?.invoiceDetails?.invoiceNumber || row?.reference || '').trim())
    .filter(Boolean))];
  const invoiceConflicts = [];
  const invoiceMissing = [];
  const invoiceExisting = [];
  for (const number of invoiceLegacy) {
    const row = invoicesById.get(number.toLowerCase());
    if (!row) {
      invoiceMissing.push(number);
      continue;
    }
    const legacy = (snapshots.customerInvoiceHistory || []).find((item) =>
      String(item?.payload?.invoiceDetails?.invoiceNumber || item?.reference || '').trim().toLowerCase() === number.toLowerCase());
    if (canonical(row.payload) === canonical(legacy?.payload)) invoiceExisting.push(number);
    else invoiceConflicts.push(number);
  }
  const invoiceLegacySet = new Set(invoiceLegacy.map((value) => value.toLowerCase()));
  const invoiceOnlyPostgres = activeInvoices
    .map((row) => String(row.invoice_number))
    .filter((value) => !invoiceLegacySet.has(value.toLowerCase()));

  const snapshotCounts = Object.fromEntries(
    Object.entries(snapshots).map(([key, value]) => [key, value == null ? 0 : value.length])
  );

  console.log('HISTORICAL DATA RECONCILIATION REPORT');
  console.log(`Database: ${identity.rows[0].name}`);
  console.log(`Sales Orders — legacy=${salesLegacy.length}, PostgreSQL active=${activeSales.length}, existing=${salesExisting.length}, missing=${salesMissing.length}, conflicts=${salesConflicts.length}, PostgreSQL-only=${salesOnlyPostgres.length}`);
  if (salesMissing.length) console.log(`  Missing Sales Order IDs: ${salesMissing.slice(0, 50).join(', ')}`);
  if (salesConflicts.length) console.log(`  Conflicting Sales Order IDs: ${salesConflicts.slice(0, 50).join(', ')}`);
  if (salesOnlyPostgres.length) console.log(`  PostgreSQL-only Sales Order IDs: ${salesOnlyPostgres.slice(0, 50).join(', ')}`);

  console.log(`Customer Invoices — legacy=${invoiceLegacy.length}, PostgreSQL active=${activeInvoices.length}, existing=${invoiceExisting.length}, missing=${invoiceMissing.length}, conflicts=${invoiceConflicts.length}, PostgreSQL-only=${invoiceOnlyPostgres.length}`);
  if (invoiceMissing.length) console.log(`  Missing Customer Invoice IDs: ${invoiceMissing.slice(0, 50).join(', ')}`);
  if (invoiceConflicts.length) console.log(`  Conflicting Customer Invoice IDs: ${invoiceConflicts.slice(0, 50).join(', ')}`);
  if (invoiceOnlyPostgres.length) console.log(`  PostgreSQL-only Customer Invoice IDs: ${invoiceOnlyPostgres.slice(0, 50).join(', ')}`);

  console.log(`Inventory Batches — PostgreSQL=${batches.rowCount}, legacy snapshot=${snapshotCounts.inventoryBatches || 0}`);
  console.log(`Seven-key snapshot counts: ${JSON.stringify(snapshotCounts)}`);
  console.log('No legacy row was imported, overwritten or deleted.');
} finally {
  await pool.end();
}
