import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { buildWebhookRoute } from "./webhook";
import { feishuAdapter } from "../lib/adapters/feishu";
import type { AdapterRegistry, ChannelAdapter } from "../lib/adapters/types";
import type { SeedConfig } from "../lib/config";
import type { EventMessage } from "../types";

const SECRET = "webhook-secret";

/** A fake adapter that records what it received and returns a canned result. */
function makeFakeAdapter(result: "success" | "fail"): {
  adapter: ChannelAdapter;
  calls: EventMessage[];
} {
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
  channels: [{ name: "team", type: "feishu", webhook_url: "https://x", enabled: true }],
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

/** A push body carrying the repository's own default branch. */
function pushBody(ref: string): string {
  return JSON.stringify({
    ref,
    repository: { full_name: "org/repo", html_url: "https://gh/o/r", default_branch: "main" },
    sender: { login: "alice", avatar_url: "" },
  });
}

/** A completed `workflow_run` body carrying one conclusion. */
function runBody(conclusion: string): string {
  return JSON.stringify({
    action: "completed",
    repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
    sender: { login: "alice", avatar_url: "" },
    workflow_run: {
      name: "CI",
      status: "completed",
      conclusion,
      head_branch: "main",
      html_url: "https://gh/o/r/actions/runs/81",
    },
  });
}

function elementsOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/** Every button in a sent card, including the ones nested in a column_set. */
function buttonsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const card = payload.card as { body: { elements: unknown } };
  const buttons: Array<Record<string, unknown>> = [];
  for (const element of elementsOf(card.body.elements)) {
    if (element.tag === "button") buttons.push(element);
    for (const column of elementsOf(element.columns)) {
      for (const inner of elementsOf(column.elements)) {
        if (inner.tag === "button") buttons.push(inner);
      }
    }
  }
  return buttons;
}

/** The parts of a sent card these tests assert on. */
interface SentCardHeader {
  template: string;
  title: { content: string };
  text_tag_list?: Array<{ text: { content: string } }>;
}

function headerOf(payload: Record<string, unknown>): SentCardHeader {
  return (payload.card as { header: SentCardHeader }).header;
}

function labelsOf(payload: Record<string, unknown>): string[] {
  return buttonsOf(payload).map((button) => (button.text as { content: string }).content);
}

function targetsOf(payload: Record<string, unknown>): Array<string | undefined> {
  return buttonsOf(payload).map(
    (button) => (button.behaviors as Array<{ default_url?: string }>)[0]?.default_url,
  );
}

/** Every markdown `content` in a sent card, joined: the card's own text. */
function markdownOf(payload: Record<string, unknown>): string {
  const card = payload.card as { body: { elements: unknown } };
  const texts: string[] = [];
  const collect = (elements: Array<Record<string, unknown>>): void => {
    for (const element of elements) {
      if (element.tag === "markdown" && typeof element.content === "string") {
        texts.push(element.content);
      }
      for (const column of elementsOf(element.columns)) {
        collect(elementsOf(column.elements));
      }
    }
  };
  collect(elementsOf(card.body.elements));
  return texts.join("\n");
}

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
    expect(calls[0]?.event).toBe("push");
    expect(calls[0]?.repository.full_name).toBe("org/repo");
    // This config configures no template, so the body is empty by default: the
    // card builders render the event themselves, and a generic fallback body
    // could only repeat what the card already shows (#16).
    expect(calls[0]?.formatted?.body).toBe("");
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

describe("webhook route normalizes org-scoped events", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}"))) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("derives repo name + url from `organization` when `repository` is absent (#6)", async () => {
    const { adapter, calls } = makeFakeAdapter("success");
    const app = buildWebhookRoute({
      config,
      adapters: new Map([["feishu", adapter]]),
      secret: SECRET,
    });
    // Org-scoped payload: no top-level `repository`, has `organization`.
    const body = JSON.stringify({
      action: "member_added",
      membership: {
        role: "member",
        user: { login: "newperson", html_url: "https://github.com/newperson" },
      },
      organization: { login: "lorelum", html_url: "https://github.com/lorelum" },
      sender: { login: "admin", avatar_url: "" },
    });
    const { status, json } = await postWebhook(app, body, {
      "x-github-event": "organization",
      "x-hub-signature-256": sign(body, SECRET),
    });
    expect(status).toBe(200);
    // The route matched and dispatched (catch-all route) and the response
    // carries the derived org name, NOT "unknown/unknown".
    expect((json as { repo?: string }).repo).toBe("lorelum");
    expect(calls.length).toBe(1);
    // The message that reached the adapter also has the org-derived name.
    expect(calls[0]?.repository.full_name).toBe("lorelum");
    expect(calls[0]?.repository.html_url).toBe("https://github.com/lorelum");
  });
});

