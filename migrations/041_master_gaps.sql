-- Phase 8 master data gaps.
-- Migration 039 created the four original master tables; this migration adds
-- optimistic versions, idempotency, soft-delete metadata and reconciliation
-- identity columns to those tables, and creates the material/UOM masters that
-- the ERP references. Applied migrations are never edited.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS create_token text,
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS legacy_id text,
  ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS delete_reason text;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS create_token text,
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS legacy_id text,
  ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS delete_reason text;

ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS create_token text,
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS legacy_id text,
  ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS delete_reason text;

ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS create_token text,
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS legacy_id text,
  ADD COLUMN IF NOT EXISTS created_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS delete_reason text;

-- Only NEW columns are constrained, so reconciliation can never restore a
-- deleted record or insert the same legacy identity twice. Existing
-- production rows keep their historical codes and remain readable.
CREATE UNIQUE INDEX IF NOT EXISTS customers_create_token_idx
  ON customers (create_token) WHERE create_token IS NOT NULL AND create_token <> '';
CREATE UNIQUE INDEX IF NOT EXISTS customers_legacy_identity_idx
  ON customers (source_key, legacy_id) WHERE source_key IS NOT NULL AND legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vendors_create_token_idx
  ON vendors (create_token) WHERE create_token IS NOT NULL AND create_token <> '';
CREATE UNIQUE INDEX IF NOT EXISTS vendors_legacy_identity_idx
  ON vendors (source_key, legacy_id) WHERE source_key IS NOT NULL AND legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS machines_create_token_idx
  ON machines (create_token) WHERE create_token IS NOT NULL AND create_token <> '';
CREATE UNIQUE INDEX IF NOT EXISTS machines_legacy_identity_idx
  ON machines (source_key, legacy_id) WHERE source_key IS NOT NULL AND legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS company_settings_create_token_idx
  ON company_settings (create_token) WHERE create_token IS NOT NULL AND create_token <> '';
CREATE UNIQUE INDEX IF NOT EXISTS company_settings_legacy_identity_idx
  ON company_settings (source_key, legacy_id) WHERE source_key IS NOT NULL AND legacy_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS uom_master (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  symbol text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Active',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  create_token text,
  source_key text,
  legacy_id text,
  created_by text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS uom_master_code_idx
  ON uom_master (lower(code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uom_master_create_token_idx
  ON uom_master (create_token) WHERE create_token IS NOT NULL AND create_token <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uom_master_legacy_identity_idx
  ON uom_master (source_key, legacy_id) WHERE source_key IS NOT NULL AND legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS uom_master_name_idx
  ON uom_master (lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS material_master (
  id text PRIMARY KEY,
  item_code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT '',
  unit_code text NOT NULL DEFAULT '',
  hsn_sac text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Active',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  create_token text,
  source_key text,
  legacy_id text,
  created_by text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS material_master_code_idx
  ON material_master (lower(item_code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS material_master_create_token_idx
  ON material_master (create_token) WHERE create_token IS NOT NULL AND create_token <> '';
CREATE UNIQUE INDEX IF NOT EXISTS material_master_legacy_identity_idx
  ON material_master (source_key, legacy_id) WHERE source_key IS NOT NULL AND legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS material_master_name_idx
  ON material_master (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS material_master_unit_idx
  ON material_master (lower(unit_code)) WHERE deleted_at IS NULL;

-- One response per mutation token. Mirrors are written only after a committed
-- database change, and replaying a token can never recreate a soft-deleted row.
CREATE TABLE IF NOT EXISTS master_idempotency (
  token text PRIMARY KEY,
  kind text NOT NULL,
  record_id text NOT NULL,
  action text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS master_idempotency_record_idx
  ON master_idempotency (kind, record_id);
