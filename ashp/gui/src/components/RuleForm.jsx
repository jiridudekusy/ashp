import { useState, useEffect } from 'react';
import { Modal } from './Modal.jsx';
import styles from './RuleForm.module.css';

const EMPTY = { name: '', url_pattern: '', methods: [], action: 'allow', priority: 0, enabled: true,
  log_request_body: 'full', log_response_body: 'full', default_behavior: '' };

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
          <label className={styles.label}>Methods (comma-sep)</label>
          <input className={styles.input} value={form.methods.join(',')}
            onChange={e => set('methods', e.target.value ? e.target.value.split(',').map(s => s.trim()) : [])} />
        </div>
        <div className={styles.row}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>Action</label>
            <select className={styles.select} value={form.action} onChange={e => set('action', e.target.value)}>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
              <option value="hold">Hold</option>
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
        <div className={styles.fieldGroup}>
          <label className={styles.label}>Default Behavior Override</label>
          <select className={styles.select} value={form.default_behavior || ''} onChange={e => set('default_behavior', e.target.value || null)}>
            <option value="">(inherit global)</option>
            <option value="deny">Deny</option><option value="hold">Hold</option><option value="queue">Queue</option>
          </select>
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
