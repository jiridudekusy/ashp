/**
 * @file Detail panel for a selected policy.
 *
 * Shows the policy name, description, action bar (add rule, edit, delete),
 * a rules table with edit/move/delete buttons, and an agent assignments
 * section with chips and an assign dropdown.
 */
import { useState } from 'react';
import { Badge } from './Badge.jsx';
import styles from './PolicyDetail.module.css';

/**
 * @param {Object} props
 * @param {Object|null} props.policy - Full policy detail object
 * @param {Array} props.rules - Rules belonging to this policy, sorted by priority desc
 * @param {boolean} props.readOnly - If true, hide mutation buttons
 * @param {Function} props.onAddRule - Called when "+ Rule" is clicked
 * @param {Function} props.onEditRule - Called with rule object to edit
 * @param {Function} props.onDeleteRule - Called with rule id to delete
 * @param {Function} props.onMoveRule - Called with rule object to move
 * @param {Function} props.onEditPolicy - Called to edit this policy
 * @param {Function} props.onDeletePolicy - Called to delete this policy
 * @param {Function} props.onAssignAgent - Called with agent id to assign
 * @param {Function} props.onUnassignAgent - Called with agent id to unassign
 * @param {Array} props.agents - All agents for the assign dropdown
 */
export default function PolicyDetail({
  policy, rules, readOnly, onAddRule, onEditRule, onDeleteRule,
  onMoveRule, onEditPolicy, onDeletePolicy, onAssignAgent, onUnassignAgent, agents,
}) {
  const [assigning, setAssigning] = useState(false);

  if (!policy) return <div className={styles.empty}>Loading...</div>;

  const assignedIds = new Set((policy.agents || []).map(a => a.id));
  const unassignedAgents = agents.filter(a => !assignedIds.has(a.id));

  return (
    <div className={styles.detail}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.title}>{policy.name}</h2>
          <span className={styles.count}>{rules.length} rule{rules.length !== 1 ? 's' : ''}</span>
        </div>
        <div className={styles.actions}>
          {!readOnly && (
            <>
              <button className={styles.actionBtn} onClick={onAddRule}>+ Rule</button>
              <button className={styles.secondaryBtn} onClick={onEditPolicy}>Edit Policy</button>
              <button className={styles.dangerBtn} onClick={onDeletePolicy}>Delete Policy</button>
            </>
          )}
        </div>
      </div>

      {policy.description && (
        <div className={styles.description}>{policy.description}</div>
      )}

      {rules.length === 0 ? (
        <div className={styles.empty}>No rules in this policy</div>
      ) : (
        <div className={styles.table}>
          <div className={styles.tableHeader}>
            <span>Name</span><span>Pattern</span><span>Methods</span><span>Action</span><span>Priority</span><span></span>
          </div>
          {rules.map(r => (
            <div key={r.id} className={r.enabled ? styles.tableRow : styles.tableRowDisabled}>
              <span className={styles.cellName} title={r.name}>{r.name}</span>
              <span className={styles.cellPattern} title={r.url_pattern}>{r.url_pattern}</span>
              <span>{r.methods.length ? r.methods.join(', ') : '*'}</span>
              <span><Badge variant={r.action}>{r.action}</Badge></span>
              <span>{r.priority}</span>
              <span className={styles.cellActions}>
                {!readOnly && (
                  <>
                    <button className={styles.editLink} onClick={() => onEditRule(r)}>Edit</button>
                    <button className={styles.editLink} onClick={() => onMoveRule(r)}>Move</button>
                    <button className={styles.deleteLink} onClick={() => onDeleteRule(r.id)}>Delete</button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>ASSIGNED TO AGENTS</div>
        <div className={styles.agentChips}>
          {(policy.agents || []).map(a => (
            <span key={a.id} className={styles.agentChip}>
              {a.name}
              {!readOnly && (
                <button className={styles.chipRemove} onClick={() => onUnassignAgent(a.id)} title="Unassign">&times;</button>
              )}
            </span>
          ))}
          {!readOnly && !assigning && unassignedAgents.length > 0 && (
            <button className={styles.assignBtn} onClick={() => setAssigning(true)}>+ Assign</button>
          )}
          {!readOnly && assigning && (
            <select
              className={styles.assignSelect}
              autoFocus
              defaultValue=""
              onChange={e => {
                const val = e.target.value;
                if (val) {
                  onAssignAgent(Number(val));
                }
                setAssigning(false);
              }}
              onBlur={e => {
                // Only close if no value was selected (blur without change)
                if (!e.target.value) setAssigning(false);
              }}
            >
              <option value="" disabled>Select agent...</option>
              {unassignedAgents.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          )}
          {(policy.agents || []).length === 0 && !assigning && (
            <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>No agents assigned</span>
          )}
        </div>
      </div>
    </div>
  );
}
