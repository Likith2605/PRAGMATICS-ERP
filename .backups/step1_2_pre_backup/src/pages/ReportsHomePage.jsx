import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { hasPermission } from '../utils/permissions.js';

/**
 * Reports landing page (Phase 1 — navigation only).
 *
 * Lists the approved first-release reports grouped by module. Reports that are
 * not yet implemented show a "Phase N" badge and are not clickable; they become
 * links as each phase ships. The Quality card links to the existing Quality
 * Reports page (QualityApp integration) — no new quality report is built here.
 *
 * Adding a report later = flip `available: true` and set its `path` below.
 */

const PHASE_BADGE = {
  2: { label: 'Phase 2', color: '#0369a1', bg: '#e0f2fe' },
  3: { label: 'Phase 3', color: '#7c3aed', bg: '#ede9fe' },
  4: { label: 'Phase 4 — best-effort', color: '#b45309', bg: '#fef3c7' }
};

const SECTIONS = [
  {
    section: 'Sales',
    reports: [
      {
        title: 'Sales Register',
        description: 'Customer-wise invoice register with payment status, taxable amounts, GST, and totals.',
        path: '/reports/sales-register',
        available: true
      },
      {
        title: 'Sales Order Status & Ageing',
        description: 'Open sales orders with age and ageing buckets (0-30 / 31-60 / 61-90 / 90+).',
        path: '/reports/sales-orders',
        available: true
      },
      {
        title: 'Customer Material Status',
        description: 'Sales Order line view of recorded production output, QC acceptance and delivery challans. Unlinked records remain visible as unavailable.',
        path: '/reports/sales/customer-material-status',
        available: true
      }
    ]
  },
  {
    section: 'Purchase',
    reports: [
      {
        title: 'Supplier Outstanding',
        description: 'Aged creditor statement: bills, payments, advances, outstanding by bucket.',
        path: '/reports/purchase/creditors',
        available: true
      },
      {
        title: 'Stale Purchase Order Report',
        description: 'Open and partially received purchase orders past their expected delivery dates.',
        path: '/reports/purchase/stale-orders',
        available: true
      },
      {
        title: 'Pre-Closed Purchase Order Report',
        description: 'Purchase orders closed before the full ordered quantity was received.',
        path: '/reports/purchase/pre-closed-orders',
        available: true
      },
      {
        title: 'Supplier-wise Item Report',
        description: 'Ordered and received materials, rates, values, and PO status by supplier.',
        path: '/reports/purchase/supplier-items',
        available: true
      },
      {
        title: 'Inward Report',
        description: 'Separate physical arrivals, material receipts, QC outcomes and GRN inventory postings.',
        path: '/reports/purchase/inward',
        available: true
      },
      {
        title: 'GRN – PO – PR Report',
        description: 'Purchase request and indent references through PO, receipt, GRN and QC where linked.',
        path: '/reports/purchase/grn-po-pr',
        available: true
      },
      {
        title: 'Advance Shipment Report',
        description: 'Advance shipment notices. No ASN source exists yet; the report shows no rows until records are captured.',
        path: '/reports/purchase/advance-shipment',
        available: true
      }
    ]
  },
  {
    section: 'Inventory',
    reports: [
      {
        title: 'Location Wise Lot Ledger',
        description: 'Batch movements by storage location with opening and closing quantities.',
        path: '/reports/inventory/location-lot-ledger',
        available: true
      },
      {
        title: 'Lot Wise Stock Statement',
        description: 'Received, issued, adjusted, and closing quantities by material lot.',
        path: '/reports/inventory/lot-stock-statement',
        available: true
      },
      {
        title: 'Lots Expired Beyond Shelf Life',
        description: 'Expired stock for materials and products with defined shelf-life tracking.',
        path: '/reports/inventory/expired-lots',
        available: true
      },
      {
        title: 'Lot Wise Stock Availability',
        description: 'Physical, reserved, blocked, rejected, and usable quantities by lot.',
        path: '/reports/inventory/lot-availability',
        available: true
      },
      {
        title: 'Lot Wise Stock Statement with Dimensions',
        description: 'Lot stock with applicable size, length, width, thickness, diameter, or weight.',
        path: '/reports/inventory/lot-stock-dimensions',
        available: true
      },
      {
        title: 'Stock Status Report',
        description: 'All items with current qty, reorder level, shortfall and suggested order qty.',
        path: '/reports/inventory/stock-status',
        available: true
      },
      {
        title: 'Stock Valuation Summary',
        description: 'Category-wise and item-wise stock value with totals. Values use current unit cost, not historical issue-time cost.',
        path: '/reports/inventory/valuation',
        available: true
      },
      {
        title: 'Material Issue Register',
        description: 'Employee-wise issued material register with optional Job Card or item grouping.',
        path: '/reports/inventory/material-issues',
        available: true
      },
      {
        title: 'Available / Issued Stock',
        description: 'Current item snapshot, reserved and available quantities, issued and returned ledger totals, and reconciliation status by unit.',
        path: '/reports/inventory/available-issued',
        available: true
      },
      {
        title: 'MRN Detail',
        description: 'Existing MR-… requests with requested, issued, returned and pending issue quantities.',
        path: '/reports/inventory/mrn-detail',
        available: true
      }
    ]
  },
  {
    section: 'Production',
    reports: [
      {
        title: 'Job Card Planned vs Actual',
        description: 'Per job card: planned qty vs accepted, rework, scrap and variance.',
        path: '/reports/production/planned-actual',
        available: true
      },
      {
        title: 'Job Card Material Issue & Return',
        description: 'Issued, returned and net consumed material per job card.',
        path: '/reports/production/jc-material',
        available: true
      },
      {
        title: 'Ready to Dispatch with Value',
        description: 'QC accepted quantity less dispatches linked to the exact Sales Order and item; value uses the Sales Order line rate where recorded.',
        path: '/reports/production/ready-despatch',
        available: true
      }
    ]
  },
  {
    section: 'Quality',
    reports: [
      {
        title: 'Quality Reports (existing)',
        description: 'Inspection reports, drawing reports and dispatch stickers from the QualityApp.',
        path: '/quality-report',
        available: true
      }
    ]
  },
  {
    section: 'Outsourcing',
    reports: [
      {
        title: 'OS Material with Supplier – Delivery Note-wise',
        description: 'Current HTR material with supplier by outward note. Other outsourced process types need their own source records before they can appear.',
        path: '/reports/outsource/material-with-supplier',
        available: true
      }
    ]
  },
  {
    section: 'Finance',
    reports: [
      {
        title: 'Sales Register',
        description: 'Same report as Sales — provided here as a finance entry point.',
        path: '/reports/sales-register',
        available: true
      },
      {
        title: 'Supplier Outstanding',
        description: 'Same report as Purchase — provided here as a finance entry point.',
        path: '/reports/purchase/creditors',
        available: true
      }
    ]
  },
  {
    section: 'Masters',
    reports: [
      {
        title: 'List of Items',
        description: 'Item master with missing-information flags (HSN, unit, reorder level, cost).',
        path: '/reports/masters/items',
        available: true
      },
      {
        title: 'List of Customers',
        description: 'Customer directory from master list plus transaction history. Exact-name matching only — similar names are not merged.',
        path: '/reports/masters/customers',
        available: true
      },
      {
        title: 'List of Supplier',
        description: 'Supplier master directory with contact and missing-information fields; no fuzzy transaction-name merges.',
        path: '/reports/masters/suppliers',
        available: true
      }
    ]
  }
];

