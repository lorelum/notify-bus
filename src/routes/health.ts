import { Elysia } from "elysia";

export const healthRoute = new Elysia().get("/health", () => ({
  status: "ok",
  service: "notify-bus",
  time: new Date().toISOString(),
}));
