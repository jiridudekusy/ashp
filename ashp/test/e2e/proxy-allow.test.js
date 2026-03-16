import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestStack } from './setup.js';

describe('E2E: proxy allow flow', () => {
  let t;

  before(async () => {
    t = await createTestStack();

    // Create allow rule
    await t.api('POST', '/api/rules', {
      name: 'Allow test target',
      url_pattern: '^http://127\\.0\\.0\\.1.*$',
      methods: ['GET'],
      action: 'allow',
      priority: 100,
      enabled: true,
    });
  });

  after(() => t.cleanup());

  it('rule test endpoint confirms allow', async () => {
    const { body } = await t.api('POST', '/api/rules/test', {
      url: 'http://127.0.0.1:9999/test',
      method: 'GET',
    });
    assert.equal(body.decision, 'allow');
    assert.ok(body.match);
    assert.equal(body.match.action, 'allow');
  });

  it('rule list includes the created rule', async () => {
    const { body: rules } = await t.api('GET', '/api/rules');
    assert.ok(rules.length >= 1);
    assert.equal(rules[0].name, 'Allow test target');
  });
});
