#!/bin/sh
set -e

# Start dnsmasq as a lightweight DNS forwarder for sandbox containers
# that are on internal-only networks and can't reach external DNS directly.
# Uses Docker's embedded DNS (127.0.0.11) as upstream.
if command -v dnsmasq >/dev/null 2>&1; then
  # Get the container's IP on the sandbox network (non-loopback, non-Docker DNS)
  # Bind dnsmasq only to container IPs, avoiding conflict with Docker embedded DNS on 127.0.0.11
  BIND_ADDRS=$(hostname -i 2>/dev/null | tr ' ' '\n' | grep -v '127.0.0' | head -5)
  LISTEN_ARGS=""
  for addr in $BIND_ADDRS; do
    LISTEN_ARGS="$LISTEN_ARGS --listen-address=$addr"
  done
  if [ -n "$LISTEN_ARGS" ]; then
    dnsmasq --server=127.0.0.11 $LISTEN_ARGS --bind-interfaces --no-daemon --log-facility=- --keep-in-foreground &
  fi
fi

# Drop to ashp user for the main application
exec su-exec ashp "$@"
