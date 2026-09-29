import { describe, expect, it } from "bun:test";
import { buildCard, DEDICATED_EVENTS } from "./feishu-cards";
import { renderFormatted } from "../render";
import { findTemplate, loadSeedConfig, resolveRoute } from "../config";
import type { EventMessage } from "../../types";
import {
  cardText,
  elementMarkdown,
  findButtons,
  findButtonUrls,
  findRawButtons,
  msg,
  msgWithoutRepoUrl,
  prodCard,
} from "./feishu-card-test-helpers";

/** `n` GitHub-shaped labels, for the label-rendering tests. */
function someLabels(n: number): { name: string }[] {
  return Array.from({ length: n }, (_, i) => ({ name: `label-${i}` }));
}

// ─── helpers the describes below share ─────────────────────────────────────
//
// These sit at module scope rather than inside the `describe` that uses them
// because none of them reads a binding from its enclosing block — and oxlint's
// `consistent-function-scoping` reports a nested function that reaches only for
// imports (a same-file declaration counts as a capture, an import does not).
// The helpers that *do* capture their describe's fixtures stay where they are.

/** A PR card for `action`, with optional extra `pull_request` fields. */
const prCard = (action: string, extra: Record<string, unknown> = {}) =>
  buildCard(
    msg(
      "pull_request",
      {
        action,
        number: 1,
        pull_request: { title: "t", html_url: "u", user: { login: "x" }, ...extra },
      },
      { action },
    ),
  );

/** Resolve an action's badge colour through the card that actually emits it. */
function badgeColor(event: string, action: string): string | undefined {
  const payload: Record<string, unknown> = { action, number: 1 };
  if (event === "pull_request") {
    payload.pull_request = { title: "t", html_url: "u", user: { login: "x" } };
  }
  return buildCard(msg(event, payload, { action })).header.badges?.[0]?.color;
}

/** All markdown text in the card, concatenated. */
const textOf = (message: EventMessage): string => elementMarkdown(buildCard(message).elements);

/** A one-commit push whose commit message is `commitMessage`. */
const pushWith = (
  commitMessage: string,
  opts: { ref?: string; author?: string } = {},
): EventMessage =>
  msg(
    "push",
    {
      ref: opts.ref ?? "refs/heads/main",
      total_commits: 1,
      commits: [
        { id: "abc1234567", message: commitMessage, author: { name: opts.author ?? "Alice" } },
      ],
    },
    { ref: opts.ref ?? "refs/heads/main" },
  );

/** Buttons of a card built through the production path, in render order. */
const buttonsOf = (
  event: string,
  payload: Record<string, unknown>,
  action?: string,
): { label: string; url: string }[] => findButtons(prodCard(event, payload, action).elements);

/** Label + style of each button a card renders, for the weight assertions. */
const stylesOf = (event: string, payload: Record<string, unknown>, action?: string): string[] =>
  findRawButtons(prodCard(event, payload, action).elements).map(
    (button) => `${button.label}:${button.type}`,
  );

describe("buildCard · push", () => {
  const card = buildCard(
    msg(
      "push",
      {
        ref: "refs/heads/main",
        compare: "https://github.com/org/repo/compare/abc...def",
        pusher: { name: "alice" },
        commits: [
          { id: "0123456789abcdef", message: "fix: login\n\n细节", author: { name: "Alice" } },
          {
            id: "fedcba9876543210",
            message: "docs: readme",
            author: { name: "Alice", username: "alice" },
          },
        ],
        head_commit: { added: ["a.ts"], modified: ["b.ts", "c.ts"], removed: ["d.ts"] },
      },
      { ref: "refs/heads/main" },
    ),
  );

  it("uses a blue header with subtitle and a 'push' badge", () => {
    expect(card.header.template).toBe("blue");
    expect(card.header.title).toContain("2 commits pushed");
    expect(card.header.subtitle).toContain("org/repo");
    expect(card.header.subtitle).toContain("main");
    expect(card.header.badges?.[0]).toEqual({ text: "push", color: "blue" });
  });

  it("lists commits with short shas, capped at 5, with author pills", () => {
    const text = elementMarkdown(card.elements);
    expect(text).toContain("`0123456`");
    expect(text).toContain("fix: login");
    expect(text).toContain('<text_tag color="neutral">Alice');
  });

  it("shows colored file stats (+green / ~orange / -red)", () => {
    const text = elementMarkdown(card.elements);
    expect(text).toContain('<font color="green">+1</font>');
    expect(text).toContain('<font color="orange">~2</font>');
    expect(text).toContain('<font color="red">-1</font>');
  });

  it("includes the compare button", () => {
    expect(findButtonUrls(card.elements)).toContain(
      "https://github.com/org/repo/compare/abc...def",
    );
  });

  it("notes the overflow with '+N more commits'", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `sha${i}000000`,
      message: `commit ${i}`,
      author: { name: "Alice" },
    }));
    const c = buildCard(
      msg("push", { ref: "refs/heads/x", commits: many }, { ref: "refs/heads/x" }),
    );
    expect(elementMarkdown(c.elements)).toContain("+3 more commits");
  });
});

