# Security Policy

## Supported Versions

notify-bus is in active early development. Security fixes are applied to the latest `main` branch only — there are no stable release lines yet.

| Version         | Supported |
| --------------- | --------- |
| `main`          | ✅        |
| tagged releases | ✅        |

## Reporting a Vulnerability

**Please do NOT report undisclosed security vulnerabilities via public GitHub issues.**

Report them privately instead:

- 📧 Email: **security@lorelum.com**
- 🔒 Preferred: use [GitHub's private vulnerability reporting](https://github.com/lorelum/notify-bus/security/advisories/new)

Include the following if possible:

- A description of the issue and its potential impact
- Steps to reproduce (PoC, screenshots, or logs)
- Affected versions / commits
- Suggested fix (optional)

### Response timeline

| Step                | Target                                                    |
| ------------------- | --------------------------------------------------------- |
| Acknowledge receipt | within 48 hours                                           |
| Initial assessment  | within 5 business days                                    |
| Fix or mitigation   | depends on severity; we'll coordinate disclosure with you |

We follow **coordinated disclosure**. Once a fix is released, we'll credit you in the advisory unless you prefer to remain anonymous.

Public dependency-maintenance issues and PRs may reference already-public GHSA,
CVE, or upstream advisory identifiers, affected package versions, image digests,
owners, and remediation status. This exception does not permit publishing new
vulnerabilities, exploit details, private reports, credentials, or raw scanner
errors. Send undisclosed findings through the private channels above.

## Scope

**In scope:**

- The notify-bus server, webhook ingestion, and pipeline in this repository
- The admin frontend served by this repository
- Security issues in GitHub webhook signature verification, the pipeline, or channel adapters
- SQL injection or credential-storage issues in the config layer (`bun:sqlite`)
- Secrets leaking into logs or responses

**Out of scope:**

- Vulnerabilities in third-party dependencies (report to the upstream maintainer)
- Issues caused by deploying without the recommended network isolation (notify-bus v1 ships no auth; see [CONTRIBUTING.md](./CONTRIBUTING.md))
- Social engineering, physical attacks, DoS

## Security design notes

notify-bus is **self-hosted and ships without authentication in v1**. It assumes deployment behind a reverse proxy or on a private network. Treat the admin API as privileged — anyone who can reach `/api/*` can read and edit channels (including webhook URLs and secrets) and routes.

Sensitive values to be aware of:

- **`GITHUB_WEBHOOK_SECRET`** — the HMAC secret for verifying GitHub webhook deliveries. Stored in an environment variable, never in the DB or config file.
- **Channel credentials** (e.g. Feishu webhook URLs and signing secrets) — stored in the config DB. The admin API returns webhook URLs partially masked; full values are write-only via the API.
- **Webhook raw body** — GitHub signatures are computed over the _exact raw request bytes_. The pipeline captures the raw body before any JSON parsing; do not re-serialize and re-sign.

## Dependency vulnerability management

The security-only writer is `Security remediation`. It uses exactly Bun 1.4.4
for `bun audit` and `bun audit fix`, independently of the application's runtime
version. It never runs `bun update`, `audit fix --latest`, routine dependency
updates, or periodic lockfile maintenance. There is no OSV integration.

Scanning and repair run without PR/Issue write credentials. Publication is a
separate job; it defaults to a read-only dry run until explicitly enabled.
Only advisory-backed repairs and required resolution changes belong in a
candidate. A nonzero repair exit code can mean residual vulnerabilities:
successful partial repairs must remain reviewable, not be discarded.

Trivy findings are independent detection input, never `audit fix` input.
OS packages, the Bun runtime, and Trivy-only npm findings require a maintainer
when Bun cannot remediate them. No automatic merge or deployment is performed.

### Reports and coverage

- `Dependency security` scans the root `bun.lock` on PRs, main pushes, weekly on
  Monday at 06:23 UTC, and manual runs. Development, build, browser, and server
  dependencies are all included.
- `scripts/security-inventory.ts` generates a temporary CycloneDX inventory of
  every unique registry package/version in the lockfile, including nested and
  bundled versions. Trivy 0.76.2's native Bun analysis omitted three such versions
  in the initial inventory, so scanning the lockfile natively is not sufficient.
  This inventory is not a second lockfile and is not submitted to GitHub.
- Trivy scans that inventory, and `scripts/security-report.ts` verifies that every
  inventoried package/version appears in its report. Missing coverage is an error.
  Non-registry sources other than local workspaces fail inventory generation
  rather than being silently omitted.
- CI exports its existing PR image build to a Docker archive for scanning.
  Main scans the published image by the digest returned by that same build.
  Neither path adds another image build. The main scan happens after publication;
  it is not a pre-publication security gate.
- Source inventory findings do not prove that a dependency is installed in the
  runtime image or exploitable. The final-image report separately covers actual
  installed packages and the base OS. Browser bundles and build-time dependencies
  still need the source inventory.

At base `4e430f9057f59c976b41da77a7ea04d94d36de19`, the recorded
`dependency-security` artifact (13665560888) inventoried the same 200 unique
package versions as the root lockfile. Its 18 Trivy findings matched the current
18 Bun audit findings after resolving GHSA/CVE aliases through GitHub's public
advisory API. This compares a historical Trivy database with the current registry;
it is not proof of equal detection coverage. Bun's audit JSON does not expose
its submitted package inventory. Keep the CycloneDX/Trivy path and its coverage
check; equal finding counts alone do not justify removing it.

Reports are JSON artifacts and job summaries, not GitHub Code scanning alerts.
All severities and vulnerabilities without fixes remain visible. Initially,
findings are report-only, including historical HIGH/CRITICAL findings. Tool,
database, registry, malformed input, and coverage failures fail the job; they are
not treated as a clean scan. No blanket `continue-on-error` or vulnerability
ignore list is used.

### Repair and tracking lifecycle

- `Security remediation` runs only on main pushes, weekly, and manually. Its
  separate `workflow_run` path consumes main-only dependency/image scan artifacts;
  it never executes downloaded code or grants PR code a publisher credential.
- Local candidates live in ignored `security-reports/`, with `candidate.json`,
  raw command evidence, base commit, exact tool version, before/after findings,
  and allowlisted `candidate-files/`. The source tree is unchanged. Dirty
  dependency files relative to the base commit are rejected, not incorporated.
- Publication requires successful scans, a real successful candidate `make ci`,
  advisory-backed fixes, and the same current main SHA. One managed
  `security/dependency-fixes` PR is updated without force pushes. Missing or
  failing GitHub CI remains visible and never counts as a valid completed fix.
- Public tracking deduplicates advisory aliases plus package and source/image
  object. GHSA aliases are resolved using GitHub's public advisory identifiers.
  A failed alias lookup is a scan fault, not a clean result. Digest records stay
  separate from source records.
- An existing verified PR with successful GitHub checks suppresses duplicate
  tracking for its repairs; residual versions, blocked constraints, unavailable
  fixes, and CI failures remain owner-action issues. New PRs awaiting checks
  remain tracked. Only first discovery, status changes, or 14-day overdue
  maintenance update issue bodies; scans do not post repeated comments.
- Issues close only after a successful current-main rescan proves absence for
  every recorded scanner source and the same object. Candidate `after` findings
  never prove main is fixed. Main repairs do not close vulnerable digest records.
  Scanner failures do not close historical findings.
- Writes are serialized with a dedicated Git ref lock. A crashed publisher fails
  closed. The maintainer must inspect the failed run, confirm no publisher is
  active, and only then remove `refs/heads/security/publisher-lock` before rerun.
  Scanner-failure issues require maintainer attention; do not dismiss them merely
  because a different scanner or digest succeeded.

### Published-image rescans

The `published-images` matrix in `.github/workflows/security.yml` is the explicit
list of supported image digests to rescan. Its initial entry comes from successful
CI run [38747928246](https://github.com/lorelum/notify-bus/actions/runs/38747928246),
commit `8ecab4fefbc044acc1721e804b4436db63f29bef`. Maintain this list deliberately
when supported releases change; it is not an inventory of production deployments.
CI records new published digest references in the `final-image-security` artifact.

Weekly/manual rescans pull those existing digests without rebuilding. A manual
run on main can supply `image_digest` as `sha256:` followed by 64 lowercase hex
characters to scan a specific notify-bus release. Tags and arbitrary image URLs
are rejected. For private GHCR packages, grant this repository Actions read access
to the package; the scan uses its job-scoped `GITHUB_TOKEN` with `packages: read`.
No PAT or production credentials are required. Missing access or a deleted image
is a scan failure.

### Enabling and reviewing fixes

1. Run the local candidate command and review its reports without publishing:
   `bun scripts/security-audit.ts --base-sha <full-main-commit>`.
   Run the publisher without `--apply` for a read-only reconciliation plan.
2. Before enabling writes, disable the hosted Renovate App for this repository
   and resolve any outstanding Renovate branches. Removing `renovate.json`
   does **not** disable an installed App. Do not run two lockfile writers.
3. Install a dedicated GitHub App on this repository with Contents, Pull requests,
   and Issues write access and Checks read access. Set `SECURITY_APP_ID` (Actions
   variable) and `SECURITY_APP_PRIVATE_KEY` (secret). Set `SECURITY_OWNER` to an
   individual maintainer login assignable in this repository, not an organization.
   Only the publisher job receives the installation token. Set
   `SECURITY_AUTOMATION_ENABLED=true` only after reviewing a successful dry run
   and the repository's PR policies.
4. Confirm the App-created PR actually triggers existing CI, receives required
   checks, and can assign the configured owner. App tokens can trigger workflows
   automatically; repository `GITHUB_TOKEN` PR events may require manual workflow
   approval. Local transport tests do not prove installation permissions.
5. Review the manifest/root lockfile diff, frozen install, and `make ci` results.
   Exercise webhook signatures, escaping/rendering, and notification failure
   boundaries using synthetic secrets and local/mocked receivers, never a real
   group webhook. Merge manually.

The repository does not configure App installation, branch protection, deployment
permissions, or notification delivery settings. Those are external rollout
requirements, not effects of merging these files. A fix on main is not evidence
that a vulnerable published digest has been replaced in any deployment.

References: [Bun audit](https://bun.sh/docs/pm/cli/audit),
[Bun 1.4.4](https://bun.sh/blog/bun-v1.4.4), and
[GitHub workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

Do not downgrade the Bun lockfile, add another package manager's lockfile, enable
ordinary upgrades to work around a security-update limitation, or enable automatic
merging. No workflow here changes GitOps/deployments or synchronizes secrets.
