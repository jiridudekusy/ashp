import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { startServer } from '../../server/src/index.js';

export async function createTestStack() {
  const dir = mkdtempSync(join(tmpdir(), 'ashp-e2e-'));
  const dbPath = join(dir, 'ashp.db');

  const config = {
    proxy: { listen: '127.0.0.1:0', auth: { agent1: 'test-token' } },
    management: { listen: '127.0.0.1:0', auth: { admin: 'testpass' } },
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
          headers: { 'Authorization': 'Basic ' + Buffer.from('admin:testpass').toString('base64') },
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
      headers: { 'Authorization': 'Basic ' + Buffer.from('admin:testpass').toString('base64'), 'Content-Type': 'application/json' },
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

// --- Full stack helper (with Go proxy + target server) ---

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export async function createFullStack(options = {}) {
  const {
    default_behavior = 'deny',
    hold_timeout,
    rules = [],
  } = options;

  const dir = mkdtempSync(join(tmpdir(), 'ashp-e2e-full-'));
  const dbPath = join(dir, 'ashp.db');
  const proxyBinPath = resolve(import.meta.dirname, '../../proxy/ashp-proxy');

  // 1. Local HTTP target server
  let targetHits = 0;
  const target = http.createServer((req, res) => {
    targetHits++;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('TARGET_OK');
  });
  await new Promise(r => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;
  const targetURL = `http://127.0.0.1:${targetPort}`;

  // 2. Find free port for proxy
  const proxyPort = await getFreePort();

  // 3. Config
  const config = {
    proxy: {
      listen: `127.0.0.1:${proxyPort}`,
      auth: { agent1: 'test-token' },
      bin_path: proxyBinPath,
      hold_timeout,
    },
    management: { listen: '127.0.0.1:0', auth: { admin: 'testpass' } },
    rules: { source: 'db' },
    default_behavior,
    logging: { request_body: 'full', response_body: 'full', retention_days: 1 },
    database: { path: dbPath, encryption_key: 'test-db-key' },
    encryption: { log_key: 'a'.repeat(64), ca_key: 'test-ca-pass' },
    webhooks: [],
  };
  const configPath = join(dir, 'ashp.json');
  writeFileSync(configPath, JSON.stringify(config));

  // 4. Start management server
  const stack = await startServer({ config: configPath });
  const mgmtPort = stack.server.address().port;
  const apiBase = `http://127.0.0.1:${mgmtPort}`;

  // 5. API helper
  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Authorization': 'Basic ' + Buffer.from('admin:testpass').toString('base64'), 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${apiBase}${path}`, opts);
    return { status: res.status, body: res.status !== 204 ? await res.json() : null };
  }

  // 6. Create agent for proxy auth
  const { body: agentData } = await api('POST', '/api/agents', { name: 'agent1' });
  const agentToken = agentData.token; // plaintext token returned at creation

  // 7. Create initial rules
  for (const rule of rules) {
    await api('POST', '/api/rules', rule);
  }

  // 8. Start proxy via ProxyManager
  stack.proxyManager.start();

  // 9. Wait for proxy to accept connections
  async function waitForProxy(maxAttempts = 50, interval = 200) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
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

  // Small delay for IPC connection + rules sync
  await new Promise(r => setTimeout(r, 500));

  // 9. Proxy request helper (HTTP proxy protocol)
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
          'Proxy-Authorization': 'Basic ' + Buffer.from(`agent1:${agentToken}`).toString('base64'),
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

  return {
    dir, apiBase, targetURL, proxyPort, api, stack,
    proxyRequest,
    getTargetHits() { return targetHits; },
    cleanup() {
      stack.proxyManager.stop();
      target.close();
      stack.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
