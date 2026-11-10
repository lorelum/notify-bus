import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, validateManifest, validateResolution } from "./security-audit";
import { parseAudit, parseFix, parseLock } from "./security-model";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const advisory = {
  id: 1,
  url: "https://github.com/advisories/GHSA-abcd-abcd-abcd",
  severity: "high",
  vulnerable_versions: "<4.17.21",
};
function lock(version = "4.17.20") {
  return JSON.stringify({
    lockfileVersion: 1,
    workspaces: {
      "": { name: "fixture", dependencies: { lodash: version } },
      "packages/app": { name: "app" },
    },
    packages: {
      app: ["app@workspace:packages/app"],
      lodash: [`lodash@${version}`, "", {}, "sha512-example"],
      "parent/lodash": ["lodash@3.10.1", "", {}, "sha512-nested"],
      alternate: [`lodash@${version}`, "", {}, "sha512-example"],
      bundled: ["other@1.0.0", "", {}, "sha512-bundled"],
    },
  });
}

test("strict audit maps aliases and every nested version without dropping bundled inventory", () => {
  const inventory = parseLock(lock());
  expect(inventory).toHaveLength(4);
  const result = parseAudit(JSON.stringify({ lodash: [advisory] }), inventory);
  expect(result).toHaveLength(2);
  expect(result.find((f) => f.version === "4.17.20")?.aliases).toEqual(["GHSA-abcd-abcd-abcd"]);
  expect(result.find((f) => f.version === "3.10.1")?.aliases).toEqual(["GHSA-abcd-abcd-abcd"]);
  expect(result.every((f) => f.target === "source")).toBe(true);
});

test("errors and invalid advisory shapes never become clean findings", () => {
  for (const text of [
    "",
    "null",
    "[]",
    "<html>failure</html>",
    '{"error":"unavailable"}',
    '{"lodash":[]}',
    JSON.stringify({ lodash: [{ ...advisory, vulnerable_versions: undefined }] }),
  ])
    expect(() => parseAudit(text, parseLock(lock()))).toThrow();
  expect(() => parseAudit(JSON.stringify({ unknown: [advisory] }), parseLock(lock()))).toThrow(
    "no covered",
  );
  expect(() => parseLock('{"packages":{"x":["x@git+https://example.invalid"]}}')).toThrow(
    "Unsupported",
  );
});

test("fix parser rejects missing and incomplete coverage while accepting blocked partial repairs", () => {
  const value = {
    dryRun: false,
    fixed: 1,
    remaining: 1,
    fixes: [{ name: "lodash", from: "4.17.20", to: "4.17.21" }],
    blocked: [{ name: "lodash", from: "3.10.1" }],
    unfixable: [],
    unmatched: [],
    unaudited: [],
    manifestUnavailable: [],
    vulnerableAfterInstall: [],
  };
  expect(parseFix(JSON.stringify(value))).toHaveLength(1);
  expect(() => parseFix(JSON.stringify({ ...value, unaudited: ["private"] }))).toThrow("coverage");
  expect(() => parseFix(JSON.stringify({ ...value, unmatched: undefined }))).toThrow("coverage");
});

test("only advisory-backed exact manifest and lock changes are eligible", () => {
  const fixes = [{ name: "lodash", from: "4.17.20", to: "4.17.21" }];
  validateManifest(
    '{"overrides":{"lodash":"4.17.20"}}',
    '{"overrides":{"lodash":"4.17.21"}}',
    fixes,
  );
  validateResolution(lock(), lock("4.17.21"), fixes);
  expect(() =>
    validateManifest('{"scripts":{"test":"old"}}', '{"scripts":{"test":"new"}}', fixes),
  ).toThrow();
  expect(() => validateResolution(lock(), lock("4.17.21"), [])).toThrow("Unexplained");
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "candidate-test-"));
  directories.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { lodash: "4.17.20" } }),
  );
  await writeFile(join(root, "bun.lock"), lock());
  return root;
}

