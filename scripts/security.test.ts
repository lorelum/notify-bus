import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "notify-bus-security-test-"));
  directories.push(path);
  return path;
}
function run(script: string, cwd: string, ...args: string[]) {
  return Bun.spawnSync([process.execPath, join(import.meta.dir, script), ...args], { cwd });
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("inventory retains nested and bundled versions without treating workspaces as external packages", async () => {
  const cwd = directory();
  writeFileSync(
    join(cwd, "bun.lock"),
    `{
      "packages": {
        "supports-color": ["supports-color@8.1.1"],
        "chalk/supports-color": ["supports-color@7.2.0"],
        "@emnapi/core": ["@emnapi/core@1.11.1"],
        "parent/@emnapi/core": ["@emnapi/core@1.11.2", "", {"bundled": true}],
        "alias": ["supports-color@8.1.1"],
        "@notify-bus/server": ["@notify-bus/server@workspace:packages/server"],
      },
    }`,
  );
  const output = join(cwd, "inventory.json");
  const result = run("security-inventory.ts", cwd, output);
  expect(result.exitCode).toBe(0);
  const inventory = await Bun.file(output).json();
  expect(
    inventory.components.map((component: { purl: string }) => component.purl).toSorted(),
  ).toEqual([
    "pkg:npm/%40emnapi/core@1.11.1",
    "pkg:npm/%40emnapi/core@1.11.2",
    "pkg:npm/supports-color@7.2.0",
    "pkg:npm/supports-color@8.1.1",
  ]);
});

test("inventory refuses an unsupported source instead of silently dropping it", () => {
  const cwd = directory();
  writeFileSync(
    join(cwd, "bun.lock"),
    JSON.stringify({ packages: { example: ["example@git+https://example.invalid/repo"] } }),
  );
  const result = run("security-inventory.ts", cwd, join(cwd, "inventory.json"));
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Cannot inventory non-registry dependency");
});

test("a scan missing a nested locked version is a failure, not a clean report", () => {
  const cwd = directory();
  const inventory = join(cwd, "inventory.json");
  const report = join(cwd, "report.json");
  writeFileSync(
    inventory,
    JSON.stringify({
      components: [
        { name: "supports-color", version: "7.2.0" },
        { name: "supports-color", version: "8.1.1" },
      ],
    }),
  );
  writeFileSync(
    report,
    JSON.stringify({ Results: [{ Packages: [{ Name: "supports-color", Version: "8.1.1" }] }] }),
  );
  const result = run("security-report.ts", cwd, report, inventory);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Trivy omitted locked package supports-color@7.2.0");
});

test("findings remain report-only, but a missing package analysis fails", () => {
  const cwd = directory();
  const report = join(cwd, "report.json");
  writeFileSync(
    report,
    JSON.stringify({
      ArtifactName: "fixture",
      Results: [
        {
          Packages: [{ Name: "handlebars", Version: "4.7.9" }],
          Vulnerabilities: [{ Severity: "CRITICAL" }],
        },
      ],
    }),
  );
  const findings = run("security-report.ts", cwd, report);
  expect(findings.exitCode).toBe(0);
  expect(findings.stdout.toString()).toContain("| CRITICAL | 1 |");
  writeFileSync(report, JSON.stringify({ Results: [] }));
  const empty = run("security-report.ts", cwd, report);
  expect(empty.exitCode).toBe(1);
  expect(empty.stderr.toString()).toContain("not a clean scan");
});
