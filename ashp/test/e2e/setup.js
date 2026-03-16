import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../../server/src/index.js';

export async function createTestStack() {
  const dir = mkdtempSync(join(tmpdir(), 'ashp-e2e-'));
  const dbPath = join(dir, 'ashp.db');

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
    dir, apiBase, proxyBase: null, api, stack,
    mgmtPort,
    cleanup() {
      stack.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
