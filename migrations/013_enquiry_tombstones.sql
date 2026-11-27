-- Durable deletion ledger: IDs remain reserved after an Enquiry is deleted.
CREATE TABLE IF NOT EXISTS enquiry_tombstones (
  record_id text PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by text NOT NULL,
  deleted_by_email text NOT NULL,
  reason text NOT NULL,
  before_values jsonb,
  create_token text,
  audit_id bigint REFERENCES erp_audit_log(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS enquiry_tombstones_create_token_uq
  ON enquiry_tombstones (create_token) WHERE create_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS enquiry_tombstones_deleted_at_idx
  ON enquiry_tombstones (deleted_at DESC);
