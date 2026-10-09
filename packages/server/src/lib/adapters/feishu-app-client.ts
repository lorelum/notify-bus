/** Outbound-only application bot API. Never include remote error text or credentials in errors. */
import type { ChannelError } from "./types";

export class FeishuAppError extends Error {
  constructor(readonly channelError: ChannelError) {
    super("detail" in channelError ? channelError.detail : "Feishu app rate limited");
    this.name = "FeishuAppError";
  }
}

interface AppCredentials {
  appId: string;
  appSecret: string;
}
interface Token {
  secret: string;
  value: string;
  expiresAt: number;
}
const API = "https://open.feishu.cn/open-apis";

export function createFeishuAppClient(now: () => number = Date.now) {
  const tokens = new Map<string, Token>();
  const refreshing = new Map<string, { secret: string; promise: Promise<string> }>();

  async function request(
    path: string,
    body: unknown,
    token?: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    let data: Record<string, unknown>;
    try {
      response = await fetch(`${API}${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new FeishuAppError({
        kind: "network",
        detail: "Feishu app request failed or returned invalid JSON",
      });
    }
    if (response.status === 429) throw new FeishuAppError({ kind: "rate_limited" });
    if (!response.ok || data?.code !== 0) {
      const code = typeof data?.code === "number" ? data.code : -1;
      throw new FeishuAppError({
        kind:
          response.status === 401 ||
          response.status === 403 ||
          [99991663, 99991664, 99991665, 99991668].includes(code)
            ? "auth"
            : "unknown",
        detail: `Feishu app HTTP ${response.status}, code ${code}`,
      });
    }
    return data;
  }

  async function accessToken(credentials: AppCredentials): Promise<string> {
    const cached = tokens.get(credentials.appId);
    if (cached?.secret === credentials.appSecret && cached.expiresAt > now()) return cached.value;
    const pending = refreshing.get(credentials.appId);
    if (pending?.secret === credentials.appSecret) return pending.promise;
    const promise = (async () => {
      const data = await request("/auth/v3/tenant_access_token/internal", {
        app_id: credentials.appId,
        app_secret: credentials.appSecret,
      });
      if (
        typeof data.tenant_access_token !== "string" ||
        !data.tenant_access_token ||
        typeof data.expire !== "number" ||
        !Number.isFinite(data.expire) ||
        data.expire <= 60
      ) {
        throw new FeishuAppError({
          kind: "auth",
          detail: "Feishu app returned invalid token or expiry",
        });
      }
      tokens.set(credentials.appId, {
        secret: credentials.appSecret,
        value: data.tenant_access_token,
        expiresAt: now() + (data.expire - 60) * 1000,
      });
      return data.tenant_access_token;
    })();
    const entry = { secret: credentials.appSecret, promise };
    refreshing.set(credentials.appId, entry);
    try {
      return await promise;
    } finally {
      if (refreshing.get(credentials.appId) === entry) refreshing.delete(credentials.appId);
    }
  }

  return {
    async send(
      credentials: AppCredentials,
      chatId: string,
      card: Readonly<Record<string, unknown>>,
      uuid: string,
      root?: string,
    ): Promise<string> {
      const token = await accessToken(credentials);
      let data: Record<string, unknown>;
      try {
        data = await request(
          root
            ? `/im/v1/messages/${encodeURIComponent(root)}/reply`
            : "/im/v1/messages?receive_id_type=chat_id",
          {
            msg_type: "interactive",
            content: JSON.stringify(card),
            uuid,
            ...(root ? { reply_in_thread: true } : { receive_id: chatId }),
          },
          token,
        );
      } catch (error) {
        if (error instanceof FeishuAppError && error.channelError.kind === "auth")
          tokens.delete(credentials.appId);
        throw error;
      }
      const message = data.data as Record<string, unknown> | undefined;
      if (typeof message?.message_id !== "string" || !message.message_id) {
        throw new FeishuAppError({ kind: "unknown", detail: "Feishu app returned no message_id" });
      }
      return message.message_id;
    },
  };
}
