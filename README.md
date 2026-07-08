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

Your team lives in GitHub and chats in Feishu / Lark. Every push, PR, issue, release, star, fork — you want a timely heads-up in the group chat. The existing options are either a rigid GitHub Action, a pure CLI, or a SaaS that doesn't let you own your data or your routing rules. None of them give you a **configurable pipeline** *and* a **visual admin UI** in one self-hosted box.

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

- **Webhook in, notifications out.** Verify GitHub's HMAC-SHA256 signature against the raw body, parse the event, run it through a configurable middleware pipeline, render a template, and dispatch.
- **Multi-channel by design, not by accident.** A `ChannelAdapter` interface is the only thing a new channel needs to implement. Feishu is the first adapter; the routing and config layer is channel-agnostic.
- **Configure without redeploying.** A built-in admin UI (React + Vite + Tailwind) edits routes, channels, and templates against a REST API — backed by `bun:sqlite`. No YAML round-trips to adjust a rule.
- **One image, one process.** Ships as a single Bun process that serves the API *and* the built frontend. One Docker container, one volume for data.

## 5-minute tour

*(Pipeline is under construction — commands below show the intended UX.)*

```bash
# Run locally
bun install
cp .env.example .env       # set GITHUB_WEBHOOK_SECRET
bun run dev                # server on :3000, frontend on :5173 (Vite proxy)

# Or, self-host with Docker
docker compose up -d       # serves API + built frontend on :3000
```

Then point a GitHub webhook at `https://your-host/webhook`, add a Feishu custom-bot webhook as a channel in the admin UI, and add a route. Done.

## How it's different

| | GitHub Action / raw webhook | SaaS notifier | **notify-bus** |
|---|---|---|---|
| **Self-hosted / own your data** | ✅ | ❌ | ✅ |
| **Configurable pipeline** | ❌ (recode to change) | partial | ✅ Filter / Enricher / Template |
| **Visual admin UI** | ❌ | ✅ | ✅ |
| **Multi-channel** | manual per channel | per-plan limits | ✅ `ChannelAdapter` interface |
| **Templates per event** | hardcoded | limited | ✅ Handlebars, per event type |
| **License** | varies | proprietary | ✅ MIT |

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

Two config sources, merged at runtime:
- **YAML** (`config.yaml`) — seed/bootstrap config, human-edited, supports hot reload.
- **SQLite** (`data.db`) — the source of truth for routes, channels, templates, logs; edited via the admin UI / REST API.

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

🟡 **Early development.** Scaffold + governance are in place; the core pipeline lands in M1. This is the right moment to shape the direction — join [Discussions](https://github.com/lorelum/notify-bus/discussions).

## Contributing

We welcome contributors. notify-bus is **MIT-licensed** — no CLA, no open-core split. Fork it, ship it, use it.

- 📖 Read [**CONTRIBUTING.md**](./CONTRIBUTING.md) for the development workflow (issue-driven + design-first)
- 🤖 Using an AI coding assistant? Also read [**AGENTS.md**](./AGENTS.md)
- 💬 Drop by [Discussions](https://github.com/lorelum/notify-bus/discussions) to say hi or propose ideas
- 🐛 Found a bug? [Open an issue](https://github.com/lorelum/notify-bus/issues/new/choose)

## License

**MIT** — see [LICENSE](./LICENSE). The entire codebase (server, pipeline, adapters, admin frontend) is MIT-licensed. No dual licensing, no CLA.
