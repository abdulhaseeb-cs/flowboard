import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession, useToast } from '../lib/session.jsx';
import { timeAgo } from '../lib/util.js';
import { Avatar } from './ui.jsx';

const ICON = { assigned: '👤', mentioned: '@', commented: '💬', due_soon: '⏰', overdue: '⚠️', completed: '✅', joined: '👋', role: '🔑' };

export default function NotificationBell() {
  const { socket } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef(null);

  const load = useCallback(async () => {
    const data = await api.get('/notifications');
    setItems(data.notifications);
    setUnread(data.unread);
  }, []);

  useEffect(() => { load().catch(() => {}); }, [load]);

  // Live push from the server (via Socket.IO, possibly relayed through Redis from another replica)
  useEffect(() => {
    if (!socket) return undefined;
    const onNew = (n) => {
      setItems((list) => [n, ...list].slice(0, 30));
      setUnread((u) => u + 1);
      toast(n.title, 'info');
    };
    const onReconnect = () => load().catch(() => {});
    socket.on('notification', onNew);
    socket.on('connect', onReconnect);
    return () => { socket.off('notification', onNew); socket.off('connect', onReconnect); };
  }, [socket, toast, load]);

  useEffect(() => {
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const markAll = async () => {
    await api.post('/notifications/read-all');
    setItems((l) => l.map((n) => ({ ...n, read: true })));
    setUnread(0);
  };

  const openItem = async (n) => {
    if (!n.read) {
      api.post(`/notifications/${n.id}/read`).catch(() => {});
      setItems((l) => l.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
    }
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  return (
    <div className="bell" ref={ref}>
      <button className="icon-btn bell-btn" id="notifications-btn" type="button" aria-label={`Notifications, ${unread} unread`} onClick={() => setOpen((o) => !o)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && <span className="badge-count" id="unread-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="popover notif-pop" data-testid="notifications-panel">
          <div className="popover-head">
            <strong>Notifications</strong>
            {unread > 0 && <button className="link-btn" type="button" onClick={markAll}>Mark all read</button>}
          </div>
          <ul className="notif-list">
            {items.length === 0 && <li className="notif-empty">You're all caught up.</li>}
            {items.map((n) => (
              <li key={n.id}>
                <button type="button" className={`notif ${n.read ? '' : 'notif-unread'}`} onClick={() => openItem(n)} data-testid="notification">
                  {n.actor ? <Avatar user={n.actor} size={28} /> : <span className="notif-icon">{ICON[n.type] || '•'}</span>}
                  <span className="notif-text">
                    <span className="notif-title">{n.title}</span>
                    {n.body && <span className="notif-body">{n.body}</span>}
                    <span className="notif-time">{timeAgo(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
