/**
 * The vocabulary every Feishu card module shares (schema 2.0).
 *
 * The per-event builders live in their own modules and import from here:
 * `feishu-cards.ts` (push, pull_request, issues, release, star, fork and the
 * fallback), `feishu-comment-card.ts` (`issue_comment`) and
 * `feishu-repository-card.ts` (`repository`). This module holds only what more
 * than one of them needs — the card types, the payload accessors, the markdown
 * and element constructors, the navigation rule and the action palette. Nothing
 * event-specific belongs here.
 *
 * v2 schema notes (verified against the Feishu docs):
 *   - Buttons link via `behaviors:[{type:"open_url", default_url}]`, not a
 *     top-level `url` (that's the deprecated v1 shorthand).
 *   - Buttons go directly in `elements`; the v1 `tag:"action"` wrapper is gone.
 *   - The v1 `note` element is gone — use a `div` with small grey text instead.
 *   - Inside markdown/lark_md: `<text_tag color="green">label</text_tag>`
 *     renders a colored pill; `<font color="green">+42</font>` colors text.
 */
import { isReservedMention, readMentionTargets } from "../mentions";
import type { EventMessage } from "../../types";

/** Header color theme (Feishu enum). */
export type CardColor =
  | "blue"
  | "wathet"
  | "turquoise"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "carmine"
  | "violet"
  | "purple"
  | "indigo"
  | "grey";

/** text_tag / font color (superset of header colors incl. `neutral`, `lime`). */
export type TagColor =
  | "neutral"
  | "blue"
  | "turquoise"
  | "lime"
  | "orange"
  | "violet"
  | "indigo"
  | "wathet"
  | "green"
  | "yellow"
  | "red"
  | "purple"
  | "carmine";

/** A card body element — a permissive shape covering all the tags we emit. */
export type CardElement = Record<string, unknown>;

/** A header suffix badge (renders as a colored pill next to the title). */
export interface HeaderBadge {
  text: string;
  color: TagColor;
}

/** The shape returned by a card builder: the parts of a Feishu card we control. */
export interface FeishuCard {
  header: {
    title: string;
    subtitle?: string;
    template: CardColor;
    badges?: HeaderBadge[];
  };
  elements: CardElement[];
}

// ─── payload accessors ─────────────────────────────────────────────────────

export function asObj(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
}
export function asStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export function asNum(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
export function asArr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ─── text helpers ──────────────────────────────────────────────────────────

/** Short sha (first 7 chars). */
export function shortSha(sha: string | undefined): string {
  return sha && sha.length > 7 ? sha.slice(0, 7) : (sha ?? "");
}

/** Truncate + ellipsis. Returns "" for empty/whitespace. */
export function truncate(text: string | undefined, max: number): string {
  const clean = (text ?? "").replace(/\r/g, "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trimEnd()}…`;
}

/**
 * Make a value from the GitHub payload safe to embed in card markdown.
 *
 * Everything user-controlled reaches the card through here: commit messages,
 * issue/PR titles and bodies, comments, branch names, labels, logins. Feishu's
 * card markdown recognises a set of HTML-like tags (`<at>`, `<font>`,
 * `<text_tag>`, `<a>`, ...), so without escaping a commit message could smuggle
 * one in and have it executed as card markup — forging styling, or (for
 * `<at id=all>`) making the entire card fail to send (#16).
 *
 * Feishu's documented escaping form is the *numeric* entity (`&#60;` for `<`,
 * `&#62;` for `>`), not the named `&lt;` / `&gt;` forms.
 *
 * Markup a builder generates is concatenated *around* the escaped text and
 * never passes through here, so generated tags keep working while user-supplied
 * ones are neutralised.
 *
 * Note: `>` is escaped too, which means a literal quote line inside a PR or
 * issue body renders as text rather than as a blockquote. That is deliberate —
 * user text should not control card layout, and the platform lists `&#62;` in
 * its escaping table.
 */
export function md(text: string | undefined): string {
  return (
    (text ?? "")
      // `&` first, so the entities introduced below are not double-escaped.
      .replace(/&/g, "&#38;")
      .replace(/</g, "&#60;")
      .replace(/>/g, "&#62;")
      .replace(/\|/g, "\\|")
      .trim()
  );
}

// ─── targeted mentions ─────────────────────────────────────────────────────

/**
 * A real Feishu mention, for the `user_id`s a channel's `mention_map` holds. Only
 * a mapped id may be interpolated — the markup is generated here, never assembled
 * from a payload, and the text around it still goes through {@link md}. The form
 * is the one the test-group spike verified.
 */
export function at(userId: string): string {
  // `all` addresses the whole chat. The loader rejects a map holding it, but a
  // caller that skipped the config path must fail loudly rather than ping a group.
  if (isReservedMention(userId)) {
    throw new Error(`refusing to mention the reserved Feishu id "${userId}"`);
  }
  return `<at id=${userId}></at>`;
}

/**
 * The @ line for the targets a `mention_only` route resolved for this event, or
 * `""` when it names nobody. Reading the route's own result — not parsing the
 * comment again — is what keeps the card and the decision identical.
 */
export function mentionLine(message: EventMessage): string {
  return readMentionTargets(message)
    .userIds.map((userId) => at(userId))
    .join(" ");
}

// ─── element constructors ──────────────────────────────────────────────────

export function markdown(content: string): CardElement {
  return { tag: "markdown", content };
}

export function hr(): CardElement {
  return { tag: "hr" };
}

/** A link button that opens `url`. */
export function linkButton(
  label: string,
  url: string,
  type: "primary" | "default" = "primary",
): CardElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    size: "medium",
    behaviors: [{ type: "open_url", default_url: url }],
  };
}

