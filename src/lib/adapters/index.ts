/**
 * Adapter registry — maps channel type → adapter instance.
 *
 * Adding a channel = implement {@link ChannelAdapter} + register here.
 * The dispatcher looks up adapters by `channels.type` from the DB.
 */
import type { AdapterRegistry, ChannelAdapter } from "./types";
import { feishuAdapter } from "./feishu";

/**
 * Build the registry of available adapters.
 * Called once at startup. Adapters are singletons.
 */
export function buildAdapterRegistry(): AdapterRegistry {
  const adapters: ChannelAdapter[] = [feishuAdapter];
  // Future: slackAdapter, dingtalkAdapter, wecomAdapter, discordAdapter
  return new Map(adapters.map((a) => [a.type, a]));
}
