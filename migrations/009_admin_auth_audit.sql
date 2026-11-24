-- Server sessions and durable audit history for sensitive ERP actions.
CREATE TABLE IF NOT EXISTS erp_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL,
  role_key text NOT NULL,
  department text NOT NULL DEFAULT '',
  employee_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS erp_sessions_expiry_idx ON erp_sessions (expires_at);

CREATE TABLE IF NOT EXISTS erp_audit_log (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  email text NOT NULL,
  role text NOT NULL,
  module text NOT NULL,
  record_id text NOT NULL,
  record_label text NOT NULL DEFAULT '',
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS erp_audit_log_record_idx ON erp_audit_log (module, record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS erp_audit_log_created_idx ON erp_audit_log (created_at DESC);
