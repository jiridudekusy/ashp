import { useState, useEffect } from 'react';
import ApprovalCard from '../components/ApprovalCard';

export default function Approvals({ api, events }) {
  const [approvals, setApprovals] = useState([]);

  const load = () => api.getApprovals().then(setApprovals);
  useEffect(() => { load(); }, [api]);

  useEffect(() => {
    if (!events) return;
    const handler = (type) => {
      if (type === 'approval.needed' || type === 'approval.resolved') load();
    };
    events.subscribe(handler);
    return () => events.unsubscribe(handler);
  }, [events]);

  async function handleResolve(id, action, createRule) {
    await api.resolveApproval(id, { action, create_rule: createRule });
    load();
  }

  return (
    <div>
      <h2>Approval Queue ({approvals.length} pending)</h2>
      {approvals.length === 0 && <p>No pending approvals.</p>}
      {approvals.map(a => (
        <ApprovalCard key={a.id} approval={a} onResolve={handleResolve} />
      ))}
    </div>
  );
}
