CREATE TABLE IF NOT EXISTS purchase_indent_quality_checks (
  qc_number text PRIMARY KEY,
  indent_number text NOT NULL UNIQUE REFERENCES purchase_indents(indent_number) ON DELETE RESTRICT,
  status text NOT NULL,
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_indent_quality_audit (
  id bigserial PRIMARY KEY,
  qc_number text NOT NULL REFERENCES purchase_indent_quality_checks(qc_number) ON DELETE RESTRICT,
  indent_number text NOT NULL REFERENCES purchase_indents(indent_number) ON DELETE RESTRICT,
  actor_id text,
  actor_email text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_indent_quality_audit_idx
  ON purchase_indent_quality_audit(qc_number, created_at DESC);
