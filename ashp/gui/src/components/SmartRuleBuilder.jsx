/**
 * @file Smart rule builder — generates URL pattern suggestions from a request URL.
 *
 * Given a URL like "api.example.com/v1/users/123", generates patterns at
 * increasing scope: exact match, path prefix, API prefix, domain wildcard.
 * The user selects a pattern scope, method filter, and action, then creates
 * a rule with one click. Opened from the Logs page or Approvals page.
 */
import { useState, useEffect } from 'react';
import { Modal } from './Modal.jsx';
import styles from './SmartRuleBuilder.module.css';

/**
 * Generates URL pattern suggestions at increasing specificity levels.
 * Strips the protocol, then creates patterns from exact → domain wildcard.
 *
 * Example for "api.example.com/v1/users/123":
 *   - exact:  "api.example.com/v1/users/123"
 *   - path:   "api.example.com/v1/users/*"
 *   - api:    "api.example.com/v1/*"
 *   - domain: "api.example.com/*"
 *
 * @param {string} url - The full request URL
 * @returns {Array<{pattern: string, label: string}>} Pattern options
 */
export function generatePatterns(url) {
  if (!url) return [];
  const clean = url.replace(/^https?:\/\//, '');
  const slashIdx = clean.indexOf('/');
  if (slashIdx === -1) {
    return [
      { pattern: clean, label: 'exact' },
      { pattern: clean + '/*', label: 'domain' },
    ];
  }
  const domain = clean.slice(0, slashIdx);
  const pathParts = clean.slice(slashIdx + 1).split('/').filter(Boolean);
  const patterns = [{ pattern: clean, label: 'exact' }];
  for (let i = pathParts.length - 1; i > 0; i--) {
    const partial = domain + '/' + pathParts.slice(0, i).join('/') + '/*';
    const label = i === pathParts.length - 1 ? 'path' : i === 1 ? 'api' : `level-${i}`;
    patterns.push({ pattern: partial, label });
  }
  patterns.push({ pattern: domain + '/*', label: 'domain' });
  return patterns;
}

export function SmartRuleBuilder({ open, onClose, onSubmit, entry }) {
  const [selectedPattern, setSelectedPattern] = useState('');
  const [method, setMethod] = useState('');
  const [action, setAction] = useState('allow');

  const patterns = entry ? generatePatterns(entry.url) : [];

  useEffect(() => {
    if (entry) {
      setSelectedPattern(patterns[0]?.pattern || '');
      setMethod(entry.method || 'ALL');
      setAction('allow');
    }
  }, [entry?.url]);

  const handleSubmit = () => {
    onSubmit({
      url_pattern: selectedPattern,
      methods: method === 'ALL' ? [] : [method],
      action,
      name: `Rule for ${selectedPattern}`,
      enabled: true,
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Create Rule from Request">
      {entry && (
        <div className={styles.source}>
          {entry.method} {entry.url} → <span className={styles[entry.decision]}>{entry.decision}</span>
        </div>
      )}
      <div className={styles.section}>
        <div className={styles.label}>Pattern scope</div>
        <div className={styles.patterns}>
          {patterns.map(p => (
            <button
              key={p.pattern}
              className={selectedPattern === p.pattern ? styles.patternActive : styles.pattern}
              onClick={() => setSelectedPattern(p.pattern)}
            >
              <span className={styles.patternText}>{p.pattern}</span>
              <span className={styles.patternLabel}>{p.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.row}>
        <div className={styles.fieldGroup}>
          <div className={styles.label}>Method</div>
          <select className={styles.select} value={method} onChange={e => setMethod(e.target.value)}>
            <option value={entry?.method}>{entry?.method}</option>
            <option value="ALL">ALL</option>
          </select>
        </div>
        <div className={styles.fieldGroup}>
          <div className={styles.label}>Action</div>
          <select className={styles.select} value={action} onChange={e => setAction(e.target.value)}>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.submitBtn} onClick={handleSubmit}>Create Rule</button>
        <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
