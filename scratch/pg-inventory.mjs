import { getPool, closeDatabase } from '../server/database.js';

const db = getPool();
const keys = await db.query(
    'SELECT storage_key, pg_column_size(data) AS bytes, updated_at FROM erp_state ORDER BY storage_key'
);
console.log(`erp_state keys in PostgreSQL: ${keys.rowCount}`);
for (const r of keys.rows) {
    console.log(`  ${String(r.storage_key).padEnd(34)}${String(r.bytes).padStart(9)} B   ${r.updated_at.toISOString()}`);
}
const bt = await db.query(`
    SELECT (SELECT count(*) FROM ballooning_projects)     AS projects,
           (SELECT count(*) FROM ballooning_drawings)     AS drawings,
           (SELECT count(*) FROM ballooning_balloons)     AS balloons,
           (SELECT count(*) FROM ballooning_characteristics) AS chars,
           (SELECT count(*) FROM ballooning_inspections)  AS inspections,
           (SELECT count(*) FROM ballooning_approvals)    AS approvals
`);
const r = bt.rows[0];
console.log(`ballooning rows: projects=${r.projects} drawings=${r.drawings} balloons=${r.balloons} characteristics=${r.chars} inspections=${r.inspections} approvals=${r.approvals}`);
await closeDatabase();
