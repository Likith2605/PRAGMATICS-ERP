import express from 'express';
import { getPool } from './database.js';
import { requireAdmin, safeAuditValues } from './auth.js';
import { hasPermissionForRole } from './departmentAccess.js';

/**
 * Central Recycle Bin.
 *
 * Every authoritative module already keeps a durable tombstone on its own row
 * (deleted_at / deleted_by / delete_reason). This router reads those existing
 * tombstones, exposes a single filtered list, and performs authorised restore
 * or permanent purge with the same row-level rules the module APIs use.
 *
 *   GET    /api/recycle-bin                 list deleted records (module filtered by permission)
 *   GET    /api/recycle-bin/:entity/:id     one deleted record plus its audit trail
 *   POST   /api/recycle-bin/:entity/:id/restore   restore with dependency/uniqueness checks
 *   DELETE /api/recycle-bin/:entity/:id     permanent purge (Admin + explicit confirmation)
 *
 * Nothing is restored automatically. Purge is never cascaded into business
 * history tables: only line-item tables that belong to the document itself are
 * removed, and only after every blocking reference has been checked.
 */

const router = express.Router();
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const text = (value) => String(value ?? '').trim();
const isAdmin = (req) => req.user?.roleKey === 'admin' || req.user?.role === 'Administrator';

