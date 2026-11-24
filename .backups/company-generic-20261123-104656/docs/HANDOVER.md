# ERP Handover Guide — PostgreSQL Edition

> Audience: the team taking over day-to-day operation of this ERP.
> Last updated: Phase 1 (PostgreSQL-first hardening) — every module's data and
> every file attachment is now stored in PostgreSQL.

---

## 1. What this system is

A quotation / manufacturing ERP (React frontend + Express API + PostgreSQL).

| Piece | Technology | Where it runs |
|---|---|---|
| User interface | React + Vite | Browser |
| API server | Node.js + Express (`server.js`) | Same machine, port **3001** |
| Database | PostgreSQL 18 (service `postgresql-x64-18`) | Same machine, port **5432** |
| Database name | `newDB` (see `DATABASE_URL` in `.env`) | — |

---

## 2. How data flows (important concept)

```
 ┌─────────────── Browser ────────────────┐        ┌──────── Server ────────┐
 │  Module pages (Sales, Store, …)        │        │  Express API :3001     │
 │        │ read/write                    │        │        │               │
 │        ▼                               │  HTTP  │        ▼               │
 │  localStorage  ◄── fast local cache ───┼────────►  PostgreSQL            │
 │  IndexedDB     (file thumbnails/cache) │        │   • erp_state  (all     │
 └────────────────────────────────────────┘        │     module records)     │
       Every ~1.5s + instantly on change           │   • ballooning_* (6 tbl) │
       queued & retried when offline               │   • file_blobs (files)  │
                                                   └─────────────────────────┘
```

- **PostgreSQL is the home of the data.** The browser keeps a working copy so
  the UI is fast and the app survives brief network outages.
- On every app start, the server copy is loaded **first**, then the browser
  pushes up anything the server doesn't have yet.
- Files (project drawings, invoice/inspection attachments) are uploaded to
  `file_blobs` — a `pg_dump` therefore captures the **entire** ERP.

### What is deliberately NOT in PostgreSQL

| Item | Reason |
|---|---|
| Login session (`erp_auth`) | Re-authenticated each browser session |
| The document currently being edited (`currentQuotation`, `currentVendorEnquiry`, `currentVendorQuotation`) | Drafts; saved to history keys when completed |
| Daily snapshots / backup audit logs (`erpDailySnapshots*`, `erpBackupAuditLogs*`) | Too large & transient — export via **Backup & Export** page |
| Ballooning drawing PDFs | Stored as files on disk (`storage/drawings/`) with metadata in `ballooning_drawings` |

---

## 3. First-time setup on a new machine

1. Install **Node.js 18+** and **PostgreSQL 18** (default port 5432).
2. Create the database and user:
   ```sql
   CREATE ROLE postgres LOGIN SUPERUSER PASSWORD 'postgres';
   CREATE DATABASE newDB OWNER postgres;
   ```
3. Copy `.env.example` → `.env` and set:
   ```
   DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/newDB
   VITE_API_URL=http://localhost:3001/api/ballooning
   VITE_API_BASE_URL=http://localhost:3001/api
   ```
4. Install & start:
   ```bash
   npm install
   npm run db:migrate     # applies migrations/*.sql (tracked in schema_migrations)
   npm run server         # Express API on :3001 (runs migrations automatically too)
   npm run dev            # Vite UI on :5173
   ```
   Or simply double-click **`Start.bat`**.

**Verify:**
```bash
npm run db:check          # → "PostgreSQL connected"
curl http://localhost:3001/api/health
                           # → "database": { "configured": true, "connected": true }
```

---

## 4. The on-screen status banner (bottom-right corner)

| Appearance | Meaning | Action |
|---|---|---|
| 🟢 green — *PostgreSQL connected* | Everything saved & confirmed | None |
| 🟡 amber — *Saving N changes…* | Normal; writes in flight (clears in ~1s) | None |
| 🔴 red — *Offline — N changes queued* | Server unreachable; changes **queued in the browser** and auto-retry every 1.5s | Fix the server; open the pill → **Retry now** |
| ⚪ grey — *Connecting…* | First connection attempt | Wait |

Click the pill for details (last confirmed save time, last error, manual retry).

---

## 5. Backup & restore

### Backup (schedule this daily)
```bash
pg_dump -h localhost -U postgres -F c -f "D:\ERP_Backups\newDB_%date%.dump" newDB
```
This single file contains **all records and all attachments**.

### Restore
```bash
pg_restore -h localhost -U postgres -d newDB -c "D:\ERP_Backups\newDB_....dump"
```

