/**
 * Config manager — loads the YAML seed config and matches events to routes.
 *
 * STATUS: M1 implements YAML loading + route matching (YAML-only, no DB).
 * The DB-merge + hot-reload layer lands in M3.
 *
 * Two sources, merged at runtime (once M3 lands):
 *   - YAML (config.yaml)  : human-edited seed/bootstrap. Hot-reloadable.
 *   - SQLite (data.db)    : source of truth for routes/channels/templates/logs,
 *                           edited via the admin API.
 * Precedence: DB wins (the admin UI is the live editor; YAML is seed only).
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  commentBodyOf,
  isReservedMention,
  normalizeMentionMap,
  resolveMentionTargets,
} from "../mentions";
import type { MentionTargets } from "../mentions";
import type { EventMessage } from "../../types";

/** A channel declared in the YAML seed config (snake_case, as authored). */
export interface SeedChannel {
  name: string;
  type: string;
  webhook_url: string;
  secret?: string;
  enabled?: boolean;
  /**
   * GitHub login → Feishu `user_id`, for this channel's targeted @ mentions.
   * Case-insensitive, channel-scoped, and the only source of a real @ — a login
   * read out of a payload is never one. See `lib/mentions`.
   */
  mention_map?: Record<string, string>;
}

/**
 * One AND-clause of a route's payload condition: a dotted path into the raw
 * GitHub payload, mapped to the value that path must have.
 *
 * The expected value is compared as text, so YAML's unquoted `true` matches a
 * `true` payload field and `1` matches `1`. `*` stands for any run of
 * characters and `$default_branch` for `payload.repository.default_branch`.
 */
export type PayloadCondition = Record<string, string | number | boolean>;

/** A route declared in the YAML seed config. */
export interface SeedRoute {
  name: string;
  match_repo?: string;
  match_event?: string;
  /** Blacklist of event types (comma-separated), evaluated within this route. */
  exclude_event?: string;
  /** Whitelist of actions (comma-separated). Omitted = all actions. */
  match_action?: string;
  /** Route-local blacklist of actions (comma-separated). Takes precedence over match_action for this route. */
  exclude_action?: string;
  /**
   * Route-local payload condition, for what `match_action` cannot express —
   * a branch, a CI conclusion, a deployment state. Clauses are OR'd (one clause
   * per situation the route delivers) and the keys inside a clause are AND'd.
   * A single clause may be written without the list wrapper. Omitted = no
   * condition, so routes written before this field keep their behavior; a shape
   * the matcher cannot read is rejected when the config loads rather than read
   * as "matches everything". See {@link matchPayloadConditions}.
   */
  match_payload?: PayloadCondition | PayloadCondition[];
  /**
   * Deliver only a comment's first posting, and only when its plain text names
   * somebody this route's channel maps; omitted, every matched comment is
   * delivered. See `lib/mentions`.
   */
  mention_only?: boolean;
  target_channel: string; // by name, resolved to a SeedChannel at match time
  priority?: number;
  enabled?: boolean;
}

/** A Handlebars template declared in the YAML seed config. */
export interface SeedTemplate {
  event_type: string;
  template: string;
  channel_type?: string;
}

export interface SeedConfig {
  channels?: SeedChannel[];
  routes?: SeedRoute[];
  templates?: SeedTemplate[];
}

/**
 * Reject a `match_payload` the matcher cannot read as conditions.
 *
 * A broken config is a deployment error, and this is where it belongs: `null`
 * would throw on every event, and an empty clause would silently accept every
 * event — the one reading a condition must never have. Failing at load names
 * the route and the path while the operator is still looking at the file.
 */
function assertMatchPayload(route: SeedRoute): void {
  const condition = route.match_payload;
  if (condition === undefined) return;
  const reject = (detail: string): never => {
    throw new Error(`route "${route.name}": match_payload ${detail}`);
  };
  const clauses = Array.isArray(condition) ? condition : [condition];
  if (clauses.length === 0) reject("needs at least one clause, or has to be omitted");
  for (const clause of clauses) {
    if (typeof clause !== "object" || clause === null || Array.isArray(clause)) {
      // A bare `match_payload:` reads as null; the likeliest intent is "no
      // condition", so the message points at omitting the key.
      reject("must be a map of path: value or a list of those maps — omit it for no condition");
    }
    const entries = Object.entries(clause);
    if (entries.length === 0) reject("clauses have to name at least one path");
    for (const [path, value] of entries) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        reject(`${path} must compare against a string, number or boolean`);
      }
    }
  }
}