const audit = (client, req, { entity, recordId, label, action, reason, before, after }) => client.query(
    `INSERT INTO erp_audit_log (user_id,email,role,module,record_id,record_label,action,reason,before_values,after_values)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
    [req.user?.id || null, req.user?.email || '', req.user?.role || req.user?.roleKey || '',
        entity, recordId, label || recordId, action, reason,
        before ? JSON.stringify(safeAuditValues(before)) : null,
        after ? JSON.stringify(safeAuditValues(after)) : null]
);

const duplicate = async (client, table, whereSql, params, label) => {
    const result = await client.query(`SELECT 1 FROM ${table} WHERE deleted_at IS NULL AND ${whereSql} LIMIT 1`, params);
    if (result.rowCount) throw conflict(`Another active ${label} already uses the same business key.`);
};

const ENTITIES = [
    {
        entity: 'quotations', moduleKey: 'sales', moduleLabel: 'Sales',
        table: 'quotations', pk: 'quotation_number', document: 'quotation_number',
        labelSql: "COALESCE(quotation_number,'') || ' Â· ' || COALESCE(customer_name,'')",
        viewPermissions: ['sales.quotation'], writePermissions: ['sales.quotation'],
        dependencies: [],
        ownedChildren: [{ table: 'quotation_items', column: 'quotation_number' }],
        blockingChildren: [{ table: 'sales_orders', column: 'quotation_ref', source: 'quotation_number', label: 'sales order(s)' }]
    },
    {
        entity: 'customer_purchase_orders', moduleKey: 'sales', moduleLabel: 'Sales',
        table: 'customer_purchase_orders', pk: 'id', document: 'po_number', numericId: true,
        labelSql: "COALESCE(po_number,'') || ' Â· ' || COALESCE(customer_name,'')",
        viewPermissions: ['sales.customer_order'], writePermissions: ['sales.customer_order'],
        dependencies: [],
        ownedChildren: [{ table: 'customer_purchase_order_items', column: 'customer_po_id', source: 'id' }],
        blockingChildren: [],
        unique: async (client, row) => {
            if (!text(row.po_number)) return;
            await duplicate(client, 'customer_purchase_orders', 'lower(po_number)=lower($1) AND id<>$2', [row.po_number, row.id], 'Customer Purchase Order');
        }
    },
    {
        entity: 'sales_orders', moduleKey: 'sales', moduleLabel: 'Sales',
        table: 'sales_orders', pk: 'so_number', document: 'so_number',
        labelSql: "COALESCE(so_number,'') || ' Â· ' || COALESCE(customer_name,'')",
        viewPermissions: ['sales_order.view'], writePermissions: ['sales_order.view'],
        dependencies: [{ table: 'quotations', key: 'quotation_number', source: 'quotation_ref', label: 'Quotation' }],
        ownedChildren: [{ table: 'sales_order_items', column: 'so_number' }],
        blockingChildren: [
            { table: 'delivery_challans', column: 'sales_order_ref', source: 'so_number', label: 'delivery challan(s)' },
            { table: 'customer_invoices', column: 'sales_order_ref', source: 'so_number', label: 'customer invoice(s)' },
            { table: 'production_requirements', column: 'so_number', source: 'so_number', label: 'production requirement(s)' },
            { table: 'job_cards', column: 'so_number', source: 'so_number', label: 'job card(s)' },
            { table: 'material_requests', column: 'sales_order_ref', source: 'so_number', label: 'material request(s)' }
        ],
        unique: async (client, row) => {
            if (text(row.customer_po_number)) {
                await duplicate(client, 'sales_orders', 'lower(customer_po_number)=lower($1) AND so_number<>$2', [row.customer_po_number, row.so_number], 'Sales Order customer PO');
            }
            if (text(row.quotation_ref)) {
                await duplicate(client, 'sales_orders', 'lower(quotation_ref)=lower($1) AND so_number<>$2', [row.quotation_ref, row.so_number], 'Sales Order quotation');
            }
        }
    },
    {
        entity: 'delivery_challans', moduleKey: 'sales', moduleLabel: 'Sales',
        table: 'delivery_challans', pk: 'dc_number', document: 'dc_number',
        labelSql: "COALESCE(dc_number,'') || ' Â· ' || COALESCE(customer_name,'')",
        viewPermissions: ['delivery.view'], writePermissions: ['delivery.create', 'delivery.view'],
        dependencies: [{ table: 'sales_orders', key: 'so_number', source: 'sales_order_ref', label: 'Sales Order' }],
        ownedChildren: [{ table: 'delivery_challan_items', column: 'dc_number' }],
        blockingChildren: [{ table: 'customer_invoices', column: 'delivery_challan_ref', source: 'dc_number', label: 'customer invoice(s)' }],
        unique: async (client, row) => {
            const dispatchRequestId = text(row.payload?.dispatchRequestId);
            if (dispatchRequestId) {
                await duplicate(client, 'delivery_challans', "(payload->>'dispatchRequestId')=$1 AND dc_number<>$2", [dispatchRequestId, row.dc_number], 'Delivery Challan dispatch request');
            }
        }
    },
    {
        entity: 'customer_invoices', moduleKey: 'sales', moduleLabel: 'Sales',
        table: 'customer_invoices', pk: 'invoice_number', document: 'invoice_number',
        labelSql: "COALESCE(invoice_number,'') || ' Â· ' || COALESCE(customer_name,'')",
        viewPermissions: ['invoice.view'], writePermissions: ['invoice.view'],
        dependencies: [
            { table: 'sales_orders', key: 'so_number', source: 'sales_order_ref', label: 'Sales Order' },
            { table: 'delivery_challans', key: 'dc_number', source: 'delivery_challan_ref', label: 'Delivery Challan' }
        ],
        ownedChildren: [{ table: 'customer_invoice_items', column: 'invoice_number' }],
        blockingChildren: []
    },
    {
        entity: 'export_invoices', moduleKey: 'sales', moduleLabel: 'Sales',
        table: 'export_invoices', pk: 'invoice_number', document: 'invoice_number',
        labelSql: "COALESCE(invoice_number,'') || ' Â· ' || COALESCE(buyer_name,'')",
        viewPermissions: ['invoice.view'], writePermissions: ['invoice.view'],
        dependencies: [],
        ownedChildren: [{ table: 'export_invoice_items', column: 'invoice_number' }],
        blockingChildren: []
    },
    {
        entity: 'purchase_indents', moduleKey: 'purchase', moduleLabel: 'Purchase',
        table: 'purchase_indents', pk: 'indent_number', document: 'indent_number',
        labelSql: "COALESCE(indent_number,'') || ' Â· ' || COALESCE(status,'')",
        viewPermissions: ['indent.view'], writePermissions: ['indent.create', 'indent.view'],
        dependencies: [],
        ownedChildren: [
            { table: 'purchase_indent_quality_checks', column: 'indent_number' },
            { table: 'purchase_indent_quality_audit', column: 'indent_number' }
        ],
        blockingChildren: [
            { table: 'purchase_orders', column: 'indent_number', source: 'indent_number', label: 'purchase order(s)' },
            { table: 'vendor_enquiries', column: 'indent_number', source: 'indent_number', label: 'vendor enquiry(ies)' }
        ],
        unique: async (client, row) => {
            if (text(row.payload?.sourceType) === 'materialRequest' && text(row.payload?.requirementNumber)) {
                await duplicate(client, 'purchase_indents', "(payload->>'requirementNumber')=$1 AND (payload->>'sourceType')='materialRequest' AND indent_number<>$2", [row.payload.requirementNumber, row.indent_number], 'Purchase Indent material request');
            }
            if (text(row.payload?.repurchaseFor)) {
                await duplicate(client, 'purchase_indents', "(payload->>'repurchaseFor')=$1 AND indent_number<>$2", [row.payload.repurchaseFor, row.indent_number], 'Purchase Indent repurchase');
            }
        }
    },
    {
        entity: 'purchase_requests', moduleKey: 'purchase', moduleLabel: 'Purchase',
        table: 'purchase_requests', pk: 'pr_number', document: 'pr_number',
        labelSql: "COALESCE(pr_number,'') || ' · ' || COALESCE(project_id,'')",
        viewPermissions: ['purchase_request.view'], writePermissions: ['purchase_request.approve'],
        dependencies: [{ table: 'material_requests', key: 'mr_number', source: 'mr_number', label: 'Material Request' }],
        ownedChildren: [{ table: 'purchase_request_items', column: 'pr_number' }],
        blockingChildren: [
            { table: 'vendor_enquiries', column: 'pr_number', source: 'pr_number', label: 'vendor enquiry(ies)' },
            { table: 'purchase_orders', column: 'pr_number', source: 'pr_number', label: 'purchase order(s)' }
        ],
        auditTable: 'purchase_request_audit'
    },
    {
        entity: 'vendor_enquiries', moduleKey: 'purchase', moduleLabel: 'Purchase',
        table: 'vendor_enquiries', pk: 'enquiry_number', document: 'enquiry_number',
        labelSql: "COALESCE(enquiry_number,'') || ' Â· ' || COALESCE(status,'')",
        viewPermissions: ['purchase_request.view'], writePermissions: ['purchase_request.create', 'purchase_request.view'],
        dependencies: [{ table: 'purchase_indents', key: 'indent_number', source: 'indent_number', label: 'Purchase Indent' }],
        ownedChildren: [],
        blockingChildren: [{ table: 'vendor_quotations', column: 'enquiry_number', source: 'enquiry_number', label: 'vendor quotation(s)' }],
        unique: async (client, row) => {
            if (text(row.indent_number)) {
                await duplicate(client, 'vendor_enquiries', 'indent_number=$1 AND enquiry_number<>$2', [row.indent_number, row.enquiry_number], 'Vendor Enquiry indent');
            }
        }
    },
    {
        entity: 'vendor_quotations', moduleKey: 'purchase', moduleLabel: 'Purchase',
        table: 'vendor_quotations', pk: 'quotation_number', document: 'quotation_number',
        labelSql: "COALESCE(quotation_number,'') || ' Â· ' || COALESCE(vendor_name,'')",
        viewPermissions: ['purchase_request.view'], writePermissions: ['purchase_request.create', 'purchase_request.view'],
        dependencies: [{ table: 'vendor_enquiries', key: 'enquiry_number', source: 'enquiry_number', label: 'Vendor Enquiry' }],
        ownedChildren: [],
        blockingChildren: [{ table: 'purchase_orders', column: 'quotation_number', source: 'quotation_number', label: 'purchase order(s)' }],
        unique: async (client, row) => {
            if (text(row.enquiry_number) && text(row.vendor_id)) {
                await duplicate(client, 'vendor_quotations', 'enquiry_number=$1 AND lower(vendor_id)=lower($2) AND quotation_number<>$3', [row.enquiry_number, row.vendor_id, row.quotation_number], 'Vendor Quotation');
            }
        }
    },
    {
        entity: 'purchase_orders', moduleKey: 'purchase', moduleLabel: 'Purchase',
        table: 'purchase_orders', pk: 'po_number', document: 'po_number',
        labelSql: "COALESCE(po_number,'') || ' Â· ' || COALESCE(vendor_name,'')",
        viewPermissions: ['purchase.order'], writePermissions: ['purchase.order'],
        dependencies: [
            { table: 'purchase_indents', key: 'indent_number', source: 'indent_number', label: 'Purchase Indent' },
            { table: 'vendor_quotations', key: 'quotation_number', source: 'quotation_number', label: 'Vendor Quotation' }
        ],
        ownedChildren: [],
        blockingChildren: [
            { table: 'supplier_invoices', column: 'po_number', source: 'po_number', label: 'supplier invoice(s)' },
            { table: 'material_receipts', column: 'po_number', source: 'po_number', label: 'material receipt(s)' },
            { table: 'debit_notes', column: 'po_number', source: 'po_number', label: 'debit note(s)' }
        ]
    },
    {
        entity: 'supplier_invoices', moduleKey: 'purchase', moduleLabel: 'Purchase',
        table: 'supplier_invoices', pk: 'invoice_number', document: 'invoice_number',
        labelSql: "COALESCE(invoice_number,'') || ' Â· ' || COALESCE(vendor_name,'')",
        viewPermissions: ['purchase.supplier_invoice'], writePermissions: ['purchase.supplier_invoice'],
        dependencies: [
            { table: 'purchase_orders', key: 'po_number', source: 'po_number', label: 'Purchase Order' },
            { table: 'material_receipts', key: 'receipt_number', source: 'receipt_number', label: 'Material Receipt' }
        ],
        ownedChildren: [],
        blockingChildren: [
            { table: 'material_receipts', column: 'invoice_number', source: 'invoice_number', label: 'material receipt(s)' },
            { table: 'debit_notes', column: 'invoice_number', source: 'invoice_number', label: 'debit note(s)' }
        ]
    },
    {
        entity: 'material_receipts', moduleKey: 'purchase', moduleLabel: 'Purchase',
        table: 'material_receipts', pk: 'receipt_number', document: 'receipt_number',
        labelSql: "COALESCE(receipt_number,'') || ' Â· ' || COALESCE(vendor_name,'')",
        viewPermissions: ['receipt.view'], writePermissions: ['receipt.create', 'receipt.view'],
        dependencies: [{ table: 'purchase_orders', key: 'po_number', source: 'po_number', label: 'Purchase Order' }],
        ownedChildren: [
            { table: 'material_receipt_inspection_items', column: 'receipt_number' },
            { table: 'material_receipt_inspections', column: 'receipt_number' },
            { table: 'material_receipt_items', column: 'receipt_number' }
        ],
        blockingChildren: [
            { table: 'supplier_invoices', column: 'receipt_number', source: 'receipt_number', label: 'supplier invoice(s)' },
            { table: 'receipt_stock_movements', column: 'receipt_number', source: 'receipt_number', label: 'posted stock movement(s)' }
        ],
        unique: async (client, row) => {
            if (text(row.invoice_number)) {
                await duplicate(client, 'material_receipts', 'lower(invoice_number)=lower($1) AND receipt_number<>$2', [row.invoice_number, row.receipt_number], 'Material Receipt invoice');
            }
        }
    },
    {
        entity: 'material_requests', moduleKey: 'store', moduleLabel: 'Store',
        table: 'material_requests', pk: 'mr_number', document: 'mr_number',
        labelSql: "COALESCE(mr_number,'') || ' Â· ' || COALESCE(project_name,'')",
        viewPermissions: ['store.module', 'material_request.view'], writePermissions: ['store.module', 'material_request.edit'],
        dependencies: [
            { table: 'job_cards', key: 'job_card_number', source: 'job_card_number', label: 'Job Card' },
            { table: 'sales_orders', key: 'so_number', source: 'sales_order_ref', label: 'Sales Order' }
        ],
        ownedChildren: [{ table: 'material_request_items', column: 'mr_number' }],
        blockingChildren: [
            { table: 'store_issues', column: 'mr_number', source: 'mr_number', label: 'store issue(s)' },
            { table: 'store_returns', column: 'mr_number', source: 'mr_number', label: 'store return(s)' }
        ]
    },
    {
        entity: 'store_issues', moduleKey: 'store', moduleLabel: 'Store',
        table: 'store_issues', pk: 'issue_number', document: 'issue_number',
        labelSql: "COALESCE(issue_number,'') || ' Â· ' || COALESCE(receiver_name,'')",
        viewPermissions: ['material_issue.view'], writePermissions: ['material_issue.create', 'material_issue.confirm'],
        dependencies: [{ table: 'material_requests', key: 'mr_number', source: 'mr_number', label: 'Material Request' }],
        ownedChildren: [{ table: 'store_issue_items', column: 'issue_number' }],
        blockingChildren: [{ table: 'store_returns', column: 'issue_number', source: 'issue_number', label: 'store return(s)' }]
    },
    {
        entity: 'store_returns', moduleKey: 'store', moduleLabel: 'Store',
        table: 'store_returns', pk: 'return_number', document: 'return_number',
        labelSql: "COALESCE(return_number,'') || ' Â· ' || COALESCE(status,'')",
        viewPermissions: ['material_return.view'], writePermissions: ['material_return.create', 'material_return.view'],
        dependencies: [
            { table: 'store_issues', key: 'issue_number', source: 'issue_number', label: 'Store Issue' },
            { table: 'material_requests', key: 'mr_number', source: 'mr_number', label: 'Material Request' }
        ],
        ownedChildren: [{ table: 'store_return_items', column: 'return_number' }],
        blockingChildren: []
    },
    {
        entity: 'inventory_items', moduleKey: 'store', moduleLabel: 'Store',
        table: 'inventory_items', pk: 'item_code', document: 'item_code',
        labelSql: "COALESCE(item_code,'') || ' Â· ' || COALESCE(material_name,'')",
        viewPermissions: ['inventory.view'], writePermissions: ['inventory.adjust'],
        dependencies: [],
        ownedChildren: [],
        blockingChildren: [
            { table: 'stock_ledger_entries', column: 'item_code', source: 'item_code', label: 'stock ledger entr(ies)' },
            { table: 'inventory_batches', column: 'item_code', source: 'item_code', label: 'inventory batch(es)' }
        ]
    },
    {
        entity: 'debit_notes', moduleKey: 'purchase', moduleLabel: 'Purchase',
        table: 'debit_notes', pk: 'debit_note_number', document: 'debit_note_number',
        labelSql: "COALESCE(debit_note_number,'') || ' Â· ' || COALESCE(vendor_name,'')",
        viewPermissions: ['debitnote.view'], writePermissions: ['debitnote.create', 'debitnote.view'],
        dependencies: [
            { table: 'purchase_orders', key: 'po_number', source: 'po_number', label: 'Purchase Order' },
            { table: 'supplier_invoices', key: 'invoice_number', source: 'invoice_number', label: 'Supplier Invoice' }
        ],
        ownedChildren: [{ table: 'debit_note_items', column: 'debit_note_number' }],
        blockingChildren: []
    },
    {
        entity: 'production_requirements', moduleKey: 'production', moduleLabel: 'Production',
        table: 'production_requirements', pk: 'requirement_number', document: 'requirement_number',
        labelSql: "COALESCE(requirement_number,'') || ' Â· ' || COALESCE(part_name,'')",
        viewPermissions: ['production.view'], writePermissions: ['production.requirement.manage', 'production.view'],
        dependencies: [{ table: 'sales_orders', key: 'so_number', source: 'so_number', label: 'Sales Order' }],
        ownedChildren: [{ table: 'production_requirement_items', column: 'requirement_number' }],
        blockingChildren: []
    },
    {
        entity: 'job_cards', moduleKey: 'production', moduleLabel: 'Production',
        table: 'job_cards', pk: 'job_card_number', document: 'job_card_number',
        labelSql: "COALESCE(job_card_number,'') || ' Â· ' || COALESCE(part_name,'')",
        viewPermissions: ['production.view', 'job_card.view'], writePermissions: ['job_card.create', 'job_card.view', 'production.view'],
        dependencies: [
            { table: 'sales_orders', key: 'so_number', source: 'so_number', label: 'Sales Order' },
            { table: 'bom_headers', key: 'bom_number', source: 'bom_number', label: 'BOM' }
        ],
        ownedChildren: [
            { table: 'job_card_items', column: 'job_card_number' },
            { table: 'job_card_operations', column: 'job_card_number' }
        ],
        blockingChildren: [
            { table: 'production_entries', column: 'job_card_number', source: 'job_card_number', label: 'production entr(ies)' },
            { table: 'production_operation_entries', column: 'job_card_number', source: 'job_card_number', label: 'production operation entr(ies)' },
            { table: 'material_requests', column: 'job_card_number', source: 'job_card_number', label: 'material request(s)' },
            { table: 'ht_outsource_requests', column: 'job_card_number', source: 'job_card_number', label: 'HT outsource request(s)' }
        ]
    },
    {
        entity: 'bom_headers', moduleKey: 'production', moduleLabel: 'Production',
        table: 'bom_headers', pk: 'bom_number', document: 'bom_number',
        labelSql: "COALESCE(bom_number,'') || ' Â· ' || COALESCE(part_name,'')",
        viewPermissions: ['production.view'], writePermissions: ['production.view'],
        dependencies: [],
        ownedChildren: [{ table: 'bom_items', column: 'bom_number' }],
        blockingChildren: [{ table: 'job_card_items', column: 'bom_number', source: 'bom_number', label: 'job card item(s)' }]
    },
    {
        entity: 'ht_outsource_requests', moduleKey: 'production', moduleLabel: 'Production',
        table: 'ht_outsource_requests', pk: 'htr_number', document: 'htr_number',
        labelSql: "COALESCE(htr_number,'') || ' Â· ' || COALESCE(vendor_name,'')",
        viewPermissions: ['ht_outsource.view'], writePermissions: ['ht_outsource.create', 'ht_outsource.view'],
        dependencies: [{ table: 'job_cards', key: 'job_card_number', source: 'job_card_number', label: 'Job Card' }],
        ownedChildren: [],
        blockingChildren: []
    },
    {
        entity: 'customers', moduleKey: 'masters', moduleLabel: 'Masters',
        table: 'customers', pk: 'id', document: 'customer_code',
        labelSql: "COALESCE(customer_code,'') || ' Â· ' || COALESCE(company_name,'')",
        viewPermissions: ['sales_order.view', 'settings.view'], writePermissions: ['sales_order.view', 'settings.view'],
        dependencies: [], ownedChildren: [], blockingChildren: []
    },
    {
        entity: 'vendors', moduleKey: 'masters', moduleLabel: 'Masters',
        table: 'vendors', pk: 'id', document: 'vendor_code',
        labelSql: "COALESCE(vendor_code,'') || ' Â· ' || COALESCE(name,'')",
        viewPermissions: ['purchase.order', 'settings.view'], writePermissions: ['purchase.order', 'settings.view'],
        dependencies: [], ownedChildren: [], blockingChildren: []
    },
    {
        entity: 'machines', moduleKey: 'masters', moduleLabel: 'Masters',
        table: 'machines', pk: 'machine_id', document: 'machine_id',
        labelSql: "COALESCE(machine_id,'') || ' Â· ' || COALESCE(name,'')",
        viewPermissions: ['settings.view'], writePermissions: ['settings.view'],
        dependencies: [], ownedChildren: [], blockingChildren: []
    },
    {
        entity: 'uom_master', moduleKey: 'masters', moduleLabel: 'Masters',
        table: 'uom_master', pk: 'id', document: 'code',
        labelSql: "COALESCE(code,'') || ' Â· ' || COALESCE(name,'')",
        viewPermissions: ['settings.view', 'inventory.view'], writePermissions: ['settings.view', 'inventory.adjust'],
        dependencies: [], ownedChildren: [], blockingChildren: [
            { table: 'material_master', column: 'unit_code', source: 'code', label: 'material master record(s)' },
            { table: 'inventory_items', column: 'unit', source: 'code', label: 'inventory item(s)' },
            { table: 'material_request_items', column: 'unit', source: 'code', label: 'material request item(s)' },
            { table: 'store_issue_items', column: 'unit', source: 'code', label: 'store issue item(s)' },
            { table: 'store_return_items', column: 'unit', source: 'code', label: 'store return item(s)' },
            { table: 'material_receipt_items', column: 'unit', source: 'code', label: 'material receipt item(s)' },
            { table: 'bom_items', column: 'unit', source: 'code', label: 'BOM item(s)' }
        ],
        unique: async (client, row) => {
            await duplicate(client, 'uom_master', 'lower(code)=lower($1) AND id<>$2', [row.code, row.id], 'UOM');
        }
    },
    {
        entity: 'material_master', moduleKey: 'masters', moduleLabel: 'Masters',
        table: 'material_master', pk: 'id', document: 'item_code',
        labelSql: "COALESCE(item_code,'') || ' Â· ' || COALESCE(name,'')",
        viewPermissions: ['settings.view', 'inventory.view'], writePermissions: ['settings.view', 'inventory.adjust'],
        dependencies: [], ownedChildren: [], blockingChildren: [
            { table: 'inventory_items', column: 'item_code', source: 'item_code', label: 'inventory item(s)' },
            { table: 'material_request_items', column: 'material_id', source: 'item_code', label: 'material request item(s)' },
            { table: 'store_issue_items', column: 'material_id', source: 'item_code', label: 'store issue item(s)' },
            { table: 'store_return_items', column: 'material_id', source: 'item_code', label: 'store return item(s)' },
            { table: 'material_receipt_items', column: 'material_code', source: 'item_code', label: 'material receipt item(s)' },
            { table: 'bom_items', column: 'item_code', source: 'item_code', label: 'BOM item(s)' },
            { table: 'job_card_items', column: 'item_code', source: 'item_code', label: 'job card item(s)' },
            { table: 'stock_ledger_entries', column: 'item_code', source: 'item_code', label: 'stock ledger entr(ies)' },
            { table: 'inventory_batches', column: 'item_code', source: 'item_code', label: 'inventory batch(es)' }
        ],
        unique: async (client, row) => {
            await duplicate(client, 'material_master', 'lower(item_code)=lower($1) AND id<>$2', [row.item_code, row.id], 'Material');
        }
    }
];

const byEntity = new Map(ENTITIES.map((entry) => [entry.entity, entry]));

// Some modules wrote their global audit rows under a legacy storage-key label.
// The Recycle Bin detail view follows those aliases so the original delete
// entry is visible next to the tombstone.
const AUDIT_MODULE_ALIASES = {
    inventory_items: ['inventoryItems'],
    sales_orders: ['salesOrders'],
    customer_purchase_orders: ['Customer Purchase Orders'],
    purchase_indents: ['purchaseIndent'],
    vendor_enquiries: ['vendorEnquiry'],
    vendor_quotations: ['vendorQuotation'],
    purchase_orders: ['purchaseOrder'],
    bom_headers: ['bom'],
    ht_outsource_requests: ['ht_outsource'],
    customers: ['Master Data: Customers'],
    vendors: ['Master Data: Vendors'],
    machines: ['Master Data: Machines'],
    uom_master: ['Master Data: UOM'],
    material_master: ['Master Data: Materials']
};

const canView = (req, entry) => isAdmin(req) ||
    hasPermissionForRole(req.user?.roleKey, entry.viewPermissions, req.user?.rolePermissions);
const canWrite = (req, entry) => isAdmin(req) ||
    hasPermissionForRole(req.user?.roleKey, entry.writePermissions, req.user?.rolePermissions);

const entityFor = (raw) => {
    const entity = text(raw);
    const entry = byEntity.get(entity);
    if (!entry) throw notFound('Unknown Recycle Bin entity.');
    return entry;
};

const recordIdFor = (entry, raw) => {
    const id = text(raw);
    if (!id || id.length > 200) throw bad('A valid record id is required.');
    if (entry.numericId && !/^\d+$/.test(id)) throw notFound('Recycle Bin record not found.');
    return id;
};

const selectRow = async (client, entry, recordId, lock = false) => {
    const result = await client.query(
        `SELECT * FROM ${entry.table} WHERE ${entry.pk}=$1${lock ? ' FOR UPDATE' : ''}`,
        [recordId]
    );
    return result.rows[0] || null;
};

const assertDependencies = async (client, entry, row) => {
    for (const dependency of entry.dependencies || []) {
        const value = text(row[dependency.source]);
        if (!value) continue;
        const parent = await client.query(
            `SELECT deleted_at FROM ${dependency.table} WHERE ${dependency.key}=$1 LIMIT 1`,
            [value]
        );
        if (!parent.rowCount) {
            throw conflict(`${dependency.label} '${value}' no longer exists. Restore is blocked.`);
        }
        if (parent.rows[0].deleted_at) {
            throw conflict(`${dependency.label} '${value}' is still in the Recycle Bin. Restore it first.`);
        }
    }
};

const assertNoBlockingChildren = async (client, entry, row) => {
    for (const child of entry.blockingChildren || []) {
        const value = text(row[child.source]);
        if (!value) continue;
        const found = await client.query(`SELECT 1 FROM ${child.table} WHERE ${child.column}=$1 LIMIT 1`, [value]);
        if (found.rowCount) {
            throw conflict(`Cannot permanently delete this ${entry.entity.replace(/_/g, ' ')} while ${child.label} still reference it.`);
        }
    }
};

const deleteOwnedChildren = async (client, entry, row) => {
    const deleted = {};
    for (const child of entry.ownedChildren || []) {
        const value = row[child.source || entry.pk];
        if (value === null || value === undefined || value === '') continue;
        const result = await client.query(`DELETE FROM ${child.table} WHERE ${child.column}=$1`, [value]);
        deleted[child.table] = result.rowCount;
    }
    return deleted;
};

const view = (entry, row) => ({
    moduleKey: entry.moduleKey,
    moduleLabel: entry.moduleLabel,
    entity: entry.entity,
    recordId: String(row[entry.pk]),
    documentNumber: text(row[entry.document]),
    label: text(row[entry.document]) || text(row[entry.pk]),
    deletedAt: row.deleted_at,
    deletedBy: text(row.deleted_by),
    deleteReason: text(row.delete_reason),
    version: Number(row.version)
});

const validateDate = (raw, field) => {
    const value = text(raw);
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value))) {
        throw bad(`${field} must be an ISO date (YYYY-MM-DD).`);
    }
    return value.slice(0, 10);
};

router.get('/', async (req, res) => {
    const authorized = ENTITIES.filter((entry) => canView(req, entry));
    if (!authorized.length) {
        return res.json({ entries: [], total: 0, limit: 50, offset: 0, modules: [] });
    }

    const moduleFilter = text(req.query.module);
    const selected = moduleFilter ? authorized.filter((entry) => entry.moduleKey === moduleFilter) : authorized;
    if (!selected.length) {
        return res.json({ entries: [], total: 0, limit: 50, offset: 0, modules: [] });
    }

    const search = text(req.query.search || req.query.documentNumber).toLowerCase();
    const deletedBy = text(req.query.deletedBy).toLowerCase();
    const from = validateDate(req.query.from, 'from');
    const to = validateDate(req.query.to, 'to');
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const union = selected.map((entry) => `
        SELECT '${entry.moduleKey}'::text AS module_key,
               '${entry.moduleLabel}'::text AS module_label,
               '${entry.entity}'::text AS entity,
               ${entry.pk}::text AS record_id,
               COALESCE(${entry.document}::text,'') AS document_number,
               COALESCE(${entry.labelSql}, ${entry.document}::text, ${entry.pk}::text, '') AS label,
               deleted_at,
               COALESCE(deleted_by,'')::text AS deleted_by,
               COALESCE(delete_reason,'')::text AS delete_reason,
               version
        FROM ${entry.table}
        WHERE deleted_at IS NOT NULL`).join('\nUNION ALL\n');

    const params = [];
    const where = [];
    if (search) {
        params.push(`%${search}%`);
        const n = params.length;
        where.push(`(lower(document_number) LIKE $${n} OR lower(label) LIKE $${n} OR lower(deleted_by) LIKE $${n})`);
    }
    if (deletedBy) {
        params.push(`%${deletedBy}%`);
        where.push(`lower(deleted_by) LIKE $${params.length}`);
    }
    if (from) {
        params.push(from);
        where.push(`deleted_at >= $${params.length}::date`);
    }
    if (to) {
        params.push(to);
        where.push(`deleted_at < ($${params.length}::date + interval '1 day')`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countParams = [...params];
    const count = await getPool().query(
        `SELECT count(*)::int AS total FROM (${union}) recycle ${whereSql}`,
        countParams
    );

    params.push(limit);
    const limitParam = params.length;
    params.push(offset);
    const offsetParam = params.length;
    const rows = await getPool().query(
        `SELECT * FROM (${union}) recycle ${whereSql}
         ORDER BY deleted_at DESC, document_number
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        params
    );

    const modules = [...new Map(authorized.map((entry) => [entry.moduleKey, entry.moduleLabel])).entries()]
        .map(([key, label]) => ({ key, label }));

    res.json({
        entries: rows.rows.map((row) => ({
            moduleKey: row.module_key,
            moduleLabel: row.module_label,
            entity: row.entity,
            recordId: row.record_id,
            documentNumber: row.document_number,
            label: row.label,
            deletedAt: row.deleted_at,
            deletedBy: row.deleted_by,
            deleteReason: row.delete_reason,
            version: Number(row.version),
            canRestore: canWrite(req, byEntity.get(row.entity)),
            canPurge: isAdmin(req)
        })),
        total: count.rows[0]?.total || 0,
        limit,
        offset,
        modules
    });
});

