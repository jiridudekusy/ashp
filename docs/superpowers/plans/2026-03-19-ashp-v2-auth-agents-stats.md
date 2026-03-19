# ASHP v2: Auth, Agent Management & Statistics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Bearer auth with Basic Auth, move agents from config to DB with hashed tokens, add hit count stats to rules, add request count stats to agents.

**Architecture:** Four changes that touch all three layers (Go proxy, Node server, React GUI). Changes are ordered to keep the system testable at each step: DB schema first, then DAO/API, then proxy integration, then GUI.

**Tech Stack:** Node.js (server), Go (proxy), React (GUI), SQLite/SQLCipher, bcrypt, node:test

**Spec:** `docs/superpowers/specs/2026-03-19-ashp-v2-auth-agents-stats-design.md`

**Working directory:** All paths in this plan are relative to `ashp/` subdirectory (the main ASHP codebase). Commands use `cd ashp/server`, `cd ashp/proxy`, etc. Git add commands use `ashp/` prefix.

---

## File Structure

### New files
- `ashp/server/src/dao/sqlite/agents.js` — SqliteAgentsDAO implementation
- `ashp/server/src/dao/sqlite/agents.test.js` — Agent DAO tests
- `ashp/server/src/api/agents.js` — Agent REST routes
- `ashp/server/src/api/agents.test.js` — Agent API tests

### Modified files
- `ashp/server/src/dao/sqlite/connection.js` — Schema migration (agents table, rules columns)
- `ashp/server/src/dao/sqlite/rules.js` — Add `incrementHitCount()`, include hit_count fields in serialization
- `ashp/server/src/dao/sqlite/rules.test.js` — Tests for hit count
- `ashp/server/src/dao/sqlite/request-log.js` — Add `agent_id` filter to `query()`
- `ashp/server/src/dao/sqlite/request-log.test.js` — Test agent_id filter
- `ashp/server/src/dao/interfaces.js` — Add AgentsDAO base class
- `ashp/server/src/api/middleware.js` — Replace `bearerAuth()` with `basicAuth()`, keep existing `errorHandler`
- `ashp/server/src/api/middleware.test.js` — Update auth tests
- `ashp/server/src/api/logs.js` — Accept `agent_id` query parameter
- `ashp/server/src/api/logs.test.js` — Test agent_id filter
- `ashp/server/src/config.js` — `management.auth` replaces `bearer_token`, remove `proxy.auth` default
- `ashp/server/src/config.test.js` — Update config tests
- `ashp/server/src/index.js` — Wire AgentsDAO, agents.reload IPC, increment counters, SIGHUP handler
- `ashp/server/src/index.test.js` — Update integration tests
- `ashp/proxy/internal/auth/basic.go` — Bcrypt compare with cache, agent struct list
- `ashp/proxy/internal/auth/basic_test.go` — Update auth tests
- `ashp/proxy/cmd/ashp-proxy/main.go` — Remove `--auth` flag, extract authHandler variable, add agents.reload IPC handler
- `ashp/gui/src/api/client.js` — Basic Auth headers, agent API methods (preserve AuthError, requestRaw, named exports)
- `ashp/gui/src/api/useSSE.js` — Replace EventSource with fetch+ReadableStream (preserve onConnect/onDisconnect interface)
- `ashp/gui/src/pages/Login.jsx` — Username+password form with Basic Auth
- `ashp/gui/src/pages/Rules.jsx` — Show hit_count / hit_count_today
- `ashp/gui/src/pages/Logs.jsx` — Add agent_id filter
- `ashp/gui/src/pages/Agents.jsx` — New agent management page
- `ashp/gui/src/App.jsx` — Add Agents route, update auth storage to credentials
- `ashp/ashp.json` — Update config format
- `ashp/ashp.docker.json` — Update config format
- `ashp/ashp.example.json` — Update config format
- `ashp/docker-compose.yml` — Remove proxy auth env vars
- `run/ashp.json` — Update config format

---

## Task 1: Schema Migration — agents table & rules hit_count columns

**Files:**
- Modify: `ashp/server/src/dao/sqlite/connection.js`
- Test: `ashp/server/src/dao/sqlite/connection.test.js`

- [ ] **Step 1: Write failing test for schema migration**

In `connection.test.js`, add a test that verifies the `agents` table exists and `rules` table has hit_count columns:

```javascript
it('creates agents table with correct schema', () => {
  const cols = db.prepare("PRAGMA table_info('agents')").all().map(c => c.name);
  assert.ok(cols.includes('id'));
  assert.ok(cols.includes('name'));
  assert.ok(cols.includes('token_hash'));
  assert.ok(cols.includes('enabled'));
  assert.ok(cols.includes('request_count'));
  assert.ok(cols.includes('created_at'));
});

it('rules table has hit_count columns', () => {
  const cols = db.prepare("PRAGMA table_info('rules')").all().map(c => c.name);
  assert.ok(cols.includes('hit_count'));
  assert.ok(cols.includes('hit_count_today'));
  assert.ok(cols.includes('hit_count_date'));
});

it('tracks schema version via user_version', () => {
  const { user_version } = db.prepare('PRAGMA user_version').get();
  assert.equal(user_version, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ashp/server && node --test src/dao/sqlite/connection.test.js`
Expected: FAIL — agents table doesn't exist, hit_count columns missing

- [ ] **Step 3: Implement schema migration in connection.js**

After the existing `db.exec(MIGRATIONS)` call, add migration logic:

```javascript
// After existing CREATE TABLE statements...

// Schema versioning
const { user_version } = db.prepare('PRAGMA user_version').get();

if (user_version < 1) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      request_count INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT (datetime('now'))
    );

    ALTER TABLE rules ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE rules ADD COLUMN hit_count_today INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE rules ADD COLUMN hit_count_date TEXT;

    PRAGMA user_version = 1;
  `);
}
```

Note: `ALTER TABLE` on an already-migrated DB will fail, so the `user_version` guard is essential. For fresh DBs, the columns are added right after table creation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ashp/server && node --test src/dao/sqlite/connection.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ashp/server/src/dao/sqlite/connection.js ashp/server/src/dao/sqlite/connection.test.js
git commit -m "feat: add agents table and rules hit_count columns with schema versioning"
```

---

## Task 2: AgentsDAO — interface and SQLite implementation

**Files:**
- Modify: `ashp/server/src/dao/interfaces.js`
- Create: `ashp/server/src/dao/sqlite/agents.js`
- Create: `ashp/server/src/dao/sqlite/agents.test.js`

- [ ] **Step 1: Add AgentsDAO to interfaces.js**

