// Checks module_records for leftover test/audit rows and lists real content.
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const counts = await pool.query(
  `SELECT storage_key, count(*) AS rows FROM module_records GROUP BY storage_key ORDER BY storage_key`
);
console.log('module_records contents:');
console.table(counts.rows);

const residue = await pool.query(
  `SELECT storage_key, record_id FROM module_records
    WHERE record_id LIKE '%TEST%' OR record_id LIKE 'AUDIT-%' OR record_id LIKE 'REC-A-%'
       OR record_id LIKE 'REC-B-%' OR record_id LIKE 'REC-C-%' OR data::text LIKE '%TEST-%'`
);
console.log(`Test-residue rows: ${residue.rows.length}`);
residue.rows.forEach((r) => console.log(`  ${r.storage_key} / ${r.record_id}`));
await pool.end();
