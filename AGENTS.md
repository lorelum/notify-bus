# AGENTS.md

> This file tells AI coding agents how to work **in this specific repo**. Humans: see [CONTRIBUTING.md](./CONTRIBUTING.md) for the human workflow. If you're using an AI assistant, point it at this file.

## Project

notify-bus is a self-hostable, multi-channel notification bus. It ingests GitHub webhooks, runs them through a configurable middleware pipeline, and dispatches rendered messages to channel adapters (Feishu first; Slack / DingTalk / WeCom / Discord to follow). This repo holds the server, pipeline, adapters, admin frontend, and format spec.

The codebase is **Bun + TypeScript**, organized as a **Bun workspace monorepo** (`packages/*`). One `package.json` at the root declares `workspaces: ["packages/*"]`; a single `bun install` installs every package. No turborepo — two packages with independent tasks don't need it.

The product contract to be aware of:
- **`ChannelAdapter` interface** (`packages/server/src/lib/adapters/types.ts`) — every channel implements it. Breaking it breaks every adapter.
- **Pipeline / middleware interface** — the `(event, next) => void` shape. Changes ripple to every middleware.
- **`EventMessage` type** (`packages/server/src/types.ts`) — the internal event representation everything else reads/writes.
- **REST API** (`/api/*`) — the frontend and any external automation depend on it.
- **Webhook contract** (`POST /webhook`) — GitHub sends to this; the raw-body capture for signature verification is security-critical.

## Layout

```
notify-bus/
├── package.json              # root: workspaces: ["packages/*"], aggregate scripts
├── tsconfig.base.json        # shared strict TS options
├── tsconfig.json             # project references -> packages/server + packages/web
├── packages/
│   ├── server/               # @notify-bus/server — Bun + Elysia (run natively)
│   │   ├── package.json
│   │   ├── tsconfig.json     # extends ../../tsconfig.base.json
│   │   └── src/
│   │       ├── index.ts      # Elysia entry: webhook + /api + static(web/dist) + /health
│   │       ├── routes/
│   │       │   ├── webhook.ts    # POST /webhook — ★ raw body must be captured before JSON parse
│   │       │   ├── health.ts
│   │       │   └── api/          # /api/routes /channels /templates /logs
│   │       ├── lib/
│   │       │   ├── verify/
│   │       │   │   └── github.ts # HMAC-SHA256, constant-time compare
│   │       │   ├── pipeline/     # middleware chain
│   │       │   ├── adapters/
│   │       │   │   ├── types.ts  # ★ ChannelAdapter interface
│   │       │   │   └── feishu.ts # Feishu adapter (signing: timestamp\nsecret as HMAC key, empty msg, base64)
│   │       │   ├── config/       # YAML + sqlite load + merge
│   │       │   └── db/
│   │       │       ├── schema.ts # routes / channels / templates / logs
│   │       │       └── index.ts  # bun:sqlite, WAL + busy_timeout + synchronous=NORMAL
│   │       └── types.ts          # EventMessage etc.
│   └── web/                  # @notify-bus/web — React + Vite + Tailwind admin frontend
│       ├── package.json      # devDep @notify-bus/server (workspace:*) for M4 Eden types
│       ├── tsconfig.json     # extends ../../tsconfig.base.json
│       ├── vite.config.ts
│       └── src/              # dist/ is gitignored (built by `bun run build:web`)
├── config.example.yaml       # seed config sample
├── Dockerfile                # multi-stage, oven/bun:1.3, single workspace install
├── docker-compose.yml        # mounts ./data (directory, not single .db — WAL sidecars)
└── .github/workflows/ci.yml
```

## Commands

- **Runtime:** Bun ≥ 1.3 (TypeScript support is built in — no separate `tsc`/Node install needed)
- **Install deps:** `bun install` (installs all workspace packages)
- **Dev (server + frontend):** `bun run dev`
- **Dev server only:** `bun run dev:server`
- **Dev frontend only:** `bun run dev:web`
- **Test:** `bun test` (uses `bun:test`, runs from root)
- **Lint:** `bun run lint` (oxlint, covers both packages)
- **Format:** `bun run fmt` (oxfmt)
- **Typecheck:** `bun run typecheck` (`tsc -b` — project references, covers both packages)
- **Build:** `bun run build` (builds the frontend; server runs TS natively)
- **Start (prod):** `bun run start`

