# Phase 2 PostgreSQL schema and cutover proposal

**Review package only. No migration, backfill, staging write, application edit, permission change, or stock adjustment was performed.** The SQL in this folder is not under `migrations/`; the current server auto-applies numbered SQL files from that directory at startup. Do not copy this proposal there until separately approved. The audit query file is a review template and has not been executed.

## Phase 1 scope retained

The target design supports the approved branded reports and Report Home work, purchase reports and authorized short-close, batch-aware inventory, manufacturing traceability from supplier batch to customer dispatch, and outsourcing for **all processes**. Short-close must preserve PO ordered quantity and receipt history while recording quantity, reason, approver, actor, and timestamp. Reporting must continue to cover existing and new reports with PDF, XLSX, and print where supported. This proposal does not change those application features.

## Audit findings relevant to schema design

The local PostgreSQL database was reachable and had migrations `001_ballooning` through `008_tally_export_amount`. The ERP business documents remain mostly JSON in `erp_state`; inventory items and stock transactions are in `module_records`. There are no relational receipt batch, finished-goods lot, or FG traceability tables today.

Observed source data: inventory items 17; stock transactions 19 (15 IN, 4 OUT); receipts 4 documents / 9 lines; ERP incoming QC 3 documents / 6 lines; purchase indents 2 / 3 lines; supplier PO history 2 / 3 lines; material requests 3 / 4 lines; issue history 3 / 4 lines; return history 1 header / 0 lines; job cards 2; sales orders 2 with 1 embedded item line; delivery challans 2 with 1 embedded item line; supplier master 1 sparse row. Customer master, batch records, FG lots, actual output records, and outsourcing records were absent in the inspected state. Do not infer their absence from records in other environments.

All receipt documents referenced a QC document where that reference existed, but 2 of 4 receipt headers had no `qcNumber`; do not infer a link for those. QC line quantities were internally valid: 342 received, 330 accepted, 12 rejected across the audited lines; these totals may span different units and must not be treated as one total. All issue documents referenced a material request; two had a matching Job Card reference. No material issue lines or stock movements had batch references. Stable line IDs were absent from the observed receipt, QC, issue, challan, and sales order lines. The return header had no return lines.

The existing `vendorMaster` has insufficient stable supplier identity fields, and no separate customer master was present in ERP state. Existing document snapshots remain the source of historical names and details. Do not merge supplier/customer records by fuzzy name matching.

## Schema and table impact

`001_traceability_schema.proposal.sql` defines an additive relational projection and future operational tables:

| Tables | Purpose / impact |
|---|---|
| `trace_suppliers` | Stable supplier UUID and historical source key/contact snapshot. Existing sparse vendor data can be linked only by a reviewed exact match. |
| `trace_items` | Stable item identity, source record ID, item code and UOM; item code duplicates/ambiguities must be resolved before projection. |
| `trace_purchase_orders`, `trace_purchase_order_lines`, `trace_po_close_events` | PO identity and stable line projection while preserving original document ID, line order, ordered quantity and source JSON. Close events are append-only audit records. No historical PO is short-closed by backfill. |
| `trace_receipts`, `trace_receipt_lines`, `trace_receipt_qc_events`, `trace_qc_batch_allocations` | Receipt/GRN and QC lineage. QC events explicitly allocate inspected/accepted/rejected amounts to one or more receipt batches. Missing or ambiguous references remain unlinked. |
| `trace_inventory_batches` | Supplier batch and/or internal receipt-batch identity, received/accepted/rejected facts, unit and QC/location state. Multiple splits per receipt line are supported. Quantity columns are receipt/QC facts, never another on-hand balance. |
| `trace_material_issues`, `trace_material_issue_lines`, `trace_issue_allocations`, `trace_material_returns`, `trace_return_allocations` | One issue line can allocate from several batches; returns point to the original issue allocation and batch. |
| `trace_job_cards`, `trace_customers`, `trace_sales_orders`, `trace_sales_order_lines` | Reviewed relational projections establish exact Job Card → project → Sales Order line → customer and item identity; preserve source snapshots and source IDs. |
| `trace_production_outputs`, `trace_finished_goods_lots`, `trace_material_consumptions`, `trace_finished_goods_qc_events` | Actual output event generates the FG lot. Actual consumption links the lot back to original issue allocation and supplier batch. Consumption is genealogy only (stock was already removed at issue). QC is append-only; reinspection references the prior event. |
| `trace_finished_goods_dispatch_allocations` | Challan line allocation to an FG lot, Sales Order line, customer and item. Service validates all relationships and available accepted lot quantity. |
| `trace_wip_lots`, `trace_outsourcing_orders`, `trace_outsourcing_shipments`, `trace_outsourcing_shipment_lines`, `trace_outsourcing_receipts` | All outsourced process types can move raw batches, semi-finished WIP lots, or finished goods. Each shipment line identifies exactly one source; partial in/out and inspection outcomes are tracked. HTR details remain in process-specific JSONB. |
| `trace_stock_movements` | Sole authoritative on-hand ledger for raw batches, WIP lots and FG lots. Every balance-changing business event has exactly one idempotent movement; receipt/QC/allocation/dispatch facts are linked to that posting and never counted as separate balances. |
| `trace_auth_identities`, `trace_auth_sessions`, `trace_idempotency_keys`, `trace_event_audit` | Server identity/session hashes, retry protection and append-only actor/permission audit history. Existing role definitions remain authoritative. |

