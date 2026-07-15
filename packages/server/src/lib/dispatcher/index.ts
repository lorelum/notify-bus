/**
 * Dispatcher — the orchestration layer between route matching and channel
 * adapters. Takes a matched seed channel + an EventMessage + the adapter
 * registry, builds the ChannelCredentials, and calls the adapter.
 *
 * M1: channels come from YAML (no DB), so channelId is a synthetic index.
 * M3 swaps this for the real DB id.
 */
import type { AdapterRegistry } from "../adapters/types";
import type { SeedChannel } from "../config";
import type { DispatchResult, EventMessage } from "../../types";

/** Convert a YAML seed channel (snake_case) to adapter config (camelCase). */
export function seedChannelToConfig(channel: SeedChannel): Readonly<Record<string, unknown>> {
  const config: Record<string, unknown> = { webhookUrl: channel.webhook_url };
  if (channel.secret) config.secret = channel.secret;
  return config;
}

/**
 * Dispatch an event to its matched channel via the registry.
 *
 * @param message       the fully-rendered event (formatted.body populated)
 * @param channel       the matched seed channel from config
 * @param adapters      the adapter registry (channel type -> adapter)
 * @param channelId     synthetic id (M1: index; M3: DB id)
 * @returns             success or a typed failure
 */
export async function dispatch(
  message: EventMessage,
  channel: SeedChannel,
  adapters: AdapterRegistry,
  channelId: number,
): Promise<DispatchResult> {
  const adapter = adapters.get(channel.type);
  if (!adapter) {
  return {
    status: "fail",
    channelId,
    error: `no adapter registered for channel type "${channel.type}"`,
  };
  }

  const result = await adapter.send(message, seedChannelToConfig(channel));
  if (result.status === "success") {
    return { status: "success", channelId };
  }
  return {
    status: "fail",
    channelId,
    error: `${result.error.kind}: ${"detail" in result.error ? result.error.detail : "rate limited"}`,
  };
}
