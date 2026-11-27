CREATE TABLE IF NOT EXISTS supplier_invoices (
  invoice_number text PRIMARY KEY,
  po_number text,
  receipt_number text,
  vendor_name text NOT NULL,
  status text NOT NULL DEFAULT 'Pending',
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
CREATE INDEX IF NOT EXISTS supplier_invoices_po_idx ON supplier_invoices(po_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS supplier_invoices_status_idx ON supplier_invoices(status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS supplier_invoice_audit (
  id bigserial PRIMARY KEY,
  invoice_number text NOT NULL,
  actor_id text,
  actor_email text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_invoice_audit_record_idx ON supplier_invoice_audit(invoice_number, created_at DESC);
