import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonFileRulesDAO } from './rules.js';

describe('JsonFileRulesDAO', () => {
  let dir;
  let filePath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ashp-test-'));
    filePath = join(dir, 'rules.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('list returns rules sorted by priority desc with synthetic ids', async () => {
    writeFileSync(filePath, JSON.stringify({
      rules: [
        { url_pattern: '/low', action: 'allow', priority: 10 },
        { url_pattern: '/high', action: 'deny', priority: 100 },
        { url_pattern: '/mid', action: 'allow', priority: 50 },
      ]
    }));
    const dao = new JsonFileRulesDAO(filePath);
    const rules = await dao.list();
    assert.equal(rules.length, 3);
    // sorted by priority desc
    assert.equal(rules[0].priority, 100);
    assert.equal(rules[1].priority, 50);
    assert.equal(rules[2].priority, 10);
    // synthetic ids
    for (const r of rules) {
      assert.equal(typeof r.id, 'number');
    }
  });

  it('get returns rule by synthetic id', async () => {
    writeFileSync(filePath, JSON.stringify({
      rules: [
        { url_pattern: '/a', action: 'allow', priority: 10 },
        { url_pattern: '/b', action: 'deny', priority: 20 },
      ]
    }));
    const dao = new JsonFileRulesDAO(filePath);
    const rules = await dao.list();
    const found = await dao.get(rules[0].id);
    assert.ok(found);
    assert.equal(found.url_pattern, rules[0].url_pattern);
    const missing = await dao.get(999);
    assert.equal(missing, null);
  });

  it('match finds highest-priority matching rule', async () => {
    writeFileSync(filePath, JSON.stringify({
      rules: [
        { url_pattern: '.*', action: 'deny', priority: 0, methods: [] },
        { url_pattern: '^https://api\\.github\\.com/.*$', action: 'allow', priority: 100, methods: ['GET', 'POST'] },
      ]
    }));
    const dao = new JsonFileRulesDAO(filePath);
    // should match the higher priority rule
    const match = await dao.match('https://api.github.com/repos', 'GET');
    assert.ok(match);
    assert.equal(match.action, 'allow');
    assert.equal(match.priority, 100);
    // method mismatch: GET-only rule shouldn't match DELETE
    const noMethodMatch = await dao.match('https://api.github.com/repos', 'DELETE');
    assert.ok(noMethodMatch);
    // falls through to catch-all
    assert.equal(noMethodMatch.action, 'deny');
    // no match at all if nothing matches
    writeFileSync(filePath, JSON.stringify({
      rules: [
        { url_pattern: '^https://only\\.this$', action: 'allow', priority: 10, methods: ['GET'] },
      ]
    }));
    const dao2 = new JsonFileRulesDAO(filePath);
    const none = await dao2.match('https://other.url', 'GET');
    assert.equal(none, null);
  });

  it('write operations throw read-only error', async () => {
    writeFileSync(filePath, JSON.stringify({ rules: [] }));
    const dao = new JsonFileRulesDAO(filePath);
    await assert.rejects(() => dao.create({}), /read-only/i);
    await assert.rejects(() => dao.update(1, {}), /read-only/i);
    await assert.rejects(() => dao.delete(1), /read-only/i);
  });

  it('reload() picks up file changes', async () => {
    writeFileSync(filePath, JSON.stringify({
      rules: [{ url_pattern: '/a', action: 'allow', priority: 10 }]
    }));
    const dao = new JsonFileRulesDAO(filePath);
    let rules = await dao.list();
    assert.equal(rules.length, 1);

    writeFileSync(filePath, JSON.stringify({
      rules: [
        { url_pattern: '/a', action: 'allow', priority: 10 },
        { url_pattern: '/b', action: 'deny', priority: 20 },
      ]
    }));
    dao.reload();
    rules = await dao.list();
    assert.equal(rules.length, 2);
  });
});