describe("buildCard · push · push state (#15)", () => {
  it("counts the commits array — the only count the payload carries", () => {
    // The webhook push payload has no total-count field. `total_commits` is not
    // a GitHub field (it exists on other forges) and `size`/`distinct_size`
    // appear only on the Events API; the 13 real top-level fields are
    // after/base_ref/before/commits/compare/created/deleted/forced/head_commit/
    // pusher/ref/repository/sender. Per GitHub's docs `commits` is capped at
    // 2048 entries, so its length is the push size for any realistic push.
    const commits = Array.from({ length: 7 }, (_, i) => ({
      id: `sha${i}000000`,
      message: `commit ${i}`,
      author: { name: "Alice" },
    }));
    const card = buildCard(
      msg("push", { ref: "refs/heads/main", commits }, { ref: "refs/heads/main" }),
    );
    expect(card.header.title).toBe("📦 7 commits pushed");
    expect(elementMarkdown(card.elements)).toContain("📦 7 commits");
  });

  it("does not assert an exact count when the commits array is at GitHub's cap", () => {
    // A 2048-entry array may be exactly 2048 commits or a longer push that
    // GitHub truncated, so the card must not claim "2048".
    const commits = Array.from({ length: 2048 }, (_, i) => ({
      id: `sha${i}000000`,
      message: `commit ${i}`,
      author: { name: "Alice" },
    }));
    const card = buildCard(
      msg("push", { ref: "refs/heads/main", commits }, { ref: "refs/heads/main" }),
    );
    expect(card.header.title).toBe("📦 2048+ commits pushed");
    // The commit list must not then contradict the header by asserting an exact
    // remainder: at the cap we know how many the payload holds, not how many
    // the push had.
    const overflowLine = elementMarkdown(card.elements)
      .split("\n")
      .find((line) => line.includes("2043"));
    expect(overflowLine).toContain("the push may contain more");
  });

  it("uses the singular for a one-commit push", () => {
    const card = buildCard(
      msg(
        "push",
        { ref: "refs/heads/main", commits: [{ id: "abcdefg1234", message: "one" }] },
        { ref: "refs/heads/main" },
      ),
    );
    expect(card.header.title).toBe("📦 1 commit pushed");
  });

  it("visibly marks a force push", () => {
    const card = buildCard(
      msg(
        "push",
        {
          ref: "refs/heads/main",
          forced: true,
          commits: [{ id: "abc1234567", message: "rewritten" }],
        },
        { ref: "refs/heads/main" },
      ),
    );
    expect(card.header.badges).toContainEqual({ text: "force push", color: "red" });
    expect(card.header.template).toBe("red");
  });

  it("reports a deleted branch instead of '0 commits pushed'", () => {
    // GitHub really sends `deleted: true` together with an empty `commits` array
    // and a null `head_commit` — its own published push payload example is a
    // branch deletion.
    const card = buildCard(
      msg(
        "push",
        { ref: "refs/heads/old", deleted: true, commits: [], head_commit: null },
        { ref: "refs/heads/old" },
      ),
    );
    expect(card.header.title).toBe("🌿 branch deleted");
    expect(card.header.badges).toContainEqual({ text: "branch deleted", color: "red" });
    expect(elementMarkdown(card.elements)).not.toContain("0 commits");
  });

  it("does not offer a Compare link for a deleted branch", () => {
    // A deleted branch's `after` sha is all zeros, so the target is meaningless.
    const compare = "https://github.com/org/repo/compare/aaa...000";
    const card = buildCard(
      msg(
        "push",
        { ref: "refs/heads/old", deleted: true, commits: [], compare },
        { ref: "refs/heads/old" },
      ),
    );
    expect(findButtonUrls(card.elements)).not.toContain(compare);
  });

  it("marks a branch created by the push", () => {
    const card = buildCard(
      msg(
        "push",
        { ref: "refs/heads/new", created: true, commits: [{ id: "abc1234567", message: "init" }] },
        { ref: "refs/heads/new" },
      ),
    );
    expect(card.header.badges).toContainEqual({ text: "new branch", color: "green" });
  });

  it("leaves an ordinary push marked only as a push", () => {
    const card = buildCard(
      msg(
        "push",
        { ref: "refs/heads/main", commits: [{ id: "abc1234567", message: "a" }] },
        { ref: "refs/heads/main" },
      ),
    );
    expect(card.header.badges).toEqual([{ text: "push", color: "blue" }]);
    expect(card.header.template).toBe("blue");
  });

  it("never renders more than three header badges (#30)", () => {
    // GitHub does not send these flags together, but nothing in the code held
    // that: a payload that did rendered four `text_tag_list` entries, and Feishu
    // only displays three of them. The first three now win, deliberately.
    const card = buildCard(
      msg(
        "push",
        {
          ref: "refs/heads/main",
          forced: true,
          deleted: true,
          created: true,
          commits: [{ id: "abc1234567", message: "a" }],
        },
        { ref: "refs/heads/main" },
      ),
    );
    expect(card.header.badges).toEqual([
      { text: "push", color: "blue" },
      { text: "force push", color: "red" },
      { text: "branch deleted", color: "red" },
    ]);
  });
});

describe("buildCard · pull_request", () => {
  const card = buildCard(
    msg(
      "pull_request",
      {
        action: "opened",
        number: 42,
        pull_request: {
          title: "Add login",
          html_url: "https://github.com/org/repo/pull/42",
          body: "implements the thing",
          user: { login: "bob" },
          head: { ref: "feature/x" },
          base: { ref: "main" },
          additions: 42,
          deletions: 7,
          changed_files: 3,
          merged: false,
        },
      },
      { action: "opened" },
    ),
  );

  it("uses a purple header with PR number, an action badge", () => {
    expect(card.header.template).toBe("purple");
    expect(card.header.title).toBe("🔀 PR #42");
    expect(card.header.badges?.[0]).toEqual({ text: "opened", color: "turquoise" });
  });

  it("renders colored additions/deletions/files stats", () => {
    const text = elementMarkdown(card.elements);
    expect(text).toContain('<font color="green">+42</font>');
    expect(text).toContain('<font color="red">-7</font>');
    expect(text).toContain("3 files");
  });

  it("renders the branch flow head → base", () => {
    expect(elementMarkdown(card.elements)).toContain("`feature/x` → `main`");
  });

  it("links View PR + View files buttons", () => {
    const urls = findButtonUrls(card.elements);
    expect(urls).toContain("https://github.com/org/repo/pull/42");
    expect(urls).toContain("https://github.com/org/repo/pull/42/files");
  });

  it("uses violet + merged badge when merged", () => {
    const merged = buildCard(
      msg(
        "pull_request",
        {
          action: "closed",
          number: 9,
          pull_request: { title: "t", html_url: "u", user: { login: "x" }, merged: true },
        },
        { action: "closed" },
      ),
    );
    expect(merged.header.template).toBe("violet");
    expect(merged.header.badges?.some((b) => b.text === "merged")).toBe(true);
  });

  it("puts the body in a blockquote", () => {
    expect(elementMarkdown(card.elements)).toContain("> implements the thing");
  });
});

describe("buildCard · pull_request header reflects the action (#15)", () => {
  it("keeps an open PR purple", () => {
    expect(prCard("opened").header.template).toBe("purple");
  });

  it("uses violet when merged", () => {
    expect(prCard("closed", { merged: true }).header.template).toBe("violet");
  });

  it("does not render a closed-without-merge PR like an open one", () => {
    const closed = prCard("closed");
    const opened = prCard("opened");
    expect(closed.header.template).toBe("grey");
    expect(closed.header.template).not.toBe(opened.header.template);
  });
});

describe("buildCard · action badge palette (#15)", () => {
  it("applies the palette on the fallback card, not only the dedicated builders", () => {
    // Events without a dedicated builder go through buildFallbackCard, which
    // used to hardcode a neutral badge — silently disabling the palette for the
    // ~30 event types that have no builder of their own. `label` is one of
    // those; its `deleted` action is in the palette, so the palette has to
    // reach the fallback.
    const card = buildCard(msg("label", { action: "deleted" }, { action: "deleted" }));
    // header `grey` is buildFallbackCard's signature — assert it so this test
    // cannot silently start exercising a different builder.
    expect(card.header.template).toBe("grey");
    expect(card.header.badges).toContainEqual({ text: "deleted", color: "red" });
  });

  it("gives an action the reader may need to act on a colour of its own", () => {
    const actionable: [string, string, string][] = [
      ["pull_request", "opened", "turquoise"],
      ["pull_request", "reopened", "green"],
      ["pull_request", "closed", "red"],
      ["pull_request", "ready_for_review", "blue"],
      ["pull_request", "review_requested", "orange"],
      ["pull_request", "assigned", "indigo"],
      ["pull_request", "converted_to_draft", "yellow"],
      ["repository", "transferred", "carmine"],
      ["repository", "renamed", "purple"],
      ["repository", "publicized", "red"],
    ];
    for (const [event, action, color] of actionable) {
      expect([event, action, badgeColor(event, action)]).toEqual([event, action, color]);
    }
  });

  it("keeps routine churn neutral so it cannot read as a signal", () => {
    const churn = [
      "synchronize",
      "labeled",
      "unlabeled",
      "unassigned",
      "review_request_removed",
      "milestoned",
      "demilestoned",
      "edited",
      "updated",
      "locked",
      "unlocked",
      "pinned",
    ];
    for (const action of churn) {
      expect([action, badgeColor("pull_request", action)]).toEqual([action, "neutral"]);
    }
  });

  it("falls back to neutral for an action it does not know", () => {
    expect(badgeColor("pull_request", "some_future_action")).toBe("neutral");
  });
});

