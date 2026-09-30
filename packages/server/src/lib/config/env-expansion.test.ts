/**
 * `${NAME}` placeholders in a seed config (#41), and the deployment shape they
 * exist for: the routing policy stays in a reviewed file, while credentials
 * come from the environment the platform injects.
 *
 * Exercised through `loadSeedConfig` — the entry point the server itself uses —
 * so a passing test describes what a real deployment loads.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSeedConfig } from "./index";

const tmpDir = join(import.meta.dirname, "__tmp_env_expansion_test__");

function write(file: string, lines: string[]): string {
  mkdirSync(tmpDir, { recursive: true });
  const path = join(tmpDir, file);
  writeFileSync(path, [...lines, ""].join("\n"));
  return path;
}

/** A one-channel config whose channel body is the given lines. */
function writeChannelConfig(file: string, channelLines: string[]): string {
  return write(file, [
    "channels:",
    "  - name: team",
    "    type: feishu",
    ...channelLines,
    "    enabled: true",
  ]);
}

describe("loadSeedConfig · environment placeholders", () => {
  it("reads a placeholder's value from the environment", () => {
    const path = writeChannelConfig("from-env.yaml", [
      "    webhook_url: ${FEISHU_BOT_WEBHOOK_URL}",
      "    secret: ${FEISHU_BOT_SECRET}",
    ]);
    const config = loadSeedConfig(path, {
      FEISHU_BOT_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/abc",
      FEISHU_BOT_SECRET: "s3cret",
    });
    expect(config?.channels?.[0]?.webhook_url).toBe(
      "https://open.feishu.cn/open-apis/bot/v2/hook/abc",
    );
    expect(config?.channels?.[0]?.secret).toBe("s3cret");
  });

  it("expands a placeholder written inside quotes as well", () => {
    const path = writeChannelConfig("quoted.yaml", ['    webhook_url: "${URL}"']);
    expect(loadSeedConfig(path, { URL: "https://x" })?.channels?.[0]?.webhook_url).toBe(
      "https://x",
    );
  });

  it("keeps an injected value a plain string, whatever it contains", () => {
    // Structural expansion runs after parsing, so a credential cannot alter the
    // document's shape: this secret would end the scalar early if it were
    // substituted into the file text.
    const path = writeChannelConfig("injection.yaml", ["    secret: ${SECRET}"]);
    const tricky = 'a"b: c\n- d';
    expect(loadSeedConfig(path, { SECRET: tricky })?.channels?.[0]?.secret).toBe(tricky);
  });

  it("fails the load, naming the variable and where it is referenced", () => {
    const path = writeChannelConfig("unset.yaml", ["    webhook_url: ${MISSING_VAR}"]);
    expect(() => loadSeedConfig(path, {})).toThrow(
      "config.channels[0].webhook_url references ${MISSING_VAR}, which is not set in the environment",
    );
  });

  it("fails the load when the variable is set but empty", () => {
    const path = writeChannelConfig("empty.yaml", ["    secret: ${EMPTY_VAR}"]);
    expect(() => loadSeedConfig(path, { EMPTY_VAR: "" })).toThrow("which is set but empty");
  });

  it("leaves a config without placeholders exactly as it was", () => {
    const path = writeChannelConfig("plain.yaml", ["    webhook_url: https://x"]);
    expect(loadSeedConfig(path, {})?.channels?.[0]?.webhook_url).toBe("https://x");
  });

  it("does not expand a placeholder shown in a comment", () => {
    // The shipped config.example.yaml documents the syntax this way; expanding
    // comments would make the example unloadable without any env set.
    const path = writeChannelConfig("comment.yaml", [
      "    webhook_url: https://x",
      "    # secret: ${FEISHU_BOT_SECRET}",
    ]);
    expect(loadSeedConfig(path, {})?.channels?.[0]?.webhook_url).toBe("https://x");
  });

  it("writes `$$` as a literal dollar sign", () => {
    const path = writeChannelConfig("escaped.yaml", ['    secret: "$${NOT_A_PLACEHOLDER}"']);
    expect(loadSeedConfig(path, {})?.channels?.[0]?.secret).toBe("${NOT_A_PLACEHOLDER}");
  });

  it("does not re-expand a value that itself looks like a placeholder", () => {
    const path = writeChannelConfig("single-pass.yaml", ["    secret: ${INDIRECT}"]);
    const config = loadSeedConfig(path, { INDIRECT: "${REAL}", REAL: "expanded" });
    expect(config?.channels?.[0]?.secret).toBe("${REAL}");
  });

  it("expands placeholders in routes too, not only in channels", () => {
    const path = write("route.yaml", [
      "channels:",
      "  - name: team",
      "    type: feishu",
      "    webhook_url: https://x",
      "    enabled: true",
      "routes:",
      "  - name: all",
      "    match_repo: ${WATCHED_REPO}",
      "    target_channel: team",
    ]);
    const config = loadSeedConfig(path, { WATCHED_REPO: "lorelum/notify-bus" });
    expect(config?.routes?.[0]?.match_repo).toBe("lorelum/notify-bus");
  });

  it("validates what the expansion produced, not the placeholder text", () => {
    // The mention_map assertions run on the expanded config: a mapping that is
    // only well-formed once the environment fills it in has to be accepted, and
    // one the environment breaks has to be rejected.
    const path = writeChannelConfig("validated-after.yaml", [
      "    webhook_url: https://x",
      "    mention_map:",
      "      octocat: ${FEISHU_USER_ID}",
    ]);
    expect(
      loadSeedConfig(path, { FEISHU_USER_ID: "f674748b" })?.channels?.[0]?.mention_map,
    ).toEqual({ octocat: "f674748b" });
    expect(() => loadSeedConfig(path, { FEISHU_USER_ID: "all" })).toThrow(/whole chat/);
  });

  // Cleanup once after the suite.
  it("cleanup", () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
