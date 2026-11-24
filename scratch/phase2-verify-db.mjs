// READ-ONLY Phase 2 verification helper.
// Queries erp_state keys + sizes and validates report math offline.
// NEVER writes to the database or localStorage.
import { getPool, closeDatabase } from '../server/database.js';

const db = getPool();

const cols = await db.query(
  "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'erp_state' ORDER BY ordinal_position"
);
console.log('erp_state columns:', cols.rows.map((r) => `${r.column_name}(${r.data_type})`).join(', '));

const keys = await db.query('SELECT storage_key FROM erp_state ORDER BY storage_key');
console.log('--- erp_state keys ---');
keys.rows.forEach((r) => console.log(' ', r.storage_key));

await closeDatabase();
