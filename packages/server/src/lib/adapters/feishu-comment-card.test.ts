/**
 * `issue_comment` card (#21) — the builder lives in `feishu-comment-card.ts`,
 * and these tests reach it the way production does, through `buildCard`.
 */
import { describe, expect, it } from "bun:test";
import { buildCard } from "./feishu-cards";
import { renderFormatted } from "../render";
import {
  cardText,
  elementMarkdown,
  findButtons,
  findRawButtons,
  msg,
  msgWithoutRepoUrl,
  prodCard,
} from "./feishu-card-test-helpers";

describe("buildCard · issue_comment (#21)", () => {
  const COMMENT_URL = "https://github.com/org/repo/issues/42#issuecomment-1";
  const ISSUE_URL = "https://github.com/org/repo/issues/42";

  /**
   * A GitHub-shaped `issue_comment` payload: the comment, its parent issue, and
   * the repository. `overrides.comment` / `overrides.issue` are merged one
   * level deep so a test can drop or replace a single field.
   */
  const fixture = (
    action: string,
    overrides: {
      comment?: Record<string, unknown>;
      issue?: Record<string, unknown>;
    } = {},
  ): Record<string, unknown> => ({
    action,
    issue: {
      number: 42,
      title: "Login broken",
      html_url: ISSUE_URL,
      user: { login: "carol" },
      ...overrides.issue,
    },
    comment: {
      body: "I can reproduce on Safari",
      html_url: COMMENT_URL,
      user: { login: "carol", html_url: "https://github.com/carol" },
      ...overrides.comment,
    },
    repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
  });

  it("shows the comment, its author and the parent issue", () => {
    const card = prodCard("issue_comment", fixture("created"), "created");
    const text = elementMarkdown(card.elements);
    expect(text).toContain("Login broken");
    expect(text).toContain("> I can reproduce on Safari");
    expect(text).toContain("carol");
    // The issue is identified in the header, so the body carries its title only.
    expect(card.header.title).toContain("#42");
  });

  it("sends View Comment to the comment itself", () => {
    const card = prodCard("issue_comment", fixture("created"), "created");
    expect(findButtons(card.elements)).toEqual([
      { label: "View Comment", url: COMMENT_URL },
      { label: "View Repo", url: "https://github.com/org/repo" },
    ]);
  });

  it("falls back to the parent issue when the comment carries no url", () => {
    const card = prodCard(
      "issue_comment",
      fixture("created", { comment: { html_url: undefined } }),
      "created",
    );
    // The label has to follow the target (#26): this button opens the issue.
    expect(findButtons(card.elements)).toEqual([
      { label: "View Issue", url: ISSUE_URL },
      { label: "View Repo", url: "https://github.com/org/repo" },
    ]);
  });

  it("emits no button when neither the comment nor its parent has a url", () => {
    const noUrls = msgWithoutRepoUrl(
      "issue_comment",
      fixture("created", { comment: { html_url: undefined }, issue: { html_url: undefined } }),
      "created",
    );
    // Raw buttons, so a button with an empty target cannot pass as "no button".
    expect(findRawButtons(buildCard(noUrls).elements)).toEqual([]);
  });

  it("distinguishes created, edited and deleted", () => {
    const look = (action: string) => {
      const card = prodCard("issue_comment", fixture(action), action);
      return `${card.header.template}/${card.header.badges?.[0]?.color}`;
    };
    expect(look("created")).toBe("blue/wathet");
    expect(look("edited")).toBe("grey/neutral");
    expect(look("deleted")).toBe("red/red");
  });

  it("names the comment's author rather than the actor", () => {
    // The fixture's actor is `alice` (see msg()) and the comment's author is
    // carol. The fallback rendered `message.actor`, which on `edited` is the
    // editor — the bug this card exists to fix.
    const text = cardText("issue_comment", fixture("edited"), "edited");
    expect(text).toContain("carol");
  });

  it("adds the editor beside the author when somebody else edits the comment", () => {
    const text = cardText("issue_comment", fixture("edited"), "edited");
    expect(text).toContain("carol"); // still the author
    expect(text).toContain("alice"); // the editor, on its own line
    expect(text).toContain("edited by");
  });

  it("does not announce an edit when the author edits their own comment", () => {
    const text = cardText(
      "issue_comment",
      fixture("edited", { comment: { user: { login: "alice" } } }),
      "edited",
    );
    expect(text).toContain("alice");
    expect(text).not.toContain("edited by");
  });

  it("says unknown — not the actor — when the payload names no author", () => {
    const text = cardText(
      "issue_comment",
      fixture("created", { comment: { user: null } }),
      "created",
    );
    expect(text).toContain("unknown");
    expect(text).not.toContain("alice");
  });

  it("keeps its own content when a template is configured", () => {
    const message = msg("issue_comment", fixture("created"), { action: "created" });
    const text = elementMarkdown(buildCard(renderFormatted(message, "Deploying now")).elements);
    expect(text).toContain("Login broken");
    expect(text).toContain("I can reproduce on Safari");
    expect(text).toContain("Deploying now");
  });
});

describe("buildCard · issue_comment · mention-only targets (#36)", () => {
  /** The comment a `mention_only` route would have looked at. */
  const payload = {
    action: "created",
    issue: {
      number: 42,
      title: "Login broken",
      html_url: "https://github.com/org/repo/issues/42",
    },
    comment: {
      body: "@alice could you look at this?",
      html_url: "https://github.com/org/repo/issues/42#issuecomment-1",
      user: { login: "carol" },
    },
  };

  it("renders the targets the route resolved, as real mentions", () => {
    const card = prodCard("issue_comment", payload, "created", {
      mentions: { logins: ["alice", "bob"], userIds: ["ou_alice", "ou_bob"] },
    });
    const text = elementMarkdown(card.elements);
    expect(text).toContain("<at id=ou_alice></at> <at id=ou_bob></at>");
    // The ordinary card is still there underneath: the mention is an addition,
    // not a replacement.
    expect(text).toContain("Login broken");
    expect(text).toContain("@alice could you look at this?");
  });

  it("never turns the comment's own text into a mention", () => {
    // `@alice` in the body is text: only the map produces markup, so a comment
    // cannot mention anybody by being written that way.
    const text = cardText("issue_comment", payload, "created");
    expect(text).toContain("@alice could you look at this?");
    expect(text).not.toContain("<at");
  });

  it("adds no line at all when the route resolved nobody", () => {
    const text = cardText("issue_comment", payload, "created");
    expect(text).not.toContain("<at id=");
  });

  it("refuses to render a whole-chat mention id", () => {
    // Defence in depth: the loader rejects a map holding one of these, and no
    // other path may ping a group either (#36).
    expect(() =>
      prodCard("issue_comment", payload, "created", {
        mentions: { logins: ["all"], userIds: ["all"] },
      }),
    ).toThrow(/reserved Feishu id/);
  });
});
