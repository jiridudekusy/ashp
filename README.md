# ASHP — AI Security HTTP Proxy

MITM proxy that sits between AI agents and the internet. Controls which HTTP requests agents can make, with real-time approval flows and encrypted request logging.

**Key features:**
- **Policies** — organize rules into hierarchical groups, assign to agents for per-agent access control
- Rule engine with allow/deny/hold actions and URL pattern matching
- Hold & approve flow — pause requests for human review before forwarding
- Encrypted request/response body logging (AES-256-GCM)
- Agent management with token-based proxy authentication (bcrypt)
- Admin GUI with policy tree, live activity feed, rule management, and request inspector
- SSE real-time events for approvals and request monitoring

## Quick Start

```bash
docker run -d --name ashp \
  -e ASHP_DB_KEY=change-me-db-encryption-key \
  -e ASHP_LOG_KEY=$(openssl rand -hex 32) \
  -e ASHP_CA_KEY=change-me-ca-passphrase \
  -p 3000:3000 \
  -p 8080:8080 \
  -v ashp-data:/data \
  jiridudkusy/ashp
```

- **GUI + API:** http://localhost:3000 (user: `admin`, pass: `change-me-admin-password`)
- **Proxy:** http://localhost:8080 (create agents via GUI, use agent name + token for proxy auth)

Configure your agent's HTTP client to use the proxy:

```bash
export HTTP_PROXY=http://agent1:change-me-agent-token@localhost:8080
export HTTPS_PROXY=http://agent1:change-me-agent-token@localhost:8080
```

To use a custom config, mount it:

```bash
docker run -d --name ashp \
  -e ASHP_DB_KEY=... -e ASHP_LOG_KEY=... -e ASHP_CA_KEY=... \
  -v ./my-config.json:/etc/ashp/ashp.json:ro \
  -v ashp-data:/data \
  -p 3000:3000 -p 8080:8080 \
  jiridudkusy/ashp
```

### Transparent Proxy Mode

ASHP can operate as a transparent proxy where sandbox containers don't need `HTTP_PROXY`/`HTTPS_PROXY` env vars. Traffic is intercepted via DNS — dnsmasq resolves all external domains to ASHP's IP, and ASHP reads TLS SNI to determine the target.

Enable in `ashp.json`:
```json
{
  "transparent": {
    "enabled": true,
    "listen": "0.0.0.0",
    "ports": [
      { "port": 443, "tls": true },
      { "port": 80, "tls": false }
    ]
  }
}
```

Set `ASHP_TRANSPARENT=true` env var on the ASHP container for dnsmasq catch-all.

Sandbox containers register their IP via:
```bash
curl -X POST http://ashp:3000/api/agents/register-ip \
  -H 'Content-Type: application/json' \
  -d '{"name":"agent-name","token":"agent-token","ip_address":"172.18.0.x"}'
```

Both modes (explicit proxy on :8080 and transparent on :80/:443) can run simultaneously.

## Architecture

```
Agent  ──HTTP──▶  Go Proxy (:8080)  ──IPC──▶  Node Server (:3000)  ◀──▶  SQLite DB
                    │                              │                        │
                    │ MITM + rules                 │ API + GUI              │ rules, logs,
                    │ body capture                 │ SSE events             │ approvals
                    ▼                              │
               Target Server                  React GUI (served on :3000)
```

**Go Proxy** — MITM HTTP/HTTPS proxy. Evaluates rules, captures encrypted request/response bodies, communicates decisions via Unix socket IPC.

**Node Server** — Management API (Express). Stores rules, request logs, and approvals in SQLite. Serves GUI static files. Broadcasts real-time events via SSE. Manages proxy lifecycle.

**React GUI** — Admin panel served by the Node server. Dashboard with live activity, rule management, log inspector with syntax-highlighted body viewer, approval queue with hold countdown.

## Configuration

The config file is JSON. All `env:VAR_NAME` values are resolved from environment variables at startup.