UUIDs are generated by PostgreSQL. Existing documents are JSON and cannot safely be FK targets; their preserved document identifiers are unique text references with service-side validation. The proposed projections make new workflow relationships enforceable by relational FKs. A source PO with absent status stores `source_status=NULL` and `source_status_present=false`; it never receives a guessed historical value. Original raw status values are retained unchanged. Cross-row totals and equality across relationships require one backend transaction, row locks, and deferred constraint triggers or equivalent service enforcement; a row-level `CHECK` cannot enforce aggregate totals.

### Corrections: QC, ledger, production, dispatch and event safety

- `trace_qc_batch_allocations` links each incoming QC event to each inspected batch with quantities. Its service invariant requires the event and batch to belong to the same receipt line; QC batches can have multiple appended inspection events. QC status alone does not add stock.
- `trace_stock_movements` is the single source for physical custody/on-hand: positive quantity plus a centralized signed movement-type mapping. A physical receipt posts once; pending/rejected batches remain physically recorded but are blocked from issue until batch QC eligibility allows it. QC accepted/rejected quantities are facts/eligibility controls, not another inbound movement. Issue, return, outsourcing, production output, WIP output and dispatch records point to their unique movement posting. Batch `quantity_received/accepted/rejected` remain provenance/QC figures, not another balance to add. A GRN or QC post must not independently increment both item totals and ledger-derived balances. Legacy stock continues to be treated according to current source semantics until separately reconciled; no synthetic opening entries.
- At production output, Job Card, Project ID, Sales Order/header line, item code, UOM and customer are checked as one consistent chain. If any required source relation is missing or ambiguous, the output is held for correction. The source references are text until the JSON ERP documents are normalized; projection FKs make later relations stable.
- Dispatch requires exact equality: challan customer = Sales Order customer; FG lot item and unit = Sales Order line item and unit; challan line item and quantity match that line; FG lot is linked to the Job Card/project/order; dispatched cumulative quantity cannot exceed eligible QC accepted lot balance. Do not join dispatch to a project or item code alone.
- Multiple partial returns and consumption events are supported through event IDs. In a serialized transaction, cumulative returned + consumed quantity cannot exceed the original allocated issue quantity. A return and consumption must both reference the same issue allocation and batch; consumed material is not returned or deducted from stock a second time.
- One idempotency key per authenticated employee and operation is stored with request hash/result. Unique source event keys prevent duplicate posting on retries. Concurrent balance changes lock the batch/WIP/FG entity, check the ledger and QC-eligible balance, then write fact + movement + audit in one transaction.
- Audit events include resolved employee, existing role key, permission token, before/after snapshots and request ID. Database grants should make the audit append-only. Rollback disables routes/features and preserves all trace tables once operational data exists; recover by reviewed forward correction or an approved restore after reconciling post-checkpoint activity, never by dropping active-data tables.

### Authentication and existing permission enforcement

Authentication is server-side: verify password hashes held in `trace_auth_identities`, resolve an active employee and role from trusted server data, issue a random session whose hash is stored in `trace_auth_sessions`, and set a short-lived `HttpOnly; Secure; SameSite` cookie. Protect state-changing requests with CSRF controls and login rate limits. Do not authenticate from `localStorage`, accept client-supplied role/actor claims, or include credential/hash/session data in ERP state/backups. Backend middleware must resolve the user's existing role and check the existing permission token on each operation. Keep the current role matrix/grants unchanged; `delivery.create` remains a proposed token with no role assigned. Generic state/record APIs must not bypass domain transaction checks. Password transition and removal of plaintext fields require a separately approved API/application phase.

Before writing this DDL into a numbered migration, confirm PostgreSQL version/extension policy, table naming conventions, scale/precision requirements, identity and audit columns, and accepted deletion/retention policy. Existing PostgreSQL state is not altered by this proposal.

## Stable line identity and preservation

For historical arrays without line IDs, create projection IDs deterministically from `(source table/key, preserved document ID, original 1-based line ordinal)`, such as `legacy:receipt:<doc-id>:<ordinal>`. Store the original ordinal and source snapshot. Do not rewrite source JSON, reorder lines, or reinterpret historical line meaning. New operational lines receive UUIDs. A duplicate source document ID, missing document ID, or ambiguous line shape is a backfill stop condition for human resolution.

## Before-and-after mapping

