# AgentBazaar — security audit notes

Append-only log of `security-auditor` reviews for every substantive PR touching
`programs/` or security-sensitive paths. One section per PR. Includes verdict,
findings by severity, and recommended fixes. Tracks the template for future
programs (escrow / sla / evaluator) — patterns approved here set precedent.

---

## PR #2 — feature/anchor-registry — 2026-04-24
**Verdict:** APPROVED (with non-blocking follow-ups)

**Scope of review:**
- `programs/bazaar-registry/src/lib.rs` (+285 / -2) — full program
- `programs/Anchor.toml` — workspace declaration
- `programs/Cargo.lock` — transitive pins via `scripts/pin-sbf-toolchain-deps.sh`
- `programs/Cargo.toml` — `overflow-checks = true` present in `[profile.release]` ✅

Walked the four mutation paths (`register_service`, `update_service`,
`deactivate_service`, `reactivate_service`) plus `SlaParams::validate`.

**Findings:**

- **Critical:** none.

- **High:** none.

- **Medium:**
  - **M1. Event payloads omit `sla_params`.** `ServiceListingCreated` carries
    price / capability_hash / metadata_uri but not `sla_params`.
    `ServiceListingUpdated` similarly omits `new_sla` even though
    `update_service` accepts `new_sla: Option<SlaParams>`. Per the checklist,
    events should be self-sufficient for the indexer to populate
    `service_listings` without re-reading the PDA. As-is the indexer must
    `getAccountInfo` on every create/update to recover SLA state, doubling
    RPC calls and opening a read-skew window between the event and the
    re-fetch. Non-blocking for M0 (indexer not live), but must land before
    backend-eng wires up the webhook listener in M1.
  - **M2. Field name `price_lamports` is misleading for a USDC marketplace.**
    MVP settles exclusively in USDC; `lamports` connotes SOL base units.
    A consumer (SDK, dashboard) could easily treat the field as SOL and
    mis-price by ~100×. Low severity on-chain (program treats it as an
    opaque `u64`), higher severity at the interface boundary. Rename to
    `price_base_units` / `price_usdc_atoms` / `price_atomic_units` — settle
    before `packages/sdk` ships types derived from the IDL.

- **Low:**
  - **L1. `update_service` emits an event even when all three `Option` args
    are `None`.** Wastes CU and writes a no-op log line that the indexer
    will have to filter. Add an early `require!` that at least one field is
    `Some`, or skip the emit when nothing changed.
  - **L2. `ServiceListingUpdated.new_price` / `new_uri` as `Option` in the
    event is ambiguous.** `None` means "not changed" on the update path but
    `None` is also emitted by `deactivate_service` / `reactivate_service`.
    The indexer has to cross-reference `is_active` transitions to disambiguate.
    Consider either (a) splitting into three distinct events
    (`PriceChanged` / `SlaChanged` / `ActiveStateChanged`) or (b) adding a
    small `u8` flag discriminating the cause. Revisit in M1 alongside M1/M2
    above.
  - **L3. `sati_agent_id: u64` has no validation.** Zero is a valid sentinel
    for "not yet provisioned by SATI" in some off-chain systems. Confirm with
    the SATI integration contract (M1) whether zero should be rejected at
    register time.

**Checklist walkthrough:**

1. ✅ **Account constraints.** `RegisterService` uses `init` with seeds
   `[b"listing", owner.key().as_ref(), capability_hash.as_ref()]` + `bump`.
   `UpdateService` / `ToggleService` use `has_one = owner` with explicit
   `Unauthorized` error code and re-derive seeds from stored
   `listing.owner` / `listing.capability_hash` + `bump = listing.bump`.
2. ✅ **Owner check on mutation.** Every mutating instruction requires a
   `Signer<'info>` typed as `owner` AND enforces `has_one = owner` against
   the stored listing. Non-owner signers are rejected with `Unauthorized`.
3. ✅ **Integer arithmetic.** Program performs no arithmetic; all writes are
   direct field assignments. `overflow-checks = true` confirmed in
   `programs/Cargo.toml [profile.release]`. No `checked_*` needed here but
   the discipline is prerequisite for escrow (M1).
4. ✅ **Deserialization.** Pure Anchor macros (`#[account]`,
   `AnchorSerialize`/`AnchorDeserialize`). No `try_from_slice_unchecked`,
   no manual Borsh, no raw pointer arithmetic.