router.get('/:entity/:recordId', async (req, res) => {
    const entry = entityFor(req.params.entity);
    if (!canView(req, entry)) return res.status(403).json({ error: 'Your role does not allow viewing this Recycle Bin module.' });
    const recordId = recordIdFor(entry, req.params.recordId);
    const row = await selectRow(getPool(), entry, recordId);
    if (!row || !row.deleted_at) throw notFound('This record is not in the Recycle Bin.');
    let auditRows;
    if (entry.auditTable) {
        const [moduleHistory, recycleHistory] = await Promise.all([
            getPool().query(
                `SELECT id,actor_email AS email,actor_role AS role,$2::text AS module,action,reason,before_values,after_values,created_at
                 FROM ${entry.auditTable} WHERE pr_number=$1 ORDER BY id DESC LIMIT 50`,
                [recordId, entry.entity]
            ),
            getPool().query(
                `SELECT id,email,role,module,action,reason,before_values,after_values,created_at
                 FROM erp_audit_log WHERE record_id=$1 AND module=$2 ORDER BY id DESC LIMIT 50`,
                [recordId, entry.entity]
            )
        ]);
        auditRows = [...moduleHistory.rows, ...recycleHistory.rows]
            .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))
            .slice(0, 50);
    } else {
        const history = await getPool().query(
            `SELECT id,email,role,module,action,reason,before_values,after_values,created_at
             FROM erp_audit_log WHERE record_id=$1 AND module = ANY($2::text[]) ORDER BY id DESC LIMIT 50`,
            [recordId, [entry.entity, ...(AUDIT_MODULE_ALIASES[entry.entity] || [])]]
        );
        auditRows = history.rows;
    }
    res.json({ entry: view(entry, row), audit: auditRows, canRestore: canWrite(req, entry), canPurge: isAdmin(req) });
});

