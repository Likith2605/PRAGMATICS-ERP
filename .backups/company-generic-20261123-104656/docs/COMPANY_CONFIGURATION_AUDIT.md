# Company Configuration Audit — Stage A

Scope: complete project audit of hardcoded company-specific information. Source code was **not** modified during this stage.

Existing infrastructure to reuse (no new storage/service):
- `src/utils/companyBranding.js` — `getCompanyProfile()`, `getCompanyLegalName()`, `getCompanyLogoDataUri()`, `useCompanyBranding(fallbackLogoUrl)`.
- `companySettings` in `localStorage` → `erp_state` (PostgreSQL) via `erpStateSync.js` → hydrated on every workstation; write permission `settings.view` (`shared/stateAccess.js`).

Persistence path: `SettingsPage` save → `localStorage.companySettings` → `PUT /api/state` (1.5 s mirror) → `erp_state.storage_key='companySettings'` → `GET /state` on other computers → `erp-state-hydrated` event → branding hook re-render.

---

## 1. Primary identity constants and boot defaults — change required

| File | Lines | Hardcoded value | Replacement | Special handling |
|---|---|---|---|---|
| `src/constants/companyProfile.js` | 2–11 | `PRAGMATIC ENGINEERS`, tagline, full address, `+91 9880030466`, `pragmatic.vasudev@gmail.com`, `www.pragmaticengineers.in`, `Karnataka (29)`, `29AKWPP8736E1ZA` | Neutral/empty baseline; single last-resort fallback | Imported by `companyBranding.js`, `reportData.js`, `pdfGenerator.js`, `App.jsx`. Tests currently assert the GSTIN/address fallbacks. |
| `src/pages/SettingsPage.jsx` | 7–42 | Same values plus `bankDetails.accountName: 'PRAGMATIC ENGINEERS'`, standard terms containing the name, UPI placeholder `pragmatics@hdfcbank` | Neutral defaults; generic placeholders | Saved settings always win; reset uses these defaults. |
| `src/App.jsx` | 169–173 | Boot merge re-injects `OFFICIAL_COMPANY_PROFILE` into `companySettings` | Keep mechanism, neutral baseline | Critical: otherwise new installs get old identity back. |
| `src/utils/companyBranding.js` | 22, 27 | Spread + fallback to `OFFICIAL_COMPANY_PROFILE` | Keep as the single choke point | Baseline becomes neutral. |
| `src/utils/reportData.js` | 1, 15–18 | Same profile fallback | Keep, neutral baseline | — |
| `src/quality/config.js` | 14 | `readCompanyName() || "PRAGMATIC ENGINEERS"` | Neutral fallback (`''`) | Node-safe guard exists. |

## 2. Per-document `companyDetails` fallback literals — change required

| File | Lines | Values | Replacement | Special handling |
|---|---|---|---|---|
| `src/pages/CustomerInvoicePage.jsx` | 222–227 | name, phone, email, address, state | `getCompanyProfile()` values | Only used when settings missing; historical records keep their saved snapshot. |
| `src/pages/CustomerPurchaseOrderPage.jsx` | 107–112 | name, phone, email, variant address, state | same | Historical snapshot precedence. |
| `src/pages/DeliveryChallanPage.jsx` | 91–96 | same | same | Historical snapshot precedence. |
| `src/pages/PurchaseOrderPage.jsx` | 222–227 | same | same | Historical snapshot precedence. |
| `src/pages/SalesOrderPage.jsx` | 105–110 | same | same | Historical snapshot precedence. |
| `src/pages/SupplierInvoicePage.jsx` | 88–93 | same | same | Historical snapshot precedence. |
| `src/components/QuotationForm.jsx` | 40, 62, 102, 116 | default terms with 'Bangalore', state `Karnataka` | settings terms / neutral | Saved templates win. |

## 3. Document-generation utilities — change required

| File | Line | Value | Replacement | Special handling |
|---|---|---|---|---|
| `src/services/excelGenerator.js` | 96 | `GSTIN: 29AKWPP8736E1ZA \| Phone: +91 9880030466 \| Email: pragmatic.vasudev@gmail.com \| State: Karnataka` | Build from `getCompanyProfile()` | RFQ Excel letterhead; lines 69/90/94/242 already dynamic. |
| `src/services/pdfGenerator.js` | 1391 | `company.gstin || '29AKWPP8736E1ZA'` | `company.gstin || getCompanyProfile().gstin || ''` | Material Receipt PDF; preserve layout. |
| `src/services/pdfGenerator.js` | 1728 | same | same | Purchase Order PDF; preserves snapshot at 1718. |
| `src/services/tallyExportService.js` | 68, 72, 731 | companyName `PRAGMATIC ENGINEERS`, state `Karnataka (29)`, export fallback | settings/neutral | Party GSTINs at 308/346/… are customer data, not branding. |
| `src/utils/tallyXmlGenerator.js` | 63 | `companyName || 'PRAGMATIC ENGINEERS'` | neutral fallback | Pure Node module — do not import DOM accessors unguarded. |
| `src/utils/exportInvoiceService.js` | 47–55 | contact person, `+91 98800 30466`, IEC `AKWPP8736E`, LUT `AD2904260184606` | neutral defaults in the existing `exportCompanyProfile` | **Missing from Company Settings**: export contact/IEC/LUT/SWIFT. Proposal: add as an "Export Invoice" section of Company Settings in a later change; do not restructure now. |
| `src/utils/exportInvoiceService.js` | 158 | `company.companyName || 'PRAGMATIC ENGINEERS'` | dynamic name | Snapshot created at invoice time; never rewrite existing invoices. |
| `src/utils/workflowService.js` | 115 | PO terms with company name | neutral or `standardTerms.purchaseOrder` | Copied into saved POs — historical snapshots preserved. |
| `src/pages/PurchaseOrderPage.jsx` | 103 | same PO terms literal | same | Same. |
| `src/pages/ballooning/DrawingWorkspace.jsx` | 2987 | email signature `PRAGMATIC ENGINEERS` | `getCompanyLegalName()` | — |
| `src/utils/backupManager.js` | 1, 226, 241 | comment, `system: 'PRAGMATIC ENGINEERS ERP'`, filename `pragmatics-erp-full-backup-…` | dynamic company slug | New backups only; old backups untouched. |
| `src/utils/csvExporter.js` | 35, 83 | same | same | Legacy backup metadata. |
| `src/quality/report/logoDataUri.js` | 1 | embedded legacy JPEG logo | retained as last-resort fallback only | `logo.js` already prefers `logoDataUrl`; do not delete asset. |

