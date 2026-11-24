import { closeDatabase, runMigrations } from './database.js';

try {
    await runMigrations();
    console.log('Database migrations completed.');
} finally {
    await closeDatabase();
}