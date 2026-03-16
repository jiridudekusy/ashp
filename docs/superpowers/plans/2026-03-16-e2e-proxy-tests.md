# E2E Proxy Tests Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 6 E2E tests that send real HTTP requests through the Go proxy, covering allow, deny, hold→approve, hold→reject, and hold→timeout flows.

**Architecture:** Extend `test/e2e/setup.js` with `createFullStack()` that starts a local HTTP target, management server, and Go proxy via `ProxyManager`. Each test gets an isolated stack. ProxyManager needs config extensions (default_behavior, hold_timeout, ca_pass, log_key) passed to the proxy binary.

**Tech Stack:** Node test runner, existing `startServer()`, `ProxyManager`, Go proxy binary

**Spec:** `docs/superpowers/specs/2026-03-16-e2e-proxy-tests-design.md`

---

## Chunk 1: Setup infrastructure

### Task 1: Extend ProxyManager args in startServer

The proxy binary needs `--default-behavior`, `--hold-timeout`, `--ca-pass`, `--log-key` flags. Currently `startServer` hardcodes only `--socket`, `--listen`, `--auth`. Add config passthrough.

**Files:**
- Modify: `ashp/server/src/index.js:79-88`

- [ ] **Step 1: Write failing test**

Add to `ashp/server/src/proxy-manager.test.js`:

```js
it('passes default_behavior and hold_timeout to proxy args', async () => {
  // This is validated by the E2E tests themselves — skip unit test,
  // the change is a config passthrough only.
});
```

Actually, this is pure config wiring — no new unit test needed. The E2E tests will validate it.

- [ ] **Step 2: Modify startServer to pass extra proxy args**

In `ashp/server/src/index.js`, change the ProxyManager construction (lines 80-88) to:

```js
  const proxyBinPath = config.proxy?.bin_path || resolve(dataDir, '..', 'proxy', 'ashp-proxy');
  const proxyArgs = [
    '--socket', socketPath,
    '--listen', config.proxy.listen,
    '--auth', JSON.stringify(config.proxy.auth || {}),
    '--default-behavior', config.default_behavior || 'deny',
  ];
  if (config.proxy.hold_timeout) proxyArgs.push('--hold-timeout', String(config.proxy.hold_timeout));
  if (config.encryption?.ca_key) proxyArgs.push('--ca-pass', config.encryption.ca_key);
  if (config.encryption?.log_key) proxyArgs.push('--log-key', config.encryption.log_key);

  const proxyManager = new ProxyManager(proxyBinPath, proxyArgs, { onRestart: async () => {
    const rules = await rulesDAO.list();
    ipc.send({ type: 'rules.reload', data: rules });
  }});
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `cd ashp && make test-server`
Expected: 110 tests pass

- [ ] **Step 4: Commit**

```bash
git add ashp/server/src/index.js
git commit -m "feat: pass default_behavior, hold_timeout, ca/log keys to proxy binary"
```

---

### Task 2: Create `createFullStack()` helper

**Files:**
- Modify: `ashp/test/e2e/setup.js`

- [ ] **Step 1: Add createFullStack to setup.js**

```js
import http from 'node:http';
import { resolve } from 'node:path';

export async function createFullStack(options = {}) {
  const {
    default_behavior = 'deny',
    hold_timeout,
    rules = [],
  } = options;

  const dir = mkdtempSync(join(tmpdir(), 'ashp-e2e-'));
  const dbPath = join(dir, 'ashp.db');
  const proxyBinPath = resolve(import.meta.dirname, '../../ashp/proxy/ashp-proxy');

  // Start local HTTP target server
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('TARGET_OK');
  });
  await new Promise(r => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;
  const targetURL = `http://127.0.0.1:${targetPort}`;

  const config = {
    proxy: {
      listen: '127.0.0.1:0',
      auth: { agent1: 'test-token' },
      bin_path: proxyBinPath,
      hold_timeout,
    },
    management: { listen: '127.0.0.1:0', bearer_token: 'mgmt-secret' },
    rules: { source: 'db' },
    default_behavior,
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

  // Start proxy via ProxyManager
  stack.proxyManager.start();

  // Wait for proxy to be listening (poll the proxy port from config)
  // ProxyManager uses port 0 — we need to discover the actual port.
  // Since proxy listens on 127.0.0.1:0, we can't know the port.
  // Fix: use a known port from config. But port 0 won't work with ProxyManager.
  // We need to assign a random available port first.
  // ... see Step 2 for port resolution.

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Authorization': 'Bearer mgmt-secret', 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${apiBase}${path}`, opts);
    return { status: res.status, body: res.status !== 204 ? await res.json() : null };
  }

  // Create initial rules
  for (const rule of rules) {
    await api('POST', '/api/rules', rule);
  }

  // ... proxyRequest helper, cleanup, etc.
}
```

- [ ] **Step 2: Resolve proxy port issue**

`ProxyManager` spawns the binary with `--listen 127.0.0.1:0` but we can't discover the actual port. Solution: find a free port before spawning.

Add to setup.js:

```js
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}
```

Use it in createFullStack:

```js
  const proxyPort = await getFreePort();
  // Override proxy listen with the discovered port
  config.proxy.listen = `127.0.0.1:${proxyPort}`;
  writeFileSync(configPath, JSON.stringify(config));
