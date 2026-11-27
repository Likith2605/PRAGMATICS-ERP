-- Repair Company Settings columns expected by migration 041 where an older
-- deployment recorded that migration before all reconciliation fields existed.
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS create_token text,
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS legacy_id text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS delete_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS company_settings_create_token_idx
  ON company_settings (create_token) WHERE create_token IS NOT NULL AND create_token <> '';
CREATE UNIQUE INDEX IF NOT EXISTS company_settings_legacy_identity_idx
  ON company_settings (source_key, legacy_id) WHERE source_key IS NOT NULL AND legacy_id IS NOT NULL;
