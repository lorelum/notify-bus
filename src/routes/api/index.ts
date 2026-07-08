/**
 * REST API under /api/* — admin/config endpoints consumed by the frontend.
 *
 * STATUS: scaffold. CRUD lands in M3; the frontend wires up in M4–M6.
 *
 * Planned surface (see README + PRD §7):
 *   GET    /api/routes            list routes
 *   POST   /api/routes            create route
 *   PUT    /api/routes/:id        update route
 *   DELETE /api/routes/:id        delete route
 *   GET    /api/channels          list channels
 *   POST   /api/channels          create channel
 *   PUT    /api/channels/:id      update channel
 *   DELETE /api/channels/:id      delete channel
 *   GET    /api/templates         list templates
 *   PUT    /api/templates/:id     update template
 *   GET    /api/logs?limit=       recent logs
 *   POST   /api/test              send a test message
 *
 * Auth: NONE in v1. Assumes network isolation / reverse proxy. The admin API
 * is privileged — it can read/edit channel credentials. See SECURITY.md.
 *
 * Eden treaty exposes this typed to the frontend — the main reason we picked
 * Elysia. Keep the route definitions here so Eden can reflect over them.
 */
import { Elysia, t } from "elysia";

export const apiRoute = new Elysia({ prefix: "/api" })
  .get("/", () => ({
    service: "notify-bus",
    version: "0.0.0-dev",
    endpoints: ["routes", "channels", "templates", "logs", "test"],
  }))
  .get("/routes", () => {
    // M3: read from sqlite
    return { routes: [] as unknown[] };
  })
  .get("/channels", () => {
    // M3: read from sqlite, mask webhook urls
    return { channels: [] as unknown[] };
  })
  .get("/templates", () => {
    // M3: read from sqlite
    return { templates: [] as unknown[] };
  })
  .get("/logs", ({ query }) => {
    // M3/M6: read from sqlite, default limit 50
    const limit = Math.min(Number(query.limit ?? 50), 100);
    return { logs: [] as unknown[], limit };
  })
  .post("/test", ({ body }) => {
    // M6: simulate an event through the pipeline + dispatch
    return { status: "not_implemented", received: body };
  }, {
    body: t.Object({
      eventType: t.String(),
      repo: t.Optional(t.String()),
      channelId: t.Number(),
    }),
  });
