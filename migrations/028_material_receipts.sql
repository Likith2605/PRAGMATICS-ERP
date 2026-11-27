CREATE TABLE IF NOT EXISTS material_receipts (
  receipt_number text PRIMARY KEY,
  po_number text NOT NULL,
  invoice_number text NOT NULL,
  vendor_name text NOT NULL,
  status text NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS material_receipts_invoice_uniq
  ON material_receipts(lower(invoice_number)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS material_receipts_po_idx
  ON material_receipts(po_number, created_at) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS material_receipt_audit (
  id bigserial PRIMARY KEY,
  receipt_number text NOT NULL,
  actor_id text,
  actor_email text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS material_receipt_audit_record_idx
  ON material_receipt_audit(receipt_number, created_at DESC);
DO $$ BEGIN
  ALTER TABLE supplier_invoices ADD CONSTRAINT supplier_invoices_receipt_fk
    FOREIGN KEY (receipt_number) REFERENCES material_receipts(receipt_number) ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
