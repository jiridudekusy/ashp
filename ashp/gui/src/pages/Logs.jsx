/**
 * @file Request log browser with split-pane layout.
 *
 * Left pane: filterable log list (decision, method, URL, agent_id) with pagination.
 * Right pane: DetailPanel showing full request/response details with decrypted bodies.
 *
 * Supports deep linking via ?id= query param (e.g., from Dashboard feed clicks).
 * SSE events trigger a "new entries available" banner instead of auto-refreshing,
 * to avoid disrupting the user's current scroll position or selection.
 *
 * The SmartRuleBuilder modal can be opened from a log entry to create a rule
 * matching that request's URL pattern.
 */
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '../components/Badge';
import { SegmentedControl } from '../components/SegmentedControl';
import { DetailPanel } from '../components/DetailPanel';
import { SmartRuleBuilder } from '../components/SmartRuleBuilder';
import { SplitPane } from '../components/SplitPane';
import styles from './Logs.module.css';

const DECISION_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'allowed', label: 'Allow' },
  { value: 'denied', label: 'Deny' },
  { value: 'held', label: 'Hold' },
];

const METHOD_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'DELETE', label: 'DEL' },
];

function formatTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

export default function Logs({ api, events }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [logs, setLogs] = useState([]);
  const [filters, setFilters] = useState({ limit: 50, offset: 0 });
  const [agentId, setAgentId] = useState('');
  const [selected, setSelected] = useState(null);
  const [ruleEntry, setRuleEntry] = useState(null);
  const [hasNewEntries, setHasNewEntries] = useState(false);

  const fetchLogs = useCallback(() => {
    const params = { ...filters };
    if (agentId) params.agent_id = agentId;
    api.getLogs(params).then(setLogs);
  }, [api, filters, agentId]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  // On mount, check for ?id= query param
  useEffect(() => {
    const id = searchParams.get('id');
    if (id && api) {
      api.getLog(id).then(entry => {
        if (entry) setSelected(entry);
      }).catch(() => {});
    }
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // SSE subscription for new entries banner
  useEffect(() => {
    if (!events) return;
    const handler = (type) => {
      if (type === 'request.allowed' || type === 'request.blocked') {
        setHasNewEntries(true);
      }
    };
    events.subscribe(handler);
    return () => events.unsubscribe(handler);
  }, [events]);

  function updateFilter(key, value) {
    setFilters(f => ({ ...f, offset: 0, [key]: value || undefined }));
  }

  function handleRefreshBanner() {
    setFilters(f => ({ ...f, offset: 0 }));
    setHasNewEntries(false);
  }

  function handleSelect(entry) {
    setSelected(entry);
    setSearchParams(entry ? { id: entry.id } : {}, { replace: true });
  }

  async function handleCreateRule(rule) {
    await api.createRule(rule);
    setRuleEntry(null);
  }

  const start = filters.offset + 1;
  const end = filters.offset + logs.length;

  const listPane = (
    <>
      <div className={styles.filters}>
        <SegmentedControl
          options={DECISION_OPTIONS}
          value={filters.decision || ''}
          onChange={v => updateFilter('decision', v)}
        />
        <SegmentedControl
          options={METHOD_OPTIONS}
          value={filters.method || ''}
          onChange={v => updateFilter('method', v)}
        />
        <input
          className={styles.urlFilter}
          type="text"
          placeholder="Filter by URL..."
          onChange={e => updateFilter('url', e.target.value)}
        />
        <input
          className={styles.urlFilter}
          type="text"
          placeholder="Agent ID"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        />
      </div>

      {hasNewEntries && (
        <div className={styles.newBanner} onClick={handleRefreshBanner}>
          New entries available — click to refresh
        </div>
      )}

      <div className={styles.rows}>
        {logs.length === 0 ? (
          <div className={styles.empty}>No log entries yet</div>
        ) : (
          logs.map(log => (
            <div
              key={log.id}
              className={selected?.id === log.id ? styles.logRowSelected : styles.logRow}
              onClick={() => handleSelect(log)}
            >
              <Badge variant={log.decision} />
              <span className={styles.logMethod}>{log.method}</span>
              <span className={styles.logUrl} title={log.url}>{log.url}</span>
              {log.mode && log.mode !== 'proxy' && (
                <span className={styles.logMode}>{log.mode}</span>
              )}
              <span className={styles.logTime}>{formatTime(log.timestamp)}</span>
            </div>
          ))
        )}
      </div>

      <div className={styles.pagination}>
        <span className={styles.paginationInfo}>
          {logs.length > 0 ? `${start}-${end}` : '0'} entries
        </span>
        <div className={styles.paginationBtns}>
          <button
            className={styles.paginationBtn}
            disabled={filters.offset === 0}
            onClick={() => setFilters(f => ({ ...f, offset: f.offset - f.limit }))}
          >
            Prev
          </button>
          <button
            className={styles.paginationBtn}
            disabled={logs.length < filters.limit}
            onClick={() => setFilters(f => ({ ...f, offset: f.offset + f.limit }))}
          >
            Next
          </button>
        </div>
      </div>
    </>
  );

  const detailPane = (
    <DetailPanel
      entry={selected}
      api={api}
      onCreateRule={entry => setRuleEntry(entry)}
    />
  );

  return (
    <div className={styles.page}>
      <SplitPane
        left={listPane}
        right={detailPane}
        storageId="logs"
        defaultWidth={380}
        minWidth={250}
        maxWidth={1200}
      />
      <SmartRuleBuilder
        open={!!ruleEntry}
        onClose={() => setRuleEntry(null)}
        onSubmit={handleCreateRule}
        entry={ruleEntry}
      />
    </div>
  );
}
