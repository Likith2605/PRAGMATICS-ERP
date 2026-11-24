-- Tally Export history table (Vyapar-style Export to Tally feature).
--
-- Records each export run so accountants can review previous exports,
-- identify potentially repeated transactions, and safely re-export.
-- This does NOT mark any transaction as "imported into Tally" -- downloading
-- an XML file is not an import confirmation.

CREATE TABLE IF NOT EXISTS tally_export_history (
  id text PRIMARY KEY,
  export_date timestamptz NOT NULL DEFAULT now(),
  export_type text NOT NULL DEFAULT 'tally_xml', -- 'tally_xml' for now
  date_from date NOT NULL,
  date_to date NOT NULL,
  transaction_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  masters_included jsonb NOT NULL DEFAULT '[]'::jsonb,
  record_counts jsonb NOT NULL DEFAULT '{}'::jsonb, -- { sales: 5, purchases: 3, ... }
  file_names jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [ 'master.xml', 'voucher.xml' ]
  export_status text NOT NULL DEFAULT 'generated', -- 'generated' | 'downloaded' | 'failed'
  generated_by text NOT NULL DEFAULT '',
  validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb, -- { errors: [...], warnings: [...] }
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tally_export_history_date_idx
  ON tally_export_history (export_date DESC);

CREATE INDEX IF NOT EXISTS tally_export_history_status_idx
  ON tally_export_history (export_status);

CREATE INDEX IF NOT EXISTS tally_export_history_type_idx
  ON tally_export_history (export_type);

-- Also store generated XML content for audit / re-download (bounded size).
CREATE TABLE IF NOT EXISTS tally_export_files (
  id text PRIMARY KEY,
  export_id text NOT NULL REFERENCES tally_export_history(id) ON DELETE CASCADE,
  file_name text NOT NULL, -- 'master.xml' | 'voucher.xml'
  file_type text NOT NULL, -- 'master' | 'voucher'
  content bytea NOT NULL,
  content_type text NOT NULL DEFAULT 'application/xml',
  size_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tally_export_files_export_idx
  ON tally_export_files (export_id, file_type);
