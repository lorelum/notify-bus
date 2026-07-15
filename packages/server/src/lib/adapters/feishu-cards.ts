/**
 * Per-event Feishu card builders (schema 2.0).
 *
 * Translates an {@link EventMessage} into a rich card: a typed header (with
 * optional badge pills), a body of elements (markdown, column layouts, stat
 * tiles, link buttons, dividers). The whole card is NOT clickable — links
 * live in explicit buttons and inline markdown links.
 *
 * v2 schema notes (verified against the Feishu docs):
 *   - Buttons link via `behaviors:[{type:"open_url", default_url}]`, not a
 *     top-level `url` (that's the deprecated v1 shorthand).
 *   - Buttons go directly in `elements`; the v1 `tag:"action"` wrapper is gone.
 *   - The v1 `note` element is gone — use a `div` with small grey text instead.
 *   - Inside markdown/lark_md: `<text_tag color="green">label</text_tag>`
 *     renders a colored pill; `<font color="green">+42</font>` colors text.
 *
 * This module owns *structure* (colors, layout, buttons). The body markdown
 * comes from `message.formatted?.body` (the configured template, or the render
 * layer's default) and is folded in as extra content.
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

/** The shape returned by buildCard: the parts of a Feishu card we control. */
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

/** Short sha (first 7 chars). */
function shortSha(sha: string | undefined): string {
  return sha && sha.length > 7 ? sha.slice(0, 7) : (sha ?? "");
}

