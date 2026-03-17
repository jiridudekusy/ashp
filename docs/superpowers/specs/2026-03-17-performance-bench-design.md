# Performance Benchmark — Design Spec

## Overview

Benchmark script to measure proxy latency overhead and full-stack throughput (proxy → IPC → server → DB). The goal is to verify that the proxy doesn't add unacceptable overhead for typical agent workloads (tens to hundreds of requests per minute).

## What We Measure

1. **Baseline** — N requests directly to target server (no proxy) → establishes floor latency
2. **Proxy allow** — same requests through proxy with an allow rule (body logging off)
3. **Proxy allow + body logging** — with `log_request_body: "full"`, `log_response_body: "full"`
4. **Proxy deny** — requests through proxy with deny rule (blocked immediately, no forwarding)
5. **Overhead** — difference between proxy scenarios and baseline in ms and %

## Architecture

### Files
- `test/bench/proxy-bench.js` — benchmark script (standalone, runnable with `node`)
- `test/bench/results.json` — output file (generated, gitignored)

### Components
- **Target server** — minimal HTTP server built into the script. Listens on random port, handles POST requests, returns 200 + fixed JSON body (~200B). Zero network latency = isolates proxy overhead.
- **Full stack** — uses `createFullStack` helper from `test/e2e/setup.js` to spin up proxy + management server + IPC. Configures rules via API.
- **Benchmark runner** — sends N sequential requests, collects timing data, computes statistics.

### Test Parameters
- **Requests per scenario:** 500
- **Concurrency:** 1 (sequential — simulates real agent behavior)
- **Request payload:** POST with ~500B JSON body
- **Target response:** ~200B JSON body
- **Warmup:** 10 requests before measurement (discarded)

## Scenarios

### 1. Direct (baseline)
- Request goes directly to target server
- No proxy involved
- Establishes minimum achievable latency

### 2. Proxy Allow
- Create rule: `url_pattern: "*", action: "allow", log_request_body: "none", log_response_body: "none"`
- Request goes through proxy → forwarded to target → response returned
- Measures proxy forwarding overhead

### 3. Proxy Allow + Body Logging
- Create rule: `url_pattern: "*", action: "allow", log_request_body: "full", log_response_body: "full"`
- Same flow as allow, but proxy encrypts and writes bodies to disk
- Measures body logging overhead on top of forwarding

### 4. Proxy Deny
- Create rule: `url_pattern: "*", action: "deny"`
- Request blocked at proxy — no forwarding, immediate 403 response
- Measures rule evaluation + IPC logging overhead

## Output

### Terminal Table
```
Scenario            Reqs   Req/s    p50      p95      p99      Overhead
──────────────────────────────────────────────────────────────────────────
Direct              500    2341     0.4ms    0.6ms    0.8ms    —
Proxy (allow)       500    1892     0.5ms    0.8ms    1.2ms    +0.1ms (+25%)
Proxy (allow+log)   500    1654     0.6ms    1.0ms    1.5ms    +0.2ms (+50%)
Proxy (deny)        500    2105     0.5ms    0.7ms    0.9ms    +0.1ms (+25%)
```

### JSON File (`test/bench/results.json`)
```json
{
  "timestamp": "2026-03-17T09:00:00Z",
  "parameters": { "requests": 500, "concurrency": 1 },
  "scenarios": {
    "direct": { "count": 500, "rps": 2341, "p50": 0.4, "p95": 0.6, "p99": 0.8 },
    "proxy_allow": { "count": 500, "rps": 1892, "p50": 0.5, "p95": 0.8, "p99": 1.2, "overhead_ms": 0.1, "overhead_pct": 25 },
    "proxy_allow_log": { "count": 500, "rps": 1654, "p50": 0.6, "p95": 1.0, "p99": 1.5, "overhead_ms": 0.2, "overhead_pct": 50 },
    "proxy_deny": { "count": 500, "rps": 2105, "p50": 0.5, "p95": 0.7, "p99": 0.9, "overhead_ms": 0.1, "overhead_pct": 25 }
  }
}
```

## Integration

- **Makefile target:** `make bench` runs `node test/bench/proxy-bench.js`
- **gitignore:** `test/bench/results.json`
- Script is standalone — no test framework dependency, just `node` + the E2E setup helper
- Exit code 0 on success (no pass/fail thresholds — this is observational, not gating)

## Non-Goals

- No stress testing / ramp-up scenarios
- No concurrent load testing
- No CI integration or regression thresholds
- No comparison across runs (just latest results)
