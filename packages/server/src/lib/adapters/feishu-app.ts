/** Issue/PR comment threads. Application bot only; webhook adapter stays unchanged. */
import { createHash } from "node:crypto";
import type { ChannelAdapter, ChannelSendResult } from "./types";
import { createFeishuAppClient, FeishuAppError } from "./feishu-app-client";
import { createCommentThreadStore } from "../db/comment-threads";
import type { CommentThreadStore } from "../db/comment-threads";
import { getDb } from "../db";
import { normalizeMentionMap, resolveMentionTargets, MENTIONS_METADATA_KEY } from "../mentions";
import { buildAppCommentCard } from "./feishu-comment-card";
import { serializeFeishuCard } from "./feishu-card-payload";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createFeishuAppAdapter(
  store?: () => CommentThreadStore,
  client = createFeishuAppClient(),
): ChannelAdapter {
  let persistentStore: CommentThreadStore | undefined;
  const getStore =
    store ??
    (() => (persistentStore ??= createCommentThreadStore(getDb(process.env.DATA_DIR ?? "./data"))));
  // One process serializes comments per root. Cross-process fan-out is not supported.
  const pending = new Map<string, Promise<ChannelSendResult>>();
  return {
    type: "feishu_app",
    capabilities: { messageTypes: ["interactive"], supportsCards: true, displayName: "Feishu App" },
    async send(message, config) {
      const { appId, appSecret, chatId } = config;
      if (
        typeof appId !== "string" ||
        !appId.trim() ||
        typeof appSecret !== "string" ||
        !appSecret.trim() ||
        typeof chatId !== "string" ||
        !chatId.trim()
      ) {
        return {
          status: "fail",
          error: { kind: "bad_config", detail: "feishu_app requires appId, appSecret and chatId" },
        };
      }
      if (
        !["issue_comment", "pull_request_review_comment"].includes(message.event) ||
        message.action !== "created"
      ) {
        return {
          status: "fail",
          error: {
            kind: "bad_config",
            detail: "feishu_app supports created Issue/PR comments only",
          },
        };
      }
      const comment = object(message.payload.comment);
      const subject = object(
        message.event === "issue_comment" ? message.payload.issue : message.payload.pull_request,
      );
      const number = subject.number;
      if (
        !Number.isSafeInteger(number) ||
        typeof number !== "number" ||
        number < 1 ||
        !Number.isSafeInteger(comment.id) ||
        typeof comment.id !== "number" ||
        comment.id < 1 ||
        typeof comment.body !== "string"
      ) {
        return {
          status: "fail",
          error: {
            kind: "bad_config",
            detail: "comment requires subject number, comment id and body",
          },
        };
      }
      const body = comment.body;
      const rawMap = object(config.mentionMap);
      if (
        Object.values(rawMap).some(
          (id) => typeof id !== "string" || !/^ou_[a-zA-Z0-9_-]+$/.test(id),
        )
      ) {
        return {
          status: "fail",
          error: { kind: "bad_config", detail: "feishu_app mentionMap requires open_id values" },
        };
      }
      const mentions = resolveMentionTargets(
        body,
        normalizeMentionMap(rawMap as Record<string, string>),
        typeof object(comment.user).login === "string"
          ? String(object(comment.user).login)
          : message.actor.login,
      );
      const topic = JSON.stringify([
        appId,
        chatId,
        message.repository.full_name.toLowerCase(),
        number,
      ]);
      const commentKey = `${message.event}:${comment.id}`;
      const uuid = createHash("sha256").update(`${topic}:${commentKey}`).digest("hex").slice(0, 40);
      const previous = pending.get(topic);
      const work = (async (): Promise<ChannelSendResult> => {
        if (previous) await previous;
        try {
          const db = getStore();
          const delivered = db.receipt(topic, commentKey);
          if (delivered) return { status: "success", messageId: delivered };
          const root = db.root(topic);
          // Reuse the webhook comment layout without mutating the event or trusting
          // a stale route's mention metadata. Only this channel's resolved ids render @.
          const normalized = {
            ...message,
            payload: { ...message.payload, issue: subject },
            metadata: {
              ...message.metadata,
              [MENTIONS_METADATA_KEY]: mentions ?? { logins: [], userIds: [] },
            },
          };
          const isPr =
            message.event === "pull_request_review_comment" ||
            (typeof subject.pull_request === "object" && subject.pull_request !== null);
          const card = buildAppCommentCard(normalized, isPr ? "PR" : "Issue");
          const messageId = await client.send(
            { appId, appSecret },
            chatId,
            serializeFeishuCard(card),
            uuid,
            root,
          );
          db.save(topic, commentKey, messageId, !root && !!mentions);
          return { status: "success", messageId };
        } catch (error) {
          const channelError =
            error instanceof FeishuAppError
              ? error.channelError
              : { kind: "unknown" as const, detail: "Feishu app thread persistence failed" };
          process.stderr.write(
            `[notify-bus] feishu_app ${channelError.kind} delivery ${message.id} failed: ${"detail" in channelError ? channelError.detail : "rate limited"}\n`,
          );
          return { status: "fail", error: channelError };
        }
      })();
      pending.set(topic, work);
      try {
        return await work;
      } finally {
        if (pending.get(topic) === work) pending.delete(topic);
      }
    },
  };
}
export const feishuAppAdapter = createFeishuAppAdapter();
