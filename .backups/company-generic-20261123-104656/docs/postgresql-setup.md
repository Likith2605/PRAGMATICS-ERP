# PostgreSQL Setup & Integration Guide

> **Pragmatics Engineers ERP — PostgreSQL 18 on Windows**

The ERP backend uses PostgreSQL for shared ERP state and all ballooning records. Browser localStorage and IndexedDB remain the offline fallback; they are never automatically deleted.

---

## Quick Start (First Time Setup)

### 1. Copy the environment template

```powershell
Copy-Item .env.example .env
```

Open `.env` in a text editor and fill in your values:

```env
# Required for PostgreSQL sync
DATABASE_URL=postgresql://postgres:YOUR_LOCAL_PASSWORD@localhost:5432/newDB

# Required for email (leave blank to disable email)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=your-email@gmail.com

# Server port (default 3001)
PORT=3001

# Connection pool settings (defaults are fine for local dev)
DB_POOL_MAX=10
DB_CONNECTION_TIMEOUT_MS=5000
DB_IDLE_TIMEOUT_MS=30000

# File storage for uploaded drawings (default: ./storage/drawings)
FILE_STORAGE_DIR=./storage

# Max upload size in bytes (default: 50 MB)
MAX_DRAWING_BYTES=52428800

# Set to true only when your PostgreSQL host requires TLS (e.g. cloud providers)
DATABASE_SSL=false

# Frontend API URL (Vite proxies from browser to backend)
VITE_API_URL=http://localhost:3001/api/ballooning
VITE_API_BASE_URL=http://localhost:3001/api
```

> **Security**: `.env` is in `.gitignore` and must never be committed. Your password stays on your machine only.

---

### 2. Create the database in pgAdmin

1. Open **pgAdmin 4** → connect to `localhost:5432` with user `postgres`.
2. Right-click **Databases** → **Create** → **Database**.
3. Name it `newDB`, owner `postgres` → **Save**.

### 3. Install dependencies

```powershell
npm install
```

### 4. Run migrations

```powershell
npm run db:migrate
```

Expected output:
```
Applied migration 001_ballooning
Applied migration 002_erp_state
Applied migration 003_erp_indexes
Database migrations completed.
```

If a migration was already applied it is silently skipped (safe to re-run).

### 5. Verify the database connection

```powershell
npm run db:check
```

Expected: `PostgreSQL connected`

### 6. Start the application

**Option A — One-click launcher (recommended for Windows)**
```
Double-click Start.bat
```

**Option B — Two terminals**

Terminal 1 (backend API server):
```powershell
npm run server
```

Terminal 2 (Vite frontend):
```powershell
npm run dev
```

