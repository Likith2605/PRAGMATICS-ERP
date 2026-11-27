CREATE TABLE IF NOT EXISTS customer_invoice_sequences (
  sequence_id smallint PRIMARY KEY CHECK(sequence_id=1),
  last_number bigint NOT NULL DEFAULT 0 CHECK(last_number>=0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