## Code style

TypeScript is the language; Bun runs it. These rules apply from day one.

- **Strict mode.** `tsconfig.json` has `strict: true`. No `any` without justification; if unavoidable, mark `// @ts-expect-error: <reason>` (reason required). `EventMessage.payload` is the one sanctioned `Record<string, unknown>` (raw GitHub data).
- **Naming.** `PascalCase` for types/interfaces/classes, `camelCase` for functions/variables. Apply uniformly.
- **Small, composable modules.** Prefer pure functions. Adapters and middlewares are the composable units.
- **Typed errors over bare strings.** Throw specific error types; let the route layer translate them into HTTP responses. Never throw a bare string.
- **No silent failures.** A function that can fail should signal it explicitly (typed error, Result, or similar) — not return `null` and hope.

## Security-critical rules (read these twice)

1. **GitHub webhook signature = HMAC-SHA256 over the *raw request body*.** The raw bytes must be captured *before* any JSON parsing. Never `JSON.parse` then `JSON.stringify` and re-sign — byte ordering/whitespace diverges and verification fails. Compare with constant-time equality. See `packages/server/src/routes/webhook.ts` for the capture hook.
2. **Feishu signing is counter-intuitive.** The HMAC *key* is `timestamp + "\n" + secret`, the *message* is empty, output is base64. The message body is never part of the signature. There is a known-good test vector — keep it green.
3. **`GITHUB_WEBHOOK_SECRET` lives only in an env var.** Never persist it to the DB, config file, or logs.
4. **Channel credentials (webhook URLs, signing secrets) are stored in the config DB.** The admin API returns webhook URLs partially masked; full values are write-only over the API.
5. **No auth in v1.** notify-bus assumes deployment behind a reverse proxy / private network. Treat `/api/*` as privileged.

## Testing

- New code ships with tests. No exceptions for the webhook verification, pipeline, adapter, and signature paths.
- Test framework is `bun:test`. Test files are `*.test.ts`, colocated next to the source they cover.
- **Mock network and the filesystem** — never hit the real Feishu API or a real GitHub webhook in unit tests. The Feishu signer has a known-good vector test.
- **Mock the clock** for anything involving `timestamp` (Feishu signing).
- When fixing a bug, add a regression test that fails before the fix and passes after.

## Git workflow

- **Never commit directly to `main`.** Every change goes through a PR.
- **One issue per PR.** Keep PRs focused and reviewable. If a change spans multiple issues, split it.
- **Conventional Commits** (`feat(adapter): ...`, `fix(webhook): ...`, `docs: ...`).
- **Every PR links to an issue** (`Closes #123`).
- **Behavioral changes need design discussion first** — open an issue or Discussion before implementing changes to the `ChannelAdapter` interface, pipeline interface, `EventMessage`, or the REST API.

## Boundaries

**Do not modify these without explicit maintainer approval:**
- `LICENSE` — license file. Changes are legal events, not code edits.
- `package.json` top-level `license` field.
- `.github/workflows/` release/publish steps (none yet — releases are CI-only when added).

**Do not run:**
- Any package-publish command (e.g. `bun publish`, `npm publish`) — releases are CI-only.
- Anything that posts to a real Feishu group or a real GitHub webhook without approval.

**Be careful with:**
- Bumping dependencies — Elysia in particular has shipped breaking changes between minor versions and a CVE in the 1.4 line. Pin to the locked version; test before bumping.
- Editing the `ChannelAdapter` interface or `EventMessage` type — they're public contracts to adapters and middlewares. Spec/design discussion first.

## Where to look

- **Product understanding:** `README.md` (overview) and `CONTRIBUTING.md` (workflow).
- **The roadmap:** the M1–M7 milestones in `README.md`, mirrored as GitHub issues.
- **Planning a feature?** Open a Discussion or issue before implementing — product-surface changes (adapter interface, pipeline, API) need alignment first.

## When in doubt

If a task is ambiguous, **open a Draft PR or ask in Discussions** rather than guessing. notify-bus's product surface is the pipeline + adapter contract + API — getting those right matters more than speed.
