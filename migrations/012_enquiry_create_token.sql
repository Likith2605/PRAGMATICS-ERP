-- Idempotency key for retries of enquiry creates. Nullable for existing rows.
ALTER TABLE module_records ADD COLUMN IF NOT EXISTS create_token text;

CREATE UNIQUE INDEX IF NOT EXISTS module_records_enquiry_create_token_uq
  ON module_records (create_token)
  WHERE storage_key = 'projectRequests' AND create_token IS NOT NULL;
