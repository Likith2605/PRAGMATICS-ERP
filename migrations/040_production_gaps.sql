-- Production / BOM / HT outsource gaps: material snapshots, operation entries,
-- idempotency tokens and deletion metadata. Applied migrations 036-038 are
-- never modified; this migration only adds missing objects.

CREATE TABLE IF NOT EXISTS production_sequences (
  sequence_key text PRIMARY KEY,
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE production_requirements ADD COLUMN IF NOT EXISTS create_token text;
ALTER TABLE production_requirements ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE production_requirements ADD COLUMN IF NOT EXISTS delete_reason text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS production_requirements_create_token_idx
  ON production_requirements (create_token) WHERE create_token IS NOT NULL;

ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS create_token text;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS bom_number text NOT NULL DEFAULT '';
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS bom_version integer NOT NULL DEFAULT 0;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS issued_at timestamptz;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS issued_by text;
CREATE UNIQUE INDEX IF NOT EXISTS job_cards_create_token_idx
  ON job_cards (create_token) WHERE create_token IS NOT NULL;

ALTER TABLE ht_outsource_requests ADD COLUMN IF NOT EXISTS create_token text;
ALTER TABLE ht_outsource_requests ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE ht_outsource_requests ADD COLUMN IF NOT EXISTS delete_reason text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS ht_outsource_requests_create_token_idx
  ON ht_outsource_requests (create_token) WHERE create_token IS NOT NULL;

ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS create_token text;
ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE bom_headers ADD COLUMN IF NOT EXISTS delete_reason text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS bom_headers_create_token_idx
  ON bom_headers (create_token) WHERE create_token IS NOT NULL;

-- Immutable BOM snapshot taken when a Job Card is issued. Later BOM edits must
-- never rewrite these rows.
CREATE TABLE IF NOT EXISTS job_card_items (
  id bigserial PRIMARY KEY,
  job_card_number text NOT NULL REFERENCES job_cards(job_card_number) ON DELETE CASCADE,
  line_number integer NOT NULL,
  item_code text NOT NULL DEFAULT '',
  material_name text NOT NULL,
  required_qty numeric(14, 4) NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'Nos',
  bom_number text NOT NULL DEFAULT '',
  bom_version integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (job_card_number, line_number)
);
CREATE INDEX IF NOT EXISTS job_card_items_job_card_idx
  ON job_card_items (job_card_number, line_number);

-- Per-operation production entries (planned vs completed quantities, operator
-- and machine assignment) kept separately from the legacy production_entries.
CREATE TABLE IF NOT EXISTS production_operation_entries (
  id bigserial PRIMARY KEY,
  job_card_number text NOT NULL REFERENCES job_cards(job_card_number) ON DELETE CASCADE,
  operation_id bigint REFERENCES job_card_operations(id) ON DELETE CASCADE,
  sequence_number integer NOT NULL DEFAULT 0,
  entry_date date NOT NULL,
  operation_name text NOT NULL DEFAULT '',
  planned_qty numeric(14, 4) NOT NULL DEFAULT 0,
  produced_qty numeric(14, 4) NOT NULL DEFAULT 0,
  accepted_qty numeric(14, 4) NOT NULL DEFAULT 0,
  rejected_qty numeric(14, 4) NOT NULL DEFAULT 0,
  rework_qty numeric(14, 4) NOT NULL DEFAULT 0,
  employee_id text NOT NULL DEFAULT '',
  employee_name text NOT NULL DEFAULT '',
  machine_id text NOT NULL DEFAULT '',
  machine_name text NOT NULL DEFAULT '',
  remarks text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_operation_entries_job_card_idx
  ON production_operation_entries (job_card_number, entry_date DESC);
CREATE INDEX IF NOT EXISTS production_operation_entries_operation_idx
  ON production_operation_entries (operation_id);

ALTER TABLE production_entries ADD COLUMN IF NOT EXISTS rework_qty numeric(14, 4) NOT NULL DEFAULT 0;
ALTER TABLE production_entries ADD COLUMN IF NOT EXISTS employee_id text NOT NULL DEFAULT '';
ALTER TABLE production_entries ADD COLUMN IF NOT EXISTS machine_id text NOT NULL DEFAULT '';
ALTER TABLE production_entries ADD COLUMN IF NOT EXISTS planned_qty numeric(14, 4) NOT NULL DEFAULT 0;
