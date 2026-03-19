import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { AgentsDAO } from '../interfaces.js';

const SALT_ROUNDS = 10;

function generateToken() {
  return randomBytes(32).toString('hex');
}

function deserialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    request_count: row.request_count,
    created_at: row.created_at,
  };
}

export class SqliteAgentsDAO extends AgentsDAO {
  #stmts;

  constructor(db) {
    super();
    this.#stmts = {
      list: db.prepare('SELECT id, name, enabled, request_count, created_at FROM agents ORDER BY id'),
      get: db.prepare('SELECT id, name, enabled, request_count, created_at FROM agents WHERE id = ?'),
      getByName: db.prepare('SELECT * FROM agents WHERE name = ?'),
      insert: db.prepare('INSERT INTO agents (name, token_hash) VALUES (@name, @token_hash)'),
      update: db.prepare('UPDATE agents SET name = @name, enabled = @enabled WHERE id = @id'),
      delete: db.prepare('DELETE FROM agents WHERE id = ?'),
      deleteRequestLogs: db.prepare('DELETE FROM request_log WHERE agent_id = (SELECT name FROM agents WHERE id = ?)'),
      updateTokenHash: db.prepare('UPDATE agents SET token_hash = ? WHERE id = ?'),
      incrementRequestCount: db.prepare('UPDATE agents SET request_count = request_count + 1 WHERE name = ?'),
      listForProxy: db.prepare('SELECT name, token_hash, enabled FROM agents'),
    };
  }

  async list() {
    return this.#stmts.list.all().map(deserialize);
  }

  async get(id) {
    return deserialize(this.#stmts.get.get(id));
  }

  async create({ name }) {
    const token = generateToken();
    const token_hash = await bcrypt.hash(token, SALT_ROUNDS);
    const info = this.#stmts.insert.run({ name, token_hash });
    const agent = deserialize(this.#stmts.get.get(info.lastInsertRowid));
    return { ...agent, token };
  }

  async update(id, fields) {
    const current = this.#stmts.get.get(id);
    if (!current) return null;
    this.#stmts.update.run({
      id,
      name: fields.name ?? current.name,
      enabled: (fields.enabled ?? !!current.enabled) ? 1 : 0,
    });
    return deserialize(this.#stmts.get.get(id));
  }

  async delete(id) {
    this.#stmts.deleteRequestLogs.run(id);
    this.#stmts.delete.run(id);
  }

  async rotateToken(id) {
    const current = this.#stmts.get.get(id);
    if (!current) return null;
    const token = generateToken();
    const token_hash = await bcrypt.hash(token, SALT_ROUNDS);
    this.#stmts.updateTokenHash.run(token_hash, id);
    return { token };
  }

  async authenticate(name, token) {
    const row = this.#stmts.getByName.get(name);
    if (!row || !row.enabled) return null;
    const match = await bcrypt.compare(token, row.token_hash);
    return match ? deserialize(row) : null;
  }

  async incrementRequestCount(name) {
    this.#stmts.incrementRequestCount.run(name);
  }

  listForProxy() {
    return this.#stmts.listForProxy.all().map(row => ({
      name: row.name,
      token_hash: row.token_hash,
      enabled: !!row.enabled,
    }));
  }
}
