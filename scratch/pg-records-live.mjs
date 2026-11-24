// Lists live module_records rows (used during the Phase 2 browser demo).
import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const result = await pool.query(
  `SELECT storage_key, record_id, version, updated_by, updated_at,
          left(data::text, 60) AS data_preview
     FROM module_records
    ORDER BY storage_key, record_id`
);
console.log(`module_records rows: ${result.rows.length}`);
console.table(result.rows);
await pool.end();
