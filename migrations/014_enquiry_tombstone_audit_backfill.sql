-- Seed durable tombstones from existing Enquiry delete audit entries. Active
-- IDs are excluded so historical deletes cannot block a current live record.
INSERT INTO enquiry_tombstones
  (record_id,deleted_at,deleted_by,deleted_by_email,reason,before_values,audit_id)
SELECT DISTINCT ON (audit.record_id)
  audit.record_id,
  audit.created_at,
  audit.user_id,
  audit.email,
  audit.reason,
  audit.before_values,
  audit.id
FROM erp_audit_log audit
WHERE audit.module = 'projectRequests'
  AND audit.action = 'DELETE'
  AND NOT EXISTS (
    SELECT 1 FROM module_records active
    WHERE active.storage_key = 'projectRequests'
      AND active.record_id = audit.record_id
  )
ORDER BY audit.record_id, audit.created_at DESC, audit.id DESC
ON CONFLICT (record_id) DO NOTHING;