router.post('/:entity/:recordId/restore', async (req, res) => {
    const entry = entityFor(req.params.entity);
    if (!canWrite(req, entry)) return res.status(403).json({ error: 'Your role does not allow restoring this Recycle Bin module.' });
    const recordId = recordIdFor(entry, req.params.recordId);
    const reason = text(req.body?.reason);
    if (!reason) throw bad('A restore reason is required.');

    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const row = await selectRow(client, entry, recordId, true);
        if (!row) throw notFound('Recycle Bin record not found.');
        if (!row.deleted_at) throw conflict('This record is already active.');
        await assertDependencies(client, entry, row);
        if (entry.unique) await entry.unique(client, row);
        const restored = await client.query(
            `UPDATE ${entry.table}
             SET deleted_at=NULL, deleted_by=NULL, delete_reason='', version=version+1, updated_at=now()
             WHERE ${entry.pk}=$1 RETURNING *`,
            [recordId]
        );
        await audit(client, req, {
            entity: entry.entity,
            recordId,
            label: text(row[entry.document]) || recordId,
            action: 'RECYCLE_BIN_RESTORE',
            reason,
            before: row,
            after: restored.rows[0]
        });
        await client.query('COMMIT');
        res.json({ record: restored.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
});

router.delete('/:entity/:recordId', requireAdmin, async (req, res) => {
    const entry = entityFor(req.params.entity);
    const recordId = recordIdFor(entry, req.params.recordId);
    const reason = text(req.body?.reason);
    const confirmation = text(req.body?.confirm);
    if (!reason) throw bad('A permanent delete reason is required.');
    if (!confirmation) throw bad('Type the document number in confirm to permanently delete.');

    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const row = await selectRow(client, entry, recordId, true);
        if (!row) throw notFound('Recycle Bin record not found.');
        if (!row.deleted_at) throw conflict('This record is active and cannot be purged from the Recycle Bin.');
        const expected = text(row[entry.document]) || recordId;
        if (confirmation !== expected) throw bad(`Confirmation does not match '${expected}'.`);

        await assertNoBlockingChildren(client, entry, row);
        const children = await deleteOwnedChildren(client, entry, row);
        const purged = await client.query(`DELETE FROM ${entry.table} WHERE ${entry.pk}=$1 RETURNING *`, [recordId]);
        await audit(client, req, {
            entity: entry.entity,
            recordId,
            label: expected,
            action: 'RECYCLE_BIN_PURGE',
            reason,
            before: row,
            after: { purged: true, ownedChildren: children }
        });
        await client.query('COMMIT');
        res.json({ purged: true, record: purged.rows[0], ownedChildren: children });
    } catch (error) {
        await client.query('ROLLBACK');
        if (error?.code === '23503') {
            throw conflict('This record is still referenced by other ERP data and cannot be permanently deleted.');
        }
        throw error;
    } finally {
        client.release();
    }
});

export default router;