describe("buildCard · issues", () => {
  it("is orange when opened, green when closed, with action badges", () => {
    const opened = buildCard(
      msg(
        "issues",
        {
          action: "opened",
          number: 7,
          issue: {
            title: "Bug",
            html_url: "https://github.com/org/repo/issues/7",
            body: "it broke",
            user: { login: "carol" },
            state: "open",
            labels: [{ name: "bug" }, { name: "ui" }],
          },
        },
        { action: "opened" },
      ),
    );
    expect(opened.header.template).toBe("orange");
    expect(opened.header.badges?.[0]).toEqual({ text: "opened", color: "turquoise" });
    expect(findButtonUrls(opened.elements)).toContain("https://github.com/org/repo/issues/7");

    const closed = buildCard(
      msg(
        "issues",
        {
          action: "closed",
          number: 7,
          issue: { title: "Bug", html_url: "u", user: { login: "c" }, state: "closed" },
        },
        { action: "closed" },
      ),
    );
    expect(closed.header.template).toBe("green");
    expect(closed.header.badges?.[0]).toEqual({ text: "closed", color: "red" });
  });

  it("renders labels as colored text_tag pills", () => {
    const card = buildCard(
      msg(
        "issues",
        {
          action: "opened",
          number: 1,
          issue: {
            title: "t",
            html_url: "u",
            user: { login: "c" },
            labels: [{ name: "bug" }, { name: "enhancement" }],
          },
        },
        { action: "opened" },
      ),
    );
    const text = elementMarkdown(card.elements);
    expect(text).toContain('<text_tag color="blue">bug</text_tag>');
    expect(text).toContain('<text_tag color="turquoise">enhancement</text_tag>');
  });

  it("reads the issue number from payload.issue.number (not top-level)", () => {
    // Real `issues` webhook payloads nest the number under `issue.number`,
    // with NO top-level `number`. Regression for the '#?' bug (#8).
    const card = buildCard(
      msg(
        "issues",
        {
          action: "opened",
          issue: {
            number: 42,
            title: "Something broke",
            html_url: "https://github.com/org/repo/issues/42",
            user: { login: "carol" },
          },
        },
        { action: "opened" },
      ),
    );
    expect(card.header.title).toBe("📌 Issue #42");
  });

  it("does not render a label column when the issue has no labels", () => {
    const card = buildCard(
      msg(
        "issues",
        {
          action: "opened",
          issue: {
            number: 5,
            title: "No labels here",
            html_url: "u",
            user: { login: "c" },
            labels: [],
          },
        },
        { action: "opened" },
      ),
    );
    const text = elementMarkdown(card.elements);
    expect(text).not.toContain("🏷️");
    // Author still present.
    expect(text).toContain("👤");
  });
});

describe("buildCard · release", () => {
  it("is turquoise, with tag + author + button", () => {
    const card = buildCard(
      msg(
        "release",
        {
          action: "published",
          release: {
            name: "v1.0.0",
            tag_name: "v1.0.0",
            html_url: "https://github.com/org/repo/releases/tag/v1.0.0",
            body: "## What's new\n- stuff",
            author: { login: "dave" },
            prerelease: false,
            assets: [{ name: "a.zip" }, { name: "b.zip" }],
          },
        },
        { action: "published" },
      ),
    );
    expect(card.header.template).toBe("turquoise");
    expect(card.header.badges?.[0]).toEqual({ text: "v1.0.0", color: "neutral" });
    expect(elementMarkdown(card.elements)).toContain("2 assets");
    expect(findButtonUrls(card.elements)).toContain(
      "https://github.com/org/repo/releases/tag/v1.0.0",
    );
  });

  it("is yellow + prerelease badge for a prerelease", () => {
    const card = buildCard(
      msg(
        "release",
        {
          action: "prereleased",
          release: {
            name: "v2-beta",
            tag_name: "v2.0.0-beta",
            html_url: "u",
            author: { login: "d" },
            prerelease: true,
          },
        },
        { action: "prereleased" },
      ),
    );
    expect(card.header.template).toBe("yellow");
    expect(card.header.badges?.some((b) => b.text === "prerelease")).toBe(true);
  });
});

describe("buildCard · star / fork", () => {
  it("star is wathet, links repo via button", () => {
    const card = buildCard(msg("star", { action: "created" }, { action: "created" }));
    expect(card.header.template).toBe("wathet");
    expect(card.header.title).toContain("starred");
    expect(findButtonUrls(card.elements)).toContain("https://github.com/org/repo");
  });

  it("fork mentions the forkee name", () => {
    const card = buildCard(
      msg("fork", { forkee: { full_name: "eve/repo", html_url: "https://github.com/eve/repo" } }),
    );
    expect(card.header.template).toBe("wathet");
    expect(elementMarkdown(card.elements)).toContain("eve/repo");
  });
});

describe("buildCard · fallback", () => {
  it("renders a grey card for an unknown event with an action badge", () => {
    const card = buildCard(msg("deployment", { environment: "prod" }));
    expect(card.header.template).toBe("grey");
    expect(card.elements.length).toBeGreaterThan(0);
  });

  it("folds in the template-rendered body when provided", () => {
    const card = buildCard(msg("deployment", {}, { formattedBody: "**custom body**" }));
    expect(elementMarkdown(card.elements)).toContain("custom body");
  });

  it("surfaces the org member and role for an `organization` event", () => {
    // `organization` is the event that carries `membership` — see the subject
    // tests below for the events that do not.
    const card = buildCard(
      msg(
        "organization",
        {
          action: "member_added",
          membership: {
            role: "member",
            state: "active",
            user: { login: "newperson", html_url: "https://github.com/newperson" },
          },
          organization: { login: "someorg" },
        },
        { action: "member_added" },
      ),
    );
    const text = elementMarkdown(card.elements);
    expect(text).toContain("newperson");
    expect(text).toContain("`member`"); // role
    expect(text).toContain("someorg");
  });

  it("does not emit a button when the repo/org url is empty", () => {
    // Dead-button guard (#6): a button with an empty default_url does nothing.
    // Build a message whose repository.html_url is "" to exercise the guard.
    const emptyUrlMsg: EventMessage = {
      id: "e",
      event: "organization",
      action: "member_added",
      repository: { full_name: "someorg", html_url: "" },
      actor: { login: "someone", avatar_url: "" },
      payload: {
        action: "member_added",
        membership: { user: { login: "x" } },
        organization: { login: "someorg" },
      },
      metadata: {},
    };
    const card = buildCard(emptyUrlMsg);
    expect(findRawButtons(card.elements)).toEqual([]);
  });

  it("labels View Repo (not View Org) for a repo event whose repo belongs to an org (#13)", () => {
    // GitHub repo-scoped payloads include BOTH repository AND organization
    // when the repo is org-owned. Must not be misdetected as an org event.
    // (`label` has no dedicated builder, so this stays a fallback assertion.)
    const card = buildCard(
      msg(
        "label",
        {
          action: "created",
          label: { name: "bug" },
          repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
          organization: { login: "org" },
        },
        { action: "created" },
      ),
    );
    // No "View Org" label anywhere in the rendered button.
    const btns = card.elements.filter((e) => (e as { tag?: string }).tag === "button");
    for (const b of btns) {
      const content = (b as { text?: { content?: string } }).text?.content ?? "";
      expect(content).not.toBe("View Org");
    }
  });

  it("labels View Org only for true org-scoped events (no repository in payload)", () => {
    // No `repository` key -> genuinely org-scoped -> "View Org".
    const card = buildCard(
      msg(
        "organization",
        {
          action: "member_added",
          membership: { user: { login: "x" } },
          organization: { login: "someorg", html_url: "https://github.com/someorg" },
        },
        { action: "member_added" },
      ),
    );
    // Note: msg() normalizes repository to org/repo; the discriminator is the
    // RAW payload.repository, which is absent here. Expect View Org label.
    const btn = card.elements.find((e) => (e as { tag?: string }).tag === "button");
    expect((btn as { text?: { content?: string } }).text?.content).toBe("View Org");
  });
});

