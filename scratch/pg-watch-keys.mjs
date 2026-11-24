import { getPool, closeDatabase } from '../server/database.js';

const db = getPool();
const watch = ['companySettings', 'notifications', 'storeAuditLog', 'employees', 'erpUsers', 'erpSession'];
const res = await db.query(
    'SELECT storage_key, data FROM erp_state WHERE storage_key = ANY($1)',
    [watch]
);
for (const row of res.rows) {
    console.log(`--- ${row.storage_key} ---`);
    console.log(JSON.stringify(row.data));
}
await closeDatabase();
