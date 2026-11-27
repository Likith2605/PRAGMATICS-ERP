-- Debit Notes schema: durable persistence, line items, and audit trail.

CREATE TABLE IF NOT EXISTS debit_notes (
  debit_note_number text PRIMARY KEY,
  debit_note_date date NOT NULL,
  rejection_number text,
  po_number text,
  invoice_number text,
  vendor_id text NOT NULL DEFAULT '',
  vendor_name text NOT NULL DEFAULT '',
  subtotal numeric(14, 2) NOT NULL DEFAULT 0,
  total_gst numeric(14, 2) NOT NULL DEFAULT 0,
  grand_total numeric(14, 2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'Draft',
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

CREATE INDEX IF NOT EXISTS debit_notes_date_idx
  ON debit_notes (debit_note_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS debit_notes_rejection_idx
  ON debit_notes (rejection_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS debit_notes_po_idx
  ON debit_notes (po_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS debit_notes_status_idx
  ON debit_notes (status, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS debit_note_items (
  id bigserial PRIMARY KEY,
  debit_note_number text NOT NULL REFERENCES debit_notes(debit_note_number) ON DELETE CASCADE,
  line_number integer NOT NULL,
  material_code text NOT NULL DEFAULT '',
  material_name text NOT NULL,
  debit_qty numeric(14, 4) NOT NULL,
  unit_price numeric(14, 4) NOT NULL DEFAULT 0,
  taxable_amount numeric(14, 2) NOT NULL DEFAULT 0,
  gst_rate numeric(5, 2) NOT NULL DEFAULT 0,
  gst_amount numeric(14, 2) NOT NULL DEFAULT 0,
  total_amount numeric(14, 2) NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'Nos',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS debit_note_items_note_idx
  ON debit_note_items (debit_note_number, line_number);

CREATE TABLE IF NOT EXISTS debit_note_audit (
  id bigserial PRIMARY KEY,
  debit_note_number text NOT NULL,
  action text NOT NULL,
  actor_id text,
  actor_email text,
  actor_role text,
  reason text NOT NULL DEFAULT '',
  before_values jsonb,
  after_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS debit_note_audit_idx
  ON debit_note_audit (debit_note_number, created_at DESC);
