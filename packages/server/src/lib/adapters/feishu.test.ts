import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { feishuAdapter, signFeishu } from "./feishu";
import type { EventMessage } from "../../types";
import type { ChannelError } from "./types";

// Known-good vector for signFeishu: fixed timestamp + secret, signature
// derived the same way Feishu documents it (HMAC-SHA256, key = "ts\nsecret",
// empty message, base64 output).
const TS = 1_699_000_000;
const SECRET = "feishu-bot-secret";

function expectedSign(timestamp: number, secret: string): string {
  const key = `${timestamp}\n${secret}`;
  return createHmac("sha256", key).update("").digest("base64");
}

function buildMessage(body = "**push** on `org/repo` by alice"): EventMessage {
  return {
    id: "evt-1",
    event: "push",
    repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
    actor: { login: "alice", avatar_url: "" },
    payload: {},
    metadata: {},
    formatted: { title: "push", body },
  };
}

const WEBHOOK_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/xxx";

function mockFetchResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: ok ? "OK" : "ERR",
    headers: { "content-type": "application/json" },
  });
}

describe("signFeishu", () => {
  it("matches the independently-derived signature (known-good vector)", () => {
    expect(signFeishu(TS, SECRET)).toBe(expectedSign(TS, SECRET));
  });

  it("is deterministic for the same inputs", () => {
    expect(signFeishu(TS, SECRET)).toBe(signFeishu(TS, SECRET));
  });

  it("changes when the secret changes", () => {
    expect(signFeishu(TS, "other")).not.toBe(signFeishu(TS, SECRET));
  });
});

describe("feishuAdapter.send", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock(() =>
      Promise.resolve(mockFetchResponse({ code: 0, msg: "success" })),
    ) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns success on Feishu code 0", async () => {
    const result = await feishuAdapter.send(buildMessage(), {
      webhookUrl: WEBHOOK_URL,
    });
    expect(result).toEqual({ status: "success" });
  });

  it("returns messageId when Feishu includes one", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(mockFetchResponse({ code: 0, msg: "success", data: { message_id: "om_123" } })),
    ) as unknown as typeof fetch;
    const result = await feishuAdapter.send(buildMessage(), {
      webhookUrl: WEBHOOK_URL,
    });
    expect(result).toEqual({ status: "success", messageId: "om_123" });
  });

  it("maps an invalid-signature / auth error code to ChannelError auth", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(mockFetchResponse({ code: 9499, msg: "invalid sign" })),
    ) as unknown as typeof fetch;
    const result = await feishuAdapter.send(buildMessage(), {
      webhookUrl: WEBHOOK_URL,
      secret: SECRET,
    });
    expect(result.status).toBe("fail");
    expect((result as { error: ChannelError }).error.kind).toBe("auth");
  });

  it("maps a rate-limit code to ChannelError rate_limited", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(mockFetchResponse({ code: 11232, msg: "rate limited" })),
    ) as unknown as typeof fetch;
    const result = await feishuAdapter.send(buildMessage(), {
      webhookUrl: WEBHOOK_URL,
    });
    expect((result as { error: ChannelError }).error.kind).toBe("rate_limited");
  });

  it("returns bad_config when webhookUrl is missing", async () => {
    const result = await feishuAdapter.send(buildMessage(), {});
    expect(result.status).toBe("fail");
    expect((result as { error: ChannelError }).error.kind).toBe("bad_config");
  });

  it("returns network when fetch throws", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch;
    const result = await feishuAdapter.send(buildMessage(), {
      webhookUrl: WEBHOOK_URL,
    });
    expect(result.status).toBe("fail");
    expect((result as { error: ChannelError }).error.kind).toBe("network");
  });

  it("sends signing fields when a secret is configured", async () => {
    let captured: { url: string; body: string } | null = null;
    globalThis.fetch = mock((input: string | URL, init?: RequestInit) => {
      captured = { url: String(input), body: String(init?.body ?? "") };
      return Promise.resolve(mockFetchResponse({ code: 0, msg: "success" }));
    }) as unknown as typeof fetch;

    await feishuAdapter.send(buildMessage(), { webhookUrl: WEBHOOK_URL, secret: SECRET });

    const payload = JSON.parse(captured!.body);
    expect(payload.timestamp).toBeTypeOf("number");
    expect(payload.sign).toBeTypeOf("string");
    expect(payload.sign).toBe(expectedSign(payload.timestamp, SECRET));
    expect(payload.msg_type).toBe("interactive");
  });

  it("omits signing fields when no secret is configured", async () => {
    let captured: { body: string } | null = null;
    globalThis.fetch = mock((_input: string | URL, init?: RequestInit) => {
      captured = { body: String(init?.body ?? "") };
      return Promise.resolve(mockFetchResponse({ code: 0, msg: "success" }));
    }) as unknown as typeof fetch;

    await feishuAdapter.send(buildMessage(), { webhookUrl: WEBHOOK_URL });
    const payload = JSON.parse(captured!.body);
    expect(payload.timestamp).toBeUndefined();
    expect(payload.sign).toBeUndefined();
  });
});
