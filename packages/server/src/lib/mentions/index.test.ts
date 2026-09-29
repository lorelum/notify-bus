/**
 * Mention parsing (#36). The rules err towards silence: text that was not meant
 * as a mention must never become a Feishu @, and an unmapped login never does.
 * Pure text and a map — no network, no payload beyond the comment body.
 */
import { describe, expect, it } from "bun:test";
import {
  MAX_MENTIONS,
  commentBodyOf,
  mappedUserId,
  normalizeMentionMap,
  readMentionTargets,
  resolveMentionTargets,
} from "./index";
import type { EventMessage } from "../../types";

/**
 * A small team. `Bob` is mixed case, `og` is an old handle for `alice` (one
 * person, two logins), and `all` / `platform-team` are mapped so the
 * reserved-word and team-reference rules are tested against logins that *would*
 * match if they were read naively.
 */
const MAP = {
  alice: "ou_alice",
  og: "ou_alice",
  Bob: "ou_bob",
  carol: "ou_carol",
  dave: "ou_dave",
  erin: "ou_erin",
  frank: "ou_frank",
  all: "ou_all",
  "platform-team": "ou_platform",
};

const lookup = normalizeMentionMap(MAP);

/** A mapped author: the comment has to come from somebody the channel trusts. */
const AUTHOR = "carol";

function targets(
  text: string,
): { logins: readonly string[]; userIds: readonly string[] } | undefined {
  return resolveMentionTargets(text, lookup, AUTHOR);
}

