/**
 * Eden treaty client — gives the frontend a fully-typed view of the server's
 * /api routes. This is the main payoff of choosing Elysia.
 *
 * STATUS: scaffold. The apiRoute in src/routes/api/index.ts is reflected here;
 * as routes gain real handlers + types, this client picks them up automatically.
 *
 * NOTE: importing server types into the frontend build requires the server's
 * types to be resolvable. For the scaffold we declare a minimal typed shape
 * locally; M4 wires the real Eden treaty import once the API stabilizes.
 */

export interface ApiChannel {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
}

export interface ApiRoute {
  id: number;
  name: string;
  match_repo: string | null;
  match_event: string | null;
  target_channel_id: number;
  priority: number;
  enabled: boolean;
}

export interface ApiLog {
  id: number;
  event_id: string | null;
  event_type: string | null;
  repo: string | null;
  result: "success" | "fail";
  error: string | null;
  created_at: string;
}

const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return (await res.json()) as T;
}

/** Minimal typed client. M4 replaces this with Eden treaty. */
export const api = {
  routes: () => get<{ routes: ApiRoute[] }>("/routes"),
  channels: () => get<{ channels: ApiChannel[] }>("/channels"),
  logs: (limit = 50) => get<{ logs: ApiLog[]; limit: number }>(`/logs?limit=${limit}`),
};
