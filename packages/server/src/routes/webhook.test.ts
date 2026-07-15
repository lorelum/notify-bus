import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { buildWebhookRoute } from "./webhook";
import type { AdapterRegistry, ChannelAdapter } from "../lib/adapters/types";
import type { SeedConfig } from "../lib/config";
import type { EventMessage } from "../types";

const SECRET = "webhook-secret";

/** A fake adapter that records what it received and returns a canned result. */
function makeFakeAdapter(result: "success" | "fail"): { adapter: ChannelAdapter; calls: EventMessage[] } {
  const calls: EventMessage[] = [];
  const adapter: ChannelAdapter = {
    type: "feishu",
    capabilities: {
      messageTypes: ["interactive"] as const,
      supportsCards: true,
      displayName: "FakeFeishu",
    },
    async send(message: EventMessage) {
      calls.push(message);
      return result === "success"
        ? { status: "success" }
        : { status: "fail", error: { kind: "unknown", detail: "boom" } };
    },
  };
  return { adapter, calls };
}

const config: SeedConfig = {
  channels: [
    { name: "team", type: "feishu", webhook_url: "https://x", enabled: true },
  ],
  routes: [{ name: "all", match_repo: "*", target_channel: "team" }],
};

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function buildApp(adapters: AdapterRegistry, secret = SECRET) {
  // The route instance is itself an Elysia app with `.handle()`.
  return buildWebhookRoute({ config, adapters, secret });
}

const PUSH_BODY = JSON.stringify({
  repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
  sender: { login: "alice", avatar_url: "https://gh/alice.png" },
  ref: "refs/heads/main",
});

async function postWebhook(
  app: { handle: (req: Request) => Promise<Response> },
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const res = await app.handle(
    new Request("http://localhost/webhook", {
      method: "POST",
      headers,
      body,
    }),
  );
  return { status: res.status, json: await res.json() };
}

describe("webhook route", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    // The adapter here is fake, so fetch is never called; but guard anyway.
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}"))) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("acks a ping event without dispatching", async () => {
    const { adapter, calls } = makeFakeAdapter("success");
    const app = buildApp(new Map([["feishu", adapter]]));
    const { status, json } = await postWebhook(app, "{}", {
      "x-github-event": "ping",
      "x-hub-signature-256": sign("{}", SECRET),
    });
    expect(status).toBe(200);
    expect((json as { status: string }).status).toBe("ok");
    expect(calls.length).toBe(0);
  });

  it("rejects a bad signature with 401", async () => {
    const { adapter } = makeFakeAdapter("success");
    const app = buildApp(new Map([["feishu", adapter]]));
    const { status, json } = await postWebhook(app, PUSH_BODY, {
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=deadbeef",
    });
    expect(status).toBe(401);
    expect((json as { status: string }).status).toBe("error");
  });

  it("dispatches on a valid signature + matching route", async () => {
    const { adapter, calls } = makeFakeAdapter("success");
    const app = buildApp(new Map([["feishu", adapter]]));
    const { status, json } = await postWebhook(app, PUSH_BODY, {
      "x-github-event": "push",
      "x-hub-signature-256": sign(PUSH_BODY, SECRET),
    });
    expect(status).toBe(200);
    expect((json as { status: string }).status).toBe("success");
    expect(calls.length).toBe(1);
    // The rendered message reached the adapter.
    expect(calls[0]?.formatted?.body).toContain("org/repo");
  });

  it("returns success even when the adapter fails (logs, doesn't crash)", async () => {
    const { adapter } = makeFakeAdapter("fail");
    const app = buildApp(new Map([["feishu", adapter]]));
    const { status, json } = await postWebhook(app, PUSH_BODY, {
      "x-github-event": "push",
      "x-hub-signature-256": sign(PUSH_BODY, SECRET),
    });
    expect(status).toBe(200);
    expect((json as { status: string }).status).toBe("fail");
  });

  it("skips verification when no secret is configured (dev mode)", async () => {
    const { adapter, calls } = makeFakeAdapter("success");
    const app = buildApp(new Map([["feishu", adapter]]), "");
    const { status } = await postWebhook(app, PUSH_BODY, {
      "x-github-event": "push",
      // no signature header
    });
    expect(status).toBe(200);
    expect(calls.length).toBe(1);
  });

  it("returns 400 on a non-JSON body", async () => {
    const { adapter } = makeFakeAdapter("success");
    const app = buildApp(new Map([["feishu", adapter]]));
    const { status, json } = await postWebhook(app, "not-json", {
      "x-github-event": "push",
      "x-hub-signature-256": sign("not-json", SECRET),
    });
    expect(status).toBe(400);
    expect((json as { status: string }).status).toBe("error");
  });
});

describe("webhook route with no matching route", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}"))) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns no_route when config has no matching route", async () => {
    const { adapter, calls } = makeFakeAdapter("success");
    const emptyConfig: SeedConfig = { channels: config.channels, routes: [] };
    const app = buildWebhookRoute({
      config: emptyConfig,
      adapters: new Map([["feishu", adapter]]),
      secret: SECRET,
    });
    const { status, json } = await postWebhook(app, PUSH_BODY, {
      "x-github-event": "push",
      "x-hub-signature-256": sign(PUSH_BODY, SECRET),
    });
    expect(status).toBe(200);
    expect((json as { status: string }).status).toBe("no_route");
    expect(calls.length).toBe(0);
  });
});