```json
{
  "proxy": {
    "listen": "0.0.0.0:8080",
    "auth": {
      "agent1": "change-me-agent-token"
    },
    "hold_timeout": 60
  },
  "management": {
    "listen": "0.0.0.0:3000",
    "auth": { "admin": "env:ASHP_ADMIN_PASSWORD" }
  },
  "rules": {
    "source": "db"
  },
  "default_behavior": "deny",
  "database": {
    "path": "/data/ashp.db",
    "encryption_key": "env:ASHP_DB_KEY"
  },
  "encryption": {
    "log_key": "env:ASHP_LOG_KEY",
    "ca_key": "env:ASHP_CA_KEY"
  },
  "webhooks": []
}
```

| Field | Description |
|-------|-------------|
| `proxy.listen` | Proxy bind address |
| `proxy.auth` | _(deprecated, use Agents API)_ Legacy agent credentials map |
| `proxy.hold_timeout` | Seconds to wait for approval before timing out held requests |
| `management.listen` | API/GUI bind address |
| `management.auth` | Map of `username: password` for Basic auth on management API |
| `rules.source` | `"db"` (SQLite, editable via API) or `"file"` (read-only JSON file) |
| `default_behavior` | Action for unmatched requests: `"deny"`, `"hold"` |
| `database.path` | SQLite database file path |
| `database.encryption_key` | SQLite encryption key (supports `env:VAR`) |
| `encryption.log_key` | 32-byte hex key for body log encryption (supports `env:VAR`) |
| `encryption.ca_key` | Passphrase for CA certificate generation (supports `env:VAR`) |
| `webhooks` | Array of webhook configs for external notifications |

## Rules

Rules control what happens to each proxied request. They are evaluated by priority (highest first).

| Field | Description |
|-------|-------------|
| `url_pattern` | Regex matched against the full URL |
| `methods` | HTTP methods to match (empty = all) |
| `action` | `"allow"` or `"deny"` |
| `priority` | Higher = evaluated first |
| `enabled` | Toggle without deleting |
| `log_request_body` | `"full"`, `"none"`, `"truncate:65536"` |
| `log_response_body` | `"full"`, `"none"`, `"truncate:65536"` |

**Actions:**
- **allow** — forward request to target, log response
- **deny** — block immediately, return 403
When no rule matches, the `default_behavior` config applies (`deny`, `hold`, or `queue`). Hold pauses the request and waits for human approval via GUI/API, timing out after `hold_timeout` seconds.

Rules belong to **policies** (named groups). Policies are assigned to agents — each agent only sees rules from its assigned policies.

**Example:** Allow all OpenAI API calls with full body logging:
```json
{
  "name": "Allow OpenAI",
  "url_pattern": "^https://api\\.openai\\.com/.*$",
  "methods": [],
  "action": "allow",
  "priority": 100,
  "log_request_body": "full",
  "log_response_body": "full"
}
```

## GUI

The admin panel is served at the same port as the API (default `:3000`).

- **Dashboard** — proxy status, rule count, pending approvals, live activity feed
- **Rules & Policies** — sidebar policy tree + rule table, create/edit/move rules between policies, assign policies to agents
- **Logs** — browse request history with filters (method, decision, URL), inspect request/response bodies with syntax highlighting
- **Approvals** — pending approval queue with agent info, matching policy suggestions, approve/reject/approve+create rule/assign policy
- **Agents** — create/manage agents, assign policies, rotate tokens

Supports light/dark/system themes.

## API Reference

All API endpoints (except status and CA cert) require `Authorization: Basic <base64(user:pass)>` header.

### Status
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Proxy status, rule count, uptime |
| `GET` | `/api/ca/certificate` | Download CA certificate (PEM) |

### Rules
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/rules` | List all rules |
| `POST` | `/api/rules` | Create rule |
| `GET` | `/api/rules/:id` | Get rule |
| `PUT` | `/api/rules/:id` | Update rule |
| `DELETE` | `/api/rules/:id` | Delete rule |
| `POST` | `/api/rules/test` | Test URL against rules (`{url, method}`) |

### Policies
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/policies` | List all policies (tree) |
| `POST` | `/api/policies` | Create policy |
| `GET` | `/api/policies/:id` | Get policy detail + children + agents |
| `PUT` | `/api/policies/:id` | Update policy |
| `DELETE` | `/api/policies/:id` | Delete policy |
| `POST` | `/api/policies/:id/children` | Add sub-policy |
| `DELETE` | `/api/policies/:id/children/:childId` | Remove sub-policy |
| `POST` | `/api/policies/:id/agents` | Assign policy to agent |
| `DELETE` | `/api/policies/:id/agents/:agentId` | Unassign from agent |
| `GET` | `/api/policies/match` | Find policies matching URL+method |

