/**
 * Core type definitions for notify-bus.
 *
 * These are the product contracts (see AGENTS.md "product surface"):
 *   - {@link EventMessage} — the internal event representation the pipeline reads/writes.
 *   - {@link ChannelAdapter} (in `lib/adapters/types.ts`) — the interface every channel implements.
 * Changes here ripple to every middleware and adapter; design-discuss first.
 */

/**
 * The canonical, normalized event that flows through the pipeline.
 *
 * Built by the parser from a raw GitHub webhook payload, then mutated by
 * middlewares (which may write to {@link EventMessage.metadata} and
 * {@link EventMessage.formatted}).
 *
 * `payload` holds the raw GitHub data and is intentionally loosely typed
 * (`Record<string, unknown>`) — it is the one sanctioned escape hatch from
 * strict typing, because GitHub's payload shapes vary per event type.
 */
export interface EventMessage {
  /** Unique request id (generated on ingestion). */
  id: string;
  /** Raw GitHub event type, e.g. `"push"`, `"pull_request"`. From `X-GitHub-Event`. */
  event: string;
  /** Action sub-type where applicable, e.g. `"opened"`, `"closed"`. */
  action?: string;
  repository: {
    full_name: string;
    html_url: string;
  };
  actor: {
    login: string;
    avatar_url: string;
  };
  /** Raw GitHub payload. Loosely typed by design — varies per event type. */
  payload: Record<string, unknown>;
  /** Branch/tag ref, where present (e.g. push events). */
  ref?: string;
  /** Output of the Template middleware — what the adapter sends. */
  formatted?: {
    title: string;
    /** Markdown / rich-text body. */
    body: string;
    /** Optional structured data for interactive cards. */
    attachments?: unknown;
  };
  /** Free-form bag middlewares write to (enrichment, trace info, etc.). */
  metadata: Record<string, unknown>;
}

/**
 * A resolved target for a dispatched event, produced by the Dispatcher after
 * matching the event against routing rules.
 */
export interface DispatchTarget {
  /** The channel id from the config DB. */
  channelId: number;
  /** The channel type — selects which adapter handles it. */
  channelType: string;
  /** Channel-specific credentials (webhook url, signing secret, ...). */
  credentials: Readonly<ChannelCredentials>;
}

/**
 * Credentials stored per channel. The `type` field discriminates the shape of
 * `config` (e.g. feishu config carries a signing secret + webhook url).
 *
 * Stored in the config DB. Returned partially-masked over the admin API;
 * full values are write-only.
 */
export interface ChannelCredentials {
  type: string;
  /** E.g. for feishu: `{ webhookUrl, secret? }`. */
  config: Readonly<Record<string, unknown>>;
}

/**
 * The outcome of dispatching to a channel. Used by the logging layer.
 */
export type DispatchResult =
  | { status: "success"; channelId: number }
  | { status: "fail"; channelId: number; error: string };