## 4. Logo `alt` text — change required (image `src` already dynamic)

`AddProjectRequestPage` 443, `BackupExportPage` 428, `CustomerInvoicePage` 604, `CustomerPurchaseOrderPage` 476, `DeliveryChallanPage` 613, `ExportInvoicePage` 329, `InventoryPage` 438, `ProductionPage` 1144 & 3158, `ProjectRequestPage` 125, `PurchaseOrderPage` 662, `QuotationPage` 173, `SalesOrderPage` 513, `StorePage` 478, `SupplierInvoicePage` 447, `VendorEnquiryPage` 284 & 439, `VendorQuotationPage` 496 & 682 — all `alt="PRAGMATIC ENGINEERS logo"` → `alt={`${brandName} logo`}`.

Also `src/components/Sidebar.jsx:188` `<h1>Pragmatic</h1>` — should display configured company name (check width/ellipsis).

## 5. Must NOT change (fixed product identity / business data)

- `Generated By VYAVASTHA SOFTWARE` (`src/constants/reportFooter.js`, `src/quality/report/footer.js`) and `addVyavasthaFooter()` in `pdfGenerator.js`.
- `PRAGMATICS1 ERP` headers (`App.jsx:115`, `Header.jsx:37`) — **ambiguity**: requested product name is "VYAVASTA" but shipped identity is "PRAGMATICS1 ERP"/"VYAVASTHA SOFTWARE". Left unchanged pending confirmation.
- Customer PO Excel import contract (`src/utils/customerPOExcelImport.js`) — 11 fixed columns, restriction.
- Third-party customer/vendor master data (`masterCustomers.json`, `legacyCustomers.json`, `legacyPOData.json`, `vendorMaster.js`) — not own-company identity.
- Generic Indian state table (`src/utils/invoiceAddresses.js`) and `GST_STATES` — not branding.
- Dead files `src/pages/_pp_copy.jsx`, `_pp_before_orphan_del.jsx` — not routed; excluded from migration.
- No company PII in `server/` or `shared/`; only cosmetic startup banners (`server.js:178`, `lanInfo.js:18`, launcher `.bat`/`.ps1` files, docs).

## 6. Company Settings field coverage

Available and used: `companyName`, `logoDataUrl`, `address`, `phone`, `email`, `website`, `gstin`, `pan`, `state`, `bankDetails.{bankName,accountName,accountNumber,ifscCode,branch}`, `prefixes`, `standardTerms`.

Available but **unused by consumers**: `tagline`, `msmeNumber`, `bankDetails.upiId`, `prefixes.*`, `standardTerms.*` — populated in the UI but hardcoded strings are used instead. Fixing the literals in §3 is the minimum safe way to start using them.

Missing / outside settings (report only, no new mechanism created):
- Separate `stateCode` (currently free text `state: 'Karnataka (29)'`, stripped with regex by consumers).
- `legalName` exists only in `companyProfile.js`, not in `DEFAULT_COMPANY_SETTINGS` or the UI.
- Export-only fields `contactPerson`, `contactNo`, `iecNumber`, `lutNumber`, `swiftCode` live in a separate `exportCompanyProfile` record.
- Bank `swiftCode` (used by Export Invoice PDF) is not in `bankDetails`.

## 7. Historical document protection

Snapshot-bearing paths that must keep old values: `exportInvoiceHistory[].payload` (`exportInvoiceService.js:157–176`), PO/quotation `companyDetails` (`workflowService.js:1501`), PDF reprints `pdfGenerator.js:1718`, `2115–2117`, document `companyDetails` fallbacks in §2, saved `termsAndConditionsTemplates`/PO terms. No migration or rewrite of existing records is proposed.

## 8. Test expectations that encode the old identity

`tests/debitnote-pdf.mjs:188–189`, `tests/purchase-indent-pdf.mjs:117–118` assert the old GSTIN/address/phone/email/website default fallbacks; `tests/exportinvoice-pdf.mjs:307` asserts the old company name from configured settings. These assertions intentionally conflict with a neutral default and must be updated to assert configured values / absence of legacy data when defaults change.
