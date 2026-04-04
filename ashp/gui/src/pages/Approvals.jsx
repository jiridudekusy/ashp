/**
 * @file Approval queue page — displays held requests awaiting human decision.
 *
 * Split-pane layout: left shows pending approvals with countdown progress bars,
 * right shows request details with approve/reject/approve+create-rule actions.
 *
 * The countdown timer reflects the Go proxy's hold_timeout — once it expires,
 * the proxy returns 504 to the agent regardless of UI state. A 1-second
 * setInterval drives the progress bars and relative timestamps.
 *
 * "Approve + Create Rule" resolves the approval and opens SmartRuleBuilder
 * pre-filled with the request's URL pattern, letting the user create a
 * permanent allow rule so future identical requests pass automatically.
 *
 * Each approval card shows the agent name and its currently assigned policies.
 * If a matching policy already has rules for the request, a suggestion banner
 * is shown with an "Assign Policy" shortcut action.
 *
 * Recently resolved approvals are kept in local state (last 10) for context,
 * updated via SSE 'approval.resolved' events.
 */
import { useState, useEffect, useCallback } from 'react';
import { Badge } from '../components/Badge';
import { DetailPanel } from '../components/DetailPanel';
import { SmartRuleBuilder } from '../components/SmartRuleBuilder';
import ApprovalCard from '../components/ApprovalCard';
import { SplitPane } from '../components/SplitPane';
import styles from './Approvals.module.css';

/** Default countdown duration in seconds (should match server's hold_timeout). */
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

/**
 * Converts an approval queue item into a pseudo log-entry shape
 * compatible with DetailPanel, which expects {id, method, url, decision, ...}.
 */
function approvalToEntry(approval) {
  if (!approval) return null;
  return {
    id: approval.request_log_id,
    method: approval.method || 'UNKNOWN',
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
  const [agents, setAgents] = useState([]);
  const [policies, setPolicies] = useState([]);
  /** Map of agent_id → array of policy objects assigned to that agent */
  const [agentPolicies, setAgentPolicies] = useState({});
  /** Matching policy suggestion for the currently selected approval */
  const [matchSuggestion, setMatchSuggestion] = useState(null);

  const load = useCallback(() => {
    api.getApprovals().then(setApprovals);
  }, [api]);

  useEffect(() => { load(); }, [load]);

  // Load agents and policies once on mount
  useEffect(() => {
    Promise.all([api.getAgents(), api.getPolicies()]).then(([agentList, policyList]) => {
      setAgents(agentList);
      setPolicies(policyList);
    });
  }, [api]);

  // When agents or policies change, build a map of agent_id → policies
  useEffect(() => {
    if (!agents.length || !policies.length) return;
    // Each policy has an `agents` array (list of agent_ids) if the API returns it,
    // or we derive it by checking policy.agent_ids. We build the reverse map.
    const map = {};
    agents.forEach(a => { map[a.id] = []; });
    policies.forEach(p => {
      const ids = p.agent_ids || p.agents || [];
      ids.forEach(agentId => {
        if (map[agentId]) map[agentId].push(p);
      });
    });
    setAgentPolicies(map);
  }, [agents, policies]);

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

  // When selection changes, check for matching policies
  useEffect(() => {
    setMatchSuggestion(null);
    if (!selected) return;
    const url = selected.url || selected.suggested_pattern || '';
    const method = selected.method || 'UNKNOWN';
    if (!url) return;
    api.matchPolicies(url, method)
      .then(result => {
        // result is expected to be an array of matching policy objects
        if (result && result.length > 0) {
          setMatchSuggestion(result[0]);
        }
      })
      .catch(() => {}); // silently ignore if endpoint unavailable
  }, [selected, api]);

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

  /**
   * Assigns the suggested matching policy to the approval's agent,
   * then approves the request.
   */
  async function handleAssignPolicy(approval, policyId) {
    const agentId = approval.agent_id;
    if (agentId && policyId) {
      await api.assignPolicyAgent(policyId, agentId);
      // Refresh agent policies map
      const [agentList, policyList] = await Promise.all([api.getAgents(), api.getPolicies()]);
      setAgents(agentList);
      setPolicies(policyList);
    }
    await api.resolveApproval(approval.id, { action: 'approve' });
    if (selected?.id === approval.id) setSelected(null);
    setMatchSuggestion(null);
    load();
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

  // Agent info bar for the selected approval
  const selectedAgent = selected ? agents.find(a => a.id === selected.agent_id) : null;
  const selectedAgentPolicies = selectedAgent ? (agentPolicies[selectedAgent.id] || []) : [];

  const agentInfoBar = selectedAgent ? (
    <div className={styles.agentInfoBar}>
      <span className={styles.agentInfoLabel}>Agent:</span>
      <span className={styles.agentInfoName}>{selectedAgent.name}</span>
      {selectedAgentPolicies.length > 0 ? (
        <span className={styles.agentPolicies}>
          {selectedAgentPolicies.map(p => (
            <span key={p.id} className={styles.policyBadge}>{p.name}</span>
          ))}
        </span>
      ) : (
        <span className={styles.agentNoPolicies}>no policies assigned</span>
      )}
    </div>
  ) : null;

  const matchBanner = matchSuggestion ? (
    <div className={styles.matchBanner}>
      <span>
        Policy <strong>{matchSuggestion.name}</strong> already contains matching rules.
      </span>
      <button
        className={styles.assignPolicyBtn}
        onClick={() => handleAssignPolicy(selected, matchSuggestion.id)}
      >
        Assign to agent
      </button>
    </div>
  ) : null;

  const listPane = (
    <>
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
                  {r.method || 'UNKNOWN'} {r.suggested_pattern || r.url || 'Unknown'}
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
    </>
  );

  const detailPane = (
    <div className={styles.detailWrapper}>
      <div className={styles.detailContent}>
        {agentInfoBar}
        {matchBanner}
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
          {matchSuggestion && (
            <button
              className={styles.assignPolicyActionBtn}
              onClick={() => handleAssignPolicy(selected, matchSuggestion.id)}
            >
              Assign Policy &ldquo;{matchSuggestion.name}&rdquo; + Approve
            </button>
          )}
          <button
            className={styles.approveRuleBtn}
            onClick={() => handleApproveAndRule(selected)}
          >
            Approve + Create Rule
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className={styles.page}>
      <SplitPane
        left={listPane}
        right={detailPane}
        storageId="approvals"
        defaultWidth={380}
        minWidth={250}
        maxWidth={1200}
      />
      <SmartRuleBuilder
        open={!!ruleEntry}
        onClose={() => setRuleEntry(null)}
        onSubmit={handleCreateRule}
        entry={ruleEntry}
        policies={policies}
      />
    </div>
  );
}
