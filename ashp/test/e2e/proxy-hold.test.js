import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestStack } from './setup.js';

describe('E2E: hold & approve flow', () => {
  let t;

  before(async () => {
    t = await createTestStack();
  });
  after(() => t.cleanup());

  it('approval queue starts empty', async () => {
    const { body } = await t.api('GET', '/api/approvals');
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  it('resolve returns 404 for nonexistent approval', async () => {
    const { status } = await t.api('POST', '/api/approvals/999/resolve', {
      action: 'approve', create_rule: false,
    });
    assert.equal(status, 404);
  });

  it('reject with invalid action returns 400', async () => {
    const { status } = await t.api('POST', '/api/approvals/1/resolve', {
      action: 'maybe',
    });
    assert.equal(status, 400);
  });

  it('status endpoint returns proxy info', async () => {
    const { status, body } = await t.api('GET', '/api/status');
    assert.equal(status, 200);
    assert.ok(body.proxy !== undefined);
    assert.ok(body.rules_count !== undefined);
    assert.ok(body.db_path !== undefined);
  });
});