describe("buildCard · no whole-card link", () => {
  it("never emits a cardLink (regression guard against re-adding card_link)", () => {
    const events = ["push", "pull_request", "issues", "release", "star", "fork", "deployment"];
    for (const e of events) {
      const c = buildCard(
        msg(
          e,
          e === "pull_request"
            ? { pull_request: { title: "t", html_url: "u", user: { login: "x" } } }
            : {},
        ),
      );
      expect((c as { cardLink?: unknown }).cardLink).toBeUndefined();
      expect("cardLink" in c).toBe(false);
    }
  });
});

describe("buildCard · schema correctness", () => {
  it("buttons use behaviors:[{type:'open_url',default_url}], not a top-level url", () => {
    const card = buildCard(
      msg(
        "pull_request",
        {
          action: "opened",
          number: 1,
          pull_request: { title: "t", html_url: "https://x", user: { login: "y" } },
        },
        { action: "opened" },
      ),
    );
    for (const el of card.elements) {
      if ((el as { tag?: string }).tag !== "button") continue;
      expect((el as { behaviors?: unknown }).behaviors).toBeTypeOf("object");
      expect((el as { url?: unknown }).url).toBeUndefined();
    }
  });

  it("no element uses the removed v2 tags (action, note)", () => {
    const events = ["push", "pull_request", "issues", "release", "star", "fork", "unknown"];
    for (const e of events) {
      const card = buildCard(
        msg(
          e,
          e === "pull_request"
            ? { pull_request: { title: "t", html_url: "u", user: { login: "x" } } }
            : {},
        ),
      );
      for (const el of card.elements) {
        const tag = (el as { tag?: string }).tag;
        expect(tag).not.toBe("action");
        expect(tag).not.toBe("note");
      }
    }
  });
});

describe("buildCard · user text is not interpreted as card markup (#16)", () => {
  const AT = "<at id=all></at>";

  it("escapes an <at> tag smuggled through a commit message", () => {
    const text = textOf(pushWith(AT));
    expect(text).not.toContain(AT);
    // Feishu's documented escaping form is the numeric entity, not `&lt;`.
    expect(text).toContain("&#60;at id=all&#62;");
  });

  it("escapes a smuggled <font> while leaving this module's own markup intact", () => {
    const text = textOf(pushWith("red<font color=green>greenagain</font>"));
    expect(text).not.toContain("<font color=green>greenagain");
    expect(text).toContain("&#60;font color=green&#62;greenagain");
    // The author pill this module generates is still a real tag.
    expect(text).toContain('<text_tag color="neutral">Alice</text_tag>');
  });

  it("escapes `<` in every payload field that reaches a markdown element", () => {
    const cases: [string, EventMessage][] = [
      ["commit.author.name", pushWith("ok", { author: AT })],
      [
        "pull_request.title",
        msg(
          "pull_request",
          {
            action: "opened",
            number: 1,
            pull_request: { title: AT, html_url: "u", user: { login: "x" } },
          },
          { action: "opened" },
        ),
      ],
      [
        "pull_request.body",
        msg(
          "pull_request",
          {
            action: "opened",
            number: 1,
            pull_request: { title: "t", html_url: "u", body: AT, user: { login: "x" } },
          },
          { action: "opened" },
        ),
      ],
      [
        "pull_request.head.ref",
        msg(
          "pull_request",
          {
            action: "opened",
            number: 1,
            pull_request: {
              title: "t",
              html_url: "u",
              user: { login: "x" },
              head: { ref: AT },
              base: { ref: "main" },
            },
          },
          { action: "opened" },
        ),
      ],
      [
        "issue.title",
        msg(
          "issues",
          {
            action: "opened",
            issue: { number: 1, title: AT, html_url: "u", user: { login: "c" } },
          },
          { action: "opened" },
        ),
      ],
      [
        "issue.body",
        msg(
          "issues",
          {
            action: "opened",
            issue: { number: 1, title: "t", html_url: "u", body: AT, user: { login: "c" } },
          },
          { action: "opened" },
        ),
      ],
      [
        "issue.labels[].name",
        msg(
          "issues",
          {
            action: "opened",
            issue: {
              number: 1,
              title: "t",
              html_url: "u",
              user: { login: "c" },
              labels: [{ name: AT }],
            },
          },
          { action: "opened" },
        ),
      ],
      [
        "release.body",
        msg(
          "release",
          {
            action: "published",
            release: {
              name: "v1",
              tag_name: "v1",
              html_url: "u",
              body: AT,
              author: { login: "d" },
            },
          },
          { action: "published" },
        ),
      ],
      [
        "comment.body",
        msg(
          "issue_comment",
          {
            action: "created",
            issue: { number: 1, title: "t" },
            comment: { body: AT, html_url: "u" },
          },
          { action: "created" },
        ),
      ],
      [
        "membership.role",
        msg(
          "organization",
          {
            action: "member_added",
            membership: { role: AT, user: { login: "m" } },
            organization: { login: "o" },
          },
          { action: "member_added" },
        ),
      ],
    ];
    for (const [field, message] of cases) {
      expect([field, textOf(message).includes(AT)]).toEqual([field, false]);
    }
  });

  it("escapes a smuggled tag in the branch name of a push", () => {
    const ref = `refs/heads/${AT}`;
    const text = textOf(msg("push", { ref, total_commits: 1, commits: [] }, { ref }));
    expect(text).not.toContain(AT);
  });
});

describe("buildCard · redundant elements are gone (#16)", () => {
  it("adds no footer note (the repo is already the header subtitle)", () => {
    const events = ["push", "pull_request", "issues", "release", "star", "fork", "deployment"];
    for (const event of events) {
      const card = buildCard(
        msg(
          event,
          event === "pull_request"
            ? { pull_request: { title: "t", html_url: "u", user: { login: "x" } } }
            : {},
        ),
      );
      const noteTexts = card.elements
        .filter((el) => (el as { tag?: string }).tag === "div")
        .map((el) => (el as { text?: { content?: string } }).text?.content ?? "");
      expect([event, noteTexts.some((t) => t.includes("notify-bus"))]).toEqual([event, false]);
    }
  });

  it("emits no whitespace-only element on the release card", () => {
    // The release card used to build a two-column layout whose right column was
    // a literal space, halving the author line's width for nothing. The empty
    // column is nested inside a column_set, so this walk has to recurse.
    const card = buildCard(
      msg(
        "release",
        {
          action: "published",
          release: { name: "v1", tag_name: "v1", html_url: "u", author: { login: "d" } },
        },
        { action: "published" },
      ),
    );
    const contents: string[] = [];
    const walk = (els: unknown[]): void => {
      for (const el of els) {
        const e = el as { tag?: string; content?: string; columns?: { elements?: unknown[] }[] };
        if (typeof e.content === "string") contents.push(e.content);
        if (e.tag === "column_set") for (const col of e.columns ?? []) walk(col.elements ?? []);
      }
    };
    walk(card.elements);
    expect(contents.some((c) => c.trim() === "")).toBe(false);
  });
});

