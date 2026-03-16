.PHONY: build build-proxy build-gui dev test test-server test-proxy test-gui test-e2e clean

build: build-proxy build-gui

build-proxy:
	cd proxy && go build -o ashp-proxy ./cmd/ashp-proxy/

build-gui:
	cd gui && npm run build

dev:
	@echo "Starting dev mode..."
	cd proxy && go build -o ashp-proxy ./cmd/ashp-proxy/ && cd ..
	cd server && node --watch src/index.js -- --config ../ashp.example.json &
	cd gui && npx vite &
	wait

test: test-proxy test-server test-gui

test-proxy:
	cd proxy && go test ./...

test-server:
	cd server && node --test 'src/**/*.test.js'

test-gui:
	cd gui && npx vitest run

test-e2e: build-proxy
	cd server && node --test '../test/e2e/*.test.js'

clean:
	rm -f proxy/ashp-proxy
	rm -rf gui/dist
	rm -rf data/
