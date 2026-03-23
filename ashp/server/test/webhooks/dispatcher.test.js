import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { WebhookDispatcher } from '../../src/webhooks/dispatcher.js';

function createTarget(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function targetUrl(server) {
  const addr = server.address();
  return `http://127.0.0.1:${addr.port}`;
}

describe('Webhook dispatcher', () => {
  let servers = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise(r => s.close(r));
    }
    servers = [];
  });

  it('dispatches event to matching webhook', async () => {
    let receivedBody = null;
    let receivedHeaders = null;
    const target = await createTarget((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        receivedBody = JSON.parse(body);
        receivedHeaders = req.headers;
        res.writeHead(200);
        res.end();
      });
    });
    servers.push(target);

    const dispatcher = new WebhookDispatcher([
      { url: targetUrl(target), events: ['approval.needed'], secret: 'test-secret', retries: 0 },
    ]);

    await dispatcher.dispatch('approval.needed', { request_id: 42 });

    assert.ok(receivedBody, 'target should have received a request');
    assert.equal(receivedBody.event, 'approval.needed');
    assert.deepStrictEqual(receivedBody.data, { request_id: 42 });
    assert.ok(receivedBody.timestamp);
    assert.equal(receivedHeaders['content-type'], 'application/json');
  });

  it('includes HMAC-SHA256 signature header', async () => {
    let receivedBody = '';
    let signatureHeader = null;
    const secret = 'my-webhook-secret';

    const target = await createTarget((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        receivedBody = body;
        signatureHeader = req.headers['x-ashp-signature'];
        res.writeHead(200);
        res.end();
      });
    });
    servers.push(target);

    const dispatcher = new WebhookDispatcher([
      { url: targetUrl(target), events: ['approval.needed'], secret, retries: 0 },
    ]);

    await dispatcher.dispatch('approval.needed', { id: 1 });

    assert.ok(signatureHeader, 'signature header should be present');
    const expected = createHmac('sha256', secret).update(receivedBody).digest('hex');
    assert.equal(signatureHeader, expected);
  });

  it('skips webhook for non-matching event', async () => {
    let called = false;
    const target = await createTarget((req, res) => {
      called = true;
      res.writeHead(200);
      res.end();
    });
    servers.push(target);

    const dispatcher = new WebhookDispatcher([
      { url: targetUrl(target), events: ['approval.needed'], secret: 's', retries: 0 },
    ]);

    await dispatcher.dispatch('request.allowed', { id: 1 });

    assert.equal(called, false, 'target should not have been called');
  });

  it('retries on failure with backoff', async () => {
    let requestCount = 0;
    const target = await createTarget((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requestCount++;
        if (requestCount < 3) {
          res.writeHead(500);
        } else {
          res.writeHead(200);
        }
        res.end();
      });
    });
    servers.push(target);

    const dispatcher = new WebhookDispatcher([
      { url: targetUrl(target), events: ['test'], secret: 's', retries: 3 },
    ]);

    await dispatcher.dispatch('test', { n: 1 });

    assert.equal(requestCount, 3, 'should have made 3 total requests');
  });

  it('gives up after max retries', async () => {
    let requestCount = 0;
    const target = await createTarget((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requestCount++;
        res.writeHead(500);
        res.end();
      });
    });
    servers.push(target);

    const dispatcher = new WebhookDispatcher([
      { url: targetUrl(target), events: ['test'], secret: 's', retries: 2 },
    ]);

    // Should not crash
    await dispatcher.dispatch('test', { n: 1 });

    // 1 initial + 2 retries = 3
    assert.equal(requestCount, 3, 'should have made 1 initial + 2 retries');
  });

  it('respects timeout', async () => {
    const target = await createTarget((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        // Delay 10 seconds — never responds in time
        setTimeout(() => {
          res.writeHead(200);
          res.end();
        }, 10000);
      });
    });
    servers.push(target);

    const dispatcher = new WebhookDispatcher([
      { url: targetUrl(target), events: ['test'], secret: 's', timeout_ms: 100, retries: 0 },
    ]);

    // Should not crash, should complete quickly due to timeout
    const start = Date.now();
    await dispatcher.dispatch('test', { n: 1 });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `should complete quickly due to timeout, took ${elapsed}ms`);
  });
});
