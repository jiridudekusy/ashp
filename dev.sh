#!/bin/bash
# Start ASHP dev container and drop into shell
set -e

cd "$(dirname "$0")"

# Build if image doesn't exist or --build flag passed
if [[ "$1" == "--build" ]] || ! docker image inspect ashp-dev:latest &>/dev/null; then
    echo "Building dev image..."
    docker compose -f docker-compose.dev.yml build
fi

# Start container (detached, keeps running)
if ! docker ps --format '{{.Names}}' | grep -q '^ashp-dev$'; then
    echo "Starting dev container..."
    docker compose -f docker-compose.dev.yml up -d

    # Wait for container to be ready
    sleep 2

    # Install dependencies on first run
    echo "Installing dependencies..."
    docker exec -u dev ashp-dev bash -c '
        cd /workspace/ashp/server && npm install 2>&1 | tail -3
        cd /workspace/ashp/gui && npm install 2>&1 | tail -3
        cd /workspace/ashp/proxy && go mod download
    '
    echo "Dependencies installed."
fi

echo ""
echo "Entering dev container..."
echo "  Proxy:  localhost:9080"
echo "  GUI:    localhost:9030"
echo "  Vite:   localhost:5173"
echo ""
echo "Commands:"
echo "  make dev        # start full stack"
echo "  make test       # run all tests"
echo "  make test-e2e   # run E2E tests"
echo ""

# Drop into shell as dev user
docker exec -it -u dev -w /workspace/ashp ashp-dev bash
