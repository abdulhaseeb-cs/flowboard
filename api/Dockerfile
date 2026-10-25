# =====================================================================
# FlowBoard API + worker — multi-stage build
# ONE image, two roles:
#   API:    CMD ["node", "src/server.js"]   (default)
#   worker: command: ["node", "src/worker.js"]   (set in docker-compose.yml)
# Build: docker build -t flowboard-api:1.0.0 ./api
# =====================================================================

# ---------- Stage 1: production dependencies ----------
FROM node:22-alpine AS deps
WORKDIR /app
# Manifests first => this layer is cached until dependencies change
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------- Stage 2: runtime ----------
FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="flowboard-api" \
      org.opencontainers.image.description="FlowBoard REST + WebSocket API and background worker" \
      org.opencontainers.image.version="1.0.0"

ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_DIR=/app/uploads

WORKDIR /app

# Upload dir owned by the unprivileged "node" user; Docker copies this
# ownership into the named volume the first time it is mounted.
RUN mkdir -p /app/uploads && chown node:node /app/uploads

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health/live || exit 1

# Exec form => node is PID 1 and receives SIGTERM for graceful shutdown
CMD ["node", "src/server.js"]
