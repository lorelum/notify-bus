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
}

function readConfig(config: Readonly<Record<string, unknown>>): FeishuConfig {
  const { webhookUrl, secret } = config as Partial<FeishuConfig>;
  return { webhookUrl, secret };
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
 * `message.formatted?.body` (the configured template, or the render layer's
 * default) and is folded in by the builder as content.
 *
 * The whole card is NOT clickable — links live in explicit buttons and inline
 * markdown links only.
 */
function buildCardPayload(
  message: EventMessage,
  timestamp?: number,
  sign?: string,
): Record<string, unknown> {
  const card = buildCard(message);
  const header: Record<string, unknown> = {
    title: { tag: "plain_text", content: card.header.title },
    template: card.header.template,
  };
  if (card.header.subtitle) {
    header.subtitle = { tag: "plain_text", content: card.header.subtitle };
  }
  if (card.header.badges && card.header.badges.length > 0) {
    header.text_tag_list = card.header.badges.map((b) => ({
      tag: "text_tag",
      text: { tag: "plain_text", content: b.text },
      color: b.color,
    }));
  }

  const payload: Record<string, unknown> = {
    msg_type: "interactive",
    card: {
      schema: "2.0",
      header,
      body: { elements: card.elements },
    },
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
    const { webhookUrl, secret } = readConfig(config);
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

    const payload = buildCardPayload(message, timestamp, sign);

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
