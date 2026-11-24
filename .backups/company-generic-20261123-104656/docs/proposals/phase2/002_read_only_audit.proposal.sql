-- READ-ONLY REVIEW QUERIES. SELECT statements only. Do not add staging writes here.
-- Run manually against a read replica/snapshot after approval; not a migration.

-- A. Schema and applied migration inventory.
SELECT version, applied_at FROM schema_migrations ORDER BY applied_at, version;
SELECT table_schema, table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name;

-- B. ERP JSON state key inventory. Counts are document/array element counts.
SELECT storage_key AS key,
       CASE WHEN jsonb_typeof(data)='array' THEN jsonb_array_length(data)
            WHEN data IS NULL THEN 0 ELSE 1 END AS element_count
FROM erp_state ORDER BY storage_key;
SELECT storage_key, count(*) AS records FROM module_records GROUP BY storage_key ORDER BY storage_key;

-- C. Duplicate/missing stable IDs in normalized module records.
SELECT storage_key, record_id, count(*) AS copies
FROM module_records GROUP BY storage_key, record_id HAVING count(*) > 1;
SELECT storage_key, count(*) AS missing_record_ids
FROM module_records WHERE record_id IS NULL OR btrim(record_id)='' GROUP BY storage_key;

-- D. Source document + line ordinal inventory. The source ERP payload remains
-- authoritative during preparation; these queries deliberately do not rewrite it.
WITH docs AS (
 SELECT storage_key AS key, data AS docs
 FROM erp_state
 WHERE storage_key = ANY (ARRAY['materialReceipts','qualityChecks','purchaseIndents',
   'storePurchaseRequests','supplierPOHistory','materialRequests','storeIssueHistory',
   'materialReturnHistory','productionJobCards','salesOrderHistory',
   'deliveryChallanHistory','vendorMaster','customerMaster','htOutsourceRequests'])
), lines AS (
 SELECT key, d.doc, l.line, l.ord
 FROM docs CROSS JOIN LATERAL jsonb_array_elements(
   CASE WHEN jsonb_typeof(docs)='array' THEN docs ELSE '[]'::jsonb END) AS d(doc)
 LEFT JOIN LATERAL jsonb_array_elements(
   CASE WHEN jsonb_typeof(d.doc->'items')='array' THEN d.doc->'items'
        WHEN jsonb_typeof(d.doc->'lines')='array' THEN d.doc->'lines'
        ELSE '[]'::jsonb END) WITH ORDINALITY AS l(line,ord) ON true
)
SELECT key, coalesce(doc->>'id',doc->>'number',doc->>'poNumber',doc->>'mrNumber') AS document_key,
       count(line) AS lines_without_stable_line_id
FROM lines
WHERE line IS NOT NULL AND coalesce(line->>'lineId',line->>'id',line->>'lineID') IS NULL
GROUP BY key, document_key ORDER BY key, document_key;

-- E. Receipt / quality links and quantity checks (field aliases may need adapting
-- to the exact source payload variant; this query is a review template).
SELECT r->>'number' AS receipt_no, r->>'qcNumber' AS linked_qc,
       q->>'number' AS qc_no,
       CASE WHEN q IS NULL THEN 'NO_EXACT_QC_LINK' ELSE 'LINKED' END AS link_status
FROM erp_state s
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.data)='array' THEN s.data ELSE '[]'::jsonb END) AS rr(r)
LEFT JOIN erp_state qs ON qs.storage_key='qualityChecks'
LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(qs.data)='array' THEN qs.data ELSE '[]'::jsonb END) AS qq(q)
 ON q->>'number'=r->>'qcNumber'
WHERE s.storage_key='materialReceipts';
SELECT q->>'number' AS qc_no, line->>'itemCode' AS item_code,
       line->>'receivedQty' AS received_qty, line->>'acceptedQty' AS accepted_qty,
       line->>'rejectedQty' AS rejected_qty
FROM erp_state s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.data)='array' THEN s.data ELSE '[]'::jsonb END) AS qq(q)
CROSS JOIN LATERAL jsonb_array_elements(coalesce(q->'items',q->'lines','[]'::jsonb)) AS ll(line)
WHERE s.storage_key='qualityChecks';

