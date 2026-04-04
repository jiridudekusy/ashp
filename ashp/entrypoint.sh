#!/bin/sh
set -e

# Start dnsmasq as a lightweight DNS forwarder for sandbox containers
# that are on internal-only networks and can't reach external DNS directly.
# Uses Docker's embedded DNS (127.0.0.11) as upstream.
# With ASHP_TRANSPARENT=true, dnsmasq acts as catch-all: all external domains resolve to ASHP IP.
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

# Drop to ashp user for the main application
exec su-exec ashp "$@"
