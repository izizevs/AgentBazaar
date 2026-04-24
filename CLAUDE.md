# AgentBazaar — project overview for agents

**Mission.** On-chain marketplace on Solana for AI agents (A2A commerce): agents discover, negotiate, and transact services with SLA-enforced escrow and reputation scoring. Settlement in USDC, no native token.

**Reference docs** (not committed; live locally in `/workspace/some-docs/`):
- `AgentBazaar_PRD.docx` — product requirements (user stories, acceptance criteria, data model)
- `AgentBazaar_Product_Definition.docx` — features, UVP, positioning, architecture, wireframes
- `AgentBazaar_Strategy_Roadmap.docx` — partnerships, fundraising, integrated roadmap
- `AgentBazaar_Legal_Risk_Assessment.docx` — compliance, entity structure, geo-block
- `AgentBazaar_FAQ.docx` — investor FAQ

## Scope

**Current:** MVP (milestones M0 → M1 → M2, see `docs/milestones/`).
**Out of MVP (V1+):** evaluator framework, dispute resolution, negotiation protocol, full dashboard, Solana Agent Kit plugin, SLA insurance, cross-chain, agent swarms, mobile, native token.

## Stack

### On-chain
- Rust + Anchor 0.31+, SPL Token, USDC only, no oracles for MVP
- 4 programs: `bazaar-registry`, `bazaar-escrow`, `bazaar-sla`, `bazaar-evaluator` (stub in MVP)
- Upgrade authority via Squads multisig 2-of-3 (not hard-coded; deploy-time config)
- `overflow-checks = true`, checked math everywhere, `Clock` sysvar for timestamps

### Off-chain (all TypeScript)
- **API** — Hono on Cloudflare Workers (Discovery API + MCP server)
- **Indexer** — Node on Railway / Fly native runtime (Helius webhooks → Postgres)
- **Dashboard** — Next.js 14 App Router on Vercel / CF Pages
- **SDK** — `@agentbazaar/sdk` published to npm

### Cross-cutting
- **pnpm** workspaces + **Turborepo** orchestration
- **Biome** for lint/format (not ESLint+Prettier)
- **pino** structured JSON logs
- **Drizzle** ORM + `drizzle-kit` migrations
- **Zod** runtime validation
- **Vitest** for TS tests (Anchor programs use their own harness)
- **Native `@coral-xyz/anchor`** for IDL typing (not Solita / Codama)
- **dotenv-mono** for Node processes (Next.js and CF Workers use their native env handling)

## Monorepo layout

```
programs/              Rust/Anchor — own Cargo workspace, NOT in pnpm
apps/
  dashboard/           Next.js 14 App Router (read-only in MVP)
  indexer/             Helius webhook listener → Postgres
  api/                 Hono HTTP API (Discovery + MCP server) on CF Workers
  mcp-server/          MCP server for LLM agents (if it ends up split out)
packages/
  sdk/                 @agentbazaar/sdk (published to npm)
  idl/                 IDL types from programs/ — shared between sdk and indexer
tests/
  e2e/                 Playwright + SDK full lifecycle
  load/                k6 against API and MCP
  sla/                 Table-driven SLA severity scenarios
  fixtures/            Funded wallet scripts, USDC mint deployer
  mocks/               SATI / x402 / Helius mocks
  helpers/             State assertions, tx utilities
scripts/               One-off scripts (install-solana-toolchain.sh, etc.)
security/              Security audit notes (append-only)
docs/
  milestones/          Per-milestone plans and summaries
  decisions/           ADR records (NNNN-title.md)
some-docs/             ❗ Source of truth from user docs. NOT committed. NOT in .gitignore on purpose — agents: do NOT `git add some-docs/` and do NOT `git add .` without inspection.
```

## Environment

Inside the devcontainer:
- `DATABASE_URL` is auto-injected via docker-compose (`postgres:5432`)
- `.env` holds `HELIUS_API_KEY`, `PINATA_JWT`, `GITHUB_TOKEN`, program IDs

Outside the devcontainer (CI / production deploys):
- env values are configured through the platform UI (Vercel / CF / Railway)

## Development — first steps

```bash
# (1) On the Mac host — bring the stack up
docker compose up -d --build

# (2) Inside the container
docker compose exec claude zsh

# (3) Install dependencies
pnpm install

# (4) Only if working with Anchor programs — install Solana toolchain (~15 min)
./scripts/install-solana-toolchain.sh

# (5) Build / test / lint
pnpm build
pnpm test
pnpm lint
```

