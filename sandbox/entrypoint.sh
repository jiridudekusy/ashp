#!/bin/bash
set -e

# Wait for ASHP and fetch CA cert for MITM trust
echo "Waiting for ASHP CA certificate..."
for i in $(seq 1 30); do
  if curl -sf --noproxy '*' http://ashp:3000/api/ca/certificate -o /usr/local/share/ca-certificates/ashp-ca.crt 2>/dev/null; then
    update-ca-certificates 2>/dev/null
    cp /usr/local/share/ca-certificates/ashp-ca.crt /home/dev/ashp-ca.crt
    chown dev:dev /home/dev/ashp-ca.crt
    echo "CA certificate installed."
    break
  fi
  sleep 1
done

if [ ! -f /home/dev/ashp-ca.crt ]; then
  echo "WARNING: Could not fetch ASHP CA certificate."
fi

exec "$@"
