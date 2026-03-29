/**
 * @module dao/interfaces
 * @description Abstract DAO interfaces for the ASHP data layer.
 *
 * Each class defines the contract that concrete implementations (SQLite, JSON file)
 * must fulfill. Methods throw "not implemented" by default, acting as compile-time
 * documentation and runtime safety nets for incomplete implementations.
 */

/** @private */
function notImpl(name) { return Promise.reject(new Error(`${name} not implemented`)); }

/**
 * Abstract interface for proxy rule CRUD and matching.
 *
 * @typedef {Object} Rule
 * @property {number} id
 * @property {string} name - Human-readable rule name.
 * @property {string} url_pattern - Regex pattern matched against request URLs.
 * @property {string[]} methods - HTTP methods this rule applies to (empty = all).
 * @property {'allow'|'deny'} action
 * @property {number} priority - Higher priority rules are evaluated first.
 * @property {string|null} agent_id - Optional agent scope.
 * @property {boolean} enabled
 * @property {number} hit_count - Total lifetime matches.
 * @property {number} hit_count_today - Matches today (resets daily).
 */
export class RulesDAO {
  /** @returns {Promise<Rule[]>} All rules ordered by priority descending. */
  list()             { return notImpl('list'); }
  /** @param {number} id @returns {Promise<Rule|null>} */
  get(id)            { return notImpl('get'); }
  /** @param {Partial<Rule>} rule @returns {Promise<Rule>} The created rule with generated ID. */
  create(rule)       { return notImpl('create'); }
  /** @param {number} id @param {Partial<Rule>} rule @returns {Promise<Rule|null>} Updated rule, or null if not found. */
  update(id, rule)   { return notImpl('update'); }
  /** @param {number} id @returns {Promise<void>} */
  delete(id)         { return notImpl('delete'); }
  /**
   * Finds the first enabled rule matching the given URL and method.
   * @param {string} url @param {string} method
   * @returns {Promise<Rule|null>} The matching rule, or null if no rule matches.
   */
  match(url, method) { return notImpl('match'); }
  /** @param {number} ruleId - Increments both `hit_count` and `hit_count_today`. */
  incrementHitCount(ruleId) { return notImpl('incrementHitCount'); }
}

/**
 * Abstract interface for HTTP request log storage and queries.
 *
 * @typedef {Object} RequestLogEntry
 * @property {number} id
 * @property {string} timestamp
 * @property {string} method
 * @property {string} url
 * @property {string|null} request_body_ref - Encrypted body ref in `path:offset:length` format.
 * @property {string|null} response_body_ref
 * @property {'allowed'|'denied'|'held'|'queued'} decision
 * @property {string|null} agent_id
 */
export class RequestLogDAO {
  /** @param {Object} entry @returns {Promise<RequestLogEntry>} The inserted entry with generated ID. */
  insert(entry)      { return notImpl('insert'); }
  /**
   * Queries log entries with optional filters.
   * @param {Object} filters - Optional: method, decision, url (LIKE), from, to, agent_id, limit, offset.
   * @returns {Promise<RequestLogEntry[]>}
   */
  query(filters)     { return notImpl('query'); }
  /** @param {number} id @returns {Promise<RequestLogEntry|null>} */
  getById(id)        { return notImpl('getById'); }
  /** @param {string|Date} olderThan - Delete entries older than this timestamp. @returns {Promise<number>} Rows deleted. */
  cleanup(olderThan) { return notImpl('cleanup'); }
}

/**
 * Abstract interface for the approval queue.
 *
 * @typedef {Object} ApprovalEntry
 * @property {number} id
 * @property {number} request_log_id - FK to request_log.
 * @property {string|null} ipc_msg_id - Correlation ID linking back to the Go proxy's held connection.
 * @property {'pending'|'approved'|'rejected'} status
 * @property {string|null} suggested_pattern - Regex pattern suggested for auto-rule creation.
 * @property {string|null} suggested_methods - JSON-encoded method array.
 */
export class ApprovalQueueDAO {
  /** @param {Object} entry @returns {Promise<ApprovalEntry>} */
  enqueue(entry)      { return notImpl('enqueue'); }
  /**
   * Resolves a pending approval.
   * @param {number} id
   * @param {{action: 'approve'|'reject', resolved_by?: string, create_rule?: boolean}} action
   * @returns {Promise<ApprovalEntry|null>} The resolved entry, or null if not found/already resolved.
   */
  resolve(id, action) { return notImpl('resolve'); }
  /** @returns {Promise<ApprovalEntry[]>} All pending approvals ordered by creation time. */
  listPending()       { return notImpl('listPending'); }
}

