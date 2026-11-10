import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  effectiveFixes,
  GitHubError,
  publish,
  resolveAdvisoryAliases,
  sameFinding,
  trivyFacts,
  validateCandidate,
  type Candidate,
  type Finding,
  type PublishOptions,
  type Transport,
} from "./security-publish";
import { parseAudit } from "./security-model";

const baseSha = "a".repeat(40);
const finding: Finding = {
  aliases: ["CVE-2026-12345"],
  package: "example",
  version: "1.0.0",
  target: "source",
  fixVersion: "1.0.1",
  status: "affected",
};
const candidate = (extra: Partial<Candidate> = {}): Candidate => ({
  schemaVersion: 1,
  baseSha,
  toolVersion: "1.4.4",
  status: "ok",
  before: [],
  after: [],
  fixed: [],
  changedFiles: [],
  ciStatus: "passed",
  ...extra,
});
type Call = { method: string; path: string; body: unknown };
function mock(
  extra: { issues?: unknown[]; pulls?: unknown[]; handler?: (call: Call) => unknown } = {},
) {
  const calls: Call[] = [];
  const transport: Transport = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const call = { method, path, body };
    calls.push(call);
    const answer = extra.handler?.(call);
    if (answer !== undefined) return answer as T;
    if (path.includes("/git/ref/heads/main")) return { object: { sha: baseSha } } as T;
    if (path.includes("/git/ref/heads/security/dependency-fixes")) throw new GitHubError(404);
    if (path.includes("/git/commits/") && method === "GET") return { tree: { sha: "tree" } } as T;
    if (path.includes("/pulls?") && method === "GET") return (extra.pulls ?? []) as T;
    if (path.includes("/issues?") && method === "GET") return (extra.issues ?? []) as T;
    if (path.includes("check-runs"))
      return { check_runs: [{ status: "completed", conclusion: "success" }] } as T;
    if (method !== "GET")
      return {
        sha: "b".repeat(40),
        number: 10,
        state: "open",
        ...(typeof body === "object" ? body : {}),
      } as T;
    throw new Error(`Unexpected isolated request ${method} ${path}`);
  };
  return { calls, transport };
}
function options(transport: Transport, extra: Partial<PublishOptions> = {}): PublishOptions {
  return {
    repo: "owner/repo",
    candidate: candidate(),
    files: {},
    transport,
    now: new Date("2026-11-10T00:00:00Z"),
    ...extra,
  };
}
function tracked(f: Finding, status = "no-fix", updated = "2026-11-09T00:00:00.000Z") {
  return {
    number: 42,
    state: "open",
    body: `<!-- security-publisher:issue:v1 ${JSON.stringify({ finding: f, status, updated })} -->`,
  };
}

