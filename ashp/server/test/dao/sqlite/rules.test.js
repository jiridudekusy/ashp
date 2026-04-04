import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from '../../../src/dao/sqlite/connection.js';
import { SqliteRulesDAO } from '../../../src/dao/sqlite/rules.js';

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

  describe('policy_id support', () => {
    it('create with policy_id stores and returns it', async () => {
      const policies = db.prepare('SELECT * FROM policies').all();
      const defaultPolicy = policies.find(p => p.name === 'default');
      const rule = await dao.create({
        name: 'test', url_pattern: '.*', action: 'allow', policy_id: defaultPolicy.id,
      });
      assert.equal(rule.policy_id, defaultPolicy.id);
    });

    it('list with policy_id filter returns only matching rules', async () => {
      const policies = db.prepare('SELECT * FROM policies').all();
      const defaultPolicy = policies.find(p => p.name === 'default');
      await dao.create({ name: 'A', url_pattern: 'a.*', action: 'allow', policy_id: defaultPolicy.id });
      await dao.create({ name: 'B', url_pattern: 'b.*', action: 'allow', policy_id: null });
      const filtered = await dao.list({ policy_id: defaultPolicy.id });
      assert.ok(filtered.every(r => r.policy_id === defaultPolicy.id));
    });

    it('moveToPolicy changes policy_id', async () => {
      const policies = db.prepare('SELECT * FROM policies').all();
      const defaultPolicy = policies.find(p => p.name === 'default');
      const info = db.prepare("INSERT INTO policies (name) VALUES ('other')").run();
      const rule = await dao.create({ name: 'R', url_pattern: '.*', action: 'allow', policy_id: defaultPolicy.id });
      const moved = await dao.moveToPolicy(rule.id, info.lastInsertRowid);
      assert.equal(moved.policy_id, info.lastInsertRowid);
    });
  });

  describe('match with policyId', () => {
    it('scopes match to specific policy', async () => {
      const info1 = db.prepare("INSERT INTO policies (name) VALUES ('pol-a')").run();
      const info2 = db.prepare("INSERT INTO policies (name) VALUES ('pol-b')").run();
      await dao.create({ name: 'allow-a', url_pattern: '.*example\\.com.*', action: 'allow', priority: 10, policy_id: info1.lastInsertRowid });
      await dao.create({ name: 'deny-b', url_pattern: '.*example\\.com.*', action: 'deny', priority: 10, policy_id: info2.lastInsertRowid });

      const matchA = await dao.match('https://example.com', 'GET', info1.lastInsertRowid);
      assert.equal(matchA.name, 'allow-a');

      const matchB = await dao.match('https://example.com', 'GET', info2.lastInsertRowid);
      assert.equal(matchB.name, 'deny-b');
    });

    it('match without policyId returns first across all policies', async () => {
      const info1 = db.prepare("INSERT INTO policies (name) VALUES ('pol-x')").run();
      await dao.create({ name: 'rule-x', url_pattern: '.*example\\.com.*', action: 'allow', priority: 50, policy_id: info1.lastInsertRowid });

      const match = await dao.match('https://example.com', 'GET');
      assert.equal(match.name, 'rule-x');
    });
  });

  describe('match with wildcard method', () => {
    it('* method matches any HTTP method', async () => {
      await dao.create({ name: 'wildcard-rule', url_pattern: '.*', methods: ['*'], action: 'allow', priority: 10 });

      const matchGet = await dao.match('https://example.com', 'GET');
      assert.equal(matchGet.name, 'wildcard-rule');

      const matchPost = await dao.match('https://example.com', 'POST');
      assert.equal(matchPost.name, 'wildcard-rule');

      const matchDelete = await dao.match('https://example.com', 'DELETE');
      assert.equal(matchDelete.name, 'wildcard-rule');
    });
  });

  describe('hit count', () => {
    it('incrementHitCount increments total and today', async () => {
      const rule = await dao.create({ name: 'r1', url_pattern: '^http://x', methods: [], action: 'allow' });
      await dao.incrementHitCount(rule.id);
      await dao.incrementHitCount(rule.id);
      const updated = await dao.get(rule.id);
      assert.equal(updated.hit_count, 2);
      assert.equal(updated.hit_count_today, 2);
      assert.ok(updated.hit_count_date); // should be today's date
    });

    it('list includes hit_count fields', async () => {
      await dao.create({ name: 'r1', url_pattern: '^http://x', methods: [], action: 'allow' });
      const list = await dao.list();
      assert.equal(list[0].hit_count, 0);
      assert.equal(list[0].hit_count_today, 0);
    });
  });
});