describe("renderFormatted -> buildCard (the production path, #16)", () => {
  it("keeps the fallback card's enriched content", () => {
    // Calling buildCard() directly cannot see this. renderFormatted always
    // populated formatted.body, and buildFallbackCard composes its body with
    // `body || lines` — so a non-empty default replaced, and therefore
    // discarded, everything #12/#13/#14 added to the fallback card.
    // `discussion_comment` is used here because it is still a fallback event
    // (`issue_comment` now has a builder of its own, #21).
    const message = msg(
      "discussion_comment",
      {
        action: "created",
        discussion: { title: "Login broken" },
        comment: { body: "I can reproduce on Safari", html_url: "u#1" },
      },
      { action: "created" },
    );
    const text = elementMarkdown(buildCard(renderFormatted(message, undefined)).elements);
    expect(text).toContain("I can reproduce on Safari");
    expect(text).toContain("Login broken");
  });

  it("keeps membership details on the fallback card", () => {
    const message = msg(
      "organization",
      {
        action: "member_added",
        membership: { role: "admin", user: { login: "NEW-MEMBER" } },
        organization: { login: "someorg" },
      },
      { action: "member_added" },
    );
    const text = elementMarkdown(buildCard(renderFormatted(message, undefined)).elements);
    expect(text).toContain("NEW-MEMBER");
    expect(text).toContain("admin");
  });

  it("keeps the fallback card's own content when a template IS configured", () => {
    // The fallback composed its body with `body || lines`, so a configured
    // template replaced — and therefore discarded — the comment text, parent
    // discussion title and membership details. Configuring a template must not
    // make the card less informative than leaving it unset.
    const message = msg(
      "discussion_comment",
      {
        action: "created",
        discussion: { title: "Login broken" },
        comment: { body: "I can reproduce on Safari", html_url: "u#1" },
      },
      { action: "created" },
    );
    const text = elementMarkdown(buildCard(renderFormatted(message, "Deploying now")).elements);
    expect(text).toContain("Login broken");
    expect(text).toContain("I can reproduce on Safari");
    expect(text).toContain("Deploying now");
  });

  it("ships no example template that re-renders a field the card already renders", () => {
    // config.example.yaml is what deployers copy. The cards build the payload
    // body themselves, so an example template re-rendering it would show that
    // body twice.
    const config = loadSeedConfig(`${import.meta.dir}/../../../../../config.example.yaml`);
    if (!config) throw new Error("config.example.yaml did not load");
    for (const event of ["push", "pull_request", "issues", "release"]) {
      expect([event, findTemplate(config, event)?.template]).toEqual([event, undefined]);
    }
  });

  it("renders the payload body exactly once when a template complements it", () => {
    const body = "This PR implements the login flow.";
    const message = msg(
      "pull_request",
      {
        action: "opened",
        number: 1,
        pull_request: {
          title: "Add login",
          html_url: "u",
          body,
          user: { login: "bob" },
          requested_reviewers: [{ login: "carol" }],
        },
      },
      { action: "opened" },
    );
    // A template adding something the card does not render — here the requested
    // reviewers. Re-rendering `pull_request.body` would instead show it twice.
    const template =
      "Review requested from {{#each payload.pull_request.requested_reviewers}}{{login}}{{/each}}";
    const text = elementMarkdown(buildCard(renderFormatted(message, template)).elements);
    expect(text.split(body).length - 1).toBe(1);
    expect(text).toContain("Review requested from carol");
  });
});

describe("buildCard · event subject (#17)", () => {
  // The actor on every fixture is `alice`, so `not.toContain("alice")` is a
  // direct assertion that the card did not blame the sender.

  it("names the org member for `organization` member_added", () => {
    const text = cardText(
      "organization",
      {
        action: "member_added",
        membership: {
          state: "active",
          role: "member",
          user: { login: "new-member", html_url: "https://github.com/new-member" },
        },
        organization: { login: "someorg" },
      },
      "member_added",
    );
    expect(text).toContain("new-member");
    expect(text).toContain("https://github.com/new-member");
    expect(text).not.toContain("alice");
  });

  it("names the invitee for member_invited, which has no membership object", () => {
    // GitHub's member_invited payload has no `membership`; the invitee is in a
    // top-level `user`, which also carries an html_url.
    const text = cardText(
      "organization",
      {
        action: "member_invited",
        invitation: { login: "hacktocat", email: null, inviter: { login: "inviter-user" } },
        user: { login: "hacktocat", html_url: "https://github.com/hacktocat" },
        organization: { login: "someorg" },
      },
      "member_invited",
    );
    expect(text).toContain("hacktocat");
    expect(text).toContain("https://github.com/hacktocat");
    expect(text).toContain("inviter-user"); // who sent the invitation
    expect(text).not.toContain("alice");
  });

  it("does not print an email-only invitation's address", () => {
    // A card is visible to the whole group; an email is not public information.
    const text = cardText(
      "organization",
      {
        action: "member_invited",
        invitation: {
          login: null,
          email: "someone@example.com",
          inviter: { login: "inviter-user" },
        },
        organization: { login: "someorg" },
      },
      "member_invited",
    );
    expect(text).not.toContain("someone@example.com");
    expect(text).toContain("invited by email");
    expect(text).toContain("inviter-user");
  });

  it("falls back to invitation.login when there is no top-level user", () => {
    // `member_invited` normally carries both; this pins the fallback on its own.
    const text = cardText(
      "organization",
      {
        action: "member_invited",
        invitation: { login: "invited-login", email: null, inviter: { login: "inviter-user" } },
        organization: { login: "someorg" },
      },
      "member_invited",
    );
    expect(text).toContain("invited-login");
    expect(text).not.toContain("alice");
  });

  it("names the collaborator for a `member` event", () => {
    const text = cardText(
      "member",
      {
        action: "added",
        member: { login: "new-collab", html_url: "https://github.com/new-collab" },
        repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
      },
      "added",
    );
    expect(text).toContain("new-collab");
    expect(text).not.toContain("alice");
  });

  it("names the teammate and the team for a `membership` event", () => {
    const text = cardText(
      "membership",
      {
        action: "added",
        scope: "team",
        member: { login: "new-teammate" },
        team: { name: "core-team", html_url: "https://github.com/orgs/someorg/teams/core-team" },
        organization: { login: "someorg" },
      },
      "added",
    );
    expect(text).toContain("new-teammate");
    expect(text).toContain("core-team");
    expect(text).not.toContain("alice");
  });

  it("surfaces the team on a `team` event, which is not about a person", () => {
    const text = cardText(
      "team",
      {
        action: "added_to_repository",
        team: {
          name: "platform-team",
          html_url: "https://github.com/orgs/someorg/teams/platform-team",
        },
        repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
      },
      "added_to_repository",
    );
    expect(text).toContain("platform-team");
    // Not a person event, so the actor is the right name here.
    expect(text).toContain("alice");
    expect(text).not.toContain("unknown");
  });

  it("names the blocked user for `org_block`", () => {
    const text = cardText(
      "org_block",
      {
        action: "blocked",
        blocked_user: { login: "bad-actor", html_url: "https://github.com/bad-actor" },
        organization: { login: "someorg" },
      },
      "blocked",
    );
    expect(text).toContain("bad-actor");
    expect(text).not.toContain("alice");
  });

  it("says unknown — not the actor — when a person event names nobody", () => {
    // A partial payload must not be reported as "the sender did it": that is
    // how the card used to name the wrong person.
    const text = cardText(
      "member",
      {
        action: "added",
        repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
      },
      "added",
    );
    expect(text).toContain("unknown");
    expect(text).not.toContain("alice");
  });

  it("still names the actor for events that are not about a person", () => {
    // `create` is about a ref, not a person — the sender is the right name here.
    const text = cardText("create", {
      ref: "v1.0.0",
      ref_type: "tag",
      repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
    });
    expect(text).toContain("alice");
    expect(text).not.toContain("unknown");
  });

  it("names the actor for the non-member `organization` actions", () => {
    // `organization` covers two unrelated shapes. `renamed` / `deleted` are
    // about the organization itself and carry no person, so they must keep
    // naming the actor — classifying the whole event as a person event dropped
    // the only information the payload had. Real payloads, per GitHub's
    // published examples.
    const renamed = cardText(
      "organization",
      {
        changes: { login: { from: "Octocoders" } },
        organization: { login: "someorg" },
      },
      "renamed",
    );
    expect(renamed).toContain("alice");
    expect(renamed).not.toContain("unknown");

    const deleted = cardText(
      "organization",
      {
        organization: { login: "someorg" },
      },
      "deleted",
    );
    expect(deleted).toContain("alice");
    expect(deleted).not.toContain("unknown");
  });

  it("still says unknown for a member action that names nobody", () => {
    // The complement of the test above: within the member-* actions a missing
    // subject must not fall back to the actor.
    const text = cardText(
      "organization",
      {
        organization: { login: "someorg" },
      },
      "member_added",
    );
    expect(text).toContain("unknown");
    expect(text).not.toContain("alice");
  });

  it("surfaces membership.state so a pending invitation is not read as joined", () => {
    // GitHub's own member_added example carries state "pending". The login is
    // deliberately unrelated to the word "pending" so this cannot pass by
    // substring accident.
    const text = cardText(
      "organization",
      {
        action: "member_added",
        membership: { state: "pending", role: "member", user: { login: "invitee-login" } },
        organization: { login: "someorg" },
      },
      "member_added",
    );
    expect(text).toContain("invitee-login");
    expect(text).toContain("pending");
  });

  it("surfaces the previous permission without presenting it as current", () => {
    // `member` action `edited` carries only changes.old_permission.from; the
    // new permission is not in the payload.
    const text = cardText(
      "member",
      {
        action: "edited",
        member: { login: "octocat" },
        changes: { old_permission: { from: "write" } },
        repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
      },
      "edited",
    );
    expect(text).toContain("write");
    expect(text).toContain("previously");
  });

  it("adds no membership lines for an event with no membership data", () => {
    const text = cardText("create", { ref: "main", ref_type: "branch" });
    expect(text).not.toContain("✉️");
    expect(text).not.toContain("previously");
  });
});

