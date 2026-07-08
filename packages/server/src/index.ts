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
import { webhookRoute } from "./routes/webhook";
import { healthRoute } from "./routes/health";
import { apiRoute } from "./routes/api";
import { buildAdapterRegistry } from "./lib/adapters";

const PORT = Number(process.env.PORT ?? 3000);
const NODE_ENV = process.env.NODE_ENV ?? "development";
// Path to the built frontend. In a workspace, the server lives under
// packages/server/ but the built web/dist is at packages/web/dist — so this
// is configurable via env (Docker sets WEB_DIST_PATH=/app/web-dist).
const WEB_DIST_PATH = process.env.WEB_DIST_PATH ?? "../web/dist";

// Build the channel adapter registry once at startup.
// (Not yet wired into dispatch — the dispatcher lands in M1.)
const _adapterRegistry = buildAdapterRegistry();

const app = new Elysia()
  .use(healthRoute)
  .use(webhookRoute)
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
    `   adapters: ${[..._adapterRegistry.keys()].join(", ") || "(none)"}`,
  );
});
