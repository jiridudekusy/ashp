# E2E Proxy Tests Design

## Problem

Existing E2E tests only test management API endpoints. No test sends a real HTTP request through the Go proxy. This failed to catch bugs in IPC messaging (missing msg_id, wrong field nesting, missing decision field).

## Architecture

Each test suite spins up a full stack:

1. **Local HTTP target server** — Node `http.createServer` on port 0, returns 200 + known body
2. **Management server** — `startServer()` with temp DB, random ports
3. **Go proxy** — spawned via `ProxyManager` (same as production), connected to server via IPC

Setup compiles proxy binary once before all tests. Each `describe` block gets a clean stack with its own temp dir, DB, and ports. Cleanup kills everything and removes temp dir.

## Test helper: `createFullStack(options)`

Extends existing `createTestStack` in `test/e2e/setup.js`:

- Starts a local HTTP target server
- Starts management server with configurable `default_behavior` and `hold_timeout`
- Spawns Go proxy via `ProxyManager` with auth `{agent1: "test-token"}`
- Waits for proxy to be listening (poll port)
- Returns: `{ api, proxyRequest, targetURL, cleanup, mgmtPort, proxyPort }`
- `proxyRequest(method, path)` — sends HTTP request through proxy to target with auth header

## Scenarios (6 tests)

### 1. Allow (rule match)
- Create allow rule matching target URL
- Send GET through proxy
- Assert: response 200, body matches target, `/api/logs` has `decision: "allowed"`

### 2. Deny (rule match)
- Create deny rule matching target URL
- Send GET through proxy
- Assert: response 403, target never received request, `/api/logs` has `decision: "denied"`

### 3. Deny (default behavior)
- No rules, `default_behavior: "deny"`
- Send GET through proxy
- Assert: response 403, `/api/logs` has `decision: "denied"`

### 4. Hold → Approve
- No rules, `default_behavior: "hold"`, `hold_timeout: 30`
- Send GET through proxy (non-blocking, in background)
- Poll `/api/approvals` until pending item appears
- POST approve
- Assert: background request completes with 200, body matches target, `/api/logs` has entries for both `"held"` and `"allowed"`

### 5. Hold → Reject
- No rules, `default_behavior: "hold"`, `hold_timeout: 30`
- Send GET through proxy (non-blocking, in background)
- Poll `/api/approvals` until pending item appears
- POST reject
- Assert: background request completes with 504, `/api/logs` has `decision: "denied"`

### 6. Hold → Timeout
- No rules, `default_behavior: "hold"`, `hold_timeout: 2` (short)
- Send GET through proxy (non-blocking)
- Do NOT approve or reject
- Assert: after ~2s request completes with 504, `/api/logs` has `decision: "denied"`

## File structure

```
test/e2e/
  setup.js              — extended with createFullStack()
  proxy-e2e-allow.test.js
  proxy-e2e-deny.test.js
  proxy-e2e-hold.test.js
```

## Dependencies

- Go proxy binary must be compiled before tests (`make build-proxy`)
- No external network access needed
- All ports dynamically assigned (port 0)
