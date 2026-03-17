.PHONY: build build-proxy build-gui dev dev-stop dev-restart dev-status dev-logs test test-server test-proxy test-gui test-e2e bench clean

build: build-proxy build-gui

build-proxy:
	cd proxy && go build -o ashp-proxy ./cmd/ashp-proxy/

build-gui:
	cd gui && npm run build

dev:
	./scripts/dev.sh start

dev-stop:
	./scripts/dev.sh stop

dev-restart:
	./scripts/dev.sh restart

dev-status:
	./scripts/dev.sh status

dev-logs:
	./scripts/dev.sh logs

test: test-proxy test-server test-gui

test-proxy:
	cd proxy && go test ./...

test-server:
	cd server && node --test 'src/**/*.test.js'

test-gui:
	cd gui && npx vitest run

test-e2e: build-proxy
	cd server && node --test '../test/e2e/*.test.js'

bench: build-proxy
	node test/bench/proxy-bench.js

clean:
	rm -f proxy/ashp-proxy
	rm -rf gui/dist
	rm -rf data/
