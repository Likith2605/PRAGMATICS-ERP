CREATE TABLE IF NOT EXISTS material_receipt_inspections (
  qc_number text PRIMARY KEY,
  receipt_number text NOT NULL UNIQUE REFERENCES material_receipts(receipt_number) ON DELETE RESTRICT,
  status text NOT NULL,
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_token text NOT NULL UNIQUE,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  posted_by text NOT NULL DEFAULT '',
  posted_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (posted_qty >= 0)
);
CREATE TABLE IF NOT EXISTS material_receipt_inspection_items (
  qc_number text NOT NULL REFERENCES material_receipt_inspections(qc_number) ON DELETE RESTRICT,
  receipt_number text NOT NULL REFERENCES material_receipts(receipt_number) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number > 0),
  receipt_line_number integer NOT NULL,
  material_code text NOT NULL DEFAULT '',
  material_name text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT 'Nos',
  received_qty numeric(18,4) NOT NULL CHECK (received_qty > 0),
  accepted_qty numeric(18,4) NOT NULL CHECK (accepted_qty >= 0),
  rejected_qty numeric(18,4) NOT NULL CHECK (rejected_qty >= 0),
  rework_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (rework_qty >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (qc_number,line_number),
  UNIQUE (qc_number,receipt_line_number),
  FOREIGN KEY (receipt_number,receipt_line_number) REFERENCES material_receipt_items(receipt_number,line_number) DEFERRABLE INITIALLY DEFERRED,
  CHECK (accepted_qty + rejected_qty = received_qty),
  CHECK (rework_qty <= rejected_qty)
);
CREATE INDEX IF NOT EXISTS receipt_inspection_items_material_idx
  ON material_receipt_inspection_items(material_code,material_name,qc_number);
CREATE TABLE IF NOT EXISTS material_receipt_inspection_audit (
  id bigserial PRIMARY KEY,
  qc_number text NOT NULL,
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
CREATE INDEX IF NOT EXISTS receipt_inspection_audit_record_idx
  ON material_receipt_inspection_audit(qc_number,created_at DESC);
