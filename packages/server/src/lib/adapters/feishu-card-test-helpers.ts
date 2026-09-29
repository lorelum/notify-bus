/**
 * Shared fixtures and collectors for the Feishu card tests.
 *
 * Split out of `feishu-cards.test.ts` when the `issue_comment` and
 * `repository` builders got test files of their own (#21). Not a test file
 * itself — it holds no tests.
 *
 * `prodCard` deliberately goes through `buildCard` rather than calling a
 * builder directly: it is the production path (template render, then dispatch),
 * which is where #16's bug lived and what #17 asked the tests to cover.
 */
import { buildCard } from "./feishu-cards";
import { renderFormatted } from "../render";
import type { EventMessage } from "../../types";

/** Minimal EventMessage with a raw GitHub-shaped payload + optional formatted body. */
export function msg(
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
    formatted: opts.formattedBody ? { title: "t", body: opts.formattedBody } : undefined,
  };
}

/**
 * The same message with no repository url — what an org-scoped or partial
 * payload resolves to (webhook.ts falls back to "" when neither the repository
 * nor the organization carries one). `msg()` always supplies a url, so the
 * missing-url cases need their own constructor.
 */
export function msgWithoutRepoUrl(
  event: string,
  payload: Record<string, unknown>,
  action?: string,
): EventMessage {
  return {
    ...msg(event, payload, { action }),
    repository: { full_name: "org/repo", html_url: "" },
  };
}

/**
 * Every button with its raw destination and style, recursing into column_set
 * columns.
 *
 * A button whose `default_url` is empty is kept (`url: ""`) rather than
 * dropped: a dead button opens nothing when clicked, so a helper that filtered
 * empty targets out could not tell it apart from no button at all.
 */
export function findRawButtons(
  elements: unknown[],
): { label: string; url: string; type: string }[] {
  const buttons: { label: string; url: string; type: string }[] = [];
  for (const el of elements) {
    const tag = (el as { tag?: string }).tag;
    if (tag === "button") {
      const label = (el as { text?: { content?: string } }).text?.content ?? "";
      const type = (el as { type?: string }).type ?? "";
      const behaviors = (el as { behaviors?: { default_url?: string }[] }).behaviors ?? [];
      if (behaviors.length === 0) buttons.push({ label, url: "", type });
      for (const b of behaviors) buttons.push({ label, url: b.default_url ?? "", type });
    }
    if (tag === "column_set") {
      for (const col of (el as { columns?: { elements?: unknown[] }[] }).columns ?? []) {
        buttons.push(...findRawButtons((col.elements ?? []) as unknown[]));
      }
    }
  }
  return buttons;
}

/** Buttons that actually open something. */
export function findButtons(elements: unknown[]): { label: string; url: string }[] {
  return findRawButtons(elements)
    .filter((button) => button.url.length > 0)
    .map(({ label, url }) => ({ label, url }));
}

/** Recursively collect button open_url destinations from elements + columns. */
export function findButtonUrls(elements: unknown[]): string[] {
  return findButtons(elements).map((button) => button.url);
}

/** Stringify a card's elements (recursing into column_set columns) so we can
 * grep for inline markup like <font> and <text_tag>. */
export function elementMarkdown(elements: unknown[]): string {
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

/**
 * Build a card through the real production path — template render, then card
 * assembly. Tests that read payload fields go through here: calling
 * `buildCard()` directly cannot see the template/composition layer, which is
 * where #16's bug lived and what #17 asked the tests to cover.
 *
 * `opts` passes the two inputs a card can depend on beyond its event (#36): the
 * channel's mention map, and the targets a route already resolved, which
 * production carries on `message.metadata` exactly as this does.
 */
export function prodCard(
  event: string,
  payload: Record<string, unknown>,
  action?: string,
  opts: {
    mentionMap?: Record<string, string>;
    mentions?: { logins: string[]; userIds: string[] };
  } = {},
): ReturnType<typeof buildCard> {
  const base = msg(event, payload, { action });
  const message = opts.mentions ? { ...base, metadata: { mentions: opts.mentions } } : base;
  return buildCard(renderFormatted(message, undefined), { mentionMap: opts.mentionMap });
}

/** All markdown text of a card built through the production path. */
export function cardText(event: string, payload: Record<string, unknown>, action?: string): string {
  return elementMarkdown(prodCard(event, payload, action).elements);
}