| Existing source | Proposed target | Backfill and integrity rule |
|---|---|---|
| `module_records(storage_key='inventoryItems', record_id, data)` | Item reference in batch/movement records; future item master projection only after identity review | Preserve record IDs, code, UOM and current quantity. Never copy current quantity into a new opening movement. |
| `module_records(storage_key='stockTransactions', record_id, data)` | `trace_stock_movements` only where source has a defensible batch/source reference | Preserve every transaction ID and history in source; unbatched rows remain explicitly unlinked. Do not fabricate batch IDs or reconcile by adjusting balances. |
| `erp_state.materialReceipts` and `qualityChecks` | receipt, receipt lines, QC events, batches | Preserve receipt/QC document numbers. Link only exact references and item/line matches. Do not turn accepted receipt quantity into batch stock twice; receipt movement creation must be idempotent and cutover-approved. |
| `supplierPOHistory`, `purchaseIndents`, `storePurchaseRequests` | PO headers/lines and separate indent/request references | PO number/document ID and line ordinal retained. Indent and request are not POs. Preserve original ordered quantity and receipt history; no historical close event is inferred. |
| `materialRequests` | Source reference on issue and production workflow | Keep MR identity/status; never convert requested quantity into consumption. |
| `storeIssueHistory`, `materialReturnHistory` | issue header/lines, per-batch allocations, return header/allocations | Issue line may allocate to multiple accepted batches. Historical unbatched issues remain unallocated. Returns must link to original issue allocation; no line is invented for the empty return header. |
| `productionJobCards` and production QC state | Job Card source references, output events, FG lots and append-only QC events | A planned quantity or legacy final QC field is not actual output. No historical FG lot is synthesized without an actual output event and source linkage. |
| HTR / outsourcing state | generic outsourcing order/shipment/receipt structures | Preserve process type and source references. Current audited HTR/outsource data was zero; no rows backfilled. Support all outsourced process types, not only HTR. |
| `salesOrderHistory`, `deliveryChallanHistory` | source references and stable line projections; lot dispatch allocations only when exact lot data exists | Preserve document ID, line order and customer snapshots. No FG lot or dispatch link inferred from item code alone. |
| `vendorMaster` | `trace_suppliers` | Sparse record becomes candidate only; exact reviewed mapping required. Keep legacy key and original supplier-name snapshots. |
| customer fields embedded in orders/challans/invoices | customer snapshots; future customer identity table requires separate design | No standalone customer master in audited state. Do not merge same-name customers or create false stable identities. |

## Read-only stock reconciliation

Use query F in `002_read_only_audit.proposal.sql` to produce item + unit rows. It compares `inventoryItems.currentQty` with the sum of recorded IN minus OUT movements and displays movement count, unexplained delta and status. It intentionally reports no-movement items separately and never totals unlike units. The observed audit found 7 matched item codes with transactions and item records; all 7 current quantities differed from recorded net movement. Ten item rows had no transactions. Six movement rows use item code `-` and have no matching item. Those differences are **unexplained**, not proposed adjustments: opening balances may exist outside the ledger. Before cutover, reconcile each item/unit with signed physical count, verified opening evidence, transaction history and owner decision. Any manual correction must be a separately approved, audited adjustment, never a backfill side effect.

The live read-only result was:

| Item | Unit | Current qty | Movement rows | Net IN−OUT | Unexplained delta |
|---|---:|---:|---:|---:|---:|
| PRAG-101 | Kg | 500 | 0 | — | No movement history |
| PRAG-102 | Nos | 120 | 0 | — | No movement history |
| PRAG-103 | Nos | 2000 | 0 | — | No movement history |
| PRAG-104 | Kg | 350 | 0 | — | No movement history |
| PRAG-105 | Kg | 0 | 3 | -80 | 80 |
| PRAG-106 | Kg | 180 | 0 | — | No movement history |
| PRAG-107 | Kg | 45 | 0 | — | No movement history |
| PRAG-108 | Nos | 75 | 0 | — | No movement history |
| PRAG-109 | Nos | 33 | 1 | 15 | 18 |
| PRAG-110 | Nos | 7 | 4 | -43 | 50 |
| PRAG-111 | Nos | 85 | 0 | — | No movement history |
| PRAG-112 | Nos | 14 | 3 | 0 | 14 |
| PRAG-113 | Nos | 60 | 0 | — | No movement history |
| PRAG-114 | Kg | 90 | 0 | — | No movement history |
| PRAG-115 | Nos | 28 | 1 | 10 | 18 |
| PRAG-116 | Nos | 10 | 0 | — | No movement history |
| PRAG-351 | Nos | 40 | 1 | -30 | 70 |

There are also 6 movement rows (net 180) carrying item code `-`, with no matching inventory item record; they are an orphan/unclassified transaction group and are excluded from item balances until identified. Among code-matched items, seven have movement history and all seven differ from current quantity; ten have no movements. The row values are quantities in each item's own unit. No automatic adjustment is allowed.

## Browser local-storage / offline sync cutover design

