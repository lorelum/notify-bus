/**
 * notify-bus server entry point.
 *
 * Wires together:
 *   - POST /webhook   (GitHub ingestion — M1)
 *   - /api/*          (admin REST API — M3)
 *   - /health
 *   - static          (serves the built React frontend from web/dist)
 *
 * Run: `bun run src/index.ts`  (or `bun run dev` for watch mode)
 */
import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { healthRoute } from "./routes/health";
import { apiRoute } from "./routes/api";
import { buildWebhookRoute } from "./routes/webhook";
import { buildAdapterRegistry } from "./lib/adapters";
import { loadSeedConfig } from "./lib/config";

const PORT = Number(process.env.PORT ?? 3000);
const NODE_ENV = process.env.NODE_ENV ?? "development";
// Path to the built frontend. In a workspace, the server lives under
// packages/server/ but the built web/dist is at packages/web/dist — so this
// is configurable via env (Docker sets WEB_DIST_PATH=/app/web-dist).
const WEB_DIST_PATH = process.env.WEB_DIST_PATH ?? "../web/dist";
// GitHub webhook secret. If unset, signature verification is skipped (local
// dev only). Production MUST set GITHUB_WEBHOOK_SECRET.
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const CONFIG_PATH = process.env.CONFIG_PATH ?? "./config.yaml";

// Build the adapter registry + load the seed config once at startup.
const adapterRegistry = buildAdapterRegistry();
const seedConfig = loadSeedConfig(CONFIG_PATH);

const app = new Elysia()
  .use(healthRoute)
  .use(
    buildWebhookRoute({
      config: seedConfig,
      adapters: adapterRegistry,
      secret: GITHUB_WEBHOOK_SECRET,
    }),
  )
  .use(apiRoute)
  // Serve the built frontend. In dev, the frontend runs on its own Vite
  // port (5173) with a proxy to :3000 — this static plugin only matters
  // for the production single-image deploy.
  .use(staticPlugin({ assets: WEB_DIST_PATH, prefix: "/" }))
  .onError(({ code, error, set }) => {
    console.error(`[notify-bus] unhandled error (${code}):`, error);
    set.status = 500;
    return { status: "error", detail: "internal error" };
  });

app.listen(PORT, () => {
  console.log(
    `🚌 notify-bus listening on http://localhost:${PORT} (env: ${NODE_ENV})`,
  );
  console.log(
    `   adapters: ${[...adapterRegistry.keys()].join(", ") || "(none)"}`,
  );
  console.log(
    `   config: ${seedConfig ? "loaded" : "none"} · webhook secret: ${GITHUB_WEBHOOK_SECRET ? "set" : "NOT SET (verify skipped)"}`,
  );
});