### Agents
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents` | List agents |
| `POST` | `/api/agents` | Create agent (returns plaintext token) |
| `GET` | `/api/agents/:id` | Get agent |
| `PUT` | `/api/agents/:id` | Update agent |
| `DELETE` | `/api/agents/:id` | Delete agent |
| `POST` | `/api/agents/:id/rotate-token` | Rotate token |
| `POST` | `/api/agents/register-ip` | Register agent IP for transparent proxy (agent token auth) |

### Logs
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/logs` | Query logs (params: `limit`, `offset`, `method`, `decision`, `url`) |
| `GET` | `/api/logs/:id` | Get log entry |
| `GET` | `/api/logs/:id/request-body` | Download decrypted request body |
| `GET` | `/api/logs/:id/response-body` | Download decrypted response body |

### Approvals
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/approvals` | List pending approvals |
| `POST` | `/api/approvals/:id/resolve` | Resolve approval (`{action: "approve"|"reject"}`) |

### Events (SSE)
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/events` | Server-Sent Events stream |

Event types: `request.allowed`, `request.blocked`, `approval.needed`, `approval.resolved`, `rules.changed`

## Development

### Prerequisites
- Go 1.25+
- Node.js 22+
- SQLCipher development headers

### Setup

```bash
cd ashp/server && npm install
cd ../gui && npm install
cd ../proxy && go mod download
```

### Dev Mode

```bash
cd ashp
make dev          # Start all components (proxy + server + GUI with hot reload)
make dev-stop     # Stop all
make dev-restart  # Restart all
make dev-logs     # Tail logs
```

### Docker Dev Environment

```bash
docker compose -f docker-compose.dev.yml up -d
docker exec -it ashp-dev bash
```

All make targets run from the `ashp/` directory.

### Make Targets

| Target | Description |
|--------|-------------|
| `make install` | Install server + GUI dependencies |
| `make dev` | Start dev stack (proxy + server + GUI) |
| `make test` | Run all unit tests (proxy + server + GUI) |
| `make test-proxy` | Go proxy unit tests |
| `make test-server` | Node server unit tests |
| `make test-gui` | GUI unit tests (Vitest) |
| `make test-e2e` | End-to-end tests (proxy + server + IPC) |
| `make bench` | Performance benchmark |
| `make build` | Build proxy binary + GUI dist |

### Running Tests

```bash
cd ashp
make test        # All unit tests
make test-e2e    # E2E: allow, deny, hold flows
make bench       # Latency overhead benchmark
```

### Benchmark

Measures proxy latency overhead vs direct requests:

```bash
make bench
```

```
Scenario             Reqs   Req/s    p50      p95      p99      Overhead
──────────────────────────────────────────────────────────────────────────
Direct                500    1938     0.4ms    1.3ms    2.1ms    —
Proxy (allow)         500    1067     0.9ms    1.4ms    2.2ms    +0.5ms
Proxy (allow+log)     500     875     1.0ms    1.7ms    2.6ms    +0.7ms
Proxy (deny)          500    1506     0.6ms    1.0ms    1.4ms    +0.3ms
```

## Sandbox Networking

When running sandbox containers on Docker internal networks (no internet access), they can't resolve external DNS. ASHP automatically runs a dnsmasq DNS forwarder bound to its container IP. Sandbox entrypoints dynamically resolve ASHP's IP and configure it as their nameserver — no static IPs needed in compose files.

## Volumes & Persistence

When running in Docker, mount `/data` as a volume:

| Path | Content |
|------|---------|
| `/data/ashp.db` | SQLite database (rules, logs, approvals) |
| `/data/logs/` | Encrypted request/response body files |
| `/data/ca/` | Generated CA certificate and key |

## License

MIT
