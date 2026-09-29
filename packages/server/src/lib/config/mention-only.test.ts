/**
 * The `mention_only` route policy and the configuration it depends on (#36). The
 * policy is route-local: a comment route that does not ask for it keeps
 * delivering every comment, which is what makes it opt-in.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSeedConfig, resolveRoute } from "./index";
import type { SeedChannel, SeedConfig, SeedRoute } from "./index";
import type { EventMessage } from "../../types";

const MAP = { alice: "ou_alice", Carol: "ou_carol" };

function channel(name: string, mentionMap?: Record<string, string>): SeedChannel {
  const seed: SeedChannel = { name, type: "feishu", webhook_url: "https://x", enabled: true };
  if (mentionMap) seed.mention_map = mentionMap;
  return seed;
}

function mentionRoute(target: string, event = "issue_comment"): SeedRoute {
  return {
    name: "mention-only",
    match_repo: "*",
    match_event: event,
    mention_only: true,
    target_channel: target,
    priority: 50,
  };
}

/**
 * A comment event: who wrote it, what it says, and which action posted it. The
 * action is a parameter because a `mention_only` route reads only a comment's
 * first posting — a helper that pinned it would hide the edit case.
 */
function comment(event: string, author: string, body: string, action = "created"): EventMessage {
  return {
    id: "evt-1",
    event,
    action,
    repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
    actor: { login: author, avatar_url: "" },
    payload: {
      action,
      comment: { body, html_url: "https://gh/o/r/issues/1#issuecomment-2" },
    },
    metadata: {},
  };
}

const mapped: SeedConfig = { channels: [channel("mapped", MAP)], routes: [mentionRoute("mapped")] };

describe("mention_only · delivery", () => {
  it("delivers a comment that names a mapped login, carrying its targets", () => {
    const decision = resolveRoute(mapped, comment("issue_comment", "carol", "ping @alice please"));
    expect(decision).toMatchObject({
      kind: "matched",
      match: {
        route: { name: "mention-only" },
        channel: { name: "mapped" },
        mentions: { logins: ["alice"], userIds: ["ou_alice"] },
      },
    });
  });

  it("matches the author and the mention the same case-insensitive way", () => {
    expect(resolveRoute(mapped, comment("issue_comment", "CAROL", "ping @ALICE"))).toMatchObject({
      kind: "matched",
      match: { mentions: { userIds: ["ou_alice"] } },
    });
  });

  it("refuses a comment that names nobody mapped, under its own reason", () => {
    // Refused, not unrouted: nothing is sent to the group, and the response
    // says which policy turned it away rather than "no route wanted this".
    expect(resolveRoute(mapped, comment("issue_comment", "carol", "anyone around?"))).toMatchObject(
      {
        kind: "ignored",
        ignored: { route: { name: "mention-only" }, reason: "mention_only" },
      },
    );
    expect(resolveRoute(mapped, comment("issue_comment", "carol", "@stranger look"))).toMatchObject(
      {
        kind: "ignored",
        ignored: { reason: "mention_only" },
      },
    );
  });

  it("refuses a comment whose author the channel does not map", () => {
    // A stranger on a public repository must not be able to @ a teammate
    // through notify-bus, however they phrase the comment.
    expect(resolveRoute(mapped, comment("issue_comment", "stranger", "@alice"))).toMatchObject({
      kind: "ignored",
      ignored: { reason: "mention_only" },
    });
  });

  it("refuses a comment an edit added the mention to", () => {
    // #36's non-goals: a mention that only appeared because somebody edited the
    // comment must not ping anyone, on either comment event.
    for (const event of ["issue_comment", "pull_request_review_comment"]) {
      const config: SeedConfig = {
        channels: [channel("mapped", MAP)],
        routes: [mentionRoute("mapped", event)],
      };
      for (const action of ["edited", "deleted"]) {
        expect([
          event,
          action,
          resolveRoute(config, comment(event, "carol", "edit: cc @alice", action)).kind,
        ]).toEqual([event, action, "ignored"]);
      }
      // …and the same comment when it is first posted is delivered.
      expect(resolveRoute(config, comment(event, "carol", "cc @alice"))).toMatchObject({
        kind: "matched",
      });
    }
  });

  it("reports what the documented shape actually answers", () => {
    // The examples write `match_action: created`, so an edit is turned away by
    // that whitelist before the mention gate runs — `no_route`, not
    // `mention_only`. Without it the gate records itself. Both send nothing.
    const documented: SeedConfig = {
      channels: [channel("mapped", MAP)],
      routes: [{ ...mentionRoute("mapped"), match_action: "created" }],
    };
    expect(resolveRoute(documented, comment("issue_comment", "carol", "@alice"))).toMatchObject({
      kind: "matched",
    });
    expect(resolveRoute(documented, comment("issue_comment", "carol", "@alice", "edited"))).toEqual(
      {
        kind: "no_route",
      },
    );
    expect(
      resolveRoute(mapped, comment("issue_comment", "carol", "@alice", "edited")),
    ).toMatchObject({ kind: "ignored", ignored: { reason: "mention_only" } });
  });

  it("applies the same policy to a PR's line-by-line review comments", () => {
    const config: SeedConfig = {
      channels: [channel("mapped", MAP)],
      routes: [mentionRoute("mapped", "pull_request_review_comment")],
    };
    expect(
      resolveRoute(
        config,
        comment("pull_request_review_comment", "carol", "@alice is this a nit?"),
      ),
    ).toMatchObject({ kind: "matched", match: { mentions: { userIds: ["ou_alice"] } } });
    expect(
      resolveRoute(config, comment("pull_request_review_comment", "carol", "renaming this")),
    ).toMatchObject({ kind: "ignored", ignored: { reason: "mention_only" } });
  });

  it("keeps a channel's map on that channel", () => {
    // The same route shape against a channel with no map: nobody is mappable,
    // so nothing is delivered — the map is not a global address book.
    const config: SeedConfig = {
      channels: [channel("mapped", MAP), channel("unmapped")],
      routes: [mentionRoute("unmapped")],
    };
    expect(resolveRoute(config, comment("issue_comment", "carol", "@alice"))).toMatchObject({
      kind: "ignored",
      ignored: { reason: "mention_only" },
    });
  });
});

