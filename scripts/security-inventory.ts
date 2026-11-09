import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

type Lockfile = { packages: Record<string, [string, ...unknown[]]> };
type Component = { type: "library"; name: string; version: string; purl: string };

// Read Bun's JSONC directly: nested lockfile keys can contain versions that
// Trivy's native Bun analyzer omits. This is an inventory, not another lockfile.
const lockfile = Bun.JSONC.parse(await Bun.file("bun.lock").text()) as Lockfile;
const components = new Map<string, Component>();
for (const [specifier] of Object.values(lockfile.packages)) {
  if (specifier.includes("@workspace:")) continue;
  const separator = specifier.lastIndexOf("@");
  const name = specifier.slice(0, separator);
  const version = specifier.slice(separator + 1);
  if (separator <= 0 || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) {
    throw new Error(`Cannot inventory non-registry dependency: ${specifier}`);
  }
  const packagePath = name.split("/").map(encodeURIComponent).join("/");
  const purl = `pkg:npm/${packagePath}@${encodeURIComponent(version)}`;
  components.set(purl, { type: "library", name, version, purl });
}

const output = process.argv[2];
if (!output) throw new Error("Usage: bun scripts/security-inventory.ts <output.json>");
await mkdir(dirname(output), { recursive: true });
await Bun.write(
  output,
  JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: { component: { type: "application", name: "notify-bus" } },
      components: [...components.values()],
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  `Inventoried ${components.size} locked package versions (including dev dependencies).\n`,
);