test("isolated generator skips fix on clean scan and strips write credentials", async () => {
  const root = await fixture();
  const commands: string[][] = [];
  const result = await generate(root, join(root, "reports"), undefined, false, (args, cwd, env) => {
    commands.push(args);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    if (args[0] === "git")
      return {
        code: 0,
        stderr: "",
        stdout: args[1] === "rev-parse" ? "a".repeat(40) : "package.json\0bun.lock\0",
      };
    expect(cwd).not.toBe(root);
    return {
      code: 0,
      stderr: "",
      stdout: args[1] === "--version" ? "1.4.4\n" : args[1] === "audit" ? "{}" : "",
    };
  });
  expect(result.status).toBe("ok");
  expect(result.changedFiles).toEqual([]);
  expect(result.ciStatus).toBe("not-run");
  expect(commands.some((c) => c.includes("fix"))).toBe(false);
  expect(
    JSON.parse(await readFile(join(root, "reports/candidate.json"), "utf8")).schemaVersion,
  ).toBe(1);
});

test("skipped coverage fails instead of reporting clean", async () => {
  const root = await fixture();
  const result = await generate(root, join(root, "reports"), undefined, false, (args) => {
    if (args[0] === "git")
      return {
        code: 0,
        stderr: "",
        stdout: args[1] === "rev-parse" ? "a".repeat(40) : "package.json\0bun.lock\0",
      };
    return {
      code: 0,
      stderr: args[1] === "audit" ? "Skipped private registry" : "",
      stdout: args[1] === "--version" ? "1.4.4" : "{}",
    };
  });
  expect(result.status).toBe("scan-failed");
  expect(result.failure).toContain("coverage");
});

// Explicit opt-in: network-backed Bun fixture; never runs as part of ordinary unit tests.
test.skipIf(process.env.SECURITY_AUDIT_LIVE !== "1")(
  "real pinned Bun audits workspace/direct/transitive/override/alias/duplicate constraints in isolation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-live-"));
    directories.push(root);
    await mkdir(join(root, "packages/app"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "audit-live",
        private: true,
        workspaces: ["packages/*"],
        dependencies: { lodash: "4.17.20", alternate: "npm:lodash@3.10.1", express: "3.21.2" },
        overrides: { ms: "0.7.0" },
      }),
    );
    await writeFile(
      join(root, "packages/app/package.json"),
      JSON.stringify({ name: "audit-workspace", dependencies: { lodash: "4.17.19" } }),
    );
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: root,
      USERPROFILE: root,
      TEMP: root,
      TMP: root,
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    };
    const install = Bun.spawnSync([process.execPath, "install", "--ignore-scripts"], {
      cwd: root,
      env,
    });
    expect(install.exitCode).toBe(0);
    const before = parseLock(await readFile(join(root, "bun.lock"), "utf8"));
    expect(before.some((p) => p.alias.includes("/"))).toBe(true);
    const audit = Bun.spawnSync([process.execPath, "audit", "--json"], { cwd: root, env });
    expect(parseAudit(audit.stdout.toString(), before).length).toBeGreaterThan(0);
    const fixed = Bun.spawnSync([process.execPath, "audit", "fix", "--json", "--ignore-scripts"], {
      cwd: root,
      env,
    });
    const plan = JSON.parse(fixed.stdout.toString());
    expect(parseFix(fixed.stdout.toString()).length).toBeGreaterThan(0);
    expect(plan.blocked.length).toBeGreaterThan(0);
    const frozen = Bun.spawnSync(
      [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
      { cwd: root, env },
    );
    expect(frozen.exitCode).toBe(0);
  },
  120_000,
);