### Verify after any backup
```bash
npm run db:check
npm run test:audit        # full 57-check end-to-end suite (see §7)
```

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Banner red: *password authentication failed* | `.env` password ≠ database password | Reset with: `ALTER ROLE postgres WITH PASSWORD '...';` (needs temporary `trust` in `pg_hba.conf`) or update `.env` |
| Banner red: *connection refused* | PostgreSQL service stopped | `Start-Service postgresql-x64-18` |
| `DATABASE_URL is not configured` | `.env` missing/blank | See §3 step 3 |
| Health API says `migrations: []` | Migrations never ran | `npm run db:migrate` |
| Uploads fail with *413 payload too large* | File > `MAX_FILE_BYTES` (50 MB default) | Raise `MAX_FILE_BYTES` in `.env` (body limit is 120 MB) |
| Two users' changes overwrote each other | Known limitation — see §8 | Until Phase 2: one user per shared area at a time |

---

## 7. Test suite (run before/after any change)

```bash
npm run test:audit     # ★ full PostgreSQL audit: schema, 26 modules, restart, ballooning — 57 checks
npm run test:records   # per-record multi-user safety: conflicts, delete-race, whitelist — 26 checks
npm run test:files     # file storage API (file_blobs) — 15 checks
npm run test:postgres  # connection + migrations
npm run test:db-crud   # record CRUD
npm run test:all       # everything
```

> Note: `test:audit` writes identifiable `*-TEST-*` samples into `erp_state`
> to prove round-trips. They are safe to delete afterwards (the shipped
> cleanup script pattern is: delete keys whose content is test-only).
> `test:records` and `test:audit` clean up their own records in
> `module_records`, so that table holds only real data after a run.

---

## 8. Known limitations & roadmap

**Phase 1 (delivered):** PostgreSQL is authoritative — instant write-through
sync, offline queue + retry, files in `file_blobs`, status banner, handover docs.

**Phase 2 — Inventory & Stock Transactions (delivered):** these two lists no
longer live as one JSON blob per key. Every item/transaction is its own row in
the `module_records` table with a **version counter** and an **`updated_by`
audit field**, saved through the per-record API (`/api/records/:key`):

- Two people editing **different** items never overwrite each other.
- Two people editing the **same** item: the later save is refused, the browser
  receives the newest server copy, and an amber **"Sync conflict"** notice
  explains what happened — nothing is lost silently.
- Deletions propagate the same way (a delete based on outdated data is refused
  and reported instead of removing someone's newer work).
- The generic `/api/state` mirror **rejects** these keys now, so there is
  exactly one authority per module.

**Phase 2 — remaining modules (recommended next):** the same per-record pattern
is ready for other shared lists (Store, Orders, Production). Onboarding a
module = add its key to `RECORD_KEYS` in `server/moduleRecordsRoutes.js` and to
`MODULE_KEYS` in `src/services/recordsSync.js` — **no schema change needed**.

**Minor:** drawings uploaded *while the API server is down* stay in the
browser until the record is saved again (everything else queues automatically).
Ballooning offline-fallback drawings behave the same way.

---

## 9. Key file map (for developers)

| Area | Files |
|---|---|
| DB pool, migrations | `server/database.js`, `migrations/*.sql` |
| ERP state API (`/api/state`) | `server/erpStateRoutes.js` → table `erp_state` |
| Per-record API (`/api/records`) | `server/moduleRecordsRoutes.js` → table `module_records` |
| File API (`/api/files`) | `server/fileRoutes.js` → table `file_blobs` |
| Ballooning API (`/api/ballooning`) | `server/ballooningRoutes.js` → `ballooning_*` tables |
| Browser sync engine + status | `src/services/erpStateSync.js` |
| Per-record sync (diff + versioning + conflicts) | `src/services/recordsSync.js` |
| File client | `src/services/fileApi.js` |
| Attachments (drawings / docs) | `src/utils/drawingStorage.js`, `src/utils/workflowFiles.js` |
| Status banner + conflict notice | `src/components/SyncStatusBar.jsx`, `src/styles/sync-status.css` |
| Server entry | `server.js` |

### Per-record API cheat sheet

```
GET  /api/records/:key          -> { records:[{ id, data, version, updatedAt, updatedBy }] }
PUT  /api/records/:key
     body    { records:[{id,data,version}], deletes:[{id,version}], updatedBy }
     response{ saved:[{id,version}], deleted:[id], conflicts:[{id,data,version,updatedBy}] }
```

A conflict response means *"someone saved this record after you last saw it"* —
the server kept its copy; the client applies it and tells the user.
