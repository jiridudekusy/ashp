# Stage 1: Go build
FROM golang:1.22-alpine AS go-build
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
RUN apk add --no-cache sqlite-dev python3 make g++
WORKDIR /app

# Server dependencies
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --production

# Application files
COPY server/src/ ./server/src/
COPY --from=go-build /ashp-proxy ./proxy/ashp-proxy
COPY --from=gui-build /src/gui/dist ./gui/dist/

# Data directory
RUN mkdir -p /app/data/ca /app/data/logs

EXPOSE 8080 3000
ENV NODE_ENV=production
CMD ["node", "server/src/index.js", "--config", "/app/ashp.json"]
