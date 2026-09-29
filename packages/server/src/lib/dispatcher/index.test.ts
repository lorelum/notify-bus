import { describe, expect, it } from "bun:test";
import { dispatch, seedChannelToConfig } from "./index";
import type { AdapterRegistry, ChannelError, ChannelSendResult } from "../adapters/types";
import type { SeedChannel } from "../config";
import type { EventMessage } from "../../types";

const message: EventMessage = {
  id: "evt-1",
  event: "push",
  repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
  actor: { login: "alice", avatar_url: "" },
  payload: {},
  metadata: {},
};

const channel: SeedChannel = {
  name: "team-feishu",
  type: "feishu",
  webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
};

/**
 * A registry holding one stub adapter of `type` that returns `result`.
 *
 * The stub is the whole point: `dispatch` is what maps an adapter's answer onto
 * a `DispatchResult`, so nothing here needs a network call or a real channel.
 */
function registry(type: string, result: ChannelSendResult): AdapterRegistry {
  return new Map([
    [
      type,
      {
        type,
        capabilities: {
          messageTypes: ["interactive"],
          supportsCards: true,
          displayName: type,
        },
        send: () => Promise.resolve(result),
      },
    ],
  ]);
}

describe("seedChannelToConfig", () => {
  it("maps the snake_case seed channel onto the adapter's config shape", () => {
    expect(seedChannelToConfig(channel)).toEqual({ webhookUrl: channel.webhook_url });
  });

  it("carries the signing secret only when the seed channel has one", () => {
    expect(seedChannelToConfig({ ...channel, secret: "s3cret" })).toEqual({
      webhookUrl: channel.webhook_url,
      secret: "s3cret",
    });
    // An empty secret must not reach the adapter as "" — adapters treat a
    // present-but-empty secret differently from an absent one.
    expect(seedChannelToConfig({ ...channel, secret: "" })).toEqual({
      webhookUrl: channel.webhook_url,
    });
  });

  it("carries the mention map, which the adapter needs to build an @ (#36)", () => {
    // The translation is a whitelist: a field that is not carried here never
    // reaches the adapter, so a mapping left out would silently drop every
    // mention the channel was configured for.
    const mention_map = { octocat: "REPLACE_ME_ID" };
    expect(seedChannelToConfig({ ...channel, mention_map })).toEqual({
      webhookUrl: channel.webhook_url,
      mentionMap: mention_map,
    });
    expect(seedChannelToConfig(channel).mentionMap).toBeUndefined();
  });
});

describe("dispatch", () => {
  it("reports success with the channel id the caller supplied", async () => {
    // The adapter also returns a messageId; the dispatcher's result contract is
    // status + channelId, so that must not leak into the mapped result.
    const result = await dispatch(
      message,
      channel,
      registry("feishu", { status: "success", messageId: "om_123" }),
      7,
    );
    expect(result).toEqual({ status: "success", channelId: 7 });
  });

  it("fails without an adapter when no adapter is registered for the channel type", async () => {
    const result = await dispatch(message, channel, registry("slack", { status: "success" }), 1);
    expect(result).toEqual({
      status: "fail",
      channelId: 1,
      error: 'no adapter registered for channel type "feishu"',
    });
  });

  /**
   * Every `ChannelError` variant → the message the logs and the webhook response
   * carry. `rate_limited` is the odd one out: it has no `detail` field at all,
   * only an optional retry hint, so it always reads as the fixed fallback.
   */
  const failures: [label: string, error: ChannelError, expected: string][] = [
    ["auth", { kind: "auth", detail: "invalid sign" }, "auth: invalid sign"],
    ["network", { kind: "network", detail: "ECONNRESET" }, "network: ECONNRESET"],
    [
      "bad_config",
      { kind: "bad_config", detail: "requires a webhookUrl" },
      "bad_config: requires a webhookUrl",
    ],
    [
      "unknown",
      { kind: "unknown", detail: "feishu code 9499: bad sign" },
      "unknown: feishu code 9499: bad sign",
    ],
    ["rate_limited", { kind: "rate_limited" }, "rate_limited: rate limited"],
    [
      "rate_limited with retry hint",
      { kind: "rate_limited", retryAfterMs: 1000 },
      "rate_limited: rate limited",
    ],
  ];

  it("maps every ChannelError variant onto a logged failure instead of throwing", async () => {
    const mapped = await Promise.all(
      failures.map(async ([label, error, expected]) => {
        const result = await dispatch(
          message,
          channel,
          registry("feishu", { status: "fail", error }),
          3,
        );
        return [label, result, expected] as const;
      }),
    );
    for (const [label, result, expected] of mapped) {
      expect([label, result]).toEqual([label, { status: "fail", channelId: 3, error: expected }]);
    }
  });

  it("passes the rendered message and the channel config through to the adapter", async () => {
    let seen: { message?: EventMessage; config?: Readonly<Record<string, unknown>> } = {};
    const adapters: AdapterRegistry = new Map([
      [
        "feishu",
        {
          type: "feishu",
          capabilities: {
            messageTypes: ["interactive"],
            supportsCards: true,
            displayName: "Feishu",
          },
          send: (event, config) => {
            seen = { message: event, config };
            return Promise.resolve({ status: "success" });
          },
        },
      ],
    ]);

    await dispatch(message, { ...channel, secret: "s3cret" }, adapters, 0);

    expect(seen.message).toBe(message);
    expect(seen.config).toEqual({ webhookUrl: channel.webhook_url, secret: "s3cret" });
  });
});
