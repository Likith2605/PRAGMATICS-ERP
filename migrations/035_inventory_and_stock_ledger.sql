-- Normalized Inventory Items, Batches and Central Stock Ledger.

CREATE TABLE IF NOT EXISTS inventory_items (
  item_code text PRIMARY KEY,
  material_name text NOT NULL,
  category text NOT NULL DEFAULT 'Raw Material',
  unit text NOT NULL DEFAULT 'Nos',
  current_qty numeric(14, 4) NOT NULL DEFAULT 0,
  reorder_level numeric(14, 4) NOT NULL DEFAULT 0,
  min_order_qty numeric(14, 4) NOT NULL DEFAULT 0,
  unit_price numeric(14, 2) NOT NULL DEFAULT 0,
  shelf_life_managed boolean NOT NULL DEFAULT false,
  shelf_life_days integer NOT NULL DEFAULT 0,
  location text NOT NULL DEFAULT '',
  hsn_code text NOT NULL DEFAULT '',
  version bigint NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS inventory_items_category_idx
  ON inventory_items (category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS inventory_items_name_idx
  ON inventory_items (lower(material_name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS inventory_batches (
  id text PRIMARY KEY,
  item_code text NOT NULL REFERENCES inventory_items(item_code) ON DELETE CASCADE,
  batch_number text NOT NULL,
  lot_number text NOT NULL DEFAULT '',
  available_qty numeric(14, 4) NOT NULL DEFAULT 0,
  initial_qty numeric(14, 4) NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'Nos',
  mfg_date date,
  expiry_date date,
  status text NOT NULL DEFAULT 'Active',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_batches_item_idx
  ON inventory_batches (item_code, expiry_date);
CREATE INDEX IF NOT EXISTS inventory_batches_batch_idx
  ON inventory_batches (batch_number);

CREATE TABLE IF NOT EXISTS stock_ledger_entries (
  id text PRIMARY KEY,
  entry_date date NOT NULL,
  entry_time timestamptz NOT NULL DEFAULT now(),
  item_code text NOT NULL REFERENCES inventory_items(item_code) ON DELETE CASCADE,
  movement_type text NOT NULL,
  quantity numeric(14, 4) NOT NULL,
  balance_after numeric(14, 4) NOT NULL,
  unit text NOT NULL DEFAULT 'Nos',
  unit_cost numeric(14, 2) NOT NULL DEFAULT 0,
  source_doc_type text NOT NULL DEFAULT '',
  source_doc_ref text NOT NULL DEFAULT '',
  batch_no text NOT NULL DEFAULT '',
  lot_number text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_ledger_entries_item_date_idx
  ON stock_ledger_entries (item_code, entry_date DESC, entry_time DESC);
CREATE INDEX IF NOT EXISTS stock_ledger_entries_ref_idx
  ON stock_ledger_entries (source_doc_ref);

-- IMPORTANT: legacy business data is never imported automatically. Historical
-- inventory and stock records must be reviewed through the Admin-only migration
-- preview endpoint and imported only as an explicit, audited selection so that
-- deleted/legacy records are never silently resurrected.