At a separately approved cutover: announce a maintenance window and pause business writes; each active device exports its ERP backup through the existing export flow. Capture app version, user/device identifier, UTC export time, pending-sync status/counts and a SHA-256 checksum. Exclude credentials, auth tokens and session values. Preserve the original encrypted export in access-controlled quarantine.

Compare each export to PostgreSQL by storage key and stable business document ID; compare `inventoryItems` and `stockTransactions` by their existing module record IDs. For line arrays without IDs, use document ID + original ordinal only as a comparison key. Classify local-only, server-only, identical and divergent records. Do not select a winning copy automatically and do not upload entire local arrays through the generic `/api/state` route. Resolve divergence with the record owner, retain source checksums and resolution log, then (only after separate approval) test an import into an isolated staging environment. Reconcile counts, IDs, movement history and quantities again before any production cutover. Keep offline devices read-only until their snapshot has been reconciled.

## Authentication and authorization design

Inspection found frontend-bundled admin account constants, employee password comparison against `employees` records in browser local storage, and `erp_auth` role identity stored client-side. Employee state can sync to PostgreSQL. These patterns do not establish a trusted server identity and risk exposing password material; credential values are intentionally not reproduced here.

Proposed future design: backend login verifies a server-managed password hash (Argon2id or bcrypt); remove password/hash fields from ERP state and browser backups through a planned credential transition. Issue a short-lived server-signed session in `HttpOnly`, `Secure`, `SameSite` cookie; enforce CSRF on writes, rate-limit login, rotate exposed/default credentials during separately approved deployment, and derive user and current role from server-side employee/role data. Never trust a submitted `roleKey`, actor name or permission claim. Require permission middleware on every write route, audit verified actor and operation, and block generic state/record endpoints from mutating transactional keys once domain endpoints are active. This requires API changes and credential migration, neither included or performed here.

Add `delivery.create` as a permission token in the existing permission structure. Candidate roles for review: Sales Manager and Sales Employee because both operate delivery workflows; confirm whether Store Manager needs it for dispatch execution. Do not assign the token or change role grants before explicit approval. Existing purchase short-close authorization remains restricted to the already authorized role structure and must be checked by backend permission middleware.

## Migration/backfill sequence and impact

1. **Backup + baseline:** verified PostgreSQL backup, checksums, migration inventory and source counts/ID sets; no source writes.
2. **Additive DDL:** create trace tables/indexes/constraints only. No existing records or balances change. Confirm locking/disk impact and deploy during a controlled window.
3. **Read-only mapping rehearsal:** export source snapshots, deterministic line IDs and exception lists. No staging inserts during this proposal phase.
4. **Separately approved backfill:** insert only exact source projections, using idempotent source keys; leave ambiguous records unresolved. No stock movement creation from inferred opening balance. Backfill does not create output, batch, QC or dispatch history absent from sources.
5. **Dual-read validation:** source and projection counts, both-direction ID set comparisons, quantity checks by document/item/unit, orphan checks and browser export reconciliation.
6. **Separately approved API cutover:** backend transactional operations, permission checks, idempotency, concurrency locks, auth and monitoring. Start with feature-gated workflows and documented recovery checkpoint.

## Validation queries and stop conditions

`002_read_only_audit.proposal.sql` includes source inventory, duplicate-ID, stable-line-ID, receipt/QC link, issue/MR, batch coverage and per-item/unit stock checks. Its final section provides target projection counts. Before/after validation must additionally compare source and target ID sets in both `EXCEPT` directions, preserve every PO number and original line ordinal/ordered quantity, compare receipt and QC quantities per receipt line and unit, compare each inventory item quantity and every transaction ID/history, check every target FK for orphans, and verify one source event maps to at most one target event. Require zero unreviewed differences and a signed exception log. Never compare aggregate quantities across units.

Some query templates require adapting to the confirmed JSON field variants. Run against a consistent snapshot/read replica; validate key column names first. A template error must be corrected and reviewed before use, not bypassed by changing live data.

## Backup checklist

- Quiesce writes for the approved backup point and record UTC time, host, database and operator.
- Take a PostgreSQL custom-format full backup (`pg_dump -Fc`) and verify it with `pg_restore --list`; separately preserve schema, roles/grants and migration ledger.
- Capture source counts, ID sets, per-item/unit stock report and SHA-256 checksums for backup and browser exports.
- Store encrypted copies in access-controlled locations; test restore to an isolated database and record duration/results.
- Retain the pre-cutover backup and browser exports until recovery is signed off; never expose credential fields in logs or audit extracts.

## Rollback and recovery

