# ASHP Policies — Hierarchical Rule Grouping

## Context

Rules are currently a flat, priority-sorted list applied identically to all agents. Real-world usage shows the need to organize rules into named groups ("policies") that can be assigned to specific agents. Example: an "LLM" policy containing "OpenAI" and "Anthropic" sub-policies, a "Calendar" policy with Google Cal rules, etc. This enables per-agent access control and cleaner rule management.

## Core Concepts

- **Policy**: Named group of rules. Has name, description.
- **Hierarchy**: Policies can contain sub-policies (tree structure). Cycle detection via ancestor walk on add.
- **Assignment**: Policies are assigned to agents (M:N). Agent sees only rules from its assigned policies.
- **Flat merge**: All rules from all agent's policies (recursively resolved) are merged into one priority-sorted list. First match wins.
- **No policy = no rules**: Agent without policies gets global default behavior (deny/hold/queue) on all requests.
- **Default policy**: Migration creates a "default" policy containing all existing rules.

## Data Model (v2→v3 migration)

### New tables

```sql
CREATE TABLE policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE policy_children (
    parent_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
    child_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
    PRIMARY KEY (parent_id, child_id),
    CHECK (parent_id != child_id)
);

CREATE TABLE agent_policies (
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    policy_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, policy_id)
);
```

### Changes to existing tables

```sql
ALTER TABLE rules ADD COLUMN policy_id INTEGER REFERENCES policies(id) ON DELETE SET NULL;
```

### Migration steps

1. Create tables above
2. Insert "default" policy
3. `UPDATE rules SET policy_id = <default_policy_id>`
4. Set `PRAGMA user_version = 3`

## Server Logic

### Policy DAO (`server/src/dao/sqlite/policies.js`)

**CRUD:** list, get, create, update, delete.

**Hierarchy:**
- `addChild(parentId, childId)` — cycle detection via recursive CTE walking ancestors of parentId; reject if childId found.
- `removeChild(parentId, childId)`
- `getTree()` — full tree for sidebar.

**Agent assignment:**
- `assignToAgent(policyId, agentId)`
- `unassignFromAgent(policyId, agentId)`
- `getAgentPolicies(agentId)`

### Cycle Detection SQL

```sql
WITH RECURSIVE ancestors(id) AS (
    SELECT parent_id FROM policy_children WHERE child_id = ?parentId
    UNION ALL
    SELECT pc.parent_id FROM policy_children pc JOIN ancestors a ON pc.child_id = a.id
)
SELECT 1 FROM ancestors WHERE id = ?childId
```

If returns row → cycle → reject with 409 Conflict.

### Flatten for Proxy — `resolveAgentRules(agentId)`

1. Get policies assigned to agent
2. Recursive CTE to expand all sub-policies
3. SELECT rules WHERE policy_id IN (resolved policy IDs) AND enabled = 1
4. Order by priority DESC
5. Return flat array

### IPC Changes

`rules.reload` sends per-agent rule map:

```json
{
  "type": "rules.reload",
  "data": {
    "agent1": [rule1, rule2, rule3],
    "agent2": [rule1, rule4]
  }
}
```

Sent on: policy CRUD, policy-child change, agent-policy assignment, rule CRUD, rule move.

## Go Proxy Changes

### Evaluator

Change from single `[]Rule` to `map[string][]compiledRule` keyed by agent name.

```go
func (e *Evaluator) Match(agentID, url, method string) *Rule {
    rules := e.byAgent[agentID]
    // iterate rules for this agent only, first match wins
}
```

### IPC Handler

`rules.reload` handler receives map, compiles regex patterns per-agent.

### Fallback

Agent not in map → no rules → global default behavior. No change to existing flow.

## API Routes

### New: `server/src/api/policies.js`

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/policies | List all (tree structure for sidebar) |
| GET | /api/policies/:id | Detail + children + rules + assigned agents |
| POST | /api/policies | Create policy |
| PUT | /api/policies/:id | Update name/description |
| DELETE | /api/policies/:id | Delete (rules get policy_id=NULL) |
| POST | /api/policies/:id/children | Add sub-policy `{ child_id }` (cycle check) |
| DELETE | /api/policies/:id/children/:childId | Remove sub-policy |
| POST | /api/policies/:id/agents | Assign to agent `{ agent_id }` |
| DELETE | /api/policies/:id/agents/:agentId | Unassign from agent |
| GET | /api/policies/match | Find policies with rules matching `?url=&method=` |

### New: Rule move

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/rules/:id/move | Move rule to policy `{ policy_id }` |

### Changes to existing

- `POST /api/rules` — accepts optional `policy_id` (defaults to "default" policy)
- `GET /api/rules` — optional `?policy_id=` filter
- `POST /api/approvals/:id/resolve` — new action `assign_policy` with `policy_id`; `create_rule` extended with `policy_id`

### SSE Events

New: `policies.changed`, `agent.policies.changed`.

## GUI

### Layout: Combined Sidebar + Detail Panel

Sidebar (left):
- **"All Rules"** link at top — shows flat table of all rules across all policies, with Policy column
- **Policy tree** — expandable/collapsible, rule counts per policy
- **Agents section** — agent names with policy count

Detail panel (right):
- Breadcrumb path (LLM > OpenAI)
- Rules table for selected policy with Edit/Move/Delete actions
- Action bar: + Rule, + Sub-Policy, Assign to Agent
- Agent assignment chips with + Assign button

### New components

| Component | Purpose |
|-----------|---------|
| `PolicyTree.jsx` | Sidebar tree with expand/collapse, counts, active selection |
| `PolicyDetail.jsx` | Right panel: breadcrumb, rules table, actions, agent assignments |
| `PolicyForm.jsx` | Modal for create/edit policy (name, description) |
| `MoveRuleModal.jsx` | Modal with tree-select for target policy |

### Changes to existing components

| Component | Change |
|-----------|--------|
| `RuleForm.jsx` | Add policy_id selector (pre-filled from context) |
| `SmartRuleBuilder.jsx` | Add policy selector dropdown |
| `ApprovalCard.jsx` | Agent info bar (name, policies, request count) |
| `Approvals.jsx` | Matching policy suggestion + "Assign policy" action |
| `Agents.jsx` | Assigned policies section with manage UI |

### CSS

New modules: `PolicyTree.module.css`, `PolicyDetail.module.css`, `MoveRuleModal.module.css`.

## Testing

### Server unit tests (`server/test/`)

- `dao/sqlite/policies.test.js` — CRUD, addChild, removeChild, cycle detection, getTree, resolveAgentRules
- `api/policies.test.js` — all endpoints, auth, validation, 409 on cycle
- `api/rules.test.js` — add policy_id filter, move endpoint
- `api/approvals.test.js` — assign_policy action

### GUI tests (`gui/src/`)

- `PolicyTree.test.jsx` — render tree, expand/collapse, selection
- `SmartRuleBuilder.test.jsx` — policy selector in approval flow

### E2E tests (`test/e2e/`)

- `proxy-e2e-policies.test.js` — create policy with rules, assign to agent, verify agent only sees its rules, verify agent without policy gets default deny

## Verification

1. `make test-server` — all existing + new policy tests pass
2. `make test-gui` — all existing + new component tests pass
3. `make test-e2e` — policy-scoped proxy flow works
4. Docker build succeeds
5. Manual: create policies, assign to agent, verify sidebar tree, move rules, approval with policy suggestion
