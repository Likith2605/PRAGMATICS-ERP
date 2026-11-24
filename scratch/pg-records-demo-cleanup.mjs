// Removes the browser-demo records (INV-DEMO*) from module_records.
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const result = await pool.query(
  `DELETE FROM module_records WHERE record_id LIKE 'INV-DEMO%' RETURNING record_id`
);
console.log(`Deleted ${result.rowCount} demo record(s):`, result.rows.map((r) => r.record_id).join(', ') || '(none)');
const remaining = await pool.query('SELECT count(*) AS n FROM module_records');
console.log(`module_records rows remaining: ${remaining.rows[0].n}`);
await pool.end();
