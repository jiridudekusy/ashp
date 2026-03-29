/**
 * @file Modal form for creating/editing policies.
 *
 * Fields: name (required), description (optional).
 * Resets to empty defaults on open for new policies,
 * or populates from the existing policy object for edits.
 */
import { useState, useEffect } from 'react';
import { Modal } from './Modal.jsx';
import styles from './PolicyForm.module.css';

/** Default values for a new policy form. */
const EMPTY = { name: '', description: '' };

/**
 * @param {Object} props
 * @param {boolean} props.open - Whether the modal is visible
 * @param {Object|null} props.policy - Existing policy to edit, or null for create
 * @param {Function} props.onSave - Called with the form data object
 * @param {Function} props.onCancel - Called when the modal is dismissed
 */
export default function PolicyForm({ open, policy, onSave, onCancel }) {
  const [form, setForm] = useState(EMPTY);
  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  useEffect(() => {
    if (open) {
      setForm(policy ? { name: policy.name, description: policy.description || '' } : EMPTY);
    }
  }, [open, policy]);

  return (
    <Modal open={open} onClose={onCancel} title={policy ? 'Edit Policy' : 'Add Policy'}>
      <form className={styles.form} onSubmit={e => { e.preventDefault(); onSave(form); }}>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>Name</label>
          <input className={styles.input} value={form.name} onChange={e => set('name', e.target.value)} required />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>Description</label>
          <textarea className={styles.textarea} value={form.description} onChange={e => set('description', e.target.value)} rows={3} />
        </div>
        <div className={styles.actions}>
          <button className={styles.submitBtn} type="submit">Save</button>
          {onCancel && <button className={styles.cancelBtn} type="button" onClick={onCancel}>Cancel</button>}
        </div>
      </form>
    </Modal>
  );
}
