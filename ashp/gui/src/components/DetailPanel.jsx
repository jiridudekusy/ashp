import { useState, useEffect } from 'react';
import { Badge } from './Badge.jsx';
import { JsonViewer } from './JsonViewer.jsx';
import styles from './DetailPanel.module.css';

export function DetailPanel({ entry, api, onCreateRule, children }) {
  const [tab, setTab] = useState('info');
  const [requestBody, setRequestBody] = useState(null);
  const [responseBody, setResponseBody] = useState(null);

  useEffect(() => { setTab('info'); setRequestBody(null); setResponseBody(null); }, [entry?.id]);

  useEffect(() => {
    if (!entry || !api) return;
    if (tab === 'request' && requestBody === null) {
      api.getRequestBody?.(entry.id)?.then(setRequestBody).catch(() => setRequestBody(''));
    }
    if (tab === 'response' && responseBody === null) {
      api.getResponseBody?.(entry.id)?.then(setResponseBody).catch(() => setResponseBody(''));
    }
  }, [tab, entry, api, requestBody, responseBody]);

  if (!entry) return <div className={styles.empty}>Select an entry to view details</div>;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.headerTitle}>{entry.method} {entry.url}</span>
          <Badge variant={entry.decision}>{entry.decision}</Badge>
        </div>
        <div className={styles.headerMeta}>
          {entry.timestamp && new Date(entry.timestamp).toLocaleString()}
          {entry.status_code ? ` · ${entry.status_code}` : ''}
          {entry.duration_ms ? ` · ${entry.duration_ms}ms` : ''}
        </div>
      </div>
      <div className={styles.tabs}>
        <button className={tab === 'info' ? styles.tabActive : styles.tab} onClick={() => setTab('info')}>Info</button>
        <button className={tab === 'request' ? styles.tabActive : styles.tab} onClick={() => setTab('request')}>Request Body</button>
        <button className={tab === 'response' ? styles.tabActive : styles.tab} onClick={() => setTab('response')}>Response Body</button>
      </div>
      <div className={styles.content}>
        {tab === 'info' && (
          <div className={styles.fields}>
            <div className={styles.field}><span className={styles.fieldLabel}>URL</span><span className={styles.fieldValue}>{entry.url}</span></div>
            <div className={styles.field}><span className={styles.fieldLabel}>Method</span><span className={styles.fieldValue}>{entry.method}</span></div>
            {entry.matched_rule && <div className={styles.field}><span className={styles.fieldLabel}>Matched Rule</span><span className={styles.fieldValue}>{entry.matched_rule}</span></div>}
            {entry.reason && <div className={styles.field}><span className={styles.fieldLabel}>Reason</span><span className={styles.fieldValue}>{entry.reason}</span></div>}
          </div>
        )}
        {tab === 'request' && <JsonViewer text={requestBody} />}
        {tab === 'response' && <JsonViewer text={responseBody} />}
      </div>
      {children}
      {onCreateRule && (
        <div className={styles.footer}>
          <button className={styles.createRuleBtn} onClick={() => onCreateRule(entry)}>
            Create Rule from Request
          </button>
        </div>
      )}
    </div>
  );
}
