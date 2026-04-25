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

---

## PR #12 — feature/sdk-idl-codegen — 2026-04-24
**Verdict:** APPROVED (with one Medium finding — hardening recommended before
`@agentbazaar/idl` ships to npm; non-blocking for M0 internal use)

**Scope of review:**
- `packages/idl/scripts/codegen.mjs` (new, +54) — IDL JSON → TS emitter
- `packages/idl/src/metadata-schema.ts` (new, +36) — Zod schema + SHA-256 helper
- `packages/idl/src/generated/bazaar-registry.ts` (new, +11) — generated IDL const
- `packages/idl/src/generated/index.ts` (new, +1) — re-export
- `packages/idl/src/index.ts` (+3) — public surface
- `packages/idl/package.json` (+13 / -1) — deps (`@coral-xyz/anchor 0.31.1`,
  `zod ^3.23.8`, `vitest ^2.0.0`)
- `packages/idl/src/tests/idl-snapshot.test.ts` (new, +119) + snapshot
- `.gitignore` flip — generated IDL TS is now git-tracked (consumers skip
  codegen step)

No on-chain scope. No escrow / vault / PDA / admin-key logic touched.

**Findings:**

- **Critical:** none.
- **High:** none.

- **Medium:**
  - **M1. Template injection risk in `scripts/codegen.mjs` via
    `idl.metadata.name`.** The script reads the JSON, extracts
    `idl.metadata?.name` into `programName`, then interpolates the
    PascalCased form into TS template literals AND uses the kebab form
    as the output filename (both unescaped). Current threat model is
    safe — IDLs come from `anchor build` inside `programs/`, which is
    controlled by repo maintainers. But three compounding concerns:

    1. **Path traversal on the output file.** `kebabName` only replaces
       `_` → `-`; `/`, `..`, and control chars pass through. A
       `metadata.name` of `"../../evil"` resolves via
       `path.join(generatedDir, "../../evil.ts")` and writes a file
       **outside** `src/generated/`. `path.join` normalizes `..`; it
       does not reject escape.
    2. **Template break-out on the generated TS.** `typeName` is
       interpolated inside the `import type { ${typeName} } from ...;`
       line. A crafted `metadata.name` (e.g., containing `}` and a
       newline) can end the `import type` block and append sibling
       statements. TS syntax is constraining enough that turning this
       into a valid-compiling payload is fiddly, but `tsc` is not a
       security boundary — if consumer CI runs codegen over an
       attacker-supplied IDL, the emitted `.ts` can contain arbitrary
       imports that resolve when the downstream JS is executed.
    3. **The codegen script ships to npm.** `package.json` lists
       `"files": ["idl", "scripts", "src"]`, so `scripts/codegen.mjs`
       is distributed. Downstream consumers running `pnpm codegen`
       against an untrusted IDL inherit this vector.

    **Recommended fix (one-line):** at the top of the loop, assert
    `programName` matches a safe regex:
    ```js
    if (!/^[a-z][a-z0-9_]*$/.test(programName)) {
      throw new Error(`Refusing to codegen: unsafe program name ${JSON.stringify(programName)}`);
    }
    ```
    Closes both path traversal and template injection with a single
    guard. Takes ~2 minutes; sdk-eng can fold into the next PR or a
    dedicated follow-up.

- **Low:**
  - **L1. `MetadataSchema.capability` has no upper length bound.**
    `z.string().min(1)` — an adversarial metadata payload could carry a
    10 MB capability string, which then passes through
    `TextEncoder.encode` + `crypto.subtle.digest`. Mild DOS vector for
    anything indexing arbitrary metadata URIs. Add `.max(256)` (or
    similar, PRD-aligned) to match the discipline applied to
    `name` / `description`.
  - **L2. `avatar: z.string().url()` accepts non-http(s) schemes.** Zod's
    `.url()` delegates to `new URL(value)`, which accepts `javascript:`,
    `data:`, `file:`, `blob:`, etc. Not an SDK-layer vulnerability
    (the URL is just stored/passed through), but a clear foot-gun for
    frontend-eng when the dashboard later renders the avatar. Tighten
    to `.refine((u) => u.startsWith("https://"))` at the schema, or
    enforce at render time. Flag for **frontend-eng** regardless so it
    doesn't slip into a `<img src={avatar}>` with a data-URL SVG
    XSS payload.
  - **L3. Import attribute syntax `with { type: 'json' }`** (TS 5.3+,
    Node 22+). Older toolchains parse this as a syntax error. MVP
    targets Node 20+ per CLAUDE.md; noted for portability only — if
    the SDK needs to support Node 18 LTS later, swap back to
    `assert { type: 'json' }` or drop the attribute and use a runtime
    JSON import. Not a security issue.

