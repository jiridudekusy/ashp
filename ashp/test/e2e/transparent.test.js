/**
 * E2E tests for the transparent proxy listeners.
 *
 * These tests start the full ASHP stack (Node management server + Go proxy)
 * with transparent listeners enabled, then connect directly to the transparent
 * HTTP and HTTPS ports — mimicking a container whose traffic is redirected by
 * iptables rather than going through the forward-proxy protocol.
 *
 * Key differences from the regular proxy E2E tests:
 * - No Proxy-Authorization header: agents are identified by source IP.
 * - HTTPS: raw TLS with SNI (not HTTP CONNECT); the proxy intercepts and
 *   presents a MITM cert signed by the ASHP CA.
 * - HTTP: plain HTTP request with a Host header; the proxy extracts the target
 *   from the Host header.
 * - Logged entries should carry mode = "transparent".
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { startServer } from '../../server/src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a free TCP port on 127.0.0.1 by briefly binding a server.
 * @returns {Promise<number>}
 */
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

/**
 * Waits until a TCP port accepts connections, polling at `interval` ms.
 * @param {number} port
 * @param {string} host
 * @param {number} maxAttempts
 * @param {number} interval
 */
async function waitForPort(port, host = '127.0.0.1', maxAttempts = 50, interval = 200) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await new Promise((res, rej) => {
        const s = net.connect(port, host, () => { s.destroy(); res(); });
        s.on('error', rej);
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, interval));
    }
  }
  throw new Error(`Port ${port} on ${host} did not open in time`);
}

/**
 * Starts the full ASHP stack with transparent proxy enabled.
 *
 * Returns helpers for the transparent tests:
 * - `transparentHttpPort`  — the plain HTTP transparent listener port
 * - `transparentHttpsPort` — the TLS transparent listener port
 * - `targetHttpPort`       — local HTTP target server port
 * - `api(method, path, body)` — authenticated management API helper
 * - `caCertPath`           — absolute path to the generated ASHP root CA cert
 * - `agentName / agentToken` — credentials of the registered test agent
 * - `cleanup()`            — stops all processes and removes temp dirs
 *
 * @param {Object} [options]
 * @param {string} [options.default_behavior='deny']
 * @param {Array}  [options.policies]
 */
async function createTransparentStack(options = {}) {
  const { default_behavior = 'deny' } = options;

  const dir = mkdtempSync(join(tmpdir(), 'ashp-e2e-transparent-'));
  const dbPath = join(dir, 'ashp.db');
  const proxyBinPath = resolve(import.meta.dirname, '../../proxy/ashp-proxy');

  // Allocate ports up front so we can embed them in the config file.
  const proxyPort = await getFreePort();
  const transparentHttpPort = await getFreePort();
  const transparentHttpsPort = await getFreePort();

  // Local HTTP target that responds with a fixed body.
  let targetHits = 0;
  const target = http.createServer((req, res) => {
    targetHits++;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('TRANSPARENT_TARGET_OK');
  });
  await new Promise(r => target.listen(0, '127.0.0.1', r));
  const targetHttpPort = target.address().port;

  const config = {
    proxy: {
      listen: `127.0.0.1:${proxyPort}`,
      bin_path: proxyBinPath,
    },
    transparent: {
      enabled: true,
      listen: '127.0.0.1',
      ports: [
        { port: transparentHttpsPort, tls: true },
        { port: transparentHttpPort,  tls: false },
      ],
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

  // Start Node management server.
  const stack = await startServer({ config: configPath });
  const mgmtPort = stack.server.address().port;
  const apiBase = `http://127.0.0.1:${mgmtPort}`;

  async function api(method, path, body) {
    const opts = {
      method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from('admin:testpass').toString('base64'),
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${apiBase}${path}`, opts);
    return { status: res.status, body: res.status !== 204 ? await res.json() : null };
  }

  // Create test agent.
  const { body: agentData } = await api('POST', '/api/agents', { name: 'agent1' });
  const agentToken = agentData.token;

  // Create policies / rules if provided.
  if (options.policies) {
    for (const pol of options.policies) {
      const { body: policy } = await api('POST', '/api/policies', { name: pol.name, description: pol.description || '' });
      for (const rule of (pol.rules || [])) {
        await api('POST', '/api/rules', { ...rule, policy_id: policy.id });
      }
      if (pol.assignToAgent) {
        const { body: agents } = await api('GET', '/api/agents');
        const agent = agents.find(a => a.name === 'agent1');
        if (agent) await api('POST', `/api/policies/${policy.id}/agents`, { agent_id: agent.id });
      }
    }
  }

  // Start Go proxy.
  stack.proxyManager.start();

  // Wait for the standard proxy port (it starts before transparent listeners).
  await waitForPort(proxyPort);
  // Wait for the transparent listeners.
  await waitForPort(transparentHttpPort);
  await waitForPort(transparentHttpsPort);

  // Allow IPC sync to complete.
  await new Promise(r => setTimeout(r, 500));

  // Register the loopback IP as agent1 so transparent auth resolves.
  // Uses the register-ip endpoint which authenticates via agent token.
  const regRes = await fetch(`${apiBase}/api/agents/register-ip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'agent1', token: agentToken, ip_address: '127.0.0.1' }),
  });
  if (!regRes.ok) throw new Error(`register-ip failed: ${regRes.status}`);
  // Wait for IPC to propagate the mapping to Go proxy.
  await new Promise(r => setTimeout(r, 500));

  // Path to the generated CA cert (written by the Go proxy on first start).
  const caCertPath = join(dir, 'ca', 'root.crt');

  return {
    dir,
    apiBase,
    proxyPort,
    transparentHttpPort,
    transparentHttpsPort,
    targetHttpPort,
    caCertPath,
    agentName: 'agent1',
    agentToken,
    api,
    stack,
    getTargetHits() { return targetHits; },
    cleanup() {
      stack.proxyManager.stop();
      target.close();
      stack.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Sends a plain HTTP/1.1 request to the transparent HTTP listener.
 * The target is identified via the Host header — no proxy protocol involved.
 *
 * @param {number} transparentPort  - Port of the transparent HTTP listener.
 * @param {string} host             - Value for the Host header (e.g. "127.0.0.1:PORT").
 * @param {string} path             - Request path (e.g. "/test").
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<{status: number, body: string}>}
 */
function transparentHttpRequest(transparentPort, host, path, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: transparentPort,
      method: 'GET',
      path,
      headers: { Host: host },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('transparent HTTP request timeout')); });
    req.end();
  });
}

