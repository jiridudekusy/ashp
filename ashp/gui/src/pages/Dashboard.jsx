import { useState, useEffect } from 'react';

export default function Dashboard({ api, events }) {
  const [status, setStatus] = useState(null);
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    api.getStatus().then(setStatus);
    api.getLogs({ limit: 10 }).then(setRecent);
  }, [api]);

  useEffect(() => {
    if (!events) return;
    const handler = (type, data) => {
      setRecent(prev => [{ ...data, _event: type }, ...prev].slice(0, 20));
    };
    events.subscribe(handler);
    return () => events.unsubscribe(handler);
  }, [events]);

  if (!status) return <p>Loading...</p>;

  return (
    <div>
      <h2>Dashboard</h2>
      <div className="stats">
        <div>Proxy: {status.proxy?.running ? 'Running' : 'Stopped'}</div>
        <div>Rules: {status.rules_count}</div>
        <div>Source: {status.rules_source}</div>
        <div>Uptime: {Math.round((status.proxy?.uptime_ms || 0) / 1000)}s</div>
      </div>
      <h3>Recent Activity</h3>
      <table>
        <thead><tr><th>Time</th><th>Method</th><th>URL</th><th>Decision</th></tr></thead>
        <tbody>
          {recent.map((r, i) => (
            <tr key={r.id || i}>
              <td>{r.timestamp || 'now'}</td>
              <td>{r.method}</td>
              <td>{r.url}</td>
              <td>{r.decision || r._event}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
