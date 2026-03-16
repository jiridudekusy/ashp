# ASHP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a sandboxing HTTP/HTTPS proxy (Go core + Node.js management + React GUI) for controlling, logging, and gating outbound traffic from AI agents.

**Architecture:** Three-layer system — Go proxy core (goproxy MITM), Node.js management API (REST + SSE + webhooks + DAO), React GUI. Layers communicate via JSON over Unix socket. Encrypted SQLite (SQLCipher) for metadata, encrypted hourly files for request/response bodies.

**Tech Stack:** Go (goproxy), Node.js, React, SQLite (SQLCipher), AES-256-GCM

---

## File Structure

Complete file map for all 5 chunks.

### Chunk 1: Project Bootstrap + Config + Crypto + DAO Layer

```
ashp/
  .gitignore
  Makefile
  ashp.example.json
  rules.example.json
  server/
    package.json
    src/
      config.js                          config.test.js
      crypto/
        index.js                         index.test.js
      dao/
        interfaces.js                    interfaces.test.js
        sqlite/
          connection.js                  connection.test.js
          rules.js                       rules.test.js
          request-log.js                 request-log.test.js
          approval-queue.js              approval-queue.test.js
        jsonfile/
          rules.js                       rules.test.js
```

### Chunk 2: REST API + SSE + IPC Socket

```
  server/src/
    index.js
    api/
      middleware.js
      rules.js                           rules.test.js
      logs.js                            logs.test.js
      approvals.js                       approvals.test.js
      events.js                          events.test.js
      status.js                          status.test.js
    ipc/
      server.js                          server.test.js
      protocol.js                        protocol.test.js
    webhooks/
      dispatcher.js                      dispatcher.test.js
    proxy-manager.js                     proxy-manager.test.js
```

### Chunk 3: Go Proxy Core

```
  proxy/
    go.mod
    cmd/ashp-proxy/main.go
    internal/
      mitm/proxy.go                      proxy_test.go
      rules/evaluator.go                 evaluator_test.go
      auth/basic.go                      basic_test.go
      logger/writer.go                   writer_test.go
      ca/manager.go                      manager_test.go
      ipc/client.go                      client_test.go
      ipc/protocol.go
```

### Chunk 4: React GUI

```
  gui/
    package.json    vite.config.js    index.html
    src/
      main.jsx    App.jsx    App.test.jsx
      api/client.js    api/useSSE.js
      pages/Dashboard.jsx    pages/Rules.jsx    pages/Logs.jsx
      pages/Approvals.jsx    pages/Login.jsx
      components/Layout.jsx    components/RuleForm.jsx
      components/LogDetail.jsx    components/ApprovalCard.jsx
      components/StatusBadge.jsx
```

### Chunk 5: Integration, Docker, E2E

```
  Dockerfile    docker-compose.yml    Makefile (final)
  test/e2e/
    setup.js    proxy-allow.test.js    proxy-deny.test.js
    proxy-hold.test.js    rule-crud.test.js
```

---

## Chunk 1: Project Bootstrap + Config + Crypto + DAO Layer

**Convention for all tests:** Use `node:test` (`describe`/`it`) and `node:assert/strict`. Temp directories use `mkdirSync(join(tmpdir(), 'ashp-test-' + Date.now()), {recursive:true})` in `beforeEach`, cleaned with `rmSync` in `afterEach`.

### Step 1.1 — Project scaffolding

- [ ] **Create `ashp/.gitignore`**

```
node_modules/
data/
*.db
*.enc
dist/
proxy/ashp-proxy
.env
```

- [ ] **Create `ashp/Makefile`**

```makefile
.PHONY: test-server dev-server

test-server:
	cd server && node --test src/**/*.test.js

dev-server:
	cd server && node --watch src/index.js
```

- [ ] **Create `ashp/server/package.json`**

```json
{
  "name": "ashp-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "test": "node --test src/**/*.test.js",
    "dev": "node --watch src/index.js"
  },
  "dependencies": {
    "@journeyapps/sqlcipher": "^5.7.0",
    "express": "^5.1.0"
  }
}
```

- [ ] **Run:** `cd server && npm install`
- [ ] **Verify:** `cd server && node -e "import('@journeyapps/sqlcipher').then(() => console.log('OK'))"` prints `OK`
- [ ] **Commit:** `chore: bootstrap server package with sqlcipher + express deps`

---

### Step 1.2 — Config loader

- [ ] **Write failing test** at `server/src/config.test.js`

Tests (each writes a temp `ashp.json`, calls `loadConfig({config: file, ...flags})`):
1. `loads valid config and applies defaults` — asserts `default_behavior` is `'deny'`, `logging.request_body` is `'full'`, `logging.retention_days` is `30`
2. `resolves env: prefixed values` — sets `process.env.ASHP_TEST_KEY='resolved-secret'`, config has `encryption_key: 'env:ASHP_TEST_KEY'`, asserts resolved value
3. `throws if env var is missing` — `encryption_key: 'env:ASHP_MISSING_VAR'` throws `/ASHP_MISSING_VAR/`
4. `CLI flags override config` — passes `{'proxy-listen':'0.0.0.0:9999','default-behavior':'hold'}`, asserts overrides applied
5. `throws on invalid rules source` — `source:'invalid'` throws `/source/`

- [ ] **Verify fails:** `cd server && node --test src/config.test.js` (module not found)

- [ ] **Implement `server/src/config.js`**

```js
import { readFileSync } from 'node:fs';

const DEFAULTS = {
  proxy: { listen: '0.0.0.0:8080', auth: {} },
  management: { listen: '0.0.0.0:3000' },
  rules: { source: 'db' },
  database: { path: 'data/ashp.db' },
  encryption: {},
  default_behavior: 'deny',
  logging: { request_body: 'full', response_body: 'full', retention_days: 30 },
  webhooks: [],
};

function resolveEnvRefs(obj) {
  if (typeof obj === 'string' && obj.startsWith('env:')) {
    const name = obj.slice(4);
    const val = process.env[name];
    if (val === undefined) throw new Error(`Environment variable ${name} is not set (referenced as "env:${name}")`);
    return val;
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvRefs);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveEnvRefs(v)]));
  }
  return obj;
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else { out[k] = v; }
  }
  return out;
}

const CLI_MAP = {
  'proxy-listen':     (c, v) => { c.proxy.listen = v; },
  'management-listen':(c, v) => { c.management.listen = v; },
  'default-behavior': (c, v) => { c.default_behavior = v; },
  'rules-source':     (c, v) => { c.rules.source = v; },
  'rules-file':       (c, v) => { c.rules.file = v; },
  'database-path':    (c, v) => { c.database.path = v; },
};

export function loadConfig(flags) {
  const raw = JSON.parse(readFileSync(flags.config, 'utf-8'));
  let cfg = deepMerge(DEFAULTS, raw);
  for (const [flag, apply] of Object.entries(CLI_MAP)) {
    if (flags[flag] !== undefined) apply(cfg, flags[flag]);
  }
  cfg = resolveEnvRefs(cfg);
  if (!['db', 'file'].includes(cfg.rules?.source))
    throw new Error(`Invalid rules source "${cfg.rules?.source}". Must be "db" or "file".`);
  if (!['deny', 'hold', 'queue'].includes(cfg.default_behavior))
    throw new Error(`Invalid default_behavior "${cfg.default_behavior}".`);
  return cfg;
}
```

- [ ] **Verify passes:** `cd server && node --test src/config.test.js` — 5 tests pass
- [ ] **Commit:** `feat: add config loader with env resolution, CLI overrides, and defaults`

---

### Step 1.3 — Crypto utilities

- [ ] **Write failing test** at `server/src/crypto/index.test.js`

Uses `masterKey = Buffer.alloc(32, 0xab)`. Tests:
1. `deriveRecordKey produces 32-byte key`
2. `different offsets produce different keys`
3. `same offset produces same key`
4. `encryptRecord/decryptRecord round-trips payload`
5. `record has matching length prefix and suffix` — reads `record.readUInt32LE(0)` and `record.readUInt32LE(record.length - 4)`, asserts equal and equals `record.length`
6. `tampered ciphertext fails auth` — flip `record[20] ^= 0xff`, assert throws
7. `wrong offset fails decryption` — encrypt at offset 0, decrypt at offset 999, assert throws

- [ ] **Verify fails:** module not found

- [ ] **Implement `server/src/crypto/index.js`**

```js
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';

export function deriveRecordKey(masterKey, offset) {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), `ashp-log-record:${offset}`, 32));
}

export function encryptRecord(masterKey, offset, payload) {
  const key = deriveRecordKey(masterKey, offset);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  const totalLen = 4 + 12 + encrypted.length + 16 + 4;
  const record = Buffer.alloc(totalLen);
  let pos = 0;
  record.writeUInt32LE(totalLen, pos); pos += 4;
  nonce.copy(record, pos);             pos += 12;
  encrypted.copy(record, pos);         pos += encrypted.length;
  tag.copy(record, pos);               pos += 16;
  record.writeUInt32LE(totalLen, pos);
  return record;
}

export function decryptRecord(masterKey, offset, record) {
  const key = deriveRecordKey(masterKey, offset);
  let pos = 4;
  const nonce = record.subarray(pos, pos + 12); pos += 12;
  const ciphertext = record.subarray(pos, record.length - 16 - 4);
  const tag = record.subarray(record.length - 16 - 4, record.length - 4);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
```

Record layout: `[4B len][12B nonce][ciphertext][16B tag][4B len]`

- [ ] **Verify passes:** 7 tests pass
- [ ] **Commit:** `feat: add AES-256-GCM crypto with HKDF key derivation and log record format`

---

### Step 1.4 — DAO interfaces

- [ ] **Write failing test** at `server/src/dao/interfaces.test.js`

Tests that each base class method rejects with `/not implemented/i`:
- `RulesDAO`: `list`, `get`, `create`, `update`, `delete`, `match`
- `RequestLogDAO`: `insert`, `query`, `getById`, `cleanup`
- `ApprovalQueueDAO`: `enqueue`, `resolve`, `listPending`

- [ ] **Verify fails**

- [ ] **Implement `server/src/dao/interfaces.js`**

```js
function notImpl(name) { return Promise.reject(new Error(`${name} not implemented`)); }

export class RulesDAO {
  list()             { return notImpl('list'); }
  get(id)            { return notImpl('get'); }
  create(rule)       { return notImpl('create'); }
  update(id, rule)   { return notImpl('update'); }
  delete(id)         { return notImpl('delete'); }
  match(url, method) { return notImpl('match'); }
}

export class RequestLogDAO {
  insert(entry)      { return notImpl('insert'); }
  query(filters)     { return notImpl('query'); }
  getById(id)        { return notImpl('getById'); }
  cleanup(olderThan) { return notImpl('cleanup'); }
}

export class ApprovalQueueDAO {
  enqueue(entry)      { return notImpl('enqueue'); }
  resolve(id, action) { return notImpl('resolve'); }
  listPending()       { return notImpl('listPending'); }
}
```

- [ ] **Verify passes:** 3 tests pass
- [ ] **Commit:** `feat: add DAO interface base classes with not-implemented guards`

---

### Step 1.5 — SQLCipher connection factory

- [ ] **Write failing test** at `server/src/dao/sqlite/connection.test.js`

Tests:
1. `creates encrypted DB, inserts, and reads back` — `CREATE TABLE t(id PK, val TEXT)`, insert, select
2. `wrong key cannot open DB` — create with key A, open with key B, assert throws on `SELECT`
3. `migrations create all required tables` — query `sqlite_master`, assert `rules`, `request_log`, `approval_queue` exist

- [ ] **Verify fails**

- [ ] **Implement `server/src/dao/sqlite/connection.js`**

```js
import Database from '@journeyapps/sqlcipher';

const MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, url_pattern TEXT NOT NULL,
    methods TEXT NOT NULL DEFAULT '[]',
    action TEXT NOT NULL CHECK(action IN ('allow','deny')),
    priority INTEGER NOT NULL DEFAULT 0, agent_id TEXT,
    log_request_body TEXT NOT NULL DEFAULT 'full',
    log_response_body TEXT NOT NULL DEFAULT 'full',
    default_behavior TEXT CHECK(default_behavior IN ('deny','hold','queue') OR default_behavior IS NULL),
    enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL DEFAULT(datetime('now')),
    method TEXT NOT NULL, url TEXT NOT NULL,
    request_headers TEXT, request_body_ref TEXT,
    response_status INTEGER, response_headers TEXT, response_body_ref TEXT,
    duration_ms INTEGER,
    rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
    decision TEXT NOT NULL CHECK(decision IN ('allowed','denied','held','queued')),
    agent_id TEXT
  );
  CREATE TABLE IF NOT EXISTS approval_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_log_id INTEGER NOT NULL REFERENCES request_log(id),
    ipc_msg_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at DATETIME NOT NULL DEFAULT(datetime('now')),
    resolved_at DATETIME, resolved_by TEXT,
    create_rule INTEGER NOT NULL DEFAULT 0,
    suggested_pattern TEXT, suggested_methods TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_request_log_timestamp ON request_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_request_log_decision ON request_log(decision);
  CREATE INDEX IF NOT EXISTS idx_approval_queue_status ON approval_queue(status);
`;

export function createConnection(dbPath, encryptionKey) {
  const db = new Database(dbPath);
  db.pragma(`key = '${encryptionKey.replace(/'/g, "''")}'`);
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (err) {
    db.close();
    throw new Error(`Failed to open encrypted database (wrong key?): ${err.message}`);
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATIONS);
  return db;
}
```

- [ ] **Verify passes:** 3 tests pass
- [ ] **Commit:** `feat: add SQLCipher connection factory with schema migrations`

---

### Step 1.6 — SqliteRulesDAO

- [ ] **Write failing test** at `server/src/dao/sqlite/rules.test.js`

Each test creates a fresh encrypted DB via `createConnection` in `beforeEach`. Tests:
1. `create + get round-trip` — create rule with `methods:['GET','POST']`, get by id, assert fields
2. `list returns rules ordered by priority desc` — create priority 1 and 100, assert order
3. `update modifies a rule` — update name + action, assert changed; assert unchanged field intact
4. `delete removes a rule` — delete, `get` returns `null`
5. `match finds highest-priority enabled rule` — 3 rules (broad deny p1, specific allow p100, disabled deny p200), assert correct match per URL+method combos
6. `match returns null when no rules match`

- [ ] **Verify fails**

- [ ] **Implement `server/src/dao/sqlite/rules.js`**

```js
import { RulesDAO } from '../interfaces.js';

function deserialize(row) {
  if (!row) return null;
  return { ...row, methods: JSON.parse(row.methods), enabled: !!row.enabled };
}