/**
 * Abstract interface for hierarchical policy management.
 *
 * Policies group rules together and can be nested (parent→child). Agents can have
 * one or more policies assigned to them. `resolveAgentRules` returns the flat,
 * merged set of enabled rules from all directly and transitively assigned policies.
 *
 * @typedef {Object} Policy
 * @property {number} id
 * @property {string} name - Unique policy name.
 * @property {string} description
 * @property {string} created_at
 */
export class PoliciesDAO {
  /** @returns {Promise<Policy[]>} All policies ordered by id. */
  list()                          { return notImpl('list'); }
  /** @param {number} id @returns {Promise<Policy|null>} */
  get(id)                         { return notImpl('get'); }
  /** @param {Partial<Policy>} policy @returns {Promise<Policy>} The created policy. */
  create(policy)                  { return notImpl('create'); }
  /** @param {number} id @param {Partial<Policy>} changes @returns {Promise<Policy|null>} */
  update(id, changes)             { return notImpl('update'); }
  /** @param {number} id @returns {Promise<void>} */
  delete(id)                      { return notImpl('delete'); }
  /** @param {number} parentId @param {number} childId @returns {Promise<void>} */
  addChild(parentId, childId)     { return notImpl('addChild'); }
  /** @param {number} parentId @param {number} childId @returns {Promise<void>} */
  removeChild(parentId, childId)  { return notImpl('removeChild'); }
  /** @returns {Promise<Array<Policy & {children: Policy[]}>>} Root policies with nested children. */
  getTree()                       { return notImpl('getTree'); }
  /** @param {number} policyId @param {number} agentId @returns {Promise<void>} */
  assignToAgent(policyId, agentId)    { return notImpl('assignToAgent'); }
  /** @param {number} policyId @param {number} agentId @returns {Promise<void>} */
  unassignFromAgent(policyId, agentId) { return notImpl('unassignFromAgent'); }
  /** @param {number} agentId @returns {Promise<Policy[]>} Policies directly assigned to the agent. */
  getAgentPolicies(agentId)       { return notImpl('getAgentPolicies'); }
  /**
   * Resolves all enabled rules accessible to an agent via assigned policies (direct + sub-policies).
   * @param {number} agentId @returns {Promise<import('./interfaces.js').Rule[]>} Rules ordered by priority desc.
   */
  resolveAgentRules(agentId)      { return notImpl('resolveAgentRules'); }
}

/**
 * Abstract interface for agent (API client) credential management.
 *
 * @typedef {Object} Agent
 * @property {number} id
 * @property {string} name - Unique agent identifier used in Proxy-Authorization.
 * @property {string} description
 * @property {boolean} enabled
 * @property {number} request_count
 * @property {string} created_at
 */
export class AgentsDAO {
  /** @returns {Promise<Agent[]>} */
  async list() { throw new Error('Not implemented'); }
  /** @param {number} id @returns {Promise<Agent|null>} */
  async get(id) { throw new Error('Not implemented'); }
  /** @param {{name: string, description?: string}} agent @returns {Promise<Agent & {token: string}>} Includes the plaintext token (only available at creation time). */
  async create(agent) { throw new Error('Not implemented'); }
  /** @param {number} id @param {Partial<Agent>} fields @returns {Promise<Agent|null>} */
  async update(id, fields) { throw new Error('Not implemented'); }
  /** @param {number} id - Cascading delete: removes related approval_queue and request_log entries. */
  async delete(id) { throw new Error('Not implemented'); }
  /** @param {number} id @returns {Promise<{token: string}|null>} New plaintext token, or null if agent not found. */
  async rotateToken(id) { throw new Error('Not implemented'); }
  /** @param {string} name @param {string} token @returns {Promise<Agent|null>} The agent if credentials are valid and enabled, else null. */
  async authenticate(name, token) { throw new Error('Not implemented'); }
  /** @param {string} name - Agent name (not ID). */
  async incrementRequestCount(name) { throw new Error('Not implemented'); }
  /** @returns {Array<{name: string, token_hash: string, enabled: boolean}>} Synchronous; returns data the Go proxy needs for auth checks. */
  listForProxy() { throw new Error('Not implemented'); }
}
