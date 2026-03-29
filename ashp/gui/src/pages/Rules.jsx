/**
 * @file Rules management page — sidebar+detail layout with policy navigation.
 *
 * Left sidebar shows a policy tree (via PolicyTree) and agent list.
 * Right panel shows either all rules (flat table with Policy column) or
 * a single policy's detail view (rules + agent assignments).
 *
 * When rules_source is 'file', the page enters read-only mode:
 * mutation buttons are hidden and a banner is shown.
 */
import { useState, useEffect } from 'react';
import PolicyTree from '../components/PolicyTree';
import PolicyDetail from '../components/PolicyDetail';
import PolicyForm from '../components/PolicyForm';
import RuleForm from '../components/RuleForm';
import MoveRuleModal from '../components/MoveRuleModal';
import { Badge } from '../components/Badge';
import styles from './Rules.module.css';

/**
 * Flatten a policy tree into a map of id -> policy for quick lookup.
 * @param {Array} policies - Tree-structured policy array
 * @returns {Map<number, Object>}
 */
function buildPolicyMap(policies) {
  const map = new Map();
  function walk(list) {
    for (const p of list) {
      map.set(p.id, p);
      if (p.children?.length) walk(p.children);
    }
  }
  walk(policies);
  return map;
}

/**
 * @param {Object} props
 * @param {Object} props.api - API client from createClient()
 */
