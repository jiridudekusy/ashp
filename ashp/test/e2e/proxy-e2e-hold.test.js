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
    const requestPromise = t.proxyRequest('GET', '/held-approve', 25000);

    // Poll for pending approval
    let approvalId;
    for (let i = 0; i < 40; i++) {
      const { body: approvals } = await t.api('GET', '/api/approvals');
      if (approvals.length > 0) {
        approvalId = approvals[0].id;
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    assert.ok(approvalId, 'approval should appear in queue');

    // Small delay to ensure proxy hold channel is ready
    await new Promise(r => setTimeout(r, 200));

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

  it('logs show held and denied entries after reject', async () => {
    // Poll for denied log entry (IPC may take a moment)
    let denied;
    for (let i = 0; i < 10; i++) {
      const { body: logs } = await t.api('GET', '/api/logs');
      denied = logs.find(l => l.decision === 'denied');
      if (denied) break;
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(denied, 'should have denied log entry');
  });
});

describe('E2E: hold → timeout', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createFullStack({
      default_behavior: 'hold',
      hold_timeout: 2,
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
