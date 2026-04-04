/**
 * @module dao/sqlite/connection
 * @description SQLite database initialization with WAL mode, foreign keys, and schema migrations.
 *
 * The database schema is applied in two phases:
 * 1. Base DDL (MIGRATIONS constant): creates `rules`, `request_log`, `approval_queue` tables and indexes.
 * 2. Versioned migrations keyed by `PRAGMA user_version`:
 *    - v0 -> v1: adds `agents` table; adds `hit_count`, `hit_count_today`, `hit_count_date` to `rules`.
 *    - v1 -> v2: adds `description` column to `agents`.
 *    - v2 -> v3: adds `policies`, `policy_children`, `agent_policies` tables; adds `policy_id` FK to `rules`; creates default policy.
 *
 * Each versioned migration runs inside a transaction and bumps `user_version` atomically.
 */
import Database from 'better-sqlite3';

/** Base DDL applied on every connection (uses CREATE IF NOT EXISTS for idempotency). */
const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, url_pattern TEXT NOT NULL,
    methods TEXT NOT NULL DEFAULT '[]',
    action TEXT NOT NULL CHECK(action IN ('allow','deny')),
    priority INTEGER NOT NULL DEFAULT 0, agent_id TEXT,
    log_request_body TEXT NOT NULL DEFAULT 'full',
    log_response_body TEXT NOT NULL DEFAULT 'full',
    default_behavior TEXT CHECK(default_behavior IN ('deny','hold','queue') OR default_behavior IS NULL),
    enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL DEFAULT(datetime('now')),
    method TEXT NOT NULL, url TEXT NOT NULL,
    request_headers TEXT, request_body_ref TEXT,
    response_status INTEGER, response_headers TEXT, response_body_ref TEXT,
    duration_ms INTEGER,
    rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
    decision TEXT NOT NULL CHECK(decision IN ('allowed','denied','held','queued')),
    agent_id TEXT
);
CREATE TABLE IF NOT EXISTS approval_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_log_id INTEGER NOT NULL REFERENCES request_log(id),
    ipc_msg_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at DATETIME NOT NULL DEFAULT(datetime('now')),
    resolved_at DATETIME, resolved_by TEXT,
    create_rule INTEGER NOT NULL DEFAULT 0,
    suggested_pattern TEXT, suggested_methods TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_log_timestamp ON request_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_request_log_decision ON request_log(decision);
CREATE INDEX IF NOT EXISTS idx_approval_queue_status ON approval_queue(status);
`;

/**
 * Opens (or creates) a SQLite database, enables WAL mode and foreign keys,
 * applies the base schema, and runs any pending versioned migrations.
 *
 * @param {string} dbPath - Absolute path to the SQLite database file.
 * @param {string} encryptionKey - Required encryption key (reserved for future SQLCipher support;
 *   currently used as a guard to ensure config includes a key).
 * @returns {import('better-sqlite3').Database} The initialized database connection.
 * @throws {Error} If `encryptionKey` is not provided.
 */
export function createConnection(dbPath, encryptionKey) {
  if (!encryptionKey) {
    throw new Error('Encryption key is required');
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATIONS);

  const { user_version } = db.prepare('PRAGMA user_version').get();

  // Migration v0 -> v1: agents table, rule hit counters
  if (user_version < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          token_hash TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          request_count INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
        );

        ALTER TABLE rules ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE rules ADD COLUMN hit_count_today INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE rules ADD COLUMN hit_count_date TEXT;
      `);
      db.pragma('user_version = 1');
    })();
  }

  // Migration v1 -> v2: agent description field
  if (user_version < 2) {
    db.transaction(() => {
      db.exec(`ALTER TABLE agents ADD COLUMN description TEXT NOT NULL DEFAULT '';`);
      db.pragma('user_version = 2');
    })();
  }

  // Migration v2 -> v3: policies (hierarchical rule grouping)
  if (user_version < 3) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE policies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          description TEXT DEFAULT '',
          created_at DATETIME NOT NULL DEFAULT(datetime('now'))
        );

        CREATE TABLE policy_children (
          parent_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
          child_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
          PRIMARY KEY (parent_id, child_id),
          CHECK (parent_id != child_id)
        );

        CREATE TABLE agent_policies (
          agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          policy_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
          PRIMARY KEY (agent_id, policy_id)
        );

        ALTER TABLE rules ADD COLUMN policy_id INTEGER REFERENCES policies(id) ON DELETE SET NULL;
      `);

      // Create default policy and assign all existing rules to it
      const info = db.prepare("INSERT INTO policies (name, description) VALUES ('default', 'Default policy for all rules')").run();
      db.prepare('UPDATE rules SET policy_id = ?').run(info.lastInsertRowid);

      db.pragma('user_version = 3');
    })();
  }

  // Migration v3 -> v4: ip_address on agents (transparent proxy mode); mode on request_log
  if (user_version < 4) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE agents ADD COLUMN ip_address TEXT DEFAULT NULL;
        ALTER TABLE request_log ADD COLUMN mode TEXT DEFAULT 'proxy';
      `);
      db.pragma('user_version = 4');
    })();
  }

  return db;
}
