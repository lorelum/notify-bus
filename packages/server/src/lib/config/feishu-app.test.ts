import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { loadSeedConfig, resolveRoute } from "./index";
import type { EventMessage } from "../../types";

const yaml = `channels:
  - name: app
    type: feishu_app
    app_id: cli_test
    app_secret: \${APP_SECRET}
    chat_id: oc_test
    mention_map:
      Alice: ou_alice
      bob: ou_bob
  - name: webhook
    type: feishu
    webhook_url: https://example.invalid/hook
routes:
  - name: comments
    match_event: issue_comment,pull_request_review_comment
    match_action: created
    target_channel: app
  - name: other
    match_event: push,issues,pull_request,release
    target_channel: webhook
`;

const load = () => loadSeedConfig("mocked.yaml", { APP_SECRET: "test-only-credential" });

describe("feishu_app YAML contract", () => {
  let text: string;
  let exists: ReturnType<typeof spyOn>;
  let read: ReturnType<typeof spyOn>;
  beforeEach(() => {
    text = yaml;
    exists = spyOn(fs, "existsSync").mockReturnValue(true);
    read = spyOn(fs, "readFileSync").mockImplementation(
      (() => text) as unknown as typeof fs.readFileSync,
    );
  });
  afterEach(() => {
    exists.mockRestore();
    read.mockRestore();
  });

  it("loads credentials from env and lets unmentioned comments reach the application bot", () => {
    const config = load()!;
    expect(config.channels?.[0]?.app_secret).toBe("test-only-credential");
    expect(config.channels?.[0]?.webhook_url).toBeUndefined();
    const message: EventMessage = {
      id: "test",
      event: "issue_comment",
      action: "created",
      repository: { full_name: "org/repo", html_url: "" },
      actor: { login: "alice", avatar_url: "" },
      metadata: {},
      payload: { comment: { body: "no at" } },
    };
    expect(resolveRoute(config, message)).toMatchObject({
      kind: "matched",
      match: { channel: { type: "feishu_app" } },
    });
    expect(resolveRoute(config, { ...message, event: "push", action: undefined })).toMatchObject({
      kind: "matched",
      match: { channel: { type: "feishu" } },
    });
  });
  it("rejects plaintext secrets without echoing their value", () => {
    text = yaml.replace("${APP_SECRET}", "private-test-value");
    expect(load).toThrow("app_secret must be an environment placeholder");
    try {
      load();
    } catch (error) {
      expect(String(error)).not.toContain("private-test-value");
    }
  });
  it("rejects mention_only because it would suppress existing-thread replies", () => {
    text = yaml.replace("match_action: created", "match_action: created\n    mention_only: true");
    expect(load).toThrow("omit mention_only");
  });
  it("rejects missing credentials, non-open-id mapping and dead event/action routes", () => {
    text = yaml.replace("    chat_id: oc_test\n", "");
    expect(load).toThrow("requires chat_id");
    text = yaml.replace("ou_bob", "all");
    expect(load).toThrow("requires open_id");
    text = yaml.replace("match_action: created", "match_action: edited");
    expect(load).toThrow("match_action: created");
    text = yaml.replace("issue_comment,pull_request_review_comment", "push");
    expect(load).toThrow("requires comment events");
  });
});