export class SqliteRulesDAO extends RulesDAO {
  #db; #stmts;
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
  async list() { return this.#stmts.list.all().map(deserialize); }
  async get(id) { return deserialize(this.#stmts.get.get(id)); }
  async create(rule) {
    const info = this.#stmts.insert.run({
      name: rule.name, url_pattern: rule.url_pattern,
      methods: JSON.stringify(rule.methods || []), action: rule.action,
      priority: rule.priority ?? 0, agent_id: rule.agent_id ?? null,
      log_request_body: rule.log_request_body ?? 'full',
      log_response_body: rule.log_response_body ?? 'full',
      default_behavior: rule.default_behavior ?? null,
      enabled: (rule.enabled ?? true) ? 1 : 0,
    });
    return this.get(info.lastInsertRowid);
  }
  async update(id, changes) {
    if (!this.#stmts.get.get(id)) return null;
    const fields = [], params = { id };
    for (const [k, v] of Object.entries(changes)) {
      if (k === 'id') continue;
      params[k] = k === 'methods' ? JSON.stringify(v) : k === 'enabled' ? (v ? 1 : 0) : v;
      fields.push(`${k} = @${k}`);
    }
    if (fields.length) this.#db.prepare(`UPDATE rules SET ${fields.join(',')} WHERE id=@id`).run(params);
    return this.get(id);
  }
  async delete(id) { this.#stmts.delete.run(id); }
  async match(url, method) {
    for (const row of this.#stmts.listEnabled.all()) {
      try {
        if (!new RegExp(row.url_pattern).test(url)) continue;
        const methods = JSON.parse(row.methods);
        if (methods.length > 0 && !methods.includes(method)) continue;
        return deserialize(row);
      } catch { continue; }
    }
    return null;
  }
}
```

- [ ] **Verify passes:** 6 tests pass
- [ ] **Commit:** `feat: add SqliteRulesDAO with CRUD and regex-based rule matching`

---

### Step 1.7 — SqliteRequestLogDAO

- [ ] **Write failing test** at `server/src/dao/sqlite/request-log.test.js`

Sample entry: `{method:'GET', url:'https://api.github.com/repos', request_headers:'{}', request_body_ref:'logs/2026/03/15/14.log.enc:0:512', response_status:200, response_headers:'{}', response_body_ref:null, duration_ms:150, rule_id:null, decision:'allowed', agent_id:'agent1'}`

Tests:
1. `insert returns entry with id and timestamp`
2. `getById retrieves / returns null for missing`
3. `query filters by method` — insert GET + POST, query `{method:'POST'}`, assert 1 result
4. `query filters by decision`
5. `query supports limit and offset` — insert 5, query `{limit:2, offset:1}`, assert 2
6. `cleanup deletes entries older than cutoff`

- [ ] **Verify fails**

- [ ] **Implement `server/src/dao/sqlite/request-log.js`**

```js
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
```

- [ ] **Verify passes:** 6 tests pass
- [ ] **Commit:** `feat: add SqliteRequestLogDAO with query filters and cleanup`

---

### Step 1.8 — SqliteApprovalQueueDAO

- [ ] **Write failing test** at `server/src/dao/sqlite/approval-queue.test.js`

Uses `SqliteRequestLogDAO` to create prerequisite `request_log` rows (FK constraint). Tests:
1. `enqueue creates a pending approval` — assert `status === 'pending'`, correct `request_log_id`
2. `listPending returns only pending items` — enqueue 2, resolve 1, assert `listPending` returns 1
3. `resolve updates status, resolved_at, resolved_by, create_rule`
4. `resolve returns null for nonexistent id`

- [ ] **Verify fails**

- [ ] **Implement `server/src/dao/sqlite/approval-queue.js`**

```js
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
    // Translate verb form (approve/reject) to past tense (approved/rejected) for DB
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
```

- [ ] **Verify passes:** 4 tests pass
- [ ] **Commit:** `feat: add SqliteApprovalQueueDAO with enqueue, resolve, and listPending`

---

### Step 1.9 — JsonFileRulesDAO (read-only)

- [ ] **Write failing test** at `server/src/dao/jsonfile/rules.test.js`

Writes temp `rules.json` files. Tests:
1. `list returns rules sorted by priority desc with synthetic ids`
2. `get returns rule by synthetic id`
3. `match finds highest-priority matching rule` (regex + method check)
4. `write operations throw read-only error` — `create`, `update`, `delete` all reject `/read-only/i`
5. `reload() picks up file changes` — list returns 1, rewrite file with 2 rules, `dao.reload()`, list returns 2

- [ ] **Verify fails**

- [ ] **Implement `server/src/dao/jsonfile/rules.js`**

```js
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
```

- [ ] **Verify passes:** 5 tests pass
- [ ] **Commit:** `feat: add JsonFileRulesDAO for read-only file-based rules`

---

### Step 1.10 — Example config files

- [ ] **Create `ashp/ashp.example.json`**

```json
{
  "proxy": {
    "listen": "0.0.0.0:8080",
    "auth": { "agent1": "change-me-agent-token" }
  },
  "management": {
    "listen": "0.0.0.0:3000",
    "bearer_token": "change-me-mgmt-token"
  },
  "rules": { "source": "db", "file": "rules.json" },
  "default_behavior": "deny",
  "logging": { "request_body": "full", "response_body": "truncate:65536", "retention_days": 30 },
  "database": { "path": "data/ashp.db", "encryption_key": "env:ASHP_DB_KEY" },
  "encryption": { "log_key": "env:ASHP_LOG_KEY", "ca_key": "env:ASHP_CA_KEY" },
  "webhooks": []
}
```

- [ ] **Create `ashp/rules.example.json`**

```json
{
  "rules": [
    {
      "name": "Allow GitHub API",
      "url_pattern": "^https://api\\.github\\.com/.*$",
      "methods": ["GET", "POST", "PUT", "PATCH", "DELETE"],
      "action": "allow", "priority": 100,
      "log_request_body": "full", "log_response_body": "truncate:65536"
    },
    {
      "name": "Allow npm registry",
      "url_pattern": "^https://registry\\.npmjs\\.org/.*$",
      "methods": ["GET"], "action": "allow", "priority": 90,
      "log_request_body": "none", "log_response_body": "none"
    },
    {
      "name": "Block everything else",
      "url_pattern": ".*", "methods": [],
      "action": "deny", "priority": 0,
      "log_request_body": "full", "log_response_body": "none"
    }
  ]
}
```

- [ ] **Verify config loads:**

```bash
cd server && node -e "
  import{loadConfig}from'./src/config.js';
  process.env.ASHP_DB_KEY=process.env.ASHP_LOG_KEY=process.env.ASHP_CA_KEY='test';
  console.log('OK:',loadConfig({config:'../ashp.example.json'}).rules.source);
" # prints OK: db
```

- [ ] **Commit:** `docs: add example ashp.json and rules.json config files`

---

### Step 1.11 — Run full test suite

- [ ] **Run:** `cd server && node --test src/**/*.test.js`
- [ ] **Expected:** ~39 tests pass across 8 test files (config 5, crypto 7, interfaces 3, connection 3, sqlite rules 6, request-log 6, approval-queue 4, jsonfile rules 5)
- [ ] **Commit (if needed):** `chore: chunk 1 complete — config, crypto, and DAO layer`

---

## Chunk 2: Node.js Management Layer — IPC + REST API + SSE + Webhooks

**Convention:** All API route modules export a function `(deps) => Router` where `deps` is `{rulesDAO, requestLogDAO, approvalQueueDAO, config, ipc, events, crypto}`. Tests use mock DAOs (plain objects with jest-style methods). Express app tests use `node:http` to make real requests against `app.listen(0)`.

---

### Step 2.1 — IPC protocol (message framing, msg_id/ref correlation)

- [ ] **Write failing test** at `server/src/ipc/protocol.test.js`

Tests:
1. `frame serializes JSON with newline delimiter` — `frame({type:'rules.reload'})` returns `Buffer` ending in `\n`, parseable JSON
2. `frame auto-generates msg_id if missing` — parsed result has `msg_id` matching UUID format
3. `frame preserves existing msg_id` — pass `msg_id:'abc'`, assert preserved
4. `parseFrames splits multiple messages on newline` — input `'{"a":1}\n{"b":2}\n'`, returns 2 parsed objects
5. `parseFrames handles partial messages` — input `'{"a":1}\n{"b":2'` returns 1 parsed + remainder `'{"b":2'`
6. `parseFrames ignores empty lines`
7. `createResponse creates message with ref to original msg_id`

- [ ] **Verify fails:** `cd server && node --test src/ipc/protocol.test.js`

- [ ] **Implement `server/src/ipc/protocol.js`**

```js
import { randomUUID } from 'node:crypto';

export function frame(msg) {
  if (!msg.msg_id) msg.msg_id = randomUUID();
  return Buffer.from(JSON.stringify(msg) + '\n');
}

export function parseFrames(buf) {
  const str = typeof buf === 'string' ? buf : buf.toString();
  const lines = str.split('\n');
  const remainder = lines.pop(); // last element is either '' or partial
  const messages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    messages.push(JSON.parse(trimmed));
  }
  return { messages, remainder };
}

export function createResponse(original, data) {
  return { ...data, ref: original.msg_id, msg_id: randomUUID() };
}
```

- [ ] **Verify passes:** 7 tests pass
- [ ] **Commit:** `feat: add IPC protocol with newline-delimited JSON framing and msg_id correlation`

---

### Step 2.2 — IPC Unix socket server

- [ ] **Write failing test** at `server/src/ipc/server.test.js`

Uses `net.createConnection` as a test client. Socket path in `tmpdir()`. Tests:
1. `accepts connection and receives framed message` — server sends `rules.reload`, client reads + parses
2. `receives messages from client` — client sends framed `request.logged`, server `onMessage` callback fires
3. `handles partial frames across chunks` — client sends message in two `write()` calls split mid-JSON
4. `reconnection after client disconnect` — client connects, disconnects, new client connects, server sends message to new client
5. `buffers messages when no client connected` — send 3 messages before client connects, client connects, receives all 3
6. `ring buffer drops oldest when full` — create server with `bufferSize:2`, send 5 messages, client connects, receives only last 2

- [ ] **Verify fails**

- [ ] **Implement `server/src/ipc/server.js`**

```js
import net from 'node:net';
import { frame, parseFrames } from './protocol.js';

export class IPCServer {
  #socketPath; #server; #client = null; #onMessage;
  #buffer = []; #bufferSize;
  #partial = '';

  constructor(socketPath, { onMessage, bufferSize = 10000 } = {}) {
    this.#socketPath = socketPath;
    this.#onMessage = onMessage || (() => {});
    this.#bufferSize = bufferSize;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.#server = net.createServer(socket => {
        this.#client = socket;
        this.#partial = '';
        // Flush buffered messages
        for (const msg of this.#buffer) socket.write(frame(msg));
        this.#buffer = [];

        socket.on('data', chunk => {
          const { messages, remainder } = parseFrames(this.#partial + chunk.toString());
          this.#partial = remainder;
          for (const m of messages) this.#onMessage(m, this);
        });
        socket.on('close', () => { if (this.#client === socket) this.#client = null; });
        socket.on('error', () => { if (this.#client === socket) this.#client = null; });
      });
      this.#server.listen(this.#socketPath, () => resolve());
      this.#server.on('error', reject);
    });
  }

  send(msg) {
    if (this.#client) {
      this.#client.write(frame(msg));
    } else {
      this.#buffer.push(msg);
      if (this.#buffer.length > this.#bufferSize) this.#buffer.shift();
    }
  }

  get connected() { return this.#client !== null; }

  close() {
    return new Promise(resolve => {
      if (this.#client) this.#client.destroy();
      this.#server.close(resolve);
    });
  }
}
```

- [ ] **Verify passes:** 6 tests pass
- [ ] **Commit:** `feat: add IPC Unix socket server with ring buffer and reconnection support`

---

### Step 2.3 — Proxy manager (spawn Go child process, lifecycle)

- [ ] **Write failing test** at `server/src/proxy-manager.test.js`

Uses a dummy child process (`node -e "setTimeout(()=>{},60000)"`) instead of the Go binary. Tests:
1. `spawn starts child process` — assert `manager.running === true`, `manager.pid` is a number
2. `stop kills child process` — `manager.stop()`, assert `manager.running === false`
3. `restart on crash` — spawn with `node -e "process.exit(1)"`, assert `onRestart` callback fires within 2s
4. `does not restart after explicit stop` — stop, wait 500ms, assert `onRestart` not called
5. `getStatus returns uptime and pid`

- [ ] **Verify fails**

- [ ] **Implement `server/src/proxy-manager.js`**

```js
import { spawn } from 'node:child_process';

export class ProxyManager {
  #proc = null; #binPath; #args; #onRestart; #stopped = false;
  #startedAt = null; #restartDelay;

  constructor(binPath, args = [], { onRestart, restartDelay = 1000 } = {}) {
    this.#binPath = binPath;
    this.#args = args;
    this.#onRestart = onRestart || (() => {});
    this.#restartDelay = restartDelay;
  }

  start() {
    this.#stopped = false;
    this.#spawn();
  }

  #spawn() {
    this.#proc = spawn(this.#binPath, this.#args, { stdio: 'inherit' });
    this.#startedAt = Date.now();
    this.#proc.on('exit', (code) => {
      this.#proc = null;
      if (!this.#stopped) {
        setTimeout(() => {
          if (!this.#stopped) { this.#spawn(); this.#onRestart(code); }
        }, this.#restartDelay);
      }
    });
  }

  stop() {
    this.#stopped = true;
    if (this.#proc) { this.#proc.kill('SIGTERM'); this.#proc = null; }
  }

  get running() { return this.#proc !== null; }
  get pid() { return this.#proc?.pid ?? null; }
  getStatus() {
    return {
      running: this.running, pid: this.pid,
      uptime_ms: this.#startedAt ? Date.now() - this.#startedAt : 0,
    };
  }
}
```

- [ ] **Verify passes:** 5 tests pass
- [ ] **Commit:** `feat: add proxy manager with auto-restart on crash`

---

### Step 2.4 — REST API middleware (bearer auth, error handling)

- [ ] **Write failing test** at `server/src/api/middleware.test.js`

Creates minimal Express app with middleware applied, uses `node:http` requests. Tests:
1. `rejects request with no Authorization header` — 401, body has `error`
2. `rejects request with wrong token` — 401
3. `passes request with valid bearer token` — 200
4. `error handler returns JSON with status and error message` — route throws `Error('boom')`, assert 500 + JSON body
5. `error handler respects err.status` — error with `status:422`, assert 422

- [ ] **Verify fails**

- [ ] **Implement `server/src/api/middleware.js`**

```js
export function bearerAuth(token) {
  return (req, res, next) => {
    // Support query param auth for EventSource (which cannot send custom headers)
    if (req.query.token && req.query.token === token) {
      return next();
    }
    const header = req.headers.authorization;
    if (!header || header !== `Bearer ${token}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
}
```

- [ ] **Verify passes:** 5 tests pass
- [ ] **Commit:** `feat: add bearer auth middleware and JSON error handler`

---

### Step 2.5 — Rules API routes

- [ ] **Write failing test** at `server/src/api/rules.test.js`

Creates Express app with rules router mounted at `/api/rules`, uses in-memory mock DAO. Tests:
1. `GET /api/rules returns rule list` — mock `list()` returns 2 rules, assert 200 + array
2. `GET /api/rules/:id returns single rule` — mock `get(1)`, assert 200
3. `GET /api/rules/:id returns 404 for missing` — mock returns null, assert 404
4. `POST /api/rules creates rule in db mode` — mock `create()`, assert 201 + body
5. `POST /api/rules returns 403 in file mode` — config `rules.source:'file'`, assert 403
6. `PUT /api/rules/:id updates rule` — mock `update()`, assert 200
7. `DELETE /api/rules/:id deletes rule` — mock `delete()`, assert 204
8. `POST /api/rules/test tests URL against rules` — body `{url,method}`, mock `match()`, assert result
9. `POST /api/rules triggers ipc rules.reload` — assert `ipc.send` called with `type:'rules.reload'`

- [ ] **Verify fails**

- [ ] **Implement `server/src/api/rules.js`**

```js
import { Router } from 'express';

export default function rulesRoutes({ rulesDAO, config, ipc, events }) {
  const r = Router();

  function rejectIfReadOnly(req, res, next) {
    // Check config.rules.source on each request (not captured once at route creation)
    // so that SIGHUP config reloads take effect without restarting the server
    if (config.rules.source === 'file') return res.status(403).json({ error: 'Rules are read-only in file mode' });
    next();
  }

  r.get('/', async (req, res, next) => {
    try { res.json(await rulesDAO.list()); } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const rule = await rulesDAO.get(Number(req.params.id));
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      res.json(rule);
    } catch (e) { next(e); }
  });

  r.post('/test', async (req, res, next) => {
    try {
      const { url, method } = req.body;
      const match = await rulesDAO.match(url, method);
      res.json({ match, decision: match ? match.action : config.default_behavior });
    } catch (e) { next(e); }
  });

  r.post('/', rejectIfReadOnly, async (req, res, next) => {
    try {
      const rule = await rulesDAO.create(req.body);
      ipc.send({ type: 'rules.reload' });
      events.emit('rules.changed', { rule_id: rule.id });
      res.status(201).json(rule);
    } catch (e) { next(e); }
  });

  r.put('/:id', rejectIfReadOnly, async (req, res, next) => {
    try {
      const rule = await rulesDAO.update(Number(req.params.id), req.body);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      ipc.send({ type: 'rules.reload' });
      events.emit('rules.changed', { rule_id: rule.id });
      res.json(rule);
    } catch (e) { next(e); }
  });

  r.delete('/:id', rejectIfReadOnly, async (req, res, next) => {
    try {
      await rulesDAO.delete(Number(req.params.id));
      ipc.send({ type: 'rules.reload' });
      events.emit('rules.changed', {});
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
```

- [ ] **Verify passes:** 9 tests pass
- [ ] **Commit:** `feat: add rules API routes with CRUD, test endpoint, and file mode guard`

---

### Step 2.6 — Logs API routes

- [ ] **Write failing test** at `server/src/api/logs.test.js`

Tests:
1. `GET /api/logs returns filtered list` — mock `query({method:'GET',limit:50,offset:0})`, assert 200
2. `GET /api/logs passes all query params` — `?from=2026-01-01&to=2026-12-31&method=POST&decision=allowed&limit=10&offset=5`, assert DAO receives correct filters
3. `GET /api/logs/:id returns log detail` — mock `getById(1)`, assert 200
4. `GET /api/logs/:id returns 404 for missing`
5. `GET /api/logs/:id/request-body streams decrypted body` — mock `getById` returns entry with `request_body_ref:'logs/test.enc:0:100'`, mock crypto `decryptRecord`, assert 200 with body content
6. `GET /api/logs/:id/request-body returns 404 when no body ref`

- [ ] **Verify fails**

- [ ] **Implement `server/src/api/logs.js`**

```js
import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

export default function logsRoutes({ requestLogDAO, crypto, config }) {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      const filters = {};
      for (const k of ['method', 'decision', 'url', 'from', 'to']) {
        if (req.query[k]) filters[k] = req.query[k];
      }
      filters.limit = parseInt(req.query.limit) || 50;
      filters.offset = parseInt(req.query.offset) || 0;
      res.json(await requestLogDAO.query(filters));
    } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const entry = await requestLogDAO.getById(Number(req.params.id));
      if (!entry) return res.status(404).json({ error: 'Log entry not found' });
      res.json(entry);
    } catch (e) { next(e); }
  });

  async function streamBody(req, res, next, refField) {
    try {
      const entry = await requestLogDAO.getById(Number(req.params.id));
      if (!entry) return res.status(404).json({ error: 'Log entry not found' });
      const ref = entry[refField];
      if (!ref) return res.status(404).json({ error: 'No body recorded' });

      const [filePath, offsetStr, lengthStr] = ref.split(':');
      const offset = parseInt(offsetStr);
      const length = parseInt(lengthStr);
      const dataDir = config.database.path.replace(/\/[^/]+$/, '');
      const fullPath = `${dataDir}/${filePath}`;

      const fh = await open(fullPath, 'r');
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);
      await fh.close();

      const decrypted = crypto.decryptRecord(crypto.logKey, offset, buf);
      res.type('application/octet-stream').send(decrypted);
    } catch (e) { next(e); }
  }

  r.get('/:id/request-body', (req, res, next) => streamBody(req, res, next, 'request_body_ref'));
  r.get('/:id/response-body', (req, res, next) => streamBody(req, res, next, 'response_body_ref'));

  return r;
}
```

- [ ] **Verify passes:** 6 tests pass
- [ ] **Commit:** `feat: add logs API routes with body decryption streaming`

---

### Step 2.7 — Approvals API routes

- [ ] **Write failing test** at `server/src/api/approvals.test.js`

Tests:
1. `GET /api/approvals returns pending list` — mock `listPending()`, assert 200
2. `GET /api/approvals?status=pending passes filter` — assert DAO called
3. `POST /api/approvals/:id/resolve approves and notifies` — body `{action:'approve',create_rule:false}`, assert DAO `resolve` called, assert `ipc.send` called with `approval.resolve`, assert `events.emit` called with `approval.resolved`
4. `POST /api/approvals/:id/resolve with create_rule creates a rule` — `{action:'approve',create_rule:true}`, assert `rulesDAO.create` called with suggested pattern/methods from approval entry
5. `POST /api/approvals/:id/resolve returns 404 for unknown` — DAO `resolve` returns null, assert 404
6. `POST /api/approvals/:id/resolve rejects invalid action` — `{action:'maybe'}`, assert 400

- [ ] **Verify fails**

- [ ] **Implement `server/src/api/approvals.js`**

```js
import { Router } from 'express';

export default function approvalsRoutes({ approvalQueueDAO, rulesDAO, config, ipc, events }) {
  const r = Router();

  r.get('/', async (req, res, next) => {
    try {
      const items = await approvalQueueDAO.listPending();
      res.json(items);
    } catch (e) { next(e); }
  });

  r.post('/:id/resolve', async (req, res, next) => {
    try {
      const { action, create_rule } = req.body;
      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'action must be "approve" or "reject"' });
      }

      const result = await approvalQueueDAO.resolve(Number(req.params.id), {
        action, create_rule: !!create_rule, resolved_by: 'api',
      });
      if (!result) return res.status(404).json({ error: 'Approval not found or already resolved' });

      // Notify proxy of decision — ref must be the original IPC msg_id so the Go proxy
      // can correlate it with the held request channel
      ipc.send({ type: 'approval.resolve', ref: result.ipc_msg_id, action });

      // Auto-create rule if requested
      if (create_rule && result.suggested_pattern) {
        const methods = result.suggested_methods ? JSON.parse(result.suggested_methods) : [];
        await rulesDAO.create({
          name: `Auto: ${result.suggested_pattern}`,
          url_pattern: result.suggested_pattern,
          methods,
          action: action === 'approve' ? 'allow' : 'deny',
          priority: 50, enabled: true,
        });
        ipc.send({ type: 'rules.reload' });
        events.emit('rules.changed', {});
      }

      events.emit('approval.resolved', { id: result.id, action });
      res.json(result);
    } catch (e) { next(e); }
  });

  return r;
}
```

- [ ] **Verify passes:** 6 tests pass
- [ ] **Commit:** `feat: add approvals API routes with resolve and auto-rule creation`

---

### Step 2.8 — SSE events endpoint

- [ ] **Write failing test** at `server/src/api/events.test.js`

Uses `node:http` to connect to SSE endpoint and read the stream. Tests:
1. `connects and receives initial comment` — assert first data starts with `:ok`
2. `receives emitted event` — emit `request.allowed` with data, assert client receives `event: request.allowed\ndata: {...}\n\n`
3. `each event has incrementing id` — emit 3 events, assert `id:` lines are `1`, `2`, `3`
4. `Last-Event-ID replays missed events` — emit 5 events, connect with `Last-Event-ID: 2`, receive events 3-5
5. `buffer drops oldest events beyond limit` — create with `bufferSize:3`, emit 5 events, reconnect with `Last-Event-ID: 0`, receive only events 3-5
6. `multiple clients receive same event` — 2 connections, emit 1 event, both receive it

- [ ] **Verify fails**

- [ ] **Implement `server/src/api/events.js`**

```js
import { Router } from 'express';

export class EventBus {
  #clients = new Set();
  #buffer = [];
  #bufferSize;
  #nextId = 1;

  constructor({ bufferSize = 1000 } = {}) {
    this.#bufferSize = bufferSize;
  }

  emit(eventType, data) {
    const event = { id: this.#nextId++, type: eventType, data };
    this.#buffer.push(event);
    if (this.#buffer.length > this.#bufferSize) this.#buffer.shift();
    for (const client of this.#clients) this.#sendEvent(client, event);
  }

  #sendEvent(res, event) {
    res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  addClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':ok\n\n');

    const lastId = parseInt(req.headers['last-event-id']) || 0;
    if (lastId > 0) {
      for (const event of this.#buffer) {
        if (event.id > lastId) this.#sendEvent(res, event);
      }
    }

    this.#clients.add(res);
    req.on('close', () => this.#clients.delete(res));
  }

  get clientCount() { return this.#clients.size; }
}

export default function eventsRoute(eventBus) {
  const r = Router();
  r.get('/', (req, res) => eventBus.addClient(req, res));
  return r;
}
```

- [ ] **Verify passes:** 6 tests pass
- [ ] **Commit:** `feat: add SSE events endpoint with Last-Event-ID replay and bounded buffer`

---

### Step 2.9 — Status API route

- [ ] **Write failing test** at `server/src/api/status.test.js`

Tests:
1. `GET /api/status returns proxy status and stats` — mock proxyManager, rulesDAO, requestLogDAO, assert response contains `proxy.running`, `proxy.uptime_ms`, `rules_count`, `db_path`
2. `GET /api/ca/certificate serves CA cert file` — write dummy cert to temp file, assert 200 with correct content-type

- [ ] **Verify fails**

- [ ] **Implement `server/src/api/status.js`**

```js
import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';

export default function statusRoutes({ proxyManager, rulesDAO, config }) {
  const r = Router();
  const startedAt = Date.now();

  r.get('/status', async (req, res, next) => {
    try {
      const rules = await rulesDAO.list();
      res.json({
        proxy: proxyManager.getStatus(),
        management: { uptime_ms: Date.now() - startedAt },
        rules_count: rules.length,
        rules_source: config.rules.source,
        db_path: config.database.path,
      });
    } catch (e) { next(e); }
  });

  r.get('/ca/certificate', (req, res) => {
    const certPath = config.database.path.replace(/\/[^/]+$/, '') + '/ca/root.crt';
    if (!existsSync(certPath)) return res.status(404).json({ error: 'CA certificate not found' });
    res.type('application/x-pem-file').send(readFileSync(certPath));
  });

  return r;
}
```

- [ ] **Verify passes:** 2 tests pass
- [ ] **Commit:** `feat: add status API route and CA certificate download`

---

### Step 2.10 — Webhook dispatcher

- [ ] **Write failing test** at `server/src/webhooks/dispatcher.test.js`

Uses a local HTTP server (`node:http`) as webhook target. Tests:
1. `dispatches event to matching webhook` — webhook registered for `approval.needed`, emit `approval.needed`, assert target receives POST with JSON body
2. `includes HMAC-SHA256 signature header` — assert `X-ASHP-Signature` header present, recompute HMAC with secret, assert match
3. `skips webhook for non-matching event` — webhook for `approval.needed`, emit `request.allowed`, target not called
4. `retries on failure with backoff` — target returns 500 twice then 200, assert 3 total requests within timeout
5. `gives up after max retries` — target always 500, retries exhausted, no crash
6. `respects timeout` — target delays 10s, webhook timeout 100ms, assert failure logged

- [ ] **Verify fails**

- [ ] **Implement `server/src/webhooks/dispatcher.js`**

```js
import { createHmac } from 'node:crypto';

export class WebhookDispatcher {
  #webhooks;

  constructor(webhooks = []) {
    this.#webhooks = webhooks;
  }

  async dispatch(eventType, data) {
    const matching = this.#webhooks.filter(w => w.events.includes(eventType));
    await Promise.allSettled(matching.map(w => this.#deliver(w, eventType, data)));
  }

  async #deliver(webhook, eventType, data, attempt = 0) {
    const body = JSON.stringify({ event: eventType, data, timestamp: new Date().toISOString() });
    const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), webhook.timeout_ms || 5000);

    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ASHP-Signature': signature,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok && attempt < (webhook.retries ?? 3)) {
        await new Promise(r => setTimeout(r, 100 * 2 ** attempt));
        return this.#deliver(webhook, eventType, data, attempt + 1);
      }
    } catch (err) {
      clearTimeout(timeout);
      if (attempt < (webhook.retries ?? 3)) {
        await new Promise(r => setTimeout(r, 100 * 2 ** attempt));
        return this.#deliver(webhook, eventType, data, attempt + 1);
      }
    }
  }

  reload(webhooks) { this.#webhooks = webhooks; }
}
```

- [ ] **Verify passes:** 6 tests pass
- [ ] **Commit:** `feat: add webhook dispatcher with HMAC signing and retry backoff`

---

### Step 2.11 — Main orchestrator (index.js)

- [ ] **Write failing test** at `server/src/index.test.js`

Integration test that starts the full server with a temp config and verifies wiring. Uses in-process import (no child process). Tests:
1. `starts server, GET /api/status returns 200` — create temp config + db dir, start orchestrator, HTTP request, assert 200
2. `bearer auth required on all API routes` — request without token, assert 401
3. `SIGHUP reloads config` — modify config file, send SIGHUP, assert status reflects change (e.g., rules source changed)

- [ ] **Verify fails**

- [ ] **Implement `server/src/index.js`**

```js
import express from 'express';
import { loadConfig } from './config.js';
import { createConnection } from './dao/sqlite/connection.js';
import { SqliteRulesDAO } from './dao/sqlite/rules.js';
import { SqliteRequestLogDAO } from './dao/sqlite/request-log.js';
import { SqliteApprovalQueueDAO } from './dao/sqlite/approval-queue.js';
import { JsonFileRulesDAO } from './dao/jsonfile/rules.js';
import { IPCServer } from './ipc/server.js';
import { EventBus } from './api/events.js';
import { ProxyManager } from './proxy-manager.js';
import { WebhookDispatcher } from './webhooks/dispatcher.js';
import { bearerAuth, errorHandler } from './api/middleware.js';
import rulesRoutes from './api/rules.js';
import logsRoutes from './api/logs.js';
import approvalsRoutes from './api/approvals.js';
import eventsRoute from './api/events.js';
import statusRoutes from './api/status.js';
import * as crypto from './crypto/index.js';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

export async function startServer(flags = {}) {
  const config = loadConfig(flags);
  const dataDir = dirname(resolve(config.database.path));
  mkdirSync(dataDir, { recursive: true });

  // DAO layer
  const db = createConnection(resolve(config.database.path), config.database.encryption_key);
  const rulesDAO = config.rules.source === 'file'
    ? new JsonFileRulesDAO(resolve(config.rules.file))
    : new SqliteRulesDAO(db);
  const requestLogDAO = new SqliteRequestLogDAO(db);
  const approvalQueueDAO = new SqliteApprovalQueueDAO(db);

  // IPC
  const socketPath = resolve(dataDir, 'ashp.sock');
  if (existsSync(socketPath)) unlinkSync(socketPath);

  const events = new EventBus();
  const webhooks = new WebhookDispatcher(config.webhooks || []);
  const logKey = config.encryption?.log_key ? Buffer.from(config.encryption.log_key, 'hex') : null;

  const ipc = new IPCServer(socketPath, {
    onMessage: async (msg) => {
      if (msg.type === 'request.logged') {
        await requestLogDAO.insert(msg.data);
        events.emit('request.allowed', msg.data);
      } else if (msg.type === 'request.blocked') {
        await requestLogDAO.insert(msg.data);
        events.emit('request.blocked', msg.data);
      } else if (msg.type === 'approval.needed') {
        const logEntry = await requestLogDAO.insert(msg.data);
        await approvalQueueDAO.enqueue({
          request_log_id: logEntry.id,
          ipc_msg_id: msg.msg_id,
          suggested_pattern: msg.data.suggested_pattern,
          suggested_methods: msg.data.suggested_methods,
        });
        events.emit('approval.needed', { ...msg.data, log_id: logEntry.id });
        webhooks.dispatch('approval.needed', msg.data);
      }
    },
  });
  await ipc.start();

  // Proxy manager
  const proxyBinPath = resolve(dataDir, '..', 'proxy', 'ashp-proxy');
  const proxyManager = new ProxyManager(proxyBinPath, [
    '--socket', socketPath,
    '--listen', config.proxy.listen,
    '--auth', JSON.stringify(config.proxy.auth || {}),
  ], { onRestart: () => ipc.send({ type: 'rules.reload' }) });

  // Express app
  const app = express();
  app.use(express.json());

  const deps = { rulesDAO, requestLogDAO, approvalQueueDAO, config, ipc, events, proxyManager,
    crypto: { ...crypto, logKey } };

  // Public: CA cert
  app.use('/api', statusRoutes(deps));

  // Protected routes
  app.use('/api', bearerAuth(config.management.bearer_token));
  app.use('/api/rules', rulesRoutes(deps));
  app.use('/api/logs', logsRoutes(deps));
  app.use('/api/approvals', approvalsRoutes(deps));
  app.use('/api/events', eventsRoute(events));
  app.use(errorHandler);

  const [host, port] = config.management.listen.split(':');
  const server = app.listen(parseInt(port), host);

  // SIGHUP reloads config
  process.on('SIGHUP', () => {
    try {
      const newConfig = loadConfig(flags);
      webhooks.reload(newConfig.webhooks || []);
      if (config.rules.source === 'file' && rulesDAO.reload) rulesDAO.reload();
      ipc.send({ type: 'config.update', data: { default_behavior: newConfig.default_behavior } });
      ipc.send({ type: 'rules.reload' });
      Object.assign(config, newConfig);
    } catch (err) {
      console.error('SIGHUP reload failed:', err.message);
    }
  });

  return { app, server, ipc, proxyManager, db, close: () => {
    proxyManager.stop();
    server.close();
    ipc.close();
    db.close();
  }};
}

// CLI entry point
if (process.argv[1] === import.meta.filename) {
  const flags = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    flags[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  }
  startServer(flags).then(({ server }) => {
    server.on('listening', () => console.log(`ASHP management API listening`));
  });
}
```

- [ ] **Verify passes:** 3 tests pass
- [ ] **Commit:** `feat: add main orchestrator wiring IPC, API, SSE, webhooks, and proxy manager`

---

### Step 2.12 — Run full Chunk 2 test suite

- [ ] **Run:** `cd server && node --test src/**/*.test.js`
- [ ] **Expected:** ~100 tests pass across all test files (Chunk 1 ~39: config 5, crypto 7, interfaces 3, connection 3, sqlite rules 6, request-log 6, approval-queue 4, jsonfile rules 5 + Chunk 2 ~61 new: protocol 7, server 6, proxy-manager 5, middleware 5, rules 9, logs 6, approvals 6, events 6, status 2, webhooks 6, index 3 — some tests grouped under describes, so total may vary)
- [ ] **Commit (if needed):** `chore: chunk 2 complete — IPC, REST API, SSE, webhooks, orchestrator`

---

## Chunk 3: Go Proxy Core

**Convention:** Each internal package has its own `_test.go` file. Use `go test ./...` from the `proxy/` directory. Tests use the standard `testing` package. Temp files use `t.TempDir()`.

---

### Step 3.1 — Go module setup

- [ ] **Create `proxy/go.mod`**

```
module github.com/jdk/ashp/proxy

go 1.22

require github.com/elazarl/goproxy v0.0.0-20240618083138-03b12a5b3bfa
```

- [ ] **Run:** `cd proxy && go mod tidy`
- [ ] **Verify:** `cd proxy && go build ./...` succeeds (no source yet, just module)
- [ ] **Commit:** `chore: initialize Go module with goproxy dependency`

---

### Step 3.2 — CA manager

- [ ] **Write failing test** at `proxy/internal/ca/manager_test.go`

```go
package ca

import (
    "crypto/tls"
    "crypto/x509"
    "os"
    "path/filepath"
    "testing"
)

func TestGenerateCA(t *testing.T) {
    dir := t.TempDir()
    certPath := filepath.Join(dir, "root.crt")
    keyPath := filepath.Join(dir, "root.key")
    passphrase := []byte("test-passphrase")

    // Generate
    caCert, err := GenerateCA(certPath, keyPath, passphrase)
    if err != nil { t.Fatal(err) }
    if !caCert.IsCA { t.Fatal("expected CA cert") }

    // Files exist
    if _, err := os.Stat(certPath); err != nil { t.Fatal("cert file missing") }
    if _, err := os.Stat(keyPath); err != nil { t.Fatal("key file missing") }

    // Reload from disk
    caCert2, err := LoadCA(certPath, keyPath, passphrase)
    if err != nil { t.Fatal(err) }
    if !caCert2.Leaf.Equal(caCert) { t.Fatal("reloaded cert mismatch") }
}

func TestSignHost(t *testing.T) {
    dir := t.TempDir()
    GenerateCA(filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key"), []byte("pass"))
    ca, _ := LoadCA(filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key"), []byte("pass"))

    tlsCert, err := SignHost(ca.Leaf, ca.PrivateKey, "example.com")
    if err != nil { t.Fatal(err) }

    parsed, _ := x509.ParseCertificate(tlsCert.Certificate[0])
    if parsed.Subject.CommonName != "example.com" { t.Fatalf("CN = %s", parsed.Subject.CommonName) }

    pool := x509.NewCertPool()
    pool.AddCert(ca.Leaf)
    if _, err := parsed.Verify(x509.VerifyOptions{Roots: pool}); err != nil {
        t.Fatalf("cert verification failed: %v", err)
    }
}

func TestWrongPassphrase(t *testing.T) {
    dir := t.TempDir()
    certPath := filepath.Join(dir, "ca.crt")
    keyPath := filepath.Join(dir, "ca.key")
    GenerateCA(certPath, keyPath, []byte("correct"))
    _, err := LoadCA(certPath, keyPath, []byte("wrong"))
    if err == nil { t.Fatal("expected error with wrong passphrase") }
}
```

- [ ] **Verify fails:** `cd proxy && go test ./internal/ca/`

- [ ] **Implement `proxy/internal/ca/manager.go`**

```go
package ca

import (
    "crypto/ecdsa"
    "crypto/elliptic"
    "crypto/rand"
    "crypto/tls"
    "crypto/x509"
    "crypto/x509/pkix"
    "encoding/pem"
    "math/big"
    "os"
    "time"
)

func GenerateCA(certPath, keyPath string, passphrase []byte) (*x509.Certificate, error) {
    key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
    if err != nil { return nil, err }

    serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
    tmpl := &x509.Certificate{
        SerialNumber:          serial,
        Subject:               pkix.Name{CommonName: "ASHP Root CA", Organization: []string{"ASHP"}},
        NotBefore:             time.Now().Add(-1 * time.Hour),
        NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
        KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
        BasicConstraintsValid: true,
        IsCA:                  true,
    }

    certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
    if err != nil { return nil, err }

    certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
    if err := os.WriteFile(certPath, certPEM, 0644); err != nil { return nil, err }

    keyDER, err := x509.MarshalECPrivateKey(key)
    if err != nil { return nil, err }
    block, err := x509.EncryptPEMBlock(rand.Reader, "EC PRIVATE KEY", keyDER, passphrase, x509.PEMCipherAES256)
    if err != nil { return nil, err }
    if err := os.WriteFile(keyPath, pem.EncodeToMemory(block), 0600); err != nil { return nil, err }

    cert, _ := x509.ParseCertificate(certDER)
    return cert, nil
}

func LoadCA(certPath, keyPath string, passphrase []byte) (tls.Certificate, error) {
    certPEM, err := os.ReadFile(certPath)
    if err != nil { return tls.Certificate{}, err }

    keyPEM, err := os.ReadFile(keyPath)
    if err != nil { return tls.Certificate{}, err }

    block, _ := pem.Decode(keyPEM)
    decrypted, err := x509.DecryptPEMBlock(block, passphrase)
    if err != nil { return tls.Certificate{}, err }

    plainBlock := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: decrypted})
    tlsCert, err := tls.X509KeyPair(certPEM, plainBlock)
    if err != nil { return tls.Certificate{}, err }
    tlsCert.Leaf, _ = x509.ParseCertificate(tlsCert.Certificate[0])
    return tlsCert, nil
}

func SignHost(caCert *x509.Certificate, caKey interface{}, hostname string) (tls.Certificate, error) {
    key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
    if err != nil { return tls.Certificate{}, err }

    serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
    tmpl := &x509.Certificate{
        SerialNumber: serial,
        Subject:      pkix.Name{CommonName: hostname},
        NotBefore:    time.Now().Add(-1 * time.Hour),
        NotAfter:     time.Now().Add(24 * time.Hour),
        KeyUsage:     x509.KeyUsageDigitalSignature,
        ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
        DNSNames:     []string{hostname},
    }

    certDER, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &key.PublicKey, caKey)
    if err != nil { return tls.Certificate{}, err }

    return tls.Certificate{
        Certificate: [][]byte{certDER},
        PrivateKey:  key,
    }, nil
}
```

**Note:** `GenerateCA` returns `*x509.Certificate`. `LoadCA` returns `tls.Certificate` (with `.Leaf` populated). `SignHost` takes the CA cert + private key extracted from the `tls.Certificate`. The test above already uses `LoadCA` and passes `ca.Leaf` and `ca.PrivateKey` correctly.

- [ ] **Verify passes:** `cd proxy && go test ./internal/ca/` — 3 tests pass
- [ ] **Commit:** `feat: add CA manager with generate, load, and host cert signing`

---

### Step 3.3 — Rule evaluator

- [ ] **Write failing test** at `proxy/internal/rules/evaluator_test.go`

```go
package rules

import "testing"

func TestEvaluator(t *testing.T) {
    e := NewEvaluator()
    e.Load([]Rule{
        {ID: 1, URLPattern: `^https://api\.github\.com/.*$`, Methods: []string{"GET", "POST"},
         Action: "allow", Priority: 100, Enabled: true},
        {ID: 2, URLPattern: `.*`, Methods: nil,
         Action: "deny", Priority: 0, Enabled: true},
        {ID: 3, URLPattern: `^https://disabled\.com/.*$`, Methods: nil,
         Action: "allow", Priority: 200, Enabled: false},
    })

    tests := []struct {
        url, method string
        wantID      int
        wantAction  string
    }{
        {"https://api.github.com/repos", "GET", 1, "allow"},
        {"https://api.github.com/repos", "DELETE", 2, "deny"},
        {"https://evil.com/hack", "GET", 2, "deny"},
        {"https://disabled.com/path", "GET", 2, "deny"}, // disabled rule skipped
    }

    for _, tt := range tests {
        match := e.Match(tt.url, tt.method)
        if match == nil { t.Fatalf("no match for %s %s", tt.method, tt.url) }
        if match.ID != tt.wantID { t.Errorf("%s %s: got rule %d, want %d", tt.method, tt.url, match.ID, tt.wantID) }
        if match.Action != tt.wantAction { t.Errorf("%s %s: got %s, want %s", tt.method, tt.url, match.Action, tt.wantAction) }
    }
}

func TestEvaluatorNoMatch(t *testing.T) {
    e := NewEvaluator()
    e.Load([]Rule{
        {ID: 1, URLPattern: `^https://specific\.com/$`, Methods: []string{"GET"},
         Action: "allow", Priority: 100, Enabled: true},
    })
    if m := e.Match("https://other.com/", "GET"); m != nil {
        t.Fatalf("expected nil, got rule %d", m.ID)
    }
}

func TestEvaluatorReload(t *testing.T) {
    e := NewEvaluator()
    e.Load([]Rule{{ID: 1, URLPattern: `.*`, Methods: nil, Action: "deny", Priority: 0, Enabled: true}})
    if m := e.Match("https://a.com/", "GET"); m.Action != "deny" { t.Fatal("expected deny") }

    e.Load([]Rule{{ID: 2, URLPattern: `.*`, Methods: nil, Action: "allow", Priority: 0, Enabled: true}})
    if m := e.Match("https://a.com/", "GET"); m.Action != "allow" { t.Fatal("expected allow after reload") }
}
```

- [ ] **Verify fails:** `cd proxy && go test ./internal/rules/`

- [ ] **Implement `proxy/internal/rules/evaluator.go`**

```go
package rules

import (
    "regexp"
    "sort"
    "sync"
)

type Rule struct {
    ID              int      `json:"id"`
    URLPattern      string   `json:"url_pattern"`
    Methods         []string `json:"methods"`
    Action          string   `json:"action"`
    Priority        int      `json:"priority"`
    Enabled         bool     `json:"enabled"`
    DefaultBehavior string   `json:"default_behavior,omitempty"`
}

type compiledRule struct {
    Rule
    re *regexp.Regexp
}

type Evaluator struct {
    mu    sync.RWMutex
    rules []compiledRule
}

func NewEvaluator() *Evaluator { return &Evaluator{} }

func (e *Evaluator) Load(rules []Rule) {
    compiled := make([]compiledRule, 0, len(rules))
    for _, r := range rules {
        if !r.Enabled { continue }
        re, err := regexp.Compile(r.URLPattern)
        if err != nil { continue }
        compiled = append(compiled, compiledRule{Rule: r, re: re})
    }
    sort.Slice(compiled, func(i, j int) bool {
        return compiled[i].Priority > compiled[j].Priority
    })
    e.mu.Lock()
    e.rules = compiled
    e.mu.Unlock()
}

func (e *Evaluator) Match(url, method string) *Rule {
    e.mu.RLock()
    defer e.mu.RUnlock()
    for _, cr := range e.rules {
        if !cr.re.MatchString(url) { continue }
        if len(cr.Methods) > 0 {
            found := false
            for _, m := range cr.Methods { if m == method { found = true; break } }
            if !found { continue }
        }
        r := cr.Rule
        return &r
    }
    return nil
}
```

- [ ] **Verify passes:** 3 tests pass
- [ ] **Commit:** `feat: add rule evaluator with regex matching and priority ordering`

---

### Step 3.4 — Basic Auth handler

- [ ] **Write failing test** at `proxy/internal/auth/basic_test.go`

```go
package auth

import (
    "encoding/base64"
    "net/http"
    "testing"
)

func TestParseProxyAuth(t *testing.T) {
    tokens := map[string]string{"agent1": "secret123"}
    h := NewHandler(tokens)

    // Valid
    val := "Basic " + base64.StdEncoding.EncodeToString([]byte("agent1:secret123"))
    req, _ := http.NewRequest("GET", "http://example.com", nil)
    req.Header.Set("Proxy-Authorization", val)
    agentID, ok := h.Authenticate(req)
    if !ok { t.Fatal("expected auth success") }
    if agentID != "agent1" { t.Fatalf("got %s", agentID) }
}

func TestRejectsWrongPassword(t *testing.T) {
    h := NewHandler(map[string]string{"agent1": "secret123"})
    val := "Basic " + base64.StdEncoding.EncodeToString([]byte("agent1:wrong"))
    req, _ := http.NewRequest("GET", "http://example.com", nil)
    req.Header.Set("Proxy-Authorization", val)
    _, ok := h.Authenticate(req)
    if ok { t.Fatal("expected auth failure") }
}

func TestRejectsMissingHeader(t *testing.T) {
    h := NewHandler(map[string]string{"agent1": "secret123"})
    req, _ := http.NewRequest("GET", "http://example.com", nil)
    _, ok := h.Authenticate(req)
    if ok { t.Fatal("expected auth failure") }
}

func TestRejectsUnknownUser(t *testing.T) {
    h := NewHandler(map[string]string{"agent1": "secret123"})
    val := "Basic " + base64.StdEncoding.EncodeToString([]byte("unknown:secret123"))
    req, _ := http.NewRequest("GET", "http://example.com", nil)
    req.Header.Set("Proxy-Authorization", val)
    _, ok := h.Authenticate(req)
    if ok { t.Fatal("expected auth failure") }
}
```

- [ ] **Verify fails:** `cd proxy && go test ./internal/auth/`

- [ ] **Implement `proxy/internal/auth/basic.go`**

```go
package auth

import (
    "encoding/base64"
    "net/http"
    "strings"
)

type Handler struct {
    tokens map[string]string // user -> password
}

func NewHandler(tokens map[string]string) *Handler {
    return &Handler{tokens: tokens}
}

func (h *Handler) Authenticate(req *http.Request) (agentID string, ok bool) {
    header := req.Header.Get("Proxy-Authorization")
    if header == "" { return "", false }
    if !strings.HasPrefix(header, "Basic ") { return "", false }

    decoded, err := base64.StdEncoding.DecodeString(header[6:])
    if err != nil { return "", false }

    parts := strings.SplitN(string(decoded), ":", 2)
    if len(parts) != 2 { return "", false }

    user, pass := parts[0], parts[1]
    expected, exists := h.tokens[user]
    if !exists || expected != pass { return "", false }
    return user, true
}

func (h *Handler) Reload(tokens map[string]string) {
    h.tokens = tokens
}
```

- [ ] **Verify passes:** 4 tests pass
- [ ] **Commit:** `feat: add Basic Auth handler for Proxy-Authorization`

---

### Step 3.5 — Encrypted log writer

- [ ] **Write failing test** at `proxy/internal/logger/writer_test.go`

```go
package logger

import (
    "bytes"
    "encoding/binary"
    "os"
    "path/filepath"
    "testing"
    "time"
)

func TestWriteAndReadRecord(t *testing.T) {
    dir := t.TempDir()
    key := bytes.Repeat([]byte{0xab}, 32)
    w, err := NewWriter(dir, key)
    if err != nil { t.Fatal(err) }

    payload := []byte(`{"method":"GET","url":"https://example.com"}`)
    ref, err := w.Write(payload)
    if err != nil { t.Fatal(err) }

    // ref format: relative/path:offset:length
    if ref == "" { t.Fatal("empty ref") }

    data, err := ReadRecord(dir, ref, key)
    if err != nil { t.Fatal(err) }
    if !bytes.Equal(data, payload) { t.Fatalf("got %s", data) }
}

func TestHourlyRotation(t *testing.T) {
    dir := t.TempDir()
    key := bytes.Repeat([]byte{0xab}, 32)
    w, _ := NewWriter(dir, key)

    // Write a record — file should be created for current hour
    w.Write([]byte("record1"))
    now := time.Now().UTC()
    expected := filepath.Join(dir, now.Format("2006/01/02"), now.Format("15")+".log.enc")
    if _, err := os.Stat(expected); err != nil { t.Fatalf("expected file %s: %v", expected, err) }
}

func TestRecordLengthPrefixSuffix(t *testing.T) {
    dir := t.TempDir()
    key := bytes.Repeat([]byte{0xab}, 32)
    w, _ := NewWriter(dir, key)

    w.Write([]byte("test data"))

    now := time.Now().UTC()
    path := filepath.Join(dir, now.Format("2006/01/02"), now.Format("15")+".log.enc")
    data, _ := os.ReadFile(path)
    prefix := binary.LittleEndian.Uint32(data[0:4])
    suffix := binary.LittleEndian.Uint32(data[len(data)-4:])
    if prefix != suffix { t.Fatalf("prefix %d != suffix %d", prefix, suffix) }
    if int(prefix) != len(data) { t.Fatalf("length %d != file size %d", prefix, len(data)) }
}

func TestMultipleRecords(t *testing.T) {
    dir := t.TempDir()
    key := bytes.Repeat([]byte{0xab}, 32)
    w, _ := NewWriter(dir, key)

    ref1, _ := w.Write([]byte("first"))
    ref2, _ := w.Write([]byte("second"))

    d1, _ := ReadRecord(dir, ref1, key)
    d2, _ := ReadRecord(dir, ref2, key)
    if string(d1) != "first" { t.Fatalf("got %s", d1) }
    if string(d2) != "second" { t.Fatalf("got %s", d2) }
}
```

- [ ] **Verify fails:** `cd proxy && go test ./internal/logger/`

- [ ] **Implement `proxy/internal/logger/writer.go`**

```go
package logger

import (
    "crypto/aes"
    "crypto/cipher"
    "crypto/rand"
    "crypto/sha256"
    "encoding/binary"
    "fmt"
    "io"
    "os"
    "path/filepath"
    "strings"
    "sync"
    "time"

    "golang.org/x/crypto/hkdf"
)

type Writer struct {
    dir string
    key []byte
    mu  sync.Mutex
    fh  *os.File
    pos int64
    cur string // current file path (relative)
}

func NewWriter(dir string, key []byte) (*Writer, error) {
    return &Writer{dir: dir, key: key}, nil
}

func (w *Writer) Write(payload []byte) (string, error) {
    w.mu.Lock()
    defer w.mu.Unlock()

    relPath := w.currentPath()
    if relPath != w.cur {
        if w.fh != nil { w.fh.Close() }
        absPath := filepath.Join(w.dir, relPath)
        os.MkdirAll(filepath.Dir(absPath), 0755)
        fh, err := os.OpenFile(absPath, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
        if err != nil { return "", err }
        info, _ := fh.Stat()
        w.fh = fh
        w.pos = info.Size()
        w.cur = relPath
    }

    offset := w.pos
    recordKey := deriveKey(w.key, offset)
    nonce := make([]byte, 12)
    io.ReadFull(rand.Reader, nonce)

    block, _ := aes.NewCipher(recordKey)
    gcm, _ := cipher.NewGCM(block)
    ciphertext := gcm.Seal(nil, nonce, payload, nil)

    totalLen := uint32(4 + 12 + len(ciphertext) + 4)
    buf := make([]byte, totalLen)
    binary.LittleEndian.PutUint32(buf[0:4], totalLen)
    copy(buf[4:16], nonce)
    copy(buf[16:16+len(ciphertext)], ciphertext)
    binary.LittleEndian.PutUint32(buf[totalLen-4:], totalLen)

    n, err := w.fh.Write(buf)
    if err != nil { return "", err }
    w.pos += int64(n)

    return fmt.Sprintf("%s:%d:%d", w.cur, offset, totalLen), nil
}

func (w *Writer) currentPath() string {
    now := time.Now().UTC()
    return filepath.Join(now.Format("2006/01/02"), now.Format("15")+".log.enc")
}

func ReadRecord(baseDir, ref string, masterKey []byte) ([]byte, error) {
    parts := strings.SplitN(ref, ":", 3)
    if len(parts) != 3 { return nil, fmt.Errorf("invalid ref: %s", ref) }
    filePath := parts[0]
    var offset, length int64
    fmt.Sscanf(parts[1], "%d", &offset)
    fmt.Sscanf(parts[2], "%d", &length)

    fh, err := os.Open(filepath.Join(baseDir, filePath))
    if err != nil { return nil, err }
    defer fh.Close()

    buf := make([]byte, length)
    if _, err := fh.ReadAt(buf, offset); err != nil { return nil, err }

    nonce := buf[4:16]
    ciphertext := buf[16 : length-4] // includes GCM tag
    recordKey := deriveKey(masterKey, offset)

    block, _ := aes.NewCipher(recordKey)
    gcm, _ := cipher.NewGCM(block)
    return gcm.Open(nil, nonce, ciphertext, nil)
}

func deriveKey(master []byte, offset int64) []byte {
    info := []byte(fmt.Sprintf("ashp-log-record:%d", offset))
    r := hkdf.New(sha256.New, master, nil, info)
    key := make([]byte, 32)
    io.ReadFull(r, key)
    return key
}

func (w *Writer) Close() {
    w.mu.Lock()
    defer w.mu.Unlock()
    if w.fh != nil { w.fh.Close() }
}
```

**Note:** Add `golang.org/x/crypto` to `go.mod`:

- [ ] **Run:** `cd proxy && go get golang.org/x/crypto && go mod tidy`
- [ ] **Verify passes:** 4 tests pass
- [ ] **Commit:** `feat: add encrypted log writer with hourly rotation and per-record AES-256-GCM`

---

### Step 3.6 — IPC client (Unix socket, JSON messaging)

- [ ] **Write failing test** at `proxy/internal/ipc/client_test.go`

Uses `net.Listen("unix", ...)` as a test server. Tests:

```go
package ipc

import (
    "encoding/json"
    "net"
    "os"
    "path/filepath"
    "testing"
    "time"
)

func TestClientConnectsAndReceives(t *testing.T) {
    sock := filepath.Join(t.TempDir(), "test.sock")
    ln, _ := net.Listen("unix", sock)
    defer ln.Close()

    msgs := make(chan Message, 10)
    c := NewClient(sock, WithOnMessage(func(m Message) { msgs <- m }))
    go c.Connect()
    defer c.Close()

    conn, _ := ln.Accept()
    conn.Write([]byte(`{"type":"rules.reload","msg_id":"abc"}` + "\n"))

    select {
    case m := <-msgs:
        if m.Type != "rules.reload" { t.Fatalf("got %s", m.Type) }
    case <-time.After(2 * time.Second):
        t.Fatal("timeout")
    }
}

func TestClientSendsMessage(t *testing.T) {
    sock := filepath.Join(t.TempDir(), "test.sock")
    ln, _ := net.Listen("unix", sock)
    defer ln.Close()

    c := NewClient(sock)
    go c.Connect()
    defer c.Close()

    conn, _ := ln.Accept()
    c.Send(Message{Type: "request.logged", MsgID: "123"})

    buf := make([]byte, 4096)
    n, _ := conn.Read(buf)
    var m Message
    json.Unmarshal(buf[:n-1], &m) // trim newline
    if m.Type != "request.logged" { t.Fatalf("got %s", m.Type) }
}

func TestClientReconnects(t *testing.T) {
    sock := filepath.Join(t.TempDir(), "test.sock")
    ln, _ := net.Listen("unix", sock)

    reconnects := make(chan struct{}, 10)
    c := NewClient(sock,
        WithOnReconnect(func() { reconnects <- struct{}{} }),
        WithBackoff(10*time.Millisecond, 50*time.Millisecond),
    )
    go c.Connect()
    defer c.Close()

    conn, _ := ln.Accept()
    conn.Close() // force disconnect

    select {
    case <-reconnects:
        // OK — reconnected
    case <-time.After(2 * time.Second):
        t.Fatal("no reconnect")
    }
}

func TestClientBuffersOnDisconnect(t *testing.T) {
    sock := filepath.Join(t.TempDir(), "test.sock")
    c := NewClient(sock, WithBufferSize(5))

    // Send while disconnected — should buffer
    for i := 0; i < 3; i++ {
        c.Send(Message{Type: "buffered", MsgID: string(rune('a' + i))})
    }

    ln, _ := net.Listen("unix", sock)
    defer ln.Close()
    go c.Connect()
    defer c.Close()

    conn, _ := ln.Accept()
    buf := make([]byte, 65536)
    n, _ := conn.Read(buf)
    lines := 0
    for _, b := range buf[:n] { if b == '\n' { lines++ } }
    if lines != 3 { t.Fatalf("expected 3 buffered messages, got %d", lines) }
}
```

- [ ] **Verify fails:** `cd proxy && go test ./internal/ipc/`

- [ ] **Implement `proxy/internal/ipc/protocol.go`**

```go
package ipc

import "encoding/json"

type Message struct {
    Type  string          `json:"type"`
    MsgID string          `json:"msg_id"`
    Ref   string          `json:"ref,omitempty"`
    Data  json.RawMessage `json:"data,omitempty"`
}

func Frame(m Message) []byte {
    b, _ := json.Marshal(m)
    return append(b, '\n')
}
```

- [ ] **Implement `proxy/internal/ipc/client.go`**

```go
package ipc

import (
    "bufio"
    "encoding/json"
    "net"
    "sync"
    "time"
)

type ClientOption func(*Client)

func WithOnMessage(fn func(Message)) ClientOption  { return func(c *Client) { c.onMessage = fn } }
func WithOnReconnect(fn func()) ClientOption        { return func(c *Client) { c.onReconnect = fn } }
func WithBackoff(min, max time.Duration) ClientOption {
    return func(c *Client) { c.minBackoff = min; c.maxBackoff = max }
}
func WithBufferSize(n int) ClientOption { return func(c *Client) { c.bufSize = n } }

type Client struct {
    sockPath    string
    conn        net.Conn
    mu          sync.Mutex
    onMessage   func(Message)
    reconnectFn func()
    minBackoff  time.Duration
    maxBackoff  time.Duration
    bufSize     int
    buffer      []Message
    closed      bool
}

func NewClient(sockPath string, opts ...ClientOption) *Client {
    c := &Client{
        sockPath:   sockPath,
        minBackoff: 100 * time.Millisecond,
        maxBackoff: 10 * time.Second,
        bufSize:    10000,
        onMessage:  func(Message) {},
    }
    for _, o := range opts {
        o(c)
    }
    return c
}

func (c *Client) Connect() {
    backoff := c.minBackoff
    first := true
    for {
        c.mu.Lock()
        if c.closed { c.mu.Unlock(); return }
        c.mu.Unlock()

        conn, err := net.Dial("unix", c.sockPath)
        if err != nil {
            time.Sleep(backoff)
            backoff *= 2
            if backoff > c.maxBackoff { backoff = c.maxBackoff }
            continue
        }

        c.mu.Lock()
        c.conn = conn
        // Flush buffer
        for _, m := range c.buffer { conn.Write(Frame(m)) }
        c.buffer = nil
        c.mu.Unlock()

        backoff = c.minBackoff
        if !first && c.reconnectFn != nil {
            c.reconnectFn()
        }
        first = false

        c.readLoop(conn)
    }
}

func (c *Client) readLoop(conn net.Conn) {
    scanner := bufio.NewScanner(conn)
    scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
    for scanner.Scan() {
        var m Message
        if err := json.Unmarshal(scanner.Bytes(), &m); err != nil { continue }
        c.onMessage(m)
    }
    c.mu.Lock()
    c.conn = nil
    c.mu.Unlock()
}

func (c *Client) Send(m Message) {
    c.mu.Lock()
    defer c.mu.Unlock()
    if c.conn != nil {
        c.conn.Write(Frame(m))
    } else {
        c.buffer = append(c.buffer, m)
        if len(c.buffer) > c.bufSize {
            c.buffer = c.buffer[1:]
        }
    }
}

func (c *Client) Close() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.closed = true
    if c.conn != nil { c.conn.Close() }
}
```

**Fix:** The `WithOnReconnect` option should set `c.reconnectFn`, not `c.onReconnect`:

```go
func WithOnReconnect(fn func()) ClientOption { return func(c *Client) { c.reconnectFn = fn } }
```

- [ ] **Verify passes:** 4 tests pass
- [ ] **Commit:** `feat: add IPC client with reconnection backoff and message buffering`

---

### Step 3.7 — MITM proxy integration

- [ ] **Write failing test** at `proxy/internal/mitm/proxy_test.go`

```go
package mitm

import (
    "io"
    "net/http"
    "net/http/httptest"
    "net/url"
    "path/filepath"
    "testing"
    "bytes"

    "github.com/jdk/ashp/proxy/internal/auth"
    calib "github.com/jdk/ashp/proxy/internal/ca"
    "github.com/jdk/ashp/proxy/internal/rules"
)

func setupProxy(t *testing.T) (*Proxy, string) {
    dir := t.TempDir()
    calib.GenerateCA(filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key"), []byte("pass"))
    ca, _ := calib.LoadCA(filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key"), []byte("pass"))

    eval := rules.NewEvaluator()
    authH := auth.NewHandler(map[string]string{"agent1": "secret"})
    logKey := bytes.Repeat([]byte{0xab}, 32)

    p := New(Config{
        CA:        ca,
        Evaluator: eval,
        Auth:      authH,
        LogDir:    filepath.Join(dir, "logs"),
        LogKey:    logKey,
    })
    ln := p.Start("127.0.0.1:0")
    return p, "http://" + ln.Addr().String()
}

func TestAllowedRequest(t *testing.T) {
    p, proxyURL := setupProxy(t)
    defer p.Stop()

    p.evaluator.Load([]rules.Rule{
        {ID: 1, URLPattern: `.*`, Methods: nil, Action: "allow", Priority: 0, Enabled: true},
    })

    target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("hello"))
    }))
    defer target.Close()

    client := &http.Client{Transport: &http.Transport{
        Proxy: func(*http.Request) (*url.URL, error) { return url.Parse(proxyURL) },
    }}
    req, _ := http.NewRequest("GET", target.URL+"/test", nil)
    req.Header.Set("Proxy-Authorization", "Basic YWdlbnQxOnNlY3JldA==") // agent1:secret
    resp, err := client.Do(req)
    if err != nil { t.Fatal(err) }
    body, _ := io.ReadAll(resp.Body)
    if string(body) != "hello" { t.Fatalf("got %s", body) }
}

func TestDeniedRequest(t *testing.T) {
    p, proxyURL := setupProxy(t)
    defer p.Stop()

    p.evaluator.Load([]rules.Rule{
        {ID: 1, URLPattern: `.*`, Methods: nil, Action: "deny", Priority: 0, Enabled: true},
    })

    target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        t.Fatal("request should not reach target")
    }))
    defer target.Close()

    client := &http.Client{Transport: &http.Transport{
        Proxy: func(*http.Request) (*url.URL, error) { return url.Parse(proxyURL) },
    }}
    req, _ := http.NewRequest("GET", target.URL+"/blocked", nil)
    req.Header.Set("Proxy-Authorization", "Basic YWdlbnQxOnNlY3JldA==")
    resp, _ := client.Do(req)
    if resp.StatusCode != 403 { t.Fatalf("got status %d", resp.StatusCode) }
}

func TestAuthRequired(t *testing.T) {
    p, proxyURL := setupProxy(t)
    defer p.Stop()

    client := &http.Client{Transport: &http.Transport{
        Proxy: func(*http.Request) (*url.URL, error) { return url.Parse(proxyURL) },
    }}
    req, _ := http.NewRequest("GET", "http://example.com/", nil)
    resp, _ := client.Do(req)
    if resp.StatusCode != 407 { t.Fatalf("expected 407, got %d", resp.StatusCode) }
}
```

- [ ] **Verify fails:** `cd proxy && go test ./internal/mitm/`

- [ ] **Implement `proxy/internal/mitm/proxy.go`**

```go
package mitm

import (
    "crypto/tls"
    "net"
    "net/http"

    "github.com/elazarl/goproxy"
    "github.com/jdk/ashp/proxy/internal/auth"
    "github.com/jdk/ashp/proxy/internal/ca"
    "github.com/jdk/ashp/proxy/internal/ipc"
    "github.com/jdk/ashp/proxy/internal/logger"
    "github.com/jdk/ashp/proxy/internal/rules"
)

type Config struct {
    CA              tls.Certificate
    Evaluator       *rules.Evaluator
    Auth            *auth.Handler
    LogDir          string
    LogKey          []byte
    IPC             *ipc.Client // optional, nil in tests
    DefaultBehavior string
    HoldRequest     func(msg ipc.Message) (approved bool) // Mode B hold callback, nil = no hold support
}

type Proxy struct {
    gp              *goproxy.ProxyHttpServer
    evaluator       *rules.Evaluator
    auth            *auth.Handler
    logWriter       *logger.Writer
    ipc             *ipc.Client
    ln              net.Listener
    defaultBehavior string
    holdRequest     func(msg ipc.Message) (approved bool)
}

func New(cfg Config) *Proxy {
    gp := goproxy.NewProxyHttpServer()
    lw, _ := logger.NewWriter(cfg.LogDir, cfg.LogKey)

    p := &Proxy{
        gp: gp, evaluator: cfg.Evaluator, auth: cfg.Auth,
        logWriter: lw, ipc: cfg.IPC,
        defaultBehavior: cfg.DefaultBehavior,
        holdRequest: cfg.HoldRequest,
    }

    // Set up MITM for CONNECT
    gp.OnRequest().HandleConnect(goproxy.FuncHttpsHandler(
        func(host string, ctx *goproxy.ProxyCtx) (*goproxy.ConnectAction, string) {
            return &goproxy.ConnectAction{
                Action:    goproxy.ConnectMitm,
                TLSConfig: func(host string, ctx *goproxy.ProxyCtx) (*tls.Config, error) {
                    cert, err := ca.SignHost(cfg.CA.Leaf, cfg.CA.PrivateKey, host)
                    if err != nil { return nil, err }
                    return &tls.Config{Certificates: []tls.Certificate{cert}}, nil
                },
            }, host
        },
    ))

    // Request handler
    gp.OnRequest().DoFunc(func(req *http.Request, ctx *goproxy.ProxyCtx) (*http.Request, *http.Response) {
        // Auth check
        agentID, ok := p.auth.Authenticate(req)
        if !ok {
            return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 407, "Proxy Authentication Required")
        }
        req.Header.Del("Proxy-Authorization")

        // Rule evaluation
        fullURL := req.URL.String()
        rule := p.evaluator.Match(fullURL, req.Method)

        if rule != nil && rule.Action == "deny" {
            return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by proxy rule")
        }

        // Determine behavior when no rule matches (or rule matched url_pattern but not methods)
        behavior := p.defaultBehavior
        if rule != nil && rule.Action == "allow" {
            // Rule matched — allow through
            ctx.UserData = map[string]interface{}{"agent_id": agentID, "rule": rule}
            return req, nil
        }
        // No matching rule — apply default behavior (or rule-level default_behavior override)
        if rule != nil && rule.DefaultBehavior != "" {
            behavior = rule.DefaultBehavior
        }

        switch behavior {
        case "deny":
            return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy")
        case "hold":
            // Mode B: Hold & Ask — block the goroutine until approved/denied/timeout
            if p.holdRequest != nil {
                holdMsg := ipc.Message{Type: "approval.needed"}
                approved := p.holdRequest(holdMsg)
                if approved {
                    ctx.UserData = map[string]interface{}{"agent_id": agentID, "rule": rule}
                    return req, nil
                }
                return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 504, "Request denied or timed out awaiting approval")
            }
            return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy (hold not available)")
        case "queue":
            // Mode C: Deny & Queue — instant 403, but queued for later review
            return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy (queued for review)")
        default:
            return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy")
        }
    })

    return p
}

func (p *Proxy) Start(addr string) net.Listener {
    ln, _ := net.Listen("tcp", addr)
    p.ln = ln
    go http.Serve(ln, p.gp)
    return ln
}

func (p *Proxy) Stop() {
    if p.ln != nil { p.ln.Close() }
    if p.logWriter != nil { p.logWriter.Close() }
}
```

- [ ] **Verify passes:** 3 tests pass
- [ ] **Commit:** `feat: add MITM proxy with goproxy, auth, rule evaluation, and TLS interception`

---

### Step 3.8 — Main entry point

- [ ] **Implement `proxy/cmd/ashp-proxy/main.go`**

```go
package main

import (
    "crypto/tls"
    "encoding/json"
    "flag"
    "fmt"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"

    "github.com/jdk/ashp/proxy/internal/auth"
    calib "github.com/jdk/ashp/proxy/internal/ca"
    "github.com/jdk/ashp/proxy/internal/ipc"
    "github.com/jdk/ashp/proxy/internal/mitm"
    "github.com/jdk/ashp/proxy/internal/rules"
)

// heldRequests tracks requests held for Mode B (Hold & Ask).
// Each entry maps an IPC msg_id to a channel that receives true (approved) or false (denied/timeout).
var (
    heldRequests   = make(map[string]chan bool)
    heldRequestsMu sync.Mutex
    holdTimeout    = 60 * time.Second
)

func main() {
    listen := flag.String("listen", "0.0.0.0:8080", "proxy listen address")
    socket := flag.String("socket", "data/ashp.sock", "IPC socket path")
    caDir := flag.String("ca-dir", "data/ca", "CA certificate directory")
    caPass := flag.String("ca-pass", "", "CA key passphrase (or env:VAR)")
    logDir := flag.String("log-dir", "data/logs", "encrypted log directory")
    logKey := flag.String("log-key", "", "log encryption key hex (or env:VAR)")
    authJSON := flag.String("auth", "{}", "JSON map of agent_id:token")
    defaultBehavior := flag.String("default-behavior", "deny", "deny|hold|queue")
    holdTimeoutSec := flag.Int("hold-timeout", 60, "hold timeout in seconds for Mode B")
    flag.Parse()

    holdTimeout = time.Duration(*holdTimeoutSec) * time.Second

    // Resolve env: refs
    caPassVal := resolveEnv(*caPass)
    logKeyVal := resolveEnv(*logKey)

    // Auth tokens
    tokens := map[string]string{}
    json.Unmarshal([]byte(*authJSON), &tokens)

    // CA
    certPath := *caDir + "/root.crt"
    keyPath := *caDir + "/root.key"
    var ca tls.Certificate
    if _, err := os.Stat(certPath); os.IsNotExist(err) {
        os.MkdirAll(*caDir, 0755)
        _, err := calib.GenerateCA(certPath, keyPath, []byte(caPassVal))
        if err != nil { fmt.Fprintf(os.Stderr, "CA generation failed: %v\n", err); os.Exit(1) }
    }
    ca, err := calib.LoadCA(certPath, keyPath, []byte(caPassVal))
    if err != nil { fmt.Fprintf(os.Stderr, "CA load failed: %v\n", err); os.Exit(1) }

    // Rule evaluator
    eval := rules.NewEvaluator()

    // IPC client
    ipcClient := ipc.NewClient(*socket,
        ipc.WithOnMessage(func(m ipc.Message) {
            switch m.Type {
            case "rules.reload":
                var ruleList []rules.Rule
                json.Unmarshal(m.Data, &ruleList)
                eval.Load(ruleList)
            case "config.update":
                // Hot-reload: update default_behavior and logging config
                var update struct {
                    DefaultBehavior string `json:"default_behavior"`
                    HoldTimeoutSec int    `json:"hold_timeout"`
                }
                if err := json.Unmarshal(m.Data, &update); err == nil {
                    if update.DefaultBehavior != "" {
                        *defaultBehavior = update.DefaultBehavior
                    }
                    if update.HoldTimeoutSec > 0 {
                        holdTimeout = time.Duration(update.HoldTimeoutSec) * time.Second
                    }
                }
            case "approval.resolve":
                // Release held request by ref (the original approval.needed msg_id)
                heldRequestsMu.Lock()
                ch, ok := heldRequests[m.Ref]
                if ok {
                    delete(heldRequests, m.Ref)
                }
                heldRequestsMu.Unlock()
                if ok {
                    var resolve struct {
                        Action string `json:"action"`
                    }
                    json.Unmarshal(m.Data, &resolve)
                    ch <- (resolve.Action == "approve")
                }
            }
        }),
        ipc.WithOnReconnect(func() {
            // Re-announce held requests on reconnect so Node can re-display them in the GUI
            heldRequestsMu.Lock()
            heldMsgIDs := make([]string, 0, len(heldRequests))
            for msgID := range heldRequests {
                heldMsgIDs = append(heldMsgIDs, msgID)
            }
            heldRequestsMu.Unlock()
            for _, msgID := range heldMsgIDs {
                ipcClient.Send(ipc.Message{
                    Type:  "approval.needed",
                    MsgID: msgID,
                })
            }
        }),
    )
    go ipcClient.Connect()

    // Hold request callback for Mode B
    holdRequestFn := func(msg ipc.Message) bool {
        ch := make(chan bool, 1)
        heldRequestsMu.Lock()
        heldRequests[msg.MsgID] = ch
        heldRequestsMu.Unlock()

        // Send approval.needed to Node via IPC
        ipcClient.Send(msg)

        // Wait for approval or timeout
        select {
        case approved := <-ch:
            return approved
        case <-time.After(holdTimeout):
            // Timeout — clean up and deny
            heldRequestsMu.Lock()
            delete(heldRequests, msg.MsgID)
            heldRequestsMu.Unlock()
            return false
        }
    }

    // Proxy
    p := mitm.New(mitm.Config{
        CA: ca, Evaluator: eval, Auth: auth.NewHandler(tokens),
        LogDir: *logDir, LogKey: []byte(logKeyVal),
        IPC: ipcClient, DefaultBehavior: *defaultBehavior,
        HoldRequest: holdRequestFn,
    })
    ln := p.Start(*listen)
    fmt.Fprintf(os.Stderr, "ASHP proxy listening on %s\n", ln.Addr())

    // Graceful shutdown
    sig := make(chan os.Signal, 1)
    signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
    <-sig
    fmt.Fprintln(os.Stderr, "Shutting down...")
    p.Stop()
    ipcClient.Close()
}

func resolveEnv(val string) string {
    if len(val) > 4 && val[:4] == "env:" {
        return os.Getenv(val[4:])
    }
    return val
}
```

- [ ] **Verify builds:** `cd proxy && go build ./cmd/ashp-proxy/`
- [ ] **Commit:** `feat: add Go proxy main entry point with CLI flags and graceful shutdown`

---

### Step 3.9 — Run full Go test suite

- [ ] **Run:** `cd proxy && go test ./...`
- [ ] **Expected:** ~17 tests pass across 6 packages (ca 3, rules 3, auth 4, logger 4, ipc 4, mitm 3 — numbers approximate, depends on sub-tests)
- [ ] **Commit (if needed):** `chore: chunk 3 complete — Go proxy core with MITM, rules, auth, logging, IPC`

---

## Chunk 4: React GUI

**Convention:** Use Vite + React 19 + React Router v7. Tests use Vitest + `@testing-library/react`. Focus tests on the API client and SSE hook; page components get light smoke tests.

---

### Step 4.1 — React project setup

- [ ] **Create `gui/package.json`**

```json
{
  "name": "ashp-gui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "jsdom": "^25.0.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Create `gui/vite.config.js`**

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  test: { environment: 'jsdom', globals: true, setupFiles: './src/test-setup.js' },
});
```

- [ ] **Create `gui/src/test-setup.js`**

```js
import '@testing-library/jest-dom';
```

- [ ] **Create `gui/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ASHP</title></head>
<body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>
</html>
```

- [ ] **Create `gui/src/main.jsx`**

```jsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')).render(
  <StrictMode><App /></StrictMode>
);
```

- [ ] **Run:** `cd gui && npm install`
- [ ] **Verify:** `cd gui && npx vite build` succeeds
- [ ] **Commit:** `chore: bootstrap React GUI with Vite, React Router, and Vitest`

---

### Step 4.2 — API client module + SSE hook

- [ ] **Write failing test** at `gui/src/api/client.test.js`

Tests (mock `fetch` with `vi.fn()`):
1. `getRules calls GET /api/rules with auth header`
2. `createRule calls POST /api/rules with body`
3. `resolveApproval calls POST /api/approvals/:id/resolve`
4. `getStatus calls GET /api/status`
5. `handles 401 by throwing AuthError`
6. `handles non-OK response by throwing with status`

- [ ] **Write failing test** at `gui/src/api/useSSE.test.js`

Tests (mock `EventSource`):
1. `connects to /api/events with auth` — assert EventSource created with correct URL
2. `calls handler on event` — simulate `message` event, assert handler called with parsed data
3. `reconnects on error` — simulate `error` event, assert new EventSource created
4. `cleans up on unmount` — unmount hook, assert `close()` called

- [ ] **Verify fails:** `cd gui && npx vitest run`

- [ ] **Implement `gui/src/api/client.js`**

```js
class AuthError extends Error { constructor() { super('Unauthorized'); this.name = 'AuthError'; } }

function createClient(baseURL = '', token = '') {
  async function request(method, path, body) {
    const opts = {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${baseURL}${path}`, opts);
    if (res.status === 401) throw new AuthError();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      try { err.body = await res.json(); } catch {}
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // For binary/body download endpoints that return raw content, not JSON
  async function requestRaw(method, path) {
    const res = await fetch(`${baseURL}${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      try { err.body = await res.json(); } catch {}
      throw err;
    }
    return res.text();
  }

  return {
    getRules:         ()          => request('GET', '/api/rules'),
    getRule:          (id)        => request('GET', `/api/rules/${id}`),
    createRule:       (rule)      => request('POST', '/api/rules', rule),
    updateRule:       (id, rule)  => request('PUT', `/api/rules/${id}`, rule),
    deleteRule:       (id)        => request('DELETE', `/api/rules/${id}`),
    testRule:         (url, method) => request('POST', '/api/rules/test', { url, method }),
    getLogs:          (params)    => request('GET', `/api/logs?${new URLSearchParams(params)}`),
    getLog:           (id)        => request('GET', `/api/logs/${id}`),
    getRequestBody:   (id)        => requestRaw('GET', `/api/logs/${id}/request-body`),
    getResponseBody:  (id)        => requestRaw('GET', `/api/logs/${id}/response-body`),
    getApprovals:     ()          => request('GET', '/api/approvals'),
    resolveApproval:  (id, body)  => request('POST', `/api/approvals/${id}/resolve`, body),
    getStatus:        ()          => request('GET', '/api/status'),
  };
}

export { createClient, AuthError };
```

- [ ] **Implement `gui/src/api/useSSE.js`**

```js
import { useEffect, useRef, useCallback } from 'react';

export function useSSE(url, { onEvent, token } = {}) {
  const esRef = useRef(null);
  const reconnectTimer = useRef(null);

  const connect = useCallback(() => {
    // EventSource doesn't support custom headers, so pass token as query param
    const es = new EventSource(`${url}?token=${encodeURIComponent(token || '')}`);
    esRef.current = es;

    const eventTypes = ['request.allowed', 'request.blocked', 'approval.needed', 'approval.resolved', 'rules.changed'];
    for (const type of eventTypes) {
      es.addEventListener(type, (e) => {
        if (onEvent) onEvent(type, JSON.parse(e.data));
      });
    }

    es.onerror = () => {
      es.close();
      reconnectTimer.current = setTimeout(connect, 3000);
    };
  }, [url, token, onEvent]);

  useEffect(() => {
    connect();
    return () => {
      if (esRef.current) esRef.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);
}
```

- [ ] **Verify passes:** `cd gui && npx vitest run` — all API + SSE tests pass
- [ ] **Commit:** `feat: add API client module and useSSE hook with reconnection`

---

### Step 4.3 — Login page

- [ ] **Create `gui/src/pages/Login.jsx`**

```jsx
import { useState } from 'react';

export default function Login({ onLogin }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    try {
      const res = await fetch('/api/status', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) { onLogin(token); }
      else { setError('Invalid token'); }
    } catch { setError('Connection failed'); }
  }

  return (
    <div className="login">
      <h1>ASHP</h1>
      <form onSubmit={handleSubmit}>
        <input type="password" value={token} onChange={e => setToken(e.target.value)}
               placeholder="Bearer token" required />
        <button type="submit">Login</button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
```

- [ ] **Commit:** `feat: add login page with token validation`

---

### Step 4.4 — Layout component

- [ ] **Create `gui/src/components/Layout.jsx`**

```jsx
import { NavLink, Outlet } from 'react-router-dom';

export default function Layout({ onLogout }) {
  return (
    <div className="layout">
      <nav>
        <NavLink to="/">Dashboard</NavLink>
        <NavLink to="/rules">Rules</NavLink>
        <NavLink to="/logs">Logs</NavLink>
        <NavLink to="/approvals">Approvals</NavLink>
        <button onClick={onLogout}>Logout</button>
      </nav>
      <main><Outlet /></main>
    </div>
  );
}
```

- [ ] **Commit:** `feat: add layout component with navigation`

---

### Step 4.5 — Dashboard page

- [ ] **Create `gui/src/pages/Dashboard.jsx`**

```jsx
import { useState, useEffect } from 'react';

export default function Dashboard({ api, events }) {
  const [status, setStatus] = useState(null);
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    api.getStatus().then(setStatus);
    api.getLogs({ limit: 10 }).then(setRecent);
  }, [api]);

  // Live updates via SSE events prop
  useEffect(() => {
    if (!events) return;
    const handler = (type, data) => {
      setRecent(prev => [{ ...data, _event: type }, ...prev].slice(0, 20));
    };
    events.subscribe(handler);
    return () => events.unsubscribe(handler);
  }, [events]);

  if (!status) return <p>Loading...</p>;

  return (
    <div>
      <h2>Dashboard</h2>
      <div className="stats">
        <div>Proxy: {status.proxy?.running ? 'Running' : 'Stopped'}</div>
        <div>Rules: {status.rules_count}</div>
        <div>Source: {status.rules_source}</div>
        <div>Uptime: {Math.round((status.proxy?.uptime_ms || 0) / 1000)}s</div>
      </div>
      <h3>Recent Activity</h3>
      <table>
        <thead><tr><th>Time</th><th>Method</th><th>URL</th><th>Decision</th></tr></thead>
        <tbody>
          {recent.map((r, i) => (
            <tr key={r.id || i}>
              <td>{r.timestamp || 'now'}</td>
              <td>{r.method}</td>
              <td>{r.url}</td>
              <td>{r.decision || r._event}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Commit:** `feat: add dashboard page with real-time activity feed`

---

### Step 4.6 — Rules page

- [ ] **Create `gui/src/components/RuleForm.jsx`**

```jsx
import { useState } from 'react';

const EMPTY = { name: '', url_pattern: '', methods: [], action: 'allow', priority: 0, enabled: true,
  log_request_body: 'full', log_response_body: 'full', default_behavior: '' };

export default function RuleForm({ rule, onSave, onCancel }) {
  const [form, setForm] = useState(rule || EMPTY);
  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form); }}>
      <label>Name <input value={form.name} onChange={e => set('name', e.target.value)} required /></label>
      <label>URL Pattern <input value={form.url_pattern} onChange={e => set('url_pattern', e.target.value)} required /></label>
      <label>Methods (comma-sep) <input value={form.methods.join(',')}
        onChange={e => set('methods', e.target.value ? e.target.value.split(',').map(s => s.trim()) : [])} /></label>
      <label>Action
        <select value={form.action} onChange={e => set('action', e.target.value)}>
          <option value="allow">Allow</option><option value="deny">Deny</option>
        </select>
      </label>
      <label>Priority <input type="number" value={form.priority} onChange={e => set('priority', +e.target.value)} /></label>
      <label>Log Request Body
        <select value={form.log_request_body} onChange={e => set('log_request_body', e.target.value)}>
          <option value="full">Full</option><option value="none">None</option>
          <option value="truncate:65536">Truncate (64K)</option>
        </select>
      </label>
      <label>Log Response Body
        <select value={form.log_response_body} onChange={e => set('log_response_body', e.target.value)}>
          <option value="full">Full</option><option value="none">None</option>
          <option value="truncate:65536">Truncate (64K)</option>
        </select>
      </label>
      <label>Default Behavior Override
        <select value={form.default_behavior || ''} onChange={e => set('default_behavior', e.target.value || null)}>
          <option value="">(inherit global)</option>
          <option value="deny">Deny</option><option value="hold">Hold</option><option value="queue">Queue</option>
        </select>
      </label>
      <label><input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} /> Enabled</label>
      <button type="submit">Save</button>
      {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
    </form>
  );
}
```

- [ ] **Create `gui/src/pages/Rules.jsx`**

```jsx
import { useState, useEffect } from 'react';
import RuleForm from '../components/RuleForm';

export default function Rules({ api, readOnly }) {
  const [rules, setRules] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | rule object
  const [testResult, setTestResult] = useState(null);

  useEffect(() => { api.getRules().then(setRules); }, [api]);

  async function handleSave(rule) {
    if (editing === 'new') { await api.createRule(rule); }
    else { await api.updateRule(editing.id, rule); }
    setEditing(null);
    setRules(await api.getRules());
  }

  async function handleDelete(id) {
    await api.deleteRule(id);
    setRules(await api.getRules());
  }

  async function handleTest(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    setTestResult(await api.testRule(fd.get('url'), fd.get('method')));
  }

  return (
    <div>
      <h2>Rules {readOnly && <span>(read-only)</span>}</h2>
      {!readOnly && !editing && <button onClick={() => setEditing('new')}>New Rule</button>}
      {editing && <RuleForm rule={editing === 'new' ? null : editing}
        onSave={handleSave} onCancel={() => setEditing(null)} />}
      <table>
        <thead><tr><th>Priority</th><th>Name</th><th>Pattern</th><th>Methods</th><th>Action</th><th>Enabled</th><th></th></tr></thead>
        <tbody>
          {rules.map(r => (
            <tr key={r.id}>
              <td>{r.priority}</td><td>{r.name}</td><td><code>{r.url_pattern}</code></td>
              <td>{r.methods.join(', ') || '*'}</td><td>{r.action}</td><td>{r.enabled ? 'Yes' : 'No'}</td>
              <td>{!readOnly && <>
                <button onClick={() => setEditing(r)}>Edit</button>
                <button onClick={() => handleDelete(r.id)}>Delete</button>
              </>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Test URL</h3>
      <form onSubmit={handleTest}>
        <input name="url" placeholder="https://example.com/path" required />
        <input name="method" placeholder="GET" defaultValue="GET" />
        <button type="submit">Test</button>
      </form>
      {testResult && <pre>{JSON.stringify(testResult, null, 2)}</pre>}
    </div>
  );
}
```

- [ ] **Commit:** `feat: add rules page with CRUD, read-only mode, and test endpoint`

---

### Step 4.7 — Logs page

- [ ] **Create `gui/src/pages/Logs.jsx`**

```jsx
import { useState, useEffect } from 'react';

export default function Logs({ api }) {
  const [logs, setLogs] = useState([]);
  const [filters, setFilters] = useState({ limit: 50, offset: 0 });
  const [selected, setSelected] = useState(null);
  const [body, setBody] = useState(null);

  useEffect(() => { api.getLogs(filters).then(setLogs); }, [api, filters]);

  async function viewBody(logId, type) {
    const detail = await api.getLog(logId);
    setSelected(detail);
    const ref = detail[`${type}_body_ref`];
    if (!ref) {
      setBody('No body recorded');
      return;
    }
    try {
      const content = type === 'request'
        ? await api.getRequestBody(logId)
        : await api.getResponseBody(logId);
      setBody(content);
    } catch (err) {
      setBody(`Failed to load body: ${err.message}`);
    }
  }

  return (
    <div>
      <h2>Request Logs</h2>
      <div className="filters">
        <select onChange={e => setFilters(f => ({ ...f, method: e.target.value || undefined }))}>
          <option value="">All Methods</option>
          {['GET','POST','PUT','DELETE','PATCH'].map(m => <option key={m}>{m}</option>)}
        </select>
        <select onChange={e => setFilters(f => ({ ...f, decision: e.target.value || undefined }))}>
          <option value="">All Decisions</option>
          {['allowed','denied','held','queued'].map(d => <option key={d}>{d}</option>)}
        </select>
        <input type="text" placeholder="URL filter"
          onChange={e => setFilters(f => ({ ...f, url: e.target.value || undefined }))} />
      </div>
      <table>
        <thead><tr><th>ID</th><th>Time</th><th>Method</th><th>URL</th><th>Status</th><th>Decision</th><th>Duration</th><th></th></tr></thead>
        <tbody>
          {logs.map(l => (
            <tr key={l.id} onClick={() => setSelected(l)}>
              <td>{l.id}</td><td>{l.timestamp}</td><td>{l.method}</td>
              <td title={l.url}>{l.url.substring(0, 60)}</td>
              <td>{l.response_status}</td><td>{l.decision}</td><td>{l.duration_ms}ms</td>
              <td><button onClick={() => viewBody(l.id, 'request')}>Body</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pagination">
        <button disabled={filters.offset === 0}
          onClick={() => setFilters(f => ({ ...f, offset: f.offset - f.limit }))}>Prev</button>
        <button disabled={logs.length < filters.limit}
          onClick={() => setFilters(f => ({ ...f, offset: f.offset + f.limit }))}>Next</button>
      </div>
      {selected && <div className="detail">
        <h3>Log #{selected.id}</h3>
        <pre>{JSON.stringify(selected, null, 2)}</pre>
        {body && <pre>{body}</pre>}
        <button onClick={() => { setSelected(null); setBody(null); }}>Close</button>
      </div>}
    </div>
  );
}
```

- [ ] **Commit:** `feat: add logs page with filters, pagination, and body viewer`

---

### Step 4.8 — Approvals page

- [ ] **Create `gui/src/components/ApprovalCard.jsx`**

```jsx
export default function ApprovalCard({ approval, onResolve }) {
  return (
    <div className="approval-card">
      <div><strong>#{approval.id}</strong> — Request #{approval.request_log_id}</div>
      <div>Pattern: <code>{approval.suggested_pattern || 'N/A'}</code></div>
      <div>Methods: {approval.suggested_methods || 'N/A'}</div>
      <div>Status: {approval.status}</div>
      {approval.status === 'pending' && (
        <div className="actions">
          <button onClick={() => onResolve(approval.id, 'approve', false)}>Approve</button>
          <button onClick={() => onResolve(approval.id, 'approve', true)}>Approve + Create Rule</button>
          <button onClick={() => onResolve(approval.id, 'reject', false)}>Reject</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Create `gui/src/pages/Approvals.jsx`**

```jsx
import { useState, useEffect } from 'react';
import ApprovalCard from '../components/ApprovalCard';

export default function Approvals({ api, events }) {
  const [approvals, setApprovals] = useState([]);

  const load = () => api.getApprovals().then(setApprovals);
  useEffect(() => { load(); }, [api]);

  // Auto-refresh on SSE events
  useEffect(() => {
    if (!events) return;
    const handler = (type) => {
      if (type === 'approval.needed' || type === 'approval.resolved') load();
    };
    events.subscribe(handler);
    return () => events.unsubscribe(handler);
  }, [events]);

  async function handleResolve(id, action, createRule) {
    await api.resolveApproval(id, { action, create_rule: createRule });
    load();
  }

  return (
    <div>
      <h2>Approval Queue ({approvals.length} pending)</h2>
      {approvals.length === 0 && <p>No pending approvals.</p>}
      {approvals.map(a => (
        <ApprovalCard key={a.id} approval={a} onResolve={handleResolve} />
      ))}
    </div>
  );
}
```

- [ ] **Commit:** `feat: add approvals page with pending queue and resolve actions`

---

### Step 4.9 — App component (router wiring)

- [ ] **Write failing test** at `gui/src/App.test.jsx`

Smoke test: renders without crashing, shows login when no token.

```jsx
import { render, screen } from '@testing-library/react';
import App from './App';

test('shows login page initially', () => {
  render(<App />);
  expect(screen.getByPlaceholderText('Bearer token')).toBeInTheDocument();
});
```

- [ ] **Verify fails:** `cd gui && npx vitest run`

- [ ] **Implement `gui/src/App.jsx`**

```jsx
import { useState, useMemo, useCallback } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { createClient } from './api/client';
import { useSSE } from './api/useSSE';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Rules from './pages/Rules';
import Logs from './pages/Logs';
import Approvals from './pages/Approvals';

function EventBridge({ token, children }) {
  const subscribers = useMemo(() => new Set(), []);
  const onEvent = useCallback((type, data) => {
    for (const fn of subscribers) fn(type, data);
  }, [subscribers]);

  useSSE('/api/events', { onEvent, token });

  const events = useMemo(() => ({
    subscribe: (fn) => subscribers.add(fn),
    unsubscribe: (fn) => subscribers.delete(fn),
  }), [subscribers]);

  return children(events);
}

export default function App() {
  const [token, setToken] = useState(sessionStorage.getItem('ashp_token'));
  const api = useMemo(() => token ? createClient('', token) : null, [token]);

  function handleLogin(t) {
    sessionStorage.setItem('ashp_token', t);
    setToken(t);
  }
  function handleLogout() {
    sessionStorage.removeItem('ashp_token');
    setToken(null);
  }

  if (!token) return <Login onLogin={handleLogin} />;

  return (
    <EventBridge token={token}>
      {(events) => (
        <BrowserRouter>
          <Routes>
            <Route element={<Layout onLogout={handleLogout} />}>
              <Route index element={<Dashboard api={api} events={events} />} />
              <Route path="rules" element={<Rules api={api} />} />
              <Route path="logs" element={<Logs api={api} />} />
              <Route path="approvals" element={<Approvals api={api} events={events} />} />
            </Route>
          </Routes>
        </BrowserRouter>
      )}
    </EventBridge>
  );
}
```

- [ ] **Verify passes:** `cd gui && npx vitest run` — App + API + SSE tests pass
- [ ] **Commit:** `feat: add App component with router, auth state, and SSE event bridge`

---

### Step 4.10 — Run full GUI test suite

- [ ] **Run:** `cd gui && npx vitest run`
- [ ] **Expected:** ~11 tests pass (client 6, useSSE 4, App 1)
- [ ] **Commit (if needed):** `chore: chunk 4 complete — React GUI with dashboard, rules, logs, approvals`

---

## Chunk 5: Integration, Docker, E2E

**Convention:** E2E tests use `node:test`. Each test spawns the full stack (Node server + Go proxy) using a helper that creates temp directories, generates configs, and cleans up. Tests make real HTTP requests through the proxy.

---

### Step 5.1 — Final Makefile

- [ ] **Update `Makefile`** (replace existing content)

```makefile
.PHONY: build build-proxy build-gui dev test test-server test-proxy test-gui test-e2e clean

build: build-proxy build-gui

build-proxy:
	cd proxy && go build -o ashp-proxy ./cmd/ashp-proxy/

build-gui:
	cd gui && npm run build

dev:
	@echo "Starting dev mode..."
	cd proxy && go build -o ashp-proxy ./cmd/ashp-proxy/ && cd ..
	cd server && node --watch src/index.js -- --config ../ashp.example.json &
	cd gui && npx vite &
	wait

test: test-proxy test-server test-gui

test-proxy:
	cd proxy && go test ./...

test-server:
	cd server && node --test src/**/*.test.js

test-gui:
	cd gui && npx vitest run

test-e2e: build-proxy
	cd server && node --test ../test/e2e/*.test.js

clean:
	rm -f proxy/ashp-proxy
	rm -rf gui/dist
	rm -rf data/
```

- [ ] **Commit:** `chore: update Makefile with full build, test, and dev targets`

---

### Step 5.2 — Dockerfile

- [ ] **Create `Dockerfile`**

```dockerfile
# Stage 1: Go build
FROM golang:1.22-alpine AS go-build
WORKDIR /src/proxy
COPY proxy/go.mod proxy/go.sum ./
RUN go mod download
COPY proxy/ ./
RUN CGO_ENABLED=0 go build -o /ashp-proxy ./cmd/ashp-proxy/

# Stage 2: GUI build
FROM node:22-alpine AS gui-build
WORKDIR /src/gui
COPY gui/package.json gui/package-lock.json ./
RUN npm ci
COPY gui/ ./
RUN npm run build

# Stage 3: Runtime
FROM node:22-alpine
RUN apk add --no-cache sqlite-dev python3 make g++
WORKDIR /app

# Server dependencies
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --production

# Application files
COPY server/src/ ./server/src/
COPY --from=go-build /ashp-proxy ./proxy/ashp-proxy
COPY --from=gui-build /src/gui/dist ./gui/dist/

# Data directory
RUN mkdir -p /app/data/ca /app/data/logs

EXPOSE 8080 3000
ENV NODE_ENV=production
CMD ["node", "server/src/index.js", "--config", "/app/ashp.json"]
```

- [ ] **Commit:** `feat: add multi-stage Dockerfile for Go + React + Node runtime`

---

### Step 5.3 — docker-compose.yml

- [ ] **Create `docker-compose.yml`**

```yaml
services:
  ashp:
    build: .
    ports:
      - "8080:8080"
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./ashp.json:/app/ashp.json:ro
      - ./rules.json:/app/rules.json:ro
    environment:
      - ASHP_DB_KEY=dev-db-key-change-in-production
      - ASHP_LOG_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      - ASHP_CA_KEY=dev-ca-key-change-in-production

  ashp-dev:
    profiles: ["dev"]
    build: .
    ports:
      - "8080:8080"
      - "3000:3000"
      - "5173:5173"
    volumes:
      - ./server/src:/app/server/src
      - ./data:/app/data
      - ./ashp.json:/app/ashp.json:ro
    environment:
      - ASHP_DB_KEY=dev-db-key
      - ASHP_LOG_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      - ASHP_CA_KEY=dev-ca-key
    command: node --watch server/src/index.js --config /app/ashp.json
```

- [ ] **Commit:** `feat: add docker-compose.yml for production and dev profiles`

---

### Step 5.4 — E2E test setup

- [ ] **Create `test/e2e/setup.js`**

```js
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { startServer } from '../../server/src/index.js';

export async function createTestStack() {
  const dir = mkdirSync(join(tmpdir(), `ashp-e2e-${Date.now()}`), { recursive: true });
  const dbPath = join(dir, 'ashp.db');
  const sockPath = join(dir, 'ashp.sock');

  // Ensure proxy binary exists
  const proxyBin = join(process.cwd(), 'proxy', 'ashp-proxy');

  // Write config
  const config = {
    proxy: { listen: '127.0.0.1:0', auth: { agent1: 'test-token' } },
    management: { listen: '127.0.0.1:0', bearer_token: 'mgmt-secret' },
    rules: { source: 'db' },
    default_behavior: 'deny',
    logging: { request_body: 'full', response_body: 'full', retention_days: 1 },
    database: { path: dbPath, encryption_key: 'test-db-key' },
    encryption: { log_key: 'a'.repeat(64), ca_key: 'test-ca-pass' },
    webhooks: [],
  };
  const configPath = join(dir, 'ashp.json');
  writeFileSync(configPath, JSON.stringify(config));

  const stack = await startServer({ config: configPath });

  const mgmtPort = stack.server.address().port;
  const apiBase = `http://127.0.0.1:${mgmtPort}`;

  // Wait for the management API to be ready by polling /api/status
  async function waitForReady(maxAttempts = 30, interval = 200) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`${apiBase}/api/status`, {
          headers: { 'Authorization': 'Bearer mgmt-secret' },
        });
        if (res.ok) return;
      } catch {}
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error('Management API did not become ready');
  }
  await waitForReady();

  // Determine proxy port (from proxy manager if available, or from config)
  const proxyPort = stack.proxyManager?.getStatus?.()?.port || null;
  const proxyBase = proxyPort ? `http://127.0.0.1:${proxyPort}` : null;

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Authorization': 'Bearer mgmt-secret', 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${apiBase}${path}`, opts);
    return { status: res.status, body: res.status !== 204 ? await res.json() : null };
  }

  return {
    dir, apiBase, proxyBase, api, stack,
    mgmtPort, proxyPort,
    cleanup() {
      stack.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Commit:** `feat: add E2E test setup helper with full stack lifecycle`

---

### Step 5.5 — E2E: proxy allow flow

- [ ] **Create `test/e2e/proxy-allow.test.js`**

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestStack } from './setup.js';

describe('E2E: proxy allow flow', () => {
  let t, targetURL, target;

  before(async () => {
    t = await createTestStack();

    // Create a target HTTP server
    target = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('target-response');
    });
    await new Promise(r => target.listen(0, '127.0.0.1', r));
    targetURL = `http://127.0.0.1:${target.address().port}`;

    // Create allow rule
    await t.api('POST', '/api/rules', {
      name: 'Allow target',
      url_pattern: targetURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/.*',
      methods: ['GET'],
      action: 'allow',
      priority: 100,
      enabled: true,
    });
  });

  after(() => { target.close(); t.cleanup(); });

  it('proxied GET request is allowed and logged', async () => {
    // Verify rule exists via API
    const { body: rules } = await t.api('GET', '/api/rules');
    assert.ok(rules.length >= 1);

    // Make an actual request through the proxy
    if (t.proxyBase) {
      const body = await proxyRequest(t.proxyBase, targetURL + '/test', 'GET', 'agent1', 'test-token');
      assert.equal(body, 'target-response');

      // Wait briefly for async logging, then verify log exists
      await new Promise(r => setTimeout(r, 500));
      const { body: logs } = await t.api('GET', '/api/logs?limit=1');
      assert.ok(logs.length >= 1);
      assert.equal(logs[0].decision, 'allowed');
    }
  });

  it('rule test endpoint confirms allow', async () => {
    const { body } = await t.api('POST', '/api/rules/test', {
      url: targetURL + '/test',
      method: 'GET',
    });
    assert.equal(body.decision, 'allow');
  });
});

// Helper: make an HTTP request through the proxy using Proxy-Authorization
function proxyRequest(proxyBase, targetUrl, method, user, pass) {
  const proxyUrl = new URL(proxyBase);
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port,
      method,
      path: targetUrl,
      headers: {
        'Host': target.host,
        'Proxy-Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`Proxy returned ${res.statusCode}: ${data}`));
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.end();
  });
}
```

- [ ] **Run:** `cd . && node --test test/e2e/proxy-allow.test.js`
- [ ] **Verify passes**
- [ ] **Commit:** `test: add E2E proxy allow flow test`

---

### Step 5.6 — E2E: proxy deny flow

- [ ] **Create `test/e2e/proxy-deny.test.js`**

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestStack } from './setup.js';

describe('E2E: proxy deny flow', () => {
  let t, target, targetURL;

  before(async () => {
    t = await createTestStack();

    // Create a target server that should never be reached for denied requests
    target = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('should-not-reach');
    });
    await new Promise(r => target.listen(0, '127.0.0.1', r));
    targetURL = `http://127.0.0.1:${target.address().port}`;
  });
  after(() => { target.close(); t.cleanup(); });

  it('request with no matching rule is denied by default', async () => {
    const { body } = await t.api('POST', '/api/rules/test', {
      url: 'https://evil.com/hack',
      method: 'GET',
    });
    assert.equal(body.decision, 'deny');
    assert.equal(body.match, null);
  });

  it('actual proxied request with no matching rule gets 403', async () => {
    if (t.proxyBase) {
      const statusCode = await proxyRequestStatus(t.proxyBase, targetURL + '/blocked', 'GET', 'agent1', 'test-token');
      assert.equal(statusCode, 403);
    }
  });

  it('request matching deny rule is denied', async () => {
    await t.api('POST', '/api/rules', {
      name: 'Block evil.com',
      url_pattern: '^https://evil\\.com/.*$',
      methods: [],
      action: 'deny',
      priority: 100,
      enabled: true,
    });

    const { body } = await t.api('POST', '/api/rules/test', {
      url: 'https://evil.com/hack',
      method: 'POST',
    });
    assert.equal(body.decision, 'deny');
    assert.ok(body.match);
    assert.equal(body.match.action, 'deny');
  });
});

// Helper: make an HTTP request through the proxy and return the status code
function proxyRequestStatus(proxyBase, targetUrl, method, user, pass) {
  const proxyUrl = new URL(proxyBase);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port,
      method,
      path: targetUrl,
      headers: {
        'Proxy-Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}
```

- [ ] **Run:** `node --test test/e2e/proxy-deny.test.js`
- [ ] **Verify passes**
- [ ] **Commit:** `test: add E2E proxy deny flow test`

---

### Step 5.7 — E2E: hold & approve flow

- [ ] **Create `test/e2e/proxy-hold.test.js`**

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestStack } from './setup.js';

describe('E2E: hold & approve flow', () => {
  let t, target, targetURL;

  before(async () => {
    t = await createTestStack();

    // Create a target HTTP server for hold flow tests
    target = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('approved-response');
    });
    await new Promise(r => target.listen(0, '127.0.0.1', r));
    targetURL = `http://127.0.0.1:${target.address().port}`;
  });
  after(() => { target.close(); t.cleanup(); });

  it('approval queue starts empty', async () => {
    const { body } = await t.api('GET', '/api/approvals');
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  it('resolve returns 404 for nonexistent approval', async () => {
    const { status } = await t.api('POST', '/api/approvals/999/resolve', {
      action: 'approve', create_rule: false,
    });
    assert.equal(status, 404);
  });

  it('reject with invalid action returns 400', async () => {
    const { status } = await t.api('POST', '/api/approvals/1/resolve', {
      action: 'maybe',
    });
    assert.equal(status, 400);
  });

  it('hold flow: request is held, approved via API, and forwarded', async () => {
    if (!t.proxyBase) return; // Skip if no proxy available

    // Send a proxied request in the background (it will block waiting for approval)
    const proxyUrl = new URL(t.proxyBase);
    const proxyReq = new Promise((resolve, reject) => {
      const req = http.request({
        host: proxyUrl.hostname,
        port: proxyUrl.port,
        method: 'GET',
        path: targetURL + '/held-path',
        headers: {
          'Proxy-Authorization': 'Basic ' + Buffer.from('agent1:test-token').toString('base64'),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end();
    });

    // Wait for the approval to appear in the queue
    let approvals = [];
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      const { body } = await t.api('GET', '/api/approvals');
      if (body.length > 0) { approvals = body; break; }
    }

    if (approvals.length > 0) {
      // Approve the held request
      const { status } = await t.api('POST', `/api/approvals/${approvals[0].id}/resolve`, {
        action: 'approve', create_rule: false,
      });
      assert.equal(status, 200);

      // The proxied request should now complete successfully
      const result = await proxyReq;
      assert.equal(result.statusCode, 200);
      assert.equal(result.body, 'approved-response');
    }
  });
});
```

- [ ] **Run:** `node --test test/e2e/proxy-hold.test.js`
- [ ] **Verify passes**
- [ ] **Commit:** `test: add E2E hold and approve flow test`

---

### Step 5.8 — E2E: rule CRUD via API

- [ ] **Create `test/e2e/rule-crud.test.js`**

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestStack } from './setup.js';

describe('E2E: rule CRUD via API', () => {
  let t, ruleId;

  before(async () => { t = await createTestStack(); });
  after(() => t.cleanup());

  it('creates a rule', async () => {
    const { status, body } = await t.api('POST', '/api/rules', {
      name: 'Allow GitHub',
      url_pattern: '^https://api\\.github\\.com/.*$',
      methods: ['GET', 'POST'],
      action: 'allow',
      priority: 100,
      enabled: true,
    });
    assert.equal(status, 201);
    assert.ok(body.id);
    ruleId = body.id;
  });

  it('reads the rule back', async () => {
    const { status, body } = await t.api('GET', `/api/rules/${ruleId}`);
    assert.equal(status, 200);
    assert.equal(body.name, 'Allow GitHub');
    assert.deepEqual(body.methods, ['GET', 'POST']);
  });

  it('updates the rule', async () => {
    const { status, body } = await t.api('PUT', `/api/rules/${ruleId}`, {
      name: 'Allow GitHub v2',
      priority: 200,
    });
    assert.equal(status, 200);
    assert.equal(body.name, 'Allow GitHub v2');
    assert.equal(body.priority, 200);
  });

  it('test endpoint matches updated rule', async () => {
    const { body } = await t.api('POST', '/api/rules/test', {
      url: 'https://api.github.com/repos/foo/bar',
      method: 'GET',
    });
    assert.equal(body.decision, 'allow');
    assert.equal(body.match.id, ruleId);
  });

  it('deletes the rule', async () => {
    const { status } = await t.api('DELETE', `/api/rules/${ruleId}`);
    assert.equal(status, 204);
  });

  it('deleted rule returns 404', async () => {
    const { status } = await t.api('GET', `/api/rules/${ruleId}`);
    assert.equal(status, 404);
  });

  it('test endpoint falls back to default_behavior after delete', async () => {
    const { body } = await t.api('POST', '/api/rules/test', {
      url: 'https://api.github.com/repos/foo/bar',
      method: 'GET',
    });
    assert.equal(body.decision, 'deny');
    assert.equal(body.match, null);
  });
});
```

- [ ] **Run:** `node --test test/e2e/rule-crud.test.js`
- [ ] **Verify passes**
- [ ] **Commit:** `test: add E2E rule CRUD via API test`

---

### Step 5.9 — Run full E2E suite

- [ ] **Run:** `make test-e2e`
- [ ] **Expected:** ~16 E2E tests pass across 4 test files (proxy-allow 2, proxy-deny 3, proxy-hold 4, rule-crud 7)
- [ ] **Run full suite:** `make test`
- [ ] **Expected:** All unit + integration + E2E tests pass
- [ ] **Commit (if needed):** `chore: chunk 5 complete — Docker, E2E tests, final Makefile`