```

- [ ] **Step 3: Add proxyRequest helper and cleanup**

```js
  async function proxyRequest(method, path) {
    const url = `${targetURL}${path}`;
    const proxyURL = `http://agent1:test-token@127.0.0.1:${proxyPort}`;
    const res = await fetch(url, {
      method,
      headers: { 'Proxy-Authorization': 'Basic ' + btoa('agent1:test-token') },
      agent: ... // Need HTTP proxy support
    });
  }
```

Problem: Node `fetch` doesn't support HTTP proxy natively. Use `http.request` with proxy:

```js
  function proxyRequest(method, path, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${targetURL}${path}`);
      const req = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method,
        path: url.href,
        headers: {
          'Host': url.host,
          'Proxy-Authorization': 'Basic ' + Buffer.from('agent1:test-token').toString('base64'),
        },
        timeout: timeoutMs,
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  }
```

- [ ] **Step 4: Add waitForProxy helper**

```js
  async function waitForProxy(maxAttempts = 30, interval = 200) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await proxyRequest('GET', '/healthcheck', 1000);
        return; // Proxy is responding (even 403 means it's up)
      } catch {
        // Connection refused — proxy not ready yet
      }
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error('Proxy did not start in time');
  }
```

Actually since default_behavior may be deny/hold, any response (even 403/504) means proxy is up. Catch only connection errors:

```js
  async function waitForProxy(maxAttempts = 30, interval = 200) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const net = await import('node:net');
        await new Promise((resolve, reject) => {
          const sock = net.connect(proxyPort, '127.0.0.1', () => { sock.destroy(); resolve(); });
          sock.on('error', reject);
        });
        return;
      } catch {}
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error('Proxy did not start in time');
  }
  await waitForProxy();
```

- [ ] **Step 5: Complete createFullStack return and cleanup**

```js
  return {
    dir, apiBase, targetURL, proxyPort, api, stack,
    proxyRequest,
    cleanup() {
      stack.proxyManager.stop();
      target.close();
      stack.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
```

- [ ] **Step 6: Verify setup compiles**

Run: `cd ashp && node --check test/e2e/setup.js`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add ashp/test/e2e/setup.js
git commit -m "feat: add createFullStack E2E helper with proxy, target, IPC"
```

---

## Chunk 2: Allow and Deny tests

### Task 3: E2E Allow test

**Files:**
- Create: `ashp/test/e2e/proxy-e2e-allow.test.js`

- [ ] **Step 1: Write test**

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFullStack } from './setup.js';

describe('E2E: proxy allow flow', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createFullStack({
      default_behavior: 'deny',
      rules: [{
        name: 'Allow target',
        url_pattern: '^http://127\\.0\\.0\\.1.*$',
        methods: ['GET'],
        action: 'allow',
        priority: 100,
        enabled: true,
      }],
    });
  });

  after(() => t?.cleanup());

  it('allowed request reaches target and returns 200', async () => {
    const res = await t.proxyRequest('GET', '/test');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'TARGET_OK');
  });

  it('allowed request is logged with decision=allowed', async () => {
    // Wait for IPC message to be processed
    await new Promise(r => setTimeout(r, 1000));
    const { body: logs } = await t.api('GET', '/api/logs');
    const entry = logs.find(l => l.url.includes('/test'));
    assert.ok(entry, 'log entry should exist');
    assert.equal(entry.decision, 'allowed');
    assert.equal(entry.agent_id, 'agent1');
    assert.equal(entry.response_status, 200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (proxy binary not built or setup issues)**

Run: `cd ashp && make build-proxy && node --test test/e2e/proxy-e2e-allow.test.js`
Expected: passes if setup is correct, fails if there are issues to fix

- [ ] **Step 3: Fix any issues and verify passes**

- [ ] **Step 4: Commit**

```bash
git add ashp/test/e2e/proxy-e2e-allow.test.js
git commit -m "test: add E2E proxy allow flow test"
```

---

### Task 4: E2E Deny tests (rule + default)

**Files:**
- Create: `ashp/test/e2e/proxy-e2e-deny.test.js`

- [ ] **Step 1: Write test**

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFullStack } from './setup.js';

describe('E2E: proxy deny by rule', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createFullStack({
      default_behavior: 'deny',
      rules: [{
        name: 'Deny target',
        url_pattern: '^http://127\\.0\\.0\\.1.*$',
        methods: ['GET'],
        action: 'deny',
        priority: 100,
        enabled: true,
      }],
    });
  });

  after(() => t?.cleanup());

  it('denied request returns 403', async () => {
    const res = await t.proxyRequest('GET', '/blocked');
    assert.equal(res.status, 403);
  });

  it('denied request is logged with decision=denied', async () => {
    await new Promise(r => setTimeout(r, 1000));
    const { body: logs } = await t.api('GET', '/api/logs');
    const entry = logs.find(l => l.url.includes('/blocked'));
    assert.ok(entry, 'log entry should exist');
    assert.equal(entry.decision, 'denied');
  });
});

describe('E2E: proxy deny by default', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createFullStack({ default_behavior: 'deny' });
    // No rules — everything denied by default
  });

  after(() => t?.cleanup());

  it('request with no matching rule returns 403', async () => {
    const res = await t.proxyRequest('GET', '/no-rule');
    assert.equal(res.status, 403);
  });

  it('default deny is logged with decision=denied', async () => {
    await new Promise(r => setTimeout(r, 1000));
    const { body: logs } = await t.api('GET', '/api/logs');
    const entry = logs.find(l => l.url.includes('/no-rule'));
    assert.ok(entry, 'log entry should exist');
    assert.equal(entry.decision, 'denied');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd ashp && node --test test/e2e/proxy-e2e-deny.test.js`
Expected: all pass

- [ ] **Step 3: Commit**

```bash
git add ashp/test/e2e/proxy-e2e-deny.test.js
git commit -m "test: add E2E proxy deny flow tests (rule + default)"
```

---

## Chunk 3: Hold tests

### Task 5: E2E Hold → Approve test

**Files:**
- Create: `ashp/test/e2e/proxy-e2e-hold.test.js`

- [ ] **Step 1: Write test**

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFullStack } from './setup.js';

