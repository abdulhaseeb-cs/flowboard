import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, tokenStore, setUnauthorizedHandler } from './api.js';

// ---------------------------------------------------------------- toasts
const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, type = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-2), { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`} role="status" data-testid="toast">{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------- session + socket
const SessionContext = createContext(null);
export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [workspaces, setWorkspaces] = useState([]);
  const [server, setServer] = useState(null); // which instance answered /api/health
  const socketRef = useRef(null);

  const logout = useCallback(() => {
    tokenStore.clear();
    socketRef.current?.close();
    socketRef.current = null;
    setSocket(null);
    setUser(null);
    setWorkspaces([]);
  }, []);

  useEffect(() => setUnauthorizedHandler(logout), [logout]);

  const refreshWorkspaces = useCallback(async () => {
    const { workspaces: list } = await api.get('/workspaces');
    setWorkspaces(list);
    return list;
  }, []);

  const refreshServer = useCallback(() => {
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setServer)
      .catch(() => setServer(null));
  }, []);

  // Open ONE WebSocket per session. transports:['websocket'] skips HTTP long-polling,
  // so no sticky sessions are needed between the API replicas behind Nginx.
  const connect = useCallback((token) => {
    socketRef.current?.close();
    const s = io({ path: '/socket.io', auth: { token }, transports: ['websocket'], reconnectionDelayMax: 5000 });
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', () => setConnected(false));
    s.on('workspace:changed', () => refreshWorkspaces().catch(() => {}));
    socketRef.current = s;
    setSocket(s);
  }, [refreshWorkspaces]);

  const startSession = useCallback(async (token, u) => {
    tokenStore.set(token);
    setUser(u);
    connect(token);
    await refreshWorkspaces().catch(() => {});
  }, [connect, refreshWorkspaces]);

  // Restore an existing session on page load
  useEffect(() => {
    refreshServer();
    const token = tokenStore.get();
    if (!token) { setReady(true); return; }
    api.get('/auth/me')
      .then(({ user: u }) => startSession(token, u))
      .catch(() => tokenStore.clear())
      .finally(() => setReady(true));
    return () => socketRef.current?.close();
  }, [startSession, refreshServer]);

  const value = useMemo(
    () => ({ user, setUser, ready, socket, connected, workspaces, refreshWorkspaces, startSession, logout, server, refreshServer }),
    [user, ready, socket, connected, workspaces, refreshWorkspaces, startSession, logout, server, refreshServer],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
