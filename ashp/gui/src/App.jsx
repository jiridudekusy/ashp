import { useState, useMemo, useCallback, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { createClient } from './api/client';
import { useSSE } from './api/useSSE';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Rules from './pages/Rules';
import Logs from './pages/Logs';
import Approvals from './pages/Approvals';

function EventBridge({ token, onConnect, onDisconnect, children }) {
  const subscribers = useMemo(() => new Set(), []);
  const onEvent = useCallback((type, data) => {
    for (const fn of subscribers) fn(type, data);
  }, [subscribers]);

  useSSE('/api/events', { onEvent, token, onConnect, onDisconnect });

  const events = useMemo(() => ({
    subscribe: (fn) => subscribers.add(fn),
    unsubscribe: (fn) => subscribers.delete(fn),
  }), [subscribers]);

  return children(events);
}

export default function App() {
  const [token, setToken] = useState(sessionStorage.getItem('ashp_token'));
  const [pendingCount, setPendingCount] = useState(0);
  const [sseConnected, setSseConnected] = useState(false);
  const [proxyConnected, setProxyConnected] = useState(false);
  const api = useMemo(() => token ? createClient('', token) : null, [token]);

  useEffect(() => {
    if (!api) return;
    api.getStatus().then(s => {
      setProxyConnected(!!s.proxy?.connected);
    }).catch(() => {});
    api.getApprovals().then(a => {
      setPendingCount(a.length);
    }).catch(() => {});
  }, [api]);

  function handleLogin(t) {
    sessionStorage.setItem('ashp_token', t);
    setToken(t);
  }
  function handleLogout() {
    sessionStorage.removeItem('ashp_token');
    setToken(null);
  }

  if (!token) return <Login onLogin={handleLogin} />;

  return (
    <EventBridge
      token={token}
      onConnect={() => setSseConnected(true)}
      onDisconnect={() => setSseConnected(false)}
    >
      {(events) => {
        return (
          <BrowserRouter>
            <ApprovalTracker events={events} setPendingCount={setPendingCount} />
            <Routes>
              <Route element={<Layout pendingCount={pendingCount} proxyConnected={proxyConnected && sseConnected} onLogout={handleLogout} />}>
                <Route index element={<Dashboard api={api} events={events} />} />
                <Route path="rules" element={<Rules api={api} events={events} />} />
                <Route path="logs" element={<Logs api={api} events={events} />} />
                <Route path="approvals" element={<Approvals api={api} events={events} />} />
              </Route>
            </Routes>
          </BrowserRouter>
        );
      }}
    </EventBridge>
  );
}

// Small component to subscribe to approval events and update pending count
function ApprovalTracker({ events, setPendingCount }) {
  useEffect(() => {
    const handler = (type) => {
      if (type === 'approval.needed') setPendingCount(c => c + 1);
      if (type === 'approval.resolved') setPendingCount(c => Math.max(0, c - 1));
    };
    events.subscribe(handler);
    return () => events.unsubscribe(handler);
  }, [events, setPendingCount]);
  return null;
}
