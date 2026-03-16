import { useState, useMemo, useCallback } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { createClient } from './api/client';
import { useSSE } from './api/useSSE';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Rules from './pages/Rules';
import Logs from './pages/Logs';
import Approvals from './pages/Approvals';

function EventBridge({ token, children }) {
  const subscribers = useMemo(() => new Set(), []);
  const onEvent = useCallback((type, data) => {
    for (const fn of subscribers) fn(type, data);
  }, [subscribers]);

  useSSE('/api/events', { onEvent, token });

  const events = useMemo(() => ({
    subscribe: (fn) => subscribers.add(fn),
    unsubscribe: (fn) => subscribers.delete(fn),
  }), [subscribers]);

  return children(events);
}

export default function App() {
  const [token, setToken] = useState(sessionStorage.getItem('ashp_token'));
  const api = useMemo(() => token ? createClient('', token) : null, [token]);

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
    <EventBridge token={token}>
      {(events) => (
        <BrowserRouter>
          <Routes>
            <Route element={<Layout onLogout={handleLogout} />}>
              <Route index element={<Dashboard api={api} events={events} />} />
              <Route path="rules" element={<Rules api={api} />} />
              <Route path="logs" element={<Logs api={api} />} />
              <Route path="approvals" element={<Approvals api={api} events={events} />} />
            </Route>
          </Routes>
        </BrowserRouter>
      )}
    </EventBridge>
  );
}
