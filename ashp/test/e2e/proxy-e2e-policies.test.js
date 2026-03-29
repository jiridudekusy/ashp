import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFullStack } from './setup.js';

describe('E2E: policy-scoped proxy', { timeout: 30000 }, () => {
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

  it('agent with policy can access matching URL', async () => {
    const res = await t.proxyRequest('GET', '/test');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'TARGET_OK');
  });

  it('request is logged with decision=allowed', async () => {
    await new Promise(r => setTimeout(r, 1000));
    const { body: logs } = await t.api('GET', '/api/logs');
    const entry = logs.find(l => l.url.includes('/test'));
    assert.ok(entry, 'log entry should exist');
    assert.equal(entry.decision, 'allowed');
  });
});

describe('E2E: agent without policy gets default deny', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    // No policies assigned — agent has no rules
    t = await createFullStack({
      default_behavior: 'deny',
      // No policies option — agent gets no policies
    });
  });

  after(() => t?.cleanup());

  it('request returns 403 (default deny)', async () => {
    const res = await t.proxyRequest('GET', '/test');
    assert.equal(res.status, 403);
  });
});

describe('E2E: assign policy enables access', { timeout: 30000 }, () => {
  let t;

  before(async () => {
    t = await createFullStack({
      default_behavior: 'deny',
    });
  });

  after(() => t?.cleanup());

  it('initially denied', async () => {
    const res = await t.proxyRequest('GET', '/test');
    assert.equal(res.status, 403);
  });

  it('after creating and assigning policy, request is allowed', async () => {
    // Create policy with allow rule
    const { body: policy } = await t.api('POST', '/api/policies', { name: 'AllowAll' });
    await t.api('POST', '/api/rules', {
      name: 'Allow',
      url_pattern: '^http://.*$',
      methods: [],
      action: 'allow',
      priority: 100,
      enabled: true,
      policy_id: policy.id,
    });

    // Assign to agent
    const { body: agents } = await t.api('GET', '/api/agents');
    const agent = agents.find(a => a.name === 'agent1');
    await t.api('POST', `/api/policies/${policy.id}/agents`, { agent_id: agent.id });

    // Wait for IPC sync
    await new Promise(r => setTimeout(r, 1000));

    const res = await t.proxyRequest('GET', '/test');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'TARGET_OK');
  });
});
