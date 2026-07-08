/**
 * Config manager — loads + merges YAML seed config with the SQLite store.
 *
 * STATUS: scaffold. Merge logic + hot reload lands in M3.
 *
 * Two sources, merged at runtime:
 *   - YAML (config.yaml)  : human-edited seed/bootstrap. Hot-reloadable.
 *   - SQLite (data.db)    : source of truth for routes/channels/templates/logs,
 *                           edited via the admin API.
 *
 * Precedence: DB wins (the admin UI is the live editor; YAML is seed only).
 */
export interface SeedConfig {
  channels?: Array<{
    name: string;
    type: string;
    webhook_url: string;
    secret?: string;
    enabled?: boolean;
  }>;
  routes?: Array<{
    name: string;
    match_repo?: string;
    match_event?: string;
    match_action?: string;
    target_channel: string; // by name, resolved to id at load
    priority?: number;
    enabled?: boolean;
  }>;
  templates?: Array<{
    event_type: string;
    template: string;
    channel_type?: string;
  }>;
}

/**
 * Load the YAML seed config from disk. Returns null if the file is absent
 * (running DB-only is valid).
 *
 * STATUS: stub. M3 implements with a YAML parser.
 */
export function loadSeedConfig(_path: string): SeedConfig | null {
  // M3: read + parse YAML. For now, no seed.
  return null;
}
