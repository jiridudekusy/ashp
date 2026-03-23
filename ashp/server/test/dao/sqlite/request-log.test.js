import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from '../../../src/dao/sqlite/connection.js';
import { SqliteRequestLogDAO } from '../../../src/dao/sqlite/request-log.js';

const sampleEntry = () => ({
  method: 'GET',
  url: 'https://api.github.com/repos',
  request_headers: '{}',
  request_body_ref: 'logs/2026/03/15/14.log.enc:0:512',
  response_status: 200,
  response_headers: '{}',
  response_body_ref: null,
  duration_ms: 150,
  rule_id: null,
  decision: 'allowed',
  agent_id: 'agent1',
});

describe('SqliteRequestLogDAO', () => {
  let dir, db, dao;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ashp-test-'));
    db = createConnection(join(dir, 'test.db'), 'test-key');
    dao = new SqliteRequestLogDAO(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('insert returns entry with id and timestamp', async () => {
    const result = await dao.insert(sampleEntry());
    assert.ok(result.id, 'should have an id');
    assert.ok(result.timestamp, 'should have a timestamp');
    assert.equal(result.method, 'GET');
    assert.equal(result.url, 'https://api.github.com/repos');
    assert.equal(result.decision, 'allowed');
    assert.equal(result.agent_id, 'agent1');
  });

  it('getById retrieves / returns null for missing', async () => {
    const inserted = await dao.insert(sampleEntry());
    const found = await dao.getById(inserted.id);
    assert.equal(found.id, inserted.id);
    assert.equal(found.method, 'GET');

    const missing = await dao.getById(99999);
    assert.equal(missing, null);
  });

  it('query filters by method', async () => {
    await dao.insert(sampleEntry());
    await dao.insert({ ...sampleEntry(), method: 'POST' });

    const results = await dao.query({ method: 'POST' });
    assert.equal(results.length, 1);
    assert.equal(results[0].method, 'POST');
  });

  it('query filters by decision', async () => {
    await dao.insert(sampleEntry());
    await dao.insert({ ...sampleEntry(), decision: 'denied' });

    const results = await dao.query({ decision: 'denied' });
    assert.equal(results.length, 1);
    assert.equal(results[0].decision, 'denied');
  });

  it('query supports limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await dao.insert(sampleEntry());
    }

    const results = await dao.query({ limit: 2, offset: 1 });
    assert.equal(results.length, 2);
  });

  it('query filters by agent_id', async () => {
    await dao.insert({ method: 'GET', url: 'http://a.com', decision: 'allowed', agent_id: 'agent1' });
    await dao.insert({ method: 'GET', url: 'http://b.com', decision: 'allowed', agent_id: 'agent2' });
    await dao.insert({ method: 'GET', url: 'http://c.com', decision: 'denied', agent_id: 'agent1' });
    const results = await dao.query({ agent_id: 'agent1' });
    assert.equal(results.length, 2);
    results.forEach(r => assert.equal(r.agent_id, 'agent1'));
  });

  it('cleanup deletes entries older than cutoff', async () => {
    await dao.insert(sampleEntry());
    // Insert an entry and manually backdate it
    const old = await dao.insert(sampleEntry());
    db.prepare('UPDATE request_log SET timestamp = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', old.id);

    const deleted = await dao.cleanup('2021-01-01T00:00:00.000Z');
    assert.equal(deleted, 1);

    const remaining = await dao.query({});
    assert.equal(remaining.length, 1);
  });
});
