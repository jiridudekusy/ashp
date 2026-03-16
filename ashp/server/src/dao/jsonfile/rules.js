import { RulesDAO } from '../interfaces.js';
import { readFileSync } from 'node:fs';

function readOnly() { return Promise.reject(new Error('Rules are read-only in file mode')); }

export class JsonFileRulesDAO extends RulesDAO {
  #path; #rules = [];
  constructor(filePath) { super(); this.#path = filePath; this.reload(); }

  reload() {
    const data = JSON.parse(readFileSync(this.#path, 'utf-8'));
    this.#rules = (data.rules || []).map((r, i) => ({
      id: i + 1, name: r.name ?? '', url_pattern: r.url_pattern,
      methods: r.methods ?? [], action: r.action, priority: r.priority ?? 0,
      agent_id: r.agent_id ?? null,
      log_request_body: r.log_request_body ?? 'full',
      log_response_body: r.log_response_body ?? 'full',
      default_behavior: r.default_behavior ?? null,
      enabled: r.enabled !== false,
    })).sort((a, b) => b.priority - a.priority);
  }

  async list() { return [...this.#rules]; }
  async get(id) { return this.#rules.find(r => r.id === id) ?? null; }
  async match(url, method) {
    for (const rule of this.#rules) {
      if (!rule.enabled) continue;
      try {
        if (!new RegExp(rule.url_pattern).test(url)) continue;
        if (rule.methods.length > 0 && !rule.methods.includes(method)) continue;
        return rule;
      } catch { continue; }
    }
    return null;
  }
  async create() { return readOnly(); }
  async update() { return readOnly(); }
  async delete() { return readOnly(); }
}
