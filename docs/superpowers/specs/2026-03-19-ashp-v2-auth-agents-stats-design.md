# ASHP v2: Auth, Agent Management & Statistics

**Date:** 2026-03-19
**Status:** Draft
**Scope:** Management API auth change, agent CRUD, rule/agent statistics

## Overview

Four improvements to ASHP:

1. Replace Bearer token auth on management API with Basic Auth
2. Move agents from config to database with full CRUD
3. Add hit count statistics to rules
4. Add request count statistics to agents

## 1. Management API — Basic Auth

### Config Change

Replace `bearer_token` with `auth` object (same format as proxy auth was):

```json
{
  "management": {
    "listen": "0.0.0.0:3000",
    "auth": { "admin": "change-me-admin-password" }
  }
}
```

Single admin account defined in config. One username-password pair.

### Middleware

Replace `bearerAuth()` with `basicAuth()` in `server/src/api/middleware.js`:

- Parses `Authorization: Basic base64(user:pass)` header
- Returns 401 with `WWW-Authenticate: Basic realm="ASHP"` if missing or invalid
- No query parameter fallbacks — Basic Auth header everywhere

### SSE Auth

The GUI currently uses `EventSource` with `?token=` query param for SSE. This changes to `fetch` + `ReadableStream` with Basic Auth header. EventSource API is not used because it cannot send custom headers. The GUI client already wraps SSE — only the transport layer changes.

### Removed

- `management.bearer_token` config key — removed
- `?token=` query parameter auth — removed

## 2. Agents in Database

### Motivation

Agents are currently hardcoded in `proxy.auth` config as `{"name": "token"}`. Moving to DB enables runtime CRUD via API/GUI, soft-delete, and statistics tracking.

No config seed mechanism. After fresh start, first agent is created via management API/GUI. This works because management API is accessible directly (not through proxy).

### Schema

New table `agents`:

```sql
CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  request_count INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
```

- `name` — agent identifier, used as Basic Auth username for proxy
- `token_hash` — bcrypt hash of the token. Plaintext is never stored.
- `enabled` — soft-delete flag. Disabled agents cannot authenticate.
- `request_count` — incremental counter, updated on each proxied request

### Token Security

- Token is generated server-side on creation
- Plaintext token is returned **only once** in the `POST /api/agents` response
- All subsequent reads (`GET /api/agents`, `GET /api/agents/:id`) never include the token
- If the token is lost, user generates a new one via `POST /api/agents/:id/rotate-token`
- Old token immediately stops working
- Proxy receives `token_hash` via IPC — authentication uses `bcrypt.compare()`

### DAO

`AgentsDAO` interface added to `server/src/dao/interfaces.js`:

```javascript
class AgentsDAO {
  async list()                    // → [{id, name, enabled, request_count, created_at}]
  async get(id)                   // → {id, name, enabled, request_count, created_at} | null
  async create({name})            // → {id, name, token, enabled, created_at} (token only here)
  async update(id, {name, enabled}) // → agent | null
  async delete(id)                // → void (cascade deletes request_log entries)
  async rotateToken(id)           // → {token} (new plaintext, only here)
  async authenticate(name, token) // → agent | null (compares bcrypt hash)
  async incrementRequestCount(name) // → void
}
```

### SQLite Implementation

`SqliteAgentsDAO` in `server/src/dao/sqlite/agents.js`:

- `create()` — generates random token, bcrypt hashes it, inserts row, returns plaintext token once
- `delete()` — deletes agent AND associated `request_log` rows. Note: `request_log.agent_id` stores the agent's string name (not integer FK), so cascade is: `DELETE FROM request_log WHERE agent_id = (SELECT name FROM agents WHERE id = ?)` then `DELETE FROM agents WHERE id = ?`
- `authenticate()` — finds by name, checks enabled, bcrypt compares token
- `incrementRequestCount()` — `UPDATE agents SET request_count = request_count + 1 WHERE name = ?`

### REST API

All endpoints require management Basic Auth.

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/agents | List all agents (no tokens) |
| GET | /api/agents/:id | Get agent detail (no token) |
| POST | /api/agents | Create agent. Body: `{name}`. Returns `{id, name, token, enabled}` |
| PUT | /api/agents/:id | Update agent. Body: `{name?, enabled?}` |
| DELETE | /api/agents/:id | Hard delete agent + cascade request_log entries |
| POST | /api/agents/:id/rotate-token | Generate new token. Returns `{token}` |

### IPC Protocol

New message type `agents.reload`:

- **Direction:** Node → Go
- **When:** On agent create/update/delete/rotate-token, and on proxy connect
- **Payload:** `{type: "agents.reload", data: [{name, token_hash, enabled}]}`

Go proxy replaces its in-memory agent map with the received list.

### Config Change

`proxy.auth` is removed from config:

```json
{
  "proxy": {
    "listen": "0.0.0.0:8080",
    "bin_path": "/app/proxy/ashp-proxy",
    "hold_timeout": 60
  }
}
```

The `--auth` CLI flag for the Go proxy is replaced by `--agents-from-ipc` (or simply removed since IPC is the only source now).

### Proxy Auth Flow

