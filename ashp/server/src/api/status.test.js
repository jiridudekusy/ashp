import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import statusRoutes from './status.js';
import { errorHandler } from './middleware.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, opts = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const reqOpts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: opts.path || '/',
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Status API route', () => {
  let server;

  afterEach(async () => {
    if (server) await new Promise(r => server.close(r));
    server = null;
  });

  it('GET /api/status returns proxy status and stats', async () => {
    const mockProxyManager = {
      getStatus() {
        return { running: true, uptime_ms: 12345 };
      },
    };
    const mockRulesDAO = {
      list: async () => [
        { id: 1, name: 'Rule 1' },
        { id: 2, name: 'Rule 2' },
        { id: 3, name: 'Rule 3' },
      ],
    };
    const mockConfig = {
      rules: { source: 'db' },
      database: { path: '/tmp/ashp-test/ashp.db' },
    };

    const app = express();
    app.use('/api', statusRoutes({ proxyManager: mockProxyManager, rulesDAO: mockRulesDAO, config: mockConfig }));
    app.use(errorHandler);
    server = await listen(app);

    const res = await request(server, { path: '/api/status' });
    assert.equal(res.status, 200);
    assert.equal(res.body.proxy.running, true);
    assert.equal(res.body.proxy.uptime_ms, 12345);
    assert.equal(res.body.rules_count, 3);
    assert.equal(res.body.rules_source, 'db');
    assert.equal(res.body.db_path, '/tmp/ashp-test/ashp.db');
    assert.ok(res.body.management.uptime_ms >= 0);
  });

  it('GET /api/ca/certificate serves CA cert file', async () => {
    const tmpDir = join(tmpdir(), `ashp-status-test-${Date.now()}`);
    const caDir = join(tmpDir, 'ca');
    mkdirSync(caDir, { recursive: true });
    const certPath = join(caDir, 'root.crt');
    const certContent = '-----BEGIN CERTIFICATE-----\nFAKECERT\n-----END CERTIFICATE-----\n';
    writeFileSync(certPath, certContent);

    const mockProxyManager = { getStatus: () => ({}) };
    const mockRulesDAO = { list: async () => [] };
    const mockConfig = {
      rules: { source: 'db' },
      database: { path: join(tmpDir, 'ashp.db') },
    };

    const app = express();
    app.use('/api', statusRoutes({ proxyManager: mockProxyManager, rulesDAO: mockRulesDAO, config: mockConfig }));
    app.use(errorHandler);
    server = await listen(app);

    const res = await request(server, { path: '/api/ca/certificate' });
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/x-pem-file'));
    assert.equal(res.body, certContent);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
