/**
 * @module dao/sqlite/agents
 * @description SQLite implementation of AgentsDAO. Manages agent (API client) credentials
 * with bcrypt-hashed tokens.
 *
 * Agents authenticate to the Go proxy via Proxy-Authorization headers. The proxy
 * receives agent credential data (name, token_hash, enabled) via IPC `agents.reload`
 * messages and performs bcrypt verification locally.
 *
 * Tokens are 32-byte random hex strings. The plaintext is only returned at creation
 * or rotation time; only the bcrypt hash is persisted.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { AgentsDAO } from '../interfaces.js';

/** @type {number} bcrypt cost factor. */
const SALT_ROUNDS = 10;

/**
 * Generates a cryptographically secure 64-character hex token.
 * @returns {string}
 * @private
 */
function generateToken() {
  return randomBytes(32).toString('hex');
}

/**
 * Converts a raw SQLite row to a public-facing Agent object.
 * Strips `token_hash` and coerces `enabled` from integer to boolean.
 *
 * @param {Object|undefined} row
 * @returns {import('../interfaces.js').Agent|null}
 * @private
 */
function deserialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    enabled: !!row.enabled,
    request_count: row.request_count,
    created_at: row.created_at,
    ip_address: row.ip_address || null,
  };
}

/**
 * SQLite-backed agent credential management.
 * @extends AgentsDAO
 */
export class SqliteAgentsDAO extends AgentsDAO {
  #db;
  #stmts;