## Commands

| Command | What it does |
|---|---|
| `pnpm build` | Turbo build: walks the dep graph `packages/idl → packages/sdk → apps/*` |
| `pnpm test` | Vitest across all TS packages |
| `pnpm typecheck` | `tsc --noEmit` per package via turbo |
| `pnpm lint` | `biome check .` |
| `pnpm lint:fix` | `biome check --write .` |
| `pnpm format` | `biome format --write .` |
| `pnpm build:programs` | `anchor build` in `programs/` |
| `pnpm test:programs` | `anchor test` in `programs/` |

## Agent team

7 agents. Prompts: `~/.claude/teams/agentbazaar/agents/*.md`.

| Agent | Model | Scope |
|---|---|---|
| team-lead | Opus | Coordination, PR review, milestone planning |
| anchor-eng | Sonnet | 4 programs in `programs/` |
| sdk-eng | Sonnet | `packages/sdk` TS SDK |
| backend-eng | Sonnet | `apps/indexer` + `apps/api` + `apps/mcp-server` |
| frontend-eng | Sonnet | `apps/dashboard` Next.js read-only |
| qa-test-eng | Sonnet | `tests/` E2E + regression + SLA + load + infra |
| security-auditor | Opus | Pre-merge audit gate for `programs/` and security-sensitive paths |

## Operating model

**Autonomy rules**, **Observer Mode cadence**, **milestone-based planning** — recorded in auto-memory (`agentbazaar_operating_model.md`). Short summary:

- ✅ Allowed without user approval: feature branches, PRs, merge after security-auditor + qa-test-eng approvals, devnet deploy, `npm publish --dry-run`, edits to `.env.example` / Dockerfile / compose
- ❌ Forbidden without user approval: mainnet deploy, spending money, force-push to `main`, real `npm publish`, going outside PRD scope, acting on the user's behalf in external systems
- 🟡 Intra-team voting: compose service restart, npm deps >100KB, breaking SDK API change

**Cadence — Observer Mode:**
- `/workspace/STATUS.md` — running log. **Event-driven** entries (no daily padding).
- `/workspace/docs/decisions/NNNN-*.md` — ADR every time a non-trivial decision is made.
- `/workspace/docs/milestones/M<N>-summary.md` — at milestone completion.
- GH PR/Issues — natural visibility stream.
- **Interruptions only via GH Issue `blocker` + `the PM`** — when truly stuck or an external system breaks.

## Language

**English only** for all repo content — code, comments, docs, commit messages, GH issues / PRs, log messages, errors, tests. The user-facing chat with Claude stays in Russian, but no Cyrillic content lands in the repo.

## Commit convention

- **Author:** `AgentBazaar <dev@agentbazaar.local>` — set globally in git config.
- **Never** attribute the user (`repo-owner`).
- **Never** add `Co-Authored-By: Claude ...` trailer to commit messages.
- Branch naming: `feature/<component>-<short-name>`, e.g., `feature/anchor-registry-init`, `feature/sdk-discover-api`.
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.

## Git rules

- Main is protected: merges only via PR
- Never `git push --force` on `main`
- Never `git add some-docs/` — intentionally not in .gitignore
- Never `git add .` without first reviewing the staging set (it can pick up `some-docs/` or host-mounted editor configs)
- Prefer atomic commits (one logical change); squash-merge PRs

## Security / legal constraints (MVP)

From the Legal Risk Assessment §§5, 7:
- **Geo-block US / UK / OFAC**-sanctioned addresses in the dashboard middleware (IP-based) and OFAC address screening before escrow creation
- **No admin keys** with withdrawal authority over the escrow vault — `security-auditor` checks this on every PR
- **Upgrade authority** via Squads multisig 2-of-3
- **No mainnet without user approval** — devnet only until the PM explicitly green-lights mainnet

## Links back to memory (for future sessions)

- `agentbazaar_operating_model.md` — autonomy + cadence + milestones
- `agentbazaar_stack_decisions.md` — 6 cross-cutting picks (Hono / pino / Drizzle / Zod / Vitest / Anchor)
- `agentbazaar_tooling.md` — pnpm / Turborepo / Biome / Docker-local-only
- `agentbazaar_env_strategy.md` — dotenv-mono vs native per tool
- `agentbazaar_scope_v1_not_mvp.md` — Agent Kit plugin is V1, not MVP
- `agentbazaar_commit_conventions.md` — AgentBazaar bot identity, no Co-Authored-By
- `agentbazaar_language.md` — repo is English-only
