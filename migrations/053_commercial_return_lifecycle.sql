-- Commercial return lifecycle, stock posting and accounting references.
-- Existing return documents remain preserved when this migration is applied.

ALTER TABLE commercial_returns
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Draft',
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS rejection_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS stock_posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS accounting_posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS accounting_reference text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS accounting_entry_type text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commercial_returns_status_check'
      AND conrelid = 'commercial_returns'::regclass
  ) THEN
    ALTER TABLE commercial_returns
      ADD CONSTRAINT commercial_returns_status_check
      CHECK (status IN ('Draft','Submitted','Approved','Rejected','Cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS commercial_returns_status_date_idx
  ON commercial_returns(status, return_date DESC, return_number DESC)
  WHERE deleted_at IS NULL;

