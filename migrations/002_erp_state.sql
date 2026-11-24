CREATE TABLE IF NOT EXISTS erp_state (
  storage_key text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS erp_state_updated_idx ON erp_state (updated_at DESC);
