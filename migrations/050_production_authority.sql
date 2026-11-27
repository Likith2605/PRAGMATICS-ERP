-- Production authority indexes and reconciliation protection.
-- This migration does not backfill or import legacy browser records.

CREATE INDEX IF NOT EXISTS production_requirements_project_so_idx
  ON production_requirements (lower(project_id), lower(so_number), requirement_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS production_requirements_job_card_payload_idx
  ON production_requirements ((payload->>'jobCardNumber'), requirement_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS job_cards_employee_idx
  ON job_cards (assigned_employee_id, status, job_card_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS job_cards_machine_idx
  ON job_cards (assigned_machine_id, status, job_card_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS job_cards_project_so_idx
  ON job_cards (lower(project_id), lower(so_number), job_card_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS production_operation_entries_employee_idx
  ON production_operation_entries (employee_id, job_card_number, entry_date DESC);

CREATE INDEX IF NOT EXISTS production_dispatch_request_idx
  ON module_records (record_id, updated_at DESC)
  WHERE storage_key = 'productionDispatchRequests';
