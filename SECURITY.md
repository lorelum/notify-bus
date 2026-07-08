# Security Policy

## Supported Versions

notify-bus is in active early development. Security fixes are applied to the latest `main` branch only — there are no stable release lines yet.

| Version | Supported |
|---------|-----------|
| `main`  | ✅        |
| tagged releases | ✅ |

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

| Step | Target |
|------|--------|
| Acknowledge receipt | within 48 hours |
| Initial assessment | within 5 business days |
| Fix or mitigation | depends on severity; we'll coordinate disclosure with you |

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
- **Webhook raw body** — GitHub signatures are computed over the *exact raw request bytes*. The pipeline captures the raw body before any JSON parsing; do not re-serialize and re-sign.
