# ASHP Transparent Proxy Mode — Design Spec

## Context

ASHP currently operates as an explicit forward proxy — sandbox containers must set `HTTP_PROXY`/`HTTPS_PROXY` environment variables to route traffic through it. This means every container is aware of the proxy's existence, which limits deployability and can be bypassed by applications that ignore proxy env vars.

This spec adds a **transparent proxy mode** where sandbox containers route traffic through ASHP without any proxy configuration. Containers believe they're talking directly to the target server. Both modes coexist — explicit proxy on `:8080` remains unchanged.

## Approach: DNS Catch-All

ASHP already runs dnsmasq as a DNS forwarder for sandbox containers. In transparent mode, dnsmasq is configured to resolve **all external domains** to ASHP's own container IP. When a sandbox container connects to `api.openai.com:443`, it actually connects to ASHP:443. ASHP reads the TLS SNI to determine the intended target, performs MITM, evaluates rules, and forwards to the real server (resolved via Docker DNS `127.0.0.11`, bypassing its own dnsmasq).

**Why not iptables?** No `NET_ADMIN` capability needed on any container. An agent with `NET_ADMIN` could remove iptables rules and bypass the proxy. DNS catch-all requires zero elevated privileges.

**Limitation:** Only intercepts traffic on ports where ASHP listens. Connections to hardcoded IP addresses (not hostnames) bypass the proxy. Both are acceptable for the AI agent sandbox use case.

## 1. Configuration

New `transparent` section in `ashp.json`:

```json
{
  "proxy": {
    "listen": "0.0.0.0:8080"
  },
  "transparent": {
    "enabled": false,
    "listen": "0.0.0.0",
    "ports": [
      { "port": 443, "tls": true },
      { "port": 80, "tls": false }
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `transparent.enabled` | Enable transparent proxy mode (default: `false`) |
| `transparent.listen` | Bind address for transparent listeners |
| `transparent.ports` | List of ports to listen on, each with `port` (number) and `tls` (boolean) |

Custom ports (e.g. `{ "port": 8443, "tls": true }`) can be added for non-standard HTTPS services.

Node server reads this config and passes it to the Go proxy as CLI flags when spawning the binary (consistent with how `--listen`, `--default-behavior`, etc. are passed today). Format: `--transparent-ports 443:tls,80,8443:tls` (comma-separated, `:tls` suffix for TLS ports).

## 2. DNS — dnsmasq Catch-All

**File:** `ashp/entrypoint.sh`

When `ASHP_TRANSPARENT=true` (set as environment variable in docker-compose.yml — the entrypoint runs before Node starts, so this cannot come from config):

1. Determine ASHP container IP: `hostname -i | grep -v '127.0.0'`
2. Add catch-all: `--address=/#/${ASHP_IP}` — all DNS queries return ASHP's IP
3. Auto-detect Docker-internal hostnames from `/etc/hosts` (Docker populates this with container names and network aliases)
4. Add exceptions for each: `--server=/${hostname}/127.0.0.11` — these resolve via Docker DNS to their real IPs

```sh
if [ "$ASHP_TRANSPARENT" = "true" ]; then
  ASHP_IP=$(hostname -i 2>/dev/null | tr ' ' '\n' | grep -v '127.0.0' | head -1)
  DNSMASQ_EXTRA="--address=/#/${ASHP_IP}"

  # Auto-detect Docker container names from /etc/hosts
  for host in $(grep -v '127.0.0' /etc/hosts | awk '{for(i=2;i<=NF;i++) print $i}' | sort -u); do
    DNSMASQ_EXTRA="$DNSMASQ_EXTRA --server=/${host}/127.0.0.11"
  done
fi
```

**DNS loop prevention:** The Go proxy resolves upstream hostnames via a custom `net.Resolver` pointing at Docker DNS (`127.0.0.11:53`), never through dnsmasq. This is critical — without it, upstream resolution would loop back to ASHP.

## 3. Go Proxy — Transparent Listeners

**New file:** `proxy/internal/mitm/transparent.go`

### 3.1 HTTPS Listener (TLS ports)

For each TLS port in config:

1. `net.Listen("tcp", addr)` — accept raw TCP connections
2. Per connection (goroutine):
   a. Peek at first bytes via `bufio.Reader` — parse TLS ClientHello record to extract SNI hostname (~60 lines, well-established technique: read 5-byte record header, then full handshake, find SNI extension type `0x0000`)
   b. `ca.SignHost(hostname)` — generate MITM cert signed by ASHP root CA
   c. `tls.Server(conn, &tls.Config{Certificates: [cert]})` — complete TLS handshake
   d. Read HTTP request from decrypted stream
   e. `auth.AuthenticateByIP(conn.RemoteAddr())` — identify agent
   f. Reconstruct URL: `https://hostname + request.RequestURI`
   g. Call shared `handleRequest()` logic (rule eval, body capture, IPC)
   h. Forward to real server or return deny response

