/**
 * `issue_comment` — a comment on an issue or a pull request.
 *
 * Split out of `feishu-cards.ts` with the `repository` card (#21), whose review
 * asked for these two builders to stop growing that file. Shared vocabulary —
 * types, accessors, markdown and element constructors, `navigationButtons`, the
 * action palette — comes from `feishu-card-kit.ts`.
 */
import type { EventMessage } from "../../types";
import {
  actionBadge,
  asNum,
  asObj,
  asStr,
  hr,
  markdown,
  md,
  mentionLine,
  navigationButtons,
  truncate,
  type CardColor,
  type CardElement,
  type FeishuCard,
  type NavTarget,
} from "./feishu-card-kit";

/**
 * The comment an `issue_comment` event is about, and where it can be read.
 *
 * `author` is deliberately not `message.actor`. The two agree on `created`, but
 * on `edited` the actor is whoever made the edit — so reading the actor here is
 * how the fallback card came to name the wrong person as the commenter (#21).
 */
interface IssueComment {
  author?: string;
  body?: string;
  url?: string;
}

/** Read the `comment` object GitHub nests in an `issue_comment` payload. */
function resolveIssueComment(payload: Record<string, unknown>): IssueComment {
  const comment = asObj(payload.comment);
  return {
    author: asStr(asObj(comment.user).login),
    body: asStr(comment.body),
    url: asStr(comment.html_url),
  };
}

/**
 * Header colour for an `issue_comment` event.
 *
 * A comment has three actions and a reader has to tell them apart at a glance:
 * `created` is content to read, `edited` is churn, `deleted` is destructive.
 * The colours follow the shared palette's weighting rule (see
 * {@link actionBadge}) — blue for ordinary activity, grey for churn, red for
 * destruction — so the header and the badge agree on how much attention the
 * action deserves.
 */
function commentHeaderColor(action: string): CardColor {
  if (action === "deleted") return "red";
  if (action === "edited") return "grey";
  return "blue";
}

/**
 * The card is about the comment, not about the issue it hangs off, and about
 * the person who wrote it, not about whoever the event is attributed to. The
 * fallback rendered this event from `message.actor`, which names the editor
 * rather than the author on `edited` — the reason this builder exists (#21).
 */
export function buildIssueCommentCard(message: EventMessage, body: string): FeishuCard {
  const p = message.payload;
  const repo = message.repository.full_name;
  const repoUrl = message.repository.html_url;
  const action = message.action ?? asStr(p.action) ?? "created";
  const issue = asObj(p.issue);
  const issueTitle = asStr(issue.title);
  const issueUrl = asStr(issue.html_url);
  const number = asNum(issue.number);
  const comment = resolveIssueComment(p);

  const elements: CardElement[] = [];

  // The route's own targets, first: on a `mention_only` route they are why this
  // card exists. Generated markup — the comment text below still goes through
  // `md()`, so writing `@someone` cannot mention anybody by itself.
  const mentions = mentionLine(message);
  if (mentions) elements.push(markdown(mentions));

  // The comment is what happened; the issue it hangs off is the context that
  // makes it readable, so the title goes above the quoted text.
  const content: CardElement[] = [];
  if (issueTitle) content.push(markdown(`### ${md(issueTitle)}`));
  const commentBody = truncate(comment.body, 300);
  if (commentBody) {
    content.push(markdown(`> ${md(commentBody).replace(/\n/g, "\n> ")}`));
  }
  if (body) content.push(markdown(body));
  if (content.length > 0) elements.push(...content, hr());

  // Who wrote the comment — resolved from `comment.user`, never the actor,
  // because on `edited` the actor is the editor (#21). A payload that names
  // nobody says "unknown" rather than borrowing the sender's name, the rule the
  // fallback's subject resolution follows too.
  const authorLines = [comment.author ? `👤 **${md(comment.author)}**` : "👤 unknown"];
  // The editor is an extra fact, so it is added beside the author and only when
  // it is somebody else — "edited by carol" under carol's own comment is noise.
  const editor = action === "edited" ? message.actor.login : undefined;
  if (editor && editor !== comment.author) {
    authorLines.push(`✏️ edited by **${md(editor)}**`);
  }
  elements.push(markdown(authorLines.join("\n")));

  // The comment itself when the payload says where it is, the parent issue
  // otherwise. The label follows the target (#26), so the fallback does not
  // claim to open a comment it cannot address.
  const primary: NavTarget = comment.url
    ? { label: "View Comment", url: comment.url, type: "primary" }
    : { label: "View Issue", url: issueUrl, type: "primary" };
  elements.push(...navigationButtons([primary], repoUrl));

  return {
    header: {
      title: `💬 Comment on #${number ?? "?"}`,
      subtitle: repo,
      template: commentHeaderColor(action),
      badges: [actionBadge(action)],
    },
    elements,
  };
}
