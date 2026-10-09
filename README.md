<p align="center">
  <h1 align="center">notify-bus</h1>
  <p align="center">Self-hostable multi-channel notification bus. GitHub webhooks in, Feishu (and more) out.</p>
  <p align="center">
    <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue"></a>
    <a href="https://github.com/lorelum/notify-bus"><img alt="Status" src="https://img.shields.io/badge/status-early%20development-orange"></a>
    <a href="./CONTRIBUTING.md"><img alt="Contributing" src="https://img.shields.io/badge/contributions-welcome-brightgreen"></a>
  </p>
  <p align="center">
    <a href="./README.md">English</a> ·
    <a href="./README.zh-CN.md">简体中文</a>
  </p>
</p>

---

> ⚠️ **notify-bus is in early development.** The scaffold is up; the core pipeline is being built milestone by milestone. Star to follow, or jump into [CONTRIBUTING.md](./CONTRIBUTING.md) / [Discussions](https://github.com/lorelum/notify-bus/discussions).

## The problem

Your team lives in GitHub and chats in Feishu / Lark. Every push, PR, issue, release, star, fork — you want a timely heads-up in the group chat. The existing options are either a rigid GitHub Action, a pure CLI, or a SaaS that doesn't let you own your data or your routing rules. None of them give you a **configurable pipeline** _and_ a **visual admin UI** in one self-hosted box.

## How notify-bus does it

```
[GitHub] ──webhook──▶ [Bun + Elysia server]
                          │
                          ▼
                    [Pipeline: Filter → Enricher → Template → ...]
                          │
                          ▼
                    [Dispatcher] ──route match──▶ [Channel Adapter] ──▶ [Feishu / Lark API]
                                                    ▲
                                                    │  ChannelAdapter interface
                                                    │  (Feishu today; Slack / DingTalk / WeCom / Discord next)
```

- **Webhook in, notifications out.** Verify GitHub's HMAC-SHA256 signature against the raw body, match the event against your routes, render the configured template, and dispatch it to the channel's adapter. _(The configurable middleware pipeline — Filter / Enricher / Template — is the M2 milestone and is not built yet.)_
- **Multi-channel by design, not by accident.** A `ChannelAdapter` interface is the only thing a new channel needs to implement. Feishu is the first adapter; the routing and config layer is channel-agnostic.
- **Configure without redeploying.** Today a rule change means editing `config.yaml` and restarting the process. _(M3)_ A built-in admin UI (React + Vite + Tailwind) will edit routes, channels, and templates against a REST API backed by `bun:sqlite`.
- **One image, one process.** Ships as a single Bun process that serves the API _and_ the built frontend. One Docker container, one volume for data. The repo is a Bun workspace monorepo (`packages/server` + `packages/web`) that builds into that one image.

## 5-minute tour

_(The steps below work today: GitHub webhooks in, Feishu cards out. The configurable middleware pipeline is M2 and not built yet.)_

```bash
# Run locally
bun install                # installs all workspace packages
cp .env.example .env       # set GITHUB_WEBHOOK_SECRET
bun run dev                # server on :3000, frontend on :5173 (Vite proxy)

# Or, self-host with Docker
docker compose up -d       # serves API + built frontend on :3000
```

Then point a GitHub webhook at `https://your-host/webhook`, add a Feishu custom-bot webhook as a channel plus a route in `config.yaml`, and restart notify-bus — the config is read at startup.

## How it's different

|                                 | GitHub Action / raw webhook | SaaS notifier   | **notify-bus**                       |
| ------------------------------- | --------------------------- | --------------- | ------------------------------------ |
| **Self-hosted / own your data** | ✅                          | ❌              | ✅                                   |
| **Configurable pipeline**       | ❌ (recode to change)       | partial         | 🚧 M2 — Filter / Enricher / Template |
| **Visual admin UI**             | ❌                          | ✅              | 🚧 M4–M6                             |
| **Multi-channel**               | manual per channel          | per-plan limits | ✅ `ChannelAdapter` interface        |
| **Templates per event**         | hardcoded                   | limited         | ✅ Handlebars, per event type        |
| **License**                     | varies                      | proprietary     | ✅ MIT                               |

## Architecture (in brief)

```
┌────────────────────────────────────────────────────────────┐
│  GitHub ──POST /webhook──▶  Bun + Elysia server            │
│                              │                              │
│              ┌───────────────┴───────────────┐              │
│              ▼                               ▼              │
│   signature verify (raw body)        EventMessage parse     │
│              │                               │              │
│              └───────────────┬───────────────┘              │
│                              ▼                              │
│                   Pipeline (middleware chain)               │
│                   Filter → Enricher → Template              │
│                              │                              │
│                              ▼                              │
│                  Dispatcher (route match)                   │
│                              │                              │
│              ┌───────────────┼───────────────┐              │
│              ▼               ▼               ▼              │
│         Feishu           (Slack)         (DingTalk)         │
│         adapter          adapter stub     adapter stub      │
│                                                              │
│   Admin UI (React) ──/api/*──▶ Config (bun:sqlite + YAML)   │
└────────────────────────────────────────────────────────────┘
```

Configuration comes from `config.yaml` today:

- **YAML** (`config.yaml`) — the only config source. Routes, channels and templates are read from it at startup, so an edit needs a restart; there is no hot reload yet.
- **Environment** — `${NAME}` inside that file's values is expanded from the environment after parsing, so a deployment can keep the routing policy in a reviewed file while credentials stay in the environment it injects (#41).
- **SQLite** (`data.db`) — _(M3)_ where routes, channels, templates and logs will live, edited through the admin UI / REST API, with the store winning over the YAML seed.

Feishu push cards can show net added/deleted lines for a normal push to an existing branch.
Set `GITHUB_API_TOKEN` in the server environment to enable this: use a token with
**Contents: read** access to the repositories being notified. This is separate from
`GITHUB_WEBHOOK_SECRET`, which verifies incoming webhooks. See `.env.example` and
`docker-compose.yml`; after changing container environment variables, recreate the
container with `docker compose up -d --force-recreate notify-bus`. Without the token,
or if the comparison is unavailable, the notification still sends without line counts.
New/deleted branches and force pushes omit these counts; PR statistics are unchanged.

## Application bot comment threads (optional)

`feishu_app` is a separate outbound-only channel; keep `feishu` webhook channels
for push/Issue/PR/release cards. It needs no callback URL, event subscription,
GitHub API token, contacts lookup or group-history access.

1. Create a Feishu enterprise self-built app, enable **Bot**, and request
   **im:message:send_as_bot** only. Publish it / obtain administrator approval,
   make it available to the intended members, and add the bot to the target group.
2. Set `FEISHU_APP_SECRET` in the server environment. Enable the commented
   `feishu_app` channel and comment route in `config.example.yaml`, using your
   app ID, target chat ID, and GitHub-login → **open_id** (`ou_...`) mapping.
   IDs are application-specific; webhook `user_id` values are not interchangeable.
   `app_secret` must be `${FEISHU_APP_SECRET}` (or another environment placeholder),
   not plaintext YAML. Token/secret are never stored in the topic database.
3. Subscribe GitHub to the desired comment events. Use `match_action: created`
   and **omit `mention_only`** so later unmentioned comments are not filtered out.
   Restart after configuration changes; inject the secret into the container
   environment and recreate the container if changing that environment.

Comment notifications use text (not interactive cards or extra templates).
The first effective @ activates a topic; later comments reply to that root,
including no-@ comments and subsequent mentions. Mentions retain #36's mapped
**author** requirement, case-insensitive logins, person deduplication and five-person
limit. An unmapped author can still reply to an existing topic but cannot generate
new real mentions. Without a topic or effective @, a created comment sends a
regular top-level text message without activating a topic. Edited/deleted comments
are not sent. PR conversation and inline comments share the repository/PR topic.

Roots and comment receipts live in `DATA_DIR/notify-bus.db`, namespaced by app,
chat, repository and Issue/PR number. Persist the data directory across restarts.
Closing an Issue/PR does not delete its root. There is no automatic retention
cleanup in this version; back up the database and monitor its growth. Changed app
or chat IDs deliberately use a new namespace. Replies always request thread mode.
If the root is deleted, the bot is removed, or the group rejects threads (230071),
delivery returns a typed failure and logs a credential-free diagnostic; it does
**not** silently send a replacement top-level message.

Token requests are cached and refreshed 60 seconds before expiry. Calls have a
five-second timeout. Per-topic serialization and durable comment receipts prevent
ordinary concurrent/redelivered duplicates in **one server process**; deterministic
API UUIDs assist retry deduplication. Remote sending and local persistence are not
an atomic transaction, so this is not a cross-instance exactly-once guarantee.
No distributed locking or automatic replay queue is implemented.

Platform behavior was tested with text in an ordinary group on 2026-10-09:
thread replies and subsequent mentions work. Notification strength/automatic
following depends on individual Feishu settings, not a promise to notify everyone.
Topic-mode groups and interactive-card thread presentation are not verified.

## Roadmap

Built in the open, milestone by milestone. Each milestone is one issue + one PR.

- **M1** — Core webhook ingestion + GitHub signature verification + Feishu adapter (with signing) + fallback route. YAML-only, no frontend.
- **M2** — Middleware pipeline: Filter, Enricher, Template (Handlebars). Order + enable/disable configurable.
- **M3** — `bun:sqlite` persistence (routes/channels/templates/logs) + REST API (CRUD) + Config Manager (YAML↔DB merge, hot reload).
- **M4** — Frontend skeleton + Routes management page (Eden treaty wired up).
- **M5** — Channels management (with connection test) + Template editor (Monaco + live preview).
- **M6** — Logs page + test-send (`POST /api/test`).
- **M7** — Integration tests, docs polish, Docker image hardening, tag `v0.1`.

See [Discussions](https://github.com/lorelum/notify-bus/discussions) for what's being worked on right now.

## Project status

🟡 **Early development.** The M1 chain works end to end — GitHub webhooks in, Feishu cards out. The configurable middleware pipeline (M2) is not built yet. This is the right moment to shape the direction — join [Discussions](https://github.com/lorelum/notify-bus/discussions).

## Contributing

We welcome contributors. notify-bus is **MIT-licensed** — no CLA, no open-core split. Fork it, ship it, use it.

- 📖 Read [**CONTRIBUTING.md**](./CONTRIBUTING.md) for the development workflow (issue-driven + design-first)
- 🤖 Using an AI coding assistant? Also read [**AGENTS.md**](./AGENTS.md)
- 💬 Drop by [Discussions](https://github.com/lorelum/notify-bus/discussions) to say hi or propose ideas
- 🐛 Found a bug? [Open an issue](https://github.com/lorelum/notify-bus/issues/new/choose)

## License

**MIT** — see [LICENSE](./LICENSE). The entire codebase (server, pipeline, adapters, admin frontend) is MIT-licensed. No dual licensing, no CLA.
