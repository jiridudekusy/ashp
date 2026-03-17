import styles from './ApprovalCard.module.css';

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export default function ApprovalCard({ approval, selected, onClick, timeoutSeconds }) {
  const method = approval.method || 'POST';
  const url = approval.suggested_pattern || approval.url || 'Unknown';
  const elapsed = (Date.now() - new Date(approval.created_at).getTime()) / 1000;
  const timeout = timeoutSeconds || 30;
  const progress = Math.min(elapsed / timeout, 1);

  return (
    <div
      className={selected ? styles.rowSelected : styles.row}
      onClick={onClick}
      data-testid="approval-row"
    >
      <div className={styles.top}>
        <span className={styles.method}>{method}</span>
        <span className={styles.url} title={url}>{url}</span>
        <span className={styles.time}>{formatRelativeTime(approval.created_at)}</span>
      </div>
      <div className={styles.progressBar}>
        <div className={styles.progressFill} style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}
