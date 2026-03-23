/**
 * @file Dashboard page — shows proxy status cards, pending approval count,
 * and a live activity feed. SSE events are prepended to the feed in real-time.
 * Clicking a feed row navigates to the Logs page with that entry selected.
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../components/Badge.jsx';
import styles from './Dashboard.module.css';

/** Formats a timestamp as a human-readable relative time string (e.g., "5m ago"). */
function timeAgo(timestamp) {
  if (!timestamp) return 'now';
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatUptime(ms) {
  if (!ms || ms < 60000) return '< 1m';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

/**
 * Resolves the decision string for a feed entry. DB-loaded entries have
 * a `decision` field; SSE events carry `_event` instead and need mapping.
 */
function getDecision(r) {
  if (r.decision) return r.decision;
  if (r._event === 'request.allowed') return 'allowed';
  if (r._event === 'request.blocked') return 'denied';
  return 'held';
}

export default function Dashboard({ api, events }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [recent, setRecent] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    api.getStatus().then(setStatus);
    api.getLogs({ limit: 20 }).then(setRecent);
    api.getApprovals().then(a => setPendingCount(a.length)).catch(() => {});
  }, [api]);

  useEffect(() => {
    if (!events) return;
    const handler = (type, data) => {
      setRecent(prev => [{ ...data, _event: type }, ...prev].slice(0, 20));
    };
    events.subscribe(handler);
    return () => events.unsubscribe(handler);
  }, [events]);

  if (!status) return <div className={styles.cards}><p>Loading...</p></div>;

  return (
    <div>
      <div className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Proxy Status</div>
          <div className={styles.cardValue}>{status.proxy?.running ? 'Running' : 'Stopped'}</div>
          <div className={styles.cardSub}>{formatUptime(status.proxy?.uptime_ms)}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Active Rules</div>
          <div className={styles.cardValue}>{status.rules_count}</div>
          <div className={styles.cardSub}>Source: {status.rules_source}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Pending Approvals</div>
          <div className={styles.cardValue}>{pendingCount}</div>
          <div className={styles.cardLink} onClick={() => navigate('/approvals')}>View approvals</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Default Behavior</div>
          <div className={styles.statusRow}>
            <Badge variant={status.default_behavior || 'deny'}>
              {status.default_behavior || 'deny'}
            </Badge>
          </div>
        </div>
      </div>

      <div className={styles.feed}>
        <div className={styles.feedHeader}>
          <span className={styles.feedTitle}>Live Activity</span>
          <span className={styles.feedMeta}>{recent.length} entries</span>
        </div>
        {recent.length === 0 ? (
          <div className={styles.empty}>No recent activity</div>
        ) : (
          recent.map((r, i) => {
            const decision = getDecision(r);
            const isHold = decision === 'held';
            return (
              <div
                key={r.id || i}
                className={isHold ? styles.feedRowHold : styles.feedRow}
                onClick={() => r.id && navigate(`/logs?id=${r.id}`)}
              >
                <Badge variant={decision}>{decision}</Badge>
                <span className={styles.feedUrl}>{r.method} {r.url}</span>
                <span className={styles.feedInfo}>
                  {r.status_code && `${r.status_code}`}
                  {r.duration_ms != null && ` ${r.duration_ms}ms`}
                </span>
                <span className={styles.feedTime}>{timeAgo(r.timestamp)}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
