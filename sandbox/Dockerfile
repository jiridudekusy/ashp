FROM node:22-alpine

RUN apk add --no-cache bash git curl ca-certificates

# Claude Code
RUN npm install -g @anthropic-ai/claude-code

# Non-root user (required for --dangerously-skip-permissions)
RUN addgroup -S dev && adduser -S dev -h /home/dev -s /bin/bash

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
CMD ["sleep", "infinity"]
