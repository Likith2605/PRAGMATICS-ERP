import { getPool, closeDatabase } from '../server/database.js';

// Keys whose CURRENT erp_state content is 100% audit-suite test data
// (verified by inspection: pure single-element test arrays / fake settings).
// Deleting them lets the browser mirror re-upload the originals on next app start.
const TEST_ONLY_KEYS = [
    '__bulk_test_1793073266910',
    'boms',
    'customerInvoiceHistory',
    'customerPOHistory',
    'debitNotes',
    'deliveryChallanHistory',
    'exportInvoiceHistory',
    'inventoryItems',
    'machines',
    'materialReceipts',
    'materialRequests',
    'materialReturnHistory',
    'productionJobCards',
    'purchaseIndents',
    'qualityChecks',
    'quotationHistory',
    'salesOrderHistory',
    'stockTransactions',
    'storeIssueHistory',
    'supplierInvoiceHistory',
    'supplierPOHistory',
    'vendorEnquiries',
    'vendorMaster',
    'vendorQuotations',
    'storeAuditLog',
    'companySettings',
    'notifications'
];

const db = getPool();
const result = await db.query(
    'DELETE FROM erp_state WHERE storage_key = ANY($1) RETURNING storage_key',
    [TEST_ONLY_KEYS]
);
console.log(`Deleted ${result.rowCount} test-residue keys:`);
console.log(result.rows.map((r) => '  ' + r.storage_key).join('\n'));

const left = await db.query('SELECT count(*) AS n FROM erp_state');
console.log(`erp_state rows remaining: ${left.rows[0].n}`);
await closeDatabase();
