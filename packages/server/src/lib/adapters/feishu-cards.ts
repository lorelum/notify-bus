/**
 * Per-event Feishu card builders (schema 2.0).
 *
 * Translates an {@link EventMessage} into a rich card: a typed header, a body
 * of elements (markdown, stat divs, link buttons, dividers), and an optional
 * card_link so the whole card is clickable.
 *
 * v2 schema notes (verified against the Feishu docs):
 *   - Buttons link via `behaviors:[{type:"open_url", default_url}]`, not a
 *     top-level `url` (that's the deprecated v1 shorthand).
 *   - Buttons go directly in `elements`; the v1 `tag:"action"` wrapper is gone.
 *   - The v1 `note` element is gone — use a `div` with small grey text instead.
 *   - Markdown elements support `[text](url)`, code blocks, lists, tables.
 *
 * This module owns *structure* (colors, layout, buttons). The body markdown
 * comes from `message.formatted?.body` (rendered from the configured
 * template, or the render layer's default) and is folded in as the content.
 */
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

/** A card body element — a permissive shape covering all the tags we emit. */
export type CardElement = Record<string, unknown>;

/** The shape returned by buildCard: the parts of a Feishu card we control. */
export interface FeishuCard {
  header: { title: string; subtitle?: string; template: CardColor };
  elements: CardElement[];
  /** Makes the whole card clickable. */
  cardLink?: string;
}

// ─── payload accessors ─────────────────────────────────────────────────────
// payload is Record<string, unknown>; these read typed fields defensively.

function asObj(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
}
function asStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asNum(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
function asArr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ─── text helpers ──────────────────────────────────────────────────────────

/** Take the first 7 chars of a sha (GitHub's "short" form). */
function shortSha(sha: string | undefined): string {
  return sha && sha.length > 7 ? sha.slice(0, 7) : (sha ?? "");
}

/** Reduce `refs/heads/main` → `main`, `refs/tags/v1` → `v1`; passthrough otherwise. */
function extractBranch(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

/** Truncate text to ~max chars on a word boundary, appending an ellipsis. */
function truncate(text: string | undefined, max: number): string {
  const clean = (text ?? "").replace(/\r/g, "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trimEnd()}…`;
}

/** Escape characters that break markdown links/bold if left raw (minimal). */
function md(text: string | undefined): string {
  return (text ?? "").replace(/\|/g, "\\|").trim();
}

// ─── element constructors ──────────────────────────────────────────────────

function markdown(content: string): CardElement {
  return { tag: "markdown", content };
}

function hr(): CardElement {
  return { tag: "hr" };
}

function note(content: string): CardElement {
  return {
    tag: "div",
    text: {
      tag: "plain_text",
      content,
      text_size: "notation",
      text_color: "grey",
    },
  };
}

/** A primary link button that opens `url`. */
function linkButton(label: string, url: string, type: "primary" | "default" = "primary"): CardElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    size: "medium",
    behaviors: [{ type: "open_url", default_url: url }],
  };
}

/** Two buttons side by side in a 2-column layout. */
function buttonRow(
  left: { label: string; url: string; type?: "primary" | "default" },
  right: { label: string; url: string; type?: "primary" | "default" },
): CardElement {
  return {
    tag: "column_set",
    flex_mode: "none",
    background_style: "default",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [linkButton(left.label, left.url, left.type ?? "primary")],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [linkButton(right.label, right.url, right.type ?? "default")],
      },
    ],
  };
}

/** A row of up to three short stat fields (e.g. +42 / -7 / 12 files). */
function statRow(stats: Array<{ label: string; value: string }>): CardElement | null {
  if (stats.length === 0) return null;
  return {
    tag: "div",
    fields: stats.map((s) => ({
      is_short: true,
      text: { tag: "lark_md", content: `**${s.label}**\n${s.value}` },
    })),
  };
}

// ─── event-specific builders ───────────────────────────────────────────────

