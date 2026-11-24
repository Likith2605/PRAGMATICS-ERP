import { getPool, closeDatabase } from '../server/database.js';

async function main() {
  const p = getPool();
  const tables = await p.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
  );
  console.log('Tables:', tables.rows.map(r => r.table_name));

  const state = await p.query(
    'SELECT storage_key, length(data::text) as bytes, updated_at FROM erp_state ORDER BY storage_key'
  );
  console.log('erp_state rows (' + state.rows.length + '):');
  for (const row of state.rows) {
    console.log(`  - ${row.storage_key} (${row.bytes} bytes, updated: ${row.updated_at.toISOString()})`);
  }

  // Also check counts of ballooning tables
  for (const tbl of ['ballooning_projects', 'ballooning_drawings', 'ballooning_balloons', 'ballooning_characteristics', 'ballooning_inspections', 'ballooning_approvals']) {
    try {
      const res = await p.query(`SELECT count(*) FROM ${tbl}`);
      console.log(`  - ${tbl}: ${res.rows[0].count} records`);
    } catch (e) {
      console.log(`  - ${tbl}: query error: ${e.message}`);
    }
  }

  await closeDatabase();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
