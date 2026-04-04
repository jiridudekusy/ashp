#!/bin/bash
# Docker integration test for transparent proxy mode.
# Spins up the run/ compose stack (ASHP + sandbox-transparent),
# creates an agent, verifies transparent HTTPS/HTTP interception.
#
# Usage: bash test/docker/test-transparent.sh
# Requires: docker, docker compose, curl, jq
set -euo pipefail
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}:/usr/local/bin"

COMPOSE_FILE="run/docker-compose.yml"
COMPOSE_PROJECT="ashp-test-$$"
API="http://localhost:3000"
AUTH="admin:change-me-admin-password"
PASS=0
FAIL=0
TOTAL=0

cleanup() {
  echo ""
  echo "=== Teardown ==="
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" actual="$2" expected="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected to contain '$needle')"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== ASHP Docker Integration Test: Transparent Proxy ==="
echo "Compose project: $COMPOSE_PROJECT"
echo ""

# -------------------------------------------------------------------
# 1. Start stack
# -------------------------------------------------------------------
echo "=== Starting stack ==="
# Clean data dir to ensure fresh DB
rm -rf run/data
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --build --wait 2>&1 | tail -5

# Wait for ASHP management API
echo "Waiting for ASHP API..."
for i in $(seq 1 60); do
  if curl -sf -u "$AUTH" "$API/api/status" > /dev/null 2>&1; then
    echo "ASHP ready after ${i}s"
    break
  fi
  if [ "$i" = "60" ]; then
    echo "FATAL: ASHP did not start in 60s"
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" logs ashp | tail -30
    exit 1
  fi
  sleep 1
done

# -------------------------------------------------------------------
# 2. Check transparent mode is active
# -------------------------------------------------------------------
echo ""
echo "=== Test: Status reports transparent mode ==="
STATUS=$(curl -sf -u "$AUTH" "$API/api/status")
TRANSPARENT_ENABLED=$(echo "$STATUS" | jq -r '.transparent.enabled // false')
assert_eq "transparent.enabled is true" "$TRANSPARENT_ENABLED" "true"

# -------------------------------------------------------------------
# 3. Create agent for transparent sandbox
# -------------------------------------------------------------------
echo ""
echo "=== Setup: Create agent ==="
AGENT_RESP=$(curl -sf -u "$AUTH" -X POST "$API/api/agents" \
  -H 'Content-Type: application/json' \
  -d '{"name":"agent-transparent","description":"test agent"}')
AGENT_ID=$(echo "$AGENT_RESP" | jq -r '.id')
AGENT_TOKEN=$(echo "$AGENT_RESP" | jq -r '.token')
echo "Created agent id=$AGENT_ID"