5. ✅ **Timestamps.** Both mutation paths use
   `Clock::get()?.unix_timestamp`. No client-supplied timestamp fields.
6. ✅ **PDA derivation.** Seeds `[b"listing", owner, capability_hash]` —
   64 bytes of entropy. Two agents with overlapping capabilities collide
   only if they share a `Pubkey`, which they don't. Same-agent duplicate
   registration is correctly blocked by the `init` constraint (address
   already in use). All-zero `capability_hash` is explicitly rejected
   (`InvalidCapabilityHash`), closing a sentinel-collision vector.
7. ✅ **capability_hash handling.** Stored as `[u8; 32]` verbatim. Program
   does not hash or validate content — SDK owns SHA-256 determinism per
   scope. Non-zero guard is the only on-chain check.
8. ✅ **Space allocation.** Uses `#[account(init, space = 8 + ServiceListing::INIT_SPACE)]`.
   `InitSpace` derive walks `#[max_len(...)]` attributes on String / Vec
   fields. Manual sanity check: discriminator 8 + Pubkey 32 + u64 8 + [u8;32] 32
   + u64 8 + u8 1 + SlaParams + String(4+64) + bool 1 + u32 4 + i64 8 + u8 1 = 167 + SlaParams.
9. ✅ **SlaParams size.** Computed bytes:
   `Option<u32>` 5 + `Option<u16>` 3 + `Option<String max=16>` 21 + `Option<String max=64>` 69 +
   `Vec<CustomParam max=2>` 4 + 2×(4+16 + 4+32) = 116 → **214 bytes**.
   Within PRD §6.1 target ≤256B. Canonical owner moves to `bazaar-sla` in
   M1 per plan; inline duplication here is acceptable for M0.
10. ⚠️ **Event payloads.** See M1 above — events omit SLA data. Flagged,
    not blocking.
11. ✅ **Reactivation / deactivation guards.** Both paths
    `require!` the pre-condition (`is_active` / `!is_active`) before mutating,
    with dedicated error codes (`AlreadyInactive` / `AlreadyActive`).
12. ✅ **`jobs_completed` mutation surface.** Set to 0 on create; no write
    path in update / deactivate / reactivate. Registry cannot mutate the
    counter — escrow CPI in M1 is the intended write path. Template for
    M1: escrow must not be able to reach `ServiceListing` without a
    signer-scoped CPI interface that auditor reviews separately.

**Additional observations (informational):**

- **O1.** `Anchor.toml` declares the workspace with all four member crates
  (`bazaar-registry`, `bazaar-escrow`, `bazaar-sla`, `bazaar-evaluator`).
  Verify the three M1 crates still compile as empty `lib.rs` stubs or
  that they exist on the branch. `anchor build` green per anchor-eng's
  STATUS entry, so this is observationally OK.
- **O2.** `declare_id!` matches `programs.localnet.bazaar_registry` in
  `Anchor.toml` (`GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd`). Keep
  this in sync when devnet deploy lands in Task #4.
- **O3.** ADR-0001 documents the SBF toolchain pins. Pins are cosmetic
  from a security standpoint (they hold transitive crates at
  rustc-1.79-compatible versions) but worth re-reviewing every time
  `programs/Cargo.lock` is regenerated — any drift that silently upgrades
  `blake3` / `indexmap` / `proc-macro-crate` / `unicode-segmentation`
  will break the build. `scripts/pin-sbf-toolchain-deps.sh` is idempotent.
- **O4.** No CPI in this program, so re-entrancy N/A. Flag for escrow (M1):
  any CPI into registry to bump `jobs_completed` must be signer-gated to
  the escrow PDA and must use a dedicated instruction with a narrow
  Accounts struct — do not expose a generic "increment" endpoint.

**Recommended fixes (for anchor-eng follow-up, ordered by urgency):**

1. **Before M1 indexer work:** add `sla_params` to
   `ServiceListingCreated` and either add `new_sla` to `ServiceListingUpdated`
   or split into finer-grained events (M1, L2).
2. **Before SDK publish:** rename `price_lamports` → `price_base_units`
   (or equivalent) throughout the program + IDL + any downstream types (M2).
3. **Low-priority cleanup:** early-return on no-op `update_service` (L1);
   decide SATI agent-id semantics (L3).

None of these block PR #2 merging for M0. They're tracked here for the
anchor-eng / sdk-eng / backend-eng handoff as M1 kicks off.