1. Go proxy starts, connects to IPC
2. Node sends `agents.reload` with current agent list
3. On HTTP/CONNECT request, proxy extracts Basic Auth credentials
4. Proxy looks up agent by name in memory, checks enabled, verifies token against bcrypt hash. To avoid ~100ms bcrypt cost on every request, Go proxy maintains an in-memory auth cache: `sha256(name+token)` → `bool`, with short TTL (e.g., 60s). Cache hit skips bcrypt. Cache miss runs bcrypt and stores result. Cache is cleared on `agents.reload`.
5. If invalid → 407 Proxy Authentication Required
6. If valid → `agent_id` set in context, request proceeds

## 3. Rule Statistics

### Schema Change

Three new columns on `rules` table:

```sql
ALTER TABLE rules ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rules ADD COLUMN hit_count_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rules ADD COLUMN hit_count_date TEXT;
```

- `hit_count` — lifetime total matches
- `hit_count_today` — matches today (lazy reset)
- `hit_count_date` — date (YYYY-MM-DD) of last reset, used to detect day change

### Increment Logic

In `SqliteRulesDAO`, new method `incrementHitCount(ruleId)`:

```sql
UPDATE rules SET
  hit_count = hit_count + 1,
  hit_count_today = CASE
    WHEN hit_count_date = date('now') THEN hit_count_today + 1
    ELSE 1
  END,
  hit_count_date = date('now')
WHERE id = ?;
```

Single atomic UPDATE. No cron job. Lazy reset: on the first hit of a new day, `hit_count_today` resets to 1.

If a rule has no hits on a given day, `hit_count_today` retains yesterday's value — visible in context of `hit_count_date`.

### Trigger

When Node processes IPC messages (`request.logged`, `request.blocked`), if `msg.data.rule_id` is present, call `rulesDAO.incrementHitCount(msg.data.rule_id)`.

### API

No new endpoints. `GET /api/rules` and `GET /api/rules/:id` responses now include `hit_count`, `hit_count_today`, and `hit_count_date` fields.

## 4. Agent Statistics

### Counter

`request_count` column on `agents` table (defined in section 2).

Incremented in Node when processing IPC messages (`request.logged`, `request.blocked`, `approval.needed`) — call `agentsDAO.incrementRequestCount(msg.data.agent_id)`.

### Detail View

For agent activity detail, use `GET /api/logs?agent_id=<name>`. The `request_log` table already stores `agent_id` on every entry, but the logs API and DAO currently lack an `agent_id` filter — this must be added:

- `SqliteRequestLogDAO.query()` — add `agent_id` to supported filter parameters
- `GET /api/logs` — accept `agent_id` query parameter

### API

`GET /api/agents` and `GET /api/agents/:id` include `request_count` in the response.

## Migration Strategy

### Database Migration

On startup, check if `agents` table exists. If not, run:

1. `CREATE TABLE agents (...)`
2. `ALTER TABLE rules ADD COLUMN hit_count ...`
3. `ALTER TABLE rules ADD COLUMN hit_count_today ...`
4. `ALTER TABLE rules ADD COLUMN hit_count_date ...`

Use `PRAGMA user_version` to track schema version. Current schema (no versioning) is version 0. After v2 migration: version 1. The existing `CREATE TABLE IF NOT EXISTS` pattern in `connection.js` remains for initial setup; versioned migrations run after.

### Config Migration

- `management.bearer_token` → `management.auth` (breaking change)
- `proxy.auth` → removed (agents in DB)
- Both are breaking changes. Document in changelog.

### Go Proxy Changes

- Remove `--auth` flag and static agent map
- Add agent list from IPC (`agents.reload` message)
- Auth validation: bcrypt compare instead of string equality
- Add `bcrypt` dependency to Go proxy

## Summary of Changes by Component

### Node.js (server/)
- `middleware.js` — new `basicAuth()`, remove `bearerAuth()`
- `dao/interfaces.js` — add `AgentsDAO`
- `dao/sqlite/agents.js` — new `SqliteAgentsDAO`
- `dao/sqlite/rules.js` — add `incrementHitCount()`
- `dao/sqlite/request-log.js` — add `agent_id` filter to `query()`
- `api/logs.js` — accept `agent_id` query parameter
- `dao/sqlite/connection.js` — schema migration for agents table + rules columns
- `api/agents.js` — new routes
- `api/events.js` — SSE via fetch/ReadableStream with Basic Auth (GUI side)
- `index.js` — wire AgentsDAO, send agents.reload on IPC connect, increment counters in IPC handler
- `config.js` — `management.auth` replaces `bearer_token`, remove `proxy.auth`

### Go (proxy/)
- `internal/auth/basic.go` — bcrypt compare, agent list from IPC instead of config
- `cmd/ashp-proxy/main.go` — remove `--auth` flag
- `go.mod` — add `golang.org/x/crypto` for bcrypt

### React (gui/)
- Agent management page (list, create, enable/disable, delete, rotate token)
- Rules list shows hit_count / hit_count_today with hit_count_date (to contextualize stale today counts)
- Agent list shows request_count
- SSE client uses fetch+ReadableStream instead of EventSource
- Login uses Basic Auth instead of Bearer token
