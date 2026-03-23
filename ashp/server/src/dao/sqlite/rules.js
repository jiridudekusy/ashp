/**
 * @module dao/sqlite/rules
 * @description SQLite implementation of RulesDAO. Provides CRUD operations for proxy
 * rules and priority-ordered regex matching against request URLs and HTTP methods.
 *
 * Rules are evaluated by the Go proxy in priority order (highest first). The `match()`
 * method here mirrors that logic for the `/api/rules/test` endpoint.
 */
import { RulesDAO } from '../interfaces.js';

/**
 * Converts a raw SQLite row into a Rule object, parsing JSON-encoded `methods`
 * and coercing `enabled` from integer to boolean.
 *
 * @param {Object|undefined} row - Raw database row.
 * @returns {import('../interfaces.js').Rule|null}
 * @private
 */
function deserialize(row) {
  if (!row) return null;
  return {
    ...row,
    methods: JSON.parse(row.methods),
    enabled: !!row.enabled,
    hit_count: row.hit_count ?? 0,
    hit_count_today: row.hit_count_today ?? 0,
    hit_count_date: row.hit_count_date ?? null,
  };
}

/**
 * SQLite-backed rules data access object.
 * @extends RulesDAO
 */
export class SqliteRulesDAO extends RulesDAO {
  #db;
  #stmts;

  /**
   * @param {import('better-sqlite3').Database} db - Initialized SQLite connection.
   */
  constructor(db) {
    super();
    this.#db = db;
    this.#stmts = {
      list: db.prepare('SELECT * FROM rules ORDER BY priority DESC'),
      get: db.prepare('SELECT * FROM rules WHERE id = ?'),
      insert: db.prepare(`INSERT INTO rules (name,url_pattern,methods,action,priority,
        agent_id,log_request_body,log_response_body,default_behavior,enabled)
        VALUES (@name,@url_pattern,@methods,@action,@priority,
        @agent_id,@log_request_body,@log_response_body,@default_behavior,@enabled)`),
      delete: db.prepare('DELETE FROM rules WHERE id = ?'),
      listEnabled: db.prepare('SELECT * FROM rules WHERE enabled=1 ORDER BY priority DESC'),
      incrementHitCount: db.prepare(`
        UPDATE rules SET
          hit_count = hit_count + 1,
          hit_count_today = CASE
            WHEN hit_count_date = date('now') THEN hit_count_today + 1
            ELSE 1
          END,
          hit_count_date = date('now')
        WHERE id = ?
      `),
    };
  }

  /** @returns {Promise<import('../interfaces.js').Rule[]>} All rules, highest priority first. */
  async list() {
    return this.#stmts.list.all().map(deserialize);
  }

  /** @param {number} id @returns {Promise<import('../interfaces.js').Rule|null>} */
  async get(id) {
    return deserialize(this.#stmts.get.get(id));
  }

  /**
   * Creates a new rule. JSON-serializes `methods` and normalizes boolean `enabled`.
   * @param {Partial<import('../interfaces.js').Rule>} rule
   * @returns {Promise<import('../interfaces.js').Rule>} The created rule.
   */
  async create(rule) {
    const info = this.#stmts.insert.run({
      name: rule.name,
      url_pattern: rule.url_pattern,
      methods: JSON.stringify(rule.methods || []),
      action: rule.action,
      priority: rule.priority ?? 0,
      agent_id: rule.agent_id ?? null,
      log_request_body: rule.log_request_body ?? 'full',
      log_response_body: rule.log_response_body ?? 'full',
      default_behavior: rule.default_behavior ?? null,
      enabled: (rule.enabled ?? true) ? 1 : 0,
    });
    return this.get(info.lastInsertRowid);
  }

  /**
   * Dynamically builds an UPDATE statement for only the changed fields.
   * @param {number} id
   * @param {Partial<import('../interfaces.js').Rule>} changes
   * @returns {Promise<import('../interfaces.js').Rule|null>} Updated rule, or null if not found.
   */
  async update(id, changes) {
    if (!this.#stmts.get.get(id)) return null;
    const fields = [];
    const params = { id };
    for (const [k, v] of Object.entries(changes)) {
      if (k === 'id') continue;
      params[k] = k === 'methods' ? JSON.stringify(v) : k === 'enabled' ? (v ? 1 : 0) : v;
      fields.push(`${k} = @${k}`);
    }
    if (fields.length) {
      this.#db.prepare(`UPDATE rules SET ${fields.join(',')} WHERE id=@id`).run(params);
    }
    return this.get(id);
  }

  /** @param {number} id @returns {Promise<void>} */
  async delete(id) {
    this.#stmts.delete.run(id);
  }

  /**
   * Increments a rule's total hit count and daily hit count.
   * Resets `hit_count_today` if `hit_count_date` differs from the current date.
   * @param {number} ruleId
   * @returns {Promise<void>}
   */
  async incrementHitCount(ruleId) {
    this.#stmts.incrementHitCount.run(ruleId);
  }

  /**
   * Finds the first enabled rule matching the URL (via regex) and HTTP method.
   * Rules are evaluated in priority order (highest first). If a rule's `methods`
   * array is empty, it matches all methods. Malformed regex patterns are silently skipped.
   *
   * @param {string} url - The full request URL to match against.
   * @param {string} method - The HTTP method (e.g. 'GET', 'POST').
   * @returns {Promise<import('../interfaces.js').Rule|null>} First matching rule, or null.
   */
  async match(url, method) {
    for (const row of this.#stmts.listEnabled.all()) {
      try {
        if (!new RegExp(row.url_pattern).test(url)) continue;
        const methods = JSON.parse(row.methods);
        if (methods.length > 0 && !methods.includes(method)) continue;
        return deserialize(row);
      } catch {
        continue;
      }
    }
    return null;
  }
}