### 3.2 HTTP Listener (plain ports)

For each non-TLS port:

1. Standard `http.Server` on the port
2. Per request:
   a. Read `Host` header → target hostname
   b. `auth.AuthenticateByIP(req.RemoteAddr)` → agent
   c. Reconstruct URL: `http://host + request.RequestURI`
   d. Call shared `handleRequest()` logic

### 3.3 Shared Request Handling (refactor)

Extract from current goproxy `OnRequest` handler into a standalone function:

```go
func (p *Proxy) handleRequest(ctx RequestContext) (*http.Response, error)
```

Where `RequestContext` contains: `agentID`, `fullURL`, `method`, `*http.Request`, `mode` ("proxy" | "transparent").

Both the goproxy handler and transparent listeners call this function. Contains: rule matching, deny/allow/hold/queue logic, body capture, IPC reporting.

### 3.4 Upstream DNS Resolver

```go
var upstreamResolver = &net.Resolver{
    PreferGo: true,
    Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
        return net.Dial("udp", "127.0.0.11:53")
    },
}
```

Used by `http.Transport.DialContext` for all transparent-mode upstream connections. Ensures real DNS resolution bypassing dnsmasq catch-all.

## 4. Agent IP Mapping

### 4.1 Database

**Migration v3 → v4:**

```sql
ALTER TABLE agents ADD COLUMN ip_address TEXT DEFAULT NULL;
```

### 4.2 API Endpoint

**`POST /api/agents/register-ip`** — no Basic Auth (management API auth), authenticates via agent credentials:

```json
// Request
{ "name": "agent-name", "token": "agent-token", "ip_address": "172.18.0.3" }

// Response 200
{ "ok": true }

// Response 401
{ "error": "Invalid agent credentials" }
```

Flow: verify agent name+token (bcrypt) → store IP in DB → send IPC `agents.ipmapping` to Go proxy.

### 4.3 IPC Message

New message type `agents.ipmapping` (Node → Go):

```json
{ "type": "agents.ipmapping", "data": { "172.18.0.3": "agent-name", "172.18.0.4": "other-agent" } }
```

Sent on: proxy startup, IP registration, agent mutation (update/delete).

### 4.4 Go Auth Handler

New fields and methods on `auth.Handler`:

- `ipMap map[string]string` — IP → agent name, protected by `sync.RWMutex`
- `ReloadIPMap(mapping map[string]string)` — atomic replace
- `AuthenticateByIP(remoteAddr string) (string, bool)` — strip port, lookup in map

### 4.5 Sandbox Entrypoint

New step in `run/entrypoint-sandbox.sh` and `sandbox/entrypoint.sh` (after CA cert install):

```sh
MY_IP=$(hostname -i 2>/dev/null | tr ' ' '\n' | grep -v '127.0.0' | head -1)
if [ -n "$MY_IP" ] && [ -n "$ASHP_AGENT_NAME" ] && [ -n "$ASHP_AGENT_TOKEN" ]; then
  curl -sf --noproxy '*' -X POST http://ashp:3000/api/agents/register-ip \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$ASHP_AGENT_NAME\",\"token\":\"$ASHP_AGENT_TOKEN\",\"ip_address\":\"$MY_IP\"}" \
    && echo "Registered IP $MY_IP for agent $ASHP_AGENT_NAME"
fi
```

Only runs if `ASHP_AGENT_NAME` and `ASHP_AGENT_TOKEN` env vars are set (transparent mode containers).

## 5. GUI Changes

### Agent Detail Page

- Display `IP Address` field (read-only) showing the registered IP
- "Clear IP" button to remove stale registrations

### Dashboard / Status

- Indicator showing transparent mode is active (when `transparent.enabled: true`)
- List of transparent listener ports

### Request Log

- New `mode` field on request log entries: `"proxy"` or `"transparent"`
- Filterable in the log table

### No Changes

- Rules and policies — work identically for both modes
- Approvals — same flow regardless of mode

## 6. Docker Compose

### `run/docker-compose.yml`

Two sandbox containers demonstrating both modes:

**sandbox-proxy** — classic explicit proxy mode:
```yaml
sandbox-proxy:
  build: ...
  environment:
    - HTTP_PROXY=http://agent-proxy:<token>@ashp:8080
    - HTTPS_PROXY=http://agent-proxy:<token>@ashp:8080
    - NO_PROXY=ashp,localhost,127.0.0.1
    - NODE_EXTRA_CA_CERTS=/home/dev/ashp-ca.crt
  networks:
    - ashp-sandbox
```

**sandbox-transparent** — transparent mode (no proxy env vars):
```yaml
sandbox-transparent:
  build: ...
  environment:
    - ASHP_AGENT_NAME=agent-transparent
    - ASHP_AGENT_TOKEN=<token>
    - NODE_EXTRA_CA_CERTS=/home/dev/ashp-ca.crt
  networks:
    - ashp-sandbox
```

