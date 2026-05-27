# ── Emeros EMS — Dockerfile ──────────────────────────────────
# Multi-stage build: deps → final image
# Data volume: mount /app/data to persist the SQLite DB + uploads

# ── Stage 1: install dependencies ────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 2: final image ──────────────────────────────────────
FROM node:22-alpine
LABEL maintainer="Puebla Services LLC"
LABEL description="Emeros — Employee Management System"

# Non-root user for security
RUN addgroup -S emeros && adduser -S emeros -G emeros

WORKDIR /app

# Copy dependencies from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy application source (data/ is excluded via .dockerignore)
COPY --chown=emeros:emeros . .

# Create data directories with correct ownership
# These will be overlaid by the volume mount at runtime
RUN mkdir -p data/uploads && chown -R emeros:emeros data

USER emeros

EXPOSE 3001

# Health check — hits the stats endpoint every 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/stats 2>/dev/null | grep -q total || exit 1

CMD ["node", "server.js"]
