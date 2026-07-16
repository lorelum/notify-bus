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
import type { EventMessage } from "../../types";

/** A channel declared in the YAML seed config (snake_case, as authored). */
export interface SeedChannel {
  name: string;
  type: string;
  webhook_url: string;
  secret?: string;
  enabled?: boolean;
}

/** A route declared in the YAML seed config. */
export interface SeedRoute {
  name: string;
  match_repo?: string;
  match_event?: string;
  /** Whitelist of actions (comma-separated). Omitted = all actions. */
  match_action?: string;
  /** Blacklist of actions (comma-separated). Wins over match_action. */
  exclude_action?: string;
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
 * Load the YAML seed config from disk.
 *
 * Returns null if the file is absent (running with no seed is valid — the
 * webhook will just never match a route). Throws on a malformed file: a
 * broken config is a deployment error, not a silent-default situation.
 */
export function loadSeedConfig(path: string): SeedConfig | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const parsed = parseYaml(text) as SeedConfig | null;
  if (parsed === null || parsed === undefined) return null;
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

/** The result of matching an event to a route: the target channel to dispatch to. */
export interface RouteMatch {
  route: SeedRoute;
  channel: SeedChannel;
}

/**
 * Find the first route (by ascending priority) that matches the event, and
 * resolve its target_channel to an enabled SeedChannel.
 *
 * Semantics (PRD §4.1.4): routes sorted by priority ascending (lower number =
 * higher priority); the first match wins; a disabled channel never matches.
 *
 * @returns the matched route + channel, or null if no route matches.
 */
export function matchRoute(config: SeedConfig, event: EventMessage): RouteMatch | null {
  const channels = config.channels ?? [];
  const channelByName = new Map(channels.map((c) => [c.name, c]));

  const routes = (config.routes ?? [])
    .filter((r) => r.enabled !== false)
    .toSorted((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  for (const route of routes) {
    if (!matchRepo(route.match_repo, event.repository.full_name)) continue;
    const events = splitCsv(route.match_event);
    if (!matchList(events, event.event)) continue;
    const actions = splitCsv(route.match_action);
    if (!matchList(actions, event.action)) continue;
    // exclude_action wins over match_action: even if the action is included
    // above, an explicit exclude drops it. Lets users say "issues, but not
    // labeled/assigned" without enumerating every wanted action.
    const excludes = splitCsv(route.exclude_action);
    if (excludes && event.action && excludes.includes(event.action)) continue;

    const channel = channelByName.get(route.target_channel);
    // No such channel, or the channel is disabled -> this route can't fire.
    if (!channel || channel.enabled === false) continue;
    return { route, channel };
  }
  return null;
}

/** Find the Handlebars template for an event type (first match). M1: no
 * channel-type scoping yet; that comes with M3. */
export function findTemplate(
  config: SeedConfig,
  eventType: string,
): SeedTemplate | undefined {
  return (config.templates ?? []).find((t) => t.event_type === eventType);
}