export default function Rules({ api }) {
  const [policies, setPolicies] = useState([]);
  const [agents, setAgents] = useState([]);
  const [allRules, setAllRules] = useState([]);
  const [selected, setSelected] = useState(null); // null = all rules, {type:'policy',id} = specific policy
  const [selectedPolicy, setSelectedPolicy] = useState(null); // full policy detail
  const [editingRule, setEditingRule] = useState(null);
  const [editingPolicy, setEditingPolicy] = useState(null); // null|'new'|policy
  const [movingRule, setMovingRule] = useState(null);
  const [readOnly, setReadOnly] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const reload = async () => {
    const [p, a, r, s] = await Promise.all([
      api.getPolicies(), api.getAgents(), api.getRules(), api.getStatus(),
    ]);
    setPolicies(p);
    setAgents(a);
    setAllRules(r);
    if (s?.rules_source === 'file') setReadOnly(true);
    // Refresh selected policy detail
    if (selected?.type === 'policy') {
      setSelectedPolicy(await api.getPolicy(selected.id));
    }
  };

  useEffect(() => { reload(); }, [api]);

  useEffect(() => {
    if (selected?.type === 'policy') {
      api.getPolicy(selected.id).then(setSelectedPolicy);
    } else {
      setSelectedPolicy(null);
    }
  }, [selected]);

  async function handleSaveRule(rule) {
    if (editingRule === 'new') {
      await api.createRule({ ...rule, policy_id: selected?.id || null });
    } else {
      await api.updateRule(editingRule.id, rule);
    }
    setEditingRule(null);
    await reload();
  }

  async function handleDeleteRule(id) {
    await api.deleteRule(id);
    await reload();
  }

  async function handleMoveRule(ruleId, policyId) {
    await api.moveRule(ruleId, policyId);
    setMovingRule(null);
    await reload();
  }

  async function handleSavePolicy(data) {
    if (editingPolicy === 'new') {
      await api.createPolicy(data);
    } else {
      await api.updatePolicy(editingPolicy.id, data);
    }
    setEditingPolicy(null);
    await reload();
  }

  async function handleDeletePolicy(id) {
    await api.deletePolicy(id);
    setSelected(null);
    await reload();
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

  // Build flat lookup map for policy names
  const policyMap = buildPolicyMap(policies);

  // Determine which rules to show
  const displayRules = selected === null
    ? [...allRules].sort((a, b) => b.priority - a.priority)
    : allRules.filter(r => r.policy_id === selected.id).sort((a, b) => b.priority - a.priority);

  return (
    <div className={styles.layout}>
      <PolicyTree
        policies={policies}
        agents={agents}
        selected={selected}
        onSelect={setSelected}
        onAddPolicy={() => setEditingPolicy('new')}
      />
      <div className={styles.main}>
        {readOnly && (
          <div className={styles.readOnlyBanner}>
            Rules are loaded from a file and cannot be edited through the UI.
          </div>
        )}

        {selected === null ? (
          /* ALL RULES view */
          <div>
            <div className={styles.header}>
              <div className={styles.headerLeft}>
                <h2 className={styles.title}>All Rules</h2>
                <span className={styles.count}>{allRules.length} rule{allRules.length !== 1 ? 's' : ''}</span>
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
                  <button className={styles.addBtn} onClick={() => setEditingRule('new')}>+ Add Rule</button>
                )}
              </div>
            </div>

            {testResult && (
              <div className={testResultClass(testResult)}>
                Result: <Badge variant={testResult.action || testResult.decision}>{testResult.action || testResult.decision}</Badge>
                {testResult.rule_name && <span> — matched rule: {testResult.rule_name}</span>}
              </div>
            )}

            {allRules.length === 0 ? (
              <div className={styles.empty}>No rules configured yet</div>
            ) : (
              <div className={styles.table}>
                <div className={styles.tableHeaderAll}>
                  <span>Name</span><span>Pattern</span><span>Policy</span><span>Methods</span><span>Action</span><span>Priority</span><span></span>
                </div>
                {displayRules.map(r => (
                  <div key={r.id} className={r.enabled ? styles.tableRowAll : styles.tableRowAllDisabled}>
                    <span className={styles.cellName} title={r.name}>{r.name}</span>
                    <span className={styles.cellPattern} title={r.url_pattern}>{r.url_pattern}</span>
                    <span className={styles.cellPolicy}>{policyMap.get(r.policy_id)?.name || '\u2014'}</span>
                    <span>{r.methods.length ? r.methods.join(', ') : '*'}</span>
                    <span><Badge variant={r.action}>{r.action}</Badge></span>
                    <span>{r.priority}</span>
                    <span className={styles.cellActions}>
                      {!readOnly && (
                        <>
                          <button className={styles.editLink} onClick={() => setEditingRule(r)}>Edit</button>
                          <button className={styles.editLink} onClick={() => setMovingRule(r)}>Move</button>
                          <button className={styles.deleteLink} onClick={() => handleDeleteRule(r.id)}>Delete</button>
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          /* POLICY DETAIL view */
          <PolicyDetail
            policy={selectedPolicy}
            rules={displayRules}
            readOnly={readOnly}
            onAddRule={() => setEditingRule('new')}
            onEditRule={r => setEditingRule(r)}
            onDeleteRule={handleDeleteRule}
            onMoveRule={r => setMovingRule(r)}
            onEditPolicy={() => setEditingPolicy(selectedPolicy)}
            onDeletePolicy={() => handleDeletePolicy(selected.id)}
            onAssignAgent={async (agentId) => {
              await api.assignPolicyAgent(selected.id, agentId);
              await reload();
            }}
            onUnassignAgent={async (agentId) => {
              await api.unassignPolicyAgent(selected.id, agentId);
              await reload();
            }}
            agents={agents}
          />
        )}
      </div>

      <RuleForm open={!!editingRule} rule={editingRule !== 'new' ? editingRule : null}
        onSave={handleSaveRule} onCancel={() => setEditingRule(null)} />
      <PolicyForm open={!!editingPolicy} policy={editingPolicy !== 'new' ? editingPolicy : null}
        onSave={handleSavePolicy} onCancel={() => setEditingPolicy(null)} />
      <MoveRuleModal open={!!movingRule} rule={movingRule} policies={policies}
        onMove={handleMoveRule} onCancel={() => setMovingRule(null)} />
    </div>
  );
}
