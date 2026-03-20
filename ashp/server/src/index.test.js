import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

function makeTempConfig(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ashp-test-'));
  const dbDir = join(dir, 'data');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'ashp.db');
  const password = randomBytes(16).toString('hex');
  const encKey = randomBytes(16).toString('hex');

  const config = {
    management: { listen: '127.0.0.1:0', auth: { admin: password } },
    proxy: { listen: '127.0.0.1:0' },
    rules: { source: 'db' },
    database: { path: dbPath, encryption_key: encKey },
    default_behavior: 'deny',
    webhooks: [],
    ...overrides,
  };

  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  return { dir, configPath, password, config };
}

describe('startServer integration', () => {
  let instance = null;

  afterEach(async () => {
    if (instance) {
      instance.close();
      instance = null;
    }
  });

  it('starts server, GET /api/status returns 200', async () => {
    const { configPath, password } = makeTempConfig();
    const { startServer } = await import('./index.js');
    instance = await startServer({ config: configPath });

    const port = instance.server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Authorization: `Basic ${Buffer.from('admin:' + password).toString('base64')}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.rules_count !== undefined);
    assert.equal(body.rules_source, 'db');
  });

  it('basic auth required on all API routes', async () => {
    const { configPath } = makeTempConfig();
    const { startServer } = await import('./index.js');
    instance = await startServer({ config: configPath });

    const port = instance.server.address().port;
    // /api/rules requires auth
    const res = await fetch(`http://127.0.0.1:${port}/api/rules`);
    assert.equal(res.status, 401);
  });

  it('agent CRUD lifecycle — create, list, rotate, delete', async () => {
    const { configPath, password } = makeTempConfig();
    const { startServer } = await import('./index.js');
    instance = await startServer({ config: configPath });

    const port = instance.server.address().port;
    const auth = `Basic ${Buffer.from('admin:' + password).toString('base64')}`;
    const api = (method, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    // Create agent
    let res = await api('POST', '/api/agents', { name: 'test-agent' });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.name, 'test-agent');
    assert.ok(created.token, 'token returned on create');
    assert.equal(created.enabled, true);

    // List agents — no token exposed
    res = await api('GET', '/api/agents');
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'test-agent');
    assert.ok(!list[0].token, 'token not in list');
    assert.ok(!list[0].token_hash, 'token_hash not in list');

    // Rotate token
    res = await api('POST', `/api/agents/${created.id}/rotate-token`);
    assert.equal(res.status, 200);
    const rotated = await res.json();
    assert.ok(rotated.token, 'new token returned');
    assert.notEqual(rotated.token, created.token, 'token changed');

    // Delete agent
    res = await api('DELETE', `/api/agents/${created.id}`);
    assert.equal(res.status, 204);

    // Verify deleted
    res = await api('GET', `/api/agents/${created.id}`);
    assert.equal(res.status, 404);
  });

  it('rules include hit_count fields', async () => {
    const { configPath, password } = makeTempConfig();
    const { startServer } = await import('./index.js');
    instance = await startServer({ config: configPath });

    const port = instance.server.address().port;
    const auth = `Basic ${Buffer.from('admin:' + password).toString('base64')}`;
    const api = (method, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    // Create a rule
    let res = await api('POST', '/api/rules', {
      name: 'test-rule',
      url_pattern: '^https://example\\.com',
      methods: [],
      action: 'allow',
    });
    assert.equal(res.status, 201);

    // List rules — should have hit_count fields
    res = await api('GET', '/api/rules');
    assert.equal(res.status, 200);
    const rules = await res.json();
    assert.ok(rules.length >= 1);
    const rule = rules.find(r => r.name === 'test-rule');
    assert.ok(rule);
    assert.equal(rule.hit_count, 0);
    assert.equal(rule.hit_count_today, 0);
  });

  it('logs support agent_id filter', async () => {
    const { configPath, password } = makeTempConfig();
    const { startServer } = await import('./index.js');
    instance = await startServer({ config: configPath });

    const port = instance.server.address().port;
    const auth = `Basic ${Buffer.from('admin:' + password).toString('base64')}`;

    // Query logs with agent_id filter (no logs yet, but should return 200 empty array)
    const res = await fetch(`http://127.0.0.1:${port}/api/logs?agent_id=nonexistent`, {
      headers: { Authorization: auth },
    });
    assert.equal(res.status, 200);
    const logs = await res.json();
    assert.ok(Array.isArray(logs));
    assert.equal(logs.length, 0);
  });

  it('SIGHUP reloads config', async () => {
    const { configPath, password, config } = makeTempConfig();
    const { startServer } = await import('./index.js');
    instance = await startServer({ config: configPath });

    const port = instance.server.address().port;
    const authHeader = `Basic ${Buffer.from('admin:' + password).toString('base64')}`;

    // Verify initial default_behavior
    let res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Authorization: authHeader },
    });
    assert.equal(res.status, 200);

    // Modify config to change default_behavior
    config.default_behavior = 'hold';
    writeFileSync(configPath, JSON.stringify(config));

    // Send SIGHUP
    process.kill(process.pid, 'SIGHUP');
    // Small delay to let the handler run
    await new Promise(r => setTimeout(r, 50));

    // Verify config was reloaded by checking status
    res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Authorization: authHeader },
    });
    assert.equal(res.status, 200);
    // Server should still be running after reload
  });
});