/**
 * A column_set of equally-weighted columns. Each column is a list of elements.
 * Pairs nicely with markdown "info tiles" for author | stats layouts.
 */
export function columnSet(columns: CardElement[][]): CardElement {
  return {
    tag: "column_set",
    flex_mode: "none",
    background_style: "default",
    columns: columns.map((elements) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "top",
      elements,
    })),
  };
}

// ─── card navigation ───────────────────────────────────────────────────────

/** A navigation target: the label to render, the URL it opens, and its style. */
export interface NavTarget {
  label: string;
  /** Absent when the payload carries no URL for this target. */
  url?: string;
  /**
   * `primary` marks the card's own object. The repository is *secondary*
   * navigation, so it always renders `default`. Spelled out at every call site
   * rather than defaulted, so no target's style is left implicit — the single
   * button left behind by a missing object URL used to come out `primary`,
   * disagreeing with the `star` and fallback cards' own repo buttons.
   */
  type: "primary" | "default";
}

/**
 * The navigation a card ends with: its own object(s) first, then the repository.
 *
 * Two #26 rules live here rather than in each builder:
 *
 *   - a target with no URL drops its own button. It is never re-pointed at the
 *     repository under the object's label — that is how "View PR" came to open
 *     the repo, and "View files" a `<repo url>/files` that does not exist;
 *   - "View Repo" is added only when `repository.html_url` holds a real URL (an
 *     org-scoped event has no repository to open) and only when no other button
 *     already opens that same URL.
 *
 * Cards that already navigate to the repository compose their own single button
 * instead of calling this, so no second repo link is added to them.
 *
 * One button renders bare, several share an equally-weighted row. The card's own
 * object is `primary`; the repository added here is always `default`.
 */
export function navigationButtons(targets: readonly NavTarget[], repoUrl: string): CardElement[] {
  const buttons = targets.filter((target): target is NavTarget & { url: string } =>
    Boolean(target.url),
  );
  if (repoUrl && !buttons.some((button) => button.url === repoUrl)) {
    buttons.push({ label: "View Repo", url: repoUrl, type: "default" });
  }
  if (buttons.length === 0) return [];
  if (buttons.length === 1) {
    const only = buttons[0]!;
    return [linkButton(only.label, only.url, only.type)];
  }
  return [columnSet(buttons.map((button) => [linkButton(button.label, button.url, button.type)]))];
}

// ─── action palette ────────────────────────────────────────────────────────

/**
 * Map a PR/issue/repository action to a colored badge.
 *
 * The palette is governed by one rule: an action the reader may need to *act
 * on* gets a colour of its own, and routine churn stays `neutral` so it can
 * never be mistaken for a signal. (Tag colours are a small finite enum, so
 * pairwise distinguishability across every action is not the goal — telling
 * "needs attention" apart from "noise" is.)
 */
export function actionBadge(action: string): HeaderBadge {
  const map: Record<string, TagColor> = {
    // Activation / progress.
    opened: "turquoise",
    reopened: "green",
    created: "wathet",
    ready_for_review: "blue",
    published: "turquoise",
    released: "turquoise",
    prereleased: "yellow",
    // Terminal or destructive.
    closed: "red",
    deleted: "red",
    unpublished: "red",
    merged: "violet",
    // Needs the reader to act.
    review_requested: "orange",
    assigned: "indigo",
    converted_to_draft: "yellow",
    transferred: "carmine",
    renamed: "purple",
    publicized: "red",
    // Routine churn — deliberately neutral.
    synchronize: "neutral",
    labeled: "neutral",
    unlabeled: "neutral",
    unassigned: "neutral",
    review_request_removed: "neutral",
    milestoned: "neutral",
    demilestoned: "neutral",
    edited: "neutral",
    updated: "neutral",
    locked: "neutral",
    unlocked: "neutral",
    pinned: "neutral",
    unpinned: "neutral",
    auto_merge_enabled: "neutral",
    auto_merge_disabled: "neutral",
  };
  return { text: action, color: map[action] ?? "neutral" };
}
