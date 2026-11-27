-- Additive concurrency, retry and soft-delete metadata for live Customer POs.
ALTER TABLE customer_purchase_orders
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN IF NOT EXISTS create_token text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS delete_reason text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS customer_purchase_orders_create_token_idx
  ON customer_purchase_orders (create_token) WHERE create_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_purchase_orders_active_idx
  ON customer_purchase_orders (po_date DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_po_sequences (
  fy_start_year integer PRIMARY KEY,
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