describe("buildCard · labels (#17)", () => {
  it("states how many labels an issue card left out", () => {
    const text = cardText(
      "issues",
      {
        action: "opened",
        issue: {
          number: 1,
          title: "t",
          html_url: "u",
          user: { login: "c" },
          labels: someLabels(10),
        },
      },
      "opened",
    );
    expect(text).toContain("label-0");
    expect(text).not.toContain("label-3"); // only three pills are shown
    expect(text).toContain("+7 more");
  });

  it("shows no remainder when every label fits", () => {
    const text = cardText(
      "issues",
      {
        action: "opened",
        issue: {
          number: 1,
          title: "t",
          html_url: "u",
          user: { login: "c" },
          labels: someLabels(2),
        },
      },
      "opened",
    );
    expect(text).not.toContain("more");
  });

  it("shows labels on a PR card, which showed none at all", () => {
    const text = cardText(
      "pull_request",
      {
        action: "opened",
        number: 1,
        pull_request: { title: "t", html_url: "u", user: { login: "x" }, labels: someLabels(2) },
      },
      "opened",
    );
    expect(text).toContain("label-0");
    expect(text).toContain("label-1");
  });
});

describe("buildCard · fork button (#17)", () => {
  it("opens the fork rather than the upstream repo", () => {
    // The body reads "A → B(fork)", so the button must agree with it.
    const card = prodCard("fork", {
      forkee: { full_name: "eve/repo", html_url: "https://github.com/eve/repo" },
    });
    const urls = findButtonUrls(card.elements);
    expect(urls).toContain("https://github.com/eve/repo");
    expect(urls).not.toContain("https://github.com/org/repo");
  });

  it("falls back to the upstream repo and says so when the payload has no forkee url", () => {
    const card = prodCard("fork", { forkee: { full_name: "eve/repo" } });
    expect(findButtonUrls(card.elements)).toEqual(["https://github.com/org/repo"]);
    const button = card.elements.find((el) => (el as { tag?: string }).tag === "button");
    expect((button as { text?: { content?: string } }).text?.content).toBe("View Repo");
  });
});