function buildPushCard(message: EventMessage, body: string): FeishuCard {
  const p = message.payload;
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const pusher =
    asStr(asObj(p.pusher).name) ?? asStr(asObj(p.sender).login) ?? message.actor.login;
  const branch = extractBranch(message.ref);
  const compare = asStr(p.compare);
  const commits = asArr(p.commits).map((c) => {
    const co = asObj(c);
    return {
      sha: shortSha(asStr(co.id)),
      message: asStr(co.message),
      author: asStr(asObj(co.author).name) ?? asStr(asObj(co.author).username),
      url: asStr(co.url),
    };
  });

  const elements: CardElement[] = [];
  elements.push(
    markdown(
      `**${md(pusher)}** pushed ${commits.length} commit(s)${
        branch ? ` to \`${branch}\`` : ""
      } to [${md(repo)}](${repoUrl})`,
    ),
  );
  if (body) elements.push(markdown(body));
  elements.push(hr());

  if (commits.length > 0) {
    const max = 5;
    const shown = commits.slice(0, max);
    const lines = shown.map((c) => {
      const head = c.url ? `[\`${c.sha}\`](${c.url})` : `\`${c.sha}\``;
      const firstLine = truncate(c.message, 120)?.split("\n")[0] ?? "";
      return `- ${head} ${md(firstLine)}${c.author ? ` （${md(c.author)}）` : ""}`;
    });
    const overflow = commits.length - shown.length;
    if (overflow > 0) lines.push(`_…and ${overflow} more_`);
    elements.push(markdown(lines.join("\n")));
  }

  // File-change stats from head_commit, if present.
  const head = asObj(p.head_commit);
  const added = asArr(head.added).length;
  const modified = asArr(head.modified).length;
  const removed = asArr(head.removed).length;
  const changed = added + modified + removed;
  if (changed > 0) {
    const stats = statRow([
      { label: "Added", value: `+${added}` },
      { label: "Modified", value: `~${modified}` },
      { label: "Removed", value: `-${removed}` },
    ]);
    if (stats) elements.push(stats);
  }
  elements.push(note(`${message.actor.login} · notify-bus`));

  if (compare) elements.push(linkButton("Compare changes", compare));

  return {
    header: {
      title: `📦 push · ${repo}`,
      subtitle: branch ? `branch: ${branch}` : undefined,
      template: "blue",
    },
    elements,
    cardLink: compare ?? repoUrl,
  };
}

function buildPullRequestCard(message: EventMessage, body: string): FeishuCard {
  const p = message.payload;
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const number = asNum(p.number);
  const action = message.action ?? asStr(p.action) ?? "updated";
  const pr = asObj(p.pull_request);
  const title = asStr(pr.title) ?? "(untitled)";
  const prUrl = asStr(pr.html_url) ?? repoUrl;
  const prBody = truncate(asStr(pr.body), 300);
  const user = asStr(asObj(pr.user).login) ?? message.actor.login;
  const additions = asNum(pr.additions);
  const deletions = asNum(pr.deletions);
  const changedFiles = asNum(pr.changed_files);
  const headRef = asStr(asObj(pr.head).ref);
  const baseRef = asStr(asObj(pr.base).ref);
  const merged = Boolean(pr.merged);
  const compare = `${repoUrl}/files`;

  const elements: CardElement[] = [];
  elements.push(markdown(`### ${md(title)}`));
  if (prBody) elements.push(markdown(prBody));
  if (body) elements.push(markdown(body));

  const stats = statRow([
    { label: "Additions", value: additions !== undefined ? `+${additions}` : "—" },
    { label: "Deletions", value: deletions !== undefined ? `-${deletions}` : "—" },
    { label: "Changed", value: changedFiles !== undefined ? `${changedFiles}` : "—" },
  ]);
  if (stats) {
    elements.push(hr());
    elements.push(stats);
  }
  elements.push(hr());
  const flow = [headRef, baseRef].filter(Boolean).join(" → ");
  elements.push(markdown(`by **${md(user)}**${flow ? ` · \`${flow}\`` : ""}`));
  elements.push(note(`${action} · notify-bus`));
  elements.push(buttonRow(
    { label: "View PR", url: prUrl, type: "primary" },
    { label: "View files", url: compare, type: "default" },
  ));

  return {
    header: {
      title: `🔀 PR #${number ?? "?"} ${action} · ${repo}`,
      template: merged ? "violet" : "purple",
    },
    elements,
    cardLink: prUrl,
  };
}

function buildIssuesCard(message: EventMessage, body: string): FeishuCard {
  const p = message.payload;
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const number = asNum(p.number);
  const action = message.action ?? asStr(p.action) ?? "updated";
  const issue = asObj(p.issue);
  const title = asStr(issue.title) ?? "(untitled)";
  const issueUrl = asStr(issue.html_url) ?? repoUrl;
  const issueBody = truncate(asStr(issue.body), 300);
  const user = asStr(asObj(issue.user).login) ?? message.actor.login;
  const state = asStr(issue.state);

  const elements: CardElement[] = [];
  elements.push(markdown(`### ${md(title)}`));
  if (issueBody) elements.push(markdown(issueBody));
  if (body) elements.push(markdown(body));
  elements.push(hr());
  const stateLine = state ? ` · state: \`${state}\`` : "";
  elements.push(markdown(`by **${md(user)}**${stateLine}`));
  elements.push(note(`${action} · notify-bus`));
  elements.push(linkButton("View Issue", issueUrl));

  const color: CardColor =
    action === "closed" ? "green" : action === "reopened" ? "turquoise" : "orange";
  return {
    header: { title: `❗ Issue #${number ?? "?"} ${action} · ${repo}`, template: color },
    elements,
    cardLink: issueUrl,
  };
}

