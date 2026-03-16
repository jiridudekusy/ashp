import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestStack } from './setup.js';

describe('E2E: rule CRUD via API', () => {
  let t, ruleId;

  before(async () => { t = await createTestStack(); });
  after(() => t.cleanup());

  it('creates a rule', async () => {
    const { status, body } = await t.api('POST', '/api/rules', {
      name: 'Allow GitHub',
      url_pattern: '^https://api\\.github\\.com/.*$',
      methods: ['GET', 'POST'],
      action: 'allow',
      priority: 100,
      enabled: true,
    });
    assert.equal(status, 201);
    assert.ok(body.id);
    ruleId = body.id;
  });

  it('reads the rule back', async () => {
    const { status, body } = await t.api('GET', `/api/rules/${ruleId}`);
    assert.equal(status, 200);
    assert.equal(body.name, 'Allow GitHub');
    assert.deepEqual(body.methods, ['GET', 'POST']);
  });

  it('updates the rule', async () => {
    const { status, body } = await t.api('PUT', `/api/rules/${ruleId}`, {
      name: 'Allow GitHub v2',
      priority: 200,
    });
    assert.equal(status, 200);
    assert.equal(body.name, 'Allow GitHub v2');
    assert.equal(body.priority, 200);
  });

  it('test endpoint matches updated rule', async () => {
    const { body } = await t.api('POST', '/api/rules/test', {
      url: 'https://api.github.com/repos/foo/bar',
      method: 'GET',
    });
    assert.equal(body.decision, 'allow');
    assert.equal(body.match.id, ruleId);
  });

  it('deletes the rule', async () => {
    const { status } = await t.api('DELETE', `/api/rules/${ruleId}`);
    assert.equal(status, 204);
  });

  it('deleted rule returns 404', async () => {
    const { status } = await t.api('GET', `/api/rules/${ruleId}`);
    assert.equal(status, 404);
  });

  it('test endpoint falls back to default_behavior after delete', async () => {
    const { body } = await t.api('POST', '/api/rules/test', {
      url: 'https://api.github.com/repos/foo/bar',
      method: 'GET',
    });
    assert.equal(body.decision, 'deny');
    assert.equal(body.match, null);
  });
});