Open: [http://localhost:5173](http://localhost:5173)

---

## Database Schema

Migrations live in `migrations/` and are tracked in `schema_migrations`. They run in transactions and are skipped once applied. They never drop or truncate existing tables.

| Migration | Creates |
|---|---|
| `001_ballooning.sql` | `ballooning_projects`, `ballooning_drawings`, `ballooning_balloons`, `ballooning_characteristics`, `ballooning_inspections`, `ballooning_approvals` |
| `002_erp_state.sql` | `erp_state` (key→JSONB bridge for all ERP localStorage keys) |
| `003_erp_indexes.sql` | Performance indexes on status, drawing number, balloon, and key-prefix columns |

### Table purposes

**`ballooning_projects`** — One row per ballooning inspection project. Flexible JSONB `data` column holds drawing number, part name, customer, inspector, status, and all custom fields.

**`ballooning_drawings`** — Drawing metadata (file name, drawing number, page count). Binary files are stored on disk at `FILE_STORAGE_DIR/drawings/`. The `storage_name` column links the database row to the physical file.

**`ballooning_balloons`** — Individual balloon callouts. Each has a numeric `number`, a `drawing_id`, and a JSONB `data` field (coordinates, dimension text, tolerance, rotation, status, etc.).

**`ballooning_characteristics`** — Inspection characteristics linked to a balloon. Holds OCR-detected or manually entered engineering values, limits, actual measurements, and pass/fail status.

**`ballooning_inspections`** — One per project; tracks overall inspector/reviewer/approval status.

**`ballooning_approvals`** — Append-only approval history for a project.

**`erp_state`** — Key/value store. `storage_key` is the localStorage key; `data` is the parsed JSON value. Covers every ERP module: quotations, sales/purchase orders, production, store, inventory, invoices, employees, vendors, settings, notifications, quality, etc.

---

## API Endpoints

### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Overall health: API status, SMTP configured, PostgreSQL connected |
| `GET` | `/api/ballooning/health` | Ballooning database connectivity |

### ERP State Sync

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/state` | Fetch all synced ERP records |
| `PUT` | `/api/state` | Upsert changed ERP records (batch, in transaction) |

### Ballooning Projects

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/ballooning/projects` | List all projects (newest first) |
| `POST` | `/api/ballooning/projects` | Create project |
| `GET` | `/api/ballooning/projects/:id` | Get single project |
| `PUT` | `/api/ballooning/projects/:id` | Partial update project |
| `DELETE` | `/api/ballooning/projects/:id` | Delete project (cascades to drawings, balloons, characteristics) |
| `POST` | `/api/ballooning/projects/:id/duplicate` | Deep copy a project including drawings and balloons |

### Drawings

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/ballooning/projects/:id/drawing` | Upload drawing file (multipart, field `drawing`) |
| `GET` | `/api/ballooning/projects/:id/drawings` | List drawings for a project |
| `GET` | `/api/ballooning/projects/:id/drawing` | Get newest drawing for a project |
| `PUT` | `/api/ballooning/projects/:pId/drawings/:dId` | Update drawing metadata |
| `DELETE` | `/api/ballooning/projects/:pId/drawings/:dId` | Delete drawing metadata |
| `GET` | `/api/ballooning/drawings/:id/file` | Download raw drawing file (PDF/PNG) |

### Balloons & Characteristics

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/ballooning/projects/:id/balloons` | List balloons (filter by `?drawingId=`) |
| `POST` | `/api/ballooning/projects/:id/balloons` | Create balloon |
| `PUT` | `/api/ballooning/balloons/:id` | Update balloon |
| `DELETE` | `/api/ballooning/balloons/:id` | Delete balloon + its characteristics |
| `GET` | `/api/ballooning/projects/:id/characteristics` | List characteristics (filter by `?drawingId=`) |
| `POST` | `/api/ballooning/projects/:id/characteristics` | Create characteristic |
| `PUT` | `/api/ballooning/characteristics/:id` | Update characteristic |
| `DELETE` | `/api/ballooning/characteristics/:id` | Delete characteristic |
| `POST` | `/api/ballooning/projects/:id/approval` | Submit approval record |

---

## How ERP ↔ PostgreSQL Sync Works

1. **App startup** (`App.jsx`) calls `syncERPState()`.
   - If PostgreSQL has records → hydrates browser localStorage from the database.
   - If PostgreSQL is empty → uploads current browser localStorage to the database.
2. **Background mirror** (`startERPStateMirror`) runs every 1.5 seconds. If localStorage has changed, it upserts only changed records to `/api/state`.
3. **Ballooning pages** (`ballooningApi.js`) try the backend first on every request. On network failure they fall back to localStorage/IndexedDB transparently.

### Browser-local only (never synced)
- `erp_auth` — login session token
- `currentQuotation`, `currentVendorEnquiry`, `currentVendorQuotation` — in-progress form drafts
- `erpDailySnapshots`, `erpBackupAuditLogs` — local backup history

---

## Migrating Existing Browser Data to PostgreSQL

Run these steps after the server is started and migrations are applied.

### ERP module records (localStorage)

The browser automatically uploads its current state to PostgreSQL on the first connection when the database is empty. If you need to force-resync:

1. Open the app at `http://localhost:5173`.
2. Open DevTools → Console.
3. Paste and run:
```javascript
import('/src/services/erpStateSync.js').then(m => m.syncERPState()).then(ok => console.log('Sync:', ok));
```
Or simply clear the database's `erp_state` table and reload — the next page load will re-upload from localStorage.

### Ballooning projects (localStorage + IndexedDB)

Existing ballooning projects in localStorage are served through the local fallback when the backend is unreachable. To move them permanently to PostgreSQL:

1. Go to `/ballooning` in the app — projects listed came from localStorage.
2. The `ballooningApi.js` will automatically use the backend on next project creation.
3. Old projects can be exported from `/ballooning/project/:id/export` and reimported.

> **Note**: The `BalloonDrawingFilesDB` IndexedDB and the `DrawingFilesDB` (used by workflow/job-card drawing attachments) are separate stores. Ballooning drawing PDFs uploaded via the API are stored in `./storage/drawings/` on disk; legacy local drawing data-URLs remain in `DrawingFilesDB` unless explicitly migrated.

---

## Backup and Restore

### Backup the database

```powershell
# Requires pg_dump in PATH (usually C:\Program Files\PostgreSQL\18\bin)
pg_dump --host=localhost --port=5432 --username=postgres --format=custom --file="backup_$(Get-Date -Format 'yyyyMMdd').dump" newDB
```

### Backup drawing files

```powershell
Copy-Item -Path ".\storage\drawings" -Destination ".\storage\drawings_backup_$(Get-Date -Format 'yyyyMMdd')" -Recurse
```

### Restore

```powershell
pg_restore --host=localhost --port=5432 --username=postgres --dbname=newDB "backup_20261026.dump"
```

> Always back up `./storage/drawings/` alongside the database. Database rows referencing drawing files that no longer exist on disk will return 404 on download.

---

## Running Tests

```powershell
# Unit tests for ballooning logic (no database needed)
npm run test:ballooning

# PostgreSQL integration test (requires DATABASE_URL in .env and server not already on 3311)
npm run test:postgres
```

The integration test (`tests/postgresql.test.mjs`) verifies:
- Migrations apply without error
- Health endpoint reports database connected
- ERP state PUT/GET round-trip
- Ballooning project creation, balloon CRUD, cascade delete

---

## Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | *(required for sync)* | PostgreSQL connection string |
| `DB_POOL_MAX` | `10` | Max connections in pool |
| `DB_CONNECTION_TIMEOUT_MS` | `5000` | Pool connection timeout (ms) |
| `DB_IDLE_TIMEOUT_MS` | `30000` | Idle connection expiry (ms) |
| `DATABASE_SSL` | `false` | Set `true` for TLS-required hosted Postgres |
| `FILE_STORAGE_DIR` | `./storage` | Root for drawing file storage |
| `MAX_DRAWING_BYTES` | `52428800` | Max drawing upload size (50 MB) |
| `PORT` | `3001` | Backend API server port |
| `SMTP_HOST` | — | SMTP server host |
| `SMTP_PORT` | `587` | SMTP server port |
| `SMTP_USER` | — | SMTP login user |
| `SMTP_PASS` | — | SMTP login password |
| `SMTP_FROM` | *(SMTP_USER)* | From address for sent emails |
| `VITE_API_URL` | `http://localhost:3001/api/ballooning` | Frontend ballooning API base |
| `VITE_API_BASE_URL` | `http://localhost:3001/api` | Frontend ERP state API base |

---

## Troubleshooting

### `DATABASE_URL is not configured`
Create `.env` from `.env.example` and set the `DATABASE_URL` variable. The app works offline without it.

### `password authentication failed for user "postgres"`
Verify the password in pgAdmin: right-click the `postgres` login role → Properties → Password. Update `.env` accordingly. Do not put the password in source control.

### `ECONNREFUSED 127.0.0.1:5432`
The PostgreSQL service is not running. Open **Services** (Windows), find `postgresql-x64-18`, right-click → **Start**.

### `database "newDB" does not exist`
Create the database in pgAdmin (right-click Databases → Create → Database → name: `newDB`) then rerun `npm run db:migrate`.

### `Migration 001_ballooning failed: relation "ballooning_projects" already exists`
This should not happen — all DDL uses `CREATE TABLE IF NOT EXISTS`. If it does, a partial migration may have left inconsistent state. Run:
```sql
DELETE FROM schema_migrations WHERE version = '001_ballooning';
```
Then rerun `npm run db:migrate` after verifying the tables exist.

### UI shows local data even with server running
This is the deliberate offline fallback. Check:
1. `http://localhost:3001/api/health` — is `database.connected` true?
2. Is the backend server (`node server.js`) actually running in a separate window?
3. Is `VITE_API_URL` / `VITE_API_BASE_URL` correct in `.env`?
4. Restart both the backend and the Vite dev server after changing `.env`.

### PostgreSQL 18 specific notes
- PostgreSQL 18 requires the connection string port to match the actual service port (default 5432). The service is `postgresql-x64-18` on Windows.
- The `pg` npm package version 8.x is compatible with PostgreSQL 18.
- `DATABASE_SSL=false` is correct for local development. Cloud PostgreSQL providers typically require `DATABASE_SSL=true`.

### `ENFILE` or `EMFILE` (too many open files) during migration
This is a Windows file handle limit. Stop other Node.js processes and retry.

### Drawing files not found after server restart
Verify `FILE_STORAGE_DIR` in `.env` points to the same directory as before. Default is `./storage` (relative to the project root). Never delete `./storage/drawings/` while records exist in `ballooning_drawings`.