describe("mention_only · what it must not change", () => {
  it("leaves a comment route without the policy alone", () => {
    const firehose: SeedConfig = {
      channels: [channel("mapped", MAP)],
      routes: [
        {
          name: "all-comments",
          match_repo: "*",
          match_event: "issue_comment",
          target_channel: "mapped",
        },
      ],
    };
    // Nobody mentioned, and the author is not mapped either: still delivered,
    // and with no targets attached for the card to render.
    const decision = resolveRoute(firehose, comment("issue_comment", "stranger", "anyone around?"));
    expect(decision).toMatchObject({ kind: "matched", match: { route: { name: "all-comments" } } });
    expect(decision.kind === "matched" && decision.match.mentions).toBeUndefined();
  });

  it("lets a later route take a comment the mention policy refused", () => {
    const config: SeedConfig = {
      channels: [channel("mapped", MAP)],
      routes: [
        mentionRoute("mapped"),
        {
          name: "all-comments",
          match_repo: "*",
          match_event: "issue_comment",
          target_channel: "mapped",
          priority: 100,
        },
      ],
    };
    expect(
      resolveRoute(config, comment("issue_comment", "stranger", "anyone around?")),
    ).toMatchObject({ kind: "matched", match: { route: { name: "all-comments" } } });
  });

  it("never mentions anybody on an event that carries no comment", () => {
    // push names a login in its commit message; that text is not an address.
    const config: SeedConfig = {
      channels: [channel("mapped", MAP)],
      routes: [{ name: "pushes", match_repo: "*", match_event: "push", target_channel: "mapped" }],
    };
    const event: EventMessage = {
      id: "evt-1",
      event: "push",
      repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
      actor: { login: "carol", avatar_url: "" },
      payload: { commits: [{ message: "ask @alice about this" }] },
      metadata: {},
    };
    const decision = resolveRoute(config, event);
    expect(decision).toMatchObject({ kind: "matched" });
    expect(decision.kind === "matched" && decision.match.mentions).toBeUndefined();
  });

  it("does not turn pull_request_review on in the shipped config", () => {
    // A review request is not a review result: the shipped routes still name
    // `pull_request` alone, and `pull_request_review` stays opt-in (#36).
    const example = loadSeedConfig(`${import.meta.dir}/../../../../../config.example.yaml`);
    if (!example) throw new Error("config.example.yaml did not load");
    expect(resolveRoute(example, comment("pull_request_review", "carol", "@alice look"))).toEqual({
      kind: "no_route",
    });
  });
});

