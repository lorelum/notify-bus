/**
 * Feishu (Lark) channel adapter.
 *
 * STATUS: stub. Implemented in M1.
 *
 * Feishu signing is counter-intuitive and the #1 source of bugs — documented
 * here so M1 gets it right:
 *
 *   - The HMAC *key*   is `timestamp + "\n" + secret`
 *   - The HMAC *message* is EMPTY (b"" — the message body is NOT signed)
 *   - Output is base64(HMAC-SHA256(key, b""))
 *   - `timestamp` (seconds) and `sign` are sent as TOP-LEVEL fields in the
 *     JSON body alongside `msg_type` / `content`.
 *
 * A known-good test vector MUST live in feishu.test.ts before this is
 * considered done (M1 acceptance criterion).
 *
 * Reference: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 */
import type { ChannelAdapter, ChannelSendResult } from "./types";
import type { EventMessage } from "../../types";

export const feishuCapabilities = {
  messageTypes: ["text", "post", "interactive"] as const,
  supportsCards: true,
  displayName: "Feishu",
} as const;

/**
 * Compute the Feishu custom-bot signature.
 *
 * STATUS: stub (M1). Returns empty string — DO NOT ship.
 *
 * @param timestamp  unix seconds
 * @param secret     the bot's signing secret
 * @returns          base64-encoded HMAC-SHA256 signature
 */
export function signFeishu(_timestamp: number, _secret: string): string {
  // M1: implement as base64(HMAC-SHA256(key=`${timestamp}\n${secret}`, msg=b""))
  throw new Error("signFeishu: not implemented (M1)");
}

export const feishuAdapter: ChannelAdapter = {
  type: "feishu",
  capabilities: feishuCapabilities,

  async send(
    _message: EventMessage,
    _config: Readonly<Record<string, unknown>>,
  ): Promise<ChannelSendResult> {
    // M1: POST to the configured webhook URL with the rendered message +
    // signing fields. Translate non-2xx into typed ChannelError.
    throw new Error("feishuAdapter.send: not implemented (M1)");
  },
};
