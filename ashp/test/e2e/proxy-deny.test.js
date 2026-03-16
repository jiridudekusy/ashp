import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestStack } from './setup.js';

describe('E2E: proxy deny flow', () => {
  let t;

  before(async () => {
    t = await createTestStack();
  });
  after(() => t.cleanup());

  it('request with no matching rule is denied by default', async () => {
    const { body } = await t.api('POST', '/api/rules/test', {
      url: 'https://evil.com/hack',
      method: 'GET',
    });
    assert.equal(body.decision, 'deny');
    assert.equal(body.match, null);
  });

  it('request matching deny rule is denied', async () => {
    await t.api('POST', '/api/rules', {
      name: 'Block evil.com',
      url_pattern: '^https://evil\\.com/.*$',
      methods: [],
      action: 'deny',
      priority: 100,
      enabled: true,
    });

    const { body } = await t.api('POST', '/api/rules/test', {
      url: 'https://evil.com/hack',
      method: 'POST',
    });
    assert.equal(body.decision, 'deny');
    assert.ok(body.match);
    assert.equal(body.match.action, 'deny');
  });

  it('default behavior is deny when no rules match', async () => {
    const { body } = await t.api('POST', '/api/rules/test', {
      url: 'https://unknown.com/page',
      method: 'GET',
    });
    assert.equal(body.decision, 'deny');
  });
});
