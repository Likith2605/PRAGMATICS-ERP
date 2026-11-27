/** Apply repository migrations to the explicitly named Enquiry test database. */
import 'dotenv/config';
import pg from 'pg';

const databaseUrl = process.env.ERP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('ERP_TEST_DATABASE_URL is required.');
const targetName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
if (targetName !== 'vyavastha_test') throw new Error('Refusing to migrate: ERP_TEST_DATABASE_URL must name vyavastha_test exactly.');

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
    const identity = await pool.query('SELECT current_database() AS name');
    if (identity.rows[0]?.name !== 'vyavastha_test') throw new Error('Refusing to migrate: current_database() is not vyavastha_test.');
    const { runMigrations } = await
    import ('../server/database.js');
    await runMigrations(pool);
    const status = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const applied = status.rows.map((row) => row.version);
    if (!applied.includes('012_enquiry_create_token')) throw new Error('Migration 012_enquiry_create_token was not recorded.');
    console.log(`Database verified: ${identity.rows[0].name}`);
    console.log(`Applied migration 012_enquiry_create_token; ${applied.length} migration(s) are recorded.`);
} finally {
    await pool.end();
}
