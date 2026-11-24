// Shows what migration 005 will import from erp_state into module_records.
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const result = await pool.query(
  `SELECT storage_key,
          jsonb_typeof(data) AS type,
          CASE WHEN jsonb_typeof(data) = 'array' THEN jsonb_array_length(data) ELSE 0 END AS items,
          length(data::text) AS bytes
     FROM erp_state
    WHERE storage_key IN ('inventoryItems', 'stockTransactions')`
);
console.log('Rows to import into module_records:');
console.table(result.rows);
if (result.rows.length === 0) console.log('  (none — arrays were cleaned earlier; migration will simply remove nothing)');
await pool.end();