# Create allow rule + policy
POLICY_RESP=$(curl -sf -u "$AUTH" -X POST "$API/api/policies" \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-allow","description":"allow for testing"}')
POLICY_ID=$(echo "$POLICY_RESP" | jq -r '.id')

curl -sf -u "$AUTH" -X POST "$API/api/rules" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Allow httpbin\",\"url_pattern\":\"^https://httpbin\\\\.org/.*$\",\"methods\":[],\"action\":\"allow\",\"priority\":100,\"enabled\":true,\"policy_id\":$POLICY_ID}" > /dev/null

curl -sf -u "$AUTH" -X POST "$API/api/policies/$POLICY_ID/agents" \
  -H 'Content-Type: application/json' \
  -d "{\"agent_id\":$AGENT_ID}" > /dev/null
echo "Policy and rules assigned to agent"

# -------------------------------------------------------------------
# 4. Wait for sandbox container to register IP
# -------------------------------------------------------------------
echo ""
echo "=== Waiting for sandbox IP registration ==="
# The sandbox entrypoint registers its IP on startup, but we need to
# restart it now that the agent exists (it was created after compose up).
# Re-set the token env var and restart the sandbox.
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T sandbox-transparent \
  sh -c "export ASHP_AGENT_NAME=agent-transparent ASHP_AGENT_TOKEN='$AGENT_TOKEN'; \
    MY_IP=\$(hostname -i 2>/dev/null | tr ' ' '\n' | grep -v '127.0.0' | head -1); \
    curl -sf --noproxy '*' -X POST http://ashp:3000/api/agents/register-ip \
      -H 'Content-Type: application/json' \
      -d \"{\\\"name\\\":\\\"agent-transparent\\\",\\\"token\\\":\\\"$AGENT_TOKEN\\\",\\\"ip_address\\\":\\\"\$MY_IP\\\"}\" && \
    echo \"Registered IP \$MY_IP\"" 2>&1 || echo "IP registration from container failed (may need manual)"

sleep 2

# Verify IP was registered
AGENT_DETAIL=$(curl -sf -u "$AUTH" "$API/api/agents/$AGENT_ID")
AGENT_IP=$(echo "$AGENT_DETAIL" | jq -r '.ip_address // "null"')
echo "Agent IP: $AGENT_IP"

# -------------------------------------------------------------------
# 5. Test transparent HTTPS from sandbox
# -------------------------------------------------------------------
echo ""
echo "=== Test: Transparent HTTPS from sandbox ==="
# The sandbox container's DNS resolves httpbin.org to ASHP IP (dnsmasq catch-all).
# Curl connects to ASHP:443, ASHP reads SNI, generates MITM cert, evaluates rules.
HTTPS_STATUS=$(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T sandbox-transparent \
  curl -sf -o /dev/null -w '%{http_code}' --max-time 10 https://httpbin.org/get 2>&1) || HTTPS_STATUS="error"
assert_eq "transparent HTTPS to httpbin.org returns 200" "$HTTPS_STATUS" "200"

# -------------------------------------------------------------------
# 6. Test transparent HTTP from sandbox
# -------------------------------------------------------------------
echo ""
echo "=== Test: Transparent HTTP from sandbox ==="
HTTP_STATUS=$(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T sandbox-transparent \
  curl -sf -o /dev/null -w '%{http_code}' --max-time 10 http://httpbin.org/get 2>&1) || HTTP_STATUS="error"
# HTTP to httpbin.org — may be denied if no rule matches http:// (our rule is https only)
echo "  HTTP status: $HTTP_STATUS (403 expected if no HTTP allow rule)"

# -------------------------------------------------------------------
# 7. Check logs via API
# -------------------------------------------------------------------
echo ""
echo "=== Test: Logs contain transparent entries ==="
sleep 3
LOGS=$(curl -sf -u "$AUTH" "$API/api/logs?mode=transparent")
LOG_COUNT=$(echo "$LOGS" | jq 'length')
echo "  Transparent log entries: $LOG_COUNT"
TOTAL=$((TOTAL + 1))
if [ "$LOG_COUNT" -gt 0 ]; then
  echo "  PASS: at least one transparent log entry exists"
  PASS=$((PASS + 1))

  FIRST_MODE=$(echo "$LOGS" | jq -r '.[0].mode')
  assert_eq "log entry mode is 'transparent'" "$FIRST_MODE" "transparent"
else
  echo "  FAIL: no transparent log entries found"
  FAIL=$((FAIL + 1))
fi

# -------------------------------------------------------------------
# 8. Test denied request (no matching rule)
# -------------------------------------------------------------------
echo ""
echo "=== Test: Denied request (no rule match) ==="
DENY_STATUS=$(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T sandbox-transparent \
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://example.com/ 2>&1) || DENY_STATUS="000"
TOTAL=$((TOTAL + 1))
if [ "$DENY_STATUS" = "403" ] || [ "$DENY_STATUS" = "000" ]; then
  echo "  PASS: transparent HTTPS to example.com blocked (status=$DENY_STATUS)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected 403 or 000, got $DENY_STATUS"
  FAIL=$((FAIL + 1))
fi

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo ""
echo "========================================"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
