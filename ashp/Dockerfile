# Stage 1: Go proxy build
FROM golang:1.25-alpine AS go-build
WORKDIR /src/proxy
COPY proxy/go.mod proxy/go.sum ./
RUN go mod download
COPY proxy/ ./
RUN CGO_ENABLED=0 go build -o /ashp-proxy ./cmd/ashp-proxy/

# Stage 2: GUI build
FROM node:22-alpine AS gui-build
WORKDIR /src/gui
COPY gui/package.json gui/package-lock.json ./
RUN npm ci
COPY gui/ ./
RUN npm run build

# Stage 3: Runtime
FROM node:22-alpine
RUN apk add --no-cache python3 make g++ tini ca-certificates dnsmasq su-exec \
    && addgroup -S ashp && adduser -S ashp -G ashp -h /home/ashp
WORKDIR /app

# Server dependencies (build native modules, then remove build tools)
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --production \
    && apk del python3 make g++

# Application files
COPY server/src/ ./server/src/
COPY --from=go-build /ashp-proxy ./proxy/ashp-proxy
COPY --from=gui-build /src/gui/dist ./gui/dist/

# Data volume: DB, encrypted logs, CA certs
RUN mkdir -p /data/ca /data/logs && chown -R ashp:ashp /data
VOLUME /data

# Config mount point
VOLUME /etc/ashp

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 80 443 3000 8080 53/udp 53/tcp
ENV NODE_ENV=production

ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
CMD ["node", "server/src/index.js", "--config", "/etc/ashp/ashp.json"]
