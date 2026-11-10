import { dirname, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";

export type Finding = {
  aliases: string[];
  package: string;
  version: string;
  target: string;
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
  failure?: unknown;
  changedFiles: string[];
  ciStatus: "passed" | "failed" | "not-run";
};
export type Transport = <T>(method: string, path: string, body?: unknown) => Promise<T>;
type Item = {
  number: number;
  body: string | null;
  state: string;
  pull_request?: unknown;
  head?: { sha: string; ref: string };
  base?: { ref: string };
};
type Fact = { finding: Finding; status: string; origin: "audit" | "trivy" };
export type PublishOptions = {
  repo: string;
  candidate: Candidate;
  files: Record<string, string>;
  transport: Transport;
  apply?: boolean;
  owner?: string;
  mainScan?: boolean;
  observations?: Finding[];
  scannedTargets?: string[];
  scanFailed?: boolean;
  now?: Date;
  overdueDays?: number;
};
const branch = "security/dependency-fixes";
const prMarker = "<!-- security-publisher:pr:v1 -->";
const issueMarker = "<!-- security-publisher:issue:v1 ";
const advisory =
  /^(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|RUSTSEC-\d{4}-\d+)$/i;
const safePackage = /^(?:@[a-z0-9._-]+\/)?[a-z0-9+._-]+$/i;
const safeVersion = /^[a-z0-9+._~:,-]+$/i;
const sha = /^[0-9a-f]{40}$/;
const allowed = (path: string) =>
  path === "bun.lock" ||
  path === "package.json" ||
  /^packages\/[a-zA-Z0-9_-]+\/package.json$/.test(path);
function validFinding(f: Finding): boolean {
  return (
    !!f &&
    Array.isArray(f.aliases) &&
    f.aliases.length > 0 &&
    f.aliases.every((a) => typeof a === "string" && advisory.test(a)) &&
    typeof f.package === "string" &&
    safePackage.test(f.package) &&
    typeof f.version === "string" &&
    safeVersion.test(f.version) &&
    (f.target === "source" || /^sha256:[0-9a-f]{64}$/.test(f.target)) &&
    typeof f.status === "string" &&
    (f.fixVersion === undefined || typeof f.fixVersion === "string")
  );
}
export function sameFinding(a: Finding, b: Finding): boolean {
  return (
    a.package === b.package &&
    a.target === b.target &&
    a.aliases.some((id) => b.aliases.includes(id))
  );
}
export function validateCandidate(c: Candidate): void {
  if (
    !c ||
    c.schemaVersion !== 1 ||
    !sha.test(c.baseSha) ||
    typeof c.toolVersion !== "string" ||
    !["ok", "scan-failed"].includes(c.status) ||
    !["passed", "failed", "not-run"].includes(c.ciStatus) ||
    ![c.before, c.after, c.fixed].every((a) => Array.isArray(a) && a.every(validFinding)) ||
    !Array.isArray(c.changedFiles) ||
    !c.changedFiles.every((p) => typeof p === "string" && allowed(p)) ||
    new Set(c.changedFiles).size !== c.changedFiles.length
  )
    throw new Error("Invalid candidate contract");
}
export function effectiveFixes(c: Candidate): Finding[] {
  return c.status !== "ok"
    ? []
    : c.fixed.filter(
        (f) =>
          f.target === "source" &&
          c.before.some((b) => sameFinding(b, f) && b.version === f.version) &&
          !c.after.some((a) => sameFinding(a, f) && a.version === f.version),
      );
}
export function trivyFacts(
  report: unknown,
  inventory: unknown | undefined,
  target: string,
): Finding[] {
  const r = report as {
    Results?: {
      Packages?: { Name: string; Version: string }[];
      Vulnerabilities?: {
        VulnerabilityID: string;
        PkgName: string;
        InstalledVersion: string;
        FixedVersion?: string;
        Status?: string;
        References?: string[];
      }[];
    }[];
  };
  if (!Array.isArray(r?.Results) || !r.Results.length) throw new Error("Scan coverage failed");
  const packages = r.Results.flatMap((v) => v.Packages ?? []);
  if (!packages.length) throw new Error("Scan coverage failed");
  if (inventory !== undefined) {
    if (!inventory || typeof inventory !== "object" || !("components" in inventory))
      throw new Error("Scan coverage failed");
    const components = inventory.components as { name: string; version: string }[];
    if (
      !Array.isArray(components) ||
      !components.length ||
      components.some((c) => !packages.some((p) => p.Name === c.name && p.Version === c.version))
    )
      throw new Error("Scan coverage failed");
  }
  const facts = r.Results.flatMap((r) => r.Vulnerabilities ?? []).map((v) => ({
    aliases: [
      ...new Set([
        v.VulnerabilityID,
        ...(v.References ?? []).flatMap(
          (reference) =>
            reference.match(/(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})/gi) ??
            [],
        ),
      ]),
    ],
    package: v.PkgName,
    version: v.InstalledVersion,
    target,
    ...(v.FixedVersion ? { fixVersion: v.FixedVersion } : {}),
    status: v.Status ?? "affected",
  }));
  if (!facts.every(validFinding)) throw new Error("Invalid scan facts");
  return facts;
}
async function pages<T>(get: Transport, path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const response = await get<T[] | { check_runs: T[] }>(
      "GET",
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    const batch = Array.isArray(response) ? response : response.check_runs;
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}
type RescanProof = { baseSha: string; origins: ("audit" | "trivy")[] };
function metadata(item: Item):
  | {
      finding?: Finding;
      status: string;
      updated: string;
      origins?: ("audit" | "trivy")[];
      proof?: RescanProof;
    }
  | undefined {
  const raw = item.body?.split(issueMarker)[1]?.split(" -->")[0];
  try {
    const data = JSON.parse(raw ?? "null");
    return data &&
      typeof data.status === "string" &&
      typeof data.updated === "string" &&
      (data.proof === undefined ||
        (data.proof &&
          sha.test(data.proof.baseSha) &&
          Array.isArray(data.proof.origins) &&
          data.proof.origins.every((value: unknown) => value === "audit" || value === "trivy"))) &&
      (!data.finding || validFinding(data.finding)) &&
      (data.origins === undefined ||
        (Array.isArray(data.origins) &&
          data.origins.length > 0 &&
          data.origins.every((v: unknown) => v === "audit" || v === "trivy")))
      ? data
      : undefined;
  } catch {
    return undefined;
  }
}
function publicFinding(f: Finding): string {
  return `${f.aliases.join(", ")} | ${f.package}@${f.version}`;
}
function issueBody(
  finding: Finding | undefined,
  status: string,
  owner: string,
  now: string,
  origins?: ("audit" | "trivy")[],
  proof?: RescanProof,
): string {
  const safeFinding = finding && {
    aliases: finding.aliases,
    package: finding.package,
    version: finding.version,
    target: finding.target,
    status: "affected",
  };
  return `${issueMarker}${JSON.stringify({ finding: safeFinding, status, updated: now, origins: origins?.length ? origins : undefined, proof })} -->\nMaintenance status: ${status}\nOwner: @${owner}\n${finding ? publicFinding(finding) : "Security scanner requires maintainer attention."}\nSource main is not a deployment assertion. Image digests are tracked independently.`;
}
async function publishLocked(o: PublishOptions): Promise<string[]> {
  validateCandidate(o.candidate);
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error("Invalid repository");
  const owner = o.owner ?? o.repo.split("/")[0]!;
  if (!/^[a-zA-Z0-9-]+$/.test(owner)) throw new Error("Invalid owner");
  if (
    !(o.observations ?? []).every(validFinding) ||
    !(o.scannedTargets ?? []).every((t) => t === "source" || /^sha256:[0-9a-f]{64}$/.test(t))
  )
    throw new Error("Invalid observations");
  const c = o.candidate,
    api = `/repos/${o.repo}`,
    log: string[] = [],
    now = (o.now ?? new Date()).toISOString();
  const get = o.transport;
  const mutate = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | undefined> => {
    log.push(`${method} ${path}`);
    return o.apply ? get<T>(method, path, body) : undefined;
  };
  const main = await get<{ object: { sha: string } }>("GET", `${api}/git/ref/heads/main`);
  const pulls = await pages<Item>(get, `${api}/pulls?state=open`);
  const prs = pulls.filter(
    (p) => p.body?.includes(prMarker) && p.head?.ref === branch && p.base?.ref === "main",
  );
  if (prs.length > 1) throw new Error("Multiple managed security pull requests");
  const fixes = effectiveFixes(c);
  const fileNames = Object.keys(o.files);
  if (
    fileNames.some((p) => !allowed(p)) ||
    fileNames.length !== c.changedFiles.length ||
    c.changedFiles.some((p) => !Object.hasOwn(o.files, p))
  )
    throw new Error("Candidate file mismatch");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ base: c.baseSha, files: Object.entries(o.files).sort(), fixes }))
    .digest("hex");
  let activePr = prs[0];
  let prValid = false;
  let githubCiFailed = false;
  let alreadyPublished = false;
  if (activePr?.head) {
    const checks = await pages<{ status: string; conclusion: string | null }>(
      get,
      `${api}/commits/${activePr.head.sha}/check-runs`,
    );
    githubCiFailed = checks.some(
      (ch) =>
        ch.status === "completed" &&
        !["success", "neutral", "skipped"].includes(ch.conclusion ?? ""),
    );
    if (activePr.body?.includes(`<!-- evidence:${fingerprint} -->`)) {
      type Tree = {
        truncated?: boolean;
        tree: { path: string; mode: string; type: string; sha: string }[];
      };
      const baseTree = await get<Tree>("GET", `${api}/git/trees/${c.baseSha}?recursive=1`);
      const headTree = await get<Tree>("GET", `${api}/git/trees/${activePr.head.sha}?recursive=1`);
      if (baseTree.truncated || headTree.truncated) throw new Error("Incomplete PR tree evidence");
      const before = new Map(
        baseTree.tree.filter((e) => e.type !== "tree").map((e) => [e.path, e]),
      );
      const after = new Map(headTree.tree.filter((e) => e.type !== "tree").map((e) => [e.path, e]));
      const changes = [...new Set([...before.keys(), ...after.keys()])].filter(
        (path) =>
          before.get(path)?.sha !== after.get(path)?.sha ||
          before.get(path)?.mode !== after.get(path)?.mode,
      );
      alreadyPublished =
        changes.length === fileNames.length &&
        changes.every((path) => {
          const content = o.files[path];
          if (content === undefined) return false;
          const blob = createHash("sha1")
            .update(`blob ${Buffer.byteLength(content)}\0`)
            .update(content)
            .digest("hex");
          return after.get(path)?.sha === blob && after.get(path)?.mode === "100644";
        });
    }
    prValid =
      alreadyPublished &&
      main.object.sha === c.baseSha &&
      c.status === "ok" &&
      checks.length > 0 &&
      checks.every((ch) => ch.status === "completed" && ch.conclusion === "success");
  }
  const canPublish =
    !o.scanFailed &&
    main.object.sha === c.baseSha &&
    c.status === "ok" &&
    c.ciStatus === "passed" &&
    fixes.length > 0 &&
    fileNames.length > 0;
  if (canPublish && !alreadyPublished) {
    let existing: string | undefined;
    try {
      existing = (await get<{ object: { sha: string } }>("GET", `${api}/git/ref/heads/${branch}`))
        .object.sha;
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e;
    }
    const baseCommit = await get<{ tree: { sha: string } }>(
      "GET",
      `${api}/git/commits/${c.baseSha}`,
    );
    const entries: { path: string; mode: string; type: string; sha: string }[] = [];
    for (const path of fileNames.sort()) {
      const blob = await mutate<{ sha: string }>("POST", `${api}/git/blobs`, {
        content: o.files[path],
        encoding: "utf-8",
      });
      entries.push({ path, mode: "100644", type: "blob", sha: blob?.sha ?? "dry-run" });
    }
    const tree = await mutate<{ sha: string }>("POST", `${api}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: entries,
    });
    const commit = await mutate<{ sha: string }>("POST", `${api}/git/commits`, {
      message: "fix: remediate verified security findings",
      tree: tree?.sha,
      parents: [...new Set([c.baseSha, ...(existing ? [existing] : [])])],
    });
    if (
      (await get<{ object: { sha: string } }>("GET", `${api}/git/ref/heads/main`)).object.sha !==
      c.baseSha
    )
      throw new Error("Main advanced; regenerate candidate");
    if (existing) {
      if (
        (await get<{ object: { sha: string } }>("GET", `${api}/git/ref/heads/${branch}`)).object
          .sha !== existing
      )
        throw new Error("Security branch advanced");
      await mutate("PATCH", `${api}/git/refs/heads/${branch}`, { sha: commit?.sha, force: false });
    } else
      await mutate("POST", `${api}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit?.sha });
    const body = `${prMarker}\n<!-- evidence:${fingerprint} -->\nVerified security remediations:\n${fixes.map(publicFinding).join("\n")}\nMaintenance status: awaiting GitHub CI and manual review.\nNo automatic merge. Main is not deployment.`;
    // Re-list immediately before creation: branch uniqueness also makes concurrent PR creation fail closed.
    const current = (
      await pages<Item>(
        get,
        `${api}/pulls?state=open&head=${encodeURIComponent(`${o.repo.split("/")[0]}:${branch}`)}`,
      )
    ).find((p) => p.head?.ref === branch && p.base?.ref === "main");
    if (current && !current.body?.includes(prMarker))
      throw new Error("Security branch has an unmanaged pull request");
    activePr = current ?? activePr;
    if (activePr) {
      if (activePr.body !== body)
        await mutate("PATCH", `${api}/pulls/${activePr.number}`, { body });
    } else
      await mutate("POST", `${api}/pulls`, {
        title: "fix: verified dependency security remediations",
        head: branch,
        base: "main",
        body,
      });
    // Newly pushed commits have not yet passed GitHub CI; never suppress their tracking issues.
    prValid = false;
  }
  const issues = (await pages<Item>(get, `${api}/issues?state=all`)).filter((i) => !i.pull_request);
  const facts: Fact[] = [
    ...c.after.map((finding) => ({ finding, origin: "audit" as const })),
    ...(o.observations ?? []).map((finding) => ({ finding, origin: "trivy" as const })),
  ].map((f) => ({
    ...f,
    status:
      c.ciStatus === "failed" || githubCiFailed
        ? "ci-failed"
        : f.finding.status === "constraint-blocked"
          ? "constraint-blocked"
          : f.finding.status === "no-fix" || !f.finding.fixVersion
            ? "no-fix"
            : "owner-action-required",
  }));
  for (const finding of c.before)
    if (
      !facts.some((f) => f.origin === "audit" && sameFinding(f.finding, finding)) &&
      !(prValid && fixes.some((f) => sameFinding(f, finding) && f.version === finding.version))
    )
      facts.push({
        finding,
        origin: "audit",
        status:
          c.ciStatus === "failed" || githubCiFailed
            ? "ci-failed"
            : canPublish
              ? "awaiting-ci"
              : main.object.sha !== c.baseSha
                ? "stale-candidate"
                : "owner-action-required",
      });
  const upsert = async (
    finding: Finding | undefined,
    status: string,
    origin?: "audit" | "trivy",
  ) => {
    const matches = issues.filter((i) => {
      const m = metadata(i);
      return m && (finding ? !!m.finding && sameFinding(m.finding, finding) : !m.finding);
    });
    if (!finding && !matches.length && issues.some((i) => metadata(i)?.status === status)) return;
    const item = matches.find((i) => i.state === "open") ?? matches[0];
    const previous = item && metadata(item);
    const origins = [
      ...new Set([
        ...(previous?.origins ??
          (previous?.finding
            ? [previous.finding.target === "source" ? ("audit" as const) : ("trivy" as const)]
            : [])),
        ...(origin ? [origin] : []),
      ]),
    ];
    const due =
      previous &&
      Date.parse(now) - Date.parse(previous.updated) >= (o.overdueDays ?? 14) * 86400000;
    if (!item) {
      const body = issueBody(finding, status, owner, now, origins);
      const result = await mutate<Item>("POST", `${api}/issues`, {
        title: finding
          ? `Security maintenance: ${publicFinding(finding)}`
          : "Security maintenance: scanner failure",
        body,
        assignees: [owner],
      });
      issues.push(result ?? { number: -1, state: "open", body });
    } else if (
      item.state !== "open" ||
      previous?.status !== status ||
      due ||
      (origin &&
        !origins.every((value) =>
          (
            previous?.origins ?? (previous?.finding?.target === "source" ? ["audit"] : ["trivy"])
          ).includes(value),
        ))
    ) {
      const body = issueBody(finding, status, owner, now, origins);
      await mutate("PATCH", `${api}/issues/${item.number}`, { state: "open", body });
      item.body = body;
    }
  };
  // Apply holds a Git ref lock, serializing list-and-create issue operations.
  for (const fact of facts)
    if (
      !(
        fact.origin === "audit" &&
        prValid &&
        fixes.some((f) => sameFinding(f, fact.finding) && f.version === fact.finding.version)
      )
    )
      await upsert(fact.finding, fact.status, fact.origin);
  const failed = c.status === "scan-failed" || o.scanFailed;
  if (failed) await upsert(undefined, "scan-failed");
  if (!failed && o.mainScan && main.object.sha === c.baseSha && c.status === "ok") {
    for (const item of issues.filter((i) => i.state === "open")) {
      const m = metadata(item);
      if (!m?.finding) continue;
      const origins = m.origins ?? (m.finding?.target === "source" ? ["audit"] : ["trivy"]);
      const proven = origins.filter(
        (origin) =>
          (m.proof?.baseSha === c.baseSha &&
            Array.isArray(m.proof.origins) &&
            m.proof.origins.includes(origin)) ||
          (origin === "audit"
            ? c.toolVersion !== "report-only" && !c.before.some((f) => sameFinding(f, m.finding!))
            : (o.scannedTargets ?? []).includes(m.finding!.target) &&
              !(o.observations ?? []).some((f) => sameFinding(f, m.finding!))),
      );
      const resolved = proven.length === origins.length;
      if (
        m.finding &&
        (resolved || proven.length > (m.proof?.baseSha === c.baseSha ? m.proof.origins.length : 0))
      ) {
        if (
          (await get<{ object: { sha: string } }>("GET", `${api}/git/ref/heads/main`)).object
            .sha !== c.baseSha
        )
          throw new Error("Main advanced during rescan publication");
        await mutate("PATCH", `${api}/issues/${item.number}`, {
          state: resolved ? "closed" : "open",
          body: issueBody(
            m.finding,
            resolved ? "resolved-by-main-rescan" : "awaiting-other-rescan",
            owner,
            now,
            m.origins,
            { baseSha: c.baseSha, origins: proven },
          ),
        });
      }
    }
  }
  return log;
}
export async function publish(o: PublishOptions): Promise<string[]> {
  validateCandidate(o.candidate);
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error("Invalid repository");
  if (!o.apply) return publishLocked(o);
  const root = `/repos/${o.repo}/git`;
  const main = await o.transport<{ object: { sha: string } }>("GET", `${root}/ref/heads/main`);
  // Atomic ref creation is the lock. A crashed runner leaves a fail-closed lock for owner recovery.
  try {
    await o.transport("POST", `${root}/refs`, {
      ref: "refs/heads/security/publisher-lock",
      sha: main.object.sha,
    });
  } catch (error) {
    if (error instanceof GitHubError && error.status === 422)
      throw new PublisherLockError(o.repo.split("/")[0]!);
    throw error;
  }
  try {
    return await publishLocked(o);
  } finally {
    await o.transport("DELETE", `${root}/refs/heads/security/publisher-lock`);
  }
}
export class PublisherLockError extends Error {
  constructor(owner: string) {
    super(
      `Owner @${owner}: publisher-lock blocks publication. Confirm no publisher is running, inspect refs/heads/security/publisher-lock, then manually delete only that lock ref and rerun.`,
    );
  }
}
export class GitHubError extends Error {
  constructor(public status: number) {
    super(`GitHub request failed (${status})`);
  }
}
export function githubTransport(token: string): Transport {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new GitHubError(response.status);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  };
}
export async function resolveAdvisoryAliases(findings: Finding[], get: Transport): Promise<void> {
  const cache = new Map<string, string[]>();
  for (const finding of findings) {
    for (const id of finding.aliases) {
      if (!id.startsWith("GHSA-")) continue;
      let aliases = cache.get(id);
      if (!aliases) {
        const data = await get<{ identifiers: { type: string; value: string }[] }>(
          "GET",
          `/advisories/${id}`,
        );
        if (!Array.isArray(data.identifiers)) throw new Error("Advisory alias lookup failed");
        aliases = data.identifiers
          .map((entry) => entry.value)
          .filter((value) => advisory.test(value));
        if (!aliases.includes(id)) throw new Error("Advisory alias response mismatch");
        cache.set(id, aliases);
      }
      finding.aliases = [...new Set([...finding.aliases, ...aliases])];
    }
  }
}

