import { useState, useEffect, useCallback } from 'react';

export default function Agents({ api }) {
  const [agents, setAgents] = useState([]);
  const [name, setName] = useState('');
  const [createdToken, setCreatedToken] = useState(null);
  const [rotatedToken, setRotatedToken] = useState(null);

  const load = useCallback(async () => {
    setAgents(await api.getAgents());
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e) => {
    e.preventDefault();
    const agent = await api.createAgent({ name });
    setCreatedToken({ name: agent.name, token: agent.token });
    setName('');
    load();
  };

  const handleToggle = async (agent) => {
    await api.updateAgent(agent.id, { enabled: !agent.enabled });
    load();
  };

  const handleDelete = async (agent) => {
    if (!confirm(`Delete agent "${agent.name}"? This will also delete all their request logs.`)) return;
    await api.deleteAgent(agent.id);
    load();
  };

  const handleRotate = async (agent) => {
    if (!confirm(`Rotate token for "${agent.name}"? The old token will stop working immediately.`)) return;
    const result = await api.rotateToken(agent.id);
    setRotatedToken({ name: agent.name, token: result.token });
  };

  return (
    <div className="page">
      <h2>Agents</h2>

      <form onSubmit={handleCreate} className="inline-form">
        <input type="text" placeholder="Agent name" value={name}
          onChange={(e) => setName(e.target.value)} required />
        <button type="submit">Create Agent</button>
      </form>

      {createdToken && (
        <div className="token-display success">
          <strong>Agent &quot;{createdToken.name}&quot; created.</strong> Token (shown only once):
          <code>{createdToken.token}</code>
          <button onClick={() => setCreatedToken(null)}>Dismiss</button>
        </div>
      )}

      {rotatedToken && (
        <div className="token-display success">
          <strong>Token rotated for &quot;{rotatedToken.name}&quot;.</strong> New token (shown only once):
          <code>{rotatedToken.token}</code>
          <button onClick={() => setRotatedToken(null)}>Dismiss</button>
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Requests</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map(a => (
            <tr key={a.id} className={a.enabled ? '' : 'disabled'}>
              <td>{a.name}</td>
              <td>{a.request_count}</td>
              <td>{a.enabled ? 'Active' : 'Disabled'}</td>
              <td>{new Date(a.created_at).toLocaleDateString()}</td>
              <td>
                <button onClick={() => handleToggle(a)}>
                  {a.enabled ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => handleRotate(a)}>Rotate Token</button>
                <button onClick={() => handleDelete(a)} className="danger">Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
