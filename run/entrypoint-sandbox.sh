#!/bin/bash
set -e

# Resolve ASHP IP via Docker embedded DNS and set it as our DNS server.
# This lets sandbox containers on internal networks resolve external domains
# via ASHP's dnsmasq forwarder, without needing a static IP in compose.
ASHP_IP=$(getent hosts ashp | awk '{print $1}')
if [ -n "$ASHP_IP" ]; then
  echo "nameserver $ASHP_IP" > /etc/resolv.conf
  echo "DNS set to ASHP at $ASHP_IP"
fi

# Wait for ASHP management API and fetch CA cert
echo "Waiting for ASHP CA certificate..."
for i in $(seq 1 30); do
  if curl -sf --noproxy ashp http://ashp:3000/api/ca/certificate -o /usr/local/share/ca-certificates/ashp-ca.crt 2>/dev/null; then
    update-ca-certificates 2>/dev/null
    # Copy for NODE_EXTRA_CA_CERTS
    cp /usr/local/share/ca-certificates/ashp-ca.crt /home/dev/ashp-ca.crt
    chown dev:dev /home/dev/ashp-ca.crt
    echo "CA certificate installed."
    break
  fi
  sleep 1
done

if [ ! -f /home/dev/ashp-ca.crt ]; then
  echo "WARNING: Could not fetch ASHP CA certificate. HTTPS interception will fail."
fi

exec "$@"