test("partial repairs survive remaining blocked versions and source tree stays unchanged", async () => {
  const root = await fixture();
  let scanned = false;
  const result = await generate(root, join(root, "reports"), undefined, true, (args, cwd) => {
    if (args[0] === "git")
      return {
        code: 0,
        stderr: "",
        stdout: args[1] === "rev-parse" ? "a".repeat(40) : "package.json\0bun.lock\0",
      };
    if (args[1] === "--version") return { code: 0, stderr: "", stdout: "1.4.4" };
    if (args[1] === "audit" && args[2] === "fix") {
      writeFileSync(join(cwd, "bun.lock"), lock("4.17.21"));
      writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({ name: "fixture", dependencies: { lodash: "4.17.21" } }),
      );
      return {
        code: 1,
        stderr: "",
        stdout: JSON.stringify({
          dryRun: false,
          fixed: 1,
          remaining: 1,
          fixes: [{ name: "lodash", from: "4.17.20", to: "4.17.21" }],
          blocked: [{ name: "lodash", from: "3.10.1", to: "4.17.21" }],
          unfixable: [],
          unmatched: [],
          unaudited: [],
          manifestUnavailable: [],
          vulnerableAfterInstall: [],
        }),
      };
    }
    if (args[1] === "audit") {
      scanned = true;
      return { code: 1, stderr: "", stdout: JSON.stringify({ lodash: [advisory] }) };
    }
    return { code: 0, stderr: "", stdout: "" };
  });
  expect(scanned).toBe(true);
  expect(result.status).toBe("ok");
  expect(result.ciStatus).toBe("passed");
  expect(result.fixed).toHaveLength(1);
  expect(result.after).toHaveLength(1);
  expect(result.after[0]?.status).toBe("constraint-blocked");
  expect(result.after[0]?.fixVersion).toBe("4.17.21");
  expect(result.changedFiles).toEqual(["bun.lock", "package.json"]);
  expect(await readFile(join(root, "bun.lock"), "utf8")).toBe(lock());
  expect(await readFile(join(root, "reports/candidate-files/bun.lock"), "utf8")).toBe(
    lock("4.17.21"),
  );
});

test("CLI rejects unknown and incomplete arguments without touching source files", () => {
  for (const args of [["--unknown"], ["--base-sha"], ["--output"]]) {
    const run = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "security-audit.ts"),
      ...args,
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toMatch(/Unknown argument|Missing value/);
  }
});

test("a different Bun version fails explicitly and records the observed version", async () => {
  const root = await fixture();
  const result = await generate(root, join(root, "reports"), undefined, false, () => ({
    code: 0,
    stdout: "1.4.5\n",
    stderr: "",
  }));
  expect(result.status).toBe("scan-failed");
  expect(result.toolVersion).toBe("1.4.5");
  expect(result.failure).toContain("1.4.4");
});

test("same numeric pin on an unrelated manifest package is not an authorized fix", () => {
  expect(() =>
    validateManifest(
      '{"dependencies":{"unrelated":"4.17.20"}}',
      '{"dependencies":{"unrelated":"4.17.21"}}',
      [{ name: "lodash", from: "4.17.20", to: "4.17.21" }],
    ),
  ).toThrow();
});

test("uncommitted dependency changes cannot enter an automated security candidate", async () => {
  const root = await fixture();
  const original = await readFile(join(root, "bun.lock"), "utf8");
  const result = await generate(root, join(root, "reports"), undefined, false, (args) => {
    if (args[1] === "--version") return { code: 0, stdout: "1.4.4", stderr: "" };
    if (args[1] === "rev-parse") return { code: 0, stdout: "a".repeat(40), stderr: "" };
    if (args[1] === "ls-files") return { code: 0, stdout: "package.json\0bun.lock\0", stderr: "" };
    if (args[1] === "diff") return { code: 1, stdout: "", stderr: "" };
    throw new Error("Must not install or scan a dirty dependency base");
  });
  expect(result.status).toBe("scan-failed");
  expect(result.failure).toContain("differ from base commit");
  expect(result.changedFiles).toEqual([]);
  expect(await readFile(join(root, "bun.lock"), "utf8")).toBe(original);
});
