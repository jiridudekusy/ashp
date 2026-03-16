import { RequestLogDAO } from '../interfaces.js';

export class SqliteRequestLogDAO extends RequestLogDAO {
  #db; #stmts;
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
  async getById(id) { return this.#stmts.getById.get(id) ?? null; }
  async query(filters = {}) {
    const conds = [], params = {};
    if (filters.method)   { conds.push('method=@method');     params.method = filters.method; }
    if (filters.decision) { conds.push('decision=@decision'); params.decision = filters.decision; }
    if (filters.url)      { conds.push('url LIKE @url');      params.url = `%${filters.url}%`; }
    if (filters.from)     { conds.push('timestamp>=@from');   params.from = filters.from; }
    if (filters.to)       { conds.push('timestamp<=@to');     params.to = filters.to; }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.#db.prepare(
      `SELECT * FROM request_log ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit: filters.limit ?? 50, offset: filters.offset ?? 0 });
  }
  async cleanup(olderThan) {
    const iso = olderThan instanceof Date ? olderThan.toISOString() : olderThan;
    return this.#stmts.cleanup.run(iso).changes;
  }
}
