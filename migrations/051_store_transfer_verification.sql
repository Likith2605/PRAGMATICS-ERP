-- Authoritative Store transfer and physical verification documents.
-- Location balances are initialized from existing PostgreSQL inventory only;
-- legacy browser snapshots are not imported or modified.

CREATE TABLE IF NOT EXISTS inventory_location_balances (
  item_code text NOT NULL REFERENCES inventory_items(item_code) ON DELETE CASCADE,
  location text NOT NULL,
  quantity numeric(14, 4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_code, location)
);

INSERT INTO inventory_location_balances (item_code, location, quantity)
SELECT item_code, COALESCE(NULLIF(btrim(location), ''), 'Unassigned'), current_qty
FROM inventory_items
ON CONFLICT (item_code, location) DO NOTHING;

CREATE INDEX IF NOT EXISTS inventory_location_balances_location_idx
  ON inventory_location_balances (lower(location), item_code);

CREATE TABLE IF NOT EXISTS inventory_location_batch_balances (
  batch_id text NOT NULL REFERENCES inventory_batches(id) ON DELETE CASCADE,
  item_code text NOT NULL REFERENCES inventory_items(item_code) ON DELETE CASCADE,
  location text NOT NULL,
  quantity numeric(14, 4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, location),
  FOREIGN KEY (item_code, location)
    REFERENCES inventory_location_balances(item_code, location) ON DELETE CASCADE
);

INSERT INTO inventory_location_batch_balances (batch_id, item_code, location, quantity)
SELECT b.id, b.item_code, COALESCE(NULLIF(btrim(i.location), ''), 'Unassigned'), b.available_qty
FROM inventory_batches b
JOIN inventory_items i ON i.item_code = b.item_code
ON CONFLICT (batch_id, location) DO NOTHING;

CREATE INDEX IF NOT EXISTS inventory_location_batch_balances_location_idx
  ON inventory_location_batch_balances (lower(location), item_code);

CREATE TABLE IF NOT EXISTS stock_transfers (
  transfer_number text PRIMARY KEY,
  transfer_date date NOT NULL,
  from_location text NOT NULL,
  to_location text NOT NULL,
  requested_by text NOT NULL,
  requested_by_employee_id text NOT NULL DEFAULT '',
  remarks text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Completed', 'Rejected')),
  version bigint NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL UNIQUE,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution_key text UNIQUE,
  resolved_by text NOT NULL DEFAULT '',
  resolved_at timestamptz,
  resolution_reason text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_transfers_status_date_idx
  ON stock_transfers (status, transfer_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id bigserial PRIMARY KEY,
  transfer_number text NOT NULL REFERENCES stock_transfers(transfer_number) ON DELETE CASCADE,
  line_number integer NOT NULL,
  item_code text NOT NULL REFERENCES inventory_items(item_code),
  batch_id text REFERENCES inventory_batches(id) ON DELETE SET NULL,
  quantity numeric(14, 4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (transfer_number, line_number)
);

CREATE INDEX IF NOT EXISTS stock_transfer_items_transfer_idx
  ON stock_transfer_items (transfer_number, line_number);

CREATE TABLE IF NOT EXISTS stock_verifications (
  verification_number text PRIMARY KEY,
  verification_date date NOT NULL,
  location text NOT NULL,
  verified_by text NOT NULL,
  verified_by_employee_id text NOT NULL DEFAULT '',
  remarks text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Pending Approval'
    CHECK (status IN ('Pending Approval', 'Approved', 'Rejected')),
  version bigint NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL UNIQUE,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution_key text UNIQUE,
  resolved_by text NOT NULL DEFAULT '',
  resolved_at timestamptz,
  resolution_reason text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_verifications_status_date_idx
  ON stock_verifications (status, verification_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS stock_verification_items (
  id bigserial PRIMARY KEY,
  verification_number text NOT NULL REFERENCES stock_verifications(verification_number) ON DELETE CASCADE,
  line_number integer NOT NULL,
  item_code text NOT NULL REFERENCES inventory_items(item_code),
  batch_id text REFERENCES inventory_batches(id) ON DELETE SET NULL,
  system_quantity numeric(14, 4) NOT NULL,
  physical_quantity numeric(14, 4) NOT NULL CHECK (physical_quantity >= 0),
  variance numeric(14, 4) NOT NULL,
  unit text NOT NULL,
  remarks text NOT NULL DEFAULT '',
  adjustment_ledger_id text UNIQUE REFERENCES stock_ledger_entries(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (verification_number, line_number)
);

CREATE INDEX IF NOT EXISTS stock_verification_items_document_idx
  ON stock_verification_items (verification_number, line_number);
