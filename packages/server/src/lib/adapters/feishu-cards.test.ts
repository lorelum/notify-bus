import { describe, expect, it } from "bun:test";
import { buildCard } from "./feishu-cards";
import type { EventMessage } from "../../types";

/** Minimal EventMessage with a raw GitHub-shaped payload + optional formatted body. */
function msg(
  event: string,
  payload: Record<string, unknown>,
  opts: { action?: string; formattedBody?: string; ref?: string } = {},
): EventMessage {
  return {
    id: "evt-1",
    event,
    action: opts.action,
    ref: opts.ref,
    repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
    actor: { login: "alice", avatar_url: "https://gh/alice.png" },
    payload,
    metadata: {},
    formatted: opts.formattedBody
      ? { title: "t", body: opts.formattedBody }
      : undefined,
  };
}

function findButtonUrls(elements: unknown[]): string[] {
  const urls: string[] = [];
  for (const el of elements) {
    const tag = (el as { tag?: string }).tag;
    if (tag === "button") {
      const behaviors = (el as { behaviors?: { default_url?: string }[] }).behaviors ?? [];
      for (const b of behaviors) if (b.default_url) urls.push(b.default_url);
    }
    if (tag === "column_set") {
      for (const col of (el as { columns?: { elements?: unknown[] }[] }).columns ?? []) {
        urls.push(...findButtonUrls((col.elements ?? []) as unknown[]));
      }
    }
  }
  return urls;
}

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
          { id: "fedcba9876543210", message: "docs: readme", author: { name: "Alice", username: "alice" } },
        ],
        head_commit: { added: ["a.ts"], modified: ["b.ts", "c.ts"], removed: ["d.ts"] },
      },
      { ref: "refs/heads/main" },
    ),
  );

  it("uses a blue header with the repo + branch subtitle", () => {
    expect(card.header.template).toBe("blue");
    expect(card.header.title).toBe("📦 push · org/repo");
    expect(card.header.subtitle).toBe("branch: main");
  });

  it("lists commits with short shas, capped at 5", () => {
    const md = card.elements.find(
      (e) =>
        (e as { tag?: string }).tag === "markdown" &&
        typeof (e as { content?: string }).content === "string" &&
        (e as { content: string }).content.includes("0123456"),
    );
    expect(md).toBeTruthy();
    const content = (md as { content: string }).content;
    expect(content).toContain("`0123456`");
    expect(content).toContain("fix: login");
  });

  it("includes the compare button and card link", () => {
    const urls = findButtonUrls(card.elements);
    expect(urls).toContain("https://github.com/org/repo/compare/abc...def");
    expect(card.cardLink).toBe("https://github.com/org/repo/compare/abc...def");
  });

  it("shows a +/~/- stat row from head_commit", () => {
    const divs = card.elements.filter((e) => (e as { tag?: string }).tag === "div" && "fields" in (e as object));
    expect(divs.length).toBeGreaterThan(0);
  });

  it("caps commits at 5 and notes the overflow", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `sha${i}000000`,
      message: `commit ${i}`,
      author: { name: "Alice" },
    }));
    const c = buildCard(msg("push", { ref: "refs/heads/x", commits: many }, { ref: "refs/heads/x" }));
    const listMd = c.elements
      .filter((e) => (e as { tag?: string }).tag === "markdown")
      .map((e) => (e as { content?: string }).content ?? "")
      .join("\n");
    expect(listMd).toContain("…and 3 more");
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

  it("uses a purple header with PR number + action", () => {
    expect(card.header.template).toBe("purple");
    expect(card.header.title).toContain("PR #42");
    expect(card.header.title).toContain("opened");
  });

  it("links the card and the View PR button to the PR url", () => {
    expect(card.cardLink).toBe("https://github.com/org/repo/pull/42");
    const urls = findButtonUrls(card.elements);
    expect(urls).toContain("https://github.com/org/repo/pull/42");
  });

  it("renders additions/deletions/changed stat tiles", () => {
    const divs = card.elements.filter((e) => "fields" in (e as object));
    expect(divs.length).toBeGreaterThan(0);
  });

  it("uses violet when the PR is merged", () => {
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
  });
});

