/**
 * @module dao/sqlite/policies
 * @description SQLite implementation of PoliciesDAO. Manages hierarchical policies that
 * group rules together and can be assigned to agents.
 *
 * Policies form a DAG (directed acyclic graph) via the `policy_children` join table.
 * Cycle detection uses a recursive CTE to walk the ancestor chain before inserting
 * a new child relationship.
 *
 * `resolveAgentRules` uses a recursive CTE to collect all policy IDs reachable from
 * an agent's directly-assigned policies, then returns enabled rules for those policies
 * ordered by priority descending.
 */
import { PoliciesDAO } from '../interfaces.js';

/**
 * Converts a raw SQLite row into a Policy object.
 *
 * @param {Object|undefined} row - Raw database row.
 * @returns {import('../interfaces.js').Policy|null}
 * @private
 */
function deserializePolicy(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    created_at: row.created_at,
  };
}

/**
 * Converts a raw SQLite rules row into a Rule object, parsing JSON `methods`
 * and coercing `enabled` to boolean.
 *
 * @param {Object|undefined} row - Raw database row.
 * @returns {import('../interfaces.js').Rule|null}
 * @private
 */
function deserializeRule(row) {
  if (!row) return null;
  return {
    ...row,
    methods: JSON.parse(row.methods),
    enabled: !!row.enabled,
    policy_id: row.policy_id ?? null,
    hit_count: row.hit_count ?? 0,
    hit_count_today: row.hit_count_today ?? 0,
    hit_count_date: row.hit_count_date ?? null,
  };
}

/**
 * SQLite-backed policies data access object.
 * @extends PoliciesDAO
 */
export class SqlitePoliciesDAO extends PoliciesDAO {
  #db;
  #stmts;

