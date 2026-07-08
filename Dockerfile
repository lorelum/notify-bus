# ────────────────────────────────────────────────────────────
# notify-bus Dockerfile — single image, Bun runtime.
# Multi-stage: build the frontend, then assemble the runtime.
# ────────────────────────────────────────────────────────────

# --- Stage 1: build the frontend -----------------------------------------
# Needs the root + web/ package.json + lockfile to install deps.
FROM oven/bun:1.3 AS web-builder
WORKDIR /app

# Copy lockfiles + manifests first for cache-friendly layering.
COPY package.json bun.lock* ./
COPY web/package.json web/package.json
RUN bun install --frozen-lockfile

# Copy the rest of the source and build the frontend.
COPY web/ web/
COPY tsconfig.json ./
RUN bun --cwd web run build

# --- Stage 2: assemble the runtime ---------------------------------------
FROM oven/bun:1.3 AS runtime
WORKDIR /app

# Runtime deps only (no devDependencies). For a scaffold this is the full
# install; once the server has more deps we can prune to production-only.
COPY package.json bun.lock* ./
COPY web/package.json web/package.json
RUN bun install --frozen-lockfile --production

# Server source.
COPY src/ src/
COPY tsconfig.json ./

# Built frontend from stage 1. Elysia's staticPlugin serves it from web/dist.
COPY --from=web-builder /app/web/dist web/dist

# ★ Mount the DATA DIRECTORY, not a single .db file.
# WAL mode creates -wal and -shm sidecars that must live in the volume,
# or you lose durability on restart. See docker-compose.yml + AGENTS.md.
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV CONFIG_PATH=/app/config.yaml

EXPOSE 3000

# Bun runs TS natively — no build step for the server.
CMD ["bun", "run", "src/index.ts"]