describe("buildCard · navigation buttons (#26)", () => {
  /**
   * One GitHub-shaped fixture per builder, keyed by event so a test names the
   * card it means rather than an array position that shifts when one is added.
   *
   * Every target a card can offer gets its own URL, so a button that quietly
   * opens the wrong one shows up as a label/URL mismatch rather than a
   * coincidence.
   */
  const REPO_URL = "https://github.com/org/repo";
  const FIXTURES: Record<string, { payload: Record<string, unknown>; action?: string }> = {
    push: {
      payload: {
        ref: "refs/heads/main",
        compare: "https://github.com/org/repo/compare/aaa...bbb",
        commits: [{ id: "abc1234567", message: "one" }],
      },
    },
    pull_request: {
      payload: {
        action: "opened",
        number: 7,
        pull_request: {
          title: "Add login",
          html_url: "https://github.com/org/repo/pull/7",
          user: { login: "bob" },
        },
      },
      action: "opened",
    },
    issues: {
      payload: {
        action: "opened",
        issue: {
          number: 8,
          title: "Bug",
          html_url: "https://github.com/org/repo/issues/8",
          user: { login: "carol" },
        },
      },
      action: "opened",
    },
    release: {
      payload: {
        action: "published",
        release: {
          name: "v1.0.0",
          tag_name: "v1.0.0",
          html_url: "https://github.com/org/repo/releases/tag/v1.0.0",
          author: { login: "dave" },
        },
      },
      action: "published",
    },
    star: { payload: { action: "created" }, action: "created" },
    fork: {
      payload: { forkee: { full_name: "eve/repo", html_url: "https://github.com/eve/repo" } },
    },
    issue_comment: {
      payload: {
        action: "created",
        issue: { number: 8, title: "Bug", html_url: "https://github.com/org/repo/issues/8" },
        comment: {
          body: "me too",
          html_url: "https://github.com/org/repo/issues/8#issuecomment-1",
          user: { login: "carol" },
        },
        repository: { full_name: "org/repo", html_url: REPO_URL },
      },
      action: "created",
    },
    repository: {
      payload: { action: "renamed", repository: { full_name: "org/repo", html_url: REPO_URL } },
      action: "renamed",
    },
    deployment: {
      payload: {
        deployment: { id: 1 },
        repository: { full_name: "org/repo", html_url: REPO_URL },
      },
    },
  };

  /** Buttons of the canonical fixture for `event`, in render order. */
  const fixtureButtons = (event: string): { label: string; url: string }[] => {
    const fixture = FIXTURES[event];
    if (!fixture) throw new Error(`no fixture for ${event}`);
    return buttonsOf(event, fixture.payload, fixture.action);
  };

  /** Button labels + styles of the canonical fixture for `event`. */
  const fixtureStyles = (event: string): string[] => {
    const fixture = FIXTURES[event];
    if (!fixture) throw new Error(`no fixture for ${event}`);
    return stylesOf(event, fixture.payload, fixture.action);
  };

  it("keeps every card within three buttons, each with a unique non-empty target", () => {
    for (const [event, fixture] of Object.entries(FIXTURES)) {
      const card = prodCard(event, fixture.payload, fixture.action);
      const raw = findRawButtons(card.elements);
      const buttons = findButtons(card.elements);
      expect([event, buttons.length <= 3]).toEqual([event, true]);
      // No dead button: every button element carries a destination.
      expect([event, raw.length]).toEqual([event, buttons.length]);
      expect([event, buttons.every((b) => b.url.length > 0)]).toEqual([event, true]);
      // No two buttons open the same target.
      expect([event, new Set(buttons.map((b) => b.url)).size]).toEqual([event, buttons.length]);
    }
  });

  it("renders the repository as secondary navigation, never primary", () => {
    // The card's own object is the primary action; the repository button is
    // secondary, matching the `star` and fallback cards that compose their own
    // `default` repo button. A card left with only "View Repo" — its object URL
    // missing — used to render that button `primary` (#26 review).
    expect(fixtureStyles("issues")).toEqual(["View Issue:primary", "View Repo:default"]);
    expect(fixtureStyles("push")).toEqual(["Compare changes:primary", "View Repo:default"]);
    expect(fixtureStyles("star")).toEqual(["View Repo:default"]);
    expect(fixtureStyles("deployment")).toEqual(["View Repo:default"]);
    // Still secondary when it is the only button left.
    expect(
      stylesOf("issues", { action: "opened", issue: { number: 8, title: "Bug" } }, "opened"),
    ).toEqual(["View Repo:default"]);
    expect(
      stylesOf("push", { ref: "refs/heads/old", deleted: true, commits: [], head_commit: null }),
    ).toEqual(["View Repo:default"]);
  });

  it("push adds the repository button next to the compare link", () => {
    // The commit list links to individual commits, so before #26 nothing on this
    // card reached the repository: the only mention was the plain-text subtitle.
    expect(fixtureButtons("push")).toEqual([
      { label: "Compare changes", url: "https://github.com/org/repo/compare/aaa...bbb" },
      { label: "View Repo", url: REPO_URL },
    ]);
  });

  it("push on a deleted branch keeps the repo button and drops the compare link", () => {
    const buttons = buttonsOf("push", {
      ref: "refs/heads/old",
      deleted: true,
      compare: "https://github.com/org/repo/compare/aaa...000",
      commits: [],
      head_commit: null,
    });
    expect(buttons).toEqual([{ label: "View Repo", url: REPO_URL }]);
  });

  it("pull_request points View PR, View files and View Repo at three distinct targets", () => {
    expect(fixtureButtons("pull_request")).toEqual([
      { label: "View PR", url: "https://github.com/org/repo/pull/7" },
      { label: "View files", url: "https://github.com/org/repo/pull/7/files" },
      { label: "View Repo", url: REPO_URL },
    ]);
  });

  it("issues points View Issue and View Repo at two distinct targets", () => {
    expect(fixtureButtons("issues")).toEqual([
      { label: "View Issue", url: "https://github.com/org/repo/issues/8" },
      { label: "View Repo", url: REPO_URL },
    ]);
  });

  it("release points View Release and View Repo at two distinct targets", () => {
    expect(fixtureButtons("release")).toEqual([
      { label: "View Release", url: "https://github.com/org/repo/releases/tag/v1.0.0" },
      { label: "View Repo", url: REPO_URL },
    ]);
  });

  it("star keeps its single View Repo — no duplicate is added", () => {
    expect(buttonsOf("star", { action: "created" }, "created")).toEqual([
      { label: "View Repo", url: REPO_URL },
    ]);
  });

  it("fork keeps its single fork button — no View Repo is added", () => {
    expect(
      buttonsOf("fork", {
        forkee: { full_name: "eve/repo", html_url: "https://github.com/eve/repo" },
      }),
    ).toEqual([{ label: "View Fork", url: "https://github.com/eve/repo" }]);
  });

  it("fallback keeps the single button resolvePrimaryLink chose", () => {
    expect(
      buttonsOf("deployment", {
        deployment: { id: 1 },
        repository: { full_name: "org/repo", html_url: REPO_URL },
      }),
    ).toEqual([{ label: "View Repo", url: REPO_URL }]);
  });

  it("drops View PR instead of opening the repository under that label", () => {
    // The old `?? repoUrl` fallback made "View PR" open the repo and "View files"
    // a `<repo url>/files` that does not exist.
    const buttons = buttonsOf(
      "pull_request",
      { action: "opened", number: 7, pull_request: { title: "Add login", user: { login: "bob" } } },
      "opened",
    );
    expect(buttons).toEqual([{ label: "View Repo", url: REPO_URL }]);
  });

  it("drops View Issue instead of opening the repository under that label", () => {
    const buttons = buttonsOf(
      "issues",
      { action: "opened", issue: { number: 8, title: "Bug", user: { login: "carol" } } },
      "opened",
    );
    expect(buttons).toEqual([{ label: "View Repo", url: REPO_URL }]);
  });

  it("drops View Release instead of opening the repository under that label", () => {
    const buttons = buttonsOf(
      "release",
      {
        action: "published",
        release: { name: "v1.0.0", tag_name: "v1.0.0", author: { login: "d" } },
      },
      "published",
    );
    expect(buttons).toEqual([{ label: "View Repo", url: REPO_URL }]);
  });

  it("emits no navigation at all when the repository has no url", () => {
    // Org-scoped payloads resolve to an empty repository.html_url; a "View Repo"
    // there would be a dead link. Asserted on the raw buttons so a button with
    // an empty target cannot pass as "no button".
    const noUrls = msgWithoutRepoUrl(
      "issues",
      { action: "opened", issue: { number: 8, title: "Bug", user: { login: "carol" } } },
      "opened",
    );
    expect(findRawButtons(buildCard(noUrls).elements)).toEqual([]);

    // The object button survives on its own URL; only the repo button is gone.
    const withIssueUrl = msgWithoutRepoUrl(
      "issues",
      {
        action: "opened",
        issue: {
          number: 8,
          title: "Bug",
          html_url: "https://github.com/org/repo/issues/8",
          user: { login: "c" },
        },
      },
      "opened",
    );
    expect(findRawButtons(buildCard(withIssueUrl).elements)).toEqual([
      {
        label: "View Issue",
        url: "https://github.com/org/repo/issues/8",
        type: "primary",
      },
    ]);
  });

  it("pull_request_review_comment sends View Comment to the comment itself", () => {
    // The parent PR url and the repo url are both in the payload and both
    // differ from the comment url, so opening any of them fails this assertion.
    const buttons = buttonsOf(
      "pull_request_review_comment",
      {
        action: "created",
        comment: {
          html_url: "https://github.com/org/repo/pull/7#discussion_r123",
          body: "nit: rename this",
        },
        pull_request: { html_url: "https://github.com/org/repo/pull/7" },
        repository: { full_name: "org/repo", html_url: REPO_URL },
      },
      "created",
    );
    expect(buttons).toEqual([
      { label: "View Comment", url: "https://github.com/org/repo/pull/7#discussion_r123" },
    ]);
  });

  it("commit_comment sends View Comment to the comment itself", () => {
    const buttons = buttonsOf(
      "commit_comment",
      {
        action: "created",
        comment: {
          html_url: "https://github.com/org/repo/commit/abc1234#commitcomment-9",
          body: "thanks",
          commit_id: "abc1234",
        },
        repository: { full_name: "org/repo", html_url: REPO_URL },
      },
      "created",
    );
    expect(buttons).toEqual([
      { label: "View Comment", url: "https://github.com/org/repo/commit/abc1234#commitcomment-9" },
    ]);
  });

  it("emits no View Comment when the payload carries no comment url", () => {
    // Degrades to the repository (the correct label for that target) rather than
    // faking a link to a comment it cannot address.
    const buttons = buttonsOf(
      "commit_comment",
      {
        action: "created",
        comment: { body: "thanks", commit_id: "abc1234" },
        repository: { full_name: "org/repo", html_url: REPO_URL },
      },
      "created",
    );
    expect(buttons).toEqual([{ label: "View Repo", url: REPO_URL }]);
  });

  it("still renders both comment events through the fallback, not a dedicated card", () => {
    // #26 explicitly keeps pull_request_review_comment / commit_comment on the
    // fallback; the grey header is that builder's signature.
    for (const event of ["pull_request_review_comment", "commit_comment"]) {
      const payload = {
        action: "created",
        comment: { html_url: "https://github.com/org/repo/issues/1#issuecomment-2", body: "hi" },
        repository: { full_name: "org/repo", html_url: REPO_URL },
      };
      expect([event, prodCard(event, payload, "created").header.template]).toEqual([event, "grey"]);
    }
  });

  it("does not deliver either comment event under the shipped config", () => {
    // Asserted through the router rather than by reading the `match_event`
    // strings: a route that omits `match_event` matches every event, so a
    // catch-all route added to config.example.yaml later would deliver these
    // while a whitelist-string check still passed. (#26 review)
    const config = loadSeedConfig(`${import.meta.dir}/../../../../../config.example.yaml`);
    if (!config) throw new Error("config.example.yaml did not load");
    for (const event of ["pull_request_review_comment", "commit_comment"]) {
      const message = msg(
        event,
        {
          action: "created",
          comment: { html_url: "https://github.com/org/repo/issues/1#issuecomment-2", body: "hi" },
          repository: { full_name: "org/repo", html_url: REPO_URL },
        },
        { action: "created" },
      );
      expect([event, resolveRoute(config, message).kind]).toEqual([event, "no_route"]);
    }
  });
});