Before any separately approved DDL, validate backup restore. If DDL fails, stop deployment and restore/repair from the checkpoint; do not issue broad `DROP` statements. New tables must **not** be dropped if they contain operational data. Roll back application feature flags/routes first, preserve new operational tables and records, and repair forward or restore the full database only under an approved recovery decision. Do not roll back by deleting newly captured batches, QC events, production outputs, consumption, outsourcing or dispatch records. Keep append-only audit events and idempotency keys. If a backfill is wrong, mark the projection as quarantined, take a fresh backup, and correct with reviewed compensating entries; preserve the original source and evidence. A full restore can discard later business activity, so reconcile the write window and obtain an explicit recovery decision before restoring.

## Verification scenarios for later implementation

- Normal: one receipt batch, accepted QC, one issue allocation, output/FG lot, actual consumption, accepted FG QC, dispatch from that lot; report traces supplier → GRN → QC → issue → Job Card → FG lot → challan.
- Partial: partial receipt and partial QC; issue quantity cannot exceed accepted available batch balance; partial output and partial dispatch retain remaining balances.
- Rejected: rejected supplier receipt quantity cannot be issued; rejected FG quantity cannot dispatch; reinspection appends an event and preserves prior QC.
- Multiple batches: one issue line allocates from two supplier batches; actual consumption links each consumed allocation to an FG lot; supplier-level report returns both source batches without double counting.
- Returns: partial return restores only the original batch/allocation and cannot exceed outstanding issued quantity; consumption and return totals are independently validated.
- Outsourcing: raw batch or FG lot shipment, partial receipt, rejected quantity and repeated receipt are idempotent and traceable for each process type.
- Concurrency/idempotency: competing issue/dispatch writes cannot overspend available balance; retries with the same idempotency key create one event.

## Part B — pending ERP reporting assessment

### Current reporting architecture and exports

`src/pages/ReportsHomePage.jsx` is the only Report Home. It links the existing category cards to routes in `src/App.jsx`; the ten report names below are not currently ten distinct report pages. Existing overlapping pages are noted so their links can be extended rather than duplicated.

Most reports read browser local-storage-backed state through `storeService.js`, `workflowService.js`, `reportData.js`, `purchaseReportData.js`, or `inventoryReportData.js`. There are no report-specific SQL views or reporting API endpoints. Synced data uses generic `GET /api/state`, `GET/PUT /api/state/:key`, `POST/PUT /api/state`, and `GET/PUT /api/records/:key`; `module_records` currently owns `inventoryItems` and `stockTransactions`. These are generic sync APIs, not a consistent reporting/query service, and active browsers can contain unsynced data. New reports should use explicit report data services; reconciled stock/traceability needs server-side reads over normalized entities.

`ReportRegister.jsx` provides the Company Settings brand header, PDF through `generateRegisterPDF`, XLSX, Print, and optional CSV. Existing Material Issue Register, Material with Supplier, and Ready to Despatch use it and already expose PDF/XLSX/Print. PDF/XLSX export all filtered/sorted rows, but print renders only the current paginated table; print must be changed to include all filtered rows or explicitly select all before printing. New report pages should use this same register. QualityApp's existing Quality Reports page has separate output controls and is outside these ten.

### Report-by-report assessment

#### 1. List of Supplier

- **Status:** No report card/page. `VendorMasterPage.jsx` is data maintenance, not a report register.
- **Sources/APIs:** `vendorMaster` via `getVendorMaster()` in `vendorMaster.js`; supplier snapshots in `supplierPOHistory`, `materialReceipts`, `supplierInvoiceHistory`, `htOutsourceRequests`; generic state APIs only.
- **Columns/filters:** Supplier code/name, phone/email/address, GSTIN, active/status, source and missing-data flags; filter supplier, active, missing contact/GSTIN.
- **Calculation:** One row per stable supplier identity. Show transaction-derived aliases separately until an exact reviewed link exists; never fuzzy-merge names.
- **Missing:** Audited supplier master was one sparse record without reliable stable code/tax/status fields.
- **Now/API:** An incomplete master-directory report can be built now with explicit incompleteness. A unified supplier activity report needs stable supplier IDs and alias links.
- **Export/Home:** PDF, XLSX, Print via ReportRegister. Add one card under Masters; do not duplicate Vendor Master navigation.

#### 2. Available / Issued Stock

- **Status:** No combined report. Existing Stock Status reports current item quantity/reorder; lot availability reports batch quantities.
- **Sources/APIs:** `inventoryItems`, `stockTransactions`, `inventoryBatches`, `storeIssueHistory`, `materialReturnHistory`; `getInventoryItems`, `getStockTransactions`, `getInventoryBatches`, `getStoreIssues`, `getMaterialReturns`, `getItemStockOverview`; `/api/records/inventoryItems` and `/api/records/stockTransactions`.
- **Columns/filters:** Item code/name, UOM/location, opening, available, gross issued, returned, blocked/reserved, closing, as-of date; filters item/category/location/date/status.
- **Calculation:** Available is ledger balance at as-of; issued comes from OUT movements; returns are linked IN movements. Never add issue-document quantity on top of an OUT movement. Keep balances by item and UOM.
- **Missing:** CurrentQty and movement totals diverge for seven matched items; ten have no movements; six movements carry item code `-`. Batch linkage and authoritative as-of ledger are incomplete.
- **Now/API:** A diagnostic can display current snapshot vs movement-derived balance now. Certified available/issued needs item/unit reconciliation, batch links, and a server read endpoint.
- **Export/Home:** PDF, XLSX, Print via ReportRegister. Add one Inventory card.

