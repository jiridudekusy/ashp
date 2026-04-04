/**
 * @file Modal form for creating/editing proxy rules.
 *
 * Fields: name, url_pattern (regex), methods (checkbox multi-select), action
 * (allow/deny), priority, body logging config, and enabled toggle. Resets to EMPTY defaults on open for new rules,
 * or populates from the existing rule object for edits.
 */
import { useState, useEffect } from 'react';
import { Modal } from './Modal.jsx';
import styles from './RuleForm.module.css';

/** Default values for a new rule form. */
const EMPTY = { name: '', url_pattern: '', methods: [], action: 'allow', priority: 0, enabled: true,
  log_request_body: 'full', log_response_body: 'full', default_behavior: '', policy_id: null };

/**
 * @param {Object} props
 * @param {boolean} props.open - Whether the modal is visible
 * @param {Object|null} props.rule - Existing rule to edit, or null for create
 * @param {Function} props.onSave - Called with the form data object
 * @param {Function} props.onCancel - Called when the modal is dismissed
 */
export default function RuleForm({ open, rule, onSave, onCancel }) {
  const [form, setForm] = useState(rule || EMPTY);
  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  useEffect(() => {
    if (open) setForm(rule || EMPTY);
  }, [open, rule]);

  return (
    <Modal open={open} onClose={onCancel} title={rule ? 'Edit Rule' : 'Add Rule'}>
      <form className={styles.form} onSubmit={e => { e.preventDefault(); onSave(form); }}>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>Name</label>
          <input className={styles.input} value={form.name} onChange={e => set('name', e.target.value)} required />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>URL Pattern</label>
          <input className={styles.input} value={form.url_pattern} onChange={e => set('url_pattern', e.target.value)} required />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>Methods</label>
          <div className={styles.methodsGrid}>
            <label className={styles.methodCheckbox}>
              <input type="checkbox" checked={form.methods.length === 0}
                onChange={() => set('methods', [])} />
              ALL
            </label>
            {['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].map(m => (
              <label key={m} className={styles.methodCheckbox}>
                <input type="checkbox" checked={form.methods.includes(m)}
                  onChange={e => set('methods', e.target.checked ? [...form.methods, m] : form.methods.filter(x => x !== m))} />
                {m}
              </label>
            ))}
          </div>
          <span className={styles.hint}>{form.methods.length === 0 ? 'All methods' : `${form.methods.length} selected`}</span>
        </div>
        <div className={styles.row}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>Action</label>
            <select className={styles.select} value={form.action} onChange={e => set('action', e.target.value)}>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
            </select>
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>Priority</label>
            <input className={styles.input} type="number" value={form.priority} onChange={e => set('priority', +e.target.value)} />
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>Log Request Body</label>
            <select className={styles.select} value={form.log_request_body} onChange={e => set('log_request_body', e.target.value)}>
              <option value="full">Full</option><option value="none">None</option>
              <option value="truncate:65536">Truncate (64K)</option>
            </select>
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>Log Response Body</label>
            <select className={styles.select} value={form.log_response_body} onChange={e => set('log_response_body', e.target.value)}>
              <option value="full">Full</option><option value="none">None</option>
              <option value="truncate:65536">Truncate (64K)</option>
            </select>
          </div>
        </div>

        <label className={styles.toggle}>
          <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} /> Enabled
        </label>
        <div className={styles.actions}>
          <button className={styles.submitBtn} type="submit">Save</button>
          {onCancel && <button className={styles.cancelBtn} type="button" onClick={onCancel}>Cancel</button>}
        </div>
      </form>
    </Modal>
  );
}
