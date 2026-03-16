export default function ApprovalCard({ approval, onResolve }) {
  return (
    <div className="approval-card">
      <div><strong>#{approval.id}</strong> — Request #{approval.request_log_id}</div>
      <div>Pattern: <code>{approval.suggested_pattern || 'N/A'}</code></div>
      <div>Methods: {approval.suggested_methods || 'N/A'}</div>
      <div>Status: {approval.status}</div>
      {approval.status === 'pending' && (
        <div className="actions">
          <button onClick={() => onResolve(approval.id, 'approve', false)}>Approve</button>
          <button onClick={() => onResolve(approval.id, 'approve', true)}>Approve + Create Rule</button>
          <button onClick={() => onResolve(approval.id, 'reject', false)}>Reject</button>
        </div>
      )}
    </div>
  );
}