function buildReleaseCard(message: EventMessage, body: string): FeishuCard {
  const p = message.payload;
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const release = asObj(p.release);
  const name = asStr(release.name) ?? asStr(release.tag_name) ?? "release";
  const tag = asStr(release.tag_name) ?? "";
  const releaseUrl = asStr(release.html_url) ?? repoUrl;
  const relBody = truncate(asStr(release.body), 500);
  const author = asStr(asObj(release.author).login) ?? message.actor.login;
  const prerelease = Boolean(release.prerelease);

  const elements: CardElement[] = [];
  elements.push(markdown(`### ${md(name)}${tag ? ` (\`${tag}\`)` : ""}`));
  if (relBody) elements.push(markdown(relBody));
  if (body) elements.push(markdown(body));
  elements.push(hr());
  const badge = prerelease ? " · `prerelease`" : "";
  elements.push(markdown(`by **${md(author)}**${badge}`));
  elements.push(note("release · notify-bus"));
  elements.push(linkButton("View Release", releaseUrl));

  return {
    header: { title: `🏷️ release ${tag} · ${repo}`, template: prerelease ? "yellow" : "turquoise" },
    elements,
    cardLink: releaseUrl,
  };
}

function buildStarCard(message: EventMessage, body: string): FeishuCard {
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const actor = message.actor.login;
  const action = message.action ?? "created";
  const verb = action === "deleted" ? "unstarred" : "starred";
  const elements: CardElement[] = [
    markdown(`**${md(actor)}** ${verb} ⭐ [${md(repo)}](${repoUrl})`),
  ];
  if (body) elements.push(markdown(body));
  elements.push(linkButton("View Repo", repoUrl, "default"));
  return {
    header: { title: `⭐ ${actor} ${verb} ${repo}`, template: "wathet" },
    elements,
    cardLink: repoUrl,
  };
}

function buildForkCard(message: EventMessage, body: string): FeishuCard {
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const actor = message.actor.login;
  const forkee = asObj(message.payload.forkee);
  const forkeeUrl = asStr(forkee.html_url) ?? "";
  const forkeeName = asStr(forkee.full_name) ?? "a fork";
  const elements: CardElement[] = [
    markdown(`**${md(actor)}** forked 🍴 [${md(repo)}](${repoUrl}) → [${md(forkeeName)}](${forkeeUrl})`),
  ];
  if (body) elements.push(markdown(body));
  elements.push(linkButton("View Repo", repoUrl, "default"));
  return {
    header: { title: `🍴 ${actor} forked ${repo}`, template: "wathet" },
    elements,
    cardLink: repoUrl,
  };
}

function buildFallbackCard(message: EventMessage, body: string): FeishuCard {
  const repo = message.repository.full_name;
  const content =
    body ||
    `**${md(message.event)}**${message.action ? ` · ${md(message.action)}` : ""}\n` +
      `Repo: [${md(repo)}](${message.repository.html_url})\n` +
      `by **${md(message.actor.login)}**`;
  return {
    header: {
      title: `${message.event} · ${repo}`,
      template: "grey",
    },
    elements: [markdown(content)],
    cardLink: message.repository.html_url,
  };
}

/**
 * Build a rich Feishu card for the given event, dispatching on event type.
 *
 * @param message  the fully-rendered event (formatted.body is the optional
 *                 template-rendered markdown, folded in as extra content).
 */
export function buildCard(message: EventMessage): FeishuCard {
  const body = message.formatted?.body ?? "";
  switch (message.event) {
    case "push":
      return buildPushCard(message, body);
    case "pull_request":
      return buildPullRequestCard(message, body);
    case "issues":
      return buildIssuesCard(message, body);
    case "release":
      return buildReleaseCard(message, body);
    case "star":
      return buildStarCard(message, body);
    case "fork":
      return buildForkCard(message, body);
    default:
      return buildFallbackCard(message, body);
  }
}
