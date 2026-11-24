import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, FileText } from 'lucide-react';
import { getNotifications, markAllNotificationsRead } from '../utils/storeService.js';
import { getCurrentUserInfo, isAdmin, normalizeDepartment } from '../utils/permissions.js';
import { openWorkflowDocument } from '../utils/workflowFiles.js';

const NotificationsPanel = () => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [allNotifications, setAllNotifications] = useState(getNotifications());

  const userInfo = getCurrentUserInfo();
  const userDept = normalizeDepartment(userInfo.employee?.department || '');
  const userRole = userInfo.roleKey || '';
  const admin = isAdmin();

  const notifications = useMemo(() => {
    return allNotifications.filter((n) => {
      if (!n.targetDept && !n.targetRole) return true;
      if (admin) return true;
      if (n.targetDept && normalizeDepartment(n.targetDept) === userDept) return true;
      if (n.targetRole && n.targetRole === userRole) return true;
      return false;
    });
  }, [allNotifications, userDept, userRole, admin]);

  const unread = notifications.filter((n) => !n.read).length;

  const refresh = () => setAllNotifications(getNotifications());

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      markAllNotificationsRead();
      refresh();
    }
  };

  /* A notification that carries a document (e.g. the PO PDF sent to Store)
     opens that file; anything else with a link navigates the app. */
  const activate = (n) => {
    setOpen(false);
    if (n.docId) {
      openWorkflowDocument({ id: n.docId, name: n.docName, kind: n.docKind || '' });
      return;
    }
    if (n.link) navigate(n.link);
  };

  const isClickable = (n) => Boolean(n.docId || n.link);

  return (
    <div className="notifications-panel">
      <button type="button" className={`notification-bell ${open ? 'is-open' : ''}`} onClick={handleToggle} aria-expanded={open} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
        <Bell className="notification-bell-icon" size={17} strokeWidth={1.75} aria-hidden="true" />
        {unread > 0 && <span className="notification-badge">{unread}</span>}
        <span className="notification-bell-label">Notifications</span>
      </button>
      {open && (
        <div className="notification-dropdown">
          <div className="notification-dropdown-head">
            <strong>Notifications</strong>
            <span className="muted-text">{notifications.length} total</span>
          </div>
          {notifications.length === 0 ? (
            <div className="notification-empty">No notifications yet.</div>
          ) : (
            <div className="notification-list">
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className={`notification-item type-${n.type}${isClickable(n) ? ' is-clickable' : ''}${n.docId ? ' has-document' : ''}`}
                  role={isClickable(n) ? 'button' : undefined}
                  tabIndex={isClickable(n) ? 0 : undefined}
                  onClick={() => { if (isClickable(n)) activate(n); }}
                  onKeyDown={(e) => {
                    if (isClickable(n) && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      activate(n);
                    }
                  }}
                >
                  <div className="notification-item-title">
                    {n.docId && <FileText className="notification-doc-tag" size={14} strokeWidth={1.75} aria-hidden="true" />}
                    {n.title}
                  </div>
                  <div className="notification-item-message">{n.message}</div>
                  <div className="notification-item-time">{n.dateTime}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default NotificationsPanel;
