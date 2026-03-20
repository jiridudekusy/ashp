import Database from 'better-sqlite3';

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

export function createConnection(dbPath, encryptionKey) {
  if (!encryptionKey) {
    throw new Error('Encryption key is required');
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATIONS);

  const { user_version } = db.prepare('PRAGMA user_version').get();

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

  if (user_version < 2) {
    db.transaction(() => {
      db.exec(`ALTER TABLE agents ADD COLUMN description TEXT NOT NULL DEFAULT '';`);
      db.pragma('user_version = 2');
    })();
  }

  return db;
}
