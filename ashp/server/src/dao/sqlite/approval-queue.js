/**
 * @module dao/sqlite/approval-queue
 * @description SQLite implementation of ApprovalQueueDAO. Manages the queue of requests
 * awaiting human approval.
 *
 * Correlation flow:
 * 1. The Go proxy sends an `approval.needed` IPC message with a unique `msg_id`.
 *    The proxy holds the TCP connection open, waiting for a response referencing that `msg_id`.
 * 2. This DAO stores the `ipc_msg_id` alongside the approval entry.
 * 3. When a human approves/rejects via the API, `resolve()` returns the entry with its
 *    `ipc_msg_id`, which the approvals route uses to send an `approval.resolve` IPC message
 *    back to the proxy (see api/approvals.js).
 */
import { ApprovalQueueDAO } from '../interfaces.js';

/**
 * SQLite-backed approval queue data access object.
 * @extends ApprovalQueueDAO
 */
export class SqliteApprovalQueueDAO extends ApprovalQueueDAO {
  #stmts;

  /**
   * @param {import('better-sqlite3').Database} db - Initialized SQLite connection.
   */
  constructor(db) {
    super();
    this.#stmts = {
      insert: db.prepare(`INSERT INTO approval_queue (request_log_id,ipc_msg_id,suggested_pattern,
        suggested_methods) VALUES (@request_log_id,@ipc_msg_id,@suggested_pattern,@suggested_methods)`),
      getById: db.prepare('SELECT * FROM approval_queue WHERE id = ?'),
      listPending: db.prepare(`SELECT a.*, r.method, r.url
        FROM approval_queue a LEFT JOIN request_log r ON a.request_log_id = r.id
        WHERE a.status='pending' ORDER BY a.created_at ASC`),
      resolve: db.prepare(`UPDATE approval_queue SET status=@status,
        resolved_at=datetime('now'), resolved_by=@resolved_by, create_rule=@create_rule
        WHERE id=@id AND status='pending'`),
    };
  }

  /**
   * Adds a request to the approval queue.
   *
   * @param {Object} entry
   * @param {number} entry.request_log_id - FK to the request_log row.
   * @param {string} [entry.ipc_msg_id] - IPC message ID for correlating the response back to the Go proxy.
   * @param {string} [entry.suggested_pattern] - Suggested URL regex pattern for auto-rule creation.
   * @param {string[]} [entry.suggested_methods] - Suggested HTTP methods for auto-rule creation.
   * @returns {Promise<import('../interfaces.js').ApprovalEntry>}
   */
  async enqueue(entry) {
    const info = this.#stmts.insert.run({
      request_log_id: entry.request_log_id,
      ipc_msg_id: entry.ipc_msg_id ?? null,
      suggested_pattern: entry.suggested_pattern ?? null,
      suggested_methods: entry.suggested_methods ? JSON.stringify(entry.suggested_methods) : null,
    });
    return this.#stmts.getById.get(info.lastInsertRowid);
  }

  /**
   * Resolves a pending approval entry. Only updates rows with `status='pending'`
   * to prevent double-resolution.
   *
   * @param {number} id - Approval queue entry ID.
   * @param {Object} action
   * @param {'approve'|'reject'|'approved'|'rejected'} action.action - Resolution action
   *   (both verb and past-tense forms are accepted and normalized).
   * @param {string} [action.resolved_by] - Who resolved it (e.g. 'api', username).
   * @param {boolean} [action.create_rule] - Whether to auto-create a rule from the suggested pattern.
   * @returns {Promise<import('../interfaces.js').ApprovalEntry|null>} The resolved entry, or null if not found/already resolved.
   */
  async resolve(id, action) {
    const statusMap = { approve: 'approved', reject: 'rejected', approved: 'approved', rejected: 'rejected' };
    const status = statusMap[action.action] ?? action.action;
    const info = this.#stmts.resolve.run({
      id, status,
      resolved_by: action.resolved_by ?? null,
      create_rule: action.create_rule ? 1 : 0,
    });
    if (info.changes === 0) return null;
    return this.#stmts.getById.get(id);
  }

  /** @returns {Promise<import('../interfaces.js').ApprovalEntry[]>} All pending approvals, oldest first. */
  async listPending() { return this.#stmts.listPending.all(); }
}
