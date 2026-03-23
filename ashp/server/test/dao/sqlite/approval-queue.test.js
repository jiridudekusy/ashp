import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from '../../../src/dao/sqlite/connection.js';
import { SqliteRequestLogDAO } from '../../../src/dao/sqlite/request-log.js';
import { SqliteApprovalQueueDAO } from '../../../src/dao/sqlite/approval-queue.js';

const sampleLogEntry = () => ({
  method: 'GET',
  url: 'https://api.github.com/repos',
  request_headers: '{}',
  request_body_ref: null,
  response_status: 200,
  response_headers: '{}',
  response_body_ref: null,
  duration_ms: 150,
  rule_id: null,
  decision: 'held',
  agent_id: 'agent1',
});

describe('SqliteApprovalQueueDAO', () => {
  let dir, db, logDao, dao;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ashp-test-'));
    db = createConnection(join(dir, 'test.db'), 'test-key');
    logDao = new SqliteRequestLogDAO(db);
    dao = new SqliteApprovalQueueDAO(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('enqueue creates a pending approval', async () => {
    const logEntry = await logDao.insert(sampleLogEntry());
    const item = await dao.enqueue({
      request_log_id: logEntry.id,
      ipc_msg_id: 'msg-123',
      suggested_pattern: 'https://api.github.com/**',
      suggested_methods: ['GET', 'POST'],
    });

    assert.ok(item.id, 'should have an id');
    assert.equal(item.status, 'pending');
    assert.equal(item.request_log_id, logEntry.id);
    assert.equal(item.ipc_msg_id, 'msg-123');
    assert.equal(item.suggested_pattern, 'https://api.github.com/**');
    assert.ok(item.created_at, 'should have created_at');
  });

  it('listPending returns only pending items', async () => {
    const log1 = await logDao.insert(sampleLogEntry());
    const log2 = await logDao.insert(sampleLogEntry());

    const item1 = await dao.enqueue({ request_log_id: log1.id });
    const item2 = await dao.enqueue({ request_log_id: log2.id });

    // Resolve one
    await dao.resolve(item1.id, { action: 'approve', resolved_by: 'admin' });

    const pending = await dao.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, item2.id);
  });

  it('resolve updates status, resolved_at, resolved_by, create_rule', async () => {
    const logEntry = await logDao.insert(sampleLogEntry());
    const item = await dao.enqueue({ request_log_id: logEntry.id });

    const resolved = await dao.resolve(item.id, {
      action: 'approve',
      resolved_by: 'admin-user',
      create_rule: true,
    });

    assert.equal(resolved.status, 'approved');
    assert.ok(resolved.resolved_at, 'should have resolved_at');
    assert.equal(resolved.resolved_by, 'admin-user');
    assert.equal(resolved.create_rule, 1);
  });

  it('resolve returns null for nonexistent id', async () => {
    const result = await dao.resolve(99999, { action: 'approve', resolved_by: 'admin' });
    assert.equal(result, null);
  });
});