  /**
   * @param {import('better-sqlite3').Database} db - Initialized SQLite connection.
   */
  constructor(db) {
    super();
    this.#db = db;
    this.#stmts = {
      list: db.prepare('SELECT id, name, description, enabled, request_count, created_at, ip_address FROM agents ORDER BY id'),
      get: db.prepare('SELECT id, name, description, enabled, request_count, created_at, ip_address FROM agents WHERE id = ?'),
      getByName: db.prepare('SELECT * FROM agents WHERE name = ?'),
      insert: db.prepare('INSERT INTO agents (name, description, token_hash) VALUES (@name, @description, @token_hash)'),
      update: db.prepare('UPDATE agents SET name = @name, description = @description, enabled = @enabled WHERE id = @id'),
      delete: db.prepare('DELETE FROM agents WHERE id = ?'),
      deleteApprovals: db.prepare('DELETE FROM approval_queue WHERE request_log_id IN (SELECT id FROM request_log WHERE agent_id = (SELECT name FROM agents WHERE id = ?))'),
      deleteRequestLogs: db.prepare('DELETE FROM request_log WHERE agent_id = (SELECT name FROM agents WHERE id = ?)'),
      updateTokenHash: db.prepare('UPDATE agents SET token_hash = ? WHERE id = ?'),
      incrementRequestCount: db.prepare('UPDATE agents SET request_count = request_count + 1 WHERE name = ?'),
      listForProxy: db.prepare('SELECT name, token_hash, enabled, ip_address FROM agents'),
      updateIp: db.prepare('UPDATE agents SET ip_address = ? WHERE id = ?'),
      ipMapping: db.prepare("SELECT ip_address, name FROM agents WHERE ip_address IS NOT NULL AND enabled = 1"),
    };
  }

  /** @returns {Promise<import('../interfaces.js').Agent[]>} */
  async list() {
    return this.#stmts.list.all().map(deserialize);
  }

  /** @param {number} id @returns {Promise<import('../interfaces.js').Agent|null>} */
  async get(id) {
    return deserialize(this.#stmts.get.get(id));
  }

  /**
   * Creates a new agent with a randomly generated token.
   *
   * @param {Object} param0
   * @param {string} param0.name - Unique agent name.
   * @param {string} [param0.description='']
   * @returns {Promise<import('../interfaces.js').Agent & {token: string}>} Agent data including the
   *   plaintext token. The token is not stored and cannot be retrieved again.
   */
  async create({ name, description = '' }) {
    const token = generateToken();
    const token_hash = await bcrypt.hash(token, SALT_ROUNDS);
    const info = this.#stmts.insert.run({ name, description, token_hash });
    const agent = deserialize(this.#stmts.get.get(info.lastInsertRowid));
    return { ...agent, token };
  }

  /**
   * Updates an agent's mutable fields (name, description, enabled).
   * @param {number} id
   * @param {Partial<import('../interfaces.js').Agent>} fields
   * @returns {Promise<import('../interfaces.js').Agent|null>} Updated agent, or null if not found.
   */
  async update(id, fields) {
    const current = this.#stmts.get.get(id);
    if (!current) return null;
    this.#stmts.update.run({
      id,
      name: fields.name ?? current.name,
      description: fields.description ?? current.description ?? '',
      enabled: (fields.enabled ?? !!current.enabled) ? 1 : 0,
    });
    return deserialize(this.#stmts.get.get(id));
  }

  /**
   * Deletes an agent and cascades to related data. Runs in a transaction:
   * 1. Delete approval_queue entries referencing the agent's request_log rows
   * 2. Delete request_log entries for this agent
   * 3. Delete the agent itself
   *
   * @param {number} id
   * @returns {Promise<void>}
   */
  async delete(id) {
    this.#db.transaction(() => {
      this.#stmts.deleteApprovals.run(id);
      this.#stmts.deleteRequestLogs.run(id);
      this.#stmts.delete.run(id);
    })();
  }

  /**
   * Generates a new token for an existing agent, replacing the old hash.
   *
   * @param {number} id
   * @returns {Promise<{token: string}|null>} The new plaintext token, or null if agent not found.
   */
  async rotateToken(id) {
    const current = this.#stmts.get.get(id);
    if (!current) return null;
    const token = generateToken();
    const token_hash = await bcrypt.hash(token, SALT_ROUNDS);
    this.#stmts.updateTokenHash.run(token_hash, id);
    return { token };
  }

  /**
   * Validates agent credentials. Returns the agent if the name exists, is enabled,
   * and the plaintext token matches the stored bcrypt hash.
   *
   * @param {string} name
   * @param {string} token - Plaintext token to verify.
   * @returns {Promise<import('../interfaces.js').Agent|null>} The agent, or null if auth fails.
   */
  async authenticate(name, token) {
    const row = this.#stmts.getByName.get(name);
    if (!row || !row.enabled) return null;
    const match = await bcrypt.compare(token, row.token_hash);
    return match ? deserialize(row) : null;
  }

  /**
   * Increments the request counter for an agent (identified by name, not ID).
   * @param {string} name
   * @returns {Promise<void>}
   */
  async incrementRequestCount(name) {
    this.#stmts.incrementRequestCount.run(name);
  }

  /**
   * Returns agent credential data for the Go proxy. Synchronous because the proxy
   * needs this data immediately on IPC connect/reload.
   *
   * @returns {Array<{name: string, token_hash: string, enabled: boolean}>}
   */
  listForProxy() {
    return this.#stmts.listForProxy.all().map(row => ({
      name: row.name,
      token_hash: row.token_hash,
      enabled: !!row.enabled,
      ip_address: row.ip_address || null,
    }));
  }

  /**
   * Stores or clears the source IP address for an agent. Used by transparent proxy
   * mode to associate a container's IP with an agent identity.
   *
   * @param {number} id - Agent ID.
   * @param {string|null} ip - IP address to register, or null to clear.
   * @returns {Promise<void>}
   */
  async registerIp(id, ip) {
    this.#stmts.updateIp.run(ip, id);
  }

  /**
   * Returns a synchronous IP-address-to-agent-name mapping for all enabled agents
   * with a registered IP. Used by the Go proxy for transparent mode auth.
   *
   * @returns {Object<string, string>} Map of IP address → agent name.
   */
  getIPMapping() {
    const rows = this.#stmts.ipMapping.all();
    const mapping = {};
    for (const row of rows) {
      mapping[row.ip_address] = row.name;
    }
    return mapping;
  }
}
