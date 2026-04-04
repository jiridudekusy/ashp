/**
 * @file Agent management page — CRUD for proxy agent credentials.
 *
 * Agents authenticate to the ASHP proxy via Proxy-Authorization Basic header.
 * Tokens are 32-byte random hex strings, hashed with bcrypt server-side.
 * The plaintext token is only shown once: immediately after creation or rotation.
 *
 * Token banners (createdToken, rotatedToken) persist until manually dismissed,
 * giving the user time to copy the credential. Deleting an agent cascades to
 * all their request logs and approval queue entries.
 *
 * Each agent row displays its assigned policies as chips. Clicking "+ Assign"
 * opens an inline dropdown to assign an additional policy; clicking × on a chip
 * unassigns that policy from the agent.
 */
import { useState, useEffect, useCallback } from 'react';
import { Modal } from '../components/Modal';
import styles from './Agents.module.css';

/**
 * @param {Object} props
 * @param {Object} props.api - API client from createClient()
 */
export default function Agents({ api }) {
  const [agents, setAgents] = useState([]);
  const [policies, setPolicies] = useState([]);
  /** Map of agent_id → array of policy objects assigned to that agent */
  const [agentPolicies, setAgentPolicies] = useState({});
  /** agent_id → boolean: whether the assign dropdown is open */
  const [assignOpen, setAssignOpen] = useState({});
  const [editing, setEditing] = useState(null); // null | 'new' | agent object
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [createdToken, setCreatedToken] = useState(null);
  const [rotatedToken, setRotatedToken] = useState(null);

  const buildAgentPoliciesMap = useCallback((agentList, policyList) => {
    const map = {};
    agentList.forEach(a => { map[a.id] = []; });
    policyList.forEach(p => {
      const ids = p.agent_ids || p.agents || [];
      ids.forEach(agentId => {
        if (map[agentId]) map[agentId].push(p);
      });
    });
    setAgentPolicies(map);
  }, []);

  const load = useCallback(async () => {
    const [agentList, policyList] = await Promise.all([api.getAgents(), api.getPolicies()]);
    setAgents(agentList);
    setPolicies(policyList);
    buildAgentPoliciesMap(agentList, policyList);
  }, [api, buildAgentPoliciesMap]);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setName('');
    setDescription('');
    setEditing('new');
  }

  function openEdit(agent) {
    setName(agent.name);
    setDescription(agent.description || '');
    setEditing(agent);
  }

  function closeModal() {
    setEditing(null);
  }

  const handleSave = async (e) => {
    e.preventDefault();
    if (editing === 'new') {
      const agent = await api.createAgent({ name, description });
      setCreatedToken({ name: agent.name, token: agent.token });
    } else {
      await api.updateAgent(editing.id, { name, description });
    }
    closeModal();
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

  const handleClearIP = async (agent) => {
    if (!confirm(`Clear IP address for agent "${agent.name}"? The agent will no longer be authenticated by IP.`)) return;
    await api.updateAgent(agent.id, { ip_address: null });
    load();
  };

  const handleAssignPolicy = async (agentId, policyId) => {
    if (!policyId) return;
    await api.assignPolicyAgent(policyId, agentId);
    setAssignOpen(prev => ({ ...prev, [agentId]: false }));
    load();
  };

  const handleUnassignPolicy = async (agentId, policyId) => {
    await api.unassignPolicyAgent(policyId, agentId);
    load();
  };

  const toggleAssignDropdown = (agentId) => {
    setAssignOpen(prev => ({ ...prev, [agentId]: !prev[agentId] }));
  };

  return (
    <div>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.title}>Agents</h2>
          <span className={styles.count}>{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
        </div>
        <button className={styles.addBtn} onClick={openCreate}>+ Create Agent</button>
      </div>

      <Modal open={!!editing} onClose={closeModal} title={editing === 'new' ? 'Create Agent' : 'Edit Agent'}>
        <form className={styles.form} onSubmit={handleSave}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>Name</label>
            <input className={styles.input} value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. claude-code-agent" required autoFocus />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>Description</label>
            <input className={styles.input} value={description} onChange={e => setDescription(e.target.value)}
              placeholder="What this agent is used for" />
          </div>
          {editing !== 'new' && editing?.ip_address && (
            <div className={styles.fieldGroup}>
              <label className={styles.label}>IP Address</label>
              <div className={styles.ipReadonly}>
                <code>{editing.ip_address}</code>
                <button type="button" className={styles.clearIpBtn} onClick={() => { handleClearIP(editing); closeModal(); }}>Clear</button>
              </div>
            </div>
          )}
          <div className={styles.formActions}>
            <button className={styles.cancelBtn} type="button" onClick={closeModal}>Cancel</button>
            <button className={styles.submitBtn} type="submit">{editing === 'new' ? 'Create' : 'Save'}</button>
          </div>
        </form>
      </Modal>

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
            <span>Name</span><span>Description</span><span>Requests</span><span>Status</span><span>Created</span><span>IP Address</span><span>Policies</span><span></span>
          </div>
          {agents.map(a => {
            const assigned = agentPolicies[a.id] || [];
            const unassigned = policies.filter(p => !assigned.some(ap => ap.id === p.id));
            return (
              <div key={a.id} className={a.enabled ? styles.tableRow : styles.tableRowDisabled}>
                <span>{a.name}</span>
                <span className={styles.cellDesc}>{a.description}</span>
                <span>{a.request_count}</span>
                <span>
                  <span className={a.enabled ? styles.dotGreen : styles.dotGrey} />
                  {a.enabled ? 'Active' : 'Disabled'}
                </span>
                <span>{new Date(a.created_at).toLocaleDateString()}</span>
                {/* IP Address column */}
                <span className={styles.cellIp}>
                  {a.ip_address ? (
                    <>
                      <code className={styles.ipCode}>{a.ip_address}</code>
                      <button
                        className={styles.clearIpBtn}
                        onClick={() => handleClearIP(a)}
                        title="Clear IP address"
                      >
                        Clear
                      </button>
                    </>
                  ) : (
                    <span className={styles.ipEmpty}>—</span>
                  )}
                </span>
                {/* Policies column */}
                <span className={styles.cellPolicies}>
                  {assigned.map(p => (
                    <span key={p.id} className={styles.policyChip}>
                      {p.name}
                      <button
                        className={styles.policyChipRemove}
                        onClick={() => handleUnassignPolicy(a.id, p.id)}
                        title={`Unassign policy "${p.name}"`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <span className={styles.assignWrapper}>
                    <button
                      className={styles.assignBtn}
                      onClick={() => toggleAssignDropdown(a.id)}
                    >
                      + Assign
                    </button>
                    {assignOpen[a.id] && (
                      <span className={styles.assignDropdown}>
                        {unassigned.length === 0 ? (
                          <span className={styles.assignEmpty}>All policies assigned</span>
                        ) : (
                          unassigned.map(p => (
                            <button
                              key={p.id}
                              className={styles.assignOption}
                              onClick={() => handleAssignPolicy(a.id, p.id)}
                            >
                              {p.name}
                            </button>
                          ))
                        )}
                        <button
                          className={styles.assignClose}
                          onClick={() => setAssignOpen(prev => ({ ...prev, [a.id]: false }))}
                        >
                          Cancel
                        </button>
                      </span>
                    )}
                  </span>
                </span>
                <span className={styles.cellActions}>
                  <button className={styles.editLink} onClick={() => openEdit(a)}>Edit</button>
                  <button className={styles.toggleLink} onClick={() => handleToggle(a)}>
                    {a.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className={styles.rotateLink} onClick={() => handleRotate(a)}>Rotate</button>
                  <button className={styles.deleteLink} onClick={() => handleDelete(a)}>Delete</button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