async function cli(): Promise<void> {
  const args = process.argv.slice(2),
    apply = args.includes("--apply");
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const repo = option("--repo") ?? process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("Repository and GitHub token required");
  const reportDirectory = option("--reports");
  const candidatePath = option("--candidate") ?? "security-reports/candidate.json";
  let candidate: Candidate;
  if (reportDirectory && !option("--candidate"))
    candidate = {
      schemaVersion: 1,
      baseSha: option("--base-sha") ?? "",
      toolVersion: "report-only",
      status: "ok",
      before: [],
      after: [],
      fixed: [],
      changedFiles: [],
      ciStatus: "not-run",
    };
  else {
    try {
      candidate = (await Bun.file(candidatePath).json()) as Candidate;
    } catch {
      if (!args.includes("--scan-failed") || !option("--base-sha"))
        throw new Error("Candidate artifact unavailable");
      candidate = {
        schemaVersion: 1,
        baseSha: option("--base-sha")!,
        toolVersion: "unavailable",
        status: "scan-failed",
        before: [],
        after: [],
        fixed: [],
        changedFiles: [],
        ciStatus: "not-run",
      };
    }
  }
  validateCandidate(candidate);
  const files: Record<string, string> = {};
  if (candidate.changedFiles.length) {
    const root = await realpath(resolve(dirname(candidatePath), "candidate-files"));
    for (const path of candidate.changedFiles) {
      const fullPath = await realpath(resolve(root, path));
      if (!fullPath.startsWith(root + sep)) throw new Error("Candidate path escapes artifact");
      files[path] = await Bun.file(fullPath).text();
    }
  }
  const observations: Finding[] = [],
    scannedTargets: string[] = [];
  const upstreamStatus = option("--upstream-status");
  let scanFailed =
    args.includes("--scan-failed") ||
    (upstreamStatus !== undefined && upstreamStatus !== "success");
  try {
    const source = option("--source-report"),
      inventory = option("--inventory"),
      image = option("--image-report"),
      reference = option("--image-reference");
    if (source) {
      if (!inventory) throw new Error("Inventory required");
      observations.push(
        ...trivyFacts(await Bun.file(source).json(), await Bun.file(inventory).json(), "source"),
      );
      scannedTargets.push("source");
    }
    if (image) {
      if (!reference) throw new Error("Image reference required");
      const ref = (await Bun.file(reference).text()).trim();
      const digest = ref.match(/(?:^|@)(sha256:[0-9a-f]{64})$/)?.[1];
      if (!digest) throw new Error("Digest required");
      observations.push(...trivyFacts(await Bun.file(image).json(), undefined, digest));
      scannedTargets.push(digest);
    }
  } catch {
    scanFailed = true;
  }
  if (reportDirectory) {
    let count = 0;
    try {
      for await (const path of new Bun.Glob("**/*.json").scan({
        cwd: reportDirectory,
        absolute: true,
      })) {
        try {
          const report = await Bun.file(path).json();
          if (!report || typeof report !== "object" || !("Results" in report)) continue;
          let inventory: unknown;
          let target: string;
          const reference = Bun.file(resolve(dirname(path), "image-reference.txt"));
          if (await reference.exists()) {
            const digest = (await reference.text())
              .trim()
              .match(/(?:^|@)(sha256:[0-9a-f]{64})$/)?.[1];
            if (!digest) throw new Error("Invalid digest");
            target = digest;
          } else {
            target = "source";
            for await (const inventoryPath of new Bun.Glob("*.json").scan({
              cwd: dirname(path),
              absolute: true,
            })) {
              const data = await Bun.file(inventoryPath).json();
              if (data?.bomFormat === "CycloneDX" && Array.isArray(data.components)) {
                inventory = data;
                break;
              }
            }
            if (!inventory) throw new Error("Source inventory required");
          }
          observations.push(...trivyFacts(report, inventory, target));
          scannedTargets.push(target);
          count++;
        } catch {
          scanFailed = true;
        }
      }
    } catch {
      scanFailed = true;
    }
    if (!count) scanFailed = true;
  }
  const transport = githubTransport(token);
  try {
    await resolveAdvisoryAliases(
      [...candidate.before, ...candidate.after, ...candidate.fixed, ...observations],
      transport,
    );
  } catch {
    scanFailed = true;
  }
  const actions = await publish({
    repo,
    candidate,
    files,
    transport,
    apply,
    owner: option("--owner"),
    mainScan: args.includes("--main-scan"),
    observations,
    scannedTargets,
    scanFailed,
  });
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", actions }));
}
if (import.meta.main)
  cli().catch((error: unknown) => {
    console.error(
      error instanceof PublisherLockError
        ? error.message
        : "Security publication failed; maintainer action required.",
    );
    process.exitCode = 1;
  });
