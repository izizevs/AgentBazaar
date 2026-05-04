# M0 — Summary

**Status:** ✅ Closed 2026-04-25.
**Duration:** ~37 hours wall-clock (2026-04-24 04:20 → 2026-04-25 15:25), ~24 hours of active build time.
**Tasks:** 19/19 done.

## What shipped

### On-chain (anchor-eng)
- `bazaar-registry` Anchor program implementing `register_service` / `update_service` / `deactivate_service` / `reactivate_service` instructions.
- `ServiceListing` PDA: `[b"listing", owner, capability_hash]`. Inline `SlaParams`. `ServiceListingCreated` / `ServiceListingUpdated` events.
- 14/14 instruction tests pass.
- Deployed to **devnet**: `GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd`. Upgrade authority on a single keypair (M1 gate: transfer to Squads 2-of-3 multisig before any value flows through escrow).
- IDL + TS types exported as `@agent-bazaar/idl` workspace package.

### SDK (sdk-eng)
- `@agent-bazaar/sdk` published-shape (npm publish dry-run validated; not yet published to registry).
- `bazaar.register()` — Pinata metadata upload, capability hash, register tx with retry + priority fee escalation.
- `bazaar.discover()` — Discovery API primary path with `AbortSignal.timeout(10s)` + fallback to `getProgramAccounts` RPC. Zod runtime validation of API responses (M1 mainnet hardening landed).
- Error hierarchy: `BazaarError` base + 11 specialized classes (`InsufficientFundsError`, `MetadataUploadError`, `DuplicateListingError`, `TransactionFailedError`, `DiscoveryAPIError`, `RPCFallbackFailedError`, `WalletNotConnectedError`, `IDLMismatchError`, `ValidationError`, `DegradedDiscoveryError`).
- 5 example scripts in `packages/sdk/examples/`.
- Other methods (`hire`, `deliver`, `confirm`, `dispute`, `claimTimeout`, `requestEvaluation`) are stubs throwing `NotImplementedError` — M1 work.

### Indexer (backend-eng)
- `apps/indexer` on Hono + Drizzle ORM + Postgres 16.
- Schema: `service_listings` (12 columns + 2 indexes including composite `(capability_hash, is_active, price_lamports)` for discover queries) + `processed_signatures` (replay dedup).
- Helius webhook receiver: Bearer token auth with `timingSafeEqual` + atomic `INSERT ... ON CONFLICT DO NOTHING RETURNING` replay protection (race-free).
- Event handler: `ServiceListingCreated` / `ServiceListingUpdated` → upsert path with Pinata metadata fetch (SSRF-hardened: scheme allowlist + private-IP DNS block + redirect:error + 100KB cap).
- Integration tests against live Postgres (gated on `INTEGRATION=true`).

### Tests (qa-test-eng)
- `@agent-bazaar/tests` workspace with `fixtures/`, `helpers/`, `mocks/`, `e2e/`.
- E2E happy path on devnet: `register()` → on-chain PDA assertion → `discover()` via RPC fallback finds the listing. 4/4 pass.

### Security (security-auditor)
- 8+ audits covering every substantial PR. Pattern: every M0 PR through audit gate, with "audit flags concern → exact recommended fix lands → re-review confirms" loop running cleanly.
- Production-deploy gate: CLEAR for indexer (after PR #44 H1+M1+M2 mitigations).
- Mainnet release-gate: CLEAR for `discover()` (after PR #21 + #26 + #21 follow-up Zod validation).
- Pre-mainnet polish notes tracked for M1: I1 streaming response cap, I2 DNS rebinding, L2 retention TTL on `processed_signatures`.

## M1 carryforwards (must close before mainnet)

- `price_lamports` → USDC-explicit naming rename (security-auditor M2 from PR #2). Touches Anchor program + IDL + SDK + Drizzle schema.
- Per-cluster program ID table in SDK (security-auditor O2 from PR #30) — bump to `0.2.0` for mainnet support.
- Squads 2-of-3 multisig as upgrade authority for `bazaar-registry`.
- L1+L2 SSRF polish: streaming-with-byte-counter, custom undici dispatcher to defeat DNS rebinding.
- TTL retention job for `processed_signatures`.

## Process notes

- **Worktree-per-agent** model adopted mid-M0 after multiple shared-tree race incidents in `/workspace`. Eliminated checkout-race entirely. Memory: `agentbazaar_worktree_model.md`.
- **STATUS.md centralized** through team-lead — agents send 1-line summaries via SendMessage to avoid concurrent writes.
- **Squash-merge gotcha** documented: avoid stacked PRs; if necessary, recover via cherry-pick onto fresh main not rebase. Memory: `agentbazaar_squash_merge_cascade.md`.
- **Post-merge orphan-push pattern** documented: agents should pause git ops after PR opens for audit until team-lead confirms merge. Memory: `agentbazaar_post_merge_orphan.md`.
- **Inbox polling**: teammate auto-delivery turn-notifications misfire when user prompts preempt; team-lead reads `inboxes/team-lead.json` manually each turn. Memory: `agentbazaar_inbox_polling.md`.
- **Lifecycle policy**: agents shut down after their wave completes; respawn fresh when next role-specific task arrives. Memory: `agentbazaar_teammate_lifecycle.md`.

## Stats

- **48 PRs opened** (PRs #1-#48). All meaningful merges through audit gate.
- **6 sequential follow-up cycles** for security findings — every flagged finding addressed in the next or following PR.
- **0 production code in `main` rejected for cause** (only CI/biome/conflict iterations).