```javascript
export class AgentsDAO {
  async list() { throw new Error('Not implemented'); }
  async get(id) { throw new Error('Not implemented'); }
  async create(agent) { throw new Error('Not implemented'); }
  async update(id, fields) { throw new Error('Not implemented'); }
  async delete(id) { throw new Error('Not implemented'); }
  async rotateToken(id) { throw new Error('Not implemented'); }
  async authenticate(name, token) { throw new Error('Not implemented'); }
  async incrementRequestCount(name) { throw new Error('Not implemented'); }
}
```

- [ ] **Step 2: Write failing tests for SqliteAgentsDAO**

Create `ashp/server/src/dao/sqlite/agents.test.js`:

```javascript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from './connection.js';
import { SqliteAgentsDAO } from './agents.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let db, dao, tempDir;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ashp-test-'));
  db = createConnection(join(tempDir, 'test.db'), 'test-key');
  dao = new SqliteAgentsDAO(db);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true });
});

describe('SqliteAgentsDAO', () => {
  it('create returns agent with plaintext token', async () => {
    const agent = await dao.create({ name: 'test-agent' });
    assert.ok(agent.id);
    assert.equal(agent.name, 'test-agent');
    assert.ok(agent.token); // plaintext token returned only on create
    assert.equal(agent.enabled, true);
    assert.ok(agent.created_at);
  });

  it('list returns agents without tokens', async () => {
    await dao.create({ name: 'agent1' });
    await dao.create({ name: 'agent2' });
    const list = await dao.list();
    assert.equal(list.length, 2);
    assert.ok(!list[0].token);
    assert.ok(!list[0].token_hash);
  });

  it('get returns agent without token', async () => {
    const created = await dao.create({ name: 'agent1' });
    const agent = await dao.get(created.id);
    assert.equal(agent.name, 'agent1');
    assert.ok(!agent.token);
    assert.ok(!agent.token_hash);
  });

  it('get returns null for nonexistent', async () => {
    const agent = await dao.get(999);
    assert.equal(agent, null);
  });

  it('authenticate succeeds with correct token', async () => {
    const created = await dao.create({ name: 'agent1' });
    const agent = await dao.authenticate('agent1', created.token);
    assert.ok(agent);
    assert.equal(agent.name, 'agent1');
  });

  it('authenticate fails with wrong token', async () => {
    await dao.create({ name: 'agent1' });
    const agent = await dao.authenticate('agent1', 'wrong-token');
    assert.equal(agent, null);
  });

  it('authenticate fails for disabled agent', async () => {
    const created = await dao.create({ name: 'agent1' });
    await dao.update(created.id, { enabled: false });
    const agent = await dao.authenticate('agent1', created.token);
    assert.equal(agent, null);
  });

  it('authenticate fails for nonexistent agent', async () => {
    const agent = await dao.authenticate('nope', 'token');
    assert.equal(agent, null);
  });

  it('update changes name and enabled', async () => {
    const created = await dao.create({ name: 'agent1' });
    const updated = await dao.update(created.id, { name: 'renamed', enabled: false });
    assert.equal(updated.name, 'renamed');
    assert.equal(updated.enabled, false);
  });

  it('rotateToken returns new token and invalidates old', async () => {
    const created = await dao.create({ name: 'agent1' });
    const { token: newToken } = await dao.rotateToken(created.id);
    assert.ok(newToken);
    assert.notEqual(newToken, created.token);
    // Old token fails
    const fail = await dao.authenticate('agent1', created.token);
    assert.equal(fail, null);
    // New token works
    const ok = await dao.authenticate('agent1', newToken);
    assert.ok(ok);
  });

  it('rotateToken returns null for nonexistent agent', async () => {
    const result = await dao.rotateToken(999);
    assert.equal(result, null);
  });

  it('delete removes agent and cascades to request_log', async () => {
    const created = await dao.create({ name: 'agent1' });
    // Insert a fake request_log row with this agent_id
    db.prepare("INSERT INTO request_log (method, url, decision, agent_id) VALUES ('GET', 'http://x', 'allowed', 'agent1')").run();
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM request_log WHERE agent_id = 'agent1'").get().c, 1);
    await dao.delete(created.id);
    assert.equal(await dao.get(created.id), null);
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM request_log WHERE agent_id = 'agent1'").get().c, 0);
  });

  it('incrementRequestCount increments counter', async () => {
    await dao.create({ name: 'agent1' });
    await dao.incrementRequestCount('agent1');
    await dao.incrementRequestCount('agent1');
    await dao.incrementRequestCount('agent1');
    const list = await dao.list();
    assert.equal(list[0].request_count, 3);
  });

  it('create rejects duplicate name', async () => {
    await dao.create({ name: 'agent1' });
    await assert.rejects(() => dao.create({ name: 'agent1' }));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ashp/server && node --test src/dao/sqlite/agents.test.js`
Expected: FAIL — module not found

- [ ] **Step 4: Implement SqliteAgentsDAO**

Create `ashp/server/src/dao/sqlite/agents.js`:

```javascript
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
```

Note: `bcrypt` npm package must be installed. Run `cd ashp/server && npm install bcrypt`.

- [ ] **Step 5: Install bcrypt dependency**

