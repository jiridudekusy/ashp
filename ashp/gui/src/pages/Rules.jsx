import { useState, useEffect } from 'react';
import RuleForm from '../components/RuleForm';

export default function Rules({ api, readOnly }) {
  const [rules, setRules] = useState([]);
  const [editing, setEditing] = useState(null);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => { api.getRules().then(setRules); }, [api]);

  async function handleSave(rule) {
    if (editing === 'new') { await api.createRule(rule); }
    else { await api.updateRule(editing.id, rule); }
    setEditing(null);
    setRules(await api.getRules());
  }

  async function handleDelete(id) {
    await api.deleteRule(id);
    setRules(await api.getRules());
  }

  async function handleTest(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    setTestResult(await api.testRule(fd.get('url'), fd.get('method')));
  }

  return (
    <div>
      <h2>Rules {readOnly && <span>(read-only)</span>}</h2>
      {!readOnly && !editing && <button onClick={() => setEditing('new')}>New Rule</button>}
      {editing && <RuleForm rule={editing === 'new' ? null : editing}
        onSave={handleSave} onCancel={() => setEditing(null)} />}
      <table>
        <thead><tr><th>Priority</th><th>Name</th><th>Pattern</th><th>Methods</th><th>Action</th><th>Enabled</th><th></th></tr></thead>
        <tbody>
          {rules.map(r => (
            <tr key={r.id}>
              <td>{r.priority}</td><td>{r.name}</td><td><code>{r.url_pattern}</code></td>
              <td>{r.methods.join(', ') || '*'}</td><td>{r.action}</td><td>{r.enabled ? 'Yes' : 'No'}</td>
              <td>{!readOnly && <>
                <button onClick={() => setEditing(r)}>Edit</button>
                <button onClick={() => handleDelete(r.id)}>Delete</button>
              </>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Test URL</h3>
      <form onSubmit={handleTest}>
        <input name="url" placeholder="https://example.com/path" required />
        <input name="method" placeholder="GET" defaultValue="GET" />
        <button type="submit">Test</button>
      </form>
      {testResult && <pre>{JSON.stringify(testResult, null, 2)}</pre>}
    </div>
  );
}