**Focus-area verdicts (sdk-eng's questions):**

1. ✅ **`z.record(z.string(), z.unknown())` prototype-pollution risk.**
   Zod patched prototype pollution in `z.record()` and `z.object()`
   in 3.22.3 (CVE-2023-4316). `package.json` requires `^3.23.8`;
   `pnpm-lock.yaml` resolves to **3.25.76** — comfortably post-fix.
   `z.record()` filters `__proto__` / `constructor` / `prototype` at
   parse time. No runtime escalation path through `custom`.

   *Regression guard I'd still ship:* a unit test that feeds
   `{ __proto__: { polluted: true }, ...rest }` through
   `MetadataSchema.parse` and then asserts `({}).polluted === undefined`.
   Cheap, catches any future Zod downgrade or replacement.

2. ⚠️ **`scripts/codegen.mjs` arbitrary code execution vector.** No
   `eval`, no dynamic `require`, no `child_process`, no network calls
   — confirmed by grep. Safe at build time for trusted IDLs. But see
   **M1** above — a malicious IDL can still produce a malicious output
   file via template injection and/or write outside `src/generated/`
   via path traversal. Threat realized only if consumer CI points the
   script at an untrusted IDL, which becomes relevant once the package
   ships to npm.

3. ✅ **`computeCapabilityHash` crypto.** Uses `crypto.subtle.digest('SHA-256', ...)`
   from the Web Crypto API, `TextEncoder` for input encoding, returns
   a `Uint8Array(32)`. No custom crypto, no key material, no nonces.
   The output is deterministic and byte-for-byte compatible with the
   Rust program's `[u8; 32]` expectation. `crypto.subtle` is global in
   Node 20+ and all target browsers. Covered by three positive unit
   tests (shape, determinism, known-digest SHA-256(`""`)).

4. ✅ **Generated `as unknown as BazaarRegistry` cast.** Type-level
   only; no runtime effect. `idlJson` is imported via static JSON
   import attribute, which gives the runtime a plain object — the
   cast just silences TS's structural mismatch between the freshly
   imported JSON object type and the Anchor IDL interface. No eval,
   no Function constructor, no implicit coercion. Safe.

**Additional observations (informational):**

- **O1.** Lockfile jumped by 1412 lines — expected (first time Zod,
  Anchor, Vitest, and their deps are pulled into `packages/idl`).
  Spot-checked: `@coral-xyz/anchor 0.31.1` matches `programs/`
  Anchor version, `zod 3.25.76` is post-CVE-2023-4316, `vitest 2.1.9`
  is current. Nothing unusual in the transitive closure on quick
  inspection.
- **O2.** Generated TS files are now git-tracked (`.gitignore` delta
  excludes `packages/idl/src/generated` from the ignore list). Good
  call for published packages — consumers avoid a post-install
  codegen step and get deterministic types. But: **the snapshot test
  becomes the only drift guard** between `idl/bazaar_registry.json`
  and `src/generated/*.ts`. If a developer edits one without running
  codegen + updating the snapshot, CI catches it. Intent confirmed
  from the test name ("catches accidental IDL drift").
- **O3.** `M2` from **PR #2** (rename `price_lamports`) is not fixed
  here — the IDL still carries `priceLamports`. Confirmed scope: this
  PR is pure SDK plumbing; the rename lives on the anchor-eng side
  and will propagate via `pnpm sync` + re-codegen.
- **O4.** Tests cover the happy path + key rejections on the schema
  and three properties on the hash helper. Good coverage for Task #6
  scope. **M1 above is not covered** — no test exercises codegen
  with a hostile IDL. If the hardening fix lands, pair it with a
  test that passes a name like `"../evil"` and asserts codegen
  throws.
- **O5.** No `node:child_process`, no `eval`, no `Function(...)`, no
  dynamic `import()` with user input, no `vm.runInThisContext` —
  all checked via grep of `packages/idl/`. The only dynamic pieces
  are `JSON.parse` and template-literal string building, which are
  covered by M1 / focus-area 2.

**Recommended fixes (for sdk-eng follow-up, ordered by urgency):**

1. **Before `npm publish` of `@agentbazaar/idl` (M1-era):** add the
   `programName` regex guard in `scripts/codegen.mjs` (M1). Single
   line + a regression test that asserts codegen throws on a crafted
   IDL.
2. **Before frontend-eng consumes metadata:** restrict
   `MetadataSchema.avatar` to `https:` URLs or ensure the dashboard
   sanitizes on render (L2). Coordinate across SDK + frontend.
3. **Nice-to-have:** add `.max(256)` on `capability` (L1); add the
   prototype-pollution regression test on `custom` (focus-area 1).

None of these block PR #12 merging for M0. The package is not yet
published and the trust boundary today is "repo maintainer controls
the IDL"; hardening becomes urgent at the `npm publish` step.

### Follow-up — 2026-04-24 re-review (commit `a53ffa5`)

**Status:** all four findings addressed. **Verdict upgraded to
APPROVED — RELEASE-READY.**

sdk-eng landed `fix(idl): address security-auditor findings on PR #12`
(`a53ffa5`) with the exact hardening the M1 release-gate called for.
Diff re-walked:

- **M1 — codegen template injection / path traversal → FIXED.**
  `scripts/codegen.mjs` now has `assertSafeProgramName(name)` guarding
  the regex `/^[a-z][a-z0-9_]*$/`, invoked **after** `programName` is
  derived and **before** any filename construction or template
  interpolation. The regex is the one I recommended. Both failure
  modes close: (a) path traversal — `/` is rejected, so
  `path.join(generatedDir, "${kebabName}.ts")` cannot escape
  `src/generated/`; (b) template break-out — no newlines, no `}`,
  no quotes, no backticks can land inside the generated
  `import type { ${typeName} }` line.
- **L1 — `capability` unbounded → FIXED.** `.min(1).max(256)` on the
  Zod field. `TextEncoder` input is now bounded; the
  `computeCapabilityHash` DOS surface closes.
- **L2 — `avatar` non-https schemes → FIXED.** Chained `.url()` with
  `.refine((u) => u.startsWith('https://'), 'Avatar must use HTTPS')`.
  Rejects `javascript:`, `data:`, `http:`, `file:`, `blob:` etc. at
  parse time. The frontend-eng handoff note still stands as
  defense-in-depth (sanitize at render anyway), but the schema is
  now the first line of defense.
- **Focus-area 1 regression test — LANDED.** New
  `prototype pollution regression — __proto__ in custom is stripped
  by Zod (CVE-2023-4316)` asserts both `({}).polluted === undefined`
  and `!Object.hasOwn(result.custom ?? {}, '__proto__')`. Catches
  any future Zod downgrade or swap to a parser that lacks the fix.

**New tests verified:**
- `codegen: program name safety` suite with three cases (valid,
  path-traversal, template-injection) — mirrors
  `assertSafeProgramName` via a `SAFE_NAME` constant with an explicit
  sync comment.
- `rejects capability longer than 256 chars`.
- `rejects non-https avatar schemes (javascript:, data:, http:)`.
- Prototype pollution regression (above).

**One minor observation on the regression guard setup:**
- **O6.** The program-name safety suite mirrors the regex via a
  local `SAFE_NAME` constant with a "must stay in sync" comment
  rather than importing `assertSafeProgramName` from the codegen
  script. If the production regex ever tightens (e.g. to forbid
  leading digits more explicitly) and the test copy lags, the test
  suite keeps passing while the real guard changes. Low-priority
  improvement: export `assertSafeProgramName` from `codegen.mjs` and
  import it in the test, OR add an end-to-end test that spawns the
  script in a tmpdir with a crafted IDL and asserts non-zero exit.
  Not blocking; noted for a future tightening pass.

**M2 from PR #2** (`price_lamports` rename) remains open and is
anchor-eng's to land; sdk-eng's snapshot test will catch the IDL
drift when it happens. No action needed on PR #12.

**Release gate:** cleared. `@agentbazaar/idl` is safe to publish to
npm from a security standpoint (modulo the usual `npm publish`
hygiene — 2FA, provenance, no leaked `.env`).
