import { RulesDAO } from '../interfaces.js';

function deserialize(row) {
  if (!row) return null;
  return { ...row, methods: JSON.parse(row.methods), enabled: !!row.enabled };
}

export class SqliteRulesDAO extends RulesDAO {
  #db;
  #stmts;

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
    };
  }

  async list() {
    return this.#stmts.list.all().map(deserialize);
  }

  async get(id) {
    return deserialize(this.#stmts.get.get(id));
  }

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

  async delete(id) {
    this.#stmts.delete.run(id);
  }

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
