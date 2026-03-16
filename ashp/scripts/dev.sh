#!/bin/sh
set -e

ASHP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ASHP_DIR/data/pids"
LOG_DIR="/tmp/ashp"

# Defaults (override via env or flags)
: "${ASHP_DB_KEY:=dev-db-key}"
: "${ASHP_LOG_KEY:=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"
: "${ASHP_CA_KEY:=dev-ca-key}"
: "${DEFAULT_BEHAVIOR:=deny}"
: "${HOLD_TIMEOUT:=60}"
export ASHP_DB_KEY ASHP_LOG_KEY ASHP_CA_KEY

usage() {
  echo "Usage: $0 {start|stop|restart|status|logs}"
  echo ""
  echo "  start   - build proxy, start server + proxy + gui"
  echo "  stop    - kill all components"
  echo "  restart - stop + start"
  echo "  status  - show running components"
  echo "  logs    - tail all logs"
  echo ""
  echo "Environment:"
  echo "  DEFAULT_BEHAVIOR=deny|hold|queue  (default: deny)"
  echo "  HOLD_TIMEOUT=60                   (seconds, default: 60)"
  exit 1
}

mkdir -p "$PID_DIR" "$LOG_DIR" "$ASHP_DIR/data"

kill_pid() {
  pidfile="$PID_DIR/$1.pid"
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

kill_port() {
  pid=$(netstat -tlnp 2>/dev/null | grep ":$1 " | awk '{print $7}' | cut -d/ -f1)
  if [ -n "$pid" ] && [ "$pid" != "-" ]; then
    kill -9 "$pid" 2>/dev/null || true
  fi
}

stop_all() {
  echo "Stopping..."
  kill_pid proxy
  kill_pid server
  kill_pid gui
  rm -f "$ASHP_DIR/data/ashp.sock"
  sleep 1
  # Safety: kill anything still on our ports
  kill_port 8080
  kill_port 3000
  kill_port 5173
  sleep 1
  echo "Stopped."
}

start_server() {
  echo "Starting management server..."
  cd "$ASHP_DIR"
  node --watch server/src/index.js --config ashp.json \
    > "$LOG_DIR/server.log" 2>&1 &
  echo $! > "$PID_DIR/server.pid"
  # Wait for server to be ready
  i=0
  while [ $i -lt 30 ]; do
    if curl -sf http://localhost:3000/api/status > /dev/null 2>&1; then
      echo "  Server ready (PID $(cat "$PID_DIR/server.pid"))"
      return 0
    fi
    sleep 0.5
    i=$((i + 1))
  done
  echo "  ERROR: Server failed to start:"
  cat "$LOG_DIR/server.log"
  return 1
}

start_proxy() {
  echo "Building proxy..."
  cd "$ASHP_DIR/proxy"
  go build -o ashp-proxy ./cmd/ashp-proxy/

  echo "Starting proxy (default_behavior=$DEFAULT_BEHAVIOR)..."
  cd "$ASHP_DIR"
  proxy/ashp-proxy \
    --socket data/ashp.sock \
    --listen 0.0.0.0:8080 \
    --auth '{"agent1":"change-me-agent-token"}' \
    --ca-pass "$ASHP_CA_KEY" \
    --log-key "env:ASHP_LOG_KEY" \
    --default-behavior "$DEFAULT_BEHAVIOR" \
    --hold-timeout "$HOLD_TIMEOUT" \
    > "$LOG_DIR/proxy.log" 2>&1 &
  echo $! > "$PID_DIR/proxy.pid"
  sleep 2
  if kill -0 "$(cat "$PID_DIR/proxy.pid")" 2>/dev/null; then
    echo "  Proxy ready (PID $(cat "$PID_DIR/proxy.pid"))"
  else
    echo "  ERROR: Proxy failed to start:"
    cat "$LOG_DIR/proxy.log"
    return 1
  fi
}

start_gui() {
  echo "Starting GUI dev server..."
  cd "$ASHP_DIR/gui"
  npx vite --host 0.0.0.0 --port 5173 > "$LOG_DIR/gui.log" 2>&1 &
  echo $! > "$PID_DIR/gui.pid"
  i=0
  while [ $i -lt 20 ]; do
    if curl -sf http://localhost:5173/ > /dev/null 2>&1; then
      echo "  GUI ready (PID $(cat "$PID_DIR/gui.pid"))"
      return 0
    fi
    sleep 0.5
    i=$((i + 1))
  done
  echo "  WARN: GUI may not be ready. Check $LOG_DIR/gui.log"
}

start_all() {
  # Config file
  if [ ! -f "$ASHP_DIR/ashp.json" ]; then
    cp "$ASHP_DIR/ashp.example.json" "$ASHP_DIR/ashp.json"
    echo "Created ashp.json from example"
  fi

  start_server || return 1
  start_proxy || return 1
  start_gui

  echo ""
  echo "=== ASHP Dev Stack Running ==="
  echo "  Proxy:      http://localhost:8080  (user: agent1 / pass: change-me-agent-token)"
  echo "  API:        http://localhost:3000  (Bearer: change-me-mgmt-token)"
  echo "  GUI:        http://localhost:5173"
  echo "  CA cert:    $ASHP_DIR/data/ca/root.crt"
  echo "  Logs:       $LOG_DIR/{server,proxy,gui}.log"
  echo ""
  echo "  Stop with:  make dev-stop"
  echo "  Restart:    make dev-restart"
  echo "  Logs:       make dev-logs"
}

show_status() {
  for name in server proxy gui; do
    pidfile="$PID_DIR/$name.pid"
    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo "  $name: running (PID $(cat "$pidfile"))"
    else
      echo "  $name: stopped"
    fi
  done
}

show_logs() {
  tail -f "$LOG_DIR/server.log" "$LOG_DIR/proxy.log" "$LOG_DIR/gui.log" 2>/dev/null
}

case "${1:-}" in
  start)   stop_all; start_all ;;
  stop)    stop_all ;;
  restart) stop_all; start_all ;;
  status)  show_status ;;
  logs)    show_logs ;;
  *)       usage ;;
esac
