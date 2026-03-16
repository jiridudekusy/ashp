import { ApprovalQueueDAO } from '../interfaces.js';

export class SqliteApprovalQueueDAO extends ApprovalQueueDAO {
  #stmts;
  constructor(db) {
    super();
    this.#stmts = {
      insert: db.prepare(`INSERT INTO approval_queue (request_log_id,ipc_msg_id,suggested_pattern,
        suggested_methods) VALUES (@request_log_id,@ipc_msg_id,@suggested_pattern,@suggested_methods)`),
      getById: db.prepare('SELECT * FROM approval_queue WHERE id = ?'),
      listPending: db.prepare("SELECT * FROM approval_queue WHERE status='pending' ORDER BY created_at ASC"),
      resolve: db.prepare(`UPDATE approval_queue SET status=@status,
        resolved_at=datetime('now'), resolved_by=@resolved_by, create_rule=@create_rule
        WHERE id=@id AND status='pending'`),
    };
  }
  async enqueue(entry) {
    const info = this.#stmts.insert.run({
      request_log_id: entry.request_log_id,
      ipc_msg_id: entry.ipc_msg_id ?? null,
      suggested_pattern: entry.suggested_pattern ?? null,
      suggested_methods: entry.suggested_methods ? JSON.stringify(entry.suggested_methods) : null,
    });
    return this.#stmts.getById.get(info.lastInsertRowid);
  }
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
  async listPending() { return this.#stmts.listPending.all(); }
}