#### 3. Employee-wise Issued Material

- **Status:** Substantially implemented in `MaterialIssueRegisterPage.jsx` at `/reports/inventory/material-issues`; grouping can be Employee, Job Card, Item.
- **Sources/APIs:** `storeIssueHistory` through `getStoreIssues()`; line `currentIssueQty`, receiver name/employee ID/department, item, MR, JC/project. No report endpoint.
- **Columns/filters:** Date, issue no, employee ID/name/department, issued-by, item, batch/lot, qty/UOM, MR/JC/project; filters date/employee/item/department/JC.
- **Calculation:** Gross issue quantities per line and employee/UOM. Returns must remain distinct or be separately reported; don't label gross issue as consumption.
- **Missing:** Employee identifiers and batches are absent on some historical issue lines.
- **Now/API:** Existing feature is usable and can be refined; no new endpoint needed for its current stored fields. Server reporting endpoint recommended for cross-device consistency.
- **Export/Home:** PDF/XLSX/Print already supported. Reuse current card and path; clarify its employee-wise mode in the existing card, no duplicate entry.

#### 4. Inward Report

- **Status:** No report. ERP distinguishes physical receipts, arrivals, QC, and inventory-posted GRNs.
- **Sources/APIs:** `materialReceipts` via `getReceipts()`, `materialArrivals` via `getArrivals()`, `qualityChecks`, `storeGRNs` via `getGRNs()`, `stockTransactions`; generic state APIs.
- **Columns/filters:** Receipt/arrival/GRN no/date, PO/PR/Indent, supplier, invoice/DC/vehicle, item/UOM, delivered, accepted/rejected/pending QC, posted quantity, batch/location; supplier/PO/date/QC filters.
- **Calculation:** Keep physical delivery, quality outcome, and stock posting as separate events. Never sum receipt + arrival + GRN as three inward quantities. Exact receipt/QC/line references govern links.
- **Missing:** Header QC number missing on some receipts; no stable line IDs; accepted posting must be linked exactly once.
- **Now/API:** Physical inward register with source labels is possible now. Reconciled accepted-stock inward requires line IDs, batch/QC links, and server query.
- **Export/Home:** PDF/XLSX/Print via ReportRegister. Add one Purchase card.

#### 5. GRN–PO–PR Report

- **Status:** No joined report. PO progress exists in `workflowService.getPOProgress`; PR and Indent are distinct workflows.
- **Sources/APIs:** `supplierPOHistory`/`getPurchaseOrders`, `storePurchaseRequests`/`getPurchaseRequests`, `purchaseIndents`/`getIndents`, `materialReceipts`, `materialArrivals`, `qualityChecks`, `storeGRNs`, `getPOProgress()`.
- **Columns/filters:** PR/Indent, PO number/date/status, supplier, PO line/item/UOM/ordered/rate, receipt/GRN/QC, received/accepted/rejected/pending, values; filter PR/PO/supplier/date/status.
- **Calculation:** Follow explicit originating PR/Indent → PO → receipt/GRN → QC line. Avoid duplicate counting across physical arrival, receipt and posting. PO line matching by item code/name can collapse duplicate same-item lines; stable line IDs are needed.
- **Missing:** Exact line-level PR→PO and receipt→QC→GRN links are not consistently represented; source statuses may be absent.
- **Now/API:** Document-level best effort possible with unlinked exceptions; reliable report needs stable line keys and relational/server query.
- **Export/Home:** PDF/XLSX/Print via ReportRegister. Add one Purchase card.

#### 6. Advance Shipment Report

- **Status:** No dedicated page, state key, or accessor found. `materialArrivals` captures an actual arrival, not an advance shipment notice.
- **Sources/APIs:** No ASN source identified; nearby records are POs, arrivals, receipts/GRNs.
- **Columns/filters:** ASN no/date, supplier, PO + line, expected ship/arrival, carrier/tracking, shipped qty/UOM, expected vs arrived, variance/status; supplier/PO/date/status.
- **Calculation:** ASN is its own event; don't infer it from PO due date or arrival. Link exact PO lines; distinguish shipment from arrival.
- **Missing:** Entire advance-shipment workflow and its source fields.
- **Now/API:** Requires new source data and API/schema before rows can exist. No fabricated rows.
- **Export/Home:** PDF/XLSX/Print via ReportRegister once implemented. Plan one Purchase card, unavailable until the source workflow exists.

#### 7. Customer Material Status