describe("buildCard · issues", () => {
  it("is orange when opened and green when closed", () => {
    const opened = buildCard(
      msg("issues", {
        action: "opened",
        number: 7,
        issue: { title: "Bug", html_url: "https://github.com/org/repo/issues/7", body: "it broke", user: { login: "carol" }, state: "open" },
      }, { action: "opened" }),
    );
    expect(opened.header.template).toBe("orange");
    expect(opened.cardLink).toBe("https://github.com/org/repo/issues/7");
    expect(findButtonUrls(opened.elements)).toContain("https://github.com/org/repo/issues/7");

    const closed = buildCard(
      msg("issues", {
        action: "closed",
        number: 7,
        issue: { title: "Bug", html_url: "https://github.com/org/repo/issues/7", user: { login: "carol" }, state: "closed" },
      }, { action: "closed" }),
    );
    expect(closed.header.template).toBe("green");
  });
});

describe("buildCard · release", () => {
  it("is turquoise for a normal release", () => {
    const card = buildCard(
      msg("release", {
        action: "published",
        release: {
          name: "v1.0.0",
          tag_name: "v1.0.0",
          html_url: "https://github.com/org/repo/releases/tag/v1.0.0",
          body: "first stable",
          author: { login: "dave" },
          prerelease: false,
        },
      }, { action: "published" }),
    );
    expect(card.header.template).toBe("turquoise");
    expect(card.cardLink).toBe("https://github.com/org/repo/releases/tag/v1.0.0");
    expect(findButtonUrls(card.elements)).toContain("https://github.com/org/repo/releases/tag/v1.0.0");
  });

  it("is yellow for a prerelease", () => {
    const card = buildCard(
      msg("release", {
        action: "prereleased",
        release: { name: "v2-beta", tag_name: "v2.0.0-beta", html_url: "u", author: { login: "d" }, prerelease: true },
      }, { action: "prereleased" }),
    );
    expect(card.header.template).toBe("yellow");
  });
});

describe("buildCard · star / fork", () => {
  it("star is wathet and links the repo", () => {
    const card = buildCard(msg("star", { action: "created", starred_at: "x" }, { action: "created" }));
    expect(card.header.template).toBe("wathet");
    expect(card.header.title).toContain("starred");
    expect(findButtonUrls(card.elements)).toContain("https://github.com/org/repo");
  });

  it("fork is wathet and mentions the fork", () => {
    const card = buildCard(
      msg("fork", {
        forkee: { full_name: "eve/repo", html_url: "https://github.com/eve/repo" },
      }),
    );
    expect(card.header.template).toBe("wathet");
    expect(card.header.title).toContain("forked");
  });
});

describe("buildCard · fallback", () => {
  it("renders a grey card for an unknown event and does not crash", () => {
    const card = buildCard(msg("deployment", { environment: "prod" }));
    expect(card.header.template).toBe("grey");
    expect(card.elements.length).toBeGreaterThan(0);
    expect(card.cardLink).toBe("https://github.com/org/repo");
  });

  it("folds in the template-rendered body when provided", () => {
    const card = buildCard(msg("deployment", {}, { formattedBody: "**custom body**" }));
    const md = card.elements
      .filter((e) => (e as { tag?: string }).tag === "markdown")
      .map((e) => (e as { content?: string }).content ?? "")
      .join("\n");
    expect(md).toContain("custom body");
  });
});

describe("buildCard · schema correctness", () => {
  it("buttons use behaviors:[{type:'open_url',default_url}], not a top-level url", () => {
    const card = buildCard(
      msg("pull_request", {
        action: "opened",
        number: 1,
        pull_request: { title: "t", html_url: "https://x", user: { login: "y" } },
      }, { action: "opened" }),
    );
    const allElements = card.elements;
    for (const el of allElements) {
      if ((el as { tag?: string }).tag !== "button") continue;
      expect((el as { behaviors?: unknown }).behaviors).toBeTypeOf("object");
      expect((el as { url?: unknown }).url).toBeUndefined();
    }
  });

  it("no element uses the removed v2 tags (action, note)", () => {
    const events = ["push", "pull_request", "issues", "release", "star", "fork", "unknown"];
    for (const e of events) {
      const card = buildCard(msg(e, e === "pull_request" ? { pull_request: { title: "t", html_url: "u", user: { login: "x" } } } : {}));
      for (const el of card.elements) {
        const tag = (el as { tag?: string }).tag;
        expect(tag).not.toBe("action");
        expect(tag).not.toBe("note");
      }
    }
  });
});
