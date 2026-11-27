CREATE TABLE IF NOT EXISTS purchase_orders (
  po_number text PRIMARY KEY,
  quotation_number text NOT NULL UNIQUE REFERENCES vendor_quotations(quotation_number) ON DELETE RESTRICT,
  indent_number text REFERENCES purchase_indents(indent_number) ON DELETE RESTRICT,
  vendor_name text NOT NULL,
  status text NOT NULL DEFAULT 'Submitted',
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_token text NOT NULL UNIQUE,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  delete_reason text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS purchase_orders_status_idx
  ON purchase_orders(status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS purchase_orders_indent_idx
  ON purchase_orders(indent_number) WHERE indent_number IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS purchase_order_audit (
  id bigserial PRIMARY KEY,
  po_number text NOT NULL,
  actor_id text,
  actor_email text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_order_audit_record_idx
  ON purchase_order_audit(po_number, created_at DESC);
