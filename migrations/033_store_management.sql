-- Dedicated store operations: Material Requests, Store Issues, Store Returns and Audit.

CREATE TABLE IF NOT EXISTS material_requests (
  mr_number text PRIMARY KEY,
  mr_date date NOT NULL,
  department text NOT NULL,
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'Draft',
  job_card_number text,
  sales_order_ref text,
  project_id text,
  project_name text,
  customer text,
  remarks text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '',
  version bigint NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS material_requests_status_idx
  ON material_requests (status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS material_requests_jobcard_idx
  ON material_requests (job_card_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS material_requests_so_idx
  ON material_requests (sales_order_ref) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS material_request_items (
  id bigserial PRIMARY KEY,
  mr_number text NOT NULL REFERENCES material_requests(mr_number) ON DELETE CASCADE,
  line_number integer NOT NULL,
  material_id text NOT NULL,
  material_name text NOT NULL,
  required_qty numeric(14, 4) NOT NULL,
  issued_qty numeric(14, 4) NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'Nos',
  batch_no text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS material_request_items_mr_idx
  ON material_request_items (mr_number, line_number);

CREATE TABLE IF NOT EXISTS store_issues (
  issue_number text PRIMARY KEY,
  issue_date date NOT NULL,
  mr_number text REFERENCES material_requests(mr_number) ON DELETE SET NULL,
  job_card_number text,
  sales_order_ref text,
  project_id text,
  receiver_name text NOT NULL,
  receiver_employee_id text NOT NULL,
  acknowledged boolean NOT NULL DEFAULT true,
  issued_by text NOT NULL,
  issued_by_dept text NOT NULL,
  remarks text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Issued',
  version bigint NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS store_issues_mr_idx
  ON store_issues (mr_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS store_issues_date_idx
  ON store_issues (issue_date DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS store_issue_items (
  id bigserial PRIMARY KEY,
  issue_number text NOT NULL REFERENCES store_issues(issue_number) ON DELETE CASCADE,
  line_number integer NOT NULL,
  material_id text NOT NULL,
  material_name text NOT NULL,
  quantity numeric(14, 4) NOT NULL,
  unit text NOT NULL DEFAULT 'Nos',
  batch_no text NOT NULL DEFAULT '',
  lot_number text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS store_issue_items_issue_idx
  ON store_issue_items (issue_number, line_number);

CREATE TABLE IF NOT EXISTS store_returns (
  return_number text PRIMARY KEY,
  return_date date NOT NULL,
  issue_number text REFERENCES store_issues(issue_number) ON DELETE SET NULL,
  mr_number text REFERENCES material_requests(mr_number) ON DELETE SET NULL,
  returned_by text NOT NULL,
  returned_by_id text NOT NULL,
  received_by text NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Received',
  version bigint NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS store_returns_date_idx
  ON store_returns (return_date DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS store_return_items (
  id bigserial PRIMARY KEY,
  return_number text NOT NULL REFERENCES store_returns(return_number) ON DELETE CASCADE,
  line_number integer NOT NULL,
  material_id text NOT NULL,
  material_name text NOT NULL,
  quantity numeric(14, 4) NOT NULL,
  unit text NOT NULL DEFAULT 'Nos',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS material_issue_audit (
  id bigserial PRIMARY KEY,
  issue_number text NOT NULL,
  action text NOT NULL,
  actor_id text,
  actor_email text,
  actor_role text,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS material_issue_audit_idx
  ON material_issue_audit (issue_number, created_at DESC);

CREATE TABLE IF NOT EXISTS store_sequences (
  sequence_key text PRIMARY KEY,
  last_number bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
