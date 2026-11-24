import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, FileText, ReceiptText, ClipboardCheck, Settings2, Truck, CircleDollarSign } from 'lucide-react';
import { getFullProjectData } from '../utils/projectTracker.js';

const STAGES = [
  { key: 'enquiry', label: 'Enquiry', icon: ClipboardList, route: '/project-request' },
  { key: 'quotation', label: 'Quotation', icon: FileText, route: '/quotation' },
  { key: 'customerPO', label: 'Customer PO', icon: ReceiptText, route: '/customer-purchase-order' },
  { key: 'salesOrder', label: 'Sales Order', icon: ClipboardCheck, route: '/sales-order' },
  { key: 'production', label: 'Job Card (QC)', icon: Settings2, route: '/production' },
  { key: 'deliveryChallan', label: 'Delivery Challan', icon: Truck, route: '/delivery-challan' },
  { key: 'customerInvoice', label: 'GST Invoice', icon: CircleDollarSign, route: '/customer-invoice' }
];

const WorkflowNavigator = ({ projectId, currentStage, sourceDocument = null }) => {
  const navigate = useNavigate();

  const projectData = useMemo(() => {
    if (!projectId) return null;
    return getFullProjectData(projectId, sourceDocument);
  }, [projectId, sourceDocument]);

  if (!projectId || !projectData || projectData.isLegacy) {
    return null;
  }

  const {
    customerDetails,
    projectRequest,
    quotation,
    quotationRef,
    customerPO,
    customerPoNumber,
    salesOrder,
    soNumber,
    jobCard,
    jobCardNumber,
    jobCardComplete,
    deliveryChallan,
    dcNumber,
    invoice,
    invoiceNumber
  } = projectData;

  // Map each stage with its document existence
  const stageData = {
    enquiry: {
      exists: Boolean(projectRequest || projectId),
      ref: projectId,
      onClick: () => navigate('/project-request', { state: { viewProject: projectRequest } })
    },
    quotation: {
      exists: Boolean(quotation || quotationRef),
      ref: quotationRef || quotation?.quotationDetails?.quotationNumber || '',
      onClick: () => {
        if (quotation) {
          navigate('/quotation/preview', { state: { quotation } });
        } else {
          navigate('/quotation');
        }
      }
    },
    customerPO: {
      exists: Boolean(customerPO || customerPoNumber),
      ref: customerPoNumber || customerPO?.poDetails?.customerPoNumber || '',
      onClick: () => {
        if (customerPO) {
          navigate('/customer-purchase-order', { state: { viewPO: customerPO } });
        } else {
          navigate('/customer-purchase-order');
        }
      }
    },
    salesOrder: {
      exists: Boolean(salesOrder || soNumber),
      ref: soNumber || salesOrder?.soDetails?.soNumber || '',
      onClick: () => {
        if (salesOrder) {
          navigate('/sales-order', { state: { viewOrder: salesOrder } });
        } else {
          navigate('/sales-order');
        }
      }
    },
    production: {
      exists: Boolean(jobCardComplete),
      ref: jobCardNumber || '',
      onClick: () => {
        navigate('/production', { state: { viewJobCard: jobCard || null } });
      }
    },
    deliveryChallan: {
      exists: Boolean(deliveryChallan || dcNumber),
      ref: dcNumber || deliveryChallan?.dcDetails?.dcNumber || '',
      onClick: () => {
        if (deliveryChallan) {
          navigate('/delivery-challan', { state: { viewChallan: deliveryChallan } });
        } else {
          navigate('/delivery-challan');
        }
      }
    },
    customerInvoice: {
      exists: Boolean(invoice || invoiceNumber),
      ref: invoiceNumber || invoice?.invoiceDetails?.invoiceNumber || '',
      onClick: () => {
        if (invoice) {
          navigate('/customer-invoice', { state: { viewInvoice: invoice } });
        } else {
          navigate('/customer-invoice');
        }
      }
    }
  };

  // Find currentIndex, previousStage, nextStage
  const currentIndex = STAGES.findIndex((s) => s.key === currentStage);
  const previousStage = currentIndex > 0 ? STAGES[currentIndex - 1] : null;
  const nextStage = currentIndex < STAGES.length - 1 ? STAGES[currentIndex + 1] : null;

  const handleGoPrevious = () => {
    if (!previousStage) return;
    const stageInfo = stageData[previousStage.key];
    if (stageInfo && stageInfo.exists) {
      stageInfo.onClick();
    } else {
      navigate(previousStage.route);
    }
  };

  const handleGoNext = () => {
    if (!nextStage) return;
    const stageInfo = stageData[nextStage.key];
    if (stageInfo && stageInfo.exists) {
      stageInfo.onClick();
    } else {
      navigate(nextStage.route);
    }
  };

  return (
    <div
      className="workflow-navigator-container no-print"
      style={{
        background: '#ffffff',
        border: '1px solid #cbd5e1',
        borderRadius: '14px',
        padding: '14px 18px',
        marginBottom: '22px',
        boxShadow: 'none'
      }}
    >
      {/* Top Header: Project Info + Quick Prev/Next Buttons */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '10px',
          borderBottom: '1px solid #f1f5f9',
          paddingBottom: '10px',
          marginBottom: '12px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: '14px', color: '#0f172a' }}>
            Project: <span style={{ color: '#2563eb' }}>{projectId}</span>
          </strong>
          {customerDetails?.companyName && (
            <span style={{ fontSize: '13px', color: '#475569' }}>
              • Customer: <strong>{customerDetails.companyName}</strong>
            </span>
          )}
        </div>
      </div>

      {/* Interactive Stepper Trail */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          overflowX: 'auto',
          paddingBottom: '4px'
        }}
      >
        {STAGES.map((st, idx) => {
          const info = stageData[st.key] || {};
          const isCurrent = st.key === currentStage;
          const isCompleted = info.exists;

          return (
            <React.Fragment key={st.key}>
              <div
                onClick={() => {
                  if (isCompleted && !isCurrent) {
                    info.onClick();
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '6px 12px',
                  borderRadius: '10px',
                  fontSize: '12px',
                  fontWeight: isCurrent ? '700' : '600',
                  cursor: isCompleted && !isCurrent ? 'pointer' : 'default',
                  transition: 'color 150ms ease, background-color 150ms ease, border-color 150ms ease',
                  whiteSpace: 'nowrap',
                  background: isCurrent
                    ? '#087e8b'
                    : isCompleted
                    ? '#f0fdf4'
                    : '#f8fafc',
                  color: isCurrent
                    ? '#ffffff'
                    : isCompleted
                    ? '#166534'
                    : '#94a3b8',
                  border: isCurrent
                    ? '1px solid #1d4ed8'
                    : isCompleted
                    ? '1px solid #bbf7d0'
                    : '1px solid #e2e8f0',
                  boxShadow: isCurrent ? '0 2px 6px rgba(37, 99, 235, 0.25)' : 'none'
                }}
                title={
                  isCurrent
                    ? `Current Stage: ${st.label}`
                    : isCompleted
                    ? `Click to view ${st.label} (${info.ref})`
                    : info.ref
                    ? `${st.label} ${info.ref} is not completed with final QC PASS`
                    : `${st.label} not created yet`
                }
              >
                <st.icon size={15} strokeWidth={1.75} aria-hidden="true" />
                <span>
                  {idx + 1}. {st.label}
                </span>
                {info.ref && (
                  <span
                    style={{
                      fontSize: '10.5px',
                      opacity: isCurrent ? 0.9 : 0.85,
                      fontWeight: 'normal',
                      marginLeft: '2px'
                    }}
                  >
                    ({info.ref})
                  </span>
                )}
                {isCompleted && !isCurrent && (
                  <span style={{ color: '#16a34a', fontWeight: 'bold', fontSize: '11px' }}>✓</span>
                )}
              </div>

              {/* Connecting arrow */}
              {idx < STAGES.length - 1 && (
                <span
                  style={{
                    color: isCompleted ? '#22c55e' : '#cbd5e1',
                    fontSize: '12px',
                    userSelect: 'none'
                  }}
                >
                  ➔
                </span>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default WorkflowNavigator;
