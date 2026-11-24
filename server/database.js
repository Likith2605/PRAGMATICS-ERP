import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const migrationsDir = fileURLToPath(new URL('../migrations',
    import.meta.url));
let pool;

/**
 * Returns the shared connection pool, creating it on first call.
 * Throws if DATABASE_URL is not configured.
 */
export const getPool = () => {
    if (!process.env.DATABASE_URL) {
        throw new Error(
            'DATABASE_URL is not configured. ' +
            'Copy .env.example to .env and set DATABASE_URL=postgresql://postgres:PASSWORD@localhost:5432/newDB'
        );
    }
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            max: Number(process.env.DB_POOL_MAX || 10),
            connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
            idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
            ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
        });
        pool.on('error', (error) => {
            console.error('Unexpected PostgreSQL pool error:', error.message);
        });
    }
    return pool;
};

/**
 * Runs SELECT 1 to verify the database is reachable.
 * Returns true on success; throws on failure.
 */
export const checkDatabase = async () => {
    const result = await getPool().query('SELECT 1 AS connected');
    return result.rows[0].connected === 1;
};

/**
 * Applies all pending SQL migrations from the migrations/ directory.
 * Migrations are recorded in schema_migrations and skipped if already applied.
 * Each migration runs in a transaction; a failure rolls back the individual
 * migration and re-throws so the caller can abort startup cleanly.
 */
export const runMigrations = async () => {
    const db = getPool();

    // Ensure the tracking table exists before anything else.
    await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

    const files = (await readdir(migrationsDir))
        .filter((name) => /^\d+_.+\.sql$/i.test(name))
        .sort();

    for (const file of files) {
        const version = file.replace(/\.sql$/i, '');
        const applied = await db.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
        if (applied.rowCount) {
            // Already applied — skip silently.
            continue;
        }

        const sql = await readFile(join(migrationsDir, file), 'utf8');
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query(
                'INSERT INTO schema_migrations (version) VALUES ($1)',
                [version]
            );
            await client.query('COMMIT');
            console.log(`  ✓ Applied migration ${version}`);
        } catch (error) {
            await client.query('ROLLBACK');
            throw new Error(`Migration ${version} failed: ${error.message}`);
        } finally {
            client.release();
        }
    }
};

/**
 * Returns a list of applied migration versions and their timestamps.
 * Useful for diagnostics and the health endpoint.
 */
export const getMigrationStatus = async () => {
    try {
        const result = await getPool().query(
            'SELECT version, applied_at FROM schema_migrations ORDER BY applied_at'
        );
        return result.rows.map((row) => ({
            version: row.version,
            appliedAt: row.applied_at.toISOString()
        }));
    } catch {
        return [];
    }
};

/**
 * Gracefully drains the connection pool.
 * Call during server shutdown (SIGINT / SIGTERM).
 */
export const closeDatabase = async () => {
    if (pool) {
        await pool.end();
        pool = undefined;
    }
};