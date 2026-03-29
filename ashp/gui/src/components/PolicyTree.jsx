/**
 * @file PolicyTree sidebar component for navigating policies and agents.
 *
 * Renders a collapsible tree of policies with rule counts, an "All Rules"
 * shortcut at the top, an agent list at the bottom, and an add-policy button.
 */

import { useState } from 'react';
import styles from './PolicyTree.module.css';

/**
 * Recursive tree node for a single policy and its children.
 *
 * @param {Object} props
 * @param {Object} props.policy  - Policy object with id, name, rule_count, children
 * @param {number} props.level   - Nesting depth (0 = root)
 * @param {Object|null} props.selected - Currently selected item
 * @param {Function} props.onSelect    - Selection callback
 */
function TreeNode({ policy, level, selected, onSelect }) {
  const [expanded, setExpanded] = useState(true);
  const isActive = selected?.type === 'policy' && selected?.id === policy.id;
  const hasChildren = policy.children && policy.children.length > 0;

  return (
    <div>
      <div
        className={`${styles.node} ${isActive ? styles.nodeActive : ''}`}
        style={{ paddingLeft: `${12 + level * 16}px` }}
        onClick={() => onSelect({ type: 'policy', id: policy.id })}
      >
        {hasChildren ? (
          <span className={styles.toggle} onClick={e => { e.stopPropagation(); setExpanded(!expanded); }}>
            {expanded ? '▼' : '▶'}
          </span>
        ) : (
          <span className={styles.togglePlaceholder} />
        )}
        <span className={styles.name}>{policy.name}</span>
        <span className={styles.count}>{policy.rule_count}</span>
      </div>
      {expanded && hasChildren && policy.children.map(child => (
        <TreeNode key={child.id} policy={child} level={level + 1} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}

/**
 * Sidebar component showing the policy tree and agent list.
 *
 * @param {Object}        props
 * @param {Array}         props.policies    - Array of policy objects (tree structure)
 * @param {Array}         props.agents      - Array of agent objects
 * @param {Object|null}   props.selected    - null | { type: 'policy'|'agent', id }
 * @param {Function}      props.onSelect    - Called with new selection when user clicks
 * @param {Function}      props.onAddPolicy - Called when "+ Add Policy" is clicked
 */
export default function PolicyTree({ policies, agents, selected, onSelect, onAddPolicy }) {
  return (
    <div className={styles.sidebar}>
      <div
        className={`${styles.allRules} ${selected === null ? styles.allRulesActive : ''}`}
        onClick={() => onSelect(null)}
      >
        ALL RULES
      </div>

      <div className={styles.sectionLabel}>POLICIES</div>
      {policies.map(p => (
        <TreeNode key={p.id} policy={p} level={0} selected={selected} onSelect={onSelect} />
      ))}
      <button className={styles.addBtn} onClick={onAddPolicy}>+ Add Policy</button>

      <div className={styles.divider} />
      <div className={styles.sectionLabel}>AGENTS</div>
      {agents.map(a => (
        <div key={a.id} className={styles.agentItem}>
          <span className={styles.agentName}>{a.name}</span>
        </div>
      ))}
    </div>
  );
}
