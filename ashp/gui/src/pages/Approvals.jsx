import { useState, useEffect, useCallback } from 'react';
import { Badge } from '../components/Badge';
import { DetailPanel } from '../components/DetailPanel';
import { SmartRuleBuilder } from '../components/SmartRuleBuilder';
import ApprovalCard from '../components/ApprovalCard';
import styles from './Approvals.module.css';

const DEFAULT_TIMEOUT = 30;

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function approvalToEntry(approval) {
  if (!approval) return null;
  return {
    id: approval.request_log_id,
    method: approval.method || 'POST',
    url: approval.suggested_pattern || approval.url || 'Unknown',
    decision: 'held',
    timestamp: approval.created_at,
    status_code: 0,
    duration_ms: 0,
  };
}

export default function Approvals({ api, events }) {
  const [approvals, setApprovals] = useState([]);
  const [resolved, setResolved] = useState([]);
  const [selected, setSelected] = useState(null);
  const [ruleEntry, setRuleEntry] = useState(null);
  const [, setTick] = useState(0);

  const load = useCallback(() => {
    api.getApprovals().then(setApprovals);
  }, [api]);

  useEffect(() => { load(); }, [load]);

  // Tick every second to update relative times and progress bars
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!events) return;
    const handler = (type, data) => {
      if (type === 'approval.needed') {
        load();
      }
      if (type === 'approval.resolved') {
        if (data) {
          setResolved(prev => [{ ...data, resolved_at: new Date().toISOString() }, ...prev].slice(0, 10));
        }
        load();
      }
    };
    events.subscribe(handler);
    return () => events.unsubscribe(handler);
  }, [events, load]);

  async function handleApprove(id) {
    await api.resolveApproval(id, { action: 'approve' });
    if (selected?.id === id) setSelected(null);
    load();
  }

  async function handleReject(id) {
    await api.resolveApproval(id, { action: 'reject' });
    if (selected?.id === id) setSelected(null);
    load();
  }

  async function handleApproveAndRule(approval) {
    await api.resolveApproval(approval.id, { action: 'approve' });
    setRuleEntry(approvalToEntry(approval));
    if (selected?.id === approval.id) setSelected(null);
    load();
  }

  async function handleCreateRule(rule) {
    await api.createRule(rule);
    setRuleEntry(null);
  }

  const entry = approvalToEntry(selected);
  const timeoutSeconds = DEFAULT_TIMEOUT;

  const countdownNode = selected ? (() => {
    const elapsed = (Date.now() - new Date(selected.created_at).getTime()) / 1000;
    const remaining = Math.max(0, Math.ceil(timeoutSeconds - elapsed));
    return (
      <div className={styles.timeout}>
        Timeout in {remaining}s
      </div>
    );
  })() : null;

  return (
    <div className={styles.page}>
      <div className={styles.list}>
        {/* Pending section */}
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Pending</span>
          <span className={styles.sectionCount}>{approvals.length}</span>
        </div>

        {approvals.length === 0 && (
          <div className={styles.empty}>No pending approvals.</div>
        )}

        {approvals.map(a => (
          <ApprovalCard
            key={a.id}
            approval={a}
            selected={selected?.id === a.id}
            onClick={() => setSelected(a)}
            timeoutSeconds={timeoutSeconds}
          />
        ))}

        {/* Recently Resolved section */}
        {resolved.length > 0 && (
          <>
            <div className={styles.resolvedHeader}>
              <span className={styles.resolvedTitle}>Recently Resolved</span>
            </div>
            {resolved.map((r, i) => (
              <div key={r.id || i} className={styles.resolvedRow}>
                <div className={styles.resolvedTop}>
                  <span className={styles.approvalUrl}>
                    {r.method || 'POST'} {r.suggested_pattern || r.url || 'Unknown'}
                  </span>
                  <Badge variant={r.action === 'approve' ? 'allowed' : 'denied'}>
                    {r.action === 'approve' ? 'approved' : 'rejected'}
                  </Badge>
                </div>
                <div className={styles.resolvedMeta}>
                  {formatRelativeTime(r.resolved_at)}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <div className={styles.detailSide}>
        <div className={styles.detailContent}>
          <DetailPanel entry={entry} api={api}>
            {countdownNode}
          </DetailPanel>
        </div>

        {selected && (
          <div className={styles.actionButtons}>
            <div className={styles.actionRow}>
              <button
                className={styles.approveBtn}
                onClick={() => handleApprove(selected.id)}
              >
                Approve
              </button>
              <button
                className={styles.rejectBtn}
                onClick={() => handleReject(selected.id)}
              >
                Reject
              </button>
            </div>
            <button
              className={styles.approveRuleBtn}
              onClick={() => handleApproveAndRule(selected)}
            >
              Approve + Create Rule
            </button>
          </div>
        )}
      </div>

      <SmartRuleBuilder
        open={!!ruleEntry}
        onClose={() => setRuleEntry(null)}
        onSubmit={handleCreateRule}
        entry={ruleEntry}
      />
    </div>
  );
}
