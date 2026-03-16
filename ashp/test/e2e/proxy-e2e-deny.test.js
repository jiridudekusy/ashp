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
    const hitsBefore = t.getTargetHits();
    const res = await t.proxyRequest('GET', '/blocked');
    assert.equal(res.status, 403);
    assert.equal(t.getTargetHits(), hitsBefore, 'target should NOT receive the request');
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
