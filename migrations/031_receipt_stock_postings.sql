CREATE TABLE IF NOT EXISTS receipt_stock_movements (
  id bigserial PRIMARY KEY,
  receipt_number text NOT NULL REFERENCES material_receipts(receipt_number) ON DELETE RESTRICT,
  qc_number text NOT NULL REFERENCES material_receipt_inspections(qc_number) ON DELETE RESTRICT,
  line_number integer NOT NULL,
  material_key text NOT NULL,
  material_code text NOT NULL DEFAULT '',
  material_name text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT 'Nos',
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  balance_before numeric(18,4) NOT NULL CHECK (balance_before >= 0),
  balance_after numeric(18,4) NOT NULL CHECK (balance_after >= balance_before),
  batch_number text NOT NULL DEFAULT '',
  lot_number text NOT NULL DEFAULT '',
  actor_id text,
  actor_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(qc_number,line_number),
  FOREIGN KEY(qc_number,line_number) REFERENCES material_receipt_inspection_items(qc_number,line_number) ON DELETE RESTRICT,
  CHECK (balance_after = balance_before + quantity)
);
CREATE INDEX IF NOT EXISTS receipt_stock_movements_receipt_idx
  ON receipt_stock_movements(receipt_number,created_at DESC);
CREATE INDEX IF NOT EXISTS receipt_stock_movements_material_idx
  ON receipt_stock_movements(material_key,created_at DESC);
CREATE TABLE IF NOT EXISTS receipt_stock_movement_audit (
  id bigserial PRIMARY KEY,
  movement_id bigint NOT NULL REFERENCES receipt_stock_movements(id) ON DELETE RESTRICT,
  actor_id text,
  actor_email text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  before_values jsonb,
  after_values jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipt_stock_audit_movement_idx
  ON receipt_stock_movement_audit(movement_id,created_at DESC);
