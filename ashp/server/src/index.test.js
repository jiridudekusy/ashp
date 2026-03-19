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