- **Status:** No report. Store Sales Order review describes procurement/material requirement status, not end-to-end customer fulfillment.
- **Sources/APIs:** `salesOrderHistory`, `productionJobCards`, `materialRequests`, `storeIssueHistory`, `materialReturnHistory`, `deliveryChallanHistory`, invoice histories; `getSalesOrders()`, `getSalesOrderMaterialStatus()`, `getDocumentChain()`.
- **Columns/filters:** Customer/order/project/line/item, ordered, required/available/purchased/received/issued, production actual/QC accepted, ready/dispatched/invoiced/pending; filters customer/order/project/date/status.
- **Calculation:** Exact Sales Order line and UOM; distinguish raw material readiness from finished production and dispatch. Current `getSalesOrderMaterialStatus` is procurement-only.
- **Missing:** Stable Sales Order line, Job Card, FG lot and challan line links; output/QC quantity lineage.
- **Now/API:** Procurement subsection possible with caveats; complete lifecycle requires traceability schema and a report endpoint.
- **Export/Home:** PDF/XLSX/Print via ReportRegister. Add one Sales card.

#### 8. MRN Detail (existing `MR-...` records)

- **Status:** No dedicated detail report; Material Issue Register shows MR number only.
- **Sources/APIs:** `materialRequests` generated as `MR-...`, `storeIssueHistory`, `materialReturnHistory`, `storePurchaseRequests`, `purchaseIndents`, `productionJobCards`; `getMaterialRequests`, `getMRMaterialTotals`, `getMRScopeQtyMaps`, `getStoreIssues`, `getMaterialReturns`.
- **Columns/filters:** MR/date/requester, JC/SO/project/customer, item/UOM/requested, issue refs/qty, returns, balance, linked PR/Indent, required date/status; filter MR/date/status/JC/project/item.
- **Calculation:** Per MR line, requested vs gross issue vs exact linked partial returns vs open balance. Do not treat status alone as a quantity. Avoid merging duplicate item lines by material ID.
- **Missing:** Stable MR line identity and explicit issue/return line links.
- **Now/API:** Document-level detail is possible now; exact line-level balances need IDs and linked transactions.
- **Export/Home:** PDF/XLSX/Print via ReportRegister. Add one Store/Inventory card; keep separate from Material Issue Register.

#### 9. OS Material with Supplier — Delivery Note-wise, all processes

- **Status:** Partial existing page `MaterialWithSupplierPage.jsx`, route `/reports/outsource/material-with-supplier`, currently reads only `htOutsourceRequests`.
- **Sources/APIs:** HTR records via `getHTOutsourceRequests()`; no shared non-HT process or delivery-note API.
- **Columns/filters:** Process type, supplier, delivery note/date, raw/WIP/FG lot, item/UOM, sent, partial returns, accepted/rejected/awaiting QC, outstanding at supplier, JC/project/customer; filter process/supplier/note/date/status.
- **Calculation:** Outstanding = dispatched qty less accepted physical returns, with rejected/awaiting QC shown separately. Group by process + delivery note + line + lot; no mixed-UOM totals. Existing `max(0, issuedQty-receivedQty)` is HTR aggregate only.
- **Missing:** Common outsourcing model for raw, WIP and FG; delivery note line identities and partial receipt/QC links.
- **Now/API:** HTR-only summary now; all-process report requires proposed outsourcing entities and endpoint.
- **Export/Home:** PDF/XLSX/Print already supported. Retain the one Outsourcing card/path and extend it; don't add a duplicate.

#### 10. Ready to Dispatch with Value

- **Status:** Quantity page exists at `/reports/production/ready-despatch`; no trustworthy value column or exact lot/order allocation.
- **Sources/APIs:** `productionJobCards`, `deliveryChallanHistory`, Job Card QC fields, `inventoryItems`; `getJobCards()` and local-storage reader.
- **Columns/filters:** Customer/order/project/JC/FG lot/item, produced, accepted/rejected/rework, dispatched, ready qty/UOM, unit value/source and ready value, challan/date; filter customer/order/JC/QC/date.
- **Calculation:** Actual output minus rejected/rework; eligible ready = cumulative accepted qty minus dispatch against that exact FG lot/order line. Value requires an approved basis (Sales Order line price or cost), not an arbitrary current item price.
- **Missing:** Current code substitutes planned order quantity for missing actual output; dispatch is matched globally by project OR item code and uses `max`, which can misattribute another order/customer and hide over-dispatch. Quantities are labelled `Nos`. No exact FG-lot/SO-line links or value policy.
- **Now/API:** Existing quantity page requires calculation correction before certification. Correct value report requires traceability schema/API and an approved value basis.
- **Export/Home:** PDF/XLSX/Print already supported. Keep and correct the existing Production card/route; do not add a second Ready to Dispatch card.

### Forward/backward traceability report

