-- Central binary file storage in PostgreSQL (Phase 1 of PG-first hardening).
--
-- Browser modules (project drawings, workflow document attachments) used to
-- keep their files in IndexedDB only — invisible to database backups. Every
-- file is now mirrored here while IndexedDB remains a local cache for fast
-- rendering. Ballooning drawings keep their dedicated handling (disk +
-- ballooning_drawings metadata) and are not stored in this table.

CREATE TABLE IF NOT EXISTS file_blobs (
  id text PRIMARY KEY,
  file_name text NOT NULL DEFAULT 'document',
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  scope text NOT NULL DEFAULT 'generic',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Scope groups files by owning module (e.g. 'drawing', 'workflow') for
-- maintenance queries and future quota reporting.
CREATE INDEX IF NOT EXISTS file_blobs_scope_idx ON file_blobs (scope, updated_at DESC);
