/**
 * Feishu (Lark) channel adapter.
 *
 * Feishu signing is counter-intuitive and the #1 source of bugs — documented
 * here so it stays correct:
 *
 *   - The HMAC *key*   is `timestamp + "\n" + secret`
 *   - The HMAC *message* is EMPTY (b"" — the message body is NOT signed)
 *   - Output is base64(HMAC-SHA256(key, b""))
 *   - `timestamp` (seconds) and `sign` are sent as TOP-LEVEL fields in the
 *     JSON body alongside `msg_type`.
 *
 * Reference: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 */
import { createHmac } from "node:crypto";
import type { ChannelAdapter, ChannelError, ChannelSendResult } from "./types";
import type { EventMessage } from "../../types";
import { buildCard } from "./feishu-cards";
import { serializeFeishuCard } from "./feishu-card-payload";
import type { CardContext } from "./feishu-cards";

export const feishuCapabilities = {
  messageTypes: ["text", "post", "interactive"] as const,
  supportsCards: true,
  displayName: "Feishu",
} as const;

/**
 * Compute the Feishu custom-bot signature.
 *
 * @param timestamp  unix seconds
 * @param secret     the bot's signing secret
 * @returns          base64-encoded HMAC-SHA256 signature
 */
export function signFeishu(timestamp: number, secret: string): string {
  const key = `${timestamp}\n${secret}`;
  return createHmac("sha256", key).update("").digest("base64");
}

/** Config shape the feishu adapter expects inside ChannelCredentials.config. */
interface FeishuConfig {
  webhookUrl?: string;
  secret?: string;
  /** GitHub login → Feishu user id, forwarded from the channel's `mention_map`. */
  mentionMap?: Readonly<Record<string, string>>;
}

function readConfig(config: Readonly<Record<string, unknown>>): FeishuConfig {
  const { webhookUrl, secret, mentionMap } = config as Partial<FeishuConfig>;
  return { webhookUrl, secret, mentionMap };
}

/** The push webhook lists changed *files*, not changed lines. Compare the two
 * revision SHAs instead; never display a partial result as an exact total. */
async function fetchPushLineStats(message: EventMessage): Promise<CardContext["pushLineStats"]> {
  const token = process.env.GITHUB_API_TOKEN;
  const p = message.payload;
  if (
    !token ||
    message.event !== "push" ||
    p.created === true ||
    p.deleted === true ||
    p.forced === true
  ) {
    return undefined;
  }

  const before = p.before;
  const after = p.after;
  const repo = message.repository.full_name;
  if (
    typeof before !== "string" ||
    typeof after !== "string" ||
    !/^[0-9a-f]{40}$/i.test(before) ||
    !/^[0-9a-f]{40}$/i.test(after) ||
    /^0{40}$/.test(before) ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)
  ) {
    return undefined;
  }

  const repoPath = repo.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${repoPath}/compare/${before}...${after}`;
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) {
      process.stderr.write(
        `[notify-bus] push line stats unavailable (GitHub HTTP ${response.status})\n`,
      );
      return undefined;
    }

    const data = (await response.json()) as Record<string, unknown>;
    // The Compare API returns at most 300 files for the entire comparison.
    // A response with exactly 300 may be truncated; never sum it as a total.
    const files = data.files;
    if (!Array.isArray(files) || files.length >= 300) {
      process.stderr.write("[notify-bus] push line stats unavailable (incomplete comparison)\n");
      return undefined;
    }
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      const { additions: added, deletions: removed } = (file ?? {}) as Record<string, unknown>;
      if (
        typeof added !== "number" ||
        !Number.isSafeInteger(added) ||
        added < 0 ||
        typeof removed !== "number" ||
        !Number.isSafeInteger(removed) ||
        removed < 0
      ) {
        process.stderr.write("[notify-bus] push line stats unavailable (invalid comparison)\n");
        return undefined;
      }
      additions += added;
      deletions += removed;
    }
    if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) return undefined;
    return { additions, deletions };
  } catch {
    // Network/JSON/timeout failures must not prevent the original notification.
    // Do not log the request headers or token.
    process.stderr.write("[notify-bus] push line stats unavailable (GitHub request failed)\n");
    return undefined;
  }
}

/** Feishu response codes that indicate signing/auth failure. */
const AUTH_CODES = new Set([9499, 9499.1]);

/** Map a Feishu error code to a typed channel error. */
function mapCode(code: number, msg: string): ChannelError {
  if (code === 11232 || code === 11232.1) {
    return { kind: "rate_limited" };
  }
  if (AUTH_CODES.has(code)) {
    return { kind: "auth", detail: msg };
  }
  return { kind: "unknown", detail: `feishu code ${code}: ${msg}` };
}

/**
 * Build the Feishu interactive-card payload from a rendered EventMessage.
 *
 * Structure (header color, badges, layout, buttons) comes from
 * {@link buildCard} — a per-event-type builder. The body markdown comes from
 * `message.formatted?.body` — the configured template's output, possibly empty
 * — and is folded in by the builder as extra content.
 *
 * The whole card is NOT clickable — links live in explicit buttons and inline
 * markdown links only.
 */
function buildCardPayload(
  message: EventMessage,
  context: CardContext,
  timestamp?: number,
  sign?: string,
): Record<string, unknown> {
  const card = buildCard(message, context);
  const payload: Record<string, unknown> = {
    msg_type: "interactive",
    card: serializeFeishuCard(card),
  };
  if (timestamp !== undefined && sign !== undefined) {
    payload.timestamp = timestamp;
    payload.sign = sign;
  }
  return payload;
}

export const feishuAdapter: ChannelAdapter = {
  type: "feishu",
  capabilities: feishuCapabilities,

  async send(
    message: EventMessage,
    config: Readonly<Record<string, unknown>>,
  ): Promise<ChannelSendResult> {
    const { webhookUrl, secret, mentionMap } = readConfig(config);
    if (!webhookUrl) {
      return {
        status: "fail",
        error: { kind: "bad_config", detail: "feishu adapter requires a webhookUrl" },
      };
    }

    let timestamp: number | undefined;
    let sign: string | undefined;
    if (secret) {
      timestamp = Math.floor(Date.now() / 1000);
      sign = signFeishu(timestamp, secret);
    }

    const pushLineStats = await fetchPushLineStats(message);
    const payload = buildCardPayload(message, { mentionMap, pushLineStats }, timestamp, sign);

    let res: Response;
    try {
      res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return {
        status: "fail",
        error: { kind: "network", detail: err instanceof Error ? err.message : "fetch failed" },
      };
    }

    // Feishu returns 200 even on logical errors; the real result is in the
    // JSON body's `code` field (0 = success).
    let parsed: { code?: number; msg?: string; data?: { message_id?: string } };
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch {
      return {
        status: "fail",
        error: { kind: "network", detail: `feishu returned non-JSON (status ${res.status})` },
      };
    }

    if (parsed.code === 0) {
      return { status: "success", messageId: parsed.data?.message_id };
    }
    return {
      status: "fail",
      error: mapCode(Number(parsed.code ?? -1), parsed.msg ?? "unknown feishu error"),
    };
  },
};
