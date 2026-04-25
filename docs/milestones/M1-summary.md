# M1 — Summary

**Status:** ✅ Closed 2026-04-25.
**Duration:** ~3.5 hours wall-clock (M0 close 15:25 → M1 close 18:50), all parallel.
**Tasks:** 14/14 done (#20–#33).

## What shipped — working devnet prototype

End-to-end escrow lifecycle on Solana devnet. Two AI agents can:

1. Agent A registers a service (capability + price + SLA + endpoint metadata)
2. Agent B discovers A via SDK
3. Agent B hires A with USDC escrow (PDA-controlled vault, non-custodial)
4. A submits delivery (result hash + URI)
5. B confirms → vault releases USDC to A based on inline SLA severity (minor 100% / moderate 80% / major 50%), A's reputation increments via CPI
6. If B silent past deadline: A claims timeout → vault releases to A
7. If B disputes: vault refunds to B (M1 stub; V1 will add resolution)

### On-chain (anchor-eng-2)
- `bazaar-escrow` Anchor program: 5 instructions (`create_escrow`, `submit_delivery`, `confirm_delivery`, `claim_timeout`, `open_dispute`)
- Inline SLA severity refund logic (deployed avoiding separate `bazaar-sla` complexity for prototype)
- `bazaar-registry` extended with `increment_jobs_completed` CPI-only instruction
- Deployed on devnet: registry `ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3`, escrow `EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2`, sla `26rhkrBkf75ijDoDuhed8m94FkuhB2MukvqtWYEDegd8`. Evaluator (stub) — pending SOL top-up
- Anchor tests: full coverage including happy / timeout / dispute / SLA severity branches / owner-mismatch negatives / CPI-signer rejection negatives

### SDK (sdk-eng)
- 5 escrow methods: `hire`, `deliver`, `confirm`, `claimTimeout`, `dispute`
- 11 new error classes (`EscrowNotFoundError`, `EscrowExpiredError`, `UnauthorizedError`, `EscrowAlreadyDisputedError`, etc.)
- `sendWithRetry` helper with priority fee escalation + `isTransient(err)` gate (no retry on program errors)
- On-chain error code mapping: program codes 6000-6010 → typed SDK exceptions
- `hire()` idempotency: existing escrow PDA returns handle without re-deposit
- 158 Vitest unit tests + on-chain error code regression test (catches H1-class regressions)
- TC39 private field for Pinata JWT (true secret hiding)

### Indexer (backend-eng-2)
- 3 new tables: `escrows`, `sla_reports`, `agent_reputation`
- 5 event handlers (`on-escrow-created`, `on-escrow-state-changed`, `on-delivery-submitted`, `on-sla-report`, `on-dispute-opened`)
- BorshEventCoder integration with bazaar-escrow IDL
- Atomic INSERT-RETURNING ON CONFLICT (race-free reputation update)
- Helius enhanced webhook configured on devnet (ID `430f2432-ccf5-41cd-9d76-c836946c9efc`) monitoring both program IDs, URL on stable ngrok domain
- 59/59 indexer tests + integration tests against live Postgres

### Tests (qa-test-eng)
- 3 E2E lifecycle suites (`tests/e2e/`): happy-path, timeout, dispute
- Each uses real devnet + funded test wallets + test USDC mint
- Shared `escrow-assertions.ts` helper
- Negative tests cover EscrowNotExpiredError, EscrowAlreadyResolvedError, EscrowAlreadyDisputedError, UnauthorizedError

### Security (security-auditor-2)
- 4 substantive audits (PR #51, #58, #59 — escrow program, event handlers, SDK methods)
- Caught 2 CRITICAL bugs that mock tests missed:
  - **C1 + C2 in PR #51**: reputation forgery (no signer constraint) + payout redirect (no token-account owner check). Fixed via PDA-signer + Anchor token::authority constraints.
  - **H1 in PR #59**: SDK deadline parameter absolute-vs-relative — `claim_timeout` would never fire. Fixed via direct BN(timeout) + regression test asserting BN value.
- Two-iteration audit-fix-reverify discipline pattern from M0 continued; every flagged issue closed in same PR cycle.

## Manual user step required for live wiring

backend-eng-2's PR #63 set up Helius webhook config, but one step requires user action:
1. Log into helius.dev dashboard
2. Find webhook ID `430f2432-ccf5-41cd-9d76-c836946c9efc`
3. Set `Authorization Header` to match `HELIUS_WEBHOOK_SECRET` from `.env`
4. Run `ngrok http --domain=perdurable-spumescent-elvis.ngrok-free.dev 3001` to expose indexer
5. Smoke test: register a listing → verify event appears in indexer logs + DB row created

Full runbook: `apps/indexer/docs/helius-setup.md`.

## M1 carryforwards (must close before mainnet — V1 work)

Tracked from various M1 audits + M0 carry-overs:

### Mainnet hardening
- **Per-cluster program ID table in SDK** — bump to `0.2.0` for mainnet support (PR #30 O2)
- **`price_lamports` → `price_usdc_base_units` rename** (PR #2 M2)
- **USDC mint canonical binding** (PR #51 H1 deferred — `address = USDC_MINT` constraint)
- **Squads 2-of-3 multisig** as upgrade authority for all 4 programs
- **Evaluator program deploy** (deferred ~1.22 SOL)

### Polish
- **SSRF I1**: streaming response cap with byte-counter (PR #44 deferred)
- **SSRF I2**: custom undici dispatcher to defeat DNS rebinding (PR #44 deferred)
- **TTL retention** for `processed_signatures` table (PR #35 L2)
- **Nonce determinism** in SDK hire (PR #59 M1 carryforward)

### Architecture
- **Discovery API as deployed HTTP service** on Cloudflare Workers (currently SDK falls back to RPC `getProgramAccounts` — works but slower past ~10k listings)
- **MCP server** for LLM agents (`bazaar_discover`, `bazaar_get_listing`, `bazaar_get_reputation`)
- **Dashboard skeleton** (Next.js, read-only views)
- **Geo-block middleware** (US/UK/OFAC IP screening)

### V1 features (out of MVP)
- Full evaluator framework (replace stub)
- Full dispute resolution (replace M1-stub full-refund)
- Negotiation protocol
- Solana Agent Kit plugin
- SLA insurance
- Cross-chain
- Agent swarms

## Process notes

- **Worktree-per-agent** model continued from M0 — zero shared-tree drift incidents in M1.
- **Audit gate** caught critical bugs that 200+ unit tests missed (mock isolation hides cross-boundary bugs). Devnet E2E tests added to safety net (qa-test-eng's #30-#32).
- **Recurring CI noise** (3 hotfix PRs #55/#56/#57 expanding biome ignore for auto-gen IDL/Drizzle) — long-term fixes landed.
- **PR cascade merge pattern** + manual git ops in shared `/workspace` proved stable with worktrees + agent lifecycle policy (shutdown after wave, respawn fresh).

## Stats

- **PRs opened**: #50–#63 (14 PRs, all merged through audit gate or no-audit-needed for schema/docs)
- **Critical findings caught**: 3 (2 CRITICAL + 1 HIGH) — all fixed in same cycle
- **Total cost**: 5 SOL devnet (covers 3 program deploys + escrow tests + E2E test wallets)
