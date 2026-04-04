# Transparent Proxy Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DNS-based transparent proxy mode so sandbox containers route traffic through ASHP without needing `HTTP_PROXY`/`HTTPS_PROXY` env vars.

**Architecture:** dnsmasq resolves all external domains to ASHP's IP. ASHP listens on configurable ports (80, 443, custom), reads TLS SNI or Host header to determine target, performs MITM and rule evaluation using the same engine as the explicit proxy. Agent identification via source IP mapping. Both modes coexist — explicit proxy on :8080 is unchanged.

**Tech Stack:** Go (net, crypto/tls, bufio), Node.js (Express, better-sqlite3), React, Docker, dnsmasq

**Spec:** `docs/superpowers/specs/2026-04-04-transparent-proxy-design.md`

---

## File Structure

| File | Role |
|------|------|
| `proxy/internal/mitm/transparent.go` | **New** — transparent HTTPS/HTTP listeners, SNI parser, upstream resolver |
| `proxy/internal/mitm/transparent_test.go` | **New** — SNI extraction tests, transparent handler tests |
| `proxy/internal/mitm/proxy.go` | Refactor: extract shared `handleRequest()` from goproxy handler |
| `proxy/internal/auth/basic.go` | Add IP mapping: `ipMap`, `ReloadIPMap()`, `AuthenticateByIP()` |
| `proxy/internal/auth/basic_test.go` | **New or extend** — IP auth tests |
| `proxy/cmd/ashp-proxy/main.go` | New CLI flags, IPC handler for `agents.ipmapping` |
| `server/src/dao/sqlite/connection.js` | Migration v4: `ip_address` column |
| `server/src/dao/sqlite/agents.js` | `registerIp()`, include `ip_address` in queries |
| `server/src/dao/interfaces.js` | Add `registerIp()` to abstract class |
| `server/src/api/agents.js` | `POST /api/agents/register-ip` endpoint |
| `server/src/config.js` | `transparent` config defaults |
| `server/src/index.js` | Pass transparent config to proxy, send `agents.ipmapping` IPC |
| `ashp/entrypoint.sh` | dnsmasq catch-all with auto-detected exceptions |
| `run/entrypoint-sandbox.sh` | IP registration step |
| `sandbox/entrypoint.sh` | IP registration step |
| `run/docker-compose.yml` | Two sandbox containers, transparent env |
| `ashp/Dockerfile` | `EXPOSE 80 443` |
| GUI components | Agent detail (IP field), dashboard (transparent status), log table (mode column) |
| `test/docker/` | **New** — Docker integration test scripts |
| `ashp/Makefile` | Add `test-docker` target |

---

## Task 1: Database Migration — Add `ip_address` Column

**Files:**
- Modify: `server/src/dao/sqlite/connection.js` (after line 139)
- Test: `server/test/dao/sqlite/agents.test.js`

- [ ] **Step 1: Write failing test for ip_address column**

In `server/test/dao/sqlite/agents.test.js`, add a test that verifies the `ip_address` column exists and can be set:

```javascript
test('agent has ip_address column after migration', () => {
  const db = createConnection(':memory:', 'test-key');
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'agents'").get();
  assert.ok(row.sql.includes('ip_address'), 'agents table should have ip_address column');
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ashp/server && node --test test/dao/sqlite/agents.test.js`
Expected: FAIL — `ip_address` column does not exist in agents table

- [ ] **Step 3: Add v4 migration**

In `server/src/dao/sqlite/connection.js`, after the v3 migration block (after line 139), add:

```javascript
  if (user_version < 4) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE agents ADD COLUMN ip_address TEXT DEFAULT NULL;
        ALTER TABLE request_log ADD COLUMN mode TEXT DEFAULT 'proxy';
      `);
      db.pragma('user_version = 4');
    })();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ashp/server && node --test test/dao/sqlite/agents.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/dao/sqlite/connection.js server/test/dao/sqlite/agents.test.js
git commit -m "feat: add ip_address column to agents table (migration v4)"
```

---

## Task 2: Agents DAO — Add `registerIp()` and Include `ip_address`

**Files:**
- Modify: `server/src/dao/sqlite/agents.js`
- Modify: `server/src/dao/interfaces.js` (line ~175)
- Test: `server/test/dao/sqlite/agents.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
test('registerIp stores IP address for agent', async () => {
  const agent = await agentsDAO.create({ name: 'ip-test-agent' });
  await agentsDAO.registerIp(agent.id, '172.18.0.5');
  const fetched = await agentsDAO.get(agent.id);
  assert.strictEqual(fetched.ip_address, '172.18.0.5');
});

test('registerIp clears IP when null', async () => {
  const agent = await agentsDAO.create({ name: 'ip-clear-agent' });
  await agentsDAO.registerIp(agent.id, '172.18.0.5');
  await agentsDAO.registerIp(agent.id, null);
  const fetched = await agentsDAO.get(agent.id);
  assert.strictEqual(fetched.ip_address, null);
});

test('listForProxy includes ip_address', () => {
  const agents = agentsDAO.listForProxy();
  for (const a of agents) {
    assert.ok('ip_address' in a, 'listForProxy should include ip_address');
  }
});