No current report can join supplier batch → receipt/GRN → incoming QC → issue allocation → Job Card → actual output → FG lot → FG QC → challan/customer. State keys include `materialReceipts`, `qualityChecks`, `storeGRNs`, `inventoryBatches`, `stockTransactions`, `storeIssueHistory`, `materialRequests` (`MR-...`), `productionJobCards`, `deliveryChallanHistory`, and `htOutsourceRequests`, but relationships are incomplete or only document-level. The report needs the proposed QC batch allocations, single stock ledger, issue allocations, Job Card/SO line links, output/FG lots, consumption, append-only QC, dispatch allocations, and generalized outsourcing API. Support forward and backward lookup by supplier batch, GRN, QC, MR, issue, JC, FG lot, challan, order, customer and item. Display missing links as exceptions; never infer from item code alone. Use ReportRegister for PDF/XLSX/Print after the print-all-rows behavior is addressed.

### Existing report calculation corrections

1. **Ready to Despatch:** remove planned quantity as an actual-output fallback, remove status-based accepted-quantity inference, and stop matching dispatch by item or project alone. Current code builds a map keyed by DC item code but looks it up with the Job Card number, so that path does not reliably count JC dispatches; the project-level aggregate can then attribute another order's lines. Use actual output, QC events, exact FG lot/order line/challan allocation. Don't total across UOMs as `Nos`.
2. **Job Card Planned vs Actual:** completed cards fall back to planned quantity when actual output is missing. Summary reads `summary.totalPendingQty` while computation names it `totalPending`, so that card is zero/undefined. Totals also assume `Nos` across cards.
3. **Job Card Material Issue & Return:** returns grouped by JC/material are subtracted from every matching issue line, risking duplicate subtraction. Raw-material fields on a JC can be emitted as an issue, including fallback quantity `1`; that invents an issue event. Use exact return-to-issue links and exclude unrecorded issues.
4. **Lot Ledger/Statement/Availability:** batch transaction matching falls back to supplier-batch strings and can be ambiguous; ambiguous movements are collapsed into one summary row. Opening quantity is hard-coded to zero while closing uses `availableQty`, so it is not a complete historical ledger. Verify whether `availableQty` already excludes reserved/blocked/rejected before subtracting them again for usable quantity.
5. **Inventory Stock Status:** totals current/available/shortfall across different units; suppress totals or group by UOM. CurrentQty has known reconciliation differences; label as source snapshot until reconciled.
6. **Purchase stale/pre-closed/supplier-wise:** stale report compares date strings and can treat placeholder `-` as a due date; parse valid dates only. Pre-closed report falls back to pending quantity as short-closed quantity, and missing approval/reason becomes a legacy label—don't present that as verified approval. Supplier-wise line matching selects the first same item code/name and can collapse duplicates; use stable PO line IDs and preserve null/missing status.
7. **Supplier Outstanding:** paid amount is read from invoice amountPaid or Paid status; payment transaction allocations/credit notes aren't joined. Age is based on invoice date although due date is shown. Reconcile payments and age by due date for accurate ageing.
8. **Material Issue Register:** employee grouping is gross issue quantity, not net consumption. Keep UOM-separated totals and only add net figures when returns are linked exactly.
9. **Inventory valuation:** current unit cost is not historical issue/dispatch value. Preserve its caveat and don't use it as customer shipment value without approved policy.

### Exact Report Home integration plan (proposal only)

Keep `ReportsHomePage.jsx` as the one Report Home and preserve existing routes. Proposed card-to-path map:

| Card in existing category | Proposed path | Integration |
|---|---|---|
| List of Supplier (Masters) | `/reports/masters/suppliers` | New card/route |
| Available / Issued Stock (Inventory) | `/reports/inventory/available-issued` | New card/route |
| Employee-wise Issued Material (Inventory) | `/reports/inventory/material-issues` | Existing card/route; clarify employee grouping, do not add another card |
| Inward (Purchase) | `/reports/purchase/inward` | New card/route |
| GRN–PO–PR (Purchase) | `/reports/purchase/grn-po-pr` | New card/route |
| Advance Shipment (Purchase) | `/reports/purchase/advance-shipment` | Planned card/route; keep unavailable until an ASN source is approved |
| Customer Material Status (Sales) | `/reports/sales/customer-material-status` | New card/route |
| MRN Detail (Inventory/Store) | `/reports/inventory/mrn-detail` | New card/route |
| OS Material with Supplier – Delivery Note-wise (Outsourcing) | `/reports/outsource/material-with-supplier` | Existing card/route; extend its source coverage |
| Ready to Dispatch with Value (Production) | `/reports/production/ready-despatch` | Existing card/route; correct quantity lineage and add approved value basis |

Add seven new cards once each; reuse the three existing entries above. No duplicate Finance cards or new report home. Existing Sales Register/Supplier Outstanding shortcuts remain untouched to preserve functionality. Mark new cards unavailable until sources/calculations pass validation; permissions remain unchanged. `src/App.jsx` will need matching route declarations in the later implementation phase. Every report route uses ReportRegister and PDF/XLSX/Print, with Print showing all filtered rows. No application file has been changed in this assessment.