/**
 * Opens a TLS connection to the transparent HTTPS listener using the given SNI,
 * sends a minimal HTTP/1.1 GET, and returns the TLS peer certificate plus the
 * HTTP response status and body.
 *
 * The caller supplies `ca` (Buffer with PEM cert) to verify that the proxy is
 * presenting a cert signed by the ASHP root CA rather than the real server's cert.
 *
 * @param {number} transparentPort  - Port of the transparent HTTPS listener.
 * @param {string} sni              - SNI hostname (also used as HTTP Host header).
 * @param {string} path             - Request path.
 * @param {Buffer|null} [ca=null]   - CA cert to verify against; null = skip verify.
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<{status: number, body: string, peerCert: tls.DetailedPeerCertificate}>}
 */
function transparentHttpsRequest(transparentPort, sni, path, ca = null, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const tlsOpts = {
      host: '127.0.0.1',
      port: transparentPort,
      servername: sni,
      timeout: timeoutMs,
    };

    if (ca) {
      tlsOpts.ca = ca;
    } else {
      tlsOpts.rejectUnauthorized = false;
    }

    const socket = tls.connect(tlsOpts, () => {
      const peerCert = socket.getPeerCertificate(true);
      const request =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${sni}\r\n` +
        `Connection: close\r\n` +
        `\r\n`;
      socket.write(request);

      let raw = '';
      socket.on('data', d => (raw += d));
      socket.on('end', () => {
        // Split HTTP response into head + body.
        const sep = raw.indexOf('\r\n\r\n');
        const head = sep >= 0 ? raw.slice(0, sep) : raw;
        const body = sep >= 0 ? raw.slice(sep + 4) : '';
        const statusMatch = head.match(/^HTTP\/\d\.\d (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        resolve({ status, body, peerCert });
      });
      socket.on('error', reject);
    });

    socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('transparent HTTPS request timeout')); });
  });
}

// ---------------------------------------------------------------------------
// Tests — Transparent HTTP
// ---------------------------------------------------------------------------

describe('E2E: transparent HTTP — allow', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createTransparentStack({
      default_behavior: 'deny',
      policies: [{
        name: 'AllowLocalHTTP',
        rules: [{
          name: 'Allow local HTTP',
          url_pattern: '^http://127\\.0\\.0\\.1.*$',
          methods: ['GET'],
          action: 'allow',
          priority: 100,
          enabled: true,
        }],
        assignToAgent: true,
      }],
    });
  });

  after(() => t?.cleanup());

  it('transparent HTTP request reaches target and returns 200', async () => {
    const host = `127.0.0.1:${t.targetHttpPort}`;
    const res = await transparentHttpRequest(t.transparentHttpPort, host, '/transparent-http-test');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'TRANSPARENT_TARGET_OK');
  });

  it('transparent HTTP request is logged with mode=transparent and decision=allowed', async () => {
    await new Promise(r => setTimeout(r, 1000));
    const { body: logs } = await t.api('GET', '/api/logs');
    const entry = logs.find(l => l.url?.includes('/transparent-http-test'));
    assert.ok(entry, 'log entry should exist');
    assert.equal(entry.decision, 'allowed');
    assert.equal(entry.mode, 'transparent');
  });
});

describe('E2E: transparent HTTP — deny by rule', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createTransparentStack({
      default_behavior: 'deny',
      policies: [{
        name: 'DenyAndAllow',
        rules: [{
          name: 'Deny blocked path',
          url_pattern: '^http://127\\.0\\.0\\.1.*/blocked.*$',
          methods: ['GET'],
          action: 'deny',
          priority: 200,
          enabled: true,
        }, {
          name: 'Allow everything else',
          url_pattern: '^http://.*$',
          methods: [],
          action: 'allow',
          priority: 50,
          enabled: true,
        }],
        assignToAgent: true,
      }],
    });
  });

  after(() => t?.cleanup());

  it('transparent HTTP request matching deny rule returns 403', async () => {
    const hitsBefore = t.getTargetHits();
    const host = `127.0.0.1:${t.targetHttpPort}`;
    const res = await transparentHttpRequest(t.transparentHttpPort, host, '/blocked-transparent');
    assert.equal(res.status, 403);
    assert.equal(t.getTargetHits(), hitsBefore, 'target should NOT receive the denied request');
  });

  it('denied transparent HTTP request is logged with mode=transparent and decision=denied', async () => {
    await new Promise(r => setTimeout(r, 2000));
    const { body: logs } = await t.api('GET', '/api/logs');
    const entry = logs.find(l => l.url?.includes('/blocked-transparent'));
    assert.ok(entry, 'log entry should exist');
    assert.equal(entry.decision, 'denied');
    assert.equal(entry.mode, 'transparent');
  });
});

describe('E2E: transparent HTTP — default deny (no rule match)', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createTransparentStack({ default_behavior: 'deny' });
  });

  after(() => t?.cleanup());

  it('unregistered-agent transparent HTTP request returns 403', async () => {
    // No IP mapping configured — agentID will be empty, default behavior applies.
    const host = `127.0.0.1:${t.targetHttpPort}`;
    const res = await transparentHttpRequest(t.transparentHttpPort, host, '/no-rule');
    assert.equal(res.status, 403);
  });
});

// ---------------------------------------------------------------------------
// Tests — Transparent HTTPS (MITM)
// ---------------------------------------------------------------------------

describe('E2E: transparent HTTPS — MITM cert signed by ASHP CA', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    // Allow all HTTPS so the connection completes successfully.
    t = await createTransparentStack({
      default_behavior: 'deny',
      policies: [{
        name: 'AllowHTTPS',
        rules: [{
          name: 'Allow all HTTPS',
          url_pattern: '^https://.*$',
          methods: ['GET'],
          action: 'allow',
          priority: 100,
          enabled: true,
        }],
        assignToAgent: true,
      }],
    });
  });

  after(() => t?.cleanup());

  it('TLS connection presents a cert signed by the ASHP CA (MITM)', async () => {
    // Fetch the CA cert that the proxy generated.
    const caCertPem = readFileSync(t.caCertPath);
    const caCert = new X509Certificate(caCertPem);

    // Connect with SNI set to a recognisable hostname.
    const sni = 'example.ashp.test';
    const { peerCert } = await transparentHttpsRequest(
      t.transparentHttpsPort, sni, '/', null /* skip server verify for now */
    );

    // The presented cert's CN / SAN must match the requested SNI.
    const certPem = '-----BEGIN CERTIFICATE-----\n' +
      Buffer.from(peerCert.raw).toString('base64').match(/.{1,64}/g).join('\n') +
      '\n-----END CERTIFICATE-----';
    const leafCert = new X509Certificate(certPem);

    // The leaf cert must be issued for the SNI hostname.
    const validForSNI =
      leafCert.subject.includes(sni) ||
      (leafCert.subjectAltName && leafCert.subjectAltName.includes(sni));
    assert.ok(validForSNI, `Leaf cert should be issued for SNI "${sni}", got subject="${leafCert.subject}" SAN="${leafCert.subjectAltName}"`);

    // The leaf cert must be verifiable against the ASHP CA.
    const isSignedByCA = leafCert.verify(caCert.publicKey);
    assert.ok(isSignedByCA, 'Leaf cert should be signed by the ASHP CA');
  });

  // Note: HTTPS allow logging cannot be tested locally because there is no real
  // HTTPS target server. The request.logged IPC message is sent after forwarding
  // completes, and with a fake SNI hostname the upstream connection fails before
  // any response is available. HTTPS deny logging IS tested in the next suite.
});

describe('E2E: transparent HTTPS — deny by rule', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createTransparentStack({ default_behavior: 'deny' });
    // No allow rules — default deny applies to all HTTPS.
  });

  after(() => t?.cleanup());

  it('transparent HTTPS request with no matching rule gets 403 via MITM', async () => {
    const sni = 'example.ashp.test';
    const { status } = await transparentHttpsRequest(
      t.transparentHttpsPort, sni, '/', null
    );
    assert.equal(status, 403, `expected 403 Forbidden, got ${status}`);
  });

  it('denied transparent HTTPS request is logged with mode=transparent', async () => {
    await new Promise(r => setTimeout(r, 1000));
    const { body: logs } = await t.api('GET', '/api/logs');
    const entry = logs.find(l => l.mode === 'transparent' && l.url?.startsWith('https://'));
    assert.ok(entry, 'log entry should exist');
    assert.equal(entry.decision, 'denied');
    assert.equal(entry.mode, 'transparent');
  });
});
