/**
 * The channel adapter contract.
 *
 * This is the product-surface interface every channel implements (see
 * AGENTS.md). notify-bus is multi-channel by design: Feishu is the first
 * adapter; Slack / DingTalk / WeCom / Discord follow the same shape.
 *
 * Breaking this interface breaks every adapter — design-discuss before
 * changing it.
 */
import type { EventMessage } from "../../types";

/**
 * Capabilities a channel declares. Drives UI hints and route validation.
 */
export interface ChannelCapabilities {
  /** Supported message types for this channel. */
  messageTypes: readonly ChannelMessageType[];
  /** Whether the channel supports interactive cards. */
  supportsCards: boolean;
  /** Human-readable channel name, e.g. "Feishu". */
  displayName: string;
}

export type ChannelMessageType = "text" | "post" | "interactive";

/**
 * A channel adapter takes a rendered {@link EventMessage} and delivers it to
 * the channel's API.
 *
 * Implementations MUST:
 *   - Apply the channel's signing scheme if the channel is configured with a
 *     secret (e.g. Feishu's HMAC-SHA256-then-base64).
 *   - Translate {@link EventMessage.formatted} into the channel's native
 *     message format.
 *   - Return a {@link ChannelSendResult}; never throw a bare string. Typed
 *     errors are translated by the route/dispatcher layer.
 */
export interface ChannelAdapter {
  /** The channel type this adapter handles, e.g. `"feishu"`. Matches `channels.type`. */
  readonly type: string;

  /** Static capabilities descriptor. */
  readonly capabilities: ChannelCapabilities;

  /**
   * Send a message to this channel.
   *
   * @param message  the fully-rendered event (formatted.body is populated).
   * @param config   channel-specific config (webhook url, signing secret, ...).
   *                 Secret values come from the config DB, never env vars.
   * @returns        success or a typed failure.
   */
  send(
    message: EventMessage,
    config: Readonly<Record<string, unknown>>,
  ): Promise<ChannelSendResult>;
}

/**
 * Discriminated result of a send attempt. Adapters return this rather than
 * throwing, so the dispatcher can log and continue to the next channel.
 */
export type ChannelSendResult =
  | { status: "success"; messageId?: string }
  | { status: "fail"; error: ChannelError };

/**
 * Typed channel errors. The dispatcher/logs translate these into messages.
 * Never throw a bare string (repo convention, see AGENTS.md).
 */
export type ChannelError =
  | { kind: "auth"; detail: string }
  | { kind: "network"; detail: string }
  | { kind: "rate_limited"; retryAfterMs?: number }
  | { kind: "bad_config"; detail: string }
  | { kind: "unknown"; detail: string };

/**
 * Registry of available adapters, keyed by channel type. The dispatcher looks
 * up the adapter for a route's target channel here.
 *
 * Adapters register themselves at startup (see `index.ts`). Adding a channel
 * = implement {@link ChannelAdapter} + register it.
 */
export type AdapterRegistry = ReadonlyMap<string, ChannelAdapter>;
