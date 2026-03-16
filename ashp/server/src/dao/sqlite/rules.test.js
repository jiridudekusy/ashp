import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from './connection.js';
import { SqliteRulesDAO } from './rules.js';

describe('SqliteRulesDAO', () => {
  let dir, db, dao;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ashp-test-'));
    db = createConnection(join(dir, 'test.db'), 'test-key');
    dao = new SqliteRulesDAO(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('create + get round-trip', async () => {
    const rule = await dao.create({
      name: 'test-rule',
      url_pattern: '^https://example\\.com',
      methods: ['GET', 'POST'],
      action: 'allow',
      priority: 10,
    });
    assert.ok(rule.id);
    assert.equal(rule.name, 'test-rule');
    assert.equal(rule.url_pattern, '^https://example\\.com');
    assert.deepEqual(rule.methods, ['GET', 'POST']);
    assert.equal(rule.action, 'allow');
    assert.equal(rule.priority, 10);
    assert.equal(rule.enabled, true);
    assert.equal(rule.log_request_body, 'full');
    assert.equal(rule.log_response_body, 'full');

    const fetched = await dao.get(rule.id);
    assert.deepEqual(fetched, rule);
  });

  it('list returns rules ordered by priority desc', async () => {
    await dao.create({ name: 'low', url_pattern: '.*', action: 'allow', priority: 1 });
    await dao.create({ name: 'high', url_pattern: '.*', action: 'deny', priority: 100 });
    const list = await dao.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'high');
    assert.equal(list[1].name, 'low');
  });

  it('update modifies a rule', async () => {
    const rule = await dao.create({
      name: 'original',
      url_pattern: '.*',
      action: 'allow',
      priority: 5,
    });
    const updated = await dao.update(rule.id, { name: 'changed', action: 'deny' });
    assert.equal(updated.name, 'changed');
    assert.equal(updated.action, 'deny');
    assert.equal(updated.priority, 5); // unchanged
    assert.equal(updated.url_pattern, '.*'); // unchanged
  });

  it('delete removes a rule', async () => {
    const rule = await dao.create({ name: 'doomed', url_pattern: '.*', action: 'deny' });
    await dao.delete(rule.id);
    const result = await dao.get(rule.id);
    assert.equal(result, null);
  });

  it('match finds highest-priority enabled rule', async () => {
    // broad deny at low priority
    await dao.create({
      name: 'broad-deny',
      url_pattern: '.*',
      methods: [],
      action: 'deny',
      priority: 1,
    });
    // specific allow at high priority
    await dao.create({
      name: 'specific-allow',
      url_pattern: '^https://api\\.example\\.com',
      methods: ['GET'],
      action: 'allow',
      priority: 100,
    });
    // disabled deny at highest priority
    await dao.create({
      name: 'disabled-deny',
      url_pattern: '.*',
      methods: [],
      action: 'deny',
      priority: 200,
      enabled: false,
    });

    // Should match specific-allow (highest enabled priority that matches)
    const match1 = await dao.match('https://api.example.com/data', 'GET');
    assert.equal(match1.name, 'specific-allow');

    // POST to api.example.com: specific-allow requires GET, so broad-deny matches
    const match2 = await dao.match('https://api.example.com/data', 'POST');
    assert.equal(match2.name, 'broad-deny');

    // random URL: broad-deny matches
    const match3 = await dao.match('https://other.com', 'GET');
    assert.equal(match3.name, 'broad-deny');
  });

  it('match returns null when no rules match', async () => {
    await dao.create({
      name: 'narrow',
      url_pattern: '^https://only-this\\.com',
      methods: ['DELETE'],
      action: 'allow',
      priority: 1,
    });
    const result = await dao.match('https://other.com', 'GET');
    assert.equal(result, null);
  });
});