/** GitHub's login rule: letters, digits and inner hyphens, 1–39 characters. */
const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

/** Feishu ids are alphanumeric with `_` / `-`; anything else could break the card markup. */
const FEISHU_ID = /^[a-z0-9_-]+$/i;

/** The events whose payload nests a comment body a `mention_only` route reads. */
const COMMENT_EVENTS = ["issue_comment", "pull_request_review_comment"];

/**
 * Reject a `mention_map` that cannot be read as login → id pairs: a mistyped key
 * would silently disable one person's mentions, and a malformed id can make a
 * whole card fail to send. Fails at load instead, naming the channel.
 */
function assertMentionMap(channel: SeedChannel): void {
  const map = channel.mention_map;
  if (map === undefined) return;
  const reject = (detail: string): never => {
    throw new Error(`channel "${channel.name}": mention_map ${detail}`);
  };
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    reject("must be a map of github-login: feishu-user-id");
  }
  const written = new Map<string, string>();
  for (const [login, userId] of Object.entries(map)) {
    const key = login.trim().toLowerCase();
    if (key === "") reject("has an empty login");
    if (!GITHUB_LOGIN.test(key)) reject(`key "${login}" is not a GitHub login`);
    if (isReservedMention(key)) {
      reject(`"${login}" is reserved — a comment that says "@${key}" is never read as a person`);
    }
    if (typeof userId !== "string" || userId.trim() === "") {
      reject(`"${login}" has to name a Feishu user id`);
    }
    if (!FEISHU_ID.test(userId.trim())) {
      reject(`"${login}" has a user id that cannot be sent as a mention`);
    }
    if (isReservedMention(userId)) {
      reject(`"${login}" maps to a user id that addresses the whole chat`);
    }
    const duplicate = written.get(key);
    if (duplicate !== undefined) reject(`maps "${duplicate}" and "${login}" to the same login`);
    written.set(key, login);
  }
  if (written.size === 0) reject("has to map at least one login, or be omitted");
}

/**
 * Reject `mention_only` where it could never be satisfied: on an event with no
 * comment body, on a channel that maps nobody, or behind an action whitelist
 * without `created`. Each would be a route that looks enabled and is silently
 * dead.
 */
function assertMentionOnly(route: SeedRoute, channels: ReadonlyMap<string, SeedChannel>): void {
  const mentionOnly = route.mention_only;
  if (mentionOnly === undefined) return;
  if (typeof mentionOnly !== "boolean") {
    throw new Error(`route "${route.name}": mention_only has to be true or false`);
  }
  if (!mentionOnly) return;
  const events = splitCsv(route.match_event) ?? [];
  if (!events.some((event) => COMMENT_EVENTS.includes(event))) {
    throw new Error(
      `route "${route.name}": mention_only reads a comment body — name ${COMMENT_EVENTS.join(" or ")} in match_event, or drop the field`,
    );
  }
  const actions = splitCsv(route.match_action);
  if (actions && !actions.includes("created")) {
    throw new Error(
      `route "${route.name}": mention_only only delivers a comment's first posting — match_action has to include created, or be omitted`,
    );
  }
  const channel = channels.get(route.target_channel);
  if (channel && !channel.mention_map) {
    throw new Error(
      `route "${route.name}": mention_only needs a mention_map on channel "${route.target_channel}" — without one nothing can be mentioned`,
    );
  }
}

/**
 * Load the YAML seed config from disk.
 *
 * Returns null if the file is absent (running with no seed is valid — the
 * webhook will just never match a route). Throws on a malformed file, on a
 * route whose `match_payload` cannot be read as conditions, and on a channel or
 * route whose mention configuration could only fail later: a broken config is a
 * deployment error, not a silent-default situation.
 */
