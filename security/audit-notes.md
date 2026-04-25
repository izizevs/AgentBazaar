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

---

## PR #15 — feature/sdk-skeleton — 2026-04-24 (light audit)
**Verdict:** APPROVED.

Pure scaffolding PR — no on-chain code, no escrow, no key handling, no
admin surface. All eight public methods are stubs that throw
`NotImplementedError`. Light audit per sdk-eng's request.

**Scope walked:**
- `packages/sdk/src/client.ts` (+104) — `AgentBazaar` class shell
- `packages/sdk/src/errors.ts` (+36) — error hierarchy
- `packages/sdk/src/types.ts` (+109) — input/result interfaces
- `packages/sdk/src/index.ts` (+23) — public surface re-exports
- `packages/sdk/package.json` (+49) — deps, exports, publishConfig
- `packages/sdk/tsup.config.ts` (+10) — dual ESM/CJS + `.d.ts` build
- `packages/sdk/tests/client.test.ts` (+72) — 13 unit tests
- `pnpm-lock.yaml` (+605) — new transitive closure

**Findings:** none at any severity.

**Five focus-area answers (sdk-eng's list):**

1. ✅ **Public surface is clean.** `src/index.ts` re-exports only the
   `AgentBazaar` class, the two config types (`AgentBazaarConfig`,
   `AnchorWallet`), seven error classes, and the ten input/result
   interfaces from `types.ts`. No RPC keys, secrets, env reads,
   or internal helpers escape. `package.json` `files: ["dist"]`
   ships only the built artifacts — source tree stays private.
   `publishConfig.access: public` is correct for a published
   `@agentbazaar/sdk`.

2. ✅ **New deps clean.**
   - `@solana/web3.js` at `^1.95.0` → lockfile resolves to
     **1.98.4** (current stable 1.x line).
   - `tsup` at `^8.5.1` → lockfile resolves to **8.5.1**
     (build-time only, devDependency).
   - `@coral-xyz/anchor 0.31.1` matches the version used by
     `packages/idl` and `programs/` — no duplicate Anchor runtime.
   - `@coral-xyz/anchor` and `@solana/web3.js` also declared as
     `peerDependencies` — good practice; avoids dual instances
     when the consumer pins its own version.
   - `zod ^3.23.8` → resolves to `3.25.76`, comfortably post-CVE-2023-4316
     (inherited from `packages/idl`'s audit).
   - No new runtime deps beyond the four above; transitive closure
     is the standard web3.js/anchor/tsup trees.

3. ✅ **`AnchorWallet` interface is structural, not nominal.**
   Defines `publicKey`, `signTransaction`, `signAllTransactions` as
   a plain TS interface — any wallet-adapter, `NodeWallet`, or custom
   signer matches duck-typed. No `instanceof NodeWallet` gate, no
   prototype-chain dependency, no concrete class import. This is
   the right shape — consumers are not forced to bring in Anchor's
   `NodeWallet` (which pulls `fs` / keypair-file loading).

4. ✅ **Error hierarchy — `new.target.name` is safe.**
   `new.target` is an ES2015 meta-property that returns the
   constructor function used with `new`; `.name` is the static
   function name defined at class-declaration time. It is NOT
   runtime-evaluated user input, so there is no injection vector.
   The pattern is the standard way to avoid `this.name` ending up
   as `"Error"` after minification or subclassing. Subclasses
   correctly rely on `new.target.name` from the base (checked —
   no subclass re-declares `name`). `TransactionFailedError` adds
   a public `signature?: string` field — signatures are public by
   definition; safe to expose.

5. ✅ **tsup build + no install-time scripts.**
   `tsup` emits to `dist/` which is `.gitignore`'d at the repo root
   (confirmed). `package.json` `scripts`: `build`, `dev`, `test`,
   `typecheck`, `lint` — none run at `npm install` (no
   `preinstall` / `install` / `postinstall` / `prepublish`). Build
   runs via `tsup` which uses esbuild; no custom plugins that
   execute during the publish pipeline. `tsup.config.ts` uses only
   documented options (`entry`, `format`, `dts`, `clean`,
   `sourcemap`, `treeshake`) — nothing suspicious.

**Additional observations (informational):**

- **O1.** Constructor accepts `rpc: string | Connection`. Untrusted
  strings would construct a `Connection` against an attacker chosen
  endpoint. This is standard "trust your config" territory — expected
  design for any Solana client library. Not a finding; noted so that
  dashboard / backend wrappers downstream are aware that the RPC URL
  flows through here unvalidated.
- **O2.** `Connection(rpc, 'confirmed')` hard-codes the commitment
  level. For the MVP this is fine; when the SDK fleshes out,
  consider surfacing a `commitment` option in `AgentBazaarConfig`
  so consumers can opt into `'finalized'` for high-value flows
  (e.g. escrow release) while keeping `'confirmed'` for discovery.
  Not a security issue, just a note for the impl phase.
- **O3.** Tests cover constructor shapes, stub throws, and error
  subclass `instanceof` chain. Good breadth for a skeleton. When
  implementations land, the test plan should grow to cover the
  actual tx-building logic — flag for qa-test-eng in M1.
- **O4.** The `@agentbazaar/idl` dep is `workspace:*` — correct
  for monorepo linking and will be pinned to a concrete version
  at publish time via pnpm. No action.
- **O5.** `tests/client.test.ts` constructs `new Connection(TEST_RPC)`
  with `https://api.devnet.solana.com` as the URL. The constructor
  doesn't actually open a socket (it's lazy); unit tests stay
  hermetic. Confirmed no `.request` / `.getLatestBlockhash` etc.
  during tests. Good.

**Template for implementation-phase audits (M0 → M1):** when the
stubs get filled in, each method body will need its own walk —
especially `register` (Pinata upload + capability-hash derivation +
register_service CPI), `hire` (escrow create + USDC transfer), and
`confirm` / `claimTimeout` / `dispute` (escrow release paths). Those
will be the substantive audits; this one establishes the perimeter.

No blocker. Cleared to merge.

---

## PR #17 — feature/sdk-register-impl — 2026-04-25
**Verdict:** APPROVED (with two Medium and four Low non-blocking findings;
two of the Mediums should land before any mainnet flow).

First substantive method-body audit per the M0 plan. `AgentBazaar.register()`
glues Pinata IPFS upload, capability-hash derivation, PDA derivation,
duplicate-listing guard, ix construction, and tx send-with-retry.

**Scope of review:**
- `packages/sdk/src/register.ts` (new, +186) — main flow
- `packages/sdk/src/client.ts` (+19 / -5) — adds `pinataJwt` to config + wires register
- `packages/sdk/src/types.ts` (+10 / -2) — extends `RegisterInput` with metadata fields
- `packages/sdk/tests/register.test.ts` (new, +393) — 18 unit tests
- `packages/sdk/package.json` (+2) — adds `bn.js` direct dep
- `pnpm-lock.yaml` (+17 / -4) — minimal lockfile delta

**Findings:**

- **Critical:** none.
- **High:** none.

- **Medium:**
  - **M1. `endpoint` field bypasses MetadataSchema validation.** The
    flow validates via `MetadataSchema.safeParse({ name, description,
    capability, avatar, custom })` (step 1), then in step 6 builds
    `fullMetadata = { ...parseResult.data, endpoint: input.endpoint }`
    and uploads that. The schema does **not** include `endpoint`, so
    `input.endpoint` lands in the public metadata JSON unvalidated.
    Same threat surface as the L2 we patched on PR #12 for `avatar`:
    a malicious agent can register with a `javascript:` /
    `data:text/html,...` / `file://` / megabyte-long endpoint that
    later gets rendered or dereferenced by the dashboard / a hiring
    consumer. An HTTPS endpoint is the only sensible value here.
    **Fix:** add `endpoint: z.string().url().refine(u => u.startsWith('https://'), 'Endpoint must use HTTPS').max(256)`
    to `MetadataSchema` in `packages/idl/src/metadata-schema.ts`,
    OR keep the schema unchanged and validate inline before the upload
    in `register.ts`. The schema route is cleaner — same place the
    avatar guard lives. Non-blocking for devnet integration; blocker
    for mainnet.
  - **M2. `confirmTransaction` result not checked for `value.err`.**
    Step 9 awaits `confirmTransaction({ signature, blockhash,
    lastValidBlockHeight }, 'confirmed')` and immediately returns
    `{ listing, signature }`. `confirmTransaction` resolves
    successfully even when the on-chain instruction reverted —
    `result.value.err` is non-null but ignored. As a result, an
    on-chain failure (program rejecting `InvalidPricingModel` /
    `MetadataUriTooLong` / `InvalidUptimePct` / etc.) is reported to
    the caller as a successful registration with a valid PDA
    address, even though the listing was never created. Worse, the
    retry loop doesn't re-attempt because the outer `try` catches
    only thrown errors, not `value.err`. **Fix:**
    ```ts
    const result = await connection.confirmTransaction({...}, 'confirmed');
    if (result.value.err) {
      throw new TransactionFailedError(
        `Program error: ${JSON.stringify(result.value.err)}`,
        signature,
      );
    }
    ```
    Ideally also parse Anchor program errors via `AnchorError.parse`
    so the user sees `MetadataUriTooLong` instead of an opaque
    `{ InstructionError: [0, { Custom: 6002 }] }`. Non-blocking for
    devnet sandbox testing; blocker for mainnet.

- **Low:**
  - **L1. `requireAllSignatures: false` on serialize is unnecessary.**
    The PR body's rationale conflates two flags: `verifySignatures: false`
    is the redundancy with on-chain Ed25519 verification (correct),
    but `requireAllSignatures: false` is independent — it disables the
    "all required signers present" check at serialize time. With one
    signer (`feePayer = wallet.publicKey`), `wallet.signTransaction`
    should always return a fully-signed tx. Setting this to `false`
    only loses an early-fail signal if the wallet returns an unsigned
    or partially-signed tx (e.g., user denied in a modal). Keep
    `verifySignatures: false`; flip `requireAllSignatures` to its
    `true` default for clearer errors.
  - **L2. No range check on `priceUsdc` / `satiAgentId` against u64
    bounds.** Both come in as `bigint` and flow into `new BN(value.toString())`.
    A negative value or one > `2^64 - 1` would either silently
    truncate or trip Anchor's borsh codec with a confusing low-level
    error. Add a guard:
    ```ts
    const U64_MAX = 2n ** 64n - 1n;
    if (input.priceUsdc < 0n || input.priceUsdc > U64_MAX) {
      throw new ValidationError('priceUsdc out of u64 range');
    }
    ```
    Same for `satiAgentId`.
  - **L3. `pinataJwt` is a public enumerable property on the client.**
    `class AgentBazaar { readonly pinataJwt: string | undefined; ... }` —
    accidental `console.log(client)` / `JSON.stringify(client)` /
    error-reporter capturing class instances would leak the JWT.
    Migrate to a `#pinataJwt` private class field, OR mark it
    non-enumerable, OR pass via a closure (e.g.,
    `getPinataJwt: () => string`). Cheap fix; meaningful in a tooling
    setup that captures full state on errors.
  - **L4. Race between duplicate-check and `init`.** Step 5 reads
    `program.account.serviceListing.fetchNullable(listingPda)`; step 8+9
    sends a tx that `init`s the same PDA. If a competing register
    races between the two, the on-chain `init` constraint fails —
    but the user sees a `TransactionFailedError` from the retry loop
    rather than the meaningful `DuplicateListingError`. With M2's fix,
    the on-chain error code (account already in use → `0x0`) becomes
    visible and could be mapped to `DuplicateListingError` for
    consistency. Tiny race window; cosmetic.

**Six focus-area answers (sdk-eng's list):**

1. ✅ **Pinata JWT — no leakage paths found.** JWT flows
   `AgentBazaarConfig.pinataJwt` → `AgentBazaar.pinataJwt` →
   `registerService(...pinataJwt)` → `uploadMetadata(...pinataJwt)`.
   In `uploadMetadata` it appears only in
   `headers: { Authorization: \`Bearer ${pinataJwt}\` }` — sent to
   Pinata, never to Solana RPC. No `console.log`, no error message
   includes the JWT. Three Pinata error paths
   (`Pinata upload failed: ${status}`, `missing data.cid`, `CID too
   long`) all interpolate only safe metadata. Retry loop's
   `lastError.message` only catches errors from `signTransaction` /
   `sendRawTransaction` / `confirmTransaction` — none of which see
   the JWT. **L3 above** is the only adjacent concern: the JWT is
   stored as a public property on the client, so accidental
   serialization of the client object would leak it. The actual
   data flow is clean.
2. ⚠️ **`requireAllSignatures: false` — see L1.** The
   `verifySignatures: false` half is correct (redundant with on-chain
   verification). The `requireAllSignatures: false` half is a
   separate flag with no rationale that holds; flip it back to the
   default.
3. ✅ **`MetadataSchema.safeParse()` validates before upload — but
   incompletely.** The validation runs in step 1, before any IPFS
   call or on-chain interaction (good). However the uploaded payload
   in step 6 spreads `parseResult.data` and then **adds `endpoint`
   from the unvalidated input** (M1). So the *fields covered by the
   schema* are validated correctly; `endpoint` is the gap.
4. ✅ **CID length guard ≤64 chars.** Matches the on-chain
   `MAX_METADATA_URI = 64`. CIDs are ASCII (base32/base58) so 1 char
   = 1 byte; the on-chain `String` byte-length check will agree.
   Test covers the 65-char rejection. Good.
5. ✅ **`wallet as any` cast is functionally safe.** `AnchorProvider`
   internally only reads `publicKey` and calls `signTransaction` /
   `signAllTransactions` — all three are present on `AnchorWallet`.
   The missing field is `payer: Keypair`, which Anchor only touches
   if you call `provider.wallet.payer` directly (we don't). The
   `as any` could be tightened to
   `wallet as unknown as anchor.Wallet` for narrower scope, but the
   current form is honest about the bypass. No security impact.
6. ✅ **`bn.js` direct dep is correct.** Anchor already depends on
   `bn.js` transitively; declaring it directly removes the implicit
   coupling. Usage:
   `new BN(input.satiAgentId.toString())` — bigint → decimal string
   → BN. Correct shape; `BN` accepts decimal-digit strings of any
   length. **L2 above** flags the missing range check (BN itself is
   arbitrary-precision, so won't throw on overflow until borsh
   serialization).

**Additional observations (informational):**

- **O1.** Pinata upload happens *after* the duplicate-listing guard
  (step 5 → step 6). Good — saves a wasted IPFS upload on the
  duplicate-already-exists case. Non-trivial improvement over the
  alternative ordering; nice.
- **O2.** Retry loop calls `wallet.signTransaction(tx)` on every
  attempt. Required because each retry uses a fresh `recentBlockhash`,
  so the prior signature would be invalid. UX consequence: hardware
  wallets prompt up to 3 times. Not a security issue — flagged for
  the dashboard team to set the user expectation.
- **O3.** Tests fully mock `@coral-xyz/anchor` (`AnchorProvider`,
  `Program`). That isolates the tests from the IDL but means the
  ix arg encoding (capability_hash byte order, BN → u64) is **not**
  exercised end-to-end in this PR. The IDL snapshot test in
  `packages/idl` covers IDL drift, but the encoder path isn't
  covered until an integration test against `solana-test-validator`
  lands. Flag for **qa-test-eng** in M0 wrap-up — coverage gap, not
  a finding.
- **O4.** `vi.stubGlobal('fetch', mockFetch)` without a corresponding
  `vi.unstubAllGlobals()` in cleanup. With Vitest's default
  `restoreMocks: false`, the global `fetch` stub bleeds across files
  if other suites are added later. Defense-in-depth: add
  `afterEach(() => vi.unstubAllGlobals())`. Hygiene, not a security
  issue.
- **O5.** `priorityFee` escalation tops at 500 000 µL/CU. With a
  ~200K CU budget, that's 100M µL = 0.0001 SOL — negligible. No
  abuse vector.
- **O6.** Tests cover: validation rejection, Pinata error paths
  (non-OK status, missing CID, oversized CID, Bearer header
  presence), duplicate guard (active vs inactive), happy path with
  full metadata round-trip, deterministic PDA derivation, retry
  succeeding on 2nd attempt, all-3-fail → `TransactionFailedError`,
  priority-fee escalation visible in instruction list, integration
  with `AgentBazaar` client (NotImplementedError without
  `pinataJwt`). 18 tests is thorough for the contract this PR
  exposes; coverage is solid where it can be (everything except the
  Anchor codec and real validator interaction).

**Recommended fixes (for sdk-eng follow-up, ordered by urgency):**

1. **Before mainnet:** check `confirmTransaction.value.err` and
   throw `TransactionFailedError(signature)` (M2). On-chain reverts
   silently appearing as success is the most user-impactful gap.
2. **Before mainnet:** validate `endpoint` via the schema or
   inline (M1). Same reasoning as the avatar guard from PR #12.
3. **Soon:** flip `requireAllSignatures` back to `true` (L1);
   add u64 range check on `priceUsdc` / `satiAgentId` (L2);
   privatize `pinataJwt` (L3).
4. **Nice-to-have:** parse Anchor program errors and map
   "account already in use" to `DuplicateListingError` (L4 +
   companion to M2).

None of these block merging PR #17 for M0 devnet integration. The
transaction-confirmation-correctness gap (M2) and the unvalidated
endpoint (M1) are the two that should land before any real value
flows.

### Follow-up — 2026-04-25 re-review (commit `bcd0070`)

**Status:** all five addressed findings verified clean. **Verdict
upgraded to APPROVED — MAINNET-READY** for the `register()` flow
(modulo cross-PR M2 IDL rename and the usual mainnet pre-flight
checklist). L4 was cosmetic and remains open as a nice-to-have;
not gating.

sdk-eng landed `fix(sdk): address security-auditor M1/M2/L1/L2/L3
findings on register()` (`bcd0070`). Re-walked:

- **M1 — endpoint validation → FIXED.** `endpoint` is now a
  required field on `MetadataSchema`:
  ```ts
  endpoint: z.string().url().max(256)
    .refine((u) => u.startsWith('https://'), 'Endpoint must use HTTPS'),
  ```
  `register.ts` step 1 includes `endpoint: input.endpoint` in the
  parsed payload; step 7 uploads `parseResult.data` directly (no
  spread of unvalidated input). All pre-existing IDL test fixtures
  updated. New negative test in `idl-snapshot.test.ts` rejects
  `http://`, `javascript:`, `ftp://`; matching test in
  `register.test.ts` rejects the same set with `ValidationError`.
  Symmetry with the avatar guard from PR #12 is now exact.

- **M2 — confirmTransaction error check → FIXED.** Inside the
  retry loop's `try`:
  ```ts
  const result = await connection.confirmTransaction({...}, 'confirmed');
  if (result.value.err) {
    throw new TransactionFailedError(
      `Program error: ${JSON.stringify(result.value.err)}`,
      signature,
    );
  }
  ```
  On-chain reverts now throw inside `try`, caught by outer
  `catch`, advance `lastError`, and continue the retry loop.
  Deterministic on-chain failures will burn all 3 retry attempts
  before surfacing — UX cost, not correctness. Failure can no
  longer mask as success.

- **L1 — requireAllSignatures default → FIXED, even stricter.**
  Original recommendation: "keep `verifySignatures: false` for
  performance". sdk-eng dropped both options on
  `signed.serialize()`, restoring full defaults. Tiny CPU cost on
  a single-tx Ed25519 verify in exchange for catching
  missing/corrupt signatures before the network round-trip. Net
  positive. Test wallet mock now signs with the keypair so
  serialization succeeds with the stricter defaults.

- **L2 — u64 range checks → FIXED.** `U64_MAX = 2^64 - 1n`
  constant; both `priceUsdc` and `satiAgentId` are guarded
  (`< 0n || > U64_MAX → ValidationError`) before `BN` encoding.
  Two new tests cover negative `priceUsdc` and `priceUsdc = 2^64`.
  Coverage note: no negative test for `satiAgentId` — same code
  path; a parallel test would be a nice symmetry.

- **L3 — pinataJwt private → FIXED, with bonus.**
  `readonly #pinataJwt: string | undefined` (true ECMAScript
  private class field — invisible to `Object.keys` /
  `Object.entries` / `Reflect.ownKeys` / `JSON.stringify`).
  Bonus: `toJSON()` returns
  `{ wallet: { publicKey: this.wallet.publicKey.toBase58() } }`,
  which prevents Connection internals from causing circular-ref
  errors and limits disclosed surface to the public key.

**Test infrastructure fixes verified:**
- `vi.stubGlobal('fetch', mockFetch)` moved to `beforeEach` with
  `afterEach(() => vi.unstubAllGlobals())`. Matches O4 from the
  initial review. No cross-file stub leakage.
- `import { Transaction }` (value) for the runtime
  `tx instanceof Transaction` check.

**Remaining open items (not gating):**

- **L4 — duplicate-listing race.** Cosmetic. With M2 in place, the
  on-chain "account already in use" error is now visible in
  `result.value.err`; mapping that to `DuplicateListingError`
  would unify failure semantics. Fold into a future Anchor
  program-error parsing pass.
- **O3 from initial review — Anchor codec coverage.**
  `@coral-xyz/anchor` is still fully mocked, so capability_hash
  byte-order + BN→u64 borsh + IDL-arg shape aren't exercised
  end-to-end. Integration test against `solana-test-validator`
  is the gap; remains flagged for qa-test-eng in M0 wrap-up.
- **M2 from PR #2 — `price_lamports` IDL rename.** Still pending
  on anchor-eng. SDK already uses `priceUsdc` semantically; rename
  is program/IDL-side. Snapshot test will catch drift.

**Mainnet release-gate verdict (security side):** **CLEARED for
`register()` flow.** Remaining items are cosmetic / observability
/ cross-PR follow-ups; none expose a real-money risk on
`register_service` specifically. Future flows (`hire`, `confirm`,
`claimTimeout`, `dispute`) will each need their own audit walk
when they land.

---

## PR #19 — feature/sdk-discover-impl — 2026-04-25
**Verdict:** APPROVED (with one Medium and five Low non-blocking findings).
Read-only flow; no signing, no funds movement. The Medium (response
validation) is the only finding that has cross-tenant impact.

**Scope of review:**
- `packages/sdk/src/discover.ts` (new, +213) — Zod input → API path → RPC fallback → in-memory filter/sort
- `packages/sdk/src/client.ts` (+9 / -3) — adds `discoveryApiUrl` config + wires `discover()`
- `packages/sdk/src/errors.ts` (+6) — `DiscoveryAPIError`, `RPCFallbackFailedError`
- `packages/sdk/src/types.ts` (+4 / -2) — `DiscoverInput.sort` enum tightened to three values + `limit` field
- `packages/sdk/src/index.ts` (+2) — error re-exports
- `packages/sdk/tests/discover.test.ts` (new, +458) — unit tests

**Five focus-area answers (sdk-eng's checklist):**

1. ✅ **No user input → shell/path.** All `DiscoverInput` fields flow
   through `URL.searchParams.set(...)` (proper percent-encoding) or
   in-memory `Array.filter` / sort. No `child_process`, no `eval`,
   no `Function(...)`, no file I/O, no template-string interpolation
   into anything executable. Confirmed by grep of `discover.ts`.
2. ⚠️ **Error message data flow — mostly clean, one note (L1 below).**
   `DiscoveryAPIError` carries `${err.message}` for fetch failures
   (which can include the request URL with query string — currently
   only user filter values, low sensitivity) and `${res.status} ${res.statusText}`
   for non-OK responses (no body content). `RPCFallbackFailedError`
   carries `${err.message}` from the underlying RPC call — Anchor /
   web3.js error strings don't include wallet keys or signed data.
   No JWT in scope on this path. Defensive note: if any future change
   adds an auth token to the URL query string, error messages would
   leak it.
3. ✅ **`AbortSignal.timeout(10_000)` usage correct.** Modern API
   (Node 18+, Chrome 103+, all M0-target environments). Auto-aborts
   after 10s; the abort lands in the `try` and surfaces as a
   `DiscoveryAPIError`, triggering the RPC fallback. Clean.
4. ✅ **RPC fallback doesn't expose wallet/connection internals.**
   `fetchFromRPC` builds an `AnchorProvider` with the wallet, calls
   `program.account.serviceListing.all()` (read-only — translates to
   `connection.getProgramAccounts(programId, filters)`), and maps
   results. Wallet's `signTransaction` / `signAllTransactions` are
   never invoked. Wallet `publicKey` does flow into Anchor's
   provider but is not transmitted in the RPC payload (the request
   is purely program-account scan). No connection secrets exposed
   in returned data. **Side note (informational):** the wallet is
   *required* even for read-only discovery — UX cost for public
   browse pages, not a security finding.
5. ✅ **Zod schema covers `DiscoverInput` surface.** All six fields
   present and bounded:
   - `capability: z.string().max(256)` — matches PR #12 `MetadataSchema.capability` ceiling.
   - `minReputation: z.number().int().min(0).max(100)` — matches the doc range.
   - `maxPrice: z.bigint().nonnegative()` — sensible.
   - `maxLatency: z.number().int().positive()` — sensible.
   - `sort: z.enum(['price_asc', 'reputation_desc', 'latency_asc'])` — three options match `types.ts`.
   - `limit: z.number().int().min(1).max(200)` — `MAX_LIMIT = 200` constant.
   No drift between the type and the schema; nothing un-validated.

**Findings:**

- **Critical:** none.
- **High:** none.

- **Medium:**
  - **M1. Discovery API response is not validated.** `body = (await res.json()) as APIResponse`
    is a TypeScript-only assertion with **no runtime checks**. The
    body is then mapped directly into `ServiceProvider[]` and
    returned to the consumer. A compromised, misconfigured, or
    malicious Discovery API could deliver:
    - Adversarial `endpoint` strings (`javascript:alert(1)`,
      `data:text/html,…`, megabytes of garbage) — bypasses the
      schema discipline that `register()` applies at write time
      because the SDK doesn't re-validate at read time.
    - Invalid base58 in `entry.listing` / `entry.owner` — `new PublicKey(...)`
      throws `Error: Invalid public key input`, which escapes
      uncaught (not wrapped in `DiscoveryAPIError`).
    - Non-numeric `entry.priceUsdc` — `BigInt(...)` throws SyntaxError.
    - Out-of-range `reputation` (negative, >100) or `pricingModel` —
      passes through to consumers as a valid-looking number.
    - Massive `body.services` arrays — memory exhaustion before the
      `limit` slice would have applied (RPC path applies limit AFTER
      mapping, but the map itself materialises everything).

    Trust model today: AgentBazaar runs the API. But (a) compromise
    of the API exposes every SDK consumer at once, (b) a misconfigured
    `discoveryApiUrl` (dev pointing at a mock that responds with
    crafted data) gets the same attack surface, (c) the SDK is a
    public package and consumers can't rely on the API trust
    boundary in their own threat models.

    **Fix:** add a Zod schema for `APIServiceEntry` (matches the
    SDK's existing `ServiceProvider` shape) and `z.array(...).max(MAX_LIMIT)`
    for `body.services`. Validate before mapping; on failure, throw
    `DiscoveryAPIError(\`malformed response: …\`)` so the RPC
    fallback kicks in. Same approach as `MetadataSchema` does for
    the Pinata payload. Non-blocking for devnet; **high priority
    before mainnet** — the endpoint XSS angle is the same surface
    M1 from PR #17 and L2 from PR #12 closed at the write side.

- **Low:**
  - **L1. `new URL('/services', baseUrl)` is outside the `try`.**
    A malformed `discoveryApiUrl` raises a synchronous `TypeError`
    that escapes `discoverServices` uncaught. Result: the consumer
    gets a raw `TypeError`, the RPC fallback never triggers. Wrap
    URL construction in the existing try/catch, OR validate
    `discoveryApiUrl` at constructor time
    (`new URL(discoveryApiUrl)` to fail-fast).
  - **L2. `res.json()` parse errors bypass `DiscoveryAPIError`.**
    The `await res.json()` call is outside the try/catch and after
    the `if (!res.ok)` check. If the API returns 200 OK with HTML
    (typical when a load balancer serves an error page) or any
    non-JSON body, `.json()` throws SyntaxError and skips the RPC
    fallback. Move `res.json()` inside try/catch and throw
    `DiscoveryAPIError`.
  - **L3. `process.env.DISCOVERY_API_URL` may throw in browsers.**
    The default URL chain `discoveryApiUrl ?? process.env.DISCOVERY_API_URL ?? 'http://localhost:8787'`
    references `process` directly. Browser bundlers without a
    `process` shim throw `ReferenceError`. tsup's default config
    doesn't define `process` for ESM browser builds. Guard with
    `typeof process !== 'undefined' ? process.env?.DISCOVERY_API_URL : undefined`,
    or move env-reading to a build-time constant. Minor; SDK
    consumers running on Node are unaffected.
  - **L4. RPC fallback returns hex hash for `capability`, not the
    original string.** API path returns the human-readable string
    from off-chain metadata; RPC fallback returns
    `Buffer.from(capabilityHash).toString('hex')`. Same field name,
    semantically different value. A consumer doing
    `provider.capability === 'text-summarization'` works through
    the API, fails on fallback. Either: (a) document the difference
    on `ServiceProvider.capability`, (b) add a discriminator
    (`capabilitySource: 'api' | 'rpc'`), or (c) fetch metadata in
    fallback (network cost, defeats the fallback's resilience role).
    Cosmetic; can wait for the SDK-stability pass.
  - **L5. `endpoint: ''` in RPC fallback is ambiguous.** Empty
    string is indistinguishable from a (now-impossible, given PR
    #17 M1) registered-with-empty-endpoint listing. Either change
    `ServiceProvider.endpoint` to `string | undefined` and use
    `undefined`, or document the fallback semantic.

**Additional observations (informational):**

- **O1.** Wallet is required even for read-only discovery. UX
  consequence (public browse pages need a wallet); not a security
  finding. Possible future shape: accept `wallet?: AnchorWallet`
  and synthesize a read-only provider when omitted.
- **O2.** Cross-cutting carry-over from PR #17 M1 — the Discovery
  API trusts on-chain metadata_uri pointers to off-chain JSON.
  If a malicious agent registers via a bypass route (anything
  not going through our SDK), they could plant adversarial
  metadata. The Discovery API itself should re-validate
  metadata before serving. Flag for **backend-eng** when the
  indexer / API land in M1.
- **O3.** The `applyFiltersAndSort` function:
  - `out.filter((r) => r.isActive)` — first filter; correct.
  - `r.sla.maxLatencyMs == null || r.sla.maxLatencyMs <= maxMs` —
    treats unknown latency as acceptable. Defensible default,
    but worth noting: a malicious provider could omit
    `maxLatencyMs` to game the `maxLatency` filter and appear in
    results regardless. Consider documenting or flipping the
    default to "exclude unknown".
  - Sort comparators handle bigint correctly via `<` / `>`.
- **O4.** Tests cover 65/65 scenarios per sdk-eng's note. Good
  breadth. Coverage gap follows the same pattern as PR #17:
  Anchor codec / IDL-arg shape on the RPC path is mocked, so the
  end-to-end fallback against `solana-test-validator` isn't
  exercised. Same handoff to qa-test-eng.
- **O5.** Default URL `'http://localhost:8787'` is a developer
  convenience. Production consumers should always pass an
  explicit `discoveryApiUrl`. Worth documenting in the SDK
  README when it exists.

**Recommended fixes (for sdk-eng follow-up, ordered by urgency):**

1. **Before mainnet:** add Zod validation to the Discovery API
   response (M1). Mirror `MetadataSchema` discipline at the
   read boundary.
2. **Soon:** L1 (wrap URL construction), L2 (json parse →
   `DiscoveryAPIError`), L3 (browser-safe `process.env` guard).
3. **DX polish:** L4 (capability semantics across paths), L5
   (`endpoint` ambiguity), O1 (read-only wallet relaxation).

**Mainnet release-gate verdict (security side):**
**Devnet integration cleared.** Mainnet is gated on M1 — once
that lands, `discover()` is release-ready. None of the Lows
expose a real-money risk; they're DX/correctness improvements.

Future flows: `hire` (the substantial one — escrow + USDC
transfer), `confirm` / `claimTimeout` / `dispute` (release paths)
each need their own walk when they land.

### Follow-up — team-lead's targeted-review points (2026-04-25)

team-lead routed five specific check-points after this audit was
already filed. Cross-walking each against the existing findings
and surfacing two additional Lows the original walkthrough missed.

- **SSRF from `discoveryApiUrl` user-controlled config?** **Not in
  the SDK's threat model.** `discoveryApiUrl` is read once at
  `AgentBazaar` constructor time from
  `AgentBazaarConfig.discoveryApiUrl ?? process.env.DISCOVERY_API_URL ?? 'http://localhost:8787'` —
  not from any per-call user input on `discover()`. Threat surface
  matches `rpc` config: if a consuming application passes a URL
  from THEIR end-user (e.g., a "configure your indexer" form)
  through unvalidated, that's the embedder's responsibility —
  config-injection on their side, not SSRF in our code path. No
  SDK action; defensive note for the dashboard / wrapper-app
  design when those land.
- **Fetch timeout/retry — does `discover()` hang on a slow API?**
  No. `AbortSignal.timeout(10_000)` enforces a 10 s ceiling on
  the API path. There is **no retry** at the API level —
  intentional graceful degradation per PRD §8: one shot, fall
  through to RPC fallback on any `DiscoveryAPIError`. No
  retry-storm risk. Minor caveat: errors that aren't wrapped in
  `DiscoveryAPIError` (L1 URL ctor / L2 json parse) escape
  uncaught and skip the fallback.
- **RPC fallback `getProgramAccounts` filter / pagination?** New
  **L6** below — original walkthrough understated this.
- **Zod schema — `capability` length, URL/string injection via
  `sort`?** `capability: z.string().max(256)` matches PR #12's
  on-chain bound. `sort: z.enum(['price_asc', 'reputation_desc', 'latency_asc'])` —
  invalid strings rejected at parse time; no string-injection
  vector. ✅ Both already covered in focus-area 5.
- **`minReputation` + RPC fallback's hard-coded `reputation: 0` —
  silent zero-result?** Confirmed real; new **L7** below.

**Two additional Low findings:**

- **L6. RPC fallback does a full-table scan with no server-side
  filter or pagination.** Anchor's
  `program.account.serviceListing.all()` passes only the
  account-discriminator filter and returns every matching account.
  At MVP scale this is fine. Two scaling concerns:
  1. **Memory.** All listings are materialised into a
     `ServiceProvider[]` before `applyFiltersAndSort` slices to
     `limit`. A marketplace with 10k+ listings produces a heavy
     in-memory array per `discover()` call; a hot dashboard
     refresh path could OOM Cloudflare Workers' 128 MB ceiling.
  2. **RPC payload limit.** Solana RPC's default
     `getProgramAccounts` response cap is 5 MB; some providers
     (Helius paid tier) lift this, but a public RPC starts
     truncating or 503'ing past the limit.

  Both deferred in M0 because the marketplace is empty.
  **Fix path** when scale matters: pass filters via
  `program.account.serviceListing.all([{ memcmp: {...} }])` for
  the `capability_hash` exact match (cheapest filter), AND/OR add
  `dataSlice` to fetch only the first ~100 bytes for the filter
  pass. Long-term: lean on the indexer and treat RPC fallback as
  best-effort with a "showing first N" disclaimer.

- **L7. `minReputation` + RPC fallback → silent zero-results.**
  Per sdk-eng's documented design choice, RPC fallback hard-codes
  `reputation: 0` for every listing (the field isn't on-chain in
  M0). `applyFiltersAndSort` then filters
  `r.reputation >= input.minReputation`. Consequence:
  - `discover({ minReputation: 50 })` with API up: real matches.
  - Same call with API down → RPC fallback: returns `[]`,
    indistinguishable from "no providers match".

  **User sees an empty list and assumes nothing's available,
  when the data is just unrecoverable in fallback mode.**

  Recommended fix:
  1. **M0 short-term:** when `minReputation > 0` is set and the
     RPC fallback is taken, either (a) skip the `minReputation`
     filter and surface a flag/warning in the return value, or
     (b) throw a typed error (`DegradedDiscoveryError`?) so the
     caller can render "reputation filtering unavailable" UX.
  2. **M1:** once `bazaar-evaluator` stores reputation on-chain
     (M1 scope per CLAUDE.md), the fallback can read real data
     and the asymmetry disappears.

  Either way, document as a **known M0 gap** in the SDK README
  + PR changelog.

**No change to mainnet verdict.** L6 / L7 are Lows; neither
exposes a real-money risk. M1 (response Zod validation) remains
the single mainnet release-gate.

**Routing:** L6 informs the indexer / Discovery API design
(backend-eng's M1 work — server-side filtering must support
`capability_hash` memcmp at minimum). L7 informs both SDK README
+ dashboard UX (frontend-eng when they land).
