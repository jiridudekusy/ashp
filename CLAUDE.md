# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ASHP (Agent Sandbox HTTP Proxy) — a MITM proxy that controls, logs, and approves outbound HTTP/HTTPS traffic from AI agents. Three-layer system: Go proxy core, Node.js management server, React GUI.

## Build & Test Commands

All commands run from `ashp/` directory:

```bash
make build              # Build Go proxy + GUI
make dev                # Full stack with hot reload (logs in /tmp/ashp/*.log)
make dev-stop           # Stop dev stack
make test               # All unit tests (proxy + server + gui)
make test-proxy         # Go tests: cd proxy && go test ./...
make test-server        # Node tests: cd server && node --test 'test/**/*.test.js'
make test-gui           # GUI tests: cd gui && npx vitest run
make test-e2e           # E2E tests (builds proxy first): cd server && node --test '../test/e2e/*.test.js'
make bench              # Performance benchmark
make test-docker        # Docker integration tests
```

Single test file: `cd server && node --test test/dao/sqlite/rules.test.js`

Docker prod build: `cd ashp && docker build -t ashp:latest .`

## Architecture

### Startup Sequence
1. Node reads `ashp.json` config (supports `env:VAR_NAME` substitution for secrets)
2. Node initializes SQLite (better-sqlite3, SQLCipher encrypted, WAL mode, migrations via `user_version` pragma)
3. Node creates Unix socket IPC server at `data/ashp.sock`
4. Node spawns Go proxy binary as child process
5. Go connects to socket, loads rules + agents from Node
6. Node starts Express on `:3000` (API + static GUI), Go proxy on `:8080`
7. If `transparent.enabled`, Go also listens on configured transparent ports (`:80`/`:443`); dnsmasq catch-all activated when `ASHP_TRANSPARENT=true`

### IPC Protocol (Unix Socket)
Newline-delimited JSON frames with `msg_id` (UUID) and `ref` for request-response correlation.

- **Node → Go:** `rules.reload` (per-agent rule map), `agents.reload`, `agents.ipmapping` (IP→agent mapping for transparent proxy), `config.update`, `approval.resolve` (ref=ipc_msg_id)
- **Go → Node:** `request.logged`, `request.blocked`, `approval.needed` (msg_id used for correlation)

The approval flow is the critical path: Go holds the HTTP connection open, sends `approval.needed` with a `msg_id`, Node stores it as `ipc_msg_id` in approval_queue, user resolves via GUI, Node sends `approval.resolve` with `ref` matching the original `msg_id`.

### Request Flow (Go Proxy)
1. Authenticate agent via `Proxy-Authorization` Basic header (bcrypt with 60s TTL cache)
2. Reconstruct URL, strip default ports (80/443)
3. Evaluate **per-agent** rules by priority descending (first match wins, regex patterns compiled on load)
4. Action: **deny** → 403, **allow** → forward, **hold** → block waiting for approval
5. Capture bodies per rule config (`full`/`truncate:N`/`none`)
6. Send IPC message with metadata and encrypted body references

### Encrypted Logging
Request/response bodies are AES-256-GCM encrypted (HKDF key derivation per record offset) into hourly files: `logs/YYYY/MM/DD/HH.log.enc`. DB stores `path:offset:length` references. Server decrypts on demand via `/api/logs/:id/request-body`.

### Database Schema (SQLite, currently v3)
- `policies` — name (unique), description, created_at. Hierarchical via `policy_children` (parent_id, child_id). Assigned to agents via `agent_policies` (M:N).
- `rules` — url_pattern (regex), methods (JSON array), action, priority, policy_id (FK to policies), logging config, hit_count
- `request_log` — method, url, headers (JSON), body refs, status, duration, decision, agent_id
- `approval_queue` — request_log_id, ipc_msg_id (correlates to Go msg_id), status, create_rule flag
- `agents` — name (unique), token_hash (bcrypt), enabled, request_count, description

FK constraints: delete agent cascades to approval_queue → request_log (delete approvals first due to FK). Delete policy sets rules.policy_id to NULL.