**ASHP service additions:**
```yaml
ashp:
  environment:
    - ASHP_TRANSPARENT=true
  # Config adds transparent section
```

**Dockerfile:** Add `EXPOSE 80 443` alongside existing `EXPOSE 8080 3000 53`.

## 7. Unknown IP Handling

When a request arrives on a transparent listener from an IP not registered to any agent:

- No agent assigned → default behavior applies (deny/hold/queue per config)
- Request is logged without `agent_id`
- Visible in GUI request log as agent "unknown"

## 8. Backward Compatibility

- Explicit proxy on `:8080` is completely unchanged
- `transparent.enabled` defaults to `false` — no impact on existing deployments
- Containers with `HTTP_PROXY`/`HTTPS_PROXY` continue using explicit proxy
- Both modes can run simultaneously on the same ASHP instance
- Same rules, policies, and approval flows apply to both modes

## 9. Testing

### Unit Tests (Go)

- `transparent_test.go` — SNI extraction from mock ClientHello bytes
- `auth/basic_test.go` — `AuthenticateByIP`, `ReloadIPMap`
- Transparent HTTP handler — Host header → correct URL reconstruction

### Unit Tests (Node)

- `test/api/agents.test.js` — `register-ip` endpoint (valid agent, invalid token, missing fields)
- `test/dao/sqlite/agents.test.js` — `ip_address` column, query by IP

### E2E Tests (local, no Docker)

Extend existing `test/e2e/` suite — start ASHP (proxy + server) locally with transparent mode enabled:

- Transparent HTTPS: connect to transparent TLS port, send request with SNI → verify MITM, rule eval, logged with `mode: "transparent"`
- Transparent HTTP: connect to transparent plain port, send request with Host header → verify forwarding and logging
- IP auth: register IP via API, make request from that IP → verify correct agent assigned
- Unknown IP: request from unregistered IP → verify default behavior (deny/hold/queue)

### Docker Integration Tests

Full Docker compose stack tests (`test/docker/`) — spin up the `run/docker-compose.yml` stack and verify both modes work:

1. **Build and start stack:** `docker compose -f run/docker-compose.yml up -d`
2. **Wait for readiness:** poll ASHP `/api/status` until healthy
3. **Test sandbox-proxy (explicit mode):**
   - `docker exec sandbox-proxy curl -x http://agent:token@ashp:8080 https://httpbin.org/get`
   - Verify request logged with `mode: "proxy"` via ASHP API
4. **Test sandbox-transparent (transparent mode):**
   - `docker exec sandbox-transparent curl https://httpbin.org/get` (no proxy env vars)
   - Verify request logged with `mode: "transparent"` and correct agent via ASHP API
5. **Test IP registration:**
   - Verify agent has `ip_address` set via `GET /api/agents/:id`
6. **Test unknown IP:**
   - Make request from ASHP container itself (not a registered agent IP) to transparent port
   - Verify default behavior applied
7. **Teardown:** `docker compose -f run/docker-compose.yml down`

These tests require Docker and are run separately from `make test-e2e` (e.g., `make test-docker`).

## 10. Files to Modify

| File | Change |
|------|--------|
| `proxy/internal/mitm/transparent.go` | **New** — transparent HTTPS/HTTP listeners, SNI parser |
| `proxy/internal/mitm/proxy.go` | Refactor shared request handling into reusable function |
| `proxy/internal/auth/basic.go` | Add IP mapping: `ipMap`, `ReloadIPMap`, `AuthenticateByIP` |
| `proxy/cmd/ashp-proxy/main.go` | New CLI flags, IPC handler for `agents.ipmapping` |
| `server/src/dao/sqlite/connection.js` | Migration v4: `ip_address` column |
| `server/src/dao/sqlite/agents.js` | `registerIp()`, `findByIp()`, include `ip_address` in queries |
| `server/src/dao/interfaces.js` | Add `registerIp`, `findByIp` to abstract interface |
| `server/src/api/agents.js` | `POST /api/agents/register-ip` endpoint |
| `server/src/index.js` | Pass transparent config to proxy, send `agents.ipmapping` IPC |
| `server/src/config.js` | `transparent` config defaults and CLI mapping |
| `ashp/entrypoint.sh` | dnsmasq catch-all with auto-detected exceptions |
| `run/entrypoint-sandbox.sh` | IP registration step |
| `sandbox/entrypoint.sh` | IP registration step |
| `run/docker-compose.yml` | Two sandbox containers (proxy + transparent), ASHP transparent env |
| `ashp/Dockerfile` | `EXPOSE 80 443` |
| `test/docker/` | **New** — Docker integration test scripts for both proxy modes |
| `ashp/Makefile` | Add `test-docker` target |
| GUI components | Agent detail (IP field), dashboard (transparent indicator), log table (mode column) |
