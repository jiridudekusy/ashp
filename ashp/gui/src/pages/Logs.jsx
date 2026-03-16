import { useState, useEffect } from 'react';

export default function Logs({ api }) {
  const [logs, setLogs] = useState([]);
  const [filters, setFilters] = useState({ limit: 50, offset: 0 });
  const [selected, setSelected] = useState(null);
  const [body, setBody] = useState(null);

  useEffect(() => { api.getLogs(filters).then(setLogs); }, [api, filters]);

  async function viewBody(logId, type) {
    const detail = await api.getLog(logId);
    setSelected(detail);
    const ref = detail[`${type}_body_ref`];
    if (!ref) { setBody('No body recorded'); return; }
    try {
      const content = type === 'request' ? await api.getRequestBody(logId) : await api.getResponseBody(logId);
      setBody(content);
    } catch (err) { setBody(`Failed to load body: ${err.message}`); }
  }

  return (
    <div>
      <h2>Request Logs</h2>
      <div className="filters">
        <select onChange={e => setFilters(f => ({ ...f, method: e.target.value || undefined }))}>
          <option value="">All Methods</option>
          {['GET','POST','PUT','DELETE','PATCH'].map(m => <option key={m}>{m}</option>)}
        </select>
        <select onChange={e => setFilters(f => ({ ...f, decision: e.target.value || undefined }))}>
          <option value="">All Decisions</option>
          {['allowed','denied','held','queued'].map(d => <option key={d}>{d}</option>)}
        </select>
        <input type="text" placeholder="URL filter"
          onChange={e => setFilters(f => ({ ...f, url: e.target.value || undefined }))} />
      </div>
      <table>
        <thead><tr><th>ID</th><th>Time</th><th>Method</th><th>URL</th><th>Status</th><th>Decision</th><th>Duration</th><th></th></tr></thead>
        <tbody>
          {logs.map(l => (
            <tr key={l.id} onClick={() => setSelected(l)}>
              <td>{l.id}</td><td>{l.timestamp}</td><td>{l.method}</td>
              <td title={l.url}>{l.url.substring(0, 60)}</td>
              <td>{l.response_status}</td><td>{l.decision}</td><td>{l.duration_ms}ms</td>
              <td><button onClick={() => viewBody(l.id, 'request')}>Body</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pagination">
        <button disabled={filters.offset === 0}
          onClick={() => setFilters(f => ({ ...f, offset: f.offset - f.limit }))}>Prev</button>
        <button disabled={logs.length < filters.limit}
          onClick={() => setFilters(f => ({ ...f, offset: f.offset + f.limit }))}>Next</button>
      </div>
      {selected && <div className="detail">
        <h3>Log #{selected.id}</h3>
        <pre>{JSON.stringify(selected, null, 2)}</pre>
        {body && <pre>{body}</pre>}
        <button onClick={() => { setSelected(null); setBody(null); }}>Close</button>
      </div>}
    </div>
  );
}
