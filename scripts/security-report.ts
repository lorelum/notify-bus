type Inventory = { components: { name: string; version: string }[] };
type Report = {
  ArtifactName?: string;
  Results?: {
    Packages?: { Name: string; Version: string }[];
    Vulnerabilities?: { Severity: string }[];
  }[];
};

const [reportPath, inventoryPath] = process.argv.slice(2);
if (!reportPath) {
  throw new Error("Usage: bun scripts/security-report.ts <report.json> [inventory.json]");
}
const report = (await Bun.file(reportPath).json()) as Report;
if (!Array.isArray(report.Results) || report.Results.length === 0) {
  throw new Error("Trivy returned no package analysis; this is not a clean scan.");
}
const packages = new Set(
  report.Results.flatMap((result) => result.Packages ?? []).map(
    (pkg) => `${pkg.Name}@${pkg.Version}`,
  ),
);
if (packages.size === 0) throw new Error("Trivy returned no package inventory.");
if (inventoryPath) {
  const inventory = (await Bun.file(inventoryPath).json()) as Inventory;
  for (const pkg of inventory.components) {
    if (!packages.has(`${pkg.name}@${pkg.version}`)) {
      throw new Error(`Trivy omitted locked package ${pkg.name}@${pkg.version}`);
    }
  }
}
const vulnerabilities = report.Results.flatMap((result) => result.Vulnerabilities ?? []);
const counts = new Map<string, number>();
for (const vulnerability of vulnerabilities) {
  counts.set(vulnerability.Severity, (counts.get(vulnerability.Severity) ?? 0) + 1);
}
const lines = [
  "## Dependency vulnerability report",
  "",
  `Target: \`${report.ArtifactName}\``,
  `Package versions analyzed: ${packages.size}`,
  "",
  "| Severity | Findings |",
  "| --- | ---: |",
];
for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]) {
  lines.push(`| ${severity} | ${counts.get(severity) ?? 0} |`);
}
lines.push(
  "",
  "Report-only: findings do not block delivery. Scanner, input, and inventory failures do.",
  "Full findings and fixed versions are in the JSON artifact. This is not an exploitability assessment.",
);
process.stdout.write(lines.join("\n") + "\n");
