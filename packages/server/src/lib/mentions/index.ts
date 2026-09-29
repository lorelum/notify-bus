/**
 * Targeted @ mentions (#36).
 *
 * GitHub names people in text; Feishu renders a mention only from markup. This
 * module is the one place that turns the first into the second: a route's
 * `mention_only` policy and the card that is finally sent read the same parse,
 * carried on `EventMessage.metadata`, so they cannot disagree about who was
 * addressed.
 *
 * Logins map to Feishu `user_id`s by hand in the channel config — the id type a
 * spike in a real group verified (`<at id=<user_id>>` in a schema 2.0 card,
 * `code: 0`, client notification received). No contacts API, no OAuth, no
 * `open_id` fallback.
 */
import type { EventMessage } from "../../types";

/** A channel's GitHub login → Feishu user id map, as authored in YAML. */
export type MentionMap = Readonly<Record<string, string>>;

/** The same map, normalized: trimmed, lower-cased logins → trimmed ids. */
export type MentionLookup = ReadonlyMap<string, string>;

/** The people a card will @, in the order the comment named them. */
export interface MentionTargets {
  readonly logins: readonly string[];
  readonly userIds: readonly string[];
}

/** How many people one card may @. A crowd in a comment must not become one. */
export const MAX_MENTIONS = 5;

/**
 * The `metadata` key a resolved decision travels under: internal plumbing, so
 * `EventMessage`'s own shape stays as it is.
 */
export const MENTIONS_METADATA_KEY = "mentions";

/** Names that address a whole chat rather than a person. */
const RESERVED = new Set(["all", "here"]);

/** Whether a login or a Feishu id names a whole chat instead of one person. */
export function isReservedMention(name: string): boolean {
  return RESERVED.has(normalizeLogin(name));
}

/**
 * `@login` at a mention position. The preceding character rules out an address
 * (`alice@carol.com`), a path (`example.com/@alice`), an escape and a doubled `@`.
 */
const MENTION = /(?:^|[^\w.+%\\/@-])@([a-z0-9][a-z0-9-]{0,38})/gi;

/** Characters a login can continue into: `@alice_smith` names somebody else. */
const LOGIN_CONTINUATION = /[\w-]/;

/** GitHub logins are case-insensitive; so is every lookup here. */
function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * A line's content once its blockquote and list markers are stripped, so a fence
 * inside a quote or a list item reads like any other. Only the markers go: a
 * quoted sentence keeps its text.
 */
function containerContent(line: string): string {
  return line.replace(/^\s*(?:(?:>|[-*+]|\d+[.)])\s*)*/, "");
}

/** Whether a line closes a fence: the same character, at least as long, alone. */
function closesFence(content: string, opening: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < opening.length || trimmed[0] !== opening[0]) return false;
  return [...trimmed].every((character) => character === opening[0]);
}

/**
 * Drop fenced code blocks, line by line — the length decides where a block ends:
 * a four-backtick fence may quote a three-backtick one, and only a run at least
 * as long as the opening closes it. An unclosed fence runs to the end, as
 * Markdown says it does.
 */
function stripFences(text: string): string {
  const kept: string[] = [];
  let opening = "";
  for (const line of text.split("\n")) {
    const content = containerContent(line);
    if (opening === "") {
      const fence = /^(`{3,}|~{3,})/.exec(content)?.[1];
      if (fence === undefined) kept.push(line);
      else opening = fence;
      continue;
    }
    if (closesFence(content, opening)) opening = "";
  }
  return kept.join("\n");
}

/**
 * Drop code: fences first, then inline code, where a run of backticks counts.
 *
 * HTML `<code>` / `<pre>` goes too — GitHub renders it as code, so an @ inside
 * one is quoted text. A tag left unterminated is not stripped: GitHub shows it
 * as written, and a comment that *discusses* `<code>` should not lose the
 * mention that follows it.
 */
function stripCode(text: string): string {
  return stripFences(text)
    .replace(/<(code|pre)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, " ")
    .replace(/`+[^`\n]*`+/g, " ");
}

/** The lookup form of a channel's map. A missing or unreadable map is empty. */
export function normalizeMentionMap(map: MentionMap | undefined): MentionLookup {
  const lookup = new Map<string, string>();
  for (const [login, userId] of Object.entries(map ?? {})) {
    const id = typeof userId === "string" ? userId.trim() : "";
    const key = normalizeLogin(login);
    if (key !== "" && id !== "") lookup.set(key, id);
  }
  return lookup;
}

/** The channel's user id for one login, or `undefined` when it maps none. */
export function mappedUserId(lookup: MentionLookup, login: string | undefined): string | undefined {
  return login === undefined ? undefined : lookup.get(normalizeLogin(login));
}

/** The comment text both comment events nest, or `""` when the payload has none. */
export function commentBodyOf(payload: Record<string, unknown>): string {
  const comment = payload.comment;
  if (comment === null || typeof comment !== "object") return "";
  const body = (comment as Record<string, unknown>).body;
  return typeof body === "string" ? body : "";
}

/**
 * The @ targets a `mention_only` route may send, or `undefined` when the policy
 * refuses the comment.
 *
 * Both halves err towards silence: the plain text has to name, as a whole token,
 * a login this channel maps — and the comment has to come from somebody the
 * channel maps too, so a stranger on a public repository cannot make notify-bus @
 * a teammate. One @ per person (two logins mapped to one id are that person),
 * capped at {@link MAX_MENTIONS}. Whether the event may mention at all is the
 * caller's decision: an edit or a deletion is not.
 */
export function resolveMentionTargets(
  body: string,
  lookup: MentionLookup,
  authorLogin: string,
): MentionTargets | undefined {
  if (!lookup.has(normalizeLogin(authorLogin))) return undefined;

  const logins: string[] = [];
  const userIds: string[] = [];
  const text = stripCode(body);
  for (const match of text.matchAll(MENTION)) {
    const login = normalizeLogin(match[1] ?? "");
    if (login === "" || RESERVED.has(login)) continue;
    const end = match.index + match[0].length;
    if (LOGIN_CONTINUATION.test(text[end] ?? "") || text[end] === "/") continue;
    const userId = lookup.get(login);
    if (userId === undefined || userIds.includes(userId)) continue;
    if (userIds.length === MAX_MENTIONS) break;
    logins.push(login);
    userIds.push(userId);
  }
  return userIds.length > 0 ? { logins, userIds } : undefined;
}

/** The targets an earlier decision attached to this event, if any. */
export function readMentionTargets(message: EventMessage): MentionTargets {
  const raw = message.metadata[MENTIONS_METADATA_KEY] as Partial<MentionTargets> | undefined;
  return {
    logins: Array.isArray(raw?.logins) ? raw.logins : [],
    userIds: Array.isArray(raw?.userIds) ? raw.userIds : [],
  };
}
