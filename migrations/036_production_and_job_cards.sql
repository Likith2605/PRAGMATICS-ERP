-- Production Requirements, Job Cards, Routing Operations, Entries and Audit.

CREATE TABLE IF NOT EXISTS production_requirements (
  requirement_number text PRIMARY KEY,
  requirement_date date NOT NULL,
  so_number text,
  project_id text,
  customer text,
  part_name text NOT NULL DEFAULT '',
  required_qty numeric(14, 4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'Draft',
  remarks text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '',
  version bigint NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS production_requirements_date_idx
  ON production_requirements (requirement_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS production_requirements_status_idx
  ON production_requirements (status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS production_requirement_items (
  id bigserial PRIMARY KEY,
  requirement_number text NOT NULL REFERENCES production_requirements(requirement_number) ON DELETE CASCADE,
  line_number integer NOT NULL,
  material_code text NOT NULL DEFAULT '',
  material_name text NOT NULL,
  required_qty numeric(14, 4) NOT NULL,
  available_qty numeric(14, 4) NOT NULL DEFAULT 0,
  shortage_qty numeric(14, 4) NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'Nos',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS job_cards (
  job_card_number text PRIMARY KEY,
  job_card_date date NOT NULL,
  so_number text,
  customer_po_number text,
  project_id text,
  customer_name text NOT NULL DEFAULT '',
  part_code text NOT NULL DEFAULT '',
  part_name text NOT NULL DEFAULT '',
  order_quantity numeric(14, 4) NOT NULL DEFAULT 0,
  produced_quantity numeric(14, 4) NOT NULL DEFAULT 0,
  accepted_quantity numeric(14, 4) NOT NULL DEFAULT 0,
  rejected_quantity numeric(14, 4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'Draft',
  assigned_employee_id text NOT NULL DEFAULT '',
  assigned_employee_name text NOT NULL DEFAULT '',
  assigned_machine_id text NOT NULL DEFAULT '',
  assigned_machine_name text NOT NULL DEFAULT '',
  start_date date,
  due_date date,
  completion_date date,
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

CREATE INDEX IF NOT EXISTS job_cards_status_idx
  ON job_cards (status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS job_cards_date_idx
  ON job_cards (job_card_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS job_cards_so_idx
  ON job_cards (so_number) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS job_card_operations (
  id bigserial PRIMARY KEY,
  job_card_number text NOT NULL REFERENCES job_cards(job_card_number) ON DELETE CASCADE,
  sequence_number integer NOT NULL,
  operation_name text NOT NULL,
  machine_name text NOT NULL DEFAULT '',
  operator_name text NOT NULL DEFAULT '',
  planned_hours numeric(8, 2) NOT NULL DEFAULT 0,
  actual_hours numeric(8, 2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'Pending',
  started_at timestamptz,
  completed_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS production_entries (
  id bigserial PRIMARY KEY,
  job_card_number text NOT NULL REFERENCES job_cards(job_card_number) ON DELETE CASCADE,
  entry_date date NOT NULL,
  operation_name text NOT NULL DEFAULT '',
  produced_qty numeric(14, 4) NOT NULL DEFAULT 0,
  accepted_qty numeric(14, 4) NOT NULL DEFAULT 0,
  rejected_qty numeric(14, 4) NOT NULL DEFAULT 0,
  operator_name text NOT NULL DEFAULT '',
  machine_name text NOT NULL DEFAULT '',
  remarks text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_card_audit (
  id bigserial PRIMARY KEY,
  job_card_number text NOT NULL,
  action text NOT NULL,
  actor_id text,
  actor_email text,
  actor_role text,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_card_audit_idx
  ON job_card_audit (job_card_number, created_at DESC);
