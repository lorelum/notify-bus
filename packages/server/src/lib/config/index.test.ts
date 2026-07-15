import { describe, expect, it } from "bun:test";
import { matchRoute, loadSeedConfig, findTemplate } from "./index";
import type { SeedConfig } from "./index";
import type { EventMessage } from "../../types";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

function event(over: Partial<EventMessage> = {}): EventMessage {
  return {
    id: "evt-1",
    event: "push",
    repository: { full_name: "org/repo", html_url: "https://gh/o/r" },
    actor: { login: "alice", avatar_url: "" },
    payload: {},
    metadata: {},
    ...over,
  };
}

const baseConfig: SeedConfig = {
  channels: [
    { name: "feishu-a", type: "feishu", webhook_url: "https://a", enabled: true },
    { name: "feishu-b", type: "feishu", webhook_url: "https://b", enabled: true },
    { name: "disabled", type: "feishu", webhook_url: "https://c", enabled: false },
  ],
};

describe("matchRoute", () => {
  it("matches a catch-all repo (*) route", () => {
    const config: SeedConfig = {
      ...baseConfig,
      routes: [{ name: "all", match_repo: "*", target_channel: "feishu-a" }],
    };
    expect(matchRoute(config, event())?.channel.name).toBe("feishu-a");
  });

  it("matches an exact repo name", () => {
    const config: SeedConfig = {
      ...baseConfig,
      routes: [{ name: "exact", match_repo: "org/repo", target_channel: "feishu-a" }],
    };
    expect(matchRoute(config, event())?.channel.name).toBe("feishu-a");
    expect(
      matchRoute(config, event({ repository: { full_name: "other/x", html_url: "" } })),
    ).toBeNull();
  });

  it("matches a comma-separated event list and omits unmatched events", () => {
    const config: SeedConfig = {
      ...baseConfig,
      routes: [
        {
          name: "push-and-pr",
          match_event: "push,pull_request",
          target_channel: "feishu-a",
        },
      ],
    };
    expect(matchRoute(config, event({ event: "push" }))?.channel.name).toBe("feishu-a");
    expect(matchRoute(config, event({ event: "pull_request" }))?.channel.name).toBe("feishu-a");
    expect(matchRoute(config, event({ event: "issues" }))).toBeNull();
  });

  it("matches on action when specified", () => {
    const config: SeedConfig = {
      ...baseConfig,
      routes: [
        {
          name: "opened-only",
          match_event: "pull_request",
          match_action: "opened",
          target_channel: "feishu-a",
        },
      ],
    };
    expect(
      matchRoute(config, event({ event: "pull_request", action: "opened" }))?.channel.name,
    ).toBe("feishu-a");
    expect(
      matchRoute(config, event({ event: "pull_request", action: "closed" })),
    ).toBeNull();
  });

  it("honors priority ordering (lower number wins)", () => {
    const config: SeedConfig = {
      ...baseConfig,
      routes: [
        { name: "low-prio", match_repo: "*", target_channel: "feishu-b", priority: 200 },
        { name: "high-prio", match_repo: "*", target_channel: "feishu-a", priority: 50 },
      ],
    };
    expect(matchRoute(config, event())?.route.name).toBe("high-prio");
  });

  it("skips a route whose target channel is disabled", () => {
    const config: SeedConfig = {
      ...baseConfig,
      routes: [
        { name: "to-disabled", match_repo: "*", target_channel: "disabled", priority: 10 },
        { name: "fallback", match_repo: "*", target_channel: "feishu-a", priority: 100 },
      ],
    };
    // The disabled-target route would match first but its channel is off,
    // so it falls through to the next route.
    expect(matchRoute(config, event())?.route.name).toBe("fallback");
  });

  it("skips a route whose target channel name does not exist", () => {
    const config: SeedConfig = {
      ...baseConfig,
      routes: [{ name: "ghost", match_repo: "*", target_channel: "nope" }],
    };
    expect(matchRoute(config, event())).toBeNull();
  });

  it("skips a disabled route", () => {
    const config: SeedConfig = {
      ...baseConfig,
      routes: [
        { name: "off", match_repo: "*", target_channel: "feishu-a", enabled: false },
      ],
    };
    expect(matchRoute(config, event())).toBeNull();
  });

  it("returns null when no routes are configured", () => {
    expect(matchRoute({ ...baseConfig }, event())).toBeNull();
  });
});

describe("findTemplate", () => {
  it("finds the template for a given event type", () => {
    const config: SeedConfig = {
      templates: [{ event_type: "push", template: "{{repository.full_name}}" }],
    };
    expect(findTemplate(config, "push")?.template).toBe("{{repository.full_name}}");
  });

  it("returns undefined when no template matches", () => {
    expect(findTemplate({ templates: [] }, "push")).toBeUndefined();
  });
});

describe("loadSeedConfig", () => {
  const tmpDir = join(import.meta.dirname, "__tmp_config_test__");

  it("returns null when the file does not exist", () => {
    expect(loadSeedConfig(join(tmpDir, "nope.yaml"))).toBeNull();
  });

  it("parses a YAML file into a SeedConfig", () => {
    mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, "seed.yaml");
    writeFileSync(
      path,
      [
        "channels:",
        "  - name: team",
        "    type: feishu",
        "    webhook_url: https://x",
        "    enabled: true",
        "routes:",
        "  - name: all",
        "    match_repo: '*'",
        "    target_channel: team",
        "templates:",
        "  - event_type: push",
        "    template: '{{event}}'",
        "",
      ].join("\n"),
    );
    const config = loadSeedConfig(path);
    expect(config?.channels?.[0]?.name).toBe("team");
    expect(config?.routes?.[0]?.match_repo).toBe("*");
    expect(config?.templates?.[0]?.event_type).toBe("push");
  });

  it("parses an empty file as a null/empty config", () => {
    mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, "empty.yaml");
    writeFileSync(path, "");
    const config = loadSeedConfig(path);
    // Empty YAML parses to null; loader normalizes to null (no seed).
    expect(config).toBeNull();
  });

  it("throws on malformed YAML (does not silently default)", () => {
    mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, "bad.yaml");
    writeFileSync(path, "channels: [unclosed");
    expect(() => loadSeedConfig(path)).toThrow();
  });

  // Cleanup once after the suite.
  it("cleanup", () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