describe("security publisher isolated transport", () => {
  test("dry run never invokes write transport", async () => {
    const m = mock();
    const actions = await publish(
      options(m.transport, { candidate: candidate({ after: [finding] }) }),
    );
    expect(actions.some((a) => a.includes("/issues"))).toBe(true);
    expect(m.calls.every((c) => c.method === "GET")).toBe(true);
  });
  test("no effective fix means no PR", async () => {
    const m = mock();
    await publish(
      options(m.transport, {
        apply: true,
        candidate: candidate({ before: [finding], after: [finding], fixed: [finding] }),
      }),
    );
    expect(m.calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toBe(false);
    expect(effectiveFixes(candidate({ before: [finding], fixed: [finding] }))).toEqual([finding]);
  });
  test("only verified source disappearance is a fix", () => {
    expect(effectiveFixes(candidate({ fixed: [finding] }))).toEqual([]);
    expect(
      effectiveFixes(candidate({ before: [finding], fixed: [{ ...finding, version: "0.0.1" }] })),
    ).toEqual([]);
    expect(
      effectiveFixes(candidate({ status: "scan-failed", before: [finding], fixed: [finding] })),
    ).toEqual([]);
  });
  test("publishes allowlisted blobs without main mutation or force", async () => {
    const m = mock();
    await publish(
      options(m.transport, {
        apply: true,
        candidate: candidate({ before: [finding], fixed: [finding], changedFiles: ["bun.lock"] }),
        files: { "bun.lock": "safe lock data" },
      }),
    );
    expect(m.calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toBe(true);
    expect(
      m.calls.filter((c) => c.method !== "GET").some((c) => c.path.endsWith("/heads/main")),
    ).toBe(false);
    expect(JSON.stringify(m.calls)).not.toContain('"force":true');
    expect(m.calls.at(-1)?.method).toBe("DELETE");
  });
  test("stale main suppresses PR and reports owner state", async () => {
    const m = mock({
      handler: (c) =>
        c.path.endsWith("/ref/heads/main") ? { object: { sha: "c".repeat(40) } } : undefined,
    });
    await publish(
      options(m.transport, {
        apply: true,
        candidate: candidate({ before: [finding], fixed: [finding], changedFiles: ["bun.lock"] }),
        files: { "bun.lock": "lock" },
      }),
    );
    expect(m.calls.some((c) => c.path.endsWith("/pulls") && c.method === "POST")).toBe(false);
    expect(JSON.stringify(m.calls)).toContain("stale-candidate");
  });
  test("main advancing mid-publish aborts before branch creation", async () => {
    let reads = 0;
    const m = mock({
      handler: (c) =>
        c.path.endsWith("/ref/heads/main")
          ? { object: { sha: ++reads > 2 ? "c".repeat(40) : baseSha } }
          : undefined,
    });
    await expect(
      publish(
        options(m.transport, {
          apply: true,
          candidate: candidate({ before: [finding], fixed: [finding], changedFiles: ["bun.lock"] }),
          files: { "bun.lock": "lock" },
        }),
      ),
    ).rejects.toThrow("Main advanced");
    expect(
      m.calls.some(
        (c) =>
          c.method === "POST" &&
          JSON.stringify(c.body).includes('"refs/heads/security/dependency-fixes"'),
      ),
    ).toBe(false);
    expect(m.calls.at(-1)?.method).toBe("DELETE");
  });
  test("rejects workflow and traversal paths", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      "../package.json",
      "packages/../package.json",
      "other.lock",
    ])
      expect(() => validateCandidate(candidate({ changedFiles: [path] }))).toThrow();
  });
  test("alias intersection uses package and object but not version", () => {
    expect(
      sameFinding(finding, {
        ...finding,
        aliases: ["GHSA-abcd-abcd-abcd", ...finding.aliases],
        version: "2.0.0",
      }),
    ).toBe(true);
    expect(sameFinding(finding, { ...finding, package: "other" })).toBe(false);
    expect(sameFinding(finding, { ...finding, target: `sha256:${"a".repeat(64)}` })).toBe(false);
  });
  test("same state is quiet; overdue changes issue body without comments", async () => {
    const f = { ...finding, fixVersion: undefined };
    const m = mock({ issues: [tracked(f)] });
    await publish(options(m.transport, { apply: true, candidate: candidate({ after: [f, f] }) }));
    expect(m.calls.filter((c) => c.method !== "GET" && c.path.includes("/issues"))).toEqual([]);
    const due = mock({ issues: [tracked(f, "no-fix", "2026-01-01T00:00:00Z")] });
    await publish(options(due.transport, { apply: true, candidate: candidate({ after: [f] }) }));
    expect(
      due.calls.filter((c) => c.method === "PATCH" && c.path.endsWith("/issues/42")),
    ).toHaveLength(1);
    expect(due.calls.some((c) => c.path.includes("comments"))).toBe(false);
  });
  test("deduplicates new aliases within one run", async () => {
    const m = mock();
    await publish(
      options(m.transport, {
        apply: true,
        candidate: candidate({
          after: [finding, { ...finding, aliases: [...finding.aliases, "GHSA-abcd-abcd-abcd"] }],
        }),
      }),
    );
    expect(m.calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues"))).toHaveLength(
      1,
    );
  });
  test("scan failure is independent and never closes history or leaks exception", async () => {
    const m = mock({ issues: [tracked(finding)] });
    await publish(
      options(m.transport, {
        apply: true,
        mainScan: true,
        scannedTargets: ["source"],
        candidate: candidate({ status: "scan-failed", failure: "secret exploit details" }),
      }),
    );
    expect(JSON.stringify(m.calls)).toContain("scan-failed");
    expect(JSON.stringify(m.calls)).not.toContain("secret exploit details");
    expect(m.calls.some((c) => JSON.stringify(c.body ?? null).includes('"state":"closed"'))).toBe(
      false,
    );
  });
  test("only successful same-object main rescan closes source", async () => {
    const image = { ...finding, target: `sha256:${"a".repeat(64)}` };
    const m = mock({ issues: [tracked(finding), { ...tracked(image), number: 43 }] });
    await publish(
      options(m.transport, { apply: true, mainScan: true, scannedTargets: ["source"] }),
    );
    const closes = m.calls.filter((c) =>
      JSON.stringify(c.body ?? null).includes('"state":"closed"'),
    );
    expect(closes.map((c) => c.path)).toEqual(["/repos/owner/repo/issues/42"]);
  });
  test("report-only source cannot close audit issues; digest scan remains independent", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const m = mock({
      issues: [tracked(finding), { ...tracked({ ...finding, target: digest }), number: 43 }],
    });
    await publish(
      options(m.transport, {
        apply: true,
        mainScan: true,
        candidate: candidate({ toolVersion: "report-only" }),
        scannedTargets: ["source", digest],
      }),
    );
    expect(
      m.calls
        .filter((c) => JSON.stringify(c.body ?? null).includes('"state":"closed"'))
        .map((c) => c.path),
    ).toEqual(["/repos/owner/repo/issues/43"]);
  });
  test("coverage failure is not a clean Trivy scan", () => {
    expect(() => trivyFacts({ Results: [] }, undefined, "source")).toThrow();
    expect(() =>
      trivyFacts(
        { Results: [{ Packages: [{ Name: "example", Version: "1" }] }] },
        { components: [{ name: "missing", version: "1" }] },
        "source",
      ),
    ).toThrow();
    expect(
      trivyFacts(
        {
          Results: [
            {
              Packages: [{ Name: "example", Version: "1" }],
              Vulnerabilities: [
                { VulnerabilityID: "CVE-2026-12345", PkgName: "example", InstalledVersion: "1" },
              ],
            },
          ],
        },
        undefined,
        "source",
      ),
    ).toHaveLength(1);
  });
  test("paginates GitHub issues", async () => {
    const m = mock({
      handler: (c) =>
        c.path.includes("/issues?") &&
        new URL(c.path, "https://api.github.com").searchParams.get("page") === "1"
          ? Array.from({ length: 100 }, (_, number) => ({
              number,
              state: "open",
              body: "unmanaged",
            }))
          : undefined,
    });
    await publish(options(m.transport));
    expect(m.calls.some((c) => c.path.includes("/issues?") && c.path.includes("page=2"))).toBe(
      true,
    );
  });
  test("atomic publisher lock contention prevents all publication", async () => {
    const m = mock({
      handler: (c) => {
        if (c.method === "POST" && JSON.stringify(c.body).includes("publisher-lock"))
          throw new GitHubError(422);
      },
    });
    await expect(publish(options(m.transport, { apply: true }))).rejects.toThrow();
    expect(m.calls.some((c) => c.path.includes("/issues"))).toBe(false);
  });
  test("partial version remediation publishes PR and keeps residual issue", async () => {
    const residual = { ...finding, version: "0.9.0" };
    const c = candidate({
      before: [finding, residual],
      after: [residual],
      fixed: [finding],
      changedFiles: ["bun.lock"],
    });
    expect(effectiveFixes(c)).toEqual([finding]);
    const m = mock();
    await publish(
      options(m.transport, { apply: true, candidate: c, files: { "bun.lock": "fixed" } }),
    );
    expect(m.calls.some((call) => call.method === "POST" && call.path.endsWith("/pulls"))).toBe(
      true,
    );
    expect(
      m.calls.some(
        (call) =>
          call.method === "POST" &&
          call.path.endsWith("/issues") &&
          JSON.stringify(call.body).includes("0.9.0"),
      ),
    ).toBe(true);
  });
  test("matching existing PR tree and passed CI suppress duplicate PR and fixed issue", async () => {
    const c = candidate({ before: [finding], fixed: [finding], changedFiles: ["bun.lock"] });
    const files = { "bun.lock": "fixed" };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({ base: c.baseSha, files: Object.entries(files).sort(), fixes: [finding] }),
      )
      .digest("hex");
    const blob = createHash("sha1").update("blob 5\0fixed").digest("hex");
    const pull = {
      number: 9,
      state: "open",
      body: `<!-- security-publisher:pr:v1 -->\n<!-- evidence:${fingerprint} -->`,
      head: { sha: "b".repeat(40), ref: "security/dependency-fixes" },
      base: { ref: "main" },
    };
    const m = mock({
      pulls: [pull],
      handler: (call) => {
        if (call.path.includes("/git/trees/"))
          return {
            tree: [
              {
                path: "bun.lock",
                mode: "100644",
                type: "blob",
                sha: call.path.includes(baseSha) ? "old" : blob,
              },
            ],
          };
        return undefined;
      },
    });
    await publish(options(m.transport, { apply: true, candidate: c, files }));
    expect(
      m.calls.filter(
        (call) =>
          call.method !== "GET" &&
          (call.path.includes("/issues") ||
            call.path.includes("/pulls") ||
            call.path.includes("/git/blobs")),
      ),
    ).toEqual([]);
  });
  test("Trivy source closes only its own proven-absent finding", async () => {
    const issue = tracked(finding);
    issue.body = issue.body.replace('"updated":', '"origins":["trivy"],"updated":');
    const m = mock({ issues: [issue] });
    await publish(
      options(m.transport, {
        apply: true,
        mainScan: true,
        candidate: candidate({ toolVersion: "report-only" }),
        scannedTargets: ["source"],
      }),
    );
    expect(
      m.calls.some(
        (call) => call.method === "PATCH" && JSON.stringify(call.body).includes('"state":"closed"'),
      ),
    ).toBe(true);
  });
  test("main before prevents closing a finding fixed only in candidate after", async () => {
    const m = mock({ issues: [tracked(finding)] });
    await publish(
      options(m.transport, {
        apply: true,
        mainScan: true,
        candidate: candidate({ before: [finding], fixed: [finding] }),
      }),
    );
    expect(
      m.calls.some((call) => JSON.stringify(call.body ?? null).includes('"state":"closed"')),
    ).toBe(false);
  });
  test("Trivy multi-version fix text is accepted but never published", async () => {
    const f = {
      ...finding,
      fixVersion: "1.2.3, 2.0.0 secret-details",
      status: "unsafe raw scanner status",
    };
    const m = mock();
    await publish(options(m.transport, { apply: true, observations: [f] }));
    expect(JSON.stringify(m.calls)).not.toContain("secret-details");
    expect(JSON.stringify(m.calls)).not.toContain("unsafe raw scanner status");
  });
  test("real audit shape crosses publisher boundary and CVE aliases deduplicate Trivy", async () => {
    const [auditFinding] = parseAudit(
      JSON.stringify({
        example: [
          {
            id: 123,
            url: "https://github.com/advisories/GHSA-abcd-abcd-abcd",
            vulnerable_versions: "<1.0.1",
            severity: "high",
          },
        ],
      }),
      [{ alias: "alternate", package: "example", version: "1.0.0" }],
    );
    expect(auditFinding).toBeDefined();
    const transport: Transport = async <T>() =>
      ({
        identifiers: [
          { type: "GHSA", value: "GHSA-abcd-abcd-abcd" },
          { type: "CVE", value: "CVE-2026-12345" },
        ],
      }) as T;
    await resolveAdvisoryAliases([auditFinding!], transport);
    validateCandidate(candidate({ before: [auditFinding!] }));
    const m = mock();
    await publish(
      options(m.transport, {
        apply: true,
        candidate: candidate({ before: [auditFinding!], after: [auditFinding!] }),
        observations: [finding],
      }),
    );
    expect(
      m.calls.filter((call) => call.method === "POST" && call.path.endsWith("/issues")),
    ).toHaveLength(1);
  });
  test("independent scanner rescans close shared tracking only with same-main proofs", async () => {
    const issue = tracked(finding);
    issue.body = issue.body.replace('"updated":', '"origins":["audit","trivy"],"updated":');
    const first = mock({ issues: [issue] });
    await publish(options(first.transport, { apply: true, mainScan: true }));
    const pending = first.calls.find(
      (call) => call.method === "PATCH" && call.path.endsWith("/issues/42"),
    )?.body;
    if (
      !pending ||
      typeof pending !== "object" ||
      !("body" in pending) ||
      typeof pending.body !== "string" ||
      !("state" in pending)
    )
      throw new Error("Missing pending rescan transition");
    expect(pending.state).toBe("open");
    expect(pending.body).toContain("awaiting-other-rescan");
    const second = mock({ issues: [{ ...issue, body: pending.body }] });
    await publish(
      options(second.transport, {
        apply: true,
        mainScan: true,
        candidate: candidate({ toolVersion: "report-only" }),
        scannedTargets: ["source"],
      }),
    );
    expect(
      second.calls.some(
        (call) =>
          call.method === "PATCH" &&
          call.body !== null &&
          typeof call.body === "object" &&
          "state" in call.body &&
          call.body.state === "closed",
      ),
    ).toBe(true);
    const stale = pending.body.replace(baseSha, "c".repeat(40));
    const third = mock({ issues: [{ ...issue, body: stale }] });
    await publish(
      options(third.transport, {
        apply: true,
        mainScan: true,
        candidate: candidate({ toolVersion: "report-only" }),
        scannedTargets: ["source"],
      }),
    );
    expect(
      third.calls.some(
        (call) =>
          call.method === "PATCH" &&
          call.body !== null &&
          typeof call.body === "object" &&
          "state" in call.body &&
          call.body.state === "closed",
      ),
    ).toBe(false);
  });
});
