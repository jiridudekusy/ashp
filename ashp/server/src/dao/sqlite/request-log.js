/**
 * @module dao/sqlite/request-log
 * @description SQLite implementation of RequestLogDAO. Stores proxied HTTP request metadata
 * and supports filtered queries with pagination.
 *
 * Body content is not stored inline; instead, the Go proxy writes encrypted blobs to
 * append-only log files and passes a `body_ref` string (`path:offset:length`) that
 * the Node server uses to read and decrypt the body on demand (see api/logs.js).
 */
import { RequestLogDAO } from '../interfaces.js';

/**
 * SQLite-backed request log data access object.
 * @extends RequestLogDAO
 */
export class SqliteRequestLogDAO extends RequestLogDAO {
  #db; #stmts;

  /**
   * @param {import('better-sqlite3').Database} db - Initialized SQLite connection.
   */
  constructor(db) {
    super();
    this.#db = db;
    this.#stmts = {
      insert: db.prepare(`INSERT INTO request_log (method,url,request_headers,
        request_body_ref,response_status,response_headers,response_body_ref,
        duration_ms,rule_id,decision,agent_id) VALUES (@method,@url,
        @request_headers,@request_body_ref,@response_status,@response_headers,
        @response_body_ref,@duration_ms,@rule_id,@decision,@agent_id)`),
      getById: db.prepare('SELECT * FROM request_log WHERE id = ?'),
      cleanup: db.prepare('DELETE FROM request_log WHERE timestamp < ?'),
    };
  }

  /**
   * Inserts a new request log entry and returns the full row (with generated ID and timestamp).
   * @param {Object} entry - Log data from the Go proxy IPC message.
   * @returns {Promise<import('../interfaces.js').RequestLogEntry>}
   */
  async insert(entry) {
    const info = this.#stmts.insert.run({
      method: entry.method, url: entry.url,
      request_headers: entry.request_headers ?? null,
      request_body_ref: entry.request_body_ref ?? null,
      response_status: entry.response_status ?? null,
      response_headers: entry.response_headers ?? null,
      response_body_ref: entry.response_body_ref ?? null,
      duration_ms: entry.duration_ms ?? null,
      rule_id: entry.rule_id ?? null,
      decision: entry.decision, agent_id: entry.agent_id ?? null,
    });
    return this.getById(info.lastInsertRowid);
  }

  /** @param {number} id @returns {Promise<import('../interfaces.js').RequestLogEntry|null>} */
  async getById(id) { return this.#stmts.getById.get(id) ?? null; }

  /**
   * Queries log entries with optional filters. Builds a dynamic WHERE clause
   * from the provided filter keys.
   *
   * @param {Object} [filters={}]
   * @param {string} [filters.method] - Exact HTTP method match.
   * @param {string} [filters.decision] - Exact decision match (allowed/denied/held/queued).
   * @param {string} [filters.url] - Substring match (LIKE %url%).
   * @param {string} [filters.from] - Minimum timestamp (inclusive).
   * @param {string} [filters.to] - Maximum timestamp (inclusive).
   * @param {string} [filters.agent_id] - Exact agent_id match.
   * @param {number} [filters.limit=50] - Maximum rows to return.
   * @param {number} [filters.offset=0] - Number of rows to skip.
   * @returns {Promise<import('../interfaces.js').RequestLogEntry[]>} Entries ordered by ID descending (newest first).
   */
  async query(filters = {}) {
    const conds = [], params = {};
    if (filters.method)   { conds.push('method=@method');     params.method = filters.method; }
    if (filters.decision) { conds.push('decision=@decision'); params.decision = filters.decision; }
    if (filters.url)      { conds.push('url LIKE @url');      params.url = `%${filters.url}%`; }
    if (filters.from)     { conds.push('timestamp>=@from');   params.from = filters.from; }
    if (filters.to)       { conds.push('timestamp<=@to');     params.to = filters.to; }
    if (filters.agent_id) { conds.push('agent_id=@agent_id'); params.agent_id = filters.agent_id; }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.#db.prepare(
      `SELECT * FROM request_log ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit: filters.limit ?? 50, offset: filters.offset ?? 0 });
  }

  /**
   * Deletes log entries older than the specified timestamp.
   * @param {string|Date} olderThan - ISO timestamp string or Date object.
   * @returns {Promise<number>} Number of rows deleted.
   */
  async cleanup(olderThan) {
    const iso = olderThan instanceof Date ? olderThan.toISOString() : olderThan;
    return this.#stmts.cleanup.run(iso).changes;
  }
}
