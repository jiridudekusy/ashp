import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFullStack } from '../e2e/setup.js';

// --- Config ---
const REQUEST_COUNT = 500;
const WARMUP_COUNT = 10;
const REQUEST_BODY = JSON.stringify({
  model: 'gpt-4',
  messages: [
    { role: 'system', content: 'You are a helpful assistant for code review.' },
    { role: 'user', content: 'Review the following function for security issues and performance problems.' },
  ],
  temperature: 0.7,
  max_tokens: 4096,
});

// --- Helpers ---

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(timings) {
  const sorted = [...timings].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    rps: Math.round(sorted.length / (sum / 1000)),
    mean: +(sum / sorted.length).toFixed(2),
    p50: +percentile(sorted, 50).toFixed(2),
    p95: +percentile(sorted, 95).toFixed(2),
    p99: +percentile(sorted, 99).toFixed(2),
  };
}

function directRequest(targetURL) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${targetURL}/bench`);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      method: 'POST',
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(REQUEST_BODY) },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(REQUEST_BODY);
    req.end();
  });
}

function proxyRequestWithBody(proxyPort, targetURL) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${targetURL}/bench`);
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'POST',
      path: url.href,
      headers: {
        'Host': url.host,
        'Proxy-Authorization': 'Basic ' + Buffer.from('agent1:test-token').toString('base64'),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(REQUEST_BODY),
      },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(REQUEST_BODY);
    req.end();
  });
}

async function runScenario(name, fn, count) {
  // Warmup
  for (let i = 0; i < WARMUP_COUNT; i++) {
    await fn();
  }
  // Measure
  const timings = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await fn();
    timings.push(performance.now() - start);
  }
  return { name, ...computeStats(timings) };
}

function printTable(results) {
  const baseline = results[0];
  console.log('');
  console.log('Scenario             Reqs   Req/s    p50      p95      p99      Overhead');
  console.log('─'.repeat(76));
  for (const r of results) {
    const overhead = r === baseline
      ? '—'
      : `+${(r.p50 - baseline.p50).toFixed(1)}ms (${Math.round(((r.p50 - baseline.p50) / baseline.p50) * 100)}%)`;
    console.log(
      `${r.name.padEnd(20)} ${String(r.count).padStart(4)}   ${String(r.rps).padStart(5)}    ${(r.p50 + 'ms').padStart(7)}  ${(r.p95 + 'ms').padStart(7)}  ${(r.p99 + 'ms').padStart(7)}  ${overhead}`
    );
  }
  console.log('');
}

// --- Main ---

async function main() {
  console.log(`\nASHP Proxy Performance Benchmark`);
  console.log(`Requests per scenario: ${REQUEST_COUNT} (+ ${WARMUP_COUNT} warmup)`);
  console.log(`Request body: ${Buffer.byteLength(REQUEST_BODY)} bytes`);
  console.log('');

  // 1. Setup full stack with allow rule (no body logging)
  console.log('Setting up stack...');
  const t = await createFullStack({
    default_behavior: 'deny',
  });

  // Create allow rule without body logging
  const { body: allowRule } = await t.api('POST', '/api/rules', {
    name: 'bench-allow',
    url_pattern: '.*',
    methods: [],
    action: 'allow',
    priority: 100,
    enabled: true,
    log_request_body: 'none',
    log_response_body: 'none',
  });
  await new Promise(r => setTimeout(r, 500));

  const results = [];

  // Scenario 1: Direct
  console.log('Running: Direct (baseline)...');
  results.push(await runScenario('Direct', () => directRequest(t.targetURL), REQUEST_COUNT));

  // Scenario 2: Proxy Allow (no body logging)
  console.log('Running: Proxy (allow)...');
  results.push(await runScenario('Proxy (allow)', () => proxyRequestWithBody(t.proxyPort, t.targetURL), REQUEST_COUNT));

  // Scenario 3: Update rule to log bodies
  await t.api('PUT', `/api/rules/${allowRule.id}`, {
    name: 'bench-allow-log',
    url_pattern: '.*',
    methods: [],
    action: 'allow',
    priority: 100,
    enabled: true,
    log_request_body: 'full',
    log_response_body: 'full',
  });
  // Wait for rules to sync via IPC
  await new Promise(r => setTimeout(r, 500));

  console.log('Running: Proxy (allow+log)...');
  results.push(await runScenario('Proxy (allow+log)', () => proxyRequestWithBody(t.proxyPort, t.targetURL), REQUEST_COUNT));

  // Scenario 4: Deny rule
  // Delete allow rule, create deny rule
  const rulesResp = await t.api('GET', '/api/rules');
  for (const rule of rulesResp.body) {
    await t.api('DELETE', `/api/rules/${rule.id}`);
  }
  await t.api('POST', '/api/rules', {
    name: 'bench-deny',
    url_pattern: '.*',
    methods: [],
    action: 'deny',
    priority: 100,
    enabled: true,
  });
  await new Promise(r => setTimeout(r, 500));

  console.log('Running: Proxy (deny)...');
  results.push(await runScenario('Proxy (deny)', () => proxyRequestWithBody(t.proxyPort, t.targetURL), REQUEST_COUNT));

  // Output
  printTable(results);

  // Save JSON
  const baseline = results[0];
  const jsonResults = {
    timestamp: new Date().toISOString(),
    parameters: { requests: REQUEST_COUNT, warmup: WARMUP_COUNT, body_size: Buffer.byteLength(REQUEST_BODY) },
    scenarios: {},
  };
  for (const r of results) {
    const key = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const entry = { count: r.count, rps: r.rps, mean: r.mean, p50: r.p50, p95: r.p95, p99: r.p99 };
    if (r !== baseline) {
      entry.overhead_ms = +(r.p50 - baseline.p50).toFixed(2);
      entry.overhead_pct = Math.round(((r.p50 - baseline.p50) / baseline.p50) * 100);
    }
    jsonResults.scenarios[key] = entry;
  }

  const outPath = resolve(import.meta.dirname, 'results.json');
  writeFileSync(outPath, JSON.stringify(jsonResults, null, 2));
  console.log(`Results saved to ${outPath}`);

  // Cleanup
  t.cleanup();
  process.exit(0);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
