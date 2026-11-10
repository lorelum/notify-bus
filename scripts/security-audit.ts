import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  type Candidate,
  type Locked,
  object,
  parseAudit,
  parseFix,
  parseLock,
} from "./security-model";

type Run = (
  args: string[],
  cwd: string,
  env: Record<string, string>,
) => { code: number; stdout: string; stderr: string };
const execute: Run = (args, cwd, env) => {
  const result = Bun.spawnSync(args, { cwd, env });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};
export async function generate(
  root: string,
  output: string,
  baseSha?: string,
  ci = false,
  run: Run = execute,
): Promise<Candidate> {
  root = resolve(root);
  output = resolve(output);
  const sandbox = await mkdtemp(join(tmpdir(), "notify-bus-audit-"));
  const tree = join(sandbox, "source"),
    home = join(sandbox, "home");
  await mkdir(tree);
  await mkdir(home);
  // Do not inherit registry tokens, CI credentials, git configuration, or user Bun configuration.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    TMPDIR: sandbox,
    TEMP: sandbox,
    TMP: sandbox,
    CI: "true",
    BUN_INSTALL_CACHE_DIR: join(sandbox, "cache"),
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT"])
    if (process.env[key]) env[key] = process.env[key]!;
  const result: Candidate = {
    schemaVersion: 1,
    baseSha: baseSha ?? "",
    toolVersion: "",
    status: "scan-failed",
    before: [],
    after: [],
    fixed: [],
    changedFiles: [],
    ciStatus: "not-run",
  };
  const evidence: Record<string, unknown> = {};
  const command = (label: string, args: string[], cwd = tree) => {
    const value = run(args, cwd, env);
    evidence[label] = { args, ...value };
    return value;
  };
  try {
    const version = command("version", [process.execPath, "--version"]);
    result.toolVersion = version.stdout.trim();
    if (version.code !== 0 || result.toolVersion !== "1.4.4")
      throw new Error("Exact Bun 1.4.4 unavailable; refusing a different runtime");
    const sha = command(
      "base",
      ["git", "rev-parse", "--verify", `${baseSha ?? "HEAD"}^{commit}`],
      root,
    );
    if (sha.code !== 0 || !/^[a-f0-9]{40,64}$/.test(sha.stdout.trim()))
      throw new Error("Cannot resolve base commit");
    result.baseSha = sha.stdout.trim();
    const files = command("tracked", ["git", "ls-files", "-z"], root);
    if (files.code !== 0) throw new Error("Cannot enumerate tracked files");
    const paths = files.stdout.split("\0").filter(Boolean);
    const dependencyPaths = paths.filter(
      (path) => path === "bun.lock" || /(^|\/)package\.json$/.test(path),
    );
    const baseline = command(
      "dependencyBaseline",
      ["git", "diff", "--quiet", result.baseSha, "--", ...dependencyPaths],
      root,
    );
    if (baseline.code !== 0)
      throw new Error(
        "Dependency files differ from base commit; preserve local changes and regenerate from a clean base",
      );
    for (const path of paths) {
      if (
        isAbsolute(path) ||
        path.split(/[\\/]/).some((part) => part === "..") ||
        path.startsWith("-")
      )
        throw new Error(`Unsafe tracked path ${path}`);
      if (
        /(^|\/)(node_modules|\.git|security-reports)(\/|$)/.test(path) ||
        /(^|\/)\.env(?:\.|$)/.test(path)
      )
        continue;
      // Registry configuration can contain write credentials; do not copy it into the execution environment.
      if (/(^|\/)(\.npmrc|bunfig\.toml)$/.test(path))
        throw new Error(`Review registry configuration before auditing: ${path}`);
      if (!(await lstat(join(root, path))).isFile())
        throw new Error(`Non-regular tracked file: ${path}`);
      const destination = join(tree, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(root, path), destination);
    }
    const originalLock = await readFile(join(tree, "bun.lock"), "utf8");
    const beforeLock = parseLock(originalLock);
    evidence.inventoryBefore = beforeLock;
    const install = command("frozenBefore", [
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
    if (install.code !== 0) throw new Error("Root frozen install failed");
    if ((await readFile(join(tree, "bun.lock"), "utf8")) !== originalLock)
      throw new Error("Frozen install changed root lock");
    const scan = (label: string, locked: Locked[]) => {
      const value = command(label, [process.execPath, "audit", "--json"]);
      if (![0, 1].includes(value.code) || /skip|unaudit|error|fail/i.test(value.stderr))
        throw new Error(`${label}: scanner failure or incomplete coverage`);
      const findings = parseAudit(value.stdout, locked);
      if ((findings.length === 0) !== (value.code === 0))
        throw new Error(`${label}: inconsistent audit exit status`);
      return findings;
    };
    result.before = scan("auditBefore", beforeLock);
    result.after = result.before;
    if (result.before.length === 0) {
      result.status = "ok";
      return result;
    }
    const fix = command("auditFix", [
      process.execPath,
      "audit",
      "fix",
      "--json",
      "--ignore-scripts",
    ]);
    if (![0, 1].includes(fix.code)) throw new Error("Audit fix execution failed");
    const fixes = parseFix(fix.stdout);
    for (const row of fixes)
      if (!result.before.some((f) => f.package === row.name && f.version === row.from))
        throw new Error(`Fix lacks advisory evidence: ${row.name}@${row.from}`);
    const afterText = await readFile(join(tree, "bun.lock"), "utf8"),
      afterLock = parseLock(afterText);
    evidence.inventoryAfter = afterLock;
    evidence.inventoryDifference = {
      removed: beforeLock.filter(
        (p) => !afterLock.some((q) => JSON.stringify(p) === JSON.stringify(q)),
      ),
      added: afterLock.filter(
        (p) => !beforeLock.some((q) => JSON.stringify(p) === JSON.stringify(q)),
      ),
    };
    evidence.coverageLimit =
      "Inventory differences are not scanner coverage equivalence. Bun does not expose its submitted request inventory; no Trivy comparison is asserted.";
    validateResolution(originalLock, afterText, fixes);
    // Bun may rewrite exact dependency, catalog, and override pins. No other source changes are candidates.
    const manifests = paths.filter((path) => /(^|\/)package\.json$/.test(path));
    for (const path of ["bun.lock", ...manifests]) {
      const content = await readFile(join(tree, path), "utf8");
      if (content === (await readFile(join(root, path), "utf8"))) continue;
      if (path !== "bun.lock")
        validateManifest(await readFile(join(root, path), "utf8"), content, fixes);
      result.changedFiles.push(path);
    }
    for (const path of result.changedFiles) {
      const destination = join(output, "candidate-files", path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(tree, path), destination);
    }
    result.after = scan("auditAfter", afterLock);
    const fixReport = object(JSON.parse(fix.stdout));
    for (const finding of result.after) {
      const blocked = (fixReport.blocked as { name: string; from: string; to?: string }[]).find(
        (row) => row.name === finding.package && row.from === finding.version,
      );
      const unfixable = (fixReport.unfixable as { name: string; from: string }[]).some(
        (row) => row.name === finding.package && row.from === finding.version,
      );
      if (blocked) {
        finding.status = "constraint-blocked";
        if (typeof blocked.to === "string") finding.fixVersion = blocked.to;
      } else if (unfixable) finding.status = "no-fix";
    }
    result.fixed = result.before.flatMap((before) => {
      const aliases = before.aliases.filter(
        (alias) =>
          !result.after.some(
            (after) =>
              after.package === before.package &&
              after.version === before.version &&
              after.aliases.includes(alias),
          ),
      );
      if (!aliases.length) return [];
      const repair = fixes.find(
        (row) => row.name === before.package && row.from === before.version,
      );
      return [{ ...before, aliases, ...(repair ? { fixVersion: repair.to } : {}) }];
    });
    const frozen = command("frozenAfter", [
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
    if (frozen.code !== 0 || (await readFile(join(tree, "bun.lock"), "utf8")) !== afterText)
      throw new Error("Candidate root frozen install failed");
    if (ci && result.changedFiles.length) {
      const checked = command("ci", ["make", "ci"]);
      result.ciStatus = checked.code === 0 ? "passed" : "failed";
    }
    result.status = "ok";
  } catch (error) {
    result.failure = error instanceof Error ? error.message : String(error);
  } finally {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    await writeFile(join(output, "candidate.json"), JSON.stringify(result, null, 2) + "\n");
    await rm(sandbox, { recursive: true, force: true });
  }
  return result;
}

type Fix = { name: string; from: string; to: string };
export function validateManifest(before: string, after: string, fixes: Fix[]): void {
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (
      typeof a === "string" &&
      typeof b === "string" &&
      fixes.some(
        (f) =>
          (a === f.from &&
            b === f.to &&
            (path.at(-1) === f.name || path.at(-1)?.endsWith(`>${f.name}`))) ||
          (a === `npm:${f.name}@${f.from}` && b === `npm:${f.name}@${f.to}`),
      ) &&
      path.some((p) =>
        [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
          "overrides",
          "catalog",
          "catalogs",
        ].includes(p),
      )
    )
      return;
    const left = object(a),
      right = object(b);
    if (Object.keys(left).sort().join("\0") !== Object.keys(right).sort().join("\0"))
      throw new Error(`Unrelated manifest change: ${path.join(".")}`);
    for (const key of Object.keys(left)) walk(left[key], right[key], [...path, key]);
  };
  walk(JSON.parse(before), JSON.parse(after), []);
}
export function validateResolution(before: string, after: string, fixes: Fix[]): void {
  const a = object(Bun.JSONC.parse(before)),
    b = object(Bun.JSONC.parse(after));
  const old = parseLock(before),
    next = parseLock(after);
  const packages = object(b.packages);
  const allowed = new Set(fixes.map((f) => f.name));
  const resolutionDependencies = new Set<string>();
  // Dependency closure explains newly resolved transitives; unchanged dependencies must stay untouched.
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of next.filter((p) => allowed.has(p.package))) {
      const entry = packages[row.alias] as unknown[];
      const metadata = entry[2] && typeof entry[2] === "object" ? object(entry[2]) : {};
      for (const key of ["dependencies", "optionalDependencies"])
        for (const name of Object.keys(metadata[key] ? object(metadata[key]) : {})) {
          resolutionDependencies.add(name);
          if (!allowed.has(name)) {
            allowed.add(name);
            changed = true;
          }
        }
    }
  }
  for (const row of old)
    if (
      !next.some(
        (p) => p.alias === row.alias && p.package === row.package && p.version === row.version,
      ) &&
      !resolutionDependencies.has(row.package) &&
      !fixes.some((f) => f.name === row.package && f.from === row.version)
    )
      throw new Error(`Unexplained locked removal/change: ${row.alias}`);
  for (const row of next)
    if (
      !old.some(
        (p) => p.alias === row.alias && p.package === row.package && p.version === row.version,
      ) &&
      !resolutionDependencies.has(row.package) &&
      !fixes.some((f) => f.name === row.package && f.to === row.version)
    )
      throw new Error(`Unexplained locked addition/change: ${row.alias}`);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (
      key === "packages" ||
      key === "workspaces" ||
      key === "overrides" ||
      key === "catalog" ||
      key === "catalogs"
    )
      continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key]))
      throw new Error(`Unexpected lock metadata change: ${key}`);
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    let output = "security-reports",
      base: string | undefined,
      ci = true;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--ci") ci = true;
      else if (arg === "--no-ci") ci = false;
      else if (arg === "--output" || arg === "--base-sha") {
        const value = args[++i];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
        if (arg === "--output") output = value;
        else base = value;
      } else throw new Error(`Unknown argument ${arg}`);
    }
    const report = await generate(process.cwd(), output, base, ci);
    if (report.status === "scan-failed" || report.ciStatus === "failed") process.exitCode = 1;
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