describe("webhook route with explicit exclusions", () => {
  it("returns ignored and does not dispatch", async () => {
    const { adapter, calls } = makeFakeAdapter("success");
    const quietConfig: SeedConfig = {
      channels: config.channels,
      routes: [{ name: "quiet", match_repo: "*", exclude_event: "create", target_channel: "team" }],
    };
    const app = buildWebhookRoute({
      config: quietConfig,
      adapters: new Map([["feishu", adapter]]),
      secret: SECRET,
    });
    const body = JSON.stringify({
      repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
      sender: { login: "alice", avatar_url: "" },
      ref: "feature/x",
      ref_type: "branch",
    });
    const { status, json } = await postWebhook(app, body, {
      "x-github-event": "create",
      "x-hub-signature-256": sign(body, SECRET),
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      status: "ignored",
      event: "create",
      route: "quiet",
      reason: "exclude_event",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("webhook route with a payload condition", () => {
  const pushConfig: SeedConfig = {
    channels: config.channels,
    routes: [
      {
        name: "default-branch-only",
        match_repo: "*",
        match_event: "push",
        match_payload: [{ ref: "refs/heads/$default_branch" }],
        target_channel: "team",
      },
    ],
  };

  function appFor() {
    const { adapter, calls } = makeFakeAdapter("success");
    return {
      app: buildWebhookRoute({
        config: pushConfig,
        adapters: new Map([["feishu", adapter]]),
        secret: SECRET,
      }),
      calls,
    };
  }

  it("returns ignored with the payload reason and does not dispatch", async () => {
    const { app, calls } = appFor();
    const body = pushBody("refs/heads/feature/x");
    const { status, json } = await postWebhook(app, body, {
      "x-github-event": "push",
      "x-hub-signature-256": sign(body, SECRET),
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      status: "ignored",
      event: "push",
      route: "default-branch-only",
      reason: "match_payload",
    });
    expect(calls).toHaveLength(0);
  });

  it("dispatches a push the condition covers", async () => {
    const { app, calls } = appFor();
    const body = pushBody("refs/heads/main");
    const { json } = await postWebhook(app, body, {
      "x-github-event": "push",
      "x-hub-signature-256": sign(body, SECRET),
    });
    expect(json).toMatchObject({ status: "success", route: "default-branch-only" });
    expect(calls).toHaveLength(1);
  });

  it("still reports an event no route names as no_route", async () => {
    // The other half of the distinction: nothing wanted this event at all,
    // which must not read as a policy refusal.
    const { app, calls } = appFor();
    const body = JSON.stringify({
      action: "created",
      repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
      sender: { login: "alice", avatar_url: "" },
    });
    const { json } = await postWebhook(app, body, {
      "x-github-event": "issues",
      "x-hub-signature-256": sign(body, SECRET),
    });
    expect(json).toMatchObject({ status: "no_route", event: "issues" });
    expect(calls).toHaveLength(0);
  });
});

describe("webhook route with a failures-only result policy (#35)", () => {
  const failuresOnly: SeedConfig = {
    channels: [
      { name: "team", type: "feishu", webhook_url: "https://feishu.example/hook", enabled: true },
    ],
    routes: [
      {
        name: "ci-failures",
        match_repo: "*",
        match_event: "workflow_run",
        match_payload: [{ action: "completed", "workflow_run.conclusion": "failure" }],
        target_channel: "team",
      },
      {
        name: "deployment-failures",
        match_repo: "*",
        match_event: "deployment_status",
        match_payload: [{ "deployment_status.state": "failure" }],
        target_channel: "team",
      },
    ],
  };

  const originalFetch = globalThis.fetch;
  let sent: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    sent = [];
    // The real adapter, with the one network call it makes replaced: what this
    // inspects is the payload Feishu would have received.
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(
        new Response(JSON.stringify({ code: 0, data: { message_id: "om_1" } })),
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function app() {
    return buildWebhookRoute({
      config: failuresOnly,
      adapters: new Map([["feishu", feishuAdapter]]),
      secret: SECRET,
    });
  }

  it("sends the failure card, with the run's conclusion and target", async () => {
    const body = runBody("failure");
    const { json } = await postWebhook(app(), body, {
      "x-github-event": "workflow_run",
      "x-hub-signature-256": sign(body, SECRET),
    });
    expect(json).toMatchObject({ status: "success", route: "ci-failures", channel: "team" });
    expect(sent).toHaveLength(1);

    const payload = sent[0]!;
    expect(payload.msg_type).toBe("interactive");
    expect((payload.card as { schema: string }).schema).toBe("2.0");
    expect(headerOf(payload).template).toBe("red");
    expect(headerOf(payload).title.content).toBe("⚙️ CI");
    expect(headerOf(payload).text_tag_list?.[0]?.text.content).toBe("failure");
    expect(labelsOf(payload)).toEqual(["View Run", "View Repo"]);
    expect(targetsOf(payload)).toEqual(["https://gh/o/r/actions/runs/81", "https://gh/o/r"]);
  });

  it("calls no channel for a successful run", async () => {
    const body = runBody("success");
    const { json } = await postWebhook(app(), body, {
      "x-github-event": "workflow_run",
      "x-hub-signature-256": sign(body, SECRET),
    });
    expect(json).toMatchObject({
      status: "ignored",
      route: "ci-failures",
      reason: "match_payload",
    });
    expect(sent).toHaveLength(0);
  });

  it("sends a deployment failure with its environment target", async () => {
    const body = JSON.stringify({
      action: "created",
      repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
      sender: { login: "alice", avatar_url: "" },
      deployment_status: {
        state: "failure",
        environment: "production",
        environment_url: "https://prod.example",
      },
      deployment: { ref: "main" },
    });
    const { json } = await postWebhook(app(), body, {
      "x-github-event": "deployment_status",
      "x-hub-signature-256": sign(body, SECRET),
    });
    expect(json).toMatchObject({ status: "success", route: "deployment-failures" });
    expect(sent).toHaveLength(1);

    const payload = sent[0]!;
    expect(headerOf(payload).template).toBe("red");
    expect(headerOf(payload).title.content).toBe("🚀 Deployment");
    expect(headerOf(payload).text_tag_list?.[0]?.text.content).toBe("failure");
    expect(labelsOf(payload)).toEqual(["View Environment", "View Repo"]);
    expect(targetsOf(payload)).toEqual(["https://prod.example", "https://gh/o/r"]);
  });
});

describe("webhook route with a mention-only comment route (#36)", () => {
  const mentionOnly: SeedConfig = {
    channels: [
      {
        name: "team",
        type: "feishu",
        webhook_url: "https://feishu.example/hook",
        enabled: true,
        mention_map: {
          alice: "ou_alice",
          bob: "ou_bob",
          carol: "ou_carol",
          dave: "ou_dave",
          erin: "ou_erin",
          frank: "ou_frank",
        },
      },
    ],
    routes: [
      {
        name: "mention-only",
        match_repo: "*",
        match_event: "issue_comment",
        mention_only: true,
        target_channel: "team",
      },
    ],
  };

  const COMMENT_URL = "https://gh/o/r/issues/42#issuecomment-1";

  const originalFetch = globalThis.fetch;
  let sent: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    sent = [];
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(
        new Response(JSON.stringify({ code: 0, data: { message_id: "om_1" } })),
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function app() {
    return buildWebhookRoute({
      config: mentionOnly,
      adapters: new Map([["feishu", feishuAdapter]]),
      secret: SECRET,
    });
  }

  /** A comment body as GitHub sends it, written by a login the comment event names. */
  function commentBody(body: string, author = "carol"): string {
    return JSON.stringify({
      action: "created",
      repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
      sender: { login: author, avatar_url: "" },
      issue: { number: 42, title: "Login broken", html_url: "https://gh/o/r/issues/42" },
      comment: { body, html_url: COMMENT_URL, user: { login: author } },
    });
  }

  async function post(body: string) {
    const response = await postWebhook(app(), body, {
      "x-github-event": "issue_comment",
      "x-hub-signature-256": sign(body, SECRET),
    });
    return response.json as { status: string; reason?: string; route?: string };
  }

  it("sends one card mentioning every mapped person, once each", async () => {
    const json = await post(commentBody("@alice could you look? @bob too — thanks @Alice"));
    expect(json).toMatchObject({ status: "success", route: "mention-only" });
    // One GitHub event, one card — never one card per person.
    expect(sent).toHaveLength(1);
    const card = markdownOf(sent[0]!);
    expect(card).toContain("<at id=ou_alice></at> <at id=ou_bob></at>");
    // `@Alice` was the same person as `@alice`, so there is no third mention.
    expect(card.split("<at id=").length - 1).toBe(2);
    expect(targetsOf(sent[0]!)).toEqual([COMMENT_URL, "https://gh/o/r"]);
  });

  it("caps the mentions in that one card", async () => {
    const everyone = "@alice @bob @carol @dave @erin @frank";
    const json = await post(commentBody(everyone));
    expect(json).toMatchObject({ status: "success" });
    expect(sent).toHaveLength(1);
    const mentions = markdownOf(sent[0]!).split("<at id=").length - 1;
    expect(mentions).toBe(5);
  });

  it("calls no channel for a comment that names nobody mapped", async () => {
    const json = await post(commentBody("anyone around? cc @stranger"));
    expect(json).toMatchObject({
      status: "ignored",
      route: "mention-only",
      reason: "mention_only",
    });
    expect(sent).toHaveLength(0);
  });

  it("calls no channel for a comment from an author the channel does not map", async () => {
    const json = await post(commentBody("@alice please review", "stranger"));
    expect(json).toMatchObject({ status: "ignored", reason: "mention_only" });
    expect(sent).toHaveLength(0);
  });
});

describe("webhook route with a review request (#36)", () => {
  const reviewRequests: SeedConfig = {
    channels: [
      {
        name: "team",
        type: "feishu",
        webhook_url: "https://feishu.example/hook",
        enabled: true,
        mention_map: { Octocat: "ou_octocat" },
      },
    ],
    routes: [
      {
        name: "pull-requests",
        match_repo: "*",
        match_event: "pull_request",
        target_channel: "team",
      },
    ],
  };

  const originalFetch = globalThis.fetch;
  let sent: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    sent = [];
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(
        new Response(JSON.stringify({ code: 0, data: { message_id: "om_1" } })),
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A review request: the whole chain from YAML to the card, in one payload. */
  async function post(reviewer: string) {
    const body = JSON.stringify({
      action: "review_requested",
      number: 7,
      repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
      sender: { login: "alice", avatar_url: "" },
      pull_request: {
        title: "Add login",
        html_url: "https://gh/o/r/pull/7",
        head: { ref: "feature/login" },
        base: { ref: "main" },
      },
      requested_reviewer: { login: reviewer },
    });
    const response = await postWebhook(
      buildWebhookRoute({
        config: reviewRequests,
        adapters: new Map([["feishu", feishuAdapter]]),
        secret: SECRET,
      }),
      body,
      { "x-github-event": "pull_request", "x-hub-signature-256": sign(body, SECRET) },
    );
    return response.json as { status: string; route?: string };
  }

  it("mentions the reviewer the channel maps, inside the PR card", async () => {
    // The map travels YAML → seedChannelToConfig → adapter → buildCard; a rename
    // anywhere on that path would show up here as a plain name instead of an @.
    expect(await post("octocat")).toMatchObject({ status: "success", route: "pull-requests" });
    expect(sent).toHaveLength(1);
    expect(markdownOf(sent[0]!)).toContain("👥 Review requested: <at id=ou_octocat></at>");
    // One PR card, with its own target — the request adds a line, not a card.
    expect(targetsOf(sent[0]!)).toContain("https://gh/o/r/pull/7");
  });

  it("names a reviewer the channel does not map, without a mention", async () => {
    expect(await post("stranger")).toMatchObject({ status: "success" });
    const card = markdownOf(sent[0]!);
    expect(card).toContain("👥 Review requested: **stranger**");
    expect(card).not.toContain("<at");
  });
});