export function loadSeedConfig(path: string): SeedConfig | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const parsed = parseYaml(text) as SeedConfig | null;
  if (parsed === null || parsed === undefined) return null;
  for (const channel of parsed.channels ?? []) assertMentionMap(channel);
  const channelByName = new Map((parsed.channels ?? []).map((channel) => [channel.name, channel]));
  for (const route of parsed.routes ?? []) {
    assertMatchPayload(route);
    assertMentionOnly(route, channelByName);
  }
  return parsed;
}

/** Split a comma-separated match field into a trimmed list. Empty -> undefined. */
function splitCsv(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Glob match supporting `*` (any) and exact match. M1 keeps it simple: `*`
 * matches everything, otherwise exact string equality. */
function matchRepo(pattern: string | undefined, repo: string): boolean {
  if (pattern === undefined) return true;
  if (pattern === "*") return true;
  return pattern === repo;
}

function matchList(list: string[] | undefined, value: string | undefined): boolean {
  if (list === undefined) return true;
  if (value === undefined) return false;
  return list.includes(value);
}

/** A clause value that means "the repository's default branch". */
const DEFAULT_BRANCH_TOKEN = "$default_branch";

/** Escape a literal so it survives `new RegExp`. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a value against a pattern where `*` stands for any run of characters
 * (newlines included), and without a `*` the comparison is exact.
 */
function matchGlob(pattern: string, value: string): boolean {
  const source = pattern.split("*").map(escapeRegExp).join("[\\s\\S]*");
  return new RegExp(`^${source}$`).test(value);
}

/** Read a dotted path out of the raw payload. `undefined` when absent. */
function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  let current: unknown = payload;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Whether every key in one clause holds.
 *
 * A path that is absent, null, or holds an object or array never matches —
 * "missing" must not read as "condition satisfied". GitHub omits fields between
 * payload versions, and silently delivering on a missing `deleted` or
 * `conclusion` is the failure this gate exists to prevent.
 *
 * A clause that is not a non-empty map — a scalar, `null`, an array, `{}` —
 * never matches either. `{}` would otherwise accept everything, which is the
 * one reading a condition must never have; {@link loadSeedConfig} rejects those
 * shapes outright, and this keeps a hand-built config from behaving differently.
 */
function matchesClause(clause: PayloadCondition, payload: Record<string, unknown>): boolean {
  if (typeof clause !== "object" || clause === null || Array.isArray(clause)) return false;
  const entries = Object.entries(clause);
  if (entries.length === 0) return false;
  return entries.every(([path, value]) => {
    let expected = String(value);
    if (expected.includes(DEFAULT_BRANCH_TOKEN)) {
      const defaultBranch = readPayloadPath(payload, "repository.default_branch");
      // A payload without a usable default branch cannot satisfy the clause.
      // Falling back to `main` would silently subscribe every repo whose
      // default branch is named something else.
      if (typeof defaultBranch !== "string" || defaultBranch === "") return false;
      expected = expected.replaceAll(DEFAULT_BRANCH_TOKEN, defaultBranch);
    }
    const actual = readPayloadPath(payload, path);
    // `null` reports itself as an object, so this one check covers it, an array
    // and a nested object alike.
    if (actual === undefined || typeof actual === "object") return false;
    return matchGlob(expected, String(actual));
  });
}

/**
 * Whether an event satisfies a route's payload condition.
 *
 * Clauses are OR'd, keys inside a clause are AND'd. The OR is load-bearing for
 * the shipped push route, which delivers "a newly created branch" and "an
 * update to the default branch" as two clauses; an AND-only field would force
 * that policy into two routes. An omitted condition accepts everything, so
 * routes written before this field keep matching their whole event domain.
 */
function matchPayloadConditions(
  condition: PayloadCondition | PayloadCondition[] | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (condition === undefined) return true;
  const clauses = Array.isArray(condition) ? condition : [condition];
  return clauses.some((clause) => matchesClause(clause, payload));
}

/** The result of matching an event to a route: the target channel to dispatch to. */
export interface RouteMatch {
  route: SeedRoute;
  channel: SeedChannel;
  /**
   * The @ targets a `mention_only` route resolved from the comment, and the only
   * people the card may name. The webhook carries them on `message.metadata`, so
   * the delivery decision and the card share one parse rather than repeating it.
   */
  mentions?: MentionTargets;
}

interface IgnoredRoute {
  route: SeedRoute;
  reason: "exclude_event" | "exclude_action" | "match_payload" | "mention_only";
}

type RouteDecision =
  | { kind: "matched"; match: RouteMatch }
  | { kind: "ignored"; ignored: IgnoredRoute }
  | { kind: "no_route" };

/**
 * Resolve an event against routes in priority order.
 *
 * Every route-local gate is permissive to the rest of the chain: a route that
 * excludes an event or action, whose payload condition does not hold, or that
 * finds nobody to mention, falls through so a later route may still accept the
 * event. An `ignored` decision is returned only when no later route accepts what
 * an earlier one rejected, and its `reason` names the field that rejected it, so
 * a policy miss stays distinguishable from an event no route ever wanted
 * (`no_route`).
 */
export function resolveRoute(config: SeedConfig, event: EventMessage): RouteDecision {
  const channels = config.channels ?? [];
  const channelByName = new Map(channels.map((channel) => [channel.name, channel]));
  const routes = (config.routes ?? [])
    .filter((route) => route.enabled !== false)
    .toSorted((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  let ignored: IgnoredRoute | undefined;

  for (const route of routes) {
    if (!matchRepo(route.match_repo, event.repository.full_name)) continue;

    const events = splitCsv(route.match_event);
    if (!matchList(events, event.event)) continue;

    const channel = channelByName.get(route.target_channel);
    // A missing or disabled target is a configuration problem, never an ignore.
    if (!channel || channel.enabled === false) continue;

    // The event is already inside this route's match_event domain, so an
    // overlapping explicit exclude wins.
    const excludedEvents = splitCsv(route.exclude_event);
    if (excludedEvents?.includes(event.event)) {
      ignored ??= { route, reason: "exclude_event" };
      continue;
    }

    const actions = splitCsv(route.match_action);
    if (!matchList(actions, event.action)) continue;

    const excludedActions = splitCsv(route.exclude_action);
    if (excludedActions && event.action && excludedActions.includes(event.action)) {
      ignored ??= { route, reason: "exclude_action" };
      continue;
    }

    // The payload condition is the finest-grained gate, so it runs last: an
    // event this route's event/action domain invited but whose payload the
    // policy does not cover.
    if (!matchPayloadConditions(route.match_payload, event.payload)) {
      ignored ??= { route, reason: "match_payload" };
      continue;
    }

    // The narrowest gate, and the only one that reads text; the targets are
    // resolved here, once, and travel with the match.
    if (route.mention_only) {
      // Only a first posting can address anybody: an edit must not ping after
      // the fact, and a deletion addresses nobody.
      if (event.action !== "created") {
        ignored ??= { route, reason: "mention_only" };
        continue;
      }
      const mentions = resolveMentionTargets(
        commentBodyOf(event.payload),
        normalizeMentionMap(channel.mention_map),
        event.actor.login,
      );
      if (mentions === undefined) {
        ignored ??= { route, reason: "mention_only" };
        continue;
      }
      return { kind: "matched", match: { route, channel, mentions } };
    }

    return { kind: "matched", match: { route, channel } };
  }

  return ignored ? { kind: "ignored", ignored } : { kind: "no_route" };
}

/**
 * Find the first dispatchable route. This convenience API preserves the
 * existing contract for callers that do not need to distinguish ignore/no-route.
 */
export function matchRoute(config: SeedConfig, event: EventMessage): RouteMatch | null {
  const decision = resolveRoute(config, event);
  return decision.kind === "matched" ? decision.match : null;
}

/** Find the Handlebars template for an event type (first match). M1: no
 * channel-type scoping yet; that comes with M3. */
export function findTemplate(config: SeedConfig, eventType: string): SeedTemplate | undefined {
  return (config.templates ?? []).find((t) => t.event_type === eventType);
}