  /**
   * @param {import('better-sqlite3').Database} db - Initialized SQLite connection.
   */
  constructor(db) {
    super();
    this.#db = db;
    this.#stmts = {
      list: db.prepare('SELECT * FROM policies ORDER BY id'),
      get: db.prepare('SELECT * FROM policies WHERE id = ?'),
      insert: db.prepare('INSERT INTO policies (name, description) VALUES (@name, @description)'),
      delete: db.prepare('DELETE FROM policies WHERE id = ?'),
      addChild: db.prepare('INSERT INTO policy_children (parent_id, child_id) VALUES (?, ?)'),
      removeChild: db.prepare('DELETE FROM policy_children WHERE parent_id = ? AND child_id = ?'),
      // All policies that ARE children (used to find roots = those not in child_id column)
      allChildIds: db.prepare('SELECT DISTINCT child_id FROM policy_children'),
      childrenOf: db.prepare('SELECT p.* FROM policies p JOIN policy_children pc ON p.id = pc.child_id WHERE pc.parent_id = ?'),
      // Cycle check: walk ancestors of `childId`; if any ancestor equals `parentId`, adding would create a cycle
      cycleCheck: db.prepare(`
        WITH RECURSIVE ancestors(id) AS (
          SELECT parent_id FROM policy_children WHERE child_id = ?
          UNION ALL
          SELECT pc.parent_id FROM policy_children pc JOIN ancestors a ON pc.child_id = a.id
        )
        SELECT 1 FROM ancestors WHERE id = ?
      `),
      assignToAgent: db.prepare('INSERT OR IGNORE INTO agent_policies (agent_id, policy_id) VALUES (?, ?)'),
      unassignFromAgent: db.prepare('DELETE FROM agent_policies WHERE agent_id = ? AND policy_id = ?'),
      getAgentPolicies: db.prepare(`
        SELECT p.* FROM policies p
        JOIN agent_policies ap ON p.id = ap.policy_id
        WHERE ap.agent_id = ?
        ORDER BY p.id
      `),
      // Recursive CTE: collect all policy IDs accessible from an agent (direct + transitive children)
      resolveAgentPolicyIds: db.prepare(`
        WITH RECURSIVE reachable(id) AS (
          SELECT policy_id FROM agent_policies WHERE agent_id = ?
          UNION ALL
          SELECT pc.child_id FROM policy_children pc JOIN reachable r ON pc.parent_id = r.id
        )
        SELECT DISTINCT id FROM reachable
      `),
    };
  }

  /** @returns {Promise<import('../interfaces.js').Policy[]>} All policies ordered by id. */
  async list() {
    return this.#stmts.list.all().map(deserializePolicy);
  }

  /**
   * @param {number} id
   * @returns {Promise<import('../interfaces.js').Policy|null>}
   */
  async get(id) {
    return deserializePolicy(this.#stmts.get.get(id));
  }

  /**
   * Creates a new policy.
   * @param {Partial<import('../interfaces.js').Policy>} policy
   * @returns {Promise<import('../interfaces.js').Policy>} The created policy.
   */
  async create(policy) {
    const info = this.#stmts.insert.run({
      name: policy.name,
      description: policy.description ?? '',
    });
    return this.get(info.lastInsertRowid);
  }

  /**
   * Dynamically builds an UPDATE for only the provided changed fields.
   * @param {number} id
   * @param {Partial<import('../interfaces.js').Policy>} changes
   * @returns {Promise<import('../interfaces.js').Policy|null>} Updated policy, or null if not found.
   */
  async update(id, changes) {
    if (!this.#stmts.get.get(id)) return null;
    const fields = [];
    const params = { id };
    for (const [k, v] of Object.entries(changes)) {
      if (k === 'id' || k === 'created_at') continue;
      params[k] = v;
      fields.push(`${k} = @${k}`);
    }
    if (fields.length) {
      this.#db.prepare(`UPDATE policies SET ${fields.join(', ')} WHERE id = @id`).run(params);
    }
    return this.get(id);
  }

  /**
   * Deletes a policy. Rules with this policy_id will have their policy_id set to NULL
   * (ON DELETE SET NULL FK constraint). Child relationships cascade automatically
   * (ON DELETE CASCADE on policy_children).
   * @param {number} id
   * @returns {Promise<void>}
   */
  async delete(id) {
    this.#stmts.delete.run(id);
  }

  /**
   * Adds a child policy relationship after verifying no cycle would be introduced.
   * Self-references are also rejected.
   *
   * @param {number} parentId
   * @param {number} childId
   * @returns {Promise<void>}
   * @throws {Error} If adding this relationship would create a cycle or self-reference.
   */
  async addChild(parentId, childId) {
    if (parentId === childId) {
      throw new Error('cycle: self-reference not allowed');
    }
    // Check if childId is already an ancestor of parentId (would form a cycle)
    const cycleRow = this.#stmts.cycleCheck.get(parentId, childId);
    if (cycleRow) {
      throw new Error('cycle: adding this relationship would create a cycle');
    }
    this.#stmts.addChild.run(parentId, childId);
  }

  /**
   * Removes a parent→child policy relationship.
   * @param {number} parentId
   * @param {number} childId
   * @returns {Promise<void>}
   */
  async removeChild(parentId, childId) {
    this.#stmts.removeChild.run(parentId, childId);
  }

  /**
   * Returns the policy tree. Root policies (not a child of any other policy) are
   * returned with a populated `children` array containing their direct children.
   * Note: children are not recursively expanded (one level deep for UI consumption).
   *
   * @returns {Promise<Array<import('../interfaces.js').Policy & {children: import('../interfaces.js').Policy[]}>>}
   */
  async getTree() {
    const all = this.#stmts.list.all().map(deserializePolicy);
    const childIdSet = new Set(this.#stmts.allChildIds.all().map(r => r.child_id));

    const roots = all.filter(p => !childIdSet.has(p.id));
    for (const root of roots) {
      root.children = this.#stmts.childrenOf.all(root.id).map(deserializePolicy);
    }
    return roots;
  }

  /**
   * Assigns a policy to an agent. Uses INSERT OR IGNORE to be idempotent.
   * @param {number} policyId
   * @param {number} agentId
   * @returns {Promise<void>}
   */
  async assignToAgent(policyId, agentId) {
    this.#stmts.assignToAgent.run(agentId, policyId);
  }

  /**
   * Removes a policy assignment from an agent.
   * @param {number} policyId
   * @param {number} agentId
   * @returns {Promise<void>}
   */
  async unassignFromAgent(policyId, agentId) {
    this.#stmts.unassignFromAgent.run(agentId, policyId);
  }

  /**
   * Returns policies directly assigned to an agent (not transitive sub-policies).
   * @param {number} agentId
   * @returns {Promise<import('../interfaces.js').Policy[]>}
   */
  async getAgentPolicies(agentId) {
    return this.#stmts.getAgentPolicies.all(agentId).map(deserializePolicy);
  }

  /**
   * Resolves all enabled rules accessible to an agent via its assigned policies
   * (direct assignments and all transitive sub-policies). Rules are deduplicated
   * and returned ordered by priority descending.
   *
   * @param {number} agentId
   * @returns {Promise<import('../interfaces.js').Rule[]>}
   */
  async resolveAgentRules(agentId) {
    const policyIds = this.#stmts.resolveAgentPolicyIds.all(agentId).map(r => r.id);
    if (policyIds.length === 0) return [];

    const placeholders = policyIds.map(() => '?').join(', ');
    const rows = this.#db
      .prepare(`SELECT * FROM rules WHERE policy_id IN (${placeholders}) AND enabled = 1 ORDER BY priority DESC`)
      .all(...policyIds);
    return rows.map(deserializeRule);
  }
}