/** `refs/heads/main` → `main`, `refs/tags/v1` → `v1`. */
function extractBranch(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

/** Truncate + ellipsis. Returns "" for empty/whitespace. */
function truncate(text: string | undefined, max: number): string {
  const clean = (text ?? "").replace(/\r/g, "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trimEnd()}…`;
}

/** First line of a commit message, truncated. */
function firstLine(msg: string | undefined, max = 120): string {
  return truncate(msg, max)?.split("\n")[0] ?? "";
}

/** Escape pipe so it doesn't break tables; trim whitespace. */
function md(text: string | undefined): string {
  return (text ?? "").replace(/\|/g, "\\|").trim();
}

/** A `<text_tag>` pill, for embedding inside markdown content. */
function textTag(color: TagColor, text: string): string {
  return `<text_tag color="${color}">${md(text)}</text_tag>`;
}

/** Colored inline text via `<font>`, for stats like +42 / -7. */
function colored(color: TagColor, text: string): string {
  return `<font color="${color}">${text}</font>`;
}

/** A markdown link, only if url is present. */
function maybeLink(label: string, url: string | undefined): string {
  return url ? `[${md(label)}](${url})` : md(label);
}

// ─── element constructors ──────────────────────────────────────────────────

function markdown(content: string): CardElement {
  return { tag: "markdown", content };
}

function hr(): CardElement {
  return { tag: "hr" };
}

/** Small grey footnote line (the v2 replacement for the removed `note`). */
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

/** A link button that opens `url`. */
function linkButton(
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

/** Two buttons side by side. */
function buttonRow(
  left: { label: string; url: string; type?: "primary" | "default" },
  right: { label: string; url: string; type?: "primary" | "default" },
): CardElement {
  return columnSet([
    [linkButton(left.label, left.url, left.type ?? "primary")],
    [linkButton(right.label, right.url, right.type ?? "default")],
  ]);
}

/**
 * A column_set of equally-weighted columns. Each column is a list of elements.
 * Pairs nicely with markdown "info tiles" for author | stats layouts.
 */
function columnSet(columns: CardElement[][]): CardElement {
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

// ─── event-specific builders ───────────────────────────────────────────────

function buildPushCard(message: EventMessage, body: string): FeishuCard {
  const p = message.payload;
  const repo = message.repository.full_name;
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

  const head = asObj(p.head_commit);
  const added = asArr(head.added).length;
  const modified = asArr(head.modified).length;
  const removed = asArr(head.removed).length;
  const changed = added + modified + removed;

  const elements: CardElement[] = [];

  // Info row: author + branch | file-change stats (colored).
  const leftCol = markdown(
    `👤 **${md(pusher)}**${branch ? `\n🔀 \`${branch}\`` : ""}`,
  );
  const rightParts: string[] = [];
  if (changed > 0) {
    rightParts.push(
      `📁 ${colored("green", `+${added}`)} ${colored("orange", `~${modified}`)} ${colored("red", `-${removed}`)}`,
    );
  }
  rightParts.push(`📦 ${commits.length} commit${commits.length === 1 ? "" : "s"}`);
  elements.push(columnSet([[leftCol], [markdown(rightParts.join("\n"))]]));

  elements.push(hr());

  // Commit list (capped at 5 + overflow note).
  if (commits.length > 0) {
    const max = 5;
    const shown = commits.slice(0, max);
    const lines = shown.map((c) => {
      const headSha = c.url ? `[\`${c.sha}\`](${c.url})` : `\`${c.sha}\``;
      const authorTag = c.author ? ` ${textTag("neutral", c.author)}` : "";
      return `- ${headSha} ${md(firstLine(c.message))}${authorTag}`;
    });
    const overflow = commits.length - shown.length;
    if (overflow > 0) lines.push(`_+${overflow} more commit${overflow === 1 ? "" : "s"}_`);
    elements.push(markdown(lines.join("\n")));
  }

  if (body) elements.push(markdown(body));

  elements.push(note(`in ${repo} · notify-bus`));
  if (compare) elements.push(linkButton("Compare changes", compare));

  return {
    header: {
      title: `📦 ${commits.length} commit${commits.length === 1 ? "" : "s"} pushed`,
      subtitle: branch ? `${repo} › ${branch}` : repo,
      template: "blue",
      badges: [{ text: "push", color: "blue" }],
    },
    elements,
  };
}

/** Map a PR/issue action to a colored badge. */
function actionBadge(action: string): HeaderBadge {
  const map: Record<string, TagColor> = {
    opened: "turquoise",
    reopened: "green",
    closed: "red",
    merged: "violet",
    synchronize: "neutral",
    ready_for_review: "blue",
    published: "turquoise",
    prereleased: "yellow",
    created: "wathet",
  };
  return { text: action, color: map[action] ?? "neutral" };
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
  const draft = Boolean(pr.draft);

  const elements: CardElement[] = [];
  elements.push(markdown(`### ${md(title)}`));
  if (prBody) elements.push(markdown(`> ${prBody.replace(/\n/g, "\n> ")}`));
  if (body) elements.push(markdown(body));

  // Info row: author + branch flow | colored +/-/files stats.
  const leftLines = [`👤 **${md(user)}**`];
  if (headRef && baseRef) leftLines.push(`🔀 \`${headRef}\` → \`${baseRef}\``);
  const rightLines: string[] = [];
  if (additions !== undefined) rightLines.push(colored("green", `+${additions}`));
  if (deletions !== undefined) rightLines.push(colored("red", `-${deletions}`));
  if (changedFiles !== undefined) rightLines.push(`📁 ${changedFiles} file${changedFiles === 1 ? "" : "s"}`);
  elements.push(hr());
  elements.push(columnSet([[markdown(leftLines.join("\n"))], [markdown(rightLines.join("  "))]]));

  elements.push(note(`${repo} · notify-bus`));
  elements.push(buttonRow(
    { label: "View PR", url: prUrl, type: "primary" },
    { label: "View files", url: `${prUrl}/files`, type: "default" },
  ));

  const badges: HeaderBadge[] = [actionBadge(action)];
  if (merged) badges.push({ text: "merged", color: "violet" });
  if (draft) badges.push({ text: "draft", color: "neutral" });

  return {
    header: {
      title: `🔀 PR #${number ?? "?"}`,
      subtitle: repo,
      template: merged ? "violet" : "purple",
      badges,
    },
    elements,
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
  const labels = asArr(issue.labels).map((l) => asStr(asObj(l).name)).filter(Boolean) as string[];

  const elements: CardElement[] = [];
  elements.push(markdown(`### ${md(title)}`));
  if (issueBody) elements.push(markdown(`> ${issueBody.replace(/\n/g, "\n> ")}`));
  if (body) elements.push(markdown(body));

  // Info row: author | labels (up to 3 colored pills).
  const labelColors: TagColor[] = ["blue", "turquoise", "orange", "violet", "green"];
  const labelText = labels.length
    ? `🏷️ ${labels.slice(0, 3).map((l, i) => textTag(labelColors[i % labelColors.length]!, l)).join(" ")}`
    : "";
  elements.push(hr());
  elements.push(columnSet([
    [markdown(`👤 **${md(user)}**`)],
    [markdown(labelText || " ")],
  ]));

  elements.push(note(`${repo} · notify-bus`));
  elements.push(linkButton("View Issue", issueUrl));

  return {
    header: {
      title: `📌 Issue #${number ?? "?"}`,
      subtitle: repo,
      template: action === "closed" ? "green" : action === "reopened" ? "turquoise" : "orange",
      badges: [actionBadge(action)],
    },
    elements,
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
  const relBody = truncate(asStr(release.body), 600);
  const author = asStr(asObj(release.author).login) ?? message.actor.login;
  const prerelease = Boolean(release.prerelease);
  const assetCount = asArr(release.assets).length;

  const elements: CardElement[] = [];
  elements.push(markdown(`### ${md(name)}`));
  if (relBody) elements.push(markdown(relBody));
  if (body) elements.push(markdown(body));

  elements.push(hr());
  const rightLines = [`👤 **${md(author)}**`];
  if (assetCount > 0) rightLines.push(`📦 ${assetCount} asset${assetCount === 1 ? "" : "s"}`);
  elements.push(columnSet([[markdown(rightLines.join("\n"))], [markdown(" ")]]));

  elements.push(note(`${repo} · notify-bus`));
  elements.push(linkButton("View Release", releaseUrl));

  const badges: HeaderBadge[] = [];
  if (tag) badges.push({ text: tag, color: "neutral" });
  if (prerelease) badges.push({ text: "prerelease", color: "yellow" });

  return {
    header: {
      title: `🏷️ Release ${tag}`.trim(),
      subtitle: repo,
      template: prerelease ? "yellow" : "turquoise",
      badges,
    },
    elements,
  };
}

function buildStarCard(message: EventMessage, body: string): FeishuCard {
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const actor = message.actor.login;
  const action = message.action ?? "created";
  const verb = action === "deleted" ? "unstarred" : "starred";

  const elements: CardElement[] = [
    markdown(`**${md(actor)}** ${verb} ⭐ ${maybeLink(repo, repoUrl)}`),
  ];
  if (body) elements.push(markdown(body));
  elements.push(note("notify-bus"));
  elements.push(linkButton("View Repo", repoUrl, "default"));

  return {
    header: { title: `⭐ ${verb}`, subtitle: repo, template: "wathet" },
    elements,
  };
}

function buildForkCard(message: EventMessage, body: string): FeishuCard {
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const actor = message.actor.login;
  const forkee = asObj(message.payload.forkee);
  const forkeeUrl = asStr(forkee.html_url) ?? repoUrl;
  const forkeeName = asStr(forkee.full_name) ?? "a fork";

  const elements: CardElement[] = [
    markdown(`**${md(actor)}** forked 🍴\n${maybeLink(repo, repoUrl)} → ${maybeLink(forkeeName, forkeeUrl)}`),
  ];
  if (body) elements.push(markdown(body));
  elements.push(note("notify-bus"));
  elements.push(linkButton("View Repo", repoUrl, "default"));

  return {
    header: { title: `🍴 forked`, subtitle: repo, template: "wathet" },
    elements,
  };
}

function buildFallbackCard(message: EventMessage, body: string): FeishuCard {
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const content =
    body ||
    `**${md(message.event)}**${message.action ? ` · ${md(message.action)}` : ""}\n` +
      `👤 **${md(message.actor.login)}**`;
  const elements: CardElement[] = [markdown(content)];
  elements.push(note(`${repo} · notify-bus`));
  elements.push(linkButton("View Repo", repoUrl, "default"));

  return {
    header: {
      title: `📋 ${message.event}`,
      subtitle: repo,
      template: "grey",
      badges: message.action ? [{ text: message.action, color: "neutral" }] : undefined,
    },
    elements,
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
