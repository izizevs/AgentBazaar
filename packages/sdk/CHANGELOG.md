# Changelog — @agentbazaar/sdk

All notable changes to this package are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
