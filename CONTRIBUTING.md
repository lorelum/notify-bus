# Contributing to notify-bus

Thanks for your interest in contributing to notify-bus! This doc explains how we work — the workflow, the conventions, and what to expect.

> 🤖 **Using an AI coding assistant (Cursor / Claude Code / Codex)?** Also read [**AGENTS.md**](./AGENTS.md) — it tells the agent how to work *in this specific repo* (commands, layout, boundaries). This doc is for humans; AGENTS.md is for machines.

---

## Table of contents

- [Code of Conduct](#code-of-conduct)
- [Development environment](#development-environment)
- [How we work: issue-driven, design-first](#how-we-work-issue-driven-design-first)
- [Reporting bugs & proposing features](#reporting-bugs--proposing-features)
- [Development workflow](#development-workflow)
- [Commit conventions](#commit-conventions)
- [PR titles](#pr-titles)
- [Testing & CI](#testing--ci)
- [AI-assisted contributions](#ai-assisted-contributions)
- [Becoming a maintainer](#becoming-a-maintainer)

---

## Code of Conduct

Everyone participating in notify-bus is expected to follow our [Code of Conduct](./CODE_OF_CONDUCT.md). Be kind, assume good intent, and keep discussions technical.

## Development environment

**Prerequisites**

- **Bun ≥ 1.3** — the runtime and package manager. TypeScript support is built in, so you don't need a separate Node.js or `tsc` install. Install at [bun.sh](https://bun.sh).
- Git ≥ 2.30

**Setup**

```bash
git clone https://github.com/lorelum/notify-bus.git
cd notify-bus
bun install          # installs all workspace packages (server + web)
cp .env.example .env   # then set GITHUB_WEBHOOK_SECRET
```

**Common commands** (run from the repo root — they cover both packages)

| Task | Command |
|---|---|
| Run server + frontend (dev) | `bun run dev` |
| Run server only (dev) | `bun run dev:server` |
| Run frontend only (dev) | `bun run dev:web` |
| Run tests | `bun test` |
| Lint | `bun run lint` (oxlint) |
| Format | `bun run fmt` (oxfmt) |
| Typecheck | `bun run typecheck` (`tsc -b` — both packages) |
| Build frontend | `bun run build` |
| Start production server | `bun run start` |

## How we work: issue-driven, design-first

notify-bus uses **issue-driven development** with a **design-first** rule for anything that touches the product surface. Every change starts with an issue; changes to the pipeline interface, channel adapter interface, REST API shape, or the `EventMessage` contract need design alignment *before* code.

**The flow at a glance:**

```
idea / bug
   │
   ▼
Issue (structured: background, goal, acceptance criteria)
   │
   ▼  touches product surface? ──▶ discuss design in the issue / a Discussion
   │                                  (align before coding)
   ▼
implementation (one branch per issue)
   │
   ▼
PR (linked to issue, CI green, human review)
   │
   ▼
merge → close issue
```

**What counts as "product surface"?** The pipeline/middleware interface, the `ChannelAdapter` interface, the `EventMessage` type, the REST API (`/api/*`), and the webhook contract (`POST /webhook`). Changes to these need design discussion first — not because we love process, but because they become contracts that users and adapters depend on.

Pure bug fixes, refactors, perf improvements, and docs don't need upfront design — just an issue and a PR.

## Reporting bugs & proposing features

- 🐛 **Bug** → [bug report template](https://github.com/lorelum/notify-bus/issues/new?template=bug_report.yml)
- ✨ **Feature** → [feature request template](https://github.com/lorelum/notify-bus/issues/new?template=feature_request.yml) — include background, goal, and acceptance criteria
- 💬 **Discussion / question** → [Discussions](https://github.com/lorelum/notify-bus/discussions)

Before opening a new issue, please search existing ones to avoid duplicates.

## Development workflow

1. **Find or open an issue.** Every change starts with an issue.
2. **Claim it.** Comment that you're working on it (or get assigned).
3. **Branch.** From `main`: `feat/<scope>-<short>` or `fix/<scope>-<short>`.
   ```bash
   git checkout -b feat/feishu-signing
   ```
4. **Implement.** Follow [AGENTS.md](./AGENTS.md) for repo conventions. Keep PRs focused — one issue per PR.
5. **Test locally.** `bun test`, `bun run lint`, `bun run typecheck` must pass. Add tests for new behavior.
6. **Open a PR.** Fill in the [PR template](./.github/PULL_REQUEST_TEMPLATE.md). Link the issue (`Closes #123`).
7. **Review.** A maintainer will review. Address feedback with new commits (don't force-push mid-review unless asked).
8. **Merge.** Squash-merge into `main`.

**Branch naming:**

| Type | Pattern | Example |
|---|---|---|
| Feature | `feat/<scope>-<short>` | `feat/feishu-signing` |
| Fix | `fix/<scope>-<short>` | `fix/webhook-raw-body` |
| Docs | `docs/<topic>` | `docs/readme-refresh` |
| Chore | `chore/<topic>` | `chore/deps-bump` |

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/). Every commit and every PR title follows the same format:

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

### Type (required)

| Type | Use for |
|---|---|
| `feat` | A new feature |
| `fix` | A bug fix |
| `perf` | A change that improves performance |
| `refactor` | A code change that neither fixes a bug nor adds a feature |
| `docs` | Documentation only |
| `test` | Adding or correcting tests |
| `build` | Changes to the build system or dependencies |
| `ci` | Changes to CI configuration |
| `chore` | Routine maintenance, tooling, repo config |

### Scope (optional but encouraged)

A short noun identifying the area — e.g. `webhook`, `pipeline`, `adapter`, `api`, `web`, `db`, `docs`. Omit the parentheses if it doesn't fit.

### Subject (required)

- Imperative, present tense: "add", not "added" or "adds".
- Lowercase first letter, no trailing period.
- ≤ 72 characters.
- Specific, not generic: `add feishu adapter with hmac signing`, not `update adapters`.

### Body (optional)

- One blank line after the subject.
- Explain **what and why**, not how (the diff shows the how).
- Wrap at ~72 characters.
- Use `-` bullets for lists.

### Footer (optional)

- One blank line before the footer.
- Used for: breaking changes (`BREAKING CHANGE: <description>`), issue closing (`Closes #123`), co-authors (`Co-authored-by: name <email>`).

### Examples

**Simple (most commits):**
```
docs(readme): add 5-minute tour section
```

**With body:**
```
fix(webhook): capture raw body before json parse for signature

Re-serializing the parsed body changed byte ordering and broke
HMAC verification. Capture the raw buffer in beforeHandle before
Elysia's body parser touches it.
```

**Closing an issue:**
```
feat(adapter): add feishu adapter with hmac signing

Closes #12
```

## PR titles

Because we **squash-merge**, the PR title becomes the commit message on `main`. So PR titles **must follow the same Conventional Commits format** as commits.

✅ Good:
- `feat(adapter): add feishu adapter with hmac signing`
- `fix(webhook): capture raw body before json parse`
- `docs: refresh readme`

❌ Avoid:
- `update` (no type, no detail)
- `fixed the bug` (no type, vague)
- `Feat: added a new adapter!!!` (uppercase, punctuation, vague)

If a PR spans multiple types, pick the **most significant** change as the type (usually `feat` or `fix`). Split the PR if the types are equally significant.

## Testing & CI

Tests run on `bun:test`, linting on `oxlint`, formatting on `oxfmt`, typecheck via `tsc -b` (project references, covers both `packages/server` and `packages/web`).

- **Unit tests ship with new code.** Colocate tests as `*.test.ts` next to the source they cover.
- **Coverage:** aim to keep or improve coverage on touched code. New behavior needs tests.
- **Lint and typecheck:** `oxlint` and `tsc -b` must pass. No silencing the type checker or linter without justification in the PR.
- **Mock network and the filesystem** — never hit the real Feishu API or a real GitHub webhook in unit tests. The Feishu signer has a known-good vector test (see `packages/server/src/lib/adapters/feishu.ts`).
- **Signature verification is security-critical.** Any change to `packages/server/src/lib/verify/github.ts` or the webhook raw-body capture path needs a regression test that fails before the fix and passes after.

CI runs build, lint, typecheck, and test on every PR. A PR cannot merge until all gates are green.

## AI-assisted contributions

We actively welcome contributions made with AI coding assistants. A few rules to keep quality high:

1. **Read [AGENTS.md](./AGENTS.md)** before letting the agent write code — it contains repo-specific commands, layout, and boundaries the agent must respect.
2. **You are responsible for the diff.** "The AI wrote it" is never a defense for bugs, broken tests, or security issues. Review every line.
3. **Disclose AI assistance.** In the PR description, check the "AI-assisted" box and briefly note which parts were AI-generated. This helps reviewers focus.
4. **No large AI-generated dump PRs.** Keep PRs focused and reviewable. If an agent produces a 1000-line diff, break it into smaller PRs.
5. **Tests still apply.** AI-generated code must pass the same lint, type-check, and test gates as hand-written code.

## Becoming a maintainer

Regular, high-quality contributors may be invited to become maintainers. Maintainers get triage rights, review responsibilities, and a say in project direction. If you're interested, just tell us in Discussions.

---

## Questions?

- 💬 [Discussions](https://github.com/lorelum/notify-bus/discussions) — for anything that's not a bug or feature request
- 📧 maintainers@lorelum.com — for private matters

Happy hacking! 🚀
