# Changelog — @agentbazaar/sdk

All notable changes to this package are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.2.3] — 2026-04-26 (Task #59, M2-W6)

### Fixed

- **R6 — discover() limit clamp** (Task #59).
  The SDK was sending `limit=200` to the API, which enforces `limit <= 100` via Zod and
  returns 422. The request URL now clamps the limit to `API_MAX_LIMIT` (100) before building
  the query string. SDK callers can still pass `limit` up to 200; the clamping is transparent
  and only applies to the HTTP request, not the RPC fallback path.

- **R7 — mapSimulationError transactionMessage fallback** (Task #59).
  When `SendTransactionError.logs` is `undefined` (web3.js path), the existing log-parsing
  loop produced no match and the caller received a generic `TransactionFailedError` instead of
  the typed exception (e.g. `EscrowNotExpiredError` for code 6006 `DeadlineNotYetPassed`).
  `mapSimulationError` now falls back to parsing the `fallbackMessage` string (the error
  message / `transactionMessage`) for a `custom program error: 0x<hex>` pattern when the
  logs array yields no match. The negative `claimTimeout` E2E test is unblocked.

---

## [0.2.2] — 2026-04-26 (Task #56, M2-W4)

### Changed

- **`discover()` is now API-primary** (Task #56).
  Previously `discover()` called `getProgramAccounts` directly on the user's RPC node (slow
  beyond ~10k listings, load-bearing on the caller's connection). It now calls the Discovery
  REST API (`GET /listings`) as the primary source, with RPC as a one-shot fallback.

- **New default `apiUrl`**: `https://agentbazaar-api.r-443.workers.dev` (production CF Workers
  endpoint). Override via `AgentBazaarConfig.discoveryApiUrl` or the `DISCOVERY_API_URL`
  env var.

- **`discover()` now throws `DegradedDiscoveryError` when the API is unavailable.**
  Previously it silently returned RPC results. Now it always throws `DegradedDiscoveryError`
  so callers know they are seeing degraded data. The RPC fallback results are attached as
  `err.rpcResults: readonly ServiceProvider[]` so callers can choose to surface them with
  appropriate UX ("live data unavailable — showing on-chain snapshot").

- **4xx from API → `DiscoveryAPIError` (no fallback).** A 400/404/etc. is a client bug
  (bad filter params), not a server outage — the SDK surfaces it immediately rather than
  hiding it behind the RPC fallback.

- **API response validated with Zod** before any consumer code runs. The schema
  (`APIResponseSchema`, `ListingDtoSchema`) is exported for callers that want to validate
  independently or write contract tests against the live API.

- **Sort parameters mapped to API conventions**: SDK `'price_asc'` → `sort=price&order=asc`;
  `'reputation_desc'` → `sort=reputation&order=desc`; `'latency_asc'` → `sort=completedJobs&order=asc`.

### Added

- `DegradedDiscoveryError<TListing>` gains a `rpcResults: readonly TListing[]` property.
  Existing code that only catches the error and does not inspect `rpcResults` is unaffected.

- `APIResponseSchema` and `ListingDtoSchema` exported from `@agentbazaar/sdk` (and from
  `packages/sdk/src/discover.ts`) for contract testing.

### Migration

```ts
// Before 0.2.2 — results silently came from RPC when API was down
const results = await bazaar.discover({ capability: 'foo' });

// After 0.2.2 — handle DegradedDiscoveryError to access RPC fallback results
let results: ServiceProvider[];
try {
  results = await bazaar.discover({ capability: 'foo' });
} catch (err) {
  if (err instanceof DegradedDiscoveryError) {
    // err.rpcResults contains best-effort on-chain data
    results = [...err.rpcResults];
    showBanner('Live data unavailable — showing on-chain snapshot');
  } else {
    throw err;
  }
}
```

---

## [0.2.1] — 2026-04-26

### Added

- **Hostname allowlist for `clusterFromConnection()`** (L2 from PR #77 audit, Task #53).
  Detection is now performed against the URL *hostname* (extracted via `new URL(endpoint).hostname`)
  rather than the full URL string. A per-cluster `CLUSTER_HOSTS` regexp allowlist prevents
  path/query-parameter injection attacks — e.g.
  `https://mainnet-proxy.example.com/devnet-shadow` now correctly resolves to `mainnet-beta`
  instead of `devnet`.
  An explicit `{ override?: Cluster }` option was added so callers can bypass auto-detection.
  Type export: `ClusterFromConnectionOptions`.

- **Cluster-aware USDC mint table** (L4 from PR #77 audit, Task #53).
  New export `USDC_MINTS: Record<Cluster, PublicKey>` with Circle's canonical addresses for
  `mainnet-beta` and `devnet`. New helper `getUsdcMint(conn: Connection): PublicKey` returns the
  correct mint for the cluster inferred from the connection.
  `hire.ts` now calls `getUsdcMint(connection)` by default; callers may still pass an explicit
  mint to `hireAgent(..., usdcMint?)` to override (useful for localnet test mints).

- **`sendWithRetry` simulation error mapping** (Task #51).
  `sendRawTransaction` is now wrapped in a try/catch. When a `SendTransactionError` is thrown
  (pre-flight simulation rejected by the node), the transaction logs are parsed for Anchor and
  raw custom-program-error codes using the same 6000-based lookup table already used for
  post-confirm errors. The helper `mapSimulationError(logs, fallbackMessage)` is exported for
  testing. Callers now receive typed exceptions (`UnauthorizedError`, `EscrowExpiredError`,
  `EscrowNotExpiredError`) from simulation failures, not opaque `SendTransactionError` instances.

### Changed

- `hire.ts` default `usdcMint` parameter changed from `DEVNET_USDC_MINT` (a compile-time
  constant) to `getUsdcMint(connection)` (runtime, cluster-aware).

### Deprecated

- `DEVNET_USDC_MINT` — still exported for backwards compatibility but deprecated.
  Use `USDC_MINTS.devnet` or `getUsdcMint(conn)` instead.

---

## [0.2.0] — 2026-04-20 (PR #77)

### Added

- Per-cluster program ID table `PROGRAM_IDS: Record<Cluster, ProgramAddresses>`.
- `UnknownClusterError` — thrown when `clusterFromConnection()` cannot resolve the endpoint.
- `Cluster` and `ProgramAddresses` type exports.
- `clusterFromConnection(conn: Connection): Cluster` helper (substring-based; superseded in 0.2.1).

### Breaking

- `deriveListingPda` seed layout changed to include the listing nonce as a LE-8 byte buffer.
  Existing localnet PDAs derived from the pre-0.2.0 layout will not match.

---

## [0.1.0] — 2026-03-15 (M1 initial release)

### Added

- `AgentBazaar` client class with full M1 method surface:
  `register`, `discover`, `hire`, `deliver`, `confirm`, `dispute`, `claimTimeout`.
- Typed error hierarchy: `InsufficientFundsError`, `MetadataUploadError`,
  `DuplicateListingError`, `TransactionFailedError`, `ValidationError`, and more.
- `sendWithRetry` with 3-attempt priority-fee escalation (`0 → 100k → 500k` micro-lamports).
- Graceful Discovery API fallback to direct RPC.
- Zod-based client-side input validation before transaction submission.
- IDL-derived types via `@agentbazaar/idl` workspace package.
