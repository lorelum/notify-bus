/**
 * Database schema for notify-bus.
 *
 * STATUS: scaffold. Tables created in M3.
 *
 * Tables (see PRD §6.1):
 *   - channels  : per-channel config (type, webhook url, secret, enabled)
 *   - routes    : match conditions → target channel, with priority
 *   - templates : Handlebars templates per event_type (+ channel_type)
 *   - logs      : recent webhook processing results
 *
 * `channels.type` selects the adapter (e.g. "feishu"). Adding a channel
 * type = register an adapter; no schema change needed.
 */
import type { Database } from "bun:sqlite";

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS channels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  type         TEXT    NOT NULL,          -- 'feishu' | future: 'slack' | ...
  webhook_url  TEXT    NOT NULL,
  secret       TEXT,                       -- feishu signing secret, if set
  enabled      INTEGER NOT NULL DEFAULT 1, -- bool as 0/1
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  match_repo       TEXT,                    -- glob, '*' matches all
  match_event      TEXT,                    -- comma-sep, NULL = all
  match_action     TEXT,                    -- comma-sep, NULL = all
  target_channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  priority         INTEGER NOT NULL DEFAULT 100,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type    TEXT NOT NULL,              -- 'push' | 'pull_request' | ...
  template      TEXT NOT NULL,              -- Handlebars source
  channel_type  TEXT,                        -- NULL = default
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT,
  event_type  TEXT,
  repo        TEXT,
  result      TEXT NOT NULL,                -- 'success' | 'fail'
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routes_priority ON routes(priority);
CREATE INDEX IF NOT EXISTS idx_logs_created    ON logs(created_at DESC);
`;

/**
 * Run the schema migrations (idempotent — `CREATE TABLE IF NOT EXISTS`).
 * Called once at startup in M3.
 */
export function migrate(db: Database): void {
  db.exec(SCHEMA);
}
