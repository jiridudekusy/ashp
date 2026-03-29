/**
 * @file Modal for moving a rule to a different policy.
 *
 * Shows the rule being moved, a dropdown of available policies
 * (including "No policy" to unassign), and Move/Cancel buttons.
 */
import { useState, useEffect } from 'react';
import { Modal } from './Modal.jsx';
import styles from './MoveRuleModal.module.css';

/**
 * Flatten a policy tree into a list with indented names.
 * @param {Array} policies - Tree-structured policy array
 * @param {number} level - Current nesting depth
 * @returns {Array<{id: number, label: string}>}
 */
function flattenPolicies(policies, level = 0) {
  const result = [];
  for (const p of policies) {
    result.push({ id: p.id, label: '\u00A0\u00A0'.repeat(level) + p.name });
    if (p.children && p.children.length > 0) {
      result.push(...flattenPolicies(p.children, level + 1));
    }
  }
  return result;
}

/**
 * @param {Object} props
 * @param {boolean} props.open - Whether the modal is visible
 * @param {Object|null} props.rule - The rule being moved
 * @param {Array} props.policies - Full policy tree
 * @param {Function} props.onMove - Called with (ruleId, policyId) where policyId may be null
 * @param {Function} props.onCancel - Called when the modal is dismissed
 */
export default function MoveRuleModal({ open, rule, policies, onMove, onCancel }) {
  const [targetPolicyId, setTargetPolicyId] = useState('');

  useEffect(() => {
    if (open && rule) {
      setTargetPolicyId(rule.policy_id != null ? String(rule.policy_id) : '');
    }
  }, [open, rule]);

  const flat = flattenPolicies(policies);

  function handleSubmit(e) {
    e.preventDefault();
    const policyId = targetPolicyId === '' ? null : Number(targetPolicyId);
    onMove(rule.id, policyId);
  }

  return (
    <Modal open={open} onClose={onCancel} title="Move Rule">
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.ruleInfo}>
          Moving rule: <span className={styles.ruleName}>{rule?.name}</span>
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>Target Policy</label>
          <select
            className={styles.select}
            value={targetPolicyId}
            onChange={e => setTargetPolicyId(e.target.value)}
          >
            <option value="">No policy</option>
            {flat.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className={styles.actions}>
          <button className={styles.submitBtn} type="submit">Move</button>
          <button className={styles.cancelBtn} type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
