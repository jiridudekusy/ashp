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

Every message includes a `msg_id` field (UUID). Request-response pairs are correlated via `msg_id` — a response references the original `msg_id` in a `ref` field.

**Node → Go:**
- `rules.reload` — rules changed, reload from Node
- `config.update` — configuration changed
- `approval.resolve` — user approved/rejected a held request (includes `ref` to original `approval.needed` msg_id)

**Go → Node:**
- `request.logged` — request was processed
- `request.blocked` — request was denied
- `approval.needed` — request is held (Mode B) or queued (Mode C), approval required. Includes request metadata for display in GUI.

**Reconnection behavior:** On socket disconnect, both sides attempt reconnect with exponential backoff (100ms, 200ms, 400ms, ..., max 10s). During disconnection:
- Go continues serving with cached rules; held requests awaiting approval timeout after their configured timeout period
- Go buffers events in a bounded ring buffer (default 10,000 messages); oldest messages dropped if buffer full
- On reconnect, Go re-announces any still-held requests via fresh `approval.needed` messages
- Node sends `rules.reload` on reconnect to ensure Go's cache is current

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

Configurable globally via `default_behavior` in config. Rules can override this for requests matching their `url_pattern` but not their `methods` list (via the `default_behavior` column on the rule):

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
Instant 403. Request logged and added to approval queue. User reviews later, approves, optionally creates allow rule. When a rule is created from approval, subsequent requests matching that rule pass automatically. "Identical" is defined by rule match — same URL pattern + method combination.

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
| default_behavior | TEXT NULL | Override global default_behavior for requests matching this rule's url_pattern but NOT its methods list |
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
| agent_id | TEXT NULL | Populated from Basic Auth username. Reserved for future rule evaluation. |

#### `approval_queue`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| request_log_id | INTEGER FK | |
| status | TEXT | `pending`, `approved`, `rejected` |
| created_at | DATETIME | |
| resolved_at | DATETIME NULL | |
| resolved_by | TEXT NULL | Who approved/rejected (for audit) |
| create_rule | BOOLEAN | Auto-create allow rule on approval |
| suggested_pattern | TEXT NULL | Auto-generated url_pattern for the rule (derived from request URL) |
| suggested_methods | TEXT NULL | JSON array of methods for the auto-created rule |

### File Storage Layout

```
data/
  ashp.db                    ← SQLCipher encrypted database
  ca/
    root.crt                 ← ASHP CA certificate (distribute to agents)
    root.key                 ← CA private key (encrypted with ASHP_CA_KEY)
  logs/
    2026/
      03/
        15/
          14.log.enc         ← all requests from 14:00-14:59
          15.log.enc
          15-001.log.enc     ← chunk if >100MB
```

### Log File Encryption

Log files use **per-record encryption** with AES-256-GCM. Each record is independently encrypted and decryptable, enabling random-access reads by offset without decrypting the entire file.

Encryption key: derived from a master log encryption key via HKDF, using the record offset as context. The master key is configured via `env:ASHP_LOG_KEY` environment variable (separate from DB encryption key).

### Log File Record Format

Each record in the hourly log file:

```
[4 bytes: encrypted record length (plaintext)]
[12 bytes: GCM nonce]
[encrypted payload: JSON metadata header + body bytes]
[16 bytes: GCM auth tag]
[4 bytes: encrypted record length (plaintext)]    ← repeated for reverse seeking
```

The 4-byte length prefix and suffix are plaintext (not sensitive — just byte counts) to allow seeking without decryption. The payload (metadata + body) is encrypted.

SQLite `request_body_ref` stores `logs/2026/03/15/14.log.enc:8192:4096` (file path : byte offset : total record length). To read a specific body, seek to offset, read length bytes, decrypt the payload.

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
| GET | `/api/logs` | List logs. Query: `?from=&to=&method=&url=&decision=&limit=50&offset=0`. Dates in ISO 8601 format. |
| GET | `/api/logs/:id` | Get log detail |
| GET | `/api/logs/:id/request-body` | Stream decrypted request body |
| GET | `/api/logs/:id/response-body` | Stream decrypted response body |

### Approval Queue

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/approvals` | List queue. Query: `?status=pending` |
| POST | `/api/approvals/:id/resolve` | `{"action":"approve"\|"reject", "create_rule":true\|false}` |

### SSE Events

`GET /api/events` — Server-Sent Events stream. Supports `Last-Event-ID` header for reconnection — on reconnect, the server replays missed events from a bounded in-memory buffer (default 1,000 events).

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
  "encryption": {
    "log_key": "env:ASHP_LOG_KEY",
    "ca_key": "env:ASHP_CA_KEY"
  },
  "webhooks": [
    {
      "url": "https://hooks.slack.com/...",
      "events": ["approval.needed"],
      "secret": "env:ASHP_WEBHOOK_SECRET",
      "timeout_ms": 5000,
      "retries": 3
    }
  ]
}
```

All settings can be overridden via CLI flags. Config file is read at startup. SIGHUP is sent to the Node process, which reloads config and forwards relevant changes to Go proxy core via `config.update` IPC message. Hot-reloadable settings: rules source, logging config, webhooks, default_behavior. Settings requiring restart: listen addresses, auth tokens, database path, encryption keys.

Encryption keys use `env:` prefix to reference environment variables — never stored in the config file itself. Three separate keys:
- `ASHP_DB_KEY` — SQLCipher database encryption
- `ASHP_LOG_KEY` — log file record encryption (AES-256-GCM)
- `ASHP_CA_KEY` — CA private key encryption

On first run, if no CA exists, ASHP generates a new root CA certificate and encrypts the private key with `ASHP_CA_KEY`.

Webhook delivery includes HMAC-SHA256 signature in `X-ASHP-Signature` header (using the webhook's `secret`). Payload format is JSON matching the SSE event structure. Delivery timeout and retry count are configurable per webhook.

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
- SQLite encrypted via SQLCipher (AES-256), key from `ASHP_DB_KEY` env var
- Log files encrypted with AES-256-GCM per record, key derived from `ASHP_LOG_KEY` env var
- CA private key encrypted on disk with `ASHP_CA_KEY` env var
- No encryption keys stored in config files

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
