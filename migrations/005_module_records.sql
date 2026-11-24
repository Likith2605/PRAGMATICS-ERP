-- Per-record storage for shared modules (Phase 2: true multi-user safety).
--
-- The generic erp_state mirror stores each module as ONE JSON list per key,
-- so two people editing the same module from different computers overwrite
-- each other (last-write-wins on the whole list). This table stores every
-- record as its own row with a version counter, so:
--   * editing different records never collides,
--   * editing the SAME record is detected (stale version -> conflict)
--     and reported instead of silently losing work.
--
-- storage_key identifies the module list ('inventoryItems', 'stockTransactions',
-- ... more modules are onboarded by adding their keys to the whitelist in
-- server/moduleRecordsRoutes.js — no schema change needed).

CREATE TABLE IF NOT EXISTS module_records (
  storage_key text        NOT NULL,
  record_id   text        NOT NULL,
  data        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  version     bigint      NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text        NOT NULL DEFAULT '',
  PRIMARY KEY (storage_key, record_id)
);

CREATE INDEX IF NOT EXISTS module_records_key_updated_idx
  ON module_records (storage_key, updated_at DESC);

-- ---------------------------------------------------------------------------
-- One-time import: split the existing inventory list arrays in erp_state into
-- per-record rows, then delete them from erp_state so exactly ONE authority
-- remains. Records without an id get a deterministic id derived from content.
-- Empty arrays ([]) simply import zero rows.
-- ---------------------------------------------------------------------------

INSERT INTO module_records (storage_key, record_id, data, version, updated_at, updated_by)
SELECT
  e.storage_key,
  COALESCE(elem ->> 'id', 'rec-' || substr(md5(elem::text), 1, 12)) AS record_id,
  elem,
  1,
  e.updated_at,
  'migration-005'
FROM erp_state e
CROSS JOIN LATERAL jsonb_array_elements(e.data) AS elem
WHERE e.storage_key IN ('inventoryItems', 'stockTransactions')
  AND jsonb_typeof(e.data) = 'array'
ON CONFLICT (storage_key, record_id) DO NOTHING;

DELETE FROM erp_state WHERE storage_key IN ('inventoryItems', 'stockTransactions');
