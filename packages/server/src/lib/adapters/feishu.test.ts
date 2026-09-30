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
      Promise.resolve(
        mockFetchResponse({ code: 0, msg: "success", data: { message_id: "om_123" } }),
      ),
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
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("ECONNRESET")),
    ) as unknown as typeof fetch;
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

  it("posts the card's button targets unchanged (#26)", async () => {
    // The card builders choose each button's `open_url.default_url`; this pins
    // what actually goes over the wire for a comment event, whose only button
    // must open that comment — not its parent commit, PR or repository.
    let captured: { body: string } | null = null;
    globalThis.fetch = mock((_input: string | URL, init?: RequestInit) => {
      captured = { body: String(init?.body ?? "") };
      return Promise.resolve(mockFetchResponse({ code: 0, msg: "success" }));
    }) as unknown as typeof fetch;

    const commentUrl = "https://github.com/org/repo/commit/abc1234#commitcomment-9";
    const message: EventMessage = {
      id: "evt-2",
      event: "commit_comment",
      action: "created",
      repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
      actor: { login: "alice", avatar_url: "" },
      payload: { action: "created", comment: { html_url: commentUrl, body: "thanks" } },
      metadata: {},
      formatted: { title: "commit_comment", body: "" },
    };

    await feishuAdapter.send(message, { webhookUrl: WEBHOOK_URL });

    const posted = JSON.parse(captured!.body) as {
      card: { body: { elements: { tag?: string; behaviors?: { default_url?: string }[] }[] } };
    };
    const buttons = posted.card.body.elements.filter((el) => el.tag === "button");
    expect(buttons.length).toBe(1);
    expect(buttons[0]!.behaviors?.[0]?.default_url).toBe(commentUrl);
  });

  it("keeps the card header plain_text (#26)", async () => {
    // Feishu's `lark_md` support for header.title / header.subtitle is limited
    // to mentions and emoji — no markdown links, no `<a>` — so navigation must
    // stay in the button elements. Pinned so a future change cannot switch the
    // tags on the belief that header links work.
    let captured: { body: string } | null = null;
    globalThis.fetch = mock((_input: string | URL, init?: RequestInit) => {
      captured = { body: String(init?.body ?? "") };
      return Promise.resolve(mockFetchResponse({ code: 0, msg: "success" }));
    }) as unknown as typeof fetch;

    await feishuAdapter.send(buildMessage(), { webhookUrl: WEBHOOK_URL });

    const posted = JSON.parse(captured!.body) as {
      card: { header: { title: { tag: string }; subtitle?: { tag: string } } };
    };
    expect(posted.card.header.title.tag).toBe("plain_text");
    expect(posted.card.header.subtitle?.tag).toBe("plain_text");
  });
});

describe("feishuAdapter.send · push line stats", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_API_TOKEN;
  const before = "a".repeat(40);
  const after = "b".repeat(40);
  let calls: { url: string; init?: RequestInit }[];
  let posted: string[];
  let apiReply: Response | Error;

  const push = (payload: Record<string, unknown> = {}): EventMessage => ({
    ...buildMessage(""),
    payload: { before, after, commits: [{ id: after, message: "fix" }], ...payload },
  });

  beforeEach(() => {
    process.env.GITHUB_API_TOKEN = "read-only-test-token";
    calls = [];
    posted = [];
    apiReply = mockFetchResponse({
      files: [
        { additions: 8, deletions: 0 },
        { additions: 158, deletions: 6 },
      ],
    });
    globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).startsWith("https://api.github.com/")) {
        if (apiReply instanceof Error) return Promise.reject(apiReply);
        return apiReply;
      }
      posted.push(String(init?.body ?? ""));
      return mockFetchResponse({ code: 0, msg: "success" });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_API_TOKEN;
    else process.env.GITHUB_API_TOKEN = originalToken;
  });

  it("uses the full before-to-after comparison for net added/deleted lines", async () => {
    const message = push({
      commits: [
        { id: "c".repeat(40), message: "docs" },
        { id: after, message: "fix" },
      ],
      head_commit: { added: [], modified: ["only-last.ts"], removed: [] },
    });
    expect(await feishuAdapter.send(message, { webhookUrl: WEBHOOK_URL })).toEqual({
      status: "success",
    });
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.github.com/repos/org/repo/compare/${before}...${after}`,
      WEBHOOK_URL,
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer read-only-test-token" });
    expect(calls[0]?.init?.signal).toBeDefined();
    const card = posted[0]!;
    expect(card).toContain("+166");
    expect(card).toContain("-6");
    expect(card).toContain("lines");
    expect(card).toContain("2 commits");
    expect(card).not.toContain("read-only-test-token");
  });

  it("sends without guessed numbers when no token is configured", async () => {
    delete process.env.GITHUB_API_TOKEN;
    expect(await feishuAdapter.send(push(), { webhookUrl: WEBHOOK_URL })).toEqual({
      status: "success",
    });
    expect(calls.map((call) => call.url)).toEqual([WEBHOOK_URL]);
    expect(posted[0]).not.toContain("lines");
  });

  it("does not block a notification or report file counts as lines on API failure", async () => {
    apiReply = mockFetchResponse({ message: "Forbidden" }, false, 403);
    expect(await feishuAdapter.send(push(), { webhookUrl: WEBHOOK_URL })).toEqual({
      status: "success",
    });
    expect(calls).toHaveLength(2);
    expect(posted[0]).not.toContain("lines");
  });

  it("still sends the original card if the compare request times out", async () => {
    apiReply = new DOMException("timed out", "AbortError");
    expect(await feishuAdapter.send(push(), { webhookUrl: WEBHOOK_URL })).toEqual({
      status: "success",
    });
    expect(calls).toHaveLength(2);
    expect(posted[0]).not.toContain("lines");
  });

  it("omits totals that may be truncated or have missing per-file counts", async () => {
    apiReply = mockFetchResponse({
      files: Array.from({ length: 300 }, () => ({ additions: 1, deletions: 0 })),
    });
    await feishuAdapter.send(push(), { webhookUrl: WEBHOOK_URL });
    expect(posted[0]).not.toContain("lines");

    apiReply = mockFetchResponse({ files: [{ additions: 10 }] });
    await feishuAdapter.send(push(), { webhookUrl: WEBHOOK_URL });
    expect(posted[1]).not.toContain("lines");
  });

  it("skips invalid comparisons, branch creation/deletion and force pushes", async () => {
    const payloads = [
      { before: "0".repeat(40), created: true },
      { deleted: true },
      { forced: true },
      { after: "bad-sha" },
    ];
    const results = await Promise.all(
      payloads.map((payload) => feishuAdapter.send(push(payload), { webhookUrl: WEBHOOK_URL })),
    );
    expect(results).toEqual(payloads.map(() => ({ status: "success" })));
    expect(calls.map((call) => call.url)).toEqual(Array(4).fill(WEBHOOK_URL));
  });

  it("never queries GitHub for other event types", async () => {
    const message = { ...push(), event: "issues" };
    await feishuAdapter.send(message, { webhookUrl: WEBHOOK_URL });
    expect(calls.map((call) => call.url)).toEqual([WEBHOOK_URL]);
  });
});
