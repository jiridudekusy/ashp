import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFullStack } from './setup.js';

describe('E2E: proxy allow flow', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createFullStack({
      default_behavior: 'deny',
      policies: [{
        name: 'AllowTarget',
        rules: [{
          name: 'Allow target',
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

  it('allowed request reaches target and returns 200', async () => {
    const res = await t.proxyRequest('GET', '/test');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'TARGET_OK');
  });

  it('allowed request is logged with decision=allowed', async () => {
    await new Promise(r => setTimeout(r, 1000));
    const { body: logs } = await t.api('GET', '/api/logs');
    const entry = logs.find(l => l.url.includes('/test'));
    assert.ok(entry, 'log entry should exist');
    assert.equal(entry.decision, 'allowed');
    assert.equal(entry.agent_id, 'agent1');
    assert.equal(entry.response_status, 200);
  });
});
