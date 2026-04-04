import { describe, it, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from '../../../src/dao/sqlite/connection.js';
import { SqliteAgentsDAO } from '../../../src/dao/sqlite/agents.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let db, dao, tempDir;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ashp-test-'));
  db = createConnection(join(tempDir, 'test.db'), 'test-key');
  dao = new SqliteAgentsDAO(db);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true });
});

describe('SqliteAgentsDAO', () => {
  it('create returns agent with plaintext token', async () => {
    const agent = await dao.create({ name: 'test-agent' });
    assert.ok(agent.id);
    assert.equal(agent.name, 'test-agent');
    assert.ok(agent.token); // plaintext token returned only on create
    assert.equal(agent.enabled, true);
    assert.ok(agent.created_at);
  });

  it('list returns agents without tokens', async () => {
    await dao.create({ name: 'agent1' });
    await dao.create({ name: 'agent2' });
    const list = await dao.list();
    assert.equal(list.length, 2);
    assert.ok(!list[0].token);
    assert.ok(!list[0].token_hash);
  });

  it('get returns agent without token', async () => {
    const created = await dao.create({ name: 'agent1' });
    const agent = await dao.get(created.id);
    assert.equal(agent.name, 'agent1');
    assert.ok(!agent.token);
    assert.ok(!agent.token_hash);
  });

  it('get returns null for nonexistent', async () => {
    const agent = await dao.get(999);
    assert.equal(agent, null);
  });

  it('authenticate succeeds with correct token', async () => {
    const created = await dao.create({ name: 'agent1' });
    const agent = await dao.authenticate('agent1', created.token);
    assert.ok(agent);
    assert.equal(agent.name, 'agent1');
  });

  it('authenticate fails with wrong token', async () => {
    await dao.create({ name: 'agent1' });
    const agent = await dao.authenticate('agent1', 'wrong-token');
    assert.equal(agent, null);
  });

  it('authenticate fails for disabled agent', async () => {
    const created = await dao.create({ name: 'agent1' });
    await dao.update(created.id, { enabled: false });
    const agent = await dao.authenticate('agent1', created.token);
    assert.equal(agent, null);
  });

  it('authenticate fails for nonexistent agent', async () => {
    const agent = await dao.authenticate('nope', 'token');
    assert.equal(agent, null);
  });

  it('update changes name and enabled', async () => {
    const created = await dao.create({ name: 'agent1' });
    const updated = await dao.update(created.id, { name: 'renamed', enabled: false });
    assert.equal(updated.name, 'renamed');
    assert.equal(updated.enabled, false);
  });

  it('rotateToken returns new token and invalidates old', async () => {
    const created = await dao.create({ name: 'agent1' });
    const { token: newToken } = await dao.rotateToken(created.id);
    assert.ok(newToken);
    assert.notEqual(newToken, created.token);
    // Old token fails
    const fail = await dao.authenticate('agent1', created.token);
    assert.equal(fail, null);
    // New token works
    const ok = await dao.authenticate('agent1', newToken);
    assert.ok(ok);
  });

  it('rotateToken returns null for nonexistent agent', async () => {
    const result = await dao.rotateToken(999);
    assert.equal(result, null);
  });

  it('delete removes agent and cascades to request_log', async () => {
    const created = await dao.create({ name: 'agent1' });
    // Insert a fake request_log row with this agent_id
    db.prepare("INSERT INTO request_log (method, url, decision, agent_id) VALUES ('GET', 'http://x', 'allowed', 'agent1')").run();
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM request_log WHERE agent_id = 'agent1'").get().c, 1);
    await dao.delete(created.id);
    assert.equal(await dao.get(created.id), null);
    assert.equal(db.prepare("SELECT COUNT(*) as c FROM request_log WHERE agent_id = 'agent1'").get().c, 0);
  });

  it('incrementRequestCount increments counter', async () => {
    await dao.create({ name: 'agent1' });
    await dao.incrementRequestCount('agent1');
    await dao.incrementRequestCount('agent1');
    await dao.incrementRequestCount('agent1');
    const list = await dao.list();
    assert.equal(list[0].request_count, 3);
  });

  it('create rejects duplicate name', async () => {
    await dao.create({ name: 'agent1' });
    await assert.rejects(() => dao.create({ name: 'agent1' }));
  });
});

test('agent has ip_address column after migration', () => {
  const db = createConnection(':memory:', 'test-key');
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'agents'").get();
  assert.ok(row.sql.includes('ip_address'), 'agents table should have ip_address column');
  db.close();
});
