CREATE TABLE IF NOT EXISTS purchase_requests (
  pr_number text PRIMARY KEY,
  mr_number text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Pending Approval',
  project_id text NOT NULL DEFAULT '',
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_token text,
  created_by text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS purchase_requests_create_token_idx
  ON purchase_requests(create_token) WHERE create_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_requests_status_date_idx
  ON purchase_requests(status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS purchase_requests_mr_idx
  ON purchase_requests(mr_number) WHERE deleted_at IS NULL AND mr_number <> '';
CREATE INDEX IF NOT EXISTS purchase_requests_recycle_bin_idx
  ON purchase_requests(deleted_at DESC) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS purchase_request_items (
  pr_number text NOT NULL REFERENCES purchase_requests(pr_number) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number > 0),
  material_id text NOT NULL DEFAULT '',
  material_name text NOT NULL,
  required_qty numeric(14, 4) NOT NULL CHECK (required_qty > 0),
  shortage_qty numeric(14, 4) NOT NULL DEFAULT 0 CHECK (shortage_qty >= 0),
  unit text NOT NULL DEFAULT 'Nos',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (pr_number, line_number)
);
CREATE INDEX IF NOT EXISTS purchase_request_items_material_idx
  ON purchase_request_items(material_id) WHERE material_id <> '';

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS pr_number text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS purchase_orders_pr_idx
  ON purchase_orders(pr_number) WHERE pr_number <> '';

CREATE TABLE IF NOT EXISTS purchase_request_audit (
  id bigserial PRIMARY KEY,
  pr_number text NOT NULL,
  actor_id text,
  actor_email text NOT NULL DEFAULT '',
  actor_role text NOT NULL DEFAULT '',
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_request_audit_record_idx
  ON purchase_request_audit(pr_number, created_at DESC);