const ReportCard = ({ report, onNavigate }) => {
  const isAvailable = !!report.available;
  const badge = isAvailable
    ? { label: 'Available', color: '#166534', bg: '#dcfce7' }
    : PHASE_BADGE[report.phase] || { label: 'Planned', color: '#475569', bg: '#f1f5f9' };

  return (
    <div
      onClick={isAvailable ? () => onNavigate(report.path) : undefined}
      style={{
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: '10px',
        padding: '14px 16px',
        cursor: isAvailable ? 'pointer' : 'default',
        opacity: isAvailable ? 1 : 0.85,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minHeight: '110px'
      }}
      title={isAvailable ? `Open ${report.title}` : `Coming in ${badge.label}`}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: '#1e293b' }}>{report.title}</div>
        <span
          style={{
            fontSize: '10px',
            fontWeight: 700,
            color: badge.color,
            background: badge.bg,
            borderRadius: '999px',
            padding: '3px 9px',
            whiteSpace: 'nowrap',
            flexShrink: 0
          }}
        >
          {badge.label}
        </span>
      </div>
      <div style={{ fontSize: '12px', color: '#64748b', lineHeight: 1.45, flex: 1 }}>{report.description}</div>
      {report.caveat && (
        <div style={{ fontSize: '11px', color: '#b45309', fontWeight: 600 }}>
          ⚠ Best-effort matching — see report notes for limitations.
        </div>
      )}
    </div>
  );
};

const ReportsHomePage = () => {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const allReportsAccess = hasPermission('reports.view');
  const visibleSections = useMemo(() => {
    const term = search.trim().toLowerCase();
    return SECTIONS.filter((section) => allReportsAccess || section.section === 'Purchase').map((section) => ({
      ...section,
      reports: section.reports.filter((report) => !term || `${report.title} ${report.description} ${section.section}`.toLowerCase().includes(term))
    })).filter((section) => section.reports.length);
  }, [search, allReportsAccess]);
  const totalReports = visibleSections.reduce((sum, s) => sum + s.reports.length, 0);
  const availableCount = visibleSections.reduce((sum, s) => sum + s.reports.filter((r) => r.available).length, 0);

  return (
    <div className="page-container" style={{ padding: '20px 24px' }}>
      <div className="content-block" style={{ marginBottom: '18px' }}>
        <div className="block-header">
          <h3 className="block-title">Reports</h3>
          <span className="muted-text">
            {availableCount} of {totalReports} reports available
          </span>
        </div>
        <div style={{ fontSize: '12.5px', color: '#64748b', lineHeight: 1.5 }}>
          Operational reports are grouped by module. Reports provide applicable filters, explicit Apply and Reset, filtered summaries, PDF, Excel and Print. Snapshot and master reports explain when date filtering does not apply.
        </div>
        <input type="search" className="action-select form-input search-input" placeholder="Search reports..."
          aria-label="Search reports" value={search} onChange={(event) => setSearch(event.target.value)}
          style={{ marginTop: '12px', minWidth: '240px' }} />
      </div>

      {visibleSections.map((section) => (
        <div className="content-block" key={section.section} style={{ marginBottom: '14px' }}>
          <div className="block-header">
            <h3 className="block-title">{section.section}</h3>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: '12px'
            }}
          >
            {section.reports.map((report) => (
              <ReportCard key={`${section.section}-${report.title}`} report={report} onNavigate={navigate} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

export default ReportsHomePage;