describe("mention configuration · load time (#36)", () => {
  const tmpDir = join(import.meta.dirname, "__tmp_mention_config__");

  /** Write a config with one channel and one route, from the two YAML blocks. */
  function writeConfig(file: string, channelLines: string[], routeLines: string[]): string {
    mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, file);
    writeFileSync(
      path,
      [
        "channels:",
        "  - name: team-feishu",
        "    type: feishu",
        "    webhook_url: https://x",
        ...channelLines.map((line) => `    ${line}`),
        "routes:",
        "  - name: noisy",
        "    match_repo: '*'",
        "    target_channel: team-feishu",
        ...routeLines.map((line) => `    ${line}`),
        "",
      ].join("\n"),
    );
    return path;
  }

  it("loads a mapping and a mention-only route", () => {
    const path = writeConfig(
      "valid.yaml",
      ["mention_map:", "  octocat: REPLACE_ME_ID", "  hubber: REPLACE_ME_TOO"],
      ["match_event: issue_comment", "mention_only: true"],
    );
    const config = loadSeedConfig(path);
    expect(config?.channels?.[0]?.mention_map).toEqual({
      octocat: "REPLACE_ME_ID",
      hubber: "REPLACE_ME_TOO",
    });
    expect(config?.routes?.[0]?.mention_only).toBe(true);
  });

  const invalidMaps: Array<[string, string[]]> = [
    ["a bare key", ["mention_map:"]],
    ["a scalar", ["mention_map: 5"]],
    ["an empty map", ["mention_map: {}"]],
    ["an empty login", ["mention_map:", '  "  ": ou_x']],
    ["a key that is not a login", ["mention_map:", "  not a login: ou_x"]],
    ["an empty user id", ["mention_map:", '  octocat: ""']],
    ["a non-string user id", ["mention_map:", "  octocat: 42"]],
    ["an id that could break the markup", ["mention_map:", '  octocat: "ou_x></at>"']],
    ["a reserved name", ["mention_map:", "  all: ou_all"]],
    ["an id that addresses the whole chat", ["mention_map:", "  octocat: ALL"]],
    [
      "the same login twice, in different case",
      ["mention_map:", "  octocat: ou_a", "  OctoCat: ou_b"],
    ],
  ];

  for (const [index, [shape, lines]] of invalidMaps.entries()) {
    it(`rejects a mention_map written as ${shape}`, () => {
      const path = writeConfig(`invalid-map-${index}.yaml`, lines, ["match_event: issue_comment"]);
      expect(() => loadSeedConfig(path)).toThrow(/channel "team-feishu": mention_map/);
    });
  }

  it("rejects mention_only that is not a boolean", () => {
    const path = writeConfig(
      "flag-not-boolean.yaml",
      [],
      ["match_event: issue_comment", "mention_only: sometimes"],
    );
    expect(() => loadSeedConfig(path)).toThrow(/route "noisy": mention_only/);
  });

  it("rejects mention_only on an event that has no comment body", () => {
    // Otherwise the route looks enabled and can never deliver anything.
    const path = writeConfig("flag-on-push.yaml", [], ["match_event: push", "mention_only: true"]);
    expect(() => loadSeedConfig(path)).toThrow(/route "noisy": mention_only reads a comment body/);
  });

  it("rejects mention_only on a channel that maps nobody", () => {
    // Nobody is mappable on that channel, so nobody could ever be mentioned —
    // the same silent dead route, one step removed.
    const path = writeConfig(
      "flag-without-map.yaml",
      [],
      ["match_event: issue_comment", "mention_only: true"],
    );
    expect(() => loadSeedConfig(path)).toThrow(
      /route "noisy": mention_only needs a mention_map on channel "team-feishu"/,
    );
  });

  it("accepts a route that turns the policy off explicitly", () => {
    const path = writeConfig("flag-false.yaml", [], ["match_event: push", "mention_only: false"]);
    expect(loadSeedConfig(path)?.routes?.[0]?.mention_only).toBe(false);
  });

  it("rejects mention_only with an action whitelist that leaves out created", () => {
    // The policy only ever reads a comment's first posting, so a route that
    // excludes it could never deliver anything.
    const path = writeConfig(
      "flag-actions.yaml",
      ["mention_map:", "  octocat: REPLACE_ME_ID"],
      ["match_event: issue_comment", "match_action: opened,closed", "mention_only: true"],
    );
    expect(() => loadSeedConfig(path)).toThrow(
      /route "noisy": mention_only only delivers a comment's first posting/,
    );
  });

  it("accepts the shape the example documents: created, mapped, mention-only", () => {
    const path = writeConfig(
      "flag-created.yaml",
      ["mention_map:", "  octocat: REPLACE_ME_ID"],
      ["match_event: issue_comment", "match_action: created", "mention_only: true"],
    );
    expect(loadSeedConfig(path)?.routes?.[0]?.mention_only).toBe(true);
  });

  it("cleanup", () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
