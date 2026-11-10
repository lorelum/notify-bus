import { semver } from "bun";

export type Finding = {
  aliases: string[];
  package: string;
  version: string;
  target: "source";
  fixVersion?: string;
  status: string;
};
export type Candidate = {
  schemaVersion: 1;
  baseSha: string;
  toolVersion: string;
  status: "ok" | "scan-failed";
  before: Finding[];
  after: Finding[];
  fixed: Finding[];
  failure?: string;
  changedFiles: string[];
  ciStatus: "passed" | "failed" | "not-run";
};
export type Locked = { alias: string; package: string; version: string };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function parseLock(text: string): Locked[] {
  const packages = object(object(Bun.JSONC.parse(text)).packages);
  return Object.entries(packages).flatMap(([alias, entry]) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string")
      throw new Error(`Invalid lock entry ${alias}`);
    const specifier = entry[0];
    if (specifier.includes("@workspace:")) return [];
    const split = specifier.lastIndexOf("@");
    const name = specifier.slice(0, split),
      version = specifier.slice(split + 1);
    if (split <= 0 || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version))
      throw new Error(`Unsupported locked source ${specifier}`);
    return [{ alias, package: name, version }];
  });
}
export function parseAudit(text: string, locked: Locked[]): Finding[] {
  const report = object(JSON.parse(text));
  const findings: Finding[] = [];
  for (const [name, rows] of Object.entries(report)) {
    if (!Array.isArray(rows) || rows.length === 0)
      throw new Error(`Invalid advisory report for ${name}`);
    for (const value of rows) {
      const row = object(value);
      if (
        !(typeof row.id === "number" || typeof row.id === "string") ||
        typeof row.url !== "string" ||
        !row.url.startsWith("https://") ||
        typeof row.vulnerable_versions !== "string" ||
        typeof row.severity !== "string"
      )
        throw new Error(`Invalid advisory for ${name}`);
      const advisoryId = new URL(row.url as string).pathname.match(
        /\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i,
      )?.[1];
      if (!advisoryId) throw new Error(`Missing public advisory identifier for ${name}`);
      let matched = false;
      for (const pkg of locked.filter((p) => p.package === name)) {
        let vulnerable: boolean;
        try {
          vulnerable = semver.satisfies(pkg.version, row.vulnerable_versions);
        } catch {
          throw new Error(`Invalid advisory range for ${name}`);
        }
        if (!vulnerable) continue;
        matched = true;
        const existing = findings.find(
          (f) => f.package === name && f.version === pkg.version && f.aliases.includes(advisoryId),
        );
        if (existing) continue;
        else
          findings.push({
            aliases: [advisoryId],
            package: name,
            version: pkg.version,
            target: "source",
            status: "affected",
          });
      }
      if (!matched) throw new Error(`Advisory has no covered locked version: ${name}`);
    }
  }
  return findings;
}
export function parseFix(text: string): { name: string; from: string; to: string }[] {
  const report = object(JSON.parse(text));
  for (const key of [
    "fixes",
    "blocked",
    "unfixable",
    "unmatched",
    "unaudited",
    "vulnerableAfterInstall",
    "manifestUnavailable",
  ]) {
    if (!Array.isArray(report[key])) throw new Error(`Missing fix coverage: ${key}`);
  }
  if (
    (report.unaudited as unknown[]).length ||
    (report.unmatched as unknown[]).length ||
    (report.manifestUnavailable as unknown[]).length
  )
    throw new Error("Incomplete audit fix coverage");
  if (
    report.dryRun !== false ||
    typeof report.fixed !== "number" ||
    typeof report.remaining !== "number"
  )
    throw new Error("Invalid fix result");
  return (report.fixes as unknown[]).map((value) => {
    const row = object(value);
    if (typeof row.name !== "string" || typeof row.from !== "string" || typeof row.to !== "string")
      throw new Error("Invalid fix entry");
    return { name: row.name, from: row.from, to: row.to };
  });
}

export function parseCandidate(text: string): Candidate {
  const report = object(JSON.parse(text));
  if (
    report.schemaVersion !== 1 ||
    typeof report.baseSha !== "string" ||
    typeof report.toolVersion !== "string" ||
    !["ok", "scan-failed"].includes(String(report.status)) ||
    !["passed", "failed", "not-run"].includes(String(report.ciStatus))
  )
    throw new Error("Invalid candidate metadata");
  if (
    report.status === "ok" &&
    (!/^[a-f0-9]{40,64}$/.test(report.baseSha) || !/^\d+\.\d+\.\d+$/.test(report.toolVersion))
  )
    throw new Error("Missing successful candidate provenance");
  for (const key of ["before", "after", "fixed"]) {
    if (!Array.isArray(report[key])) throw new Error(`Invalid candidate ${key}`);
    for (const value of report[key] as unknown[]) {
      const finding = object(value);
      if (
        !Array.isArray(finding.aliases) ||
        !finding.aliases.length ||
        !finding.aliases.every((alias) => typeof alias === "string" && alias.length > 0) ||
        typeof finding.package !== "string" ||
        !finding.package ||
        typeof finding.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(finding.version) ||
        finding.target !== "source" ||
        typeof finding.status !== "string" ||
        !finding.status ||
        (finding.fixVersion !== undefined && typeof finding.fixVersion !== "string")
      )
        throw new Error(`Invalid ${key} finding`);
    }
  }
  if (
    !Array.isArray(report.changedFiles) ||
    !report.changedFiles.every(
      (path) =>
        typeof path === "string" &&
        !path.startsWith("/") &&
        !path.includes("\\") &&
        !path.split("/").includes("..") &&
        (path === "bun.lock" || /^(?:[^/:]+\/)*package\.json$/.test(path)),
    ) ||
    new Set(report.changedFiles).size !== report.changedFiles.length
  )
    throw new Error("Invalid candidate paths");
  if (report.failure !== undefined && typeof report.failure !== "string")
    throw new Error("Invalid candidate failure");
  if (report.status === "scan-failed" && !report.failure) throw new Error("Missing scan failure");
  if (report.status === "ok" && report.failure !== undefined)
    throw new Error("Contradictory candidate failure");
  return report as unknown as Candidate;
}
