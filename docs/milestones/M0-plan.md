# M0 — Registry + SATI + Indexer skeleton + SDK v0.1

**Goal.** End-to-end `register → discover` flow working on Solana devnet. A seller agent registers a service via the SDK, metadata lands on IPFS (Pinata), the `ServiceListing` PDA is created on-chain, the Helius webhook fires the indexer, the indexer writes to Postgres, and a buyer agent finds the service through `SDK.discover`.

PRD-guidance time: ~4 weeks. No calendar deadline — done when exit criteria are verified.

## Exit criteria (verifiable)

Each item must be demonstrated by `qa-test-eng` before moving on to M1.

1. ✅ `bazaar-registry` program deployed to devnet — program ID recorded in `.env` and `.env.example`.
2. ✅ E2E via SDK: `new AgentBazaar({...}).register({...})` → metadata uploaded to Pinata IPFS → `ServiceListing` PDA created on-chain → tx signature returned in ≤5 seconds.
3. ✅ SATI integration: if the wallet has no SATI identity, the SDK creates one; if it does, the SDK uses it.
4. ✅ Indexer: after a `ServiceListingCreated` event, a row appears in Postgres `service_listings` within ≤30 seconds.
5. ✅ SDK: `bazaar.discover({capability: X})` returns the registered listing.
6. ✅ Anchor tests: 100% instruction coverage across all 4 registry instructions (`register_service`, `update_service`, `deactivate_service`, `reactivate_service`).
7. ✅ `security-auditor` approved the registry-program PR (audit notes in `security/audit-notes.md`).
8. ✅ GitHub Actions CI passes on main: `turbo build` + `turbo test` + `biome check`.
9. ✅ `packages/sdk` packs cleanly via `npm publish --dry-run` (version 0.1.0).

## Component breakdown

### programs/ (owner: anchor-eng)
- Cargo workspace + `Anchor.toml`
- `programs/bazaar-registry/` — `ServiceListing` PDA, 4 instructions, events
- Anchor Mocha/Chai tests
- IDL export → `packages/idl/idl/bazaar_registry.json`
- Devnet deploy

### packages/idl/ (owner: sdk-eng, source data from anchor-eng)
- Codegen: Anchor IDL JSON → TypeScript types
- Export the metadata JSON schema (single source of truth for SDK and Dashboard)

### packages/sdk/ (owner: sdk-eng)
- `AgentBazaar` class with `{wallet, rpc, cluster}` constructor
- `bazaar.register()` — Zod validation → Pinata upload → SATI identity handling → `register_service` tx → return listing
- `bazaar.discover()` — direct `getProgramAccounts` initially (until the indexer is in place); later switch to Discovery API
- Typed error hierarchy
- Vitest unit tests + example scripts

### apps/indexer/ (owner: backend-eng)
- Helius webhook endpoint (Node + pino)
- Drizzle schema + drizzle-kit migrations for `service_listings` (PRD §6.2)
- Event decoder (via `@agent-bazaar/idl`)
- Handler: `ServiceListingCreated/Updated` → upsert into Postgres
- Integration test against the live Postgres (docker-compose)

### Infrastructure (owner: team-lead)
- `.github/workflows/ci.yml` — install → lint → typecheck → test
- `.github/PULL_REQUEST_TEMPLATE.md` with security + qa checkboxes
- First end-to-end CI run on a probe PR

### tests/ (owner: qa-test-eng)
- `tests/fixtures/devnet-wallets.ts` — script that funds N wallets via airdrop
- `tests/e2e/register-discover.spec.ts` — happy-path full lifecycle
- Placeholder structure for future milestones (`load/`, `sla/`)

### security/ (owner: security-auditor)
- Review every PR in `programs/` or security-sensitive paths
- Append-only log in `security/audit-notes.md`

## Dependencies / parallelism

```
[anchor-eng] scaffold → register_service → deploy devnet → IDL export
                                                            │
                                                            ▼
[sdk-eng]    ──────────────────────────→ IDL codegen → SDK.register → SDK.discover
                                                            │
[backend-eng] indexer skeleton → schema → ─────── event handler ← IDL
                                                            │
[qa-test-eng] fixtures + placeholders ──────── E2E test ←───┘
                                                            │
[security-auditor] ←── reviews at each merge gate ─────────┘
```

After the first Anchor build + IDL export, sdk-eng and backend-eng can work independently in parallel.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Anza has no precompiled arm64-linux build → cargo source build takes 15+ min | `scripts/install-solana-toolchain.sh` with RUSTFLAGS overrides; one-time cost, cached |
| `solana-test-validator` cargo crate is a library, not a binary | Run test-validator from a docker sidecar (`solanalabs/solana` image) inside Anchor tests; TODO captured in install script |
| SATI SDK may be unstable (Strategy Roadmap §3.5 critical path) | Fallback: write directly to Token-2022 NFT identity without the SATI wrapper; document the deviation in an ADR |
| Helius devnet webhook latency varies | The indexer must be able to reprocess from RPC fallback if a webhook is missed (acceptance: a `rebuild_from_chain.ts` script) |
| IDL generation tool: `@coral-xyz/anchor` sometimes breaks types on a major upgrade | Pin Anchor 0.31.x in `programs/Cargo.toml` until the end of MVP |

## Out of scope for M0

Explicitly NOT done in this milestone (deferred to M1 or V1):
- `bazaar-escrow` and `bazaar-sla` — M1
- `bazaar-evaluator` (even the stub) — M1
- x402 integration — M1
- Dashboard — M2
- SDK `hire` / `deliver` / `confirm` / `dispute` / `requestEvaluation` — M1 (escrow) and later
- Reputation feed on SATI — M2
- Full discovery filters (reputation, uptime, latency sort) — M2 (when indexer is mature)
- Discovery API rate limiting — M2 (the API itself ships in M1)

## Next actions (order of operations)

1. team-lead creates the TaskList for M0 (15–25 tasks)
2. Spawn anchor-eng (first — on the critical path)
3. anchor-eng runs `scripts/install-solana-toolchain.sh`
4. In parallel, team-lead prepares `.github/workflows/ci.yml` + PR template
5. anchor-eng works on registry → devnet deploy → IDL publication
6. After IDL: spawn sdk-eng and backend-eng in parallel
7. Once the register path works — spawn qa-test-eng for E2E
8. security-auditor — on-demand for every PR in `programs/`
