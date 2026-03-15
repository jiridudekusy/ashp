# ASHP — Agent Sandbox HTTP Proxy

Design specification for a sandboxing HTTP/HTTPS proxy that controls, logs, and gates outbound traffic from AI agents.

## Problem

When running AI agents (Claude Code, OpenClaw, etc.) in sandboxed environments, there is no standard way to:
- Control which external URLs and HTTP methods the agent can access
- Log all outbound traffic including request bodies
- Interactively approve or deny unknown requests in real time
- Review and audit what happened after the fact

## Architecture

Three-layer architecture, designed to run in a single process (default) or as separate processes:

### Layer 1: Proxy Core (Go)

Built on [goproxy](https://github.com/elazarl/goproxy), a battle-tested MITM proxy library.

**Responsibilities:**
- MITM HTTPS interception — terminates TLS using dynamically generated certificates signed by ASHP's own CA
- HTTP proxy for plain HTTP traffic
- Rule evaluation — regex matching of full URL (domain + path) against cached rules
- Basic Auth for agent identification (`Proxy-Authorization: Basic user:pass`, where user = agent ID, password = token)
- Encrypted body logging — writes request/response bodies to AES-256-GCM encrypted hourly log files
- IPC client — connects to management layer via Unix socket

**Does NOT contain:** REST API, GUI, database access, webhook logic.

The proxy core is a standalone Go binary (`ashp-proxy`) that can theoretically run independently with cached rules.

### Layer 2: Management API (Node.js)

**Responsibilities:**
- REST API for rules, logs, approvals, and system status
- SSE event stream for real-time updates to GUI
- Webhook dispatcher for external notifications
- DAO layer abstracting all data access (swappable implementations)
- IPC server — Unix socket communication with proxy core
- Proxy lifecycle management — spawns and supervises Go child process
- Bearer token authentication for API consumers

### Layer 3: Web GUI (React)

**Responsibilities:**
- Dashboard — real-time traffic overview
- Rule editor — CRUD for proxy rules (read-only in file mode)
- Log viewer — searchable, filterable request/response log with body inspection
- Approval UI — real-time approval queue with SSE notifications
- Login — authenticates via Management API

All GUI communication goes through the REST API + SSE. No direct DB or proxy access.

### Internal Communication

Go and Node communicate via **JSON over Unix socket** (newline-delimited JSON messages).

**Node → Go:**
- `rules.reload` — rules changed, reload from Node
- `config.update` — configuration changed
- `approval.resolve` — user approved/rejected a held request

**Go → Node:**
- `request.logged` — request was processed
- `request.blocked` — request was denied
- `request.held` — request is waiting for approval (Mode B)
- `approval.needed` — approval required, notify user

**Why Unix socket:** No TCP overhead, file-system permission security, no port conflicts, works in both sidecar and gateway deployments.

### Startup Sequence

1. Node process starts, reads `ashp.json` config
2. Node initializes DAO layer (SQLite or JSON file, depending on config)
3. Node creates Unix socket, starts listening
4. Node spawns Go proxy core as child process
5. Go connects to Unix socket, loads rules from Node
6. Go starts accepting proxy connections
7. Node starts REST API and serves GUI

## Request Lifecycle

1. **Agent sends request** — HTTP directly, HTTPS via CONNECT + TLS handshake with ASHP CA
2. **Basic Auth check** — verify agent identity. 407 Proxy Authentication Required if fails.
3. **MITM decrypt** (HTTPS only) — goproxy terminates TLS, full request visible
4. **Rule evaluation** — match URL (regex) + method against rules ordered by priority
   - **Match: allow** → proceed to step 5
   - **Match: deny** → 403 Forbidden, log as blocked
   - **No match** → apply default behavior (configurable: deny / hold / queue)
5. **Log request** — metadata to SQLite, body to encrypted hourly log file
6. **Forward to destination** — proxy opens connection to target, forwards request
7. **Log response** — metadata to SQLite, body per logging config (subject to size limits)
8. **SSE event emitted** — GUI updates in real time

## Request Flow Modes

Configurable globally or per-rule via `on_no_match` override:

### Mode A: Deny & Log
Instant 403. Request logged as blocked. Strict lockdown — use for production.

### Mode B: Hold & Ask
Request held in proxy (configurable timeout, default 60s). SSE notification + webhook sent. User approves/rejects in GUI or via API. On timeout: deny with 504.

Detailed flow:
1. Go: request arrives, no matching rule
2. Go → Node: `{"type":"approval.needed","id":"req_123",...}`
3. Node: inserts into approval_queue, emits SSE event, fires webhook
4. GUI: user sees notification, clicks Approve (optionally "create rule")
5. GUI → API: `POST /api/approvals/req_123/resolve {"action":"approve","create_rule":true}`
6. Node → Go: `{"type":"approval.resolve","id":"req_123","action":"approve"}`
7. Go: releases held request → forwards to destination

### Mode C: Deny & Queue
Instant 403. Request logged and added to approval queue. User reviews later, approves, optionally creates rule. Next identical request passes.

## Data Model

### Storage Architecture

- **Encrypted SQLite (SQLCipher)** — rules, request metadata, approval queue
- **Encrypted files** — request/response bodies in hourly log files
- **Config file** — `ashp.json`, read at startup

### SQLite Tables

#### `rules`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| name | TEXT | Human-readable name |
| url_pattern | TEXT | Regex matching full URL (domain + path) |
| methods | TEXT | JSON array, e.g. `["GET","POST"]` |
| action | TEXT | `allow` or `deny` |
| priority | INTEGER | Higher = evaluated first |
| agent_id | TEXT NULL | Reserved for future per-agent rules |
| log_request_body | TEXT | `full`, `truncate:N`, or `none` |
| log_response_body | TEXT | `full`, `truncate:N`, or `none` |
| on_no_match | TEXT NULL | Per-rule override: `deny`, `hold`, `queue` |
| enabled | BOOLEAN | |

#### `request_log`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| timestamp | DATETIME | |
| method | TEXT | |
| url | TEXT | |
| request_headers | TEXT | JSON |
| request_body_ref | TEXT | `file:offset:length` reference |
| response_status | INTEGER | |
| response_headers | TEXT | JSON |
| response_body_ref | TEXT NULL | `file:offset:length` reference |
| duration_ms | INTEGER | |
| rule_id | INTEGER FK NULL | Which rule matched |
| decision | TEXT | `allowed`, `denied`, `held`, `queued` |
| agent_id | TEXT NULL | Reserved for future |

#### `approval_queue`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| request_log_id | INTEGER FK | |
| status | TEXT | `pending`, `approved`, `rejected` |
| created_at | DATETIME | |
| resolved_at | DATETIME NULL | |
| create_rule | BOOLEAN | Auto-create allow rule on approval |

### File Storage Layout

```
data/
  ashp.db                    ← SQLCipher encrypted database
  ca/
    root.crt                 ← ASHP CA certificate (distribute to agents)
    root.key                 ← CA private key (encrypted)
  logs/
    2026/
      03/
        15/
          14.log.enc         ← all requests from 14:00-14:59
          15.log.enc
          15-001.log.enc     ← chunk if >100MB
```

### Log File Record Format

```
[4 bytes: record length]
[JSON metadata header]
[raw body bytes]
[4 bytes: record length]    ← repeated at end for reverse seeking
```

SQLite `request_body_ref` stores `logs/2026/03/15/14.log.enc:8192:4096` (file path : byte offset : byte length).

### DAO Pattern

All database access goes through DAO interfaces. Implementations are swappable.

**RulesDAO:**
- `list()`, `get(id)`, `create(rule)`, `update(id, rule)`, `delete(id)`, `match(url, method)`
- Implementations: `JsonFileRulesDAO` (read-only from JSON file), `SqliteRulesDAO`

**RequestLogDAO:**
- `insert(entry)`, `query(filters)`, `getById(id)`, `cleanup(olderThan)`
- Implementation: `SqliteRequestLogDAO`

**ApprovalQueueDAO:**
- `enqueue(entry)`, `resolve(id, action)`, `listPending()`
- Implementation: `SqliteApprovalQueueDAO`

### Rules Source

Configurable via `ashp.json`:
- `"source": "file"` — rules loaded from static JSON file, read-only in GUI. Versioned in git.
- `"source": "db"` — rules managed via GUI/API, stored in SQLite.

Not both simultaneously. Same DAO interface regardless of source.

## REST API

All endpoints require `Authorization: Bearer <token>` (configured in `ashp.json`). Returns 401 if missing/invalid.

### Rules

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/rules` | List all. Query: `?enabled=true&search=pattern` |
| GET | `/api/rules/:id` | Get single rule |
| POST | `/api/rules` | Create rule. DB mode only (403 in file mode) |
| PUT | `/api/rules/:id` | Update rule. DB mode only |
| DELETE | `/api/rules/:id` | Delete rule. DB mode only |
| POST | `/api/rules/test` | Test URL+method against current rules |

### Request Logs

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/logs` | List logs. Query: `?from=&to=&method=&url=&decision=&limit=50&offset=0` |
| GET | `/api/logs/:id` | Get log detail |
| GET | `/api/logs/:id/request-body` | Stream decrypted request body |
| GET | `/api/logs/:id/response-body` | Stream decrypted response body |

### Approval Queue

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/approvals` | List queue. Query: `?status=pending` |
| POST | `/api/approvals/:id/resolve` | `{"action":"approve"\|"reject", "create_rule":true\|false}` |

### SSE Events

`GET /api/events` — Server-Sent Events stream.

Events:
- `request.allowed` — request passed through
- `request.blocked` — request denied
- `approval.needed` — waiting for user decision
- `approval.resolved` — decision made
- `rules.changed` — rules were modified

### System

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/status` | Proxy uptime, stats, rule count, DB size |
| GET | `/api/ca/certificate` | Download CA cert for agent trust store |

## Configuration

### ashp.json

```json
{
  "proxy": {
    "listen": "0.0.0.0:8080",
    "auth": {
      "agent1": "token-abc-123"
    }
  },
  "management": {
    "listen": "0.0.0.0:3000",
    "bearer_token": "mgmt-secret-456"
  },
  "rules": {
    "source": "db",
    "file": "rules.json"
  },
  "default_behavior": "deny",
  "logging": {
    "request_body": "full",
    "response_body": "truncate:65536",
    "retention_days": 30
  },
  "database": {
    "path": "data/ashp.db",
    "encryption_key": "env:ASHP_DB_KEY"
  },
  "webhooks": [
    {
      "url": "https://hooks.slack.com/...",
      "events": ["approval.needed"]
    }
  ]
}
```

All settings can be overridden via CLI flags. Config file is read at startup; changes require restart (or SIGHUP for reload).

DB encryption key uses `env:` prefix to reference environment variable — never stored in the config file itself.

### rules.json (static rules file)

```json
{
  "rules": [
    {
      "name": "Allow OpenAI API",
      "url_pattern": "^https://api\\.openai\\.com/v1/.*$",
      "methods": ["POST"],
      "action": "allow",
      "priority": 100,
      "log_request_body": "full",
      "log_response_body": "truncate:65536"
    }
  ]
}
```

## Project Structure

```
ashp/
  proxy/                          ← Go proxy core
    cmd/
      ashp-proxy/                 ← main.go entry point
    internal/
      mitm/                       ← goproxy MITM engine
      rules/                      ← rule cache + evaluator
      auth/                       ← Basic Auth handler
      logger/                     ← encrypted log writer
      ca/                         ← CA cert management
      ipc/                        ← Unix socket client
    go.mod
    go.sum

  server/                         ← Node.js management
    src/
      index.js                    ← entry point, orchestrator
      config.js                   ← JSON config loader
      dao/
        interfaces.js             ← DAO contracts
        sqlite/
          rules.js
          request-log.js
          approval-queue.js
        jsonfile/
          rules.js                ← read-only from JSON
      api/
        rules.js
        logs.js
        approvals.js
        events.js                 ← SSE endpoint
        status.js
      ipc/                        ← Unix socket server
      webhooks/                   ← webhook dispatcher
      crypto/                     ← encryption utils
      proxy-manager.js            ← Go child process management
    package.json

  gui/                            ← React frontend
    src/
      components/
      pages/                      ← Dashboard, Rules, Logs, Approvals
      api/                        ← API client + SSE hook
      App.jsx
    package.json

  ashp.json                       ← config file (example)
  rules.json                      ← static rules (example)
  Dockerfile
  docker-compose.yml
  Makefile                        ← build orchestration
```

## Build & Deployment

### Development
```bash
make dev    # builds Go, starts all with file watch
```

### Production
```bash
make build  # Go binary + React bundle
make docker # single Docker image
```

### Docker
Multi-stage build:
1. Stage 1: Go build → `ashp-proxy` binary
2. Stage 2: Node + React build → bundled static files
3. Stage 3: `node:alpine` + Go binary + React bundle

Final image: ~80-100MB.

### Running
```bash
ashp --config ashp.json
```

Single command starts proxy core, management API, and GUI.

## Error Handling & Resilience

| Failure | Behavior |
|---------|----------|
| Go proxy core crashes | Node detects child exit, restarts automatically. Active connections lost — agents retry. Held requests timeout as denied. |
| Node management crashes | Go proxy continues with cached rules. No new approvals possible. GUI unavailable. Restart via process supervisor. |
| Unix socket disconnects | Both sides reconnect with backoff. Go falls back to cached rules. Events queued in bounded memory buffer. |
| SQLite DB locked/corrupt | WAL mode minimizes locking. On corruption: read-only mode, webhook alert, manual recovery. Proxy continues with cached rules. |
| Log disk full | Proxy continues, logging degrades to metadata-only. Webhook alert. Immediate retention cleanup triggered. |
| Hold timeout (Mode B) | Configurable (default 60s). On expiry: 504 Gateway Timeout. Logged as "timeout". Stays in approval queue for future rule creation. |
| Webhook delivery failure | Retry 3x with exponential backoff. On failure: log and continue. Webhooks never block proxy operation. |

## Security

### Data at Rest
- SQLite encrypted via SQLCipher (AES-256)
- Log files encrypted with AES-256-GCM per chunk
- CA private key encrypted on disk
- DB encryption key via environment variable, never in config file

### Access Control
- Proxy: Basic Auth per agent (`Proxy-Authorization`)
- Management API: Bearer token (`Authorization`)
- Unix socket: file-system permissions (0600)
- GUI: authenticates via Management API, no direct DB or proxy access

## Testing Strategy

### Go (Proxy Core)
**Unit tests:** Rule evaluator (regex matching, priority), auth handler, encrypted log writer (chunking, offsets), CA manager (cert generation).
**Integration tests:** Full proxy flow (HTTP + HTTPS), IPC socket message roundtrip.

### Node (Management)
**Unit tests:** DAO implementations (CRUD, queries, edge cases), config loader (validation, defaults, env refs), crypto utils.
**Integration tests:** REST API (all endpoints, auth, errors), SSE event delivery, approval flow (hold → approve → forward).

### E2E (Full Stack)
Scenarios in Docker Compose with test agent:
- Agent → proxy → allow → log → verify
- Agent → proxy → deny → verify 403
- Agent → proxy → hold → GUI approve → forward
- Rule CRUD via API → proxy behavior changes
- Log retention cleanup

## Future Considerations (out of scope for v1)

- Per-agent rules (`agent_id` column is reserved)
- Named deployment modes/profiles (sidecar vs gateway presets)
- TUI client for terminal-based management
- Mobile app
- Certificate pinning passthrough for specific domains
- Body pattern matching rules (e.g., block requests containing certain patterns)
- Rate limiting per agent/domain
- Metrics export (Prometheus)