-- F. Inventory balance by item AND unit. Never sum across units. The numeric
-- parsing guard returns NULL for malformed quantities for manual reconciliation.
WITH items AS (
 SELECT data->>'itemCode' AS item_code, data->>'unit' AS unit,
        CASE WHEN coalesce(data->>'currentQty','') ~ '^-?[0-9]+(\.[0-9]+)?$'
             THEN (data->>'currentQty')::numeric END AS current_qty
 FROM module_records WHERE storage_key='inventoryItems'
), tx AS (
 SELECT data->>'itemCode' AS item_code, data->>'unit' AS unit,
        count(*) AS tx_count,
        sum(CASE WHEN upper(data->>'type')='IN' THEN
                   CASE WHEN coalesce(data->>'quantity','') ~ '^[0-9]+(\.[0-9]+)?$' THEN (data->>'quantity')::numeric END
                 WHEN upper(data->>'type')='OUT' THEN
                   CASE WHEN coalesce(data->>'quantity','') ~ '^[0-9]+(\.[0-9]+)?$' THEN -(data->>'quantity')::numeric END
                 ELSE NULL END) AS net_movement,
        count(*) FILTER (WHERE coalesce(data->>'quantity','') !~ '^[0-9]+(\.[0-9]+)?$') AS invalid_qty_rows
 FROM module_records WHERE storage_key='stockTransactions'
 GROUP BY data->>'itemCode',data->>'unit'
)
SELECT coalesce(i.item_code,t.item_code) AS item_code, coalesce(i.unit,t.unit) AS unit,
       i.current_qty, coalesce(t.tx_count,0) AS transaction_count, t.net_movement,
       CASE WHEN t.tx_count IS NULL THEN NULL ELSE i.current_qty-t.net_movement END AS unexplained_delta,
       coalesce(t.invalid_qty_rows,0) AS invalid_qty_rows,
       CASE WHEN t.tx_count IS NULL THEN 'NO_MOVEMENTS_OPENING_BALANCE_UNVERIFIED'
            WHEN i.current_qty IS NULL OR t.net_movement IS NULL THEN 'MANUAL_REVIEW'
            WHEN i.current_qty=t.net_movement THEN 'MATCH_NO_OPENING_BALANCE'
            ELSE 'DIFFERENCE_NO_AUTO_ADJUSTMENT' END AS reconciliation_status
FROM items i FULL JOIN tx t USING(item_code,unit)
ORDER BY item_code,unit;

-- G. Batch-reference coverage; blank/missing is an orphan/unlinked legacy row,
-- not permission to infer a supplier batch or opening inventory.
SELECT storage_key, count(*) AS rows_total,
       count(*) FILTER (WHERE nullif(btrim(coalesce(data->>'batchId',data->>'batchNumber','')),'') IS NOT NULL) AS rows_with_batch_ref
FROM module_records WHERE storage_key IN ('stockTransactions','inventoryItems') GROUP BY storage_key;
SELECT count(*) AS issue_lines, count(*) FILTER (WHERE nullif(btrim(line->>'batchId'),'') IS NOT NULL) AS lines_with_batch_ref
FROM erp_state s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.data)='array' THEN s.data ELSE '[]'::jsonb END) AS dd(d)
CROSS JOIN LATERAL jsonb_array_elements(coalesce(d->'items',d->'lines','[]'::jsonb)) AS ll(line) WHERE s.storage_key='storeIssueHistory';

-- H. Cross-reference coverage. Exact source field names should be confirmed before
-- a backfill; unmatched records must remain explicitly unlinked.
SELECT d->>'number' AS issue_no, d->>'mrNumber' AS mr_no, d->>'jobCardNumber' AS job_card,
       (SELECT count(*) FROM erp_state ms
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ms.data)='array' THEN ms.data ELSE '[]'::jsonb END) AS mm(m)
         WHERE ms.storage_key='materialRequests' AND m->>'number'=d->>'mrNumber') AS matching_mr_count
FROM erp_state s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.data)='array' THEN s.data ELSE '[]'::jsonb END) AS dd(d)
WHERE s.storage_key='storeIssueHistory';
SELECT count(*) AS supplier_master_rows FROM erp_state s
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.data)='array' THEN s.data ELSE '[]'::jsonb END) AS vv(v) WHERE s.storage_key='vendorMaster';

-- I. Post-migration validation templates (run only after a separately approved
-- migration/backfill). Compare source snapshots and projection rows by exact IDs.
-- Counts by document kind/source ID; any non-zero difference is a stop condition.
SELECT 'PO' AS kind, count(*) FROM trace_purchase_orders
UNION ALL SELECT 'receipt',count(*) FROM trace_receipts
UNION ALL SELECT 'issue',count(*) FROM trace_material_issues
UNION ALL SELECT 'return',count(*) FROM trace_material_returns;
-- Example set comparison after a separately approved projection exists:
-- SELECT source_doc_id FROM approved_source_receipt_id_snapshot
-- EXCEPT SELECT source_document_id FROM trace_receipts;
-- Explicit preservation checks should compare: source IDs in both EXCEPT directions;
-- per-receipt/per-unit quantity sums; stock currentQty vs movements; movement IDs;
-- QC accepted/rejected quantities; PO original ordered quantities; and line ordinals.
-- Do not execute generated DML or approve cutover while any difference is unexplained.
