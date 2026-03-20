import { useState, useEffect, useCallback } from 'react';
import styles from './Agents.module.css';

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
    <div>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.title}>Agents</h2>
          <span className={styles.count}>{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
        </div>
        <form className={styles.createGroup} onSubmit={handleCreate}>
          <input className={styles.createInput} type="text" placeholder="Agent name" value={name}
            onChange={(e) => setName(e.target.value)} required />
          <button className={styles.createBtn} type="submit">+ Create</button>
        </form>
      </div>

      {createdToken && (
        <div className={styles.tokenBanner}>
          <strong>Agent "{createdToken.name}" created.</strong> Token (shown only once):
          <code className={styles.tokenCode}>{createdToken.token}</code>
          <button className={styles.dismissBtn} onClick={() => setCreatedToken(null)}>Dismiss</button>
        </div>
      )}

      {rotatedToken && (
        <div className={styles.tokenBanner}>
          <strong>Token rotated for "{rotatedToken.name}".</strong> New token (shown only once):
          <code className={styles.tokenCode}>{rotatedToken.token}</code>
          <button className={styles.dismissBtn} onClick={() => setRotatedToken(null)}>Dismiss</button>
        </div>
      )}

      {agents.length === 0 ? (
        <div className={styles.empty}>No agents configured yet</div>
      ) : (
        <div className={styles.table}>
          <div className={styles.tableHeader}>
            <span>Name</span><span>Requests</span><span>Status</span><span>Created</span><span></span>
          </div>
          {agents.map(a => (
            <div key={a.id} className={a.enabled ? styles.tableRow : styles.tableRowDisabled}>
              <span>{a.name}</span>
              <span>{a.request_count}</span>
              <span>
                <span className={a.enabled ? styles.dotGreen : styles.dotGrey} />
                {a.enabled ? 'Active' : 'Disabled'}
              </span>
              <span>{new Date(a.created_at).toLocaleDateString()}</span>
              <span className={styles.cellActions}>
                <button className={styles.toggleLink} onClick={() => handleToggle(a)}>
                  {a.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className={styles.rotateLink} onClick={() => handleRotate(a)}>Rotate</button>
                <button className={styles.deleteLink} onClick={() => handleDelete(a)}>Delete</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