Run: `cd ashp/server && npm install bcrypt`

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ashp/server && node --test src/dao/sqlite/agents.test.js`
Expected: PASS (all 13 tests)

- [ ] **Step 7: Commit**

```bash
git add ashp/server/src/dao/interfaces.js ashp/server/src/dao/sqlite/agents.js ashp/server/src/dao/sqlite/agents.test.js ashp/server/package.json ashp/server/package-lock.json
git commit -m "feat: add AgentsDAO with bcrypt token hashing"
```

---

## Task 3: Rules DAO — add incrementHitCount and hit_count fields

**Files:**
- Modify: `ashp/server/src/dao/sqlite/rules.js`
- Modify: `ashp/server/src/dao/sqlite/rules.test.js`

- [ ] **Step 1: Write failing tests for hit count**

Add to `rules.test.js`:

```javascript
describe('hit count', () => {
  it('incrementHitCount increments total and today', async () => {
    const rule = await dao.create({ name: 'r1', url_pattern: '^http://x', methods: [], action: 'allow' });
    await dao.incrementHitCount(rule.id);
    await dao.incrementHitCount(rule.id);
    const updated = await dao.get(rule.id);
    assert.equal(updated.hit_count, 2);
    assert.equal(updated.hit_count_today, 2);
    assert.ok(updated.hit_count_date); // should be today's date
  });

  it('list includes hit_count fields', async () => {
    await dao.create({ name: 'r1', url_pattern: '^http://x', methods: [], action: 'allow' });
    const list = await dao.list();
    assert.equal(list[0].hit_count, 0);
    assert.equal(list[0].hit_count_today, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ashp/server && node --test src/dao/sqlite/rules.test.js`
Expected: FAIL — `incrementHitCount` is not a function, `hit_count` undefined

- [ ] **Step 3: Update rules.js — add hit_count to deserialization and incrementHitCount method**

In the `deserialize` function, add:

```javascript
hit_count: row.hit_count ?? 0,
hit_count_today: row.hit_count_today ?? 0,
hit_count_date: row.hit_count_date ?? null,
```

Add prepared statement to constructor:

```javascript
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
```

Add method:

```javascript
async incrementHitCount(ruleId) {
  this.#stmts.incrementHitCount.run(ruleId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ashp/server && node --test src/dao/sqlite/rules.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ashp/server/src/dao/sqlite/rules.js ashp/server/src/dao/sqlite/rules.test.js
git commit -m "feat: add hit count statistics to rules DAO"
```

---

## Task 4: Request log DAO — add agent_id filter

**Files:**
- Modify: `ashp/server/src/dao/sqlite/request-log.js`
- Modify: `ashp/server/src/dao/sqlite/request-log.test.js`

- [ ] **Step 1: Write failing test for agent_id filter**

Add to `request-log.test.js`:

```javascript
it('query filters by agent_id', async () => {
  await dao.insert({ method: 'GET', url: 'http://a.com', decision: 'allowed', agent_id: 'agent1' });
  await dao.insert({ method: 'GET', url: 'http://b.com', decision: 'allowed', agent_id: 'agent2' });
  await dao.insert({ method: 'GET', url: 'http://c.com', decision: 'denied', agent_id: 'agent1' });
  const results = await dao.query({ agent_id: 'agent1' });
  assert.equal(results.length, 2);
  results.forEach(r => assert.equal(r.agent_id, 'agent1'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ashp/server && node --test src/dao/sqlite/request-log.test.js`
Expected: FAIL — returns all 3 rows instead of 2

- [ ] **Step 3: Add agent_id filter to query() in request-log.js**

In the `query()` method, add alongside the existing filters (using **named parameter** style matching the existing code pattern):

```javascript
if (filters.agent_id) { conds.push('agent_id=@agent_id'); params.agent_id = filters.agent_id; }
```

This must use the `conds`/`params` variables and `@named` parameter syntax matching the existing code in `request-log.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ashp/server && node --test src/dao/sqlite/request-log.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ashp/server/src/dao/sqlite/request-log.js ashp/server/src/dao/sqlite/request-log.test.js
git commit -m "feat: add agent_id filter to request log queries"
```

---

## Task 5: Management API — Basic Auth middleware

**Files:**
- Modify: `ashp/server/src/api/middleware.js`
- Modify: `ashp/server/src/api/middleware.test.js`

- [ ] **Step 1: Write failing tests for basicAuth**

Replace bearer auth tests in `middleware.test.js` with:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { basicAuth, errorHandler } from './middleware.js';

function makeApp(auth) {
  const app = express();
  app.use(basicAuth(auth));
  app.get('/test', (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

async function req(app, headers = {}) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://localhost:${port}/test`, { headers });
    return { status: res.status, body: await res.json().catch(() => null), headers: Object.fromEntries(res.headers) };
  } finally {
    server.close();
  }
}

describe('basicAuth', () => {
  const auth = { admin: 'secret123' };

  it('returns 401 without auth header', async () => {
    const app = makeApp(auth);
    const res = await req(app);
    assert.equal(res.status, 401);
    assert.ok(res.headers['www-authenticate']?.includes('Basic'));
  });

  it('returns 401 with wrong credentials', async () => {
    const app = makeApp(auth);
    const creds = Buffer.from('admin:wrong').toString('base64');
    const res = await req(app, { Authorization: `Basic ${creds}` });
    assert.equal(res.status, 401);
  });

  it('returns 401 with wrong username', async () => {
    const app = makeApp(auth);
    const creds = Buffer.from('nobody:secret123').toString('base64');
    const res = await req(app, { Authorization: `Basic ${creds}` });
    assert.equal(res.status, 401);
  });

  it('passes with correct credentials', async () => {
    const app = makeApp(auth);
    const creds = Buffer.from('admin:secret123').toString('base64');
    const res = await req(app, { Authorization: `Basic ${creds}` });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('rejects Bearer token format', async () => {
    const app = makeApp(auth);
    const res = await req(app, { Authorization: 'Bearer secret123' });
    assert.equal(res.status, 401);
  });
});

describe('errorHandler', () => {
  it('returns JSON with status and error message', async () => {
    const app = express();
    app.get('/err', (req, res, next) => { const e = new Error('bad'); e.status = 400; next(e); });
    app.use(errorHandler);
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const res = await fetch(`http://localhost:${port}/err`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'bad');
    } finally {
      server.close();
    }
  });

  it('defaults to 500', async () => {
    const app = express();
    app.get('/err', (req, res, next) => next(new Error('oops')));
    app.use(errorHandler);
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const res = await fetch(`http://localhost:${port}/err`);
      assert.equal(res.status, 500);
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ashp/server && node --test src/api/middleware.test.js`
Expected: FAIL — `basicAuth` is not exported

- [ ] **Step 3: Implement basicAuth in middleware.js**

Replace `bearerAuth` with `basicAuth`. **Keep the existing `errorHandler` unchanged:**

```javascript
export function basicAuth(authMap) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="ASHP"');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const sep = decoded.indexOf(':');
    if (sep === -1) {
      res.set('WWW-Authenticate', 'Basic realm="ASHP"');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (!authMap[user] || authMap[user] !== pass) {
      res.set('WWW-Authenticate', 'Basic realm="ASHP"');
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

**Important:** The `errorHandler` must preserve `err.status` and `err.message` — the existing implementation already does this. Do NOT change it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ashp/server && node --test src/api/middleware.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ashp/server/src/api/middleware.js ashp/server/src/api/middleware.test.js
git commit -m "feat: replace Bearer auth with Basic Auth for management API"
```

---

## Task 6: Config changes — management.auth, remove proxy.auth

**Files:**
- Modify: `ashp/server/src/config.js`
- Modify: `ashp/server/src/config.test.js`

- [ ] **Step 1: Write failing tests for new config shape**

Update `config.test.js` — replace tests that reference `bearer_token` with `auth`:

```javascript
it('management.auth is required', () => {
  const config = loadConfig({ config: testConfigPath });
  assert.ok(config.management.auth);
});

it('proxy section has no auth field', () => {
  const config = loadConfig({ config: testConfigPath });
  assert.equal(config.proxy.auth, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ashp/server && node --test src/config.test.js`
Expected: FAIL

- [ ] **Step 3: Update config.js**

In `DEFAULTS`:
- Change `management` to: `{ listen: '0.0.0.0:3000', auth: {} }`
- Change `proxy` to: `{ listen: '0.0.0.0:8080' }` (remove `auth: {}`)

In `CLI_MAP`: remove any `--auth` related mapping for proxy.

Remove `bearer_token` references.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ashp/server && node --test src/config.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ashp/server/src/config.js ashp/server/src/config.test.js
git commit -m "feat: config changes for Basic Auth and DB agents"
```

---

## Task 7: Agent REST API routes

**Files:**
- Create: `ashp/server/src/api/agents.js`
- Create: `ashp/server/src/api/agents.test.js`

- [ ] **Step 1: Write failing tests for agent API**

Create `ashp/server/src/api/agents.test.js`:

```javascript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { errorHandler } from './middleware.js';
import agentsRoutes from './agents.js';

// Mock DAO
function mockAgentsDAO() {
  const agents = [];
  let nextId = 1;
  return {
    list: async () => agents.map(a => ({ ...a, token_hash: undefined })),
    get: async (id) => { const a = agents.find(a => a.id === id); return a ? { ...a, token_hash: undefined } : null; },
    create: async ({ name }) => {
      const agent = { id: nextId++, name, token: 'generated-token-123', enabled: true, request_count: 0, created_at: new Date().toISOString() };
      agents.push(agent);
      return agent;
    },
    update: async (id, fields) => {
      const a = agents.find(a => a.id === id);
      if (!a) return null;
      Object.assign(a, fields);
      return { ...a, token_hash: undefined };
    },
    delete: async (id) => { const idx = agents.findIndex(a => a.id === id); if (idx >= 0) agents.splice(idx, 1); },
    rotateToken: async (id) => {
      const a = agents.find(a => a.id === id);
      if (!a) return null;
      return { token: 'new-rotated-token-456' };
    },
    listForProxy: () => [],
    _agents: agents,
  };
}

function makeApp(agentsDAO) {
  const app = express();
  app.use(express.json());
  const ipc = { send: () => {} };
  app.use('/api/agents', agentsRoutes({ agentsDAO, ipc }));
  app.use(errorHandler);
  return app;
}

async function req(app, method, path, body) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`http://localhost:${port}${path}`, opts);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

describe('agents API', () => {
  let dao, app;
  beforeEach(() => { dao = mockAgentsDAO(); app = makeApp(dao); });

  it('POST /api/agents creates agent and returns token', async () => {
    const res = await req(app, 'POST', '/api/agents', { name: 'agent1' });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'agent1');
    assert.ok(res.body.token); // token visible only on create
  });

  it('GET /api/agents lists without tokens', async () => {
    await req(app, 'POST', '/api/agents', { name: 'agent1' });
    const res = await req(app, 'GET', '/api/agents');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.ok(!res.body[0].token);
  });

  it('GET /api/agents/:id returns agent without token', async () => {
    const created = await req(app, 'POST', '/api/agents', { name: 'agent1' });
    const res = await req(app, 'GET', `/api/agents/${created.body.id}`);
    assert.equal(res.status, 200);
    assert.ok(!res.body.token);
  });

  it('GET /api/agents/:id returns 404 for nonexistent', async () => {
    const res = await req(app, 'GET', '/api/agents/999');
    assert.equal(res.status, 404);
  });

  it('DELETE /api/agents/:id removes agent', async () => {
    const created = await req(app, 'POST', '/api/agents', { name: 'agent1' });
    const res = await req(app, 'DELETE', `/api/agents/${created.body.id}`);
    assert.equal(res.status, 204);
  });

  it('POST /api/agents/:id/rotate-token returns new token', async () => {
    const created = await req(app, 'POST', '/api/agents', { name: 'agent1' });
    const res = await req(app, 'POST', `/api/agents/${created.body.id}/rotate-token`);
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  it('POST /api/agents/:id/rotate-token returns 404 for nonexistent', async () => {
    const res = await req(app, 'POST', '/api/agents/999/rotate-token');
    assert.equal(res.status, 404);
  });

  it('PUT /api/agents/:id returns 404 for nonexistent', async () => {
    const res = await req(app, 'PUT', '/api/agents/999', { name: 'x' });
    assert.equal(res.status, 404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ashp/server && node --test src/api/agents.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement agent routes**

Create `ashp/server/src/api/agents.js`:

```javascript
import { Router } from 'express';

export default function agentsRoutes({ agentsDAO, ipc }) {
  const r = Router();

  async function sendAgentsReload() {
    const agents = agentsDAO.listForProxy();
    ipc.send({ type: 'agents.reload', data: agents });
  }

  r.get('/', async (req, res, next) => {
    try { res.json(await agentsDAO.list()); } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const agent = await agentsDAO.get(Number(req.params.id));
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json(agent);
    } catch (e) { next(e); }
  });

  r.post('/', async (req, res, next) => {
    try {
      const agent = await agentsDAO.create(req.body);
      await sendAgentsReload();
      res.status(201).json(agent);
    } catch (e) { next(e); }
  });

  r.put('/:id', async (req, res, next) => {
    try {
      const agent = await agentsDAO.update(Number(req.params.id), req.body);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      await sendAgentsReload();
      res.json(agent);
    } catch (e) { next(e); }
  });

  r.delete('/:id', async (req, res, next) => {
    try {
      await agentsDAO.delete(Number(req.params.id));
      await sendAgentsReload();
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.post('/:id/rotate-token', async (req, res, next) => {
    try {
      const result = await agentsDAO.rotateToken(Number(req.params.id));
      if (!result) return res.status(404).json({ error: 'Agent not found' });
      await sendAgentsReload();
      res.json(result);
    } catch (e) { next(e); }
  });

  return r;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ashp/server && node --test src/api/agents.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ashp/server/src/api/agents.js ashp/server/src/api/agents.test.js
git commit -m "feat: add agent management REST API"
```

---

## Task 8: Logs API — add agent_id query param

**Files:**
- Modify: `ashp/server/src/api/logs.js`
- Modify: `ashp/server/src/api/logs.test.js`

- [ ] **Step 1: Write failing test for agent_id filter in API**

Add to `logs.test.js`:

```javascript
it('GET /api/logs?agent_id= filters by agent', async () => {
  // Set up mock DAO to verify agent_id is passed to query
  const passedFilters = {};
  dao.query = async (filters) => { Object.assign(passedFilters, filters); return []; };
  const res = await req(app, 'GET', '/api/logs?agent_id=agent1');
  assert.equal(res.status, 200);
  assert.equal(passedFilters.agent_id, 'agent1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ashp/server && node --test src/api/logs.test.js`
Expected: FAIL — `agent_id` not in passedFilters

- [ ] **Step 3: Add agent_id to logs.js query params**

In `logs.js`, in the GET `/` handler, add `'agent_id'` to the filter extraction loop. Change:

```javascript
for (const k of ['method', 'decision', 'url', 'from', 'to']) {
```

to:

```javascript
for (const k of ['method', 'decision', 'url', 'from', 'to', 'agent_id']) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ashp/server && node --test src/api/logs.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ashp/server/src/api/logs.js ashp/server/src/api/logs.test.js
git commit -m "feat: add agent_id filter to logs API"
```

---

## Task 9: Wire everything in index.js — AgentsDAO, IPC counters, agents.reload

**Files:**
- Modify: `ashp/server/src/index.js`

- [ ] **Step 1: Add imports and AgentsDAO wiring**

Add imports:

```javascript
import { SqliteAgentsDAO } from './dao/sqlite/agents.js';
import agentsRoutes from './api/agents.js';
```

After existing DAO initialization (after `approvalQueueDAO`):

```javascript
const agentsDAO = new SqliteAgentsDAO(db);
```

- [ ] **Step 2: Update IPC onConnect to send agents.reload**

In the `onConnect` callback, after sending `rules.reload`, add:

```javascript
const agents = agentsDAO.listForProxy();
ipc.send({ type: 'agents.reload', data: agents });
```

- [ ] **Step 3: Update IPC onMessage to increment counters**

In the `onMessage` handler, after each message type processing (`request.logged`, `request.blocked`, `approval.needed`), add counter increments:

```javascript
// After request.logged/request.blocked/approval.needed processing:
if (msg.data.rule_id) await rulesDAO.incrementHitCount(msg.data.rule_id);
if (msg.data.agent_id) await agentsDAO.incrementRequestCount(msg.data.agent_id);
```

- [ ] **Step 4: Update proxy args — remove --auth**

Remove this line from proxyArgs:

```javascript
'--auth', JSON.stringify(config.proxy.auth || {}),
```

- [ ] **Step 5: Replace bearerAuth with basicAuth in route setup**

Change import:

```javascript
import { basicAuth, errorHandler } from './api/middleware.js';
```

Change middleware:

```javascript
app.use('/api', basicAuth(config.management.auth));
```

- [ ] **Step 6: Add agents routes and update deps**

After the existing protected routes:

```javascript
app.use('/api/agents', agentsRoutes({ agentsDAO, ipc }));
```

Add `agentsDAO` to the deps object:

```javascript
const deps = { rulesDAO, requestLogDAO, approvalQueueDAO, agentsDAO, config, ipc, events, proxyManager,
  crypto: { ...crypto, logKey } };
```

- [ ] **Step 7: Update SIGHUP handler to send agents.reload**

In the existing `sighupHandler`, after sending `rules.reload`, add:

```javascript
const currentAgents = agentsDAO.listForProxy();
ipc.send({ type: 'agents.reload', data: currentAgents });
```

- [ ] **Step 8: Update proxyManager onRestart to send agents.reload**

In the `onRestart` callback, after sending `rules.reload`, add:

```javascript
const agents = agentsDAO.listForProxy();
ipc.send({ type: 'agents.reload', data: agents });
```

- [ ] **Step 9: Run all server tests**

Run: `cd ashp/server && node --test src/**/*.test.js`
Expected: PASS (some existing tests may need `bearerAuth` → `basicAuth` updates)

- [ ] **Step 10: Fix any broken tests due to auth change**

Update tests that use `Bearer` token to use `Basic` auth. Replace:

```javascript
headers: { Authorization: `Bearer ${token}` }
```

with:

```javascript
headers: { Authorization: `Basic ${Buffer.from('admin:' + password).toString('base64')}` }
```

- [ ] **Step 11: Commit**

```bash
git add ashp/server/src/index.js
git commit -m "feat: wire AgentsDAO, Basic Auth, counters, and agents.reload IPC"
```

---

## Task 10: Go proxy — bcrypt auth with cache, agents.reload IPC

**Files:**
- Modify: `ashp/proxy/internal/auth/basic.go`
- Modify: `ashp/proxy/internal/auth/basic_test.go`
- Modify: `ashp/proxy/cmd/ashp-proxy/main.go`

- [ ] **Step 1: Update auth/basic.go — agent struct, bcrypt compare with cache**

Replace the current `Handler` implementation:

```go
package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type Agent struct {
	Name      string `json:"name"`
	TokenHash string `json:"token_hash"`
	Enabled   bool   `json:"enabled"`
}

type cacheEntry struct {
	ok      bool
	expires time.Time
}

type Handler struct {
	mu     sync.RWMutex
	agents map[string]Agent // name -> Agent
	cache  map[string]cacheEntry
	ttl    time.Duration
}

func NewHandler() *Handler {
	return &Handler{
		agents: make(map[string]Agent),
		cache:  make(map[string]cacheEntry),
		ttl:    60 * time.Second,
	}
}

func (h *Handler) Reload(agents []Agent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.agents = make(map[string]Agent, len(agents))
	for _, a := range agents {
		h.agents[a.Name] = a
	}
	h.cache = make(map[string]cacheEntry) // clear cache on reload
}

func (h *Handler) Authenticate(req *http.Request) (string, bool) {
	header := req.Header.Get("Proxy-Authorization")
	if header == "" {
		return "", false
	}
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || parts[0] != "Basic" {
		return "", false
	}
	decoded, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", false
	}
	pair := strings.SplitN(string(decoded), ":", 2)
	if len(pair) != 2 {
		return "", false
	}
	name, token := pair[0], pair[1]

	h.mu.RLock()
	agent, exists := h.agents[name]
	h.mu.RUnlock()

	if !exists || !agent.Enabled {
		return "", false
	}

	// Check cache
	cacheKey := cacheKeyFor(name, token)
	h.mu.RLock()
	entry, cached := h.cache[cacheKey]
	h.mu.RUnlock()

	if cached && time.Now().Before(entry.expires) {
		if entry.ok {
			return name, true
		}
		return "", false
	}

	// Bcrypt compare
	err = bcrypt.CompareHashAndPassword([]byte(agent.TokenHash), []byte(token))
	ok := err == nil

	h.mu.Lock()
	h.cache[cacheKey] = cacheEntry{ok: ok, expires: time.Now().Add(h.ttl)}
	h.mu.Unlock()

	if ok {
		return name, true
	}
	return "", false
}

func cacheKeyFor(name, token string) string {
	sum := sha256.Sum256([]byte(name + ":" + token))
	return hex.EncodeToString(sum[:])
}
```

Note: The `mitm` package only uses the `Authenticate(req)` method on `*auth.Handler`. The method signature `(string, bool)` is unchanged, so no changes to `mitm` are needed.

- [ ] **Step 2: Add golang.org/x/crypto dependency if needed**

Run: `cd ashp/proxy && go get golang.org/x/crypto/bcrypt`

Check if it's already in `go.mod` — the project may already have it.

- [ ] **Step 3: Update basic_test.go**

Update tests to use `NewHandler()`, `Reload()` with Agent structs and bcrypt hashes:

```go
package auth

import (
	"net/http"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func hashToken(t *testing.T, token string) string {
	h, err := bcrypt.GenerateFromPassword([]byte(token), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	return string(h)
}

func TestAuthenticate(t *testing.T) {
	h := NewHandler()
	h.Reload([]Agent{
		{Name: "agent1", TokenHash: hashToken(t, "secret123"), Enabled: true},
		{Name: "disabled", TokenHash: hashToken(t, "pass"), Enabled: false},
	})

	tests := []struct {
		name    string
		user    string
		pass    string
		wantOK  bool
		wantID  string
	}{
		{"valid", "agent1", "secret123", true, "agent1"},
		{"wrong pass", "agent1", "wrong", false, ""},
		{"unknown agent", "nope", "secret123", false, ""},
		{"disabled agent", "disabled", "pass", false, ""},
		{"no header", "", "", false, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "/", nil)
			if tt.user != "" {
				req.SetBasicAuth(tt.user, tt.pass)
				// Move to Proxy-Authorization
				req.Header.Set("Proxy-Authorization", req.Header.Get("Authorization"))
				req.Header.Del("Authorization")
			}
			id, ok := h.Authenticate(req)
			if ok != tt.wantOK {
				t.Errorf("ok = %v, want %v", ok, tt.wantOK)
			}
			if id != tt.wantID {
				t.Errorf("id = %q, want %q", id, tt.wantID)
			}
		})
	}
}

func TestAuthCache(t *testing.T) {
	h := NewHandler()
	h.Reload([]Agent{
		{Name: "agent1", TokenHash: hashToken(t, "secret123"), Enabled: true},
	})

	req, _ := http.NewRequest("GET", "/", nil)
	req.SetBasicAuth("agent1", "secret123")
	req.Header.Set("Proxy-Authorization", req.Header.Get("Authorization"))
	req.Header.Del("Authorization")

	// First call — bcrypt
	_, ok := h.Authenticate(req)
	if !ok {
		t.Fatal("first auth failed")
	}

	// Second call — should hit cache (much faster)
	_, ok = h.Authenticate(req)
	if !ok {
		t.Fatal("cached auth failed")
	}
}

func TestReloadClearsCache(t *testing.T) {
	h := NewHandler()
	h.Reload([]Agent{
		{Name: "agent1", TokenHash: hashToken(t, "secret123"), Enabled: true},
	})

	req, _ := http.NewRequest("GET", "/", nil)
	req.SetBasicAuth("agent1", "secret123")
	req.Header.Set("Proxy-Authorization", req.Header.Get("Authorization"))
	req.Header.Del("Authorization")

	h.Authenticate(req) // populate cache

	// Reload with different token
	h.Reload([]Agent{
		{Name: "agent1", TokenHash: hashToken(t, "newtoken"), Enabled: true},
	})

	// Old token should fail (cache cleared)
	_, ok := h.Authenticate(req)
	if ok {
		t.Fatal("old token should fail after reload")
	}
}
```

- [ ] **Step 4: Run Go auth tests**

Run: `cd ashp/proxy && go test ./internal/auth/ -v`
Expected: PASS

- [ ] **Step 5: Update main.go — remove --auth flag, extract authHandler, add agents.reload IPC handler**

In `main.go`:

1. Remove `--auth` flag definition and the `json.Unmarshal` of tokens.
2. Remove the `tokens` variable.
3. **Extract authHandler into a variable** before the IPC and mitm.Config setup:

```go
authHandler := auth.NewHandler()
```

4. Add `agents.reload` case to the IPC `WithOnMessage` switch, using `m.Data` directly (matching existing `rules.reload` pattern):

```go
case "agents.reload":
    var agents []auth.Agent
    json.Unmarshal(m.Data, &agents)
    authHandler.Reload(agents)
```

5. Use `authHandler` in `mitm.Config`:

```go
p := mitm.New(mitm.Config{
    CA: ca, Evaluator: eval, Auth: authHandler,
    // ... rest unchanged
})
```

- [ ] **Step 6: Run all Go tests**

Run: `cd ashp/proxy && go test ./... -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add ashp/proxy/internal/auth/basic.go ashp/proxy/internal/auth/basic_test.go ashp/proxy/cmd/ashp-proxy/main.go ashp/proxy/go.mod ashp/proxy/go.sum
git commit -m "feat: Go proxy bcrypt auth with cache, agents from IPC"
```

---

## Task 11: GUI — Login with Basic Auth

**Files:**
- Modify: `ashp/gui/src/api/client.js`
- Modify: `ashp/gui/src/pages/Login.jsx`
- Modify: `ashp/gui/src/App.jsx`

- [ ] **Step 1: Update client.js to use Basic Auth — preserve AuthError, requestRaw, named exports**

Replace the authorization header from Bearer to Basic. **Keep `AuthError` class, `requestRaw` function, and named export pattern:**

```javascript
class AuthError extends Error { constructor() { super('Unauthorized'); this.name = 'AuthError'; } }

function createClient(baseURL = '', credentials = '') {
  async function request(method, path, body) {
    const opts = {
      method,
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
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

  async function requestRaw(method, path) {
    const res = await fetch(`${baseURL}${path}`, {
      method,
      headers: { 'Authorization': `Basic ${credentials}` },
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
    // New agent methods
    getAgents:        ()          => request('GET', '/api/agents'),
    getAgent:         (id)        => request('GET', `/api/agents/${id}`),
    createAgent:      (data)      => request('POST', '/api/agents', data),
    updateAgent:      (id, data)  => request('PUT', `/api/agents/${id}`, data),
    deleteAgent:      (id)        => request('DELETE', `/api/agents/${id}`),
    rotateToken:      (id)        => request('POST', `/api/agents/${id}/rotate-token`),
    // Auth credentials for SSE
    credentials,
  };
}

export { createClient, AuthError };
```

- [ ] **Step 2: Update Login.jsx to username/password form**

The existing Login.jsx validates credentials against `/api/status`. Since `/api/status` is a public route (mounted before auth middleware — it also serves CA certificate downloads), login must validate against a **protected** endpoint instead (e.g., `/api/rules`):

```jsx
import { useState } from 'react';
import styles from './Login.module.css';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const credentials = btoa(`${username}:${password}`);
    try {
      // Validate against a protected endpoint (not /api/status which is public)
      const res = await fetch('/api/rules', {
        headers: { Authorization: `Basic ${credentials}` },
      });
      if (!res.ok) throw new Error('Invalid credentials');
      onLogin(credentials);
    } catch {
      setError('Invalid username or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.brand}>ASHP</h1>
        <p className={styles.subtitle}>AI Security HTTP Proxy</p>
        <form onSubmit={handleSubmit}>
          <label className={styles.label}>Username</label>
          <input className={styles.input} type="text" value={username}
            onChange={e => setUsername(e.target.value)} placeholder="Username" required autoFocus />
          <label className={styles.label}>Password</label>
          <input className={styles.input} type="password" value={password}
            onChange={e => setPassword(e.target.value)} placeholder="Password" required />
          <button className={styles.button} type="submit" disabled={loading}>
            {loading ? 'Logging in...' : 'Login'}
          </button>
          {error && <p className={styles.error}>{error}</p>}
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update App.jsx — change token storage to credentials**

In `App.jsx`, change state from `token` to `credentials`:

```jsx
const [credentials, setCredentials] = useState(sessionStorage.getItem('ashp_credentials'));
const api = useMemo(() => credentials ? createClient('', credentials) : null, [credentials]);

function handleLogin(c) {
  sessionStorage.setItem('ashp_credentials', c);
  setCredentials(c);
}
function handleLogout() {
  sessionStorage.removeItem('ashp_credentials');
  setCredentials(null);
}

if (!credentials) return <Login onLogin={handleLogin} />;
```

Update `EventBridge` to pass `credentials` instead of `token`.

- [ ] **Step 4: Commit**

```bash
git add ashp/gui/src/api/client.js ashp/gui/src/pages/Login.jsx ashp/gui/src/App.jsx
git commit -m "feat: GUI login with Basic Auth (username/password)"
```

---

## Task 12: GUI — SSE with fetch+ReadableStream

**Files:**
- Modify: `ashp/gui/src/api/useSSE.js`
- Modify: `ashp/gui/src/App.jsx` (EventBridge update)

- [ ] **Step 1: Replace EventSource with fetch+ReadableStream — preserve onConnect/onDisconnect interface**

The existing `useSSE` interface is `useSSE(url, { onEvent, token, onConnect, onDisconnect })`. Keep the same callback interface but change `token` to `credentials` and replace the transport:

```javascript
import { useEffect, useRef, useCallback } from 'react';

export function useSSE(url, { onEvent, credentials, onConnect, onDisconnect } = {}) {
  const abortRef = useRef(null);
  const reconnectTimer = useRef(null);

  const connect = useCallback(() => {
    if (!credentials) return;

    const controller = new AbortController();
    abortRef.current = controller;

    async function run() {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Basic ${credentials}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          onDisconnect?.();
          reconnectTimer.current = setTimeout(connect, 3000);
          return;
        }

        onConnect?.();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line

          let currentEvent = null;
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ') && currentEvent) {
              try {
                const data = JSON.parse(line.slice(6));
                if (onEvent) onEvent(currentEvent, data);
              } catch { /* ignore parse errors */ }
              currentEvent = null;
            } else if (line === '') {
              currentEvent = null;
            }
          }
        }
        // Stream ended — reconnect
        onDisconnect?.();
        reconnectTimer.current = setTimeout(connect, 3000);
      } catch (err) {
        if (err.name !== 'AbortError') {
          onDisconnect?.();
          reconnectTimer.current = setTimeout(connect, 3000);
        }
      }
    }

    run();
  }, [url, credentials, onEvent, onConnect, onDisconnect]);

  useEffect(() => {
    connect();
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);
}
```

- [ ] **Step 2: Update EventBridge in App.jsx**

Change `EventBridge` to pass `credentials` instead of `token`:

```jsx
function EventBridge({ credentials, onConnect, onDisconnect, children }) {
  const subscribers = useMemo(() => new Set(), []);
  const onEvent = useCallback((type, data) => {
    for (const fn of subscribers) fn(type, data);
  }, [subscribers]);

  useSSE('/api/events', { onEvent, credentials, onConnect, onDisconnect });

  const events = useMemo(() => ({
    subscribe: (fn) => subscribers.add(fn),
    unsubscribe: (fn) => subscribers.delete(fn),
  }), [subscribers]);

  return children(events);
}
```

And update its usage:

```jsx
<EventBridge
  credentials={credentials}
  onConnect={() => setSseConnected(true)}
  onDisconnect={() => setSseConnected(false)}
>
```

Note: The `?token=` query parameter support in the old EventSource code is removed. The server-side `bearerAuth` middleware (which accepted `?token=`) was already replaced with `basicAuth` in Task 5, so this is consistent.

- [ ] **Step 3: Commit**

```bash
git add ashp/gui/src/api/useSSE.js ashp/gui/src/App.jsx
git commit -m "feat: replace EventSource with fetch+ReadableStream for SSE"
```

---

## Task 13: GUI — Agents page, Rules hit counts, Logs agent filter

**Files:**
- Create: `ashp/gui/src/pages/Agents.jsx`
- Modify: `ashp/gui/src/pages/Rules.jsx`
- Modify: `ashp/gui/src/pages/Logs.jsx`
- Modify: `ashp/gui/src/App.jsx`

- [ ] **Step 1: Create Agents.jsx page**

Note: Use `{ api }` prop (not `{ client }`) to match existing page component convention in App.jsx.

```jsx
import { useState, useEffect, useCallback } from 'react';

export default function Agents({ api }) {
  const [agents, setAgents] = useState([]);
  const [name, setName] = useState('');
  const [createdToken, setCreatedToken] = useState(null);
  const [rotatedToken, setRotatedToken] = useState(null);

  const load = useCallback(async () => {
    setAgents(await api.getAgents());
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e) => {
    e.preventDefault();
    const agent = await api.createAgent({ name });
    setCreatedToken({ name: agent.name, token: agent.token });
    setName('');
    load();
  };

  const handleToggle = async (agent) => {
    await api.updateAgent(agent.id, { enabled: !agent.enabled });
    load();
  };

  const handleDelete = async (agent) => {
    if (!confirm(`Delete agent "${agent.name}"? This will also delete all their request logs.`)) return;
    await api.deleteAgent(agent.id);
    load();
  };

  const handleRotate = async (agent) => {
    if (!confirm(`Rotate token for "${agent.name}"? The old token will stop working immediately.`)) return;
    const result = await api.rotateToken(agent.id);
    setRotatedToken({ name: agent.name, token: result.token });
  };

  return (
    <div className="page">
      <h2>Agents</h2>

      <form onSubmit={handleCreate} className="inline-form">
        <input type="text" placeholder="Agent name" value={name}
          onChange={(e) => setName(e.target.value)} required />
        <button type="submit">Create Agent</button>
      </form>

      {createdToken && (
        <div className="token-display success">
          <strong>Agent "{createdToken.name}" created.</strong> Token (shown only once):
          <code>{createdToken.token}</code>
          <button onClick={() => setCreatedToken(null)}>Dismiss</button>
        </div>
      )}

      {rotatedToken && (
        <div className="token-display success">
          <strong>Token rotated for "{rotatedToken.name}".</strong> New token (shown only once):
          <code>{rotatedToken.token}</code>
          <button onClick={() => setRotatedToken(null)}>Dismiss</button>
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Requests</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map(a => (
            <tr key={a.id} className={a.enabled ? '' : 'disabled'}>
              <td>{a.name}</td>
              <td>{a.request_count}</td>
              <td>{a.enabled ? 'Active' : 'Disabled'}</td>
              <td>{new Date(a.created_at).toLocaleDateString()}</td>
              <td>
                <button onClick={() => handleToggle(a)}>
                  {a.enabled ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => handleRotate(a)}>Rotate Token</button>
                <button onClick={() => handleDelete(a)} className="danger">Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Update Rules.jsx — add hit_count columns**

In the rules table header, add:

```jsx
<th>Hits (Total)</th>
<th>Hits (Today)</th>
```

In the rules table body, add:

```jsx
<td>{rule.hit_count}</td>
<td>{rule.hit_count_today}{rule.hit_count_date && rule.hit_count_date !== new Date().toISOString().slice(0, 10) ? ` (${rule.hit_count_date})` : ''}</td>
```

- [ ] **Step 3: Update Logs.jsx — add agent_id filter**

Add agent_id to the filter state and UI:

```jsx
// In filter state:
const [agentId, setAgentId] = useState('');

// In filter UI:
<input type="text" placeholder="Agent ID" value={agentId}
  onChange={(e) => setAgentId(e.target.value)} />

// In query params:
if (agentId) params.agent_id = agentId;
```

- [ ] **Step 4: Update App.jsx — add Agents route**

Import Agents page and add route:

```jsx
import Agents from './pages/Agents';

// In routes (use `api` prop, matching existing pattern):
<Route path="agents" element={<Agents api={api} events={events} />} />
```

Add "Agents" link to the Layout navigation (check Layout component for how nav links are added).

- [ ] **Step 5: Commit**

```bash
git add ashp/gui/src/pages/Agents.jsx ashp/gui/src/pages/Rules.jsx ashp/gui/src/pages/Logs.jsx ashp/gui/src/App.jsx
git commit -m "feat: GUI agent management, rule hit counts, logs agent filter"
```

---

## Task 14: Update config files

**Files:**
- Modify: `ashp/ashp.json`
- Modify: `ashp/ashp.docker.json`
- Modify: `ashp/ashp.example.json`
- Modify: `ashp/docker-compose.yml`
- Modify: `run/ashp.json`

- [ ] **Step 1: Update ashp config files**

In each config file, remove `proxy.auth` and `management.bearer_token`, add `management.auth`:

`ashp/ashp.json`:
```json
{
  "proxy": {
    "listen": "0.0.0.0:8080"
  },
  "management": {
    "listen": "0.0.0.0:3000",
    "auth": { "admin": "change-me-admin-password" }
  }
}
```

`ashp/ashp.docker.json` — same changes plus keep `bin_path`, `gui.dist_path`, `database.path`, `ipc_socket`, etc.

`ashp/ashp.example.json` — update as reference.

- [ ] **Step 2: Update run/ashp.json (sandbox runner)**

Remove `bearer_token`, add `auth`, remove `proxy.auth`.

- [ ] **Step 3: Update ashp/docker-compose.yml**

Remove any proxy auth-related environment variables or config references. The `--auth` proxy flag is no longer used (agents come from IPC).

- [ ] **Step 4: Commit**

```bash
git add ashp/ashp.json ashp/ashp.docker.json ashp/ashp.example.json ashp/docker-compose.yml run/ashp.json
git commit -m "feat: update config files for Basic Auth and DB agents"
```

---

## Task 15: Integration test — full flow

**Files:**
- Modify: `ashp/server/src/index.test.js` (or create integration test)

- [ ] **Step 1: Run all server tests**

Run: `cd ashp/server && node --test src/**/*.test.js`
Expected: PASS

- [ ] **Step 2: Run all Go tests**

Run: `cd ashp/proxy && go test ./... -v`
Expected: PASS

- [ ] **Step 3: Build and verify Docker image**

Run: `cd ashp && docker build -t jiridudekusy/ashp:latest .`
Expected: Build succeeds

- [ ] **Step 4: Start with docker compose and verify**

```bash
cd run && docker compose up -d
sleep 3
docker logs run-ashp-1 2>&1 | tail -5
```

Expected: `ASHP management API listening on 0.0.0.0:3000` and `ASHP proxy listening on [::]:8080`

- [ ] **Step 5: Test Basic Auth via curl**

```bash
# Should fail without auth
curl -sf http://localhost:3000/api/rules && echo "FAIL: should require auth" || echo "OK: auth required"

# Should work with Basic Auth
curl -sf -u admin:change-me-admin-password http://localhost:3000/api/rules
```

- [ ] **Step 6: Test agent CRUD via curl**

```bash
# Create agent
curl -sf -u admin:change-me-admin-password -X POST http://localhost:3000/api/agents \
  -H 'Content-Type: application/json' -d '{"name":"test-agent"}'

# List agents (no token visible)
curl -sf -u admin:change-me-admin-password http://localhost:3000/api/agents
```

- [ ] **Step 7: Commit final state**

```bash
git add -A
git commit -m "feat: ASHP v2 — Basic Auth, agent management, statistics"
```
