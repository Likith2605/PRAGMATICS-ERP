-- Heat Treatment (HT) & Outside Processing Outsource Schema.

CREATE TABLE IF NOT EXISTS ht_outsource_requests (
  htr_number text PRIMARY KEY,
  htr_date date NOT NULL,
  job_card_number text,
  part_code text NOT NULL DEFAULT '',
  part_name text NOT NULL DEFAULT '',
  process_type text NOT NULL DEFAULT 'Heat Treatment',
  vendor_id text NOT NULL DEFAULT '',
  vendor_name text NOT NULL DEFAULT '',
  sent_qty numeric(14, 4) NOT NULL DEFAULT 0,
  received_qty numeric(14, 4) NOT NULL DEFAULT 0,
  rejected_qty numeric(14, 4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'Pending Assignment',
  challan_number text NOT NULL DEFAULT '',
  challan_date date,
  remarks text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '',
  version bigint NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS ht_outsource_requests_status_idx
  ON ht_outsource_requests (status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ht_outsource_requests_jobcard_idx
  ON ht_outsource_requests (job_card_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ht_outsource_requests_vendor_idx
  ON ht_outsource_requests (vendor_name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ht_outsource_audit (
  id bigserial PRIMARY KEY,
  htr_number text NOT NULL,
  action text NOT NULL,
  actor_id text,
  actor_email text,
  actor_role text,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ht_outsource_audit_idx
  ON ht_outsource_audit (htr_number, created_at DESC);
