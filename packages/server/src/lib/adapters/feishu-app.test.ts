import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { createFeishuAppAdapter } from "./feishu-app";
import { createFeishuAppClient } from "./feishu-app-client";
import { createCommentThreadStore } from "../db/comment-threads";
import type { EventMessage } from "../../types";
import { buildWebhookRoute } from "../../routes/webhook";

const config = {
  appId: "cli_test",
  appSecret: "fixture-credential",
  chatId: "oc_test",
  mentionMap: { Alice: "ou_alice", bob: "ou_bob", alias: "ou_bob" },
};
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function comment(id: number, body: string, number = 1, event = "issue_comment"): EventMessage {
  return {
    id: `delivery-${id}`,
    event,
    action: "created",
    repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
    actor: { login: "alice", avatar_url: "" },
    metadata: {},
    payload: {
      comment: {
        id,
        body,
        html_url: "https://github.com/org/repo/issues/1#issuecomment-1",
        user: { login: "alice" },
      },
      ...(event === "issue_comment"
        ? { issue: { number, title: "Discussion" } }
        : { pull_request: { number, title: "Discussion" } }),
    },
  };
}

const walk = (elements: Record<string, unknown>[]): Record<string, unknown>[] =>
  elements.flatMap((element) => {
    if (element.tag === "button") return [element];
    if (element.tag === "column_set")
      return (element.columns as { elements: Record<string, unknown>[] }[]).flatMap((column) =>
        walk(column.elements),
      );
    return [];
  });

