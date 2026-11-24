import { getPool, closeDatabase } from '../server/database.js';

const db = getPool();
const res = await db.query('SELECT storage_key, data FROM erp_state ORDER BY storage_key');

const MARKERS = ['TEST-', 'Audit ', '__bulk_test', 'AUDIT '];
const hits = [];
for (const row of res.rows) {
    const text = JSON.stringify(row.data);
    const found = MARKERS.filter((m) => text.includes(m));
    if (found.length) {
        hits.push({ key: row.storage_key, markers: found, sample: text.slice(0, 220) });
    }
}
console.log(`Keys containing audit/test markers: ${hits.length}`);
for (const h of hits) console.log(`  ${h.key}  [${h.markers.join(', ')}]  ${h.sample}`);
await closeDatabase();
