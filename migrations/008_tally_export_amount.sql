-- Add total_amount column to tally_export_history for tracking export value.
ALTER TABLE tally_export_history
  ADD COLUMN IF NOT EXISTS total_amount numeric(14,2) NOT NULL DEFAULT 0;

-- Add index for querying by amount range.
CREATE INDEX IF NOT EXISTS tally_export_history_amount_idx
  ON tally_export_history (total_amount);
