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

/** Recursively collect button open_url destinations from elements + columns. */
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

/** Stringify a card's elements (recursing into column_set columns) so we can
 * grep for inline markup like <font> and <text_tag>. */
function elementMarkdown(elements: unknown[]): string {
  const out: string[] = [];
  const walk = (els: unknown[]): void => {
    for (const el of els) {
      const tag = (el as { tag?: string }).tag;
      if (tag === "markdown") {
        const content = (el as { content?: string }).content;
        if (typeof content === "string") out.push(content);
      } else if (tag === "div") {
        const text = (el as { text?: { content?: string } }).text;
        if (text?.content) out.push(text.content);
        for (const f of (el as { fields?: { text?: { content?: string } }[] }).fields ?? []) {
          if (f.text?.content) out.push(f.text.content);
        }
      } else if (tag === "column_set") {
        for (const col of (el as { columns?: { elements?: unknown[] }[] }).columns ?? []) {
          walk((col.elements ?? []) as unknown[]);
        }
      }
    }
  };
  walk(elements);
  return out.join("\n");
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
    const c = buildCard(msg("push", { ref: "refs/heads/x", commits: many }, { ref: "refs/heads/x" }));
    expect(elementMarkdown(c.elements)).toContain("+3 more commits");
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

describe("buildCard · issues", () => {
  it("is orange when opened, green when closed, with action badges", () => {
    const opened = buildCard(
      msg("issues", {
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
      }, { action: "opened" }),
    );
    expect(opened.header.template).toBe("orange");
    expect(opened.header.badges?.[0]).toEqual({ text: "opened", color: "turquoise" });
    expect(findButtonUrls(opened.elements)).toContain("https://github.com/org/repo/issues/7");

    const closed = buildCard(
      msg("issues", {
        action: "closed",
        number: 7,
        issue: { title: "Bug", html_url: "u", user: { login: "c" }, state: "closed" },
      }, { action: "closed" }),
    );
    expect(closed.header.template).toBe("green");
    expect(closed.header.badges?.[0]).toEqual({ text: "closed", color: "red" });
  });

  it("renders labels as colored text_tag pills", () => {
    const card = buildCard(
      msg("issues", {
        action: "opened",
        number: 1,
        issue: {
          title: "t",
          html_url: "u",
          user: { login: "c" },
          labels: [{ name: "bug" }, { name: "enhancement" }],
        },
      }, { action: "opened" }),
    );
    const text = elementMarkdown(card.elements);
    expect(text).toContain('<text_tag color="blue">bug</text_tag>');
    expect(text).toContain('<text_tag color="turquoise">enhancement</text_tag>');
  });
});

describe("buildCard · release", () => {
  it("is turquoise, with tag + author + button", () => {
    const card = buildCard(
      msg("release", {
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
      }, { action: "published" }),
    );
    expect(card.header.template).toBe("turquoise");
    expect(card.header.badges?.[0]).toEqual({ text: "v1.0.0", color: "neutral" });
    expect(elementMarkdown(card.elements)).toContain("2 assets");
    expect(findButtonUrls(card.elements)).toContain("https://github.com/org/repo/releases/tag/v1.0.0");
  });

  it("is yellow + prerelease badge for a prerelease", () => {
    const card = buildCard(
      msg("release", {
        action: "prereleased",
        release: { name: "v2-beta", tag_name: "v2.0.0-beta", html_url: "u", author: { login: "d" }, prerelease: true },
      }, { action: "prereleased" }),
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
});

describe("buildCard · no whole-card link", () => {
  it("never emits a cardLink (regression guard against re-adding card_link)", () => {
    const events = ["push", "pull_request", "issues", "release", "star", "fork", "deployment"];
    for (const e of events) {
      const c = buildCard(msg(e, e === "pull_request" ? { pull_request: { title: "t", html_url: "u", user: { login: "x" } } } : {}));
      expect((c as { cardLink?: unknown }).cardLink).toBeUndefined();
      expect("cardLink" in c).toBe(false);
    }
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
    for (const el of card.elements) {
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
