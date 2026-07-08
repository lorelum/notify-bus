# ────────────────────────────────────────────────────────────
# notify-bus Dockerfile — single image, Bun workspace monorepo.
# Multi-stage: build the frontend, then assemble the runtime.
# ────────────────────────────────────────────────────────────

# --- Stage 1: build the frontend -----------------------------------------
# Workspace install: a single `bun install` at root installs ALL packages
# (server + web), so no separate `bun --cwd web install` is needed.
FROM oven/bun:1.3 AS web-builder
WORKDIR /app

# Copy all three manifests + lockfile first for cache-friendly layering.
COPY package.json bun.lock* ./
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN bun install --frozen-lockfile

# Copy the rest of the source and build the frontend.
COPY tsconfig.base.json tsconfig.json ./
COPY packages/server/tsconfig.json packages/server/tsconfig.json
COPY packages/web/ packages/web/
COPY packages/server/src/ packages/server/src/
RUN cd packages/web && bun run build

# --- Stage 2: assemble the runtime ---------------------------------------
FROM oven/bun:1.3 AS runtime
WORKDIR /app

# Runtime deps only (--production prunes devDependencies).
COPY package.json bun.lock* ./
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN bun install --frozen-lockfile --production

# Server source + config.
COPY packages/server/src/ packages/server/src/
COPY packages/server/tsconfig.json packages/server/tsconfig.json
COPY tsconfig.base.json ./

# Built frontend from stage 1, copied to a fixed path so the server's
# staticPlugin can find it regardless of workspace layout.
COPY --from=web-builder /app/packages/web/dist /app/web-dist

# ★ Mount the DATA DIRECTORY, not a single .db file.
# WAL mode creates -wal and -shm sidecars that must live in the volume,
# or you lose durability on restart. See docker-compose.yml + AGENTS.md.
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV CONFIG_PATH=/app/config.yaml
ENV WEB_DIST_PATH=/app/web-dist

EXPOSE 3000

# Bun runs TS natively — no build step for the server.
CMD ["bun", "run", "packages/server/src/index.ts"]
