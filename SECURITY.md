# Security Policy

## Supported Versions

notify-bus is in active early development. Security fixes are applied to the latest `main` branch only — there are no stable release lines yet.

| Version         | Supported |
| --------------- | --------- |
| `main`          | ✅        |
| tagged releases | ✅        |

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities via public GitHub issues.**

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

Renovate is configured in `renovate.json` for security fixes only. Routine version
updates, automatic merging, Dependency Dashboard issues, and periodic lockfile
maintenance are disabled. Only the Bun manager is enabled. OSV provides an
independent vulnerability input; GitHub Dependabot alerts can also be consumed
without enabling Dependabot's own security-update PRs.

This is limited automation, not a guarantee that every vulnerable dependency
will get a PR. In Renovate 44.220.0, the Bun manager does not extract the complete
lockfile dependency graph or consistently use locked versions for version ranges.
Dependencies it cannot remediate still require manual security fixes.

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

Reports are JSON artifacts and job summaries, not GitHub Code scanning alerts.
All severities and vulnerabilities without fixes remain visible. Initially,
findings are report-only, including historical HIGH/CRITICAL findings. Tool,
database, registry, malformed input, and coverage failures fail the job; they are
not treated as a clean scan. No blanket `continue-on-error` or vulnerability
ignore list is used.

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

1. Merge the configuration through the normal reviewed PR workflow; do not enable
   interactive Renovate operation before the security-only config is on main.
2. Keep the hosted App in Scan Only until its logs confirm ordinary updates are
   disabled and any proposed updates have real vulnerability identifiers.
3. A maintainer may then switch to interactive operation. The App mode and GitHub
   security settings are not changed by this repository configuration.
4. Review each security PR's manifest and root lockfile changes, frozen install,
   and existing `make ci` results. Exercise raw-body webhook signatures, request
   handling, template escaping/rendering, and notification success/failure
   boundaries using synthetic secrets and local/mocked receivers. Never use a real
   group webhook to validate an upgrade.
5. Merge manually. Scanner results alone do not establish compatibility. OS/Bun
   runtime and unsupported transitive-dependency fixes may need manual PRs.

Do not downgrade the Bun lockfile, add another package manager's lockfile, enable
ordinary upgrades to work around a security-update limitation, or enable automatic
merging. No workflow here changes GitOps/deployments or synchronizes secrets.