### Policies (Rule Grouping)
Rules are organized into hierarchical policies (tree structure). Policies are assigned to agents (M:N). Each agent only sees rules from its assigned policies (including sub-policies). Server resolves the policy tree per-agent and sends a flat, priority-sorted rule list via IPC. Cycle detection prevents circular policy hierarchies. A "default" policy is created on migration containing all pre-existing rules.

### GUI
React 19 + React Router 7 + Vite 6, CSS modules. SSE via `/api/events` for real-time updates (EventBus with circular buffer, `Last-Event-ID` reconnection). API client uses Basic auth stored in sessionStorage.

### DAO Layer
Abstract interfaces in `server/src/dao/interfaces.js`, SQLite implementations in `server/src/dao/sqlite/`. Rules source configurable: `db` (editable via API) or `file` (read-only JSON).

## Key Config

`ashp.json` with `env:VAR_NAME` substitution. Required env vars: `ASHP_DB_KEY`, `ASHP_LOG_KEY` (64-char hex), `ASHP_CA_KEY`. Default behavior options: `deny`, `hold`, `queue`.

Transparent proxy config block (optional):
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
Set `ASHP_TRANSPARENT=true` env var to enable dnsmasq catch-all. Agents register their IP via `POST /api/agents/register-ip` (authenticated with agent token).

## Docker

- Production image: `cd ashp && docker build -t ashp:latest .` (multi-stage: Go → GUI → Node alpine)
- Published image name: `jiridudekusy/ashp:latest` (tag local build if not yet pushed)
- `run/` directory: docker-compose with ASHP + sandbox (Claude Code in isolated container proxied through ASHP)
- `sandbox/` directory: standalone Claude Code sandbox container (joins `ashp-sandbox` network, requires ASHP running first)
- Sandbox entrypoint auto-fetches CA cert from `http://ashp:3000/api/ca/certificate`
- No Go installed locally — Go builds happen inside Docker only

## Project Conventions

- **Test location:** Server tests live in `server/test/` mirroring `src/` structure (not colocated with source)
- **E2E tests:** in `test/e2e/` (project root), run via `make test-e2e`
- **GUI tests:** Vitest with jsdom in `gui/src/` (colocated, React convention)
- **Node.js:** ESM (`"type": "module"`), Node 22+, `node --test` runner (no Jest/Mocha)
- **CSS:** CSS modules (`.module.css`), CSS variables for theming
- **API auth:** HTTP Basic Auth for management API, Proxy-Authorization Basic for proxy agents
- **Documentation:** JSDoc for Node/React, Go doc comments for proxy — all source files are documented
- **Unused deps:** `@journeyapps/sqlcipher` was removed — only `better-sqlite3` is used
- **Default credentials:** admin / `change-me-admin-password` (in `ashp.docker.json`)

## Release Workflow

When releasing a new version:

0. **Update README.md** (repo root) — ensure new features, API endpoints, config changes are documented
1. **Check last version:** `git tag --sort=-v:refname | head -5`
2. **Determine version bump:**
   - Bug fixes only → patch (e.g., v0.1.0 → v0.1.1)
   - New features or enhancements → minor (e.g., v0.1.0 → v0.2.0)
3. **Propose version** to the user before proceeding
4. **Create git tag:** `git tag -a vX.Y.Z -m "vX.Y.Z — summary"`
5. **Build Docker:** `cd ashp && docker build -t jiridudekusy/ashp:latest -t jiridudekusy/ashp:vX.Y.Z .`
6. **Push Docker:** `docker push jiridudekusy/ashp:latest && docker push jiridudekusy/ashp:vX.Y.Z`
7. **Push git tag:** `git push origin vX.Y.Z`

## Common Pitfalls

- Deleting an agent requires deleting `approval_queue` entries before `request_log` (FK constraint order)
- `rules.json` in compose was a directory not a file — removed from volume mounts since rules come from DB
- The `--production` flag in `npm ci` is deprecated — use `--omit=dev` instead (Dockerfile still uses old flag but works)