describe("buildCard · dedicated card registry (#30)", () => {
  it("registers exactly the events that have a dedicated card", () => {
    // The registry replaced a `switch`, so dropping an entry no longer fails to
    // compile anywhere — the event would just quietly start rendering as the
    // fallback. This list is the checklist that makes such a removal visible.
    expect(DEDICATED_EVENTS.toSorted()).toEqual([
      "deployment_status",
      "fork",
      "issue_comment",
      "issues",
      "pull_request",
      "pull_request_review",
      "push",
      "release",
      "repository",
      "star",
      "workflow_run",
    ]);
  });

  it("dispatches every registered event to a card of its own", () => {
    for (const event of DEDICATED_EVENTS) {
      // buildFallbackCard titles itself `📋 <event>`, so this pins that none of
      // the registered events falls through to it.
      const title = prodCard(event, {}).header.title;
      expect([event, title === `📋 ${event}`]).toEqual([event, false]);
    }
  });

  it("leaves unregistered events on the fallback", () => {
    // Not an error: GitHub sends far more events than this adapter styles, and
    // `deployment` (unlike `deployment_status`) is one of them.
    for (const event of ["deployment", "create", "delete", "watch"]) {
      const card = prodCard(event, { ref: "v1.0.0", ref_type: "tag" });
      expect([event, card.header.title]).toEqual([event, `📋 ${event}`]);
    }
  });
});

/** A `pull_request` payload whose action a review-request test can vary. */
function prPayload(action: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action,
    number: 7,
    pull_request: {
      title: "Add login",
      html_url: "https://github.com/org/repo/pull/7",
      user: { login: "alice" },
      head: { ref: "feature/login" },
      base: { ref: "main" },
    },
    ...extra,
  };
}

describe("buildCard · pull_request review request (#36)", () => {
  /** `Bob` is written in mixed case on purpose: the lookup ignores case. */
  const MAP = { Bob: "ou_bob" };

  it("names the reviewer the request is for", () => {
    const text = cardText(
      "pull_request",
      prPayload("review_requested", { requested_reviewer: { login: "bob" } }),
      "review_requested",
    );
    expect(text).toContain("👥 Review requested:");
    expect(text).toContain("bob");
  });

  it("mentions a reviewer the channel maps, inside the same card", () => {
    const card = prodCard(
      "pull_request",
      prPayload("review_requested", { requested_reviewer: { login: "bob" } }),
      "review_requested",
      { mentionMap: MAP },
    );
    expect(elementMarkdown(card.elements)).toContain("👥 Review requested: <at id=ou_bob></at>");
    // Still one PR card — a review request never becomes a card of its own.
    expect(card.header.title).toBe("🔀 PR #7");
  });

  it("names an unmapped reviewer without inventing a mention", () => {
    const text = cardText(
      "pull_request",
      prPayload("review_requested", { requested_reviewer: { login: "stranger" } }),
      "review_requested",
    );
    expect(text).toContain("👥 Review requested: **stranger**");
    expect(text).not.toContain("<at");
  });

  it("keeps a requested team a name, and never expands it", () => {
    const text = cardText(
      "pull_request",
      prPayload("review_requested", { requested_team: { name: "Platform", slug: "platform" } }),
      "review_requested",
    );
    expect(text).toContain("👥 Review requested: team **Platform**");
    expect(text).not.toContain("<at");
    expect(text).not.toContain("@all");
  });

  it("does not announce a withdrawal as a request", () => {
    // `review_request_removed` carries the same `requested_reviewer` field, so
    // reading the field alone would announce a request that was taken back.
    const text = cardText(
      "pull_request",
      prPayload("review_request_removed", { requested_reviewer: { login: "bob" } }),
      "review_request_removed",
    );
    expect(text).not.toContain("Review requested:");
  });

  it("leaves every other action alone", () => {
    const text = cardText(
      "pull_request",
      prPayload("opened", { requested_reviewer: { login: "bob" } }),
      "opened",
    );
    expect(text).not.toContain("Review requested:");
  });
});

describe("buildCard · mentions on the fallback (#36)", () => {
  const reviewComment = {
    action: "created",
    comment: {
      body: "nit: rename this",
      html_url: "https://github.com/org/repo/pull/7#discussion_r1",
    },
    pull_request: { html_url: "https://github.com/org/repo/pull/7" },
  };

  it("renders the targets a mention-only route resolved", () => {
    // `pull_request_review_comment` keeps its fallback card (#26); the mention
    // is what the policy adds to it.
    const card = prodCard("pull_request_review_comment", reviewComment, "created", {
      mentions: { logins: ["bob"], userIds: ["ou_bob"] },
    });
    expect(elementMarkdown(card.elements)).toContain("<at id=ou_bob></at>");
    expect(card.header.template).toBe("grey");
  });

  it("adds nothing when no targets were resolved", () => {
    expect(cardText("pull_request_review_comment", reviewComment, "created")).not.toContain("<at");
  });
});
