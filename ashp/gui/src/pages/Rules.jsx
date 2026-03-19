import { useState, useEffect } from 'react';
import RuleForm from '../components/RuleForm';
import { Badge } from '../components/Badge';
import styles from './Rules.module.css';

export default function Rules({ api }) {
  const [rules, setRules] = useState([]);
  const [editing, setEditing] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    api.getRules().then(setRules);
    api.getStatus().then(s => {
      if (s && s.rules_source === 'file') setReadOnly(true);
    });
  }, [api]);

  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

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

  function testResultClass(result) {
    if (!result) return '';
    const action = result.action || result.decision || '';
    if (action === 'allow') return styles.testResultAllow;
    if (action === 'deny') return styles.testResultDeny;
    if (action === 'hold') return styles.testResultHold;
    return styles.testResult;
  }

  return (
    <div>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.title}>Rules</h2>
          <span className={styles.count}>{rules.length} rule{rules.length !== 1 ? 's' : ''}</span>
        </div>
        <div className={styles.headerRight}>
          <form className={styles.testerGroup} onSubmit={handleTest}>
            <input className={styles.testerInput} name="url" placeholder="https://example.com/path" required />
            <select className={styles.testerMethod} name="method" defaultValue="GET">
              <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option><option>PATCH</option>
            </select>
            <button className={styles.testerBtn} type="submit">Test</button>
          </form>
          {!readOnly && (
            <button className={styles.addBtn} onClick={() => setEditing('new')}>+ Add Rule</button>
          )}
        </div>
      </div>

      {readOnly && (
        <div className={styles.readOnlyBanner}>
          Rules are loaded from a file and cannot be edited through the UI.
        </div>
      )}

      {testResult && (
        <div className={testResultClass(testResult)}>
          Result: <Badge variant={testResult.action || testResult.decision}>{testResult.action || testResult.decision}</Badge>
          {testResult.rule_name && <span> — matched rule: {testResult.rule_name}</span>}
        </div>
      )}

      <RuleForm
        open={!!editing}
        rule={editing && editing !== 'new' ? editing : null}
        onSave={handleSave}
        onCancel={() => setEditing(null)}
      />

      {rules.length === 0 ? (
        <div className={styles.empty}>No rules configured yet</div>
      ) : (
        <div className={styles.table}>
          <div className={styles.tableHeader}>
            <span>Name</span><span>Pattern</span><span>Methods</span><span>Action</span><span>Priority</span><span>On</span><span>Hits (Total)</span><span>Hits (Today)</span><span></span>
          </div>
          {sorted.map(r => (
            <div key={r.id} className={r.enabled ? styles.tableRow : styles.tableRowDisabled}>
              <span>{r.name}</span>
              <span className={styles.cellPattern}>{r.url_pattern}</span>
              <span>{r.methods.length ? r.methods.join(', ') : '*'}</span>
              <span><Badge variant={r.action}>{r.action}</Badge></span>
              <span>{r.priority}</span>
              <span><span className={r.enabled ? styles.dotGreen : styles.dotGrey} /></span>
              <span>{r.hit_count}</span>
              <span>{r.hit_count_today}{r.hit_count_date && r.hit_count_date !== new Date().toISOString().slice(0, 10) ? ` (${r.hit_count_date})` : ''}</span>
              <span className={styles.cellActions}>
                {!readOnly && (
                  <>
                    <button className={styles.editLink} onClick={() => setEditing(r)}>Edit</button>
                    <button className={styles.deleteLink} onClick={() => handleDelete(r.id)}>Delete</button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