test('getIPMapping returns IP-to-name map', () => {
  // Assuming agents with IPs were created above
  const mapping = agentsDAO.getIPMapping();
  assert.strictEqual(typeof mapping, 'object');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ashp/server && node --test test/dao/sqlite/agents.test.js`
Expected: FAIL — `registerIp` is not a function

- [ ] **Step 3: Add `registerIp()` to interface**

In `server/src/dao/interfaces.js`, inside the `AgentsDAO` class, add:

```javascript
  /** @param {number} id @param {string|null} ip @returns {Promise<void>} */
  async registerIp(id, ip) { throw new Error('Not implemented'); }

  /** @returns {Object<string, string>} IP address → agent name mapping (synchronous) */
  getIPMapping() { throw new Error('Not implemented'); }
```

- [ ] **Step 4: Implement in SQLite DAO**

In `server/src/dao/sqlite/agents.js`:

Add prepared statement alongside existing ones (~line 72):
```javascript
const updateIp = db.prepare('UPDATE agents SET ip_address = ? WHERE id = ?');
const ipMapping = db.prepare("SELECT ip_address, name FROM agents WHERE ip_address IS NOT NULL AND enabled = 1");
```

Add `ip_address` to the `listForProxy` query (~line 74):
```javascript
const listForProxy = db.prepare('SELECT name, token_hash, enabled, ip_address FROM agents');
```

Add `ip_address` to deserialization (~line 37-47) so `get()` and `list()` include it:
```javascript
ip_address: row.ip_address || null,
```

Add methods:
```javascript
  async registerIp(id, ip) {
    updateIp.run(ip, id);
  }

  getIPMapping() {
    const rows = ipMapping.all();
    const mapping = {};
    for (const row of rows) {
      mapping[row.ip_address] = row.name;
    }
    return mapping;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ashp/server && node --test test/dao/sqlite/agents.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/dao/sqlite/agents.js server/src/dao/interfaces.js server/test/dao/sqlite/agents.test.js
git commit -m "feat: add registerIp() and getIPMapping() to agents DAO"
```

---

## Task 3: API Endpoint — `POST /api/agents/register-ip`

**Files:**
- Modify: `server/src/api/agents.js`
- Test: `server/test/api/agents.test.js`

- [ ] **Step 1: Write failing test**

```javascript
test('POST /api/agents/register-ip registers IP with valid credentials', async (t) => {
  // Create agent first (via authenticated API)
  const createRes = await fetch(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    body: JSON.stringify({ name: 'ip-reg-agent' }),
  });
  const created = await createRes.json();

  // Register IP (no management auth — uses agent credentials)
  const res = await fetch(`${BASE_URL}/api/agents/register-ip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'ip-reg-agent',
      token: created.token,
      ip_address: '172.18.0.10',
    }),
  });
  assert.strictEqual(res.status, 200);

  // Verify IP was stored
  const getRes = await fetch(`${BASE_URL}/api/agents/${created.id}`, {
    headers: { 'Authorization': authHeader },
  });
  const agent = await getRes.json();
  assert.strictEqual(agent.ip_address, '172.18.0.10');
});

test('POST /api/agents/register-ip rejects invalid token', async () => {
  const res = await fetch(`${BASE_URL}/api/agents/register-ip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'ip-reg-agent',
      token: 'wrong-token',
      ip_address: '172.18.0.10',
    }),
  });
  assert.strictEqual(res.status, 401);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ashp/server && node --test test/api/agents.test.js`
Expected: FAIL — 404 on register-ip endpoint

- [ ] **Step 3: Implement the endpoint**

In `server/src/api/agents.js`, add **before** the auth-protected routes (this endpoint uses agent token auth, not management Basic Auth):

```javascript
  // IP registration for transparent proxy — authenticates via agent token, not management auth
  router.post('/agents/register-ip', async (req, res, next) => {
    try {
      const { name, token, ip_address } = req.body;
      if (!name || !token || !ip_address) {
        return res.status(400).json({ error: 'name, token, and ip_address required' });
      }
      const agent = await agentsDAO.authenticate(name, token);
      if (!agent) {
        return res.status(401).json({ error: 'Invalid agent credentials' });
      }
      await agentsDAO.registerIp(agent.id, ip_address);
      sendIPMappingReload();
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
```

Add the IPC helper:
```javascript
  function sendIPMappingReload() {
    const mapping = agentsDAO.getIPMapping();
    ipc.send({ type: 'agents.ipmapping', data: mapping });
  }
```

**Important:** This route must be mounted on the Express app **before** the `basicAuth` middleware is applied at `/api`. Add it in `server/src/index.js` as a separate route that bypasses Basic Auth:

```javascript
// Before app.use('/api', basicAuth(...)):
app.post('/api/agents/register-ip', agentsRegisterIpRoute);
```

Alternatively, add it directly in `index.js` before the middleware, or create a small handler function.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ashp/server && node --test test/api/agents.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/api/agents.js server/src/index.js server/test/api/agents.test.js
git commit -m "feat: add POST /api/agents/register-ip endpoint for transparent proxy"
```

---

## Task 4: Node Config — Add `transparent` Defaults

**Files:**
- Modify: `server/src/config.js`

- [ ] **Step 1: Add transparent defaults to DEFAULTS object**

In `server/src/config.js`, add to the DEFAULTS object (~line 17):

```javascript
const DEFAULTS = {
  proxy: { listen: '0.0.0.0:8080' },
  transparent: {
    enabled: false,
    listen: '0.0.0.0',
    ports: [
      { port: 443, tls: true },
      { port: 80, tls: false },
    ],
  },
  management: { listen: '0.0.0.0:3000', auth: {} },
  // ... rest unchanged
};
```

- [ ] **Step 2: Commit**

```bash
git add server/src/config.js
git commit -m "feat: add transparent proxy config defaults"
```

---

## Task 5: Node Server — Pass Transparent Config to Proxy + Send IP Mapping

**Files:**
- Modify: `server/src/index.js` (~lines 145-161 proxy args, ~lines 104-142 IPC handlers)

- [ ] **Step 1: Add transparent proxy args to proxy spawning**

In `server/src/index.js`, after the existing proxy args construction (~line 155), add:

```javascript
if (config.transparent?.enabled) {
  const portSpec = config.transparent.ports
    .map(p => p.tls ? `${p.port}:tls` : String(p.port))
    .join(',');
  proxyArgs.push('--transparent-listen', config.transparent.listen || '0.0.0.0');
  proxyArgs.push('--transparent-ports', portSpec);
}
```

- [ ] **Step 2: Send IP mapping on IPC connect**

In the `onConnect` handler (~line 106), after the existing `agents.reload` send, add:

```javascript
const ipMapping = agentsDAO.getIPMapping();
ipc.send({ type: 'agents.ipmapping', data: ipMapping });
```

- [ ] **Step 3: Also send IP mapping after agent mutations**

In the `sendAgentsReload()` function in `server/src/api/agents.js` (~line 32), add after agents.reload:

```javascript
async function sendAgentsReload() {
  const agents = agentsDAO.listForProxy();
  ipc.send({ type: 'agents.reload', data: agents });
  const mapping = agentsDAO.getIPMapping();
  ipc.send({ type: 'agents.ipmapping', data: mapping });
}
```

- [ ] **Step 4: Set ASHP_TRANSPARENT env var for entrypoint**

In `server/src/index.js`, before proxy spawning, if transparent is enabled set the env var so the entrypoint's dnsmasq can read it:

```javascript
if (config.transparent?.enabled) {
  process.env.ASHP_TRANSPARENT = 'true';
}
```

Note: In Docker, the env var is set in docker-compose.yml instead. This is for dev mode only.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.js server/src/api/agents.js
git commit -m "feat: wire transparent proxy config to Go proxy and IPC"
```

---

## Task 6: Go Auth — Add IP-Based Authentication

**Files:**
- Modify: `proxy/internal/auth/basic.go`
- Test: `proxy/internal/auth/basic_test.go`

- [ ] **Step 1: Write failing tests**

Create or extend `proxy/internal/auth/basic_test.go`:

```go
package auth

import (
	"testing"
)

func TestAuthenticateByIP_Found(t *testing.T) {
	h := NewHandler()
	h.ReloadIPMap(map[string]string{
		"172.18.0.3": "agent-one",
		"172.18.0.4": "agent-two",
	})

	name, ok := h.AuthenticateByIP("172.18.0.3:54321")
	if !ok {
		t.Fatal("expected authentication to succeed")
	}
	if name != "agent-one" {
		t.Fatalf("expected agent-one, got %s", name)
	}
}

func TestAuthenticateByIP_NotFound(t *testing.T) {
	h := NewHandler()
	h.ReloadIPMap(map[string]string{
		"172.18.0.3": "agent-one",
	})

	_, ok := h.AuthenticateByIP("172.18.0.99:12345")
	if ok {
		t.Fatal("expected authentication to fail for unknown IP")
	}
}

func TestAuthenticateByIP_EmptyMap(t *testing.T) {
	h := NewHandler()
	_, ok := h.AuthenticateByIP("172.18.0.3:12345")
	if ok {
		t.Fatal("expected authentication to fail with empty map")
	}
}

func TestReloadIPMap_Replaces(t *testing.T) {
	h := NewHandler()
	h.ReloadIPMap(map[string]string{"1.2.3.4": "old"})
	h.ReloadIPMap(map[string]string{"5.6.7.8": "new"})

	_, ok := h.AuthenticateByIP("1.2.3.4:1234")
	if ok {
		t.Fatal("old mapping should be gone after reload")
	}
	name, ok := h.AuthenticateByIP("5.6.7.8:1234")
	if !ok || name != "new" {
		t.Fatal("new mapping should be active")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ashp/proxy && go test ./internal/auth/ -v -run TestAuthenticateByIP`
Expected: FAIL — `ReloadIPMap` and `AuthenticateByIP` not defined

- [ ] **Step 3: Implement IP mapping on Handler**

In `proxy/internal/auth/basic.go`, add a new field to the Handler struct (~line 43):

```go
type Handler struct {
	mu     sync.RWMutex
	agents map[string]Agent
	cache  map[string]cacheEntry
	ttl    time.Duration
	ipMap  map[string]string // IP address → agent name
}
```

Initialize in `NewHandler()`:
```go
func NewHandler() *Handler {
	return &Handler{
		agents: make(map[string]Agent),
		cache:  make(map[string]cacheEntry),
		ttl:    60 * time.Second,
		ipMap:  make(map[string]string),
	}
}
```

Add methods:
```go
// ReloadIPMap atomically replaces the IP-to-agent mapping used by
// transparent proxy mode for source-IP-based authentication.
func (h *Handler) ReloadIPMap(mapping map[string]string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ipMap = mapping
}

// AuthenticateByIP looks up the agent name associated with the given
// remote address (ip:port format). Returns the agent name and true if
// found, or empty string and false otherwise.
func (h *Handler) AuthenticateByIP(remoteAddr string) (string, bool) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	name, ok := h.ipMap[host]
	return name, ok
}
```

Add `"net"` to the import block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ashp/proxy && go test ./internal/auth/ -v -run TestAuthenticateByIP`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add proxy/internal/auth/basic.go proxy/internal/auth/basic_test.go
git commit -m "feat: add IP-based authentication for transparent proxy mode"
```

---

## Task 7: Go Proxy — Refactor Shared Request Handling

**Files:**
- Modify: `proxy/internal/mitm/proxy.go`

This task extracts the rule evaluation, body capture, and IPC reporting logic from the goproxy `OnRequest` handler into a reusable function that both the existing handler and the new transparent listeners will call.

- [ ] **Step 1: Define RequestContext struct and handleRequest method**

Add to `proxy/internal/mitm/proxy.go` (before the `New()` function):

```go
// RequestContext holds the information needed to evaluate and process a
// proxied request, shared between the goproxy handler and transparent listeners.
type RequestContext struct {
	AgentID string
	FullURL string
	Method  string
	Mode    string // "proxy" or "transparent"
}

// RequestDecision is the result of evaluating a request against the rule engine.
type RequestDecision struct {
	Action       string     // "allow", "deny", "hold", "queue"
	Rule         *rules.Rule
	BodyRef      string     // encrypted body reference (if captured)
	BodyBytes    []byte     // original body bytes (for forwarding)
}
```

- [ ] **Step 2: Extract evaluation logic into evaluateRequest()**

Add a method that encapsulates the rule matching and decision logic:

```go
// evaluateRequest matches the request against rules and returns the decision.
// It does NOT capture bodies or send IPC — the caller handles that based on the decision.
func (p *Proxy) evaluateRequest(ctx RequestContext) RequestDecision {
	rule := p.evaluator.Match(ctx.AgentID, ctx.FullURL, ctx.Method)
	if rule != nil {
		return RequestDecision{Action: rule.Action, Rule: rule}
	}
	return RequestDecision{Action: p.defaultBehavior}
}
```

- [ ] **Step 3: Update goproxy OnRequest handler to use evaluateRequest()**

Refactor the existing handler (lines 133-259) to call `evaluateRequest()` internally. The goproxy handler still manages body capture and IPC directly (because it needs to interact with `goproxy.ProxyCtx`), but the decision logic is now centralized.

The goproxy-specific code (reading body from `req.Body`, setting `ctx.UserData`, returning `goproxy.NewResponse`) stays in the handler. The rule matching call changes from:

```go
rule := p.evaluator.Match(agentID, fullURL, req.Method)
```

to:

```go
decision := p.evaluateRequest(RequestContext{
    AgentID: agentID,
    FullURL: fullURL,
    Method:  req.Method,
    Mode:    "proxy",
})
```

And the subsequent if/else branches reference `decision.Action` and `decision.Rule` instead of checking `rule` directly.

- [ ] **Step 4: Run existing tests to verify no regression**

Run: `cd ashp/proxy && go test ./...`
Expected: PASS (all existing tests still pass)

- [ ] **Step 5: Commit**

```bash
git add proxy/internal/mitm/proxy.go
git commit -m "refactor: extract evaluateRequest() for shared rule evaluation"
```

---

## Task 8: Go Proxy — SNI Parser

**Files:**
- Create: `proxy/internal/mitm/transparent.go`
- Create: `proxy/internal/mitm/transparent_test.go`

- [ ] **Step 1: Write failing test for SNI extraction**

Create `proxy/internal/mitm/transparent_test.go`:

```go
package mitm

import (
	"crypto/tls"
	"net"
	"testing"
	"time"
)

func TestExtractSNI(t *testing.T) {
	// Create a TLS listener that we'll connect to
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	done := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- ""
			return
		}
		defer conn.Close()
		sni, _, err := extractSNI(conn)
		if err != nil {
			done <- ""
			return
		}
		done <- sni
	}()

	// Connect with a TLS client that sends SNI
	conn, err := net.DialTimeout("tcp", ln.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	tlsConn := tls.Client(conn, &tls.Config{
		ServerName:         "example.com",
		InsecureSkipVerify: true,
	})
	// Write the ClientHello — the handshake will fail but SNI is in the first message
	go tlsConn.Handshake()
	time.Sleep(100 * time.Millisecond)
	tlsConn.Close()

	sni := <-done
	if sni != "example.com" {
		t.Fatalf("expected SNI 'example.com', got '%s'", sni)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ashp/proxy && go test ./internal/mitm/ -v -run TestExtractSNI`
Expected: FAIL — `extractSNI` not defined

- [ ] **Step 3: Implement SNI extraction**

Create `proxy/internal/mitm/transparent.go`:

```go
package mitm

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/jdk/ashp/proxy/internal/auth"
	calib "github.com/jdk/ashp/proxy/internal/ca"
	"github.com/jdk/ashp/proxy/internal/ipc"
)

// extractSNI peeks at the TLS ClientHello on conn and returns the SNI
// server name. The returned net.Conn is a buffered wrapper that replays
// the peeked bytes so the caller can pass it to tls.Server unchanged.
func extractSNI(conn net.Conn) (string, net.Conn, error) {
	br := bufio.NewReader(conn)

	// Peek at TLS record header: 1 byte type + 2 bytes version + 2 bytes length
	hdr, err := br.Peek(5)
	if err != nil {
		return "", nil, fmt.Errorf("peek TLS header: %w", err)
	}
	if hdr[0] != 0x16 { // ContentType handshake
		return "", nil, fmt.Errorf("not a TLS handshake (type=%d)", hdr[0])
	}
	recordLen := int(hdr[3])<<8 | int(hdr[4])

	// Peek full record (header + body)
	record, err := br.Peek(5 + recordLen)
	if err != nil {
		return "", nil, fmt.Errorf("peek TLS record: %w", err)
	}

	sni := parseSNIFromClientHello(record[5:])
	if sni == "" {
		return "", nil, fmt.Errorf("no SNI found in ClientHello")
	}

	// Wrap conn so buffered bytes are replayed
	wrapped := &bufferedConn{Reader: br, Conn: conn}
	return sni, wrapped, nil
}

// parseSNIFromClientHello extracts the server_name from a TLS ClientHello
// handshake message body. Returns empty string if not found.
func parseSNIFromClientHello(data []byte) string {
	if len(data) < 42 {
		return ""
	}
	// Handshake type (1) + length (3) + client version (2) + random (32)
	if data[0] != 0x01 { // ClientHello
		return ""
	}
	pos := 38 // skip type(1) + length(3) + version(2) + random(32)

	// Session ID
	if pos >= len(data) {
		return ""
	}
	sidLen := int(data[pos])
	pos += 1 + sidLen

	// Cipher suites
	if pos+2 > len(data) {
		return ""
	}
	csLen := int(data[pos])<<8 | int(data[pos+1])
	pos += 2 + csLen

	// Compression methods
	if pos >= len(data) {
		return ""
	}
	cmLen := int(data[pos])
	pos += 1 + cmLen

	// Extensions
	if pos+2 > len(data) {
		return ""
	}
	extLen := int(data[pos])<<8 | int(data[pos+1])
	pos += 2
	end := pos + extLen

	for pos+4 <= end && pos+4 <= len(data) {
		extType := int(data[pos])<<8 | int(data[pos+1])
		extDataLen := int(data[pos+2])<<8 | int(data[pos+3])
		pos += 4
		if extType == 0x0000 { // server_name extension
			if pos+5 <= len(data) && pos+5 <= pos+extDataLen {
				// SNI list length (2) + type (1) + name length (2) + name
				nameLen := int(data[pos+3])<<8 | int(data[pos+4])
				if pos+5+nameLen <= len(data) {
					return string(data[pos+5 : pos+5+nameLen])
				}
			}
			return ""
		}
		pos += extDataLen
	}
	return ""
}

// bufferedConn wraps a net.Conn with a bufio.Reader so that peeked
// bytes from SNI extraction are replayed during the TLS handshake.
type bufferedConn struct {
	io.Reader
	net.Conn
}

func (c *bufferedConn) Read(b []byte) (int, error) {
	return c.Reader.Read(b)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ashp/proxy && go test ./internal/mitm/ -v -run TestExtractSNI`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add proxy/internal/mitm/transparent.go proxy/internal/mitm/transparent_test.go
git commit -m "feat: add SNI extraction from TLS ClientHello for transparent proxy"
```

---

## Task 9: Go Proxy — Transparent HTTPS and HTTP Listeners

**Files:**
- Modify: `proxy/internal/mitm/transparent.go`
- Modify: `proxy/internal/mitm/proxy.go` (Config struct)
- Test: `proxy/internal/mitm/transparent_test.go`

- [ ] **Step 1: Define TransparentPort config and upstream resolver**

Add to `transparent.go`:

```go
// TransparentPort defines a port for transparent proxy listening.
type TransparentPort struct {
	Port int
	TLS  bool
}

// upstreamResolver bypasses dnsmasq catch-all by resolving via Docker
// embedded DNS directly. Without this, transparent proxy would loop.
var upstreamResolver = &net.Resolver{
	PreferGo: true,
	Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
		return net.Dial("udp", "127.0.0.11:53")
	},
}

// upstreamTransport is the HTTP transport used for forwarding transparent
// proxy requests, using the upstream resolver to avoid DNS loops.
var upstreamTransport = &http.Transport{
	DialContext: (&net.Dialer{
		Resolver: upstreamResolver,
		Timeout:  30 * time.Second,
	}).DialContext,
	TLSHandshakeTimeout: 10 * time.Second,
}
```

- [ ] **Step 2: Add transparent fields to Config and Proxy structs**

In `proxy.go`, add to the Config struct:
```go
TransparentListen string           // Bind address for transparent listeners (empty = disabled)
TransparentPorts  []TransparentPort // Ports for transparent proxy
```

Add to the Proxy struct:
```go
transparentListeners []net.Listener
```

- [ ] **Step 3: Implement startTransparentListeners()**

Add to `transparent.go`:

```go
// startTransparentListeners starts HTTPS and HTTP listeners for transparent
// proxy mode on the configured ports. Returns after all listeners are bound.
func (p *Proxy) startTransparentListeners(listenAddr string, ports []TransparentPort) error {
	for _, port := range ports {
		addr := fmt.Sprintf("%s:%d", listenAddr, port.Port)
		if port.TLS {
			if err := p.startTransparentTLS(addr); err != nil {
				return fmt.Errorf("transparent TLS on %s: %w", addr, err)
			}
		} else {
			if err := p.startTransparentHTTP(addr); err != nil {
				return fmt.Errorf("transparent HTTP on %s: %w", addr, err)
			}
		}
	}
	return nil
}

func (p *Proxy) startTransparentTLS(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	p.transparentListeners = append(p.transparentListeners, ln)
	fmt.Fprintf(os.Stderr, "Transparent HTTPS listening on %s\n", addr)

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return // listener closed
			}
			go p.handleTransparentTLS(conn)
		}
	}()
	return nil
}

func (p *Proxy) handleTransparentTLS(conn net.Conn) {
	defer conn.Close()

	sni, buffered, err := extractSNI(conn)
	if err != nil {
		return
	}

	// Generate MITM cert for the target hostname
	caCert, err := x509.ParseCertificate(p.ca.Certificate[0])
	if err != nil {
		return
	}
	leafCert, err := calib.SignHost(caCert, p.ca.PrivateKey, sni)
	if err != nil {
		return
	}

	// Complete TLS handshake presenting the MITM cert
	tlsConn := tls.Server(buffered, &tls.Config{
		Certificates: []tls.Certificate{leafCert},
	})
	if err := tlsConn.Handshake(); err != nil {
		return
	}
	defer tlsConn.Close()

	// Read HTTP request from decrypted stream
	req, err := http.ReadRequest(bufio.NewReader(tlsConn))
	if err != nil {
		return
	}

	// Authenticate by source IP
	agentID, _ := p.auth.AuthenticateByIP(conn.RemoteAddr().String())

	fullURL := "https://" + sni + req.RequestURI
	decision := p.evaluateRequest(RequestContext{
		AgentID: agentID, FullURL: fullURL, Method: req.Method, Mode: "transparent",
	})

	switch decision.Action {
	case "deny":
		p.sendTransparentDeny(tlsConn, req, agentID, fullURL, decision)
	case "allow":
		p.forwardTransparentRequest(tlsConn, req, agentID, fullURL, sni, decision)
	case "hold":
		p.handleTransparentHold(tlsConn, req, agentID, fullURL, sni, decision)
	case "queue":
		p.sendTransparentDeny(tlsConn, req, agentID, fullURL, decision)
	}
}

func (p *Proxy) startTransparentHTTP(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	p.transparentListeners = append(p.transparentListeners, ln)
	fmt.Fprintf(os.Stderr, "Transparent HTTP listening on %s\n", addr)

	server := &http.Server{
		Handler: http.HandlerFunc(p.handleTransparentHTTP),
	}
	go server.Serve(ln)
	return nil
}

func (p *Proxy) handleTransparentHTTP(w http.ResponseWriter, req *http.Request) {
	host := req.Host
	if host == "" {
		http.Error(w, "Missing Host header", http.StatusBadRequest)
		return
	}

	agentID, _ := p.auth.AuthenticateByIP(req.RemoteAddr)
	fullURL := "http://" + host + req.RequestURI
	decision := p.evaluateRequest(RequestContext{
		AgentID: agentID, FullURL: fullURL, Method: req.Method, Mode: "transparent",
	})

	switch decision.Action {
	case "deny", "queue":
		p.sendIPC(ipc.Message{Type: "request.blocked"}, map[string]any{
			"agent_id": agentID, "url": fullURL, "method": req.Method,
			"decision": decision.Action, "mode": "transparent",
		})
		http.Error(w, "Blocked by ASHP", http.StatusForbidden)
	case "allow":
		p.forwardHTTPTransparent(w, req, agentID, fullURL, host, decision)
	case "hold":
		p.handleHTTPHold(w, req, agentID, fullURL, host, decision)
	}
}
```

- [ ] **Step 4: Implement forwarding and deny helpers**

Add to `transparent.go`:

```go
func (p *Proxy) sendTransparentDeny(conn net.Conn, req *http.Request, agentID, fullURL string, decision RequestDecision) {
	ruleID := 0
	if decision.Rule != nil {
		ruleID = decision.Rule.ID
	}
	p.sendIPC(ipc.Message{Type: "request.blocked"}, map[string]any{
		"agent_id": agentID, "url": fullURL, "method": req.Method,
		"decision": decision.Action, "rule_id": ruleID, "mode": "transparent",
	})
	resp := &http.Response{
		StatusCode: 403, Status: "403 Forbidden",
		Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
		Header: make(http.Header),
		Body:   io.NopCloser(strings.NewReader("Blocked by ASHP")),
	}
	resp.Write(conn)
}

func (p *Proxy) forwardTransparentRequest(conn net.Conn, req *http.Request, agentID, fullURL, hostname string, decision RequestDecision) {
	// Capture request body if rule requires it
	var reqBodyRef string
	var bodyBytes []byte
	if decision.Rule != nil && decision.Rule.LogRequestBody != "" && decision.Rule.LogRequestBody != "none" {
		reqBodyRef, bodyBytes = p.captureBody(req.Body, decision.Rule.LogRequestBody)
		req.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	}

	// Build upstream request
	targetURL := "https://" + hostname + req.RequestURI
	outReq, err := http.NewRequest(req.Method, targetURL, req.Body)
	if err != nil {
		return
	}
	outReq.Header = req.Header

	resp, err := upstreamTransport.RoundTrip(outReq)
	if err != nil {
		errResp := &http.Response{
			StatusCode: 502, Status: "502 Bad Gateway",
			Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
			Header: make(http.Header),
			Body:   io.NopCloser(strings.NewReader("Upstream error: " + err.Error())),
		}
		errResp.Write(conn)
		return
	}
	defer resp.Body.Close()

	// Capture response body
	var respBodyRef string
	if decision.Rule != nil && decision.Rule.LogResponseBody != "" && decision.Rule.LogResponseBody != "none" {
		respBodyRef, bodyBytes = p.captureBody(resp.Body, decision.Rule.LogResponseBody)
		resp.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	}

	// Send response to client
	resp.Write(conn)

	// Log via IPC
	ruleID := 0
	if decision.Rule != nil {
		ruleID = decision.Rule.ID
	}
	p.sendIPC(ipc.Message{Type: "request.logged"}, map[string]any{
		"agent_id": agentID, "url": fullURL, "method": req.Method,
		"status_code": resp.StatusCode, "decision": "allow",
		"rule_id": ruleID, "mode": "transparent",
		"request_body_ref": reqBodyRef, "response_body_ref": respBodyRef,
	})
}

func (p *Proxy) forwardHTTPTransparent(w http.ResponseWriter, req *http.Request, agentID, fullURL, hostname string, decision RequestDecision) {
	targetURL := "http://" + hostname + req.RequestURI
	outReq, err := http.NewRequest(req.Method, targetURL, req.Body)
	if err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	outReq.Header = req.Header

	resp, err := upstreamTransport.RoundTrip(outReq)
	if err != nil {
		http.Error(w, "Upstream error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers and body
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)

	ruleID := 0
	if decision.Rule != nil {
		ruleID = decision.Rule.ID
	}
	p.sendIPC(ipc.Message{Type: "request.logged"}, map[string]any{
		"agent_id": agentID, "url": fullURL, "method": req.Method,
		"status_code": resp.StatusCode, "decision": "allow",
		"rule_id": ruleID, "mode": "transparent",
	})
}
```

Add hold handlers (delegating to existing `holdRequest` callback):

```go
func (p *Proxy) handleTransparentHold(conn net.Conn, req *http.Request, agentID, fullURL, hostname string, decision RequestDecision) {
	msg := ipc.Message{Type: "approval.needed"}
	data := map[string]any{
		"agent_id": agentID, "url": fullURL, "method": req.Method,
		"suggested_pattern": suggestPattern(fullURL),
		"suggested_methods": []string{req.Method},
		"mode": "transparent",
	}
	dataJSON, _ := json.Marshal(data)
	msg.Data = dataJSON
	msg.MsgID = ipc.GenerateID()

	approved := p.holdRequest(msg)
	if approved {
		p.forwardTransparentRequest(conn, req, agentID, fullURL, hostname, decision)
	} else {
		p.sendTransparentDeny(conn, req, agentID, fullURL, RequestDecision{Action: "deny"})
	}
}

func (p *Proxy) handleHTTPHold(w http.ResponseWriter, req *http.Request, agentID, fullURL, hostname string, decision RequestDecision) {
	msg := ipc.Message{Type: "approval.needed"}
	data := map[string]any{
		"agent_id": agentID, "url": fullURL, "method": req.Method,
		"suggested_pattern": suggestPattern(fullURL),
		"suggested_methods": []string{req.Method},
		"mode": "transparent",
	}
	dataJSON, _ := json.Marshal(data)
	msg.Data = dataJSON
	msg.MsgID = ipc.GenerateID()

	approved := p.holdRequest(msg)
	if approved {
		p.forwardHTTPTransparent(w, req, agentID, fullURL, hostname, decision)
	} else {
		p.sendIPC(ipc.Message{Type: "request.blocked"}, map[string]any{
			"agent_id": agentID, "url": fullURL, "method": req.Method,
			"decision": "deny", "mode": "transparent",
		})
		http.Error(w, "Request denied", http.StatusForbidden)
	}
}
```

Add necessary imports: `"bytes"`, `"crypto/x509"`, `"encoding/json"`, `"os"`, `"strings"`.

- [ ] **Step 5: Wire transparent listeners into Start() and Stop()**

In `proxy.go`, update `Start()` to launch transparent listeners after the main proxy:

```go
func (p *Proxy) Start(addr string) (net.Listener, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	p.ln = ln
	go http.Serve(ln, p.gp)
	return ln, nil
}

// StartTransparent launches transparent proxy listeners. Call after Start().
func (p *Proxy) StartTransparent(listenAddr string, ports []TransparentPort) error {
	return p.startTransparentListeners(listenAddr, ports)
}
```

Update `Stop()` to close transparent listeners:
```go
func (p *Proxy) Stop() {
	if p.ln != nil {
		p.ln.Close()
	}
	for _, ln := range p.transparentListeners {
		ln.Close()
	}
	if p.logWriter != nil {
		p.logWriter.Close()
	}
}
```

Also store the CA cert on the Proxy struct so transparent handlers can access it:
```go
type Proxy struct {
	// ... existing fields
	ca tls.Certificate // root CA for MITM cert signing
}
```

Set in `New()`: `p.ca = cfg.CA`

- [ ] **Step 6: Run all proxy tests**

Run: `cd ashp/proxy && go test ./...`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add proxy/internal/mitm/transparent.go proxy/internal/mitm/proxy.go
git commit -m "feat: add transparent HTTPS/HTTP listeners with MITM and forwarding"
```

---

## Task 10: Go Main — CLI Flags and IPC Handler for Transparent Mode

**Files:**
- Modify: `proxy/cmd/ashp-proxy/main.go`

- [ ] **Step 1: Add CLI flags for transparent mode**

After existing flag definitions (~line 54), add:

```go
transparentListen := flag.String("transparent-listen", "", "transparent proxy bind address (empty=disabled)")
transparentPorts := flag.String("transparent-ports", "", "transparent ports: 443:tls,80,8443:tls")
```

- [ ] **Step 2: Parse transparent ports flag**

After `flag.Parse()`, add:

```go
var tPorts []mitm.TransparentPort
if *transparentPorts != "" {
	for _, spec := range strings.Split(*transparentPorts, ",") {
		spec = strings.TrimSpace(spec)
		isTLS := strings.HasSuffix(spec, ":tls")
		portStr := strings.TrimSuffix(spec, ":tls")
		port, err := strconv.Atoi(portStr)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Invalid transparent port: %s\n", spec)
			os.Exit(1)
		}
		tPorts = append(tPorts, mitm.TransparentPort{Port: port, TLS: isTLS})
	}
}
```

Add `"strconv"` and `"strings"` to imports.

- [ ] **Step 3: Add IPC handler for agents.ipmapping**

In the `ipc.WithOnMessage` callback, add a case:

```go
case "agents.ipmapping":
	var mapping map[string]string
	if err := json.Unmarshal(m.Data, &mapping); err == nil {
		authHandler.ReloadIPMap(mapping)
	}
```

- [ ] **Step 4: Start transparent listeners after proxy**

After `p.Start(*listen)` (~line 194), add:

```go
if *transparentListen != "" && len(tPorts) > 0 {
	if err := p.StartTransparent(*transparentListen, tPorts); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start transparent proxy: %v\n", err)
		os.Exit(1)
	}
}
```

- [ ] **Step 5: Run proxy build to verify compilation**

Run: `cd ashp/proxy && go build ./cmd/ashp-proxy/`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add proxy/cmd/ashp-proxy/main.go
git commit -m "feat: add transparent proxy CLI flags and IPC handler"
```

---

## Task 11: Entrypoint — dnsmasq Catch-All

**Files:**
- Modify: `ashp/entrypoint.sh`

- [ ] **Step 1: Add transparent mode DNS catch-all**

In `ashp/entrypoint.sh`, replace the dnsmasq block with:

```sh
if command -v dnsmasq >/dev/null 2>&1; then
  BIND_ADDRS=$(hostname -i 2>/dev/null | tr ' ' '\n' | grep -v '127.0.0' | head -5)
  LISTEN_ARGS=""
  for addr in $BIND_ADDRS; do
    LISTEN_ARGS="$LISTEN_ARGS --listen-address=$addr"
  done

  DNSMASQ_EXTRA=""
  if [ "$ASHP_TRANSPARENT" = "true" ]; then
    ASHP_IP=$(echo "$BIND_ADDRS" | head -1)
    if [ -n "$ASHP_IP" ]; then
      # Catch-all: resolve all external domains to ASHP IP
      DNSMASQ_EXTRA="--address=/#/${ASHP_IP}"
      # Auto-detect Docker container names from /etc/hosts — exempt from catch-all
      for host in $(grep -v '127.0.0' /etc/hosts | awk '{for(i=2;i<=NF;i++) print $i}' | sort -u); do
        DNSMASQ_EXTRA="$DNSMASQ_EXTRA --server=/${host}/127.0.0.11"
      done
      echo "Transparent DNS: all domains -> $ASHP_IP"
    fi
  fi

  if [ -n "$LISTEN_ARGS" ]; then
    dnsmasq --server=127.0.0.11 $LISTEN_ARGS --bind-interfaces --no-daemon --log-facility=- --keep-in-foreground $DNSMASQ_EXTRA &
  fi
fi

exec su-exec ashp "$@"
```

- [ ] **Step 2: Commit**

```bash
git add ashp/entrypoint.sh
git commit -m "feat: add dnsmasq DNS catch-all for transparent proxy mode"
```

---

## Task 12: Sandbox Entrypoints — IP Registration

**Files:**
- Modify: `run/entrypoint-sandbox.sh`
- Modify: `sandbox/entrypoint.sh`

- [ ] **Step 1: Add IP registration to run/entrypoint-sandbox.sh**

After the CA cert installation block (~line 26), add:

```sh
# Register IP with ASHP for transparent proxy agent identification
MY_IP=$(hostname -i 2>/dev/null | tr ' ' '\n' | grep -v '127.0.0' | head -1)
if [ -n "$MY_IP" ] && [ -n "$ASHP_AGENT_NAME" ] && [ -n "$ASHP_AGENT_TOKEN" ]; then
  for i in $(seq 1 10); do
    if curl -sf --noproxy '*' -X POST http://ashp:3000/api/agents/register-ip \
      -H 'Content-Type: application/json' \
      -d "{\"name\":\"$ASHP_AGENT_NAME\",\"token\":\"$ASHP_AGENT_TOKEN\",\"ip_address\":\"$MY_IP\"}" \
      2>/dev/null; then
      echo "Registered IP $MY_IP for agent $ASHP_AGENT_NAME"
      break
    fi
    sleep 1
  done
fi
```

- [ ] **Step 2: Add same block to sandbox/entrypoint.sh**

Same code, added after the CA cert block (~line 26).

- [ ] **Step 3: Commit**

```bash
git add run/entrypoint-sandbox.sh sandbox/entrypoint.sh
git commit -m "feat: add IP auto-registration in sandbox entrypoints"
```

---

## Task 13: Docker Compose — Two Sandbox Containers

**Files:**
- Modify: `run/docker-compose.yml`
- Modify: `ashp/Dockerfile`

- [ ] **Step 1: Add EXPOSE 80 443 to Dockerfile**

In `ashp/Dockerfile`, add alongside existing EXPOSE:

```dockerfile
EXPOSE 80 443 3000 8080
```

- [ ] **Step 2: Update run/docker-compose.yml**

Add `ASHP_TRANSPARENT=true` to the ASHP service environment. Add the `sandbox-transparent` service alongside the existing sandbox (rename existing to `sandbox-proxy` if needed):

```yaml
  sandbox-transparent:
    build:
      context: ../sandbox
    container_name: ashp-sandbox-transparent
    networks:
      - ashp-sandbox
    volumes:
      - transparent_home:/home/dev
      - ../sandbox/workspace:/workspace
    environment:
      - ASHP_AGENT_NAME=agent-transparent
      - ASHP_AGENT_TOKEN=${ASHP_TRANSPARENT_AGENT_TOKEN:-changeme}
      - NODE_EXTRA_CA_CERTS=/home/dev/ashp-ca.crt
    stdin_open: true
    tty: true
    entrypoint: ["/entrypoint.sh"]
    command: ["bash"]
```

Add `transparent_home:` to volumes section. Add `ASHP_TRANSPARENT=true` to the ashp service.

- [ ] **Step 3: Update run/ashp.json with transparent config**

Add to the config:
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

- [ ] **Step 4: Commit**

```bash
git add ashp/Dockerfile run/docker-compose.yml run/ashp.json
git commit -m "feat: add transparent sandbox container and Docker config"
```

---

## Task 14: GUI — Agent IP Field

**Files:**
- Modify: GUI agent detail component (find via `grep -r "agent" gui/src/`)

- [ ] **Step 1: Add IP address display to agent detail**

In the agent detail component, after the existing fields (description, enabled, request_count), add:

```jsx
{agent.ip_address && (
  <div className={styles.field}>
    <label>IP Address</label>
    <span>{agent.ip_address}</span>
    <button onClick={() => handleClearIP(agent.id)}>Clear</button>
  </div>
)}
```

Add `handleClearIP` function that calls `PUT /api/agents/:id` with `ip_address: null`.

- [ ] **Step 2: Add mode column to request log table**

In the log table component, add a `Mode` column that displays the `mode` field from each log entry.

- [ ] **Step 3: Add transparent status to dashboard**

In the status/dashboard component, add a line showing whether transparent mode is active (from `/api/status` response — requires adding `transparent` field to the status endpoint).

- [ ] **Step 4: Run GUI tests**

Run: `cd ashp/gui && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gui/src/
git commit -m "feat: add transparent proxy info to GUI (IP field, mode column, status)"
```

---

## Task 15: Status API — Report Transparent Mode

**Files:**
- Modify: `server/src/api/status.js` (or wherever `/api/status` is defined)

- [ ] **Step 1: Add transparent config to status response**

Include `transparent: { enabled, ports }` in the `/api/status` response so the GUI and health checks know transparent mode is active.

- [ ] **Step 2: Commit**

```bash
git add server/src/api/
git commit -m "feat: include transparent proxy status in /api/status response"
```

---

## Task 16: Request Log — Support `mode` Field

The `mode` column was already added to `request_log` in the v4 migration (Task 1). This task wires it through the DAO and API layers.

**Files:**
- Modify: `server/src/dao/sqlite/logs.js`
- Modify: `server/src/api/logs.js`
- Test: `server/test/dao/sqlite/logs.test.js`

- [ ] **Step 1: Update log insertion to include mode**

In the logs DAO `insert()` method, add `mode` to the INSERT statement and bind it from the IPC message data. Default to `'proxy'` if not provided:

```javascript
const mode = data.mode || 'proxy';
```

- [ ] **Step 2: Update log query API to support mode filter**

In the logs API (`GET /api/logs`), add `mode` as an optional query parameter alongside existing filters (`method`, `decision`, `url`).

- [ ] **Step 3: Include mode in log list/get responses**

Ensure the log DAO SELECT queries include the `mode` column and it appears in API responses.

- [ ] **Step 4: Run tests**

Run: `cd ashp/server && node --test test/dao/sqlite/logs.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/dao/sqlite/logs.js server/src/api/logs.js server/test/dao/sqlite/logs.test.js
git commit -m "feat: wire mode field through log DAO and API"
```

---

## Task 17: E2E Tests — Local Transparent Proxy

**Files:**
- Create: `test/e2e/transparent.test.js`

- [ ] **Step 1: Write E2E test for transparent HTTPS**

Test that connects to the transparent TLS listener, performs a TLS handshake with SNI, sends an HTTP request, and verifies MITM + rule evaluation + logging with `mode: "transparent"`.

- [ ] **Step 2: Write E2E test for IP auth**

Register an IP via the API, make a request from that IP to the transparent listener, verify the correct agent is assigned in the log.

- [ ] **Step 3: Write E2E test for unknown IP**

Make a request from an unregistered IP, verify default behavior is applied.

- [ ] **Step 4: Run E2E tests**

Run: `cd ashp && make test-e2e`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/e2e/transparent.test.js
git commit -m "test: add E2E tests for transparent proxy mode"
```

---

## Task 18: Docker Integration Tests

**Files:**
- Create: `test/docker/test-transparent.sh`
- Modify: `ashp/Makefile`

- [ ] **Step 1: Write Docker integration test script**

Create `test/docker/test-transparent.sh`:

```bash
#!/bin/bash
set -e

echo "=== ASHP Docker Integration Test: Transparent Proxy ==="

# 1. Build and start stack
echo "Starting stack..."
docker compose -f run/docker-compose.yml up -d --build --wait

# 2. Wait for ASHP readiness
echo "Waiting for ASHP..."
for i in $(seq 1 30); do
  if docker exec ashp curl -sf http://localhost:3000/api/status > /dev/null 2>&1; then
    echo "ASHP ready"
    break
  fi
  sleep 1
done

# 3. Test explicit proxy mode
echo "Testing explicit proxy mode..."
PROXY_RESULT=$(docker exec ashp-sandbox-proxy curl -sf -x http://agent-proxy:token@ashp:8080 https://httpbin.org/get 2>&1) || true
echo "Proxy result: ${PROXY_RESULT:0:100}"

# 4. Test transparent mode
echo "Testing transparent proxy mode..."
TRANSPARENT_RESULT=$(docker exec ashp-sandbox-transparent curl -sf https://httpbin.org/get 2>&1) || true
echo "Transparent result: ${TRANSPARENT_RESULT:0:100}"

# 5. Verify logs via API
echo "Checking logs..."
LOGS=$(docker exec ashp curl -sf http://localhost:3000/api/logs 2>&1)
echo "Logs: ${LOGS:0:200}"

# 6. Teardown
echo "Stopping stack..."
docker compose -f run/docker-compose.yml down

echo "=== DONE ==="
```

- [ ] **Step 2: Add test-docker target to Makefile**

In `ashp/Makefile`, add:

```makefile
test-docker:
	bash ../test/docker/test-transparent.sh
```

- [ ] **Step 3: Commit**

```bash
git add test/docker/test-transparent.sh ashp/Makefile
git commit -m "test: add Docker integration tests for transparent proxy"
```

---

## Task 19: Update README and CLAUDE.md

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Transparent Proxy section to README**

Add a new section after "Quick Start" explaining transparent proxy mode, config example, and how it works.

- [ ] **Step 2: Update CLAUDE.md architecture section**

Add transparent proxy to the architecture description, mention DNS catch-all approach, new IPC message type, and IP-based auth.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: add transparent proxy mode documentation"
```