describe("resolveMentionTargets", () => {
  it("matches a mapped login, whatever its case", () => {
    expect(targets("ping @alice please")).toEqual({ logins: ["alice"], userIds: ["ou_alice"] });
    expect(targets("ping @ALICE")).toEqual({ logins: ["alice"], userIds: ["ou_alice"] });
    expect(targets("ping @Bob")).toEqual({ logins: ["bob"], userIds: ["ou_bob"] });
    // …and the author's own login is compared the same way.
    expect(resolveMentionTargets("@alice", lookup, "CAROL")).toEqual({
      logins: ["alice"],
      userIds: ["ou_alice"],
    });
  });

  it("reads the map's own user id, ignoring case and padding", () => {
    expect(mappedUserId(lookup, "BOB")).toBe("ou_bob");
    expect(mappedUserId(lookup, " bob ")).toBe("ou_bob");
    expect(mappedUserId(lookup, "nobody")).toBeUndefined();
    expect(mappedUserId(lookup, undefined)).toBeUndefined();
  });

  it("mentions each person once, in the order the comment named them", () => {
    const result = targets("@alice look — @carol too, and @alice again");
    expect(result?.logins).toEqual(["alice", "carol"]);
    expect(result?.userIds).toEqual(["ou_alice", "ou_carol"]);
  });

  it("caps one card at MAX_MENTIONS people", () => {
    const text = ["alice", "bob", "carol", "dave", "erin", "frank"]
      .map((login) => `@${login}`)
      .join(" ");
    const result = targets(text);
    expect(MAX_MENTIONS).toBe(5);
    expect(result?.logins).toEqual(["alice", "bob", "carol", "dave", "erin"]);
    expect(result?.userIds).toHaveLength(MAX_MENTIONS);
  });

  it("ignores a mention inside a fenced code block", () => {
    expect(targets("try this\n```\n@alice deploy\n```\n")).toBeUndefined();
    expect(targets("~~~\n@alice\n~~~")).toBeUndefined();
    expect(targets("````\n@alice\n````")).toBeUndefined();
  });

  it("ignores a mention inside inline code", () => {
    expect(targets("the log said `@alice failed` is all")).toBeUndefined();
    expect(targets("write `@alice` in the issue")).toBeUndefined();
    // A run of backticks is how code that itself contains a backtick is written.
    expect(targets("the flag is ``--user=@alice`` here")).toBeUndefined();
  });

  it("keeps a shorter fence inside a longer one as code", () => {
    // Closing on a *shorter* run would take a quoted block for the comment's own
    // text, and ping whoever it names.
    expect(targets("````\n```\n@alice\n```\n````")).toBeUndefined();
    expect(targets("````\n```js\n@alice\n```\n````")).toBeUndefined();
    expect(targets("````\n@alice\n```\n@bob\n````")).toBeUndefined();
  });

  it("runs an unclosed fence to the end of the comment", () => {
    // Markdown swallows the rest, so what follows is code.
    expect(targets("```\n@alice")).toBeUndefined();
    expect(targets("look:\n~~~\n@alice and @bob")).toBeUndefined();
  });

  it("reads the text after a fence that did close", () => {
    expect(targets("```\n@alice\n````\nbut @bob please")?.logins).toEqual(["bob"]);
  });

  it("keeps a fence inside a quote or a list item as code", () => {
    expect(targets("> ```\n> @alice\n> ```")).toBeUndefined();
    expect(targets("- ```\n  @alice\n  ```")).toBeUndefined();
  });

  it("ignores a mention inside HTML code", () => {
    // GitHub renders these as code, so an @ inside one is quoted text.
    expect(targets("<code>@alice</code>")).toBeUndefined();
    expect(targets("<pre>\n@alice\n</pre>")).toBeUndefined();
    expect(targets("see <code>@alice</code> and <code>@bob</code>")).toBeUndefined();
  });

  it("still reads a mention after an unterminated HTML tag", () => {
    // Nothing is code without a closing tag: a comment that discusses `<code>`
    // must not lose the mention that follows it.
    expect(targets("wrap it in <code> and ask @alice")?.logins).toEqual(["alice"]);
  });

  it("still reads a quoted sentence that is not code", () => {
    // Only the container markers come off: a quote is a quote, and a list item is
    // a list item — neither is a code block by itself.
    expect(targets("> @alice please look")?.logins).toEqual(["alice"]);
    expect(targets("- @bob can you check this")?.logins).toEqual(["bob"]);
  });

  it("reads what follows a quoted fence that closed", () => {
    expect(targets("> ```\n> @alice\n> ```\nthanks @bob")?.logins).toEqual(["bob"]);
    expect(targets("- ```\n  @alice\n  ```\n  cc @bob")?.logins).toEqual(["bob"]);
  });

  it("still reads the plain text around a code block", () => {
    expect(targets("```\n@bob\n```\nbut @alice please")?.logins).toEqual(["alice"]);
  });

  it("ignores a mention that continues into a longer login", () => {
    // `@alice_smith` names somebody else: a login cannot contain `_`, so the
    // token does not end there — and `@alice-bob` is one longer login, not two.
    expect(targets("@alice_smith please look")).toBeUndefined();
    expect(targets("@alice-bob please look")).toBeUndefined();
    // The punctuation a sentence actually ends with still terminates one.
    expect(targets("thanks @alice.")?.logins).toEqual(["alice"]);
    expect(targets("cc (@alice, @bob)")?.logins).toEqual(["alice", "bob"]);
  });

  it("ignores a mention written inside a URL", () => {
    // A link to somebody's profile is a reference, not an address.
    expect(targets("see https://example.com/@alice")).toBeUndefined();
    expect(targets("see example.com/@alice")).toBeUndefined();
  });

  it("ignores an escaped or doubled @", () => {
    expect(targets("write \\@alice to mention them")).toBeUndefined();
    expect(targets("@@alice")).toBeUndefined();
  });

  it("ignores an e-mail address that looks like a login", () => {
    expect(targets("mail alice@carol.com")).toBeUndefined();
    expect(targets("mail alice+review@dave.example")).toBeUndefined();
    expect(targets("mail alice.bob@erin.example")).toBeUndefined();
  });

  it("mentions a person once when two logins point at them", () => {
    // `og` is an old handle for alice: the same person, so one @ — and the cap
    // counts people rather than logins.
    expect(targets("@alice and @og")).toEqual({ logins: ["alice"], userIds: ["ou_alice"] });
    expect(targets("@alice @og @bob @carol @dave @erin")).toEqual({
      logins: ["alice", "bob", "carol", "dave", "erin"],
      userIds: ["ou_alice", "ou_bob", "ou_carol", "ou_dave", "ou_erin"],
    });
  });

  it("ignores the reserved words @all and @here", () => {
    expect(targets("@all please look at this")).toBeUndefined();
    expect(targets("@here roll call")).toBeUndefined();
  });

  it("ignores a team or repository reference", () => {
    expect(targets("thanks @platform-team/reviewers")).toBeUndefined();
    expect(targets("see @alice/notify-bus")).toBeUndefined();
  });

  it("ignores a login the channel does not map", () => {
    expect(targets("@stranger please look")).toBeUndefined();
    expect(targets("nothing addressed here")).toBeUndefined();
  });

  it("keeps only the mapped people out of a mixed comment", () => {
    expect(targets("@stranger @alice @platform-team/x @All")?.logins).toEqual(["alice"]);
  });

  it("refuses a comment whose author is not mapped", () => {
    // The conservative half of the policy: a stranger on a public repository
    // cannot make notify-bus @ a teammate, however they phrase it.
    expect(resolveMentionTargets("@alice please review", lookup, "stranger")).toBeUndefined();
    expect(
      resolveMentionTargets("@alice", normalizeMentionMap(undefined), "alice"),
    ).toBeUndefined();
  });

  it("treats an unreadable map as an empty one rather than throwing", () => {
    const junk = normalizeMentionMap({ alice: 5, "": "ou_x", bob: "  " } as unknown as Record<
      string,
      string
    >);
    expect(junk.size).toBe(0);
    expect(resolveMentionTargets("@alice", junk, "alice")).toBeUndefined();
  });
});

describe("commentBodyOf", () => {
  it("reads the comment body both comment events nest", () => {
    expect(commentBodyOf({ comment: { body: "ping @alice" } })).toBe("ping @alice");
  });

  it("is empty when the payload has no comment", () => {
    expect(commentBodyOf({})).toBe("");
    expect(commentBodyOf({ comment: null })).toBe("");
    expect(commentBodyOf({ comment: { body: 42 } })).toBe("");
  });
});

/** An event carrying whatever metadata a test wants to read back. */
function message(metadata: Record<string, unknown>): EventMessage {
  return {
    id: "evt-1",
    event: "issue_comment",
    repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
    actor: { login: "carol", avatar_url: "" },
    payload: {},
    metadata,
  };
}

describe("readMentionTargets", () => {
  it("reads the targets a decision attached", () => {
    const attached = { logins: ["alice"], userIds: ["ou_alice"] };
    expect(readMentionTargets(message({ mentions: attached }))).toEqual(attached);
  });

  it("is empty when nothing was resolved", () => {
    expect(readMentionTargets(message({}))).toEqual({ logins: [], userIds: [] });
    expect(readMentionTargets(message({ mentions: { userIds: "ou_alice" } }))).toEqual({
      logins: [],
      userIds: [],
    });
  });
});
