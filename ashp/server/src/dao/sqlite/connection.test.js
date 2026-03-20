import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from './connection.js';

describe('SQLite connection factory', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ashp-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates DB, inserts, and reads back', () => {
    const db = createConnection(join(dir, 'test.db'), 'test-key');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, val TEXT)');
    db.prepare('INSERT INTO t(val) VALUES (?)').run('hello');
    const row = db.prepare('SELECT * FROM t WHERE id = 1').get();
    assert.equal(row.val, 'hello');
    db.close();
  });

  it('validates encryption key is provided', () => {
    assert.throws(() => createConnection(join(dir, 'test.db'), ''), {
      message: /encryption key/i,
    });
    assert.throws(() => createConnection(join(dir, 'test.db'), undefined), {
      message: /encryption key/i,
    });
    assert.throws(() => createConnection(join(dir, 'test.db')), {
      message: /encryption key/i,
    });
  });

  it('migrations create all required tables', () => {
    const db = createConnection(join(dir, 'test.db'), 'test-key');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.ok(tables.includes('rules'), 'rules table missing');
    assert.ok(tables.includes('request_log'), 'request_log table missing');
    assert.ok(tables.includes('approval_queue'), 'approval_queue table missing');
    assert.ok(tables.includes('agents'), 'agents table missing');
    db.close();
  });

  it('is idempotent — second open of migrated DB succeeds', () => {
    const db1 = createConnection(join(dir, 'second.db'), 'test-key');
    db1.close();
    const db2 = createConnection(join(dir, 'second.db'), 'test-key');
    const { user_version } = db2.prepare('PRAGMA user_version').get();
    assert.equal(user_version, 2);
    db2.close();
  });

  describe('schema migrations', () => {
    let db;

    beforeEach(() => {
      db = createConnection(join(dir, 'test.db'), 'test-key');
    });

    afterEach(() => {
      db.close();
    });

    it('creates agents table with correct schema', () => {
      const cols = db.prepare("PRAGMA table_info('agents')").all().map(c => c.name);
      assert.ok(cols.includes('id'));
      assert.ok(cols.includes('name'));
      assert.ok(cols.includes('token_hash'));
      assert.ok(cols.includes('enabled'));
      assert.ok(cols.includes('request_count'));
      assert.ok(cols.includes('created_at'));
      assert.ok(cols.includes('description'));
    });

    it('rules table has hit_count columns', () => {
      const cols = db.prepare("PRAGMA table_info('rules')").all().map(c => c.name);
      assert.ok(cols.includes('hit_count'));
      assert.ok(cols.includes('hit_count_today'));
      assert.ok(cols.includes('hit_count_date'));
    });

    it('tracks schema version via user_version', () => {
      const { user_version } = db.prepare('PRAGMA user_version').get();
      assert.equal(user_version, 2);
    });
  });
});