describe("feishu_app comment threads", () => {
  const originalFetch = globalThis.fetch;
  let db: Database;
  let time: number;
  let calls: { url: string; body: Record<string, unknown>; headers: Headers }[];
  let failure: number;
  let store: ReturnType<typeof createCommentThreadStore>;
  let adapter: ReturnType<typeof createFeishuAppAdapter>;
  let serial: number;
  beforeEach(() => {
    db = new Database(":memory:");
    store = createCommentThreadStore(db);
    time = 100000;
    serial = 0;
    failure = 0;
    calls = [];
    adapter = createFeishuAppAdapter(
      () => store,
      createFeishuAppClient(() => time),
    );
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });
      if (String(url).includes("tenant_access_token"))
        return response({ code: 0, tenant_access_token: "fixture-access", expire: 7200 });
      if (failure) return response({ code: failure, msg: config.appSecret });
      return response({ code: 0, data: { message_id: `om_${++serial}`, thread_id: "omt_1" } });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });
  const messageCalls = () => calls.filter((call) => !call.url.includes("tenant_access_token"));
  const cardOf = (index: number) =>
    JSON.parse(String(messageCalls()[index]?.body.content)) as {
      schema: string;
      header: { title: { tag: string; content: string }; template: string };
      body: { elements: Record<string, unknown>[] };
    };
  function buttonsOf(index: number): Record<string, unknown>[] {
    return walk(cardOf(index).body.elements);
  }
  const textOf = (index: number) =>
    cardOf(index)
      .body.elements.map((el) => (typeof el.content === "string" ? el.content : ""))
      .join("\n");

  it("activates once, replies without @ after adapter restart, then @ in the same thread", async () => {
    expect(await adapter.send(comment(1, "@BOB @alias"), config)).toEqual({
      status: "success",
      messageId: "om_1",
    });
    adapter = createFeishuAppAdapter(
      () => createCommentThreadStore(db),
      createFeishuAppClient(() => time),
    );
    await adapter.send(comment(2, "no mention"), config);
    await adapter.send(comment(3, "@bob again"), config);
    expect(messageCalls()[0]?.url).toEndWith("/messages?receive_id_type=chat_id");
    expect(messageCalls()[0]?.body.receive_id).toBe("oc_test");
    expect(
      messageCalls()
        .slice(1)
        .map((call) => call.url),
    ).toEqual(Array(2).fill("https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply"));
    expect(messageCalls()[1]?.body.reply_in_thread).toBe(true);
    expect(textOf(0).match(/<at id=/g)).toHaveLength(1);
    expect(textOf(1)).not.toContain("<at");
    expect(textOf(2)).toContain("<at id=ou_bob></at>");
  });

  it("sends schema 2.0 cards for roots and replies, with shared blue headers and exact comment links", async () => {
    await adapter.send(comment(1, "@bob hello"), config);
    await adapter.send(comment(2, "reply"), config);
    for (const index of [0, 1]) {
      expect(messageCalls()[index]?.body.msg_type).toBe("interactive");
      expect(cardOf(index).schema).toBe("2.0");
      expect(cardOf(index).header).toMatchObject({
        title: { tag: "plain_text", content: "💬 Comment on Issue #1" },
        template: "blue",
      });
      const buttons = buttonsOf(index);
      expect(buttons.map((button) => button.text)).toEqual([
        { tag: "plain_text", content: "View Comment" },
        { tag: "plain_text", content: "View Repo" },
      ]);
      expect(buttons[0]?.behaviors).toEqual([
        { type: "open_url", default_url: "https://github.com/org/repo/issues/1#issuecomment-1" },
      ]);
    }
  });

  it("uses PR labels for both PR conversation and inline comments", async () => {
    const page = comment(1, "@bob");
    page.payload.issue = {
      number: 1,
      title: "PR discussion",
      pull_request: { url: "https://api.github.com/repos/org/repo/pulls/1" },
    };
    await adapter.send(page, config);
    await adapter.send(comment(2, "inline", 1, "pull_request_review_comment"), config);
    expect(cardOf(0).header.title.content).toBe("💬 Comment on PR #1");
    expect(cardOf(1).header.title.content).toBe("💬 Comment on PR #1");
    expect(messageCalls()[1]?.url).toEndWith("/om_1/reply");
  });

  it("replies with a card to a persisted root from the previous text implementation", async () => {
    const topic = JSON.stringify([config.appId, config.chatId, "org/repo", 1]);
    store.save(topic, "issue_comment:1", "om_old_text", true);
    await adapter.send(comment(2, "new reply"), config);
    expect(messageCalls()[0]?.url).toEndWith("/om_old_text/reply");
    expect(messageCalls()[0]?.body.msg_type).toBe("interactive");
    expect(messageCalls()[0]?.body.reply_in_thread).toBe(true);
  });

  it("sanitizes markup and truncates long bodies while keeping the original comment button", async () => {
    await adapter.send(comment(1, "<at id=all></at>" + "x".repeat(400)), config);
    expect(textOf(0)).toContain("&#60;at id=all&#62;");
    expect(textOf(0)).not.toContain("<at id=all>");
    expect(textOf(0)).toContain("…");
    expect(textOf(0)).not.toContain("x".repeat(400));
    expect(buttonsOf(0).length > 0).toBe(true);
  });

  it("does not trust stale mention metadata or mutate the source event", async () => {
    const event = comment(1, "plain");
    event.metadata = { mentions: { logins: ["bob"], userIds: ["ou_bob"] } };
    const before = JSON.stringify(event);
    await adapter.send(event, config);
    expect(textOf(0)).not.toContain("<at id=");
    expect(JSON.stringify(event)).toBe(before);
  });

  it("labels a missing-comment-link fallback as View PR rather than View Issue", async () => {
    const event = comment(1, "plain", 1, "pull_request_review_comment");
    (event.payload.comment as Record<string, unknown>).html_url = undefined;
    event.payload.pull_request = { number: 1, html_url: "https://github.com/org/repo/pull/1" };
    await adapter.send(event, config);
    const buttons = buttonsOf(0);
    expect(buttons[0]?.text).toEqual({ tag: "plain_text", content: "View PR" });
    expect(buttons[0]?.behaviors).toEqual([
      { type: "open_url", default_url: "https://github.com/org/repo/pull/1" },
    ]);
  });

  it("retains roots and receipts when reopening the database after a service restart", async () => {
    await adapter.send(comment(1, "@bob"), config);
    const bytes = db.serialize();
    db.close();
    db = Database.deserialize(bytes);
    store = createCommentThreadStore(db);
    adapter = createFeishuAppAdapter(
      () => store,
      createFeishuAppClient(() => time),
    );
    await adapter.send(comment(1, "@bob"), config);
    await adapter.send(comment(2, "plain after restart"), config);
    expect(messageCalls()).toHaveLength(2);
    expect(messageCalls()[1]?.url).toEndWith("/om_1/reply");
  });

  it("leaves unmentioned top-level comments unactivated, then activates on a mapped mention", async () => {
    await adapter.send(comment(1, "plain"), config);
    await adapter.send(comment(2, "@bob"), config);
    await adapter.send(comment(3, "plain again"), config);
    expect(messageCalls()[1]?.url).toEndWith("/messages?receive_id_type=chat_id");
    expect(messageCalls()[2]?.url).toEndWith("/om_2/reply");
  });

  it("isolates subjects, repositories, apps and chats; joins PR page and inline comments", async () => {
    await adapter.send(comment(1, "@bob"), config);
    await adapter.send(comment(2, "@bob", 2), config);
    await adapter.send(comment(3, "@bob"), { ...config, chatId: "oc_other" });
    await adapter.send(comment(4, "@bob"), { ...config, appId: "cli_other" });
    await adapter.send(
      { ...comment(5, "@bob"), repository: { full_name: "org/other", html_url: "" } },
      config,
    );
    await adapter.send(comment(6, "inline", 1, "pull_request_review_comment"), config);
    expect(
      messageCalls()
        .slice(0, 5)
        .every((call) => call.url.endsWith("/messages?receive_id_type=chat_id")),
    ).toBe(true);
    expect(messageCalls()[5]?.url).toEndWith("/om_1/reply");
  });

  it("serializes concurrent first mentions and deduplicates retried comments", async () => {
    const results = await Promise.all([
      adapter.send(comment(1, "@bob"), config),
      adapter.send(comment(2, "@bob"), config),
    ]);
    expect(results.every((result) => result.status === "success")).toBe(true);
    expect(messageCalls()[0]?.url).toEndWith("/messages?receive_id_type=chat_id");
    expect(messageCalls()[1]?.url).toEndWith("/om_1/reply");
    await adapter.send({ ...comment(1, "@bob"), id: "redelivery" }, config);
    expect(messageCalls()).toHaveLength(2);
  });

  it("reuses tokens, refreshes before expiry and never puts credentials in messages", async () => {
    await adapter.send(comment(1, "@bob"), config);
    time += 7100 * 1000;
    await adapter.send(comment(2, "plain"), config);
    expect(calls.filter((call) => call.url.includes("tenant_access_token"))).toHaveLength(1);
    time += 100 * 1000;
    await adapter.send(comment(3, "plain"), config);
    expect(calls.filter((call) => call.url.includes("tenant_access_token"))).toHaveLength(2);
    expect(messageCalls()[0]?.headers.get("authorization")).toBe("Bearer fixture-access");
    expect(JSON.stringify(messageCalls().map((call) => call.body))).not.toContain(config.appSecret);
  });

  it("shares an in-flight token request across different topics", async () => {
    await Promise.all([
      adapter.send(comment(1, "@bob", 1), config),
      adapter.send(comment(2, "@bob", 2), config),
    ]);
    expect(calls.filter((call) => call.url.includes("tenant_access_token"))).toHaveLength(1);
    expect(messageCalls()).toHaveLength(2);
  });

  it("rejects bad token responses without exposing remote response text", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        response({ code: 0, tenant_access_token: "", expire: 7200, msg: config.appSecret }),
      ),
    ) as unknown as typeof fetch;
    const result = await adapter.send(comment(1, "@bob"), config);
    expect(result).toMatchObject({ status: "fail", error: { kind: "auth" } });
    expect(JSON.stringify(result)).not.toContain(config.appSecret);
  });

  it("never marks success when the platform omits message_id", async () => {
    globalThis.fetch = mock((input: string | URL) =>
      Promise.resolve(
        response(
          String(input).includes("tenant_access_token")
            ? { code: 0, tenant_access_token: "fixture-access", expire: 7200 }
            : { code: 0, data: {} },
        ),
      ),
    ) as unknown as typeof fetch;
    expect(await adapter.send(comment(1, "@bob"), config)).toMatchObject({
      status: "fail",
      error: { kind: "unknown", detail: "Feishu app returned no message_id" },
    });
  });

  it("invalidates a rejected token and refreshes it on the next attempt", async () => {
    await adapter.send(comment(1, "@bob"), config);
    failure = 99991668;
    expect(await adapter.send(comment(2, "plain"), config)).toMatchObject({
      status: "fail",
      error: { kind: "auth" },
    });
    failure = 0;
    await adapter.send(comment(2, "plain"), config);
    expect(calls.filter((call) => call.url.includes("tenant_access_token"))).toHaveLength(2);
    expect(
      messageCalls()
        .slice(1)
        .every((call) => call.url.endsWith("/om_1/reply")),
    ).toBe(true);
  });

  it("reports unsupported-thread failures without opening another root or marking delivery", async () => {
    await adapter.send(comment(1, "@bob"), config);
    failure = 230071;
    const failed = await adapter.send(comment(2, "plain"), config);
    expect(failed).toEqual({
      status: "fail",
      error: { kind: "unknown", detail: "Feishu app HTTP 200, code 230071" },
    });
    expect(JSON.stringify(failed)).not.toContain(config.appSecret);
    failure = 0;
    await adapter.send(comment(2, "plain"), config);
    expect(
      messageCalls()
        .slice(1)
        .every((call) => call.url.endsWith("/om_1/reply")),
    ).toBe(true);
    expect(messageCalls()[1]?.body.uuid).toBe(messageCalls()[2]?.body.uuid);
  });

  it("does not persist a failed first send as a root", async () => {
    failure = 230001;
    expect((await adapter.send(comment(1, "@bob"), config)).status).toBe("fail");
    failure = 0;
    await adapter.send(comment(1, "@bob"), config);
    expect(
      messageCalls().every((call) => call.url.endsWith("/messages?receive_id_type=chat_id")),
    ).toBe(true);
  });

  it("prevents mention injection and reuses the mapped-author restriction", async () => {
    await adapter.send(comment(1, '<at user_id="all"></at> `@bob`'), config);
    expect(textOf(0)).not.toContain("<at user_id=");
    const external = comment(2, "@bob");
    external.payload.comment = { id: 2, body: "@bob", user: { login: "stranger" } };
    await adapter.send(external, config);
    await adapter.send(comment(3, "plain"), config);
    expect(messageCalls().every((call) => !call.url.endsWith("/reply"))).toBe(true);
  });

  it("rejects unsupported events/actions and invalid ids/config without requests", async () => {
    expect((await adapter.send({ ...comment(1, "@bob"), action: "edited" }, config)).status).toBe(
      "fail",
    );
    expect((await adapter.send({ ...comment(1, "@bob"), event: "push" }, config)).status).toBe(
      "fail",
    );
    expect((await adapter.send(comment(1, "@bob"), { ...config, appSecret: "" })).status).toBe(
      "fail",
    );
    expect(
      (await adapter.send(comment(1, "@bob"), { ...config, mentionMap: { bob: "all" } })).status,
    ).toBe("fail");
    expect(calls).toHaveLength(0);
  });

  it("runs GitHub webhook → route → config forwarding → root/reply, without revealing secrets", async () => {
    const app = buildWebhookRoute({
      secret: "",
      adapters: new Map([["feishu_app", adapter]]),
      config: {
        channels: [
          {
            name: "app",
            type: "feishu_app",
            app_id: config.appId,
            app_secret: config.appSecret,
            chat_id: config.chatId,
            mention_map: config.mentionMap,
          },
        ],
        routes: [
          {
            name: "comments",
            match_event: "issue_comment",
            match_action: "created",
            target_channel: "app",
          },
        ],
      },
    });
    const deliver = async (id: number, body: string) => {
      const event = comment(id, body);
      const reply = await app.handle(
        new Request("http://localhost/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "issue_comment",
            "x-github-delivery": event.id,
          },
          body: JSON.stringify({
            ...event.payload,
            action: "created",
            repository: event.repository,
            sender: event.actor,
          }),
        }),
      );
      return reply.json();
    };
    expect(await deliver(1, "@bob")).toMatchObject({ status: "success", channel: "app" });
    expect(await deliver(2, "no at")).toMatchObject({ status: "success", channel: "app" });
    expect(messageCalls()).toHaveLength(2);
    expect(messageCalls()[1]?.url).toEndWith("/om_1/reply");
  });

  it("reports local persistence failures instead of sending untracked roots", async () => {
    db.close();
    // An injected store failure mocks an unavailable database without disk access.
    adapter = createFeishuAppAdapter(() => {
      throw new Error(config.appSecret);
    });
    expect(await adapter.send(comment(1, "@bob"), config)).toEqual({
      status: "fail",
      error: { kind: "unknown", detail: "Feishu app thread persistence failed" },
    });
    expect(calls).toHaveLength(0);
    db = new Database(":memory:");
  });

  it("caps real mentions at five people", async () => {
    const mentionMap = Object.fromEntries(
      ["alice", "bob", "carl", "dave", "eve", "fred", "gina"].map((login) => [
        login,
        `ou_${login}`,
      ]),
    );
    await adapter.send(comment(1, "@bob @carl @dave @eve @fred @gina"), { ...config, mentionMap });
    expect(textOf(0).match(/<at id=/g)).toHaveLength(5);
  });

  it("returns typed network failures without exposing exception text", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error(config.appSecret)),
    ) as unknown as typeof fetch;
    const result = await adapter.send(comment(1, "@bob"), config);
    expect(result).toEqual({
      status: "fail",
      error: { kind: "network", detail: "Feishu app request failed or returned invalid JSON" },
    });
  });
});