describe('E2E: hold → approve', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createFullStack({
      default_behavior: 'hold',
      hold_timeout: 30,
    });
  });

  after(() => t?.cleanup());

  it('request is held, approved, and completes with 200', async () => {
    // Send request in background (it will block)
    const requestPromise = t.proxyRequest('GET', '/held-approve', 20000);

    // Poll for pending approval
    let approvalId;
    for (let i = 0; i < 30; i++) {
      const { body: approvals } = await t.api('GET', '/api/approvals');
      if (approvals.length > 0) {
        approvalId = approvals[0].id;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(approvalId, 'approval should appear in queue');

    // Approve
    const { status, body } = await t.api('POST', `/api/approvals/${approvalId}/resolve`, {
      action: 'approve',
    });
    assert.equal(status, 200);
    assert.equal(body.status, 'approved');

    // Wait for request to complete
    const res = await requestPromise;
    assert.equal(res.status, 200);
    assert.equal(res.body, 'TARGET_OK');
  });

  it('logs show held and allowed entries', async () => {
    await new Promise(r => setTimeout(r, 1000));
    const { body: logs } = await t.api('GET', '/api/logs');
    const held = logs.find(l => l.decision === 'held');
    const allowed = logs.find(l => l.decision === 'allowed');
    assert.ok(held, 'should have held log entry');
    assert.ok(allowed, 'should have allowed log entry after approval');
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd ashp && node --test test/e2e/proxy-e2e-hold.test.js`
Expected: passes

- [ ] **Step 3: Commit**

```bash
git add ashp/test/e2e/proxy-e2e-hold.test.js
git commit -m "test: add E2E hold → approve flow test"
```

---

### Task 6: E2E Hold → Reject test

**Files:**
- Modify: `ashp/test/e2e/proxy-e2e-hold.test.js`

- [ ] **Step 1: Add reject test to hold test file**

```js
describe('E2E: hold → reject', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createFullStack({
      default_behavior: 'hold',
      hold_timeout: 30,
    });
  });

  after(() => t?.cleanup());

  it('request is held, rejected, and returns 504', async () => {
    const requestPromise = t.proxyRequest('GET', '/held-reject', 20000);

    // Poll for pending approval
    let approvalId;
    for (let i = 0; i < 30; i++) {
      const { body: approvals } = await t.api('GET', '/api/approvals');
      if (approvals.length > 0) {
        approvalId = approvals[0].id;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(approvalId, 'approval should appear in queue');

    // Reject
    const { status, body } = await t.api('POST', `/api/approvals/${approvalId}/resolve`, {
      action: 'reject',
    });
    assert.equal(status, 200);
    assert.equal(body.status, 'rejected');

    // Wait for request to complete
    const res = await requestPromise;
    assert.equal(res.status, 504);
  });

  it('logs show denied entry after reject', async () => {
    await new Promise(r => setTimeout(r, 1000));
    const { body: logs } = await t.api('GET', '/api/logs');
    const denied = logs.find(l => l.decision === 'denied');
    assert.ok(denied, 'should have denied log entry');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd ashp && node --test test/e2e/proxy-e2e-hold.test.js`
Expected: all hold tests pass

- [ ] **Step 3: Commit**

```bash
git add ashp/test/e2e/proxy-e2e-hold.test.js
git commit -m "test: add E2E hold → reject flow test"
```

---

### Task 7: E2E Hold → Timeout test

**Files:**
- Modify: `ashp/test/e2e/proxy-e2e-hold.test.js`

- [ ] **Step 1: Add timeout test**

```js
describe('E2E: hold → timeout', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createFullStack({
      default_behavior: 'hold',
      hold_timeout: 2, // 2 seconds — short timeout
    });
  });

  after(() => t?.cleanup());

  it('request times out after hold_timeout and returns 504', async () => {
    const start = Date.now();
    const res = await t.proxyRequest('GET', '/held-timeout', 10000);
    const elapsed = Date.now() - start;

    assert.equal(res.status, 504);
    assert.ok(elapsed >= 1500, `should wait ~2s, waited ${elapsed}ms`);
    assert.ok(elapsed < 5000, `should not wait too long, waited ${elapsed}ms`);
  });

  it('timeout is logged with decision=denied', async () => {
    await new Promise(r => setTimeout(r, 1000));
    const { body: logs } = await t.api('GET', '/api/logs');
    const denied = logs.find(l => l.decision === 'denied');
    assert.ok(denied, 'should have denied log entry after timeout');
  });
});
```

- [ ] **Step 2: Run all hold tests**

Run: `cd ashp && node --test test/e2e/proxy-e2e-hold.test.js`
Expected: all 6 hold tests pass (approve 2, reject 2, timeout 2)

- [ ] **Step 3: Commit**

```bash
git add ashp/test/e2e/proxy-e2e-hold.test.js
git commit -m "test: add E2E hold → timeout flow test"
```

---

## Chunk 4: Finalize

### Task 8: Run full test suite and verify

- [ ] **Step 1: Run all E2E tests**

Run: `cd ashp && make build-proxy && node --test test/e2e/proxy-e2e-*.test.js`
Expected: all tests pass

- [ ] **Step 2: Run existing tests to confirm no regressions**

Run: `cd ashp && make test`
Expected: all proxy + server + gui tests pass

- [ ] **Step 3: Update Makefile test-e2e target**

In `ashp/Makefile`, update test-e2e to include new tests:

```makefile
test-e2e: build-proxy
	cd server && node --test '../test/e2e/*.test.js'
```

This already matches all test files in the e2e directory, so no change needed — verify it picks up the new files.

Run: `cd ashp && make test-e2e`

- [ ] **Step 4: Final commit**

```bash
git add ashp/Makefile
git commit -m "test: complete E2E proxy test suite (allow, deny, hold flows)"
```
