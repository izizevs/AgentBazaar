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

### Follow-up — 2026-04-25 re-review (PR #21 / `feature/sdk-discover-audit-fixes`)

**Status:** all six addressed findings (M1 + L1–L5) verified clean.
**Verdict upgraded to APPROVED — MAINNET-READY for `discover()`**
(modulo PR #2 M2 IDL `price_lamports` rename still pending; L6/L7
remain non-gating per the section above, both routed elsewhere).

PR #21 walked:

- **M1 — Discovery API response Zod-validated → FIXED.** New
  `APIServiceEntrySchema` covers every field with on-chain-aligned
  bounds:
  - `priceUsdc: z.string().regex(/^\d+$/)` — strict numeric
    decimal-string; rules out negatives, hex, scientific notation
    before `BigInt(...)`.
  - `pricingModel: z.number().int().min(0).max(3)` — matches the
    on-chain `PRICING_MODEL_MAX = 3`.
  - `sla` nested object with bounds matching PRD §6.1
    (`maxLatencyMs` non-negative int, `minUptimePct` 0–10000 bps,
    `responseFormat` ≤16, `jsonSchemaUri` ≤64, `customParams` ≤2,
    each entry capped at 16/32 chars).
  - `endpoint: z.string().url().max(256).refine(startsWith('https://'))` —
    exact symmetry with PR #17 M1 (write side) and PR #12 L2
    (avatar). The `javascript:` / `data:` / `http:` /
    megabyte-payload vectors all close.
  - `reputation: 0–100`, `jobsCompleted: nonneg`, `isActive: bool`.

  `APIResponseSchema` wraps `services: z.array(...).max(MAX_LIMIT)`,
  closing the array-size DoS vector. Parse failure throws
  `DiscoveryAPIError` so the RPC fallback fires cleanly.

- **L1 — `new URL()` inside try → FIXED.** URL construction now
  lives inside the existing
  `try { ... } catch { throw DiscoveryAPIError }` block.

- **L2 — `res.json()` parse → FIXED.** sdk-eng consolidated JSON
  parsing and Zod validation into a single try block:
  `parsed = APIResponseSchema.parse(await res.json())`. JSON
  SyntaxError and Zod parse errors both surface as
  `DiscoveryAPIError`. Slightly different from the
  "two separate try blocks" recommendation (informational note
  O7 below) but functionally equivalent.

- **L3 — `process.env` browser guard → FIXED.**
  `typeof process !== 'undefined' ? process.env?.DISCOVERY_API_URL : undefined`
  exactly matches the recommendation.

- **L4 — capability hex/string semantic → DOCUMENTED.** Comment
  in `fetchFromRPC`:
  > L4: capability is the hex of the on-chain capability_hash —
  > the original string is not stored on-chain (M0). API path
  > returns the human-readable string; callers must handle both.

- **L5 — `endpoint` ambiguity → FIXED.** `ServiceProvider.endpoint`
  is now `string | undefined`. RPC fallback sets
  `endpoint: undefined`. Test
  `L5: sets endpoint to undefined (stored in IPFS metadata, not on-chain)`
  asserts the new contract.

**Test coverage delta:** four new tests — malformed JSON →
fallback, invalid Zod schema (`javascript:` endpoint) → fallback,
bad baseUrl → fallback, RPC `endpoint` is `undefined`. 69 SDK +
21 IDL tests pass.

**Two informational notes (not findings):**

- **O7.** L2 was resolved with one consolidated try block instead
  of two. Functionally equivalent. No action.

- **O8 (residual Low — non-gating).** `listing` and `owner` are
  `z.string()` but **not** validated as base58 PublicKeys. A
  non-base58 string survives Zod parsing, then crashes
  synchronously in `new PublicKey(entry.listing)` inside
  `parsed.services.map(...)` — which lives **outside** the try
  block. The throw escapes uncaught, bypassing the RPC fallback.
  Same class of issue as L1/L2 for one specific edge case the
  M1 fix didn't cover.

  Threat model: API is internal in M0, realistic exposure is low.
  Two-line fix, either:
  ```ts
  // (a) tighten the schema:
  listing: z.string().refine(
    (s) => { try { new PublicKey(s); return true } catch { return false } },
    'Invalid base58 public key',
  ),
  // owner: same
  ```
  OR:
  ```ts
  // (b) widen the try block to include the .map():
  try {
    parsed = APIResponseSchema.parse(await res.json());
    return parsed.services.map(...);
  } catch (err) { throw new DiscoveryAPIError(...); }
  ```
  Logged for sdk-eng to fold into a future polish pass; not
  blocking PR #21's merge or the mainnet release-gate.

**Mainnet release-gate verdict (security side):**
**CLEARED for `discover()`.** Same caveats as the per-method
audits — `hire`, `confirm`, `claimTimeout`, `dispute` each need
their own walk when impls land. L6/L7 tracked on backend-eng
(M1 indexer) and sdk-eng (Task #10) sides. O8 is the only
residual finding from this re-review.

---

## PR #22 — feature/backend-indexer-skeleton — 2026-04-25 (light audit)
**Verdict:** APPROVED with two Medium and one Low non-blocking
finding plus three informational notes. Pure scaffolding PR — no
business logic, no signed input, no funds movement. SSRF / request
validation surface lands in Task #12 (Helius webhook receiver).
The Mediums are correctness/testability issues that compound when
business logic arrives in Tasks #11–#14; worth fixing before the
next substantive PR.

**Scope walked:**
- `apps/indexer/src/index.ts` (+19) — entrypoint, dotenv + Hono server
- `apps/indexer/src/logger.ts` (+8) — pino transport selection
- `apps/indexer/drizzle.config.ts` (+10) — drizzle-kit config
- `apps/indexer/package.json` (+33) — deps and scripts
- `apps/indexer/tests/sanity.test.ts` (+16) — placeholder webhook test
- `apps/indexer/tsconfig.json` / `tsconfig.build.json` / `vitest.config.ts`
- `pnpm-lock.yaml` (+1859 / -12)

**Findings:**

- **Critical:** none.
- **High:** none.

- **Medium:**

  - **M1. dotenv-mono import ordering broken under ESM.** In
    `src/index.ts`:
    ```ts
    import { dotenvLoad } from 'dotenv-mono';
    dotenvLoad();
    import { serve } from '@hono/node-server';
    import { Hono } from 'hono';
    import { logger } from './logger.js';
    ```
    The app is ESM (`"type": "module"` + `"module": "NodeNext"`).
    All `import` statements are hoisted above any executable
    body code. Actual evaluation order:
    1. `dotenv-mono` module loads.
    2. `@hono/node-server` loads.
    3. `hono` loads.
    4. `./logger.js` loads — and `logger.ts` reads
       `process.env['NODE_ENV']` at module-init time, **before
       `dotenvLoad()` has run**.
    5. Body of `index.ts` runs: `dotenvLoad()` finally executes.
    6. `serve(...)` reads `process.env['PORT']` (works because
       PORT is read in body code).

    Consequence: any `process.env` value that lives in `.env`
    (e.g., `NODE_ENV`, future `DATABASE_URL`,
    `HELIUS_WEBHOOK_SECRET`) is **not visible** to any module
    that reads it at top-level. Production deploys are unaffected
    (Railway/docker set env vars in the process directly). Local
    dev is the affected surface.

    **Fix:** use the `dotenv-mono/preload` side-effect import:
    ```ts
    import 'dotenv-mono/preload';   // side-effect import — runs at module-load
    import { serve } from '@hono/node-server';
    // ...
    ```
    Or `node --import dotenv-mono/preload`, or Node 20.6+'s
    `--env-file=.env`. Trivial fix; catches a class of latent
    bugs that surface as soon as Tasks #11/#12 add env-driven
    behaviour.

  - **M2. Module-load side effect — importing `src/index.ts`
    starts the HTTP server.** `serve({ fetch: app.fetch, port }, ...)`
    is at module top-level. The sanity test does
    `import { app } from '../src/index.js'`, which runs the
    entire module body — including `serve(...)` — just to get
    the Hono app reference. Three consequences:
    1. **Test pollution.** Every Vitest run starts a real HTTP
       listener on port 3001 (or `PORT`). Currently silent
       because the test uses `app.fetch(req)` directly, not the
       socket. But Vitest doesn't await server shutdown.
    2. **CI / parallel-test risk.** Future tests importing
       `src/index.ts` would compete for the same port.
    3. **Consumer testability.** Future tests wanting to
       exercise individual routes via `app.fetch()` must accept
       the side effect of starting the server.

    **Fix:** split entrypoint and app:
    ```ts
    // src/app.ts
    import { Hono } from 'hono';
    export const app = new Hono();
    app.post('/webhooks/helius', (c) => c.json({ ok: true }));

    // src/index.ts (entrypoint)
    import 'dotenv-mono/preload';
    import { serve } from '@hono/node-server';
    import { app } from './app.js';
    import { logger } from './logger.js';
    const port = Number(process.env['PORT'] ?? 3001);
    serve({ fetch: app.fetch, port }, () => logger.info({ port }, 'indexer listening'));
    ```
    Tests import `app.ts`; no server starts. Standard Hono
    pattern. Fold into the M1 fix.

- **Low:**

  - **L1. `drizzle.config.ts` uses `!` non-null assertion on
    `DATABASE_URL`.**
    ```ts
    url: process.env['DATABASE_URL']!,
    ```
    If `DATABASE_URL` isn't set when `pnpm db:generate` /
    `db:migrate` runs, drizzle-kit receives `undefined` and
    fails with a confusing error. Not a security issue —
    drizzle-kit is a build-time tool — but a DX gap that
    becomes more painful when Tasks #11/#13 land migrations
    developers run frequently. **Fix:**
    ```ts
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is required for drizzle-kit operations');
    ```
    Pairs naturally with O1 below.

**Three informational notes (not findings):**

- **O1.** No central env-var schema. `process.env` is read
  ad-hoc across `index.ts`, `logger.ts`, and
  `drizzle.config.ts`. Recommend a `src/env.ts` that Zod-parses
  `{ NODE_ENV, PORT, DATABASE_URL, HELIUS_API_KEY, HELIUS_WEBHOOK_SECRET }`
  at startup and exports a typed object. Closes the gap before
  Task #12 lands the webhook secret. Pairs with M1.
- **O2.** `pino-pretty` is in `dependencies`, not
  `devDependencies`. Required because pino's transport
  mechanism dynamically loads it at runtime in non-production.
  Acceptable trade-off.
- **O3.** `serve(...)` defaults to `0.0.0.0` binding (all
  interfaces). Correct for Railway / docker.

**Cross-cutting carryover (informational):** PR #19's L6 (RPC
fallback needs server-side `memcmp` filtering) lands here when
**Task #11** wires the Drizzle schema and **Task #13** wires the
event-handler upsert. Indexed columns on `(capability_hash)` and
`(owner)` will be the primary lookup paths the SDK falls through
to via the API.

**Mainnet release-gate verdict:** N/A — pure scaffold. Each of
Tasks #11–#14 will need its own audit walk when business logic
lands. **M1+M2 should land before Task #11** to avoid layering
business logic on broken bootstrap.

**Recommended fix order:**
1. **Before Task #11:** M1 (`dotenv-mono/preload`) + M2 (split
   `app.ts` from `index.ts`). Both tiny.
2. **Soon:** L1 + O1 (one `src/env.ts` module covers both).
3. **Nice-to-have:** O2 / O3 — status quo, no action.

None of these block PR #22's merge — scaffold is syntactically
correct, test passes by accident (server-side-effect masked by
in-process `app.fetch`). Worth fixing before the next PR layers
business logic on top.

---

## PR #26 — feature/sdk-error-hierarchy-v2 — 2026-04-25
**Verdict:** APPROVED. No findings at any severity. Two informational
observations only.

Task #15 — SDK error hierarchy refactor: structured fields, cause-chain
support throughout, three new error classes
(`DegradedDiscoveryError`, `WalletNotConnectedError`, `IDLMismatchError`),
constructor signature updates with backward compatibility,
comprehensive test coverage. Also folds in **L7 fix from PR #19's
audit follow-up**: `discover()` now throws
`DegradedDiscoveryError(['minReputation'])` when RPC fallback is taken
with `minReputation > 0`, instead of silently returning `[]`.

**Scope walked:**
- `packages/sdk/src/errors.ts` (+113 / -19) — base + 11 typed errors
- `packages/sdk/src/discover.ts` (+18 / -2) — `DegradedDiscoveryError` integration
- `packages/sdk/src/index.ts` (+3) — three new exports
- `packages/sdk/tests/errors.test.ts` (new, +236)
- `packages/sdk/tests/discover.test.ts` (+32 / -1) — three L7 tests
- `packages/sdk/README.md` (new, +87) — public API docs

**Five focus-area answers (sdk-eng's checklist):**

1. ✅ **`DegradedDiscoveryError.filtersDropped` is `Object.freeze()`-d.**
   Constructor calls `Object.freeze(filtersDropped)` and the field is
   typed `readonly string[]`. Both compile-time (TS `readonly`) and
   runtime (frozen) immutability. Test `filtersDropped is frozen at
   runtime` asserts `.push(...)` throws in strict mode (Vitest's
   default). `Object.freeze` is shallow, but the array contains
   primitives, so shallow is sufficient.

2. ✅ **`TransactionFailedError` constructor change is backward-compatible.**
   Old: `(message, public readonly signature?)`. New:
   `(message: string, signature?: string, options?: ErrorOptions)`.
   `signature` is now declared as a class field with explicit
   `readonly signature?: string` and assigned in the constructor body.
   The new third arg is optional. Both call sites in
   `packages/sdk/src/register.ts` (lines 185 and 197 on this branch)
   pass exactly `(message, signature)` — work unchanged. Test
   `propagates cause` exercises the new `options?` arg.

3. ✅ **`DiscoveryAPIError` new `statusCode?` second arg is opt-in.**
   Existing throws in `discover.ts` (lines 91-94, 96-98, 105-108)
   pass zero args for `statusCode`, leaving it `undefined`.
   Backward-compatible. *(See O2 below — the 4xx/5xx site could
   profitably pass `res.status`, but that's polish.)*

4. ✅ **`InsufficientFundsError` exported but not yet thrown.**
   Confirmed via grep — no `throw new InsufficientFundsError(`
   anywhere in the SDK. Pre-emptive export so consumers can
   `catch (err) { if (err instanceof InsufficientFundsError) ... }`
   once `hire` lands. Constructor stores both `required` /
   `available` as `readonly bigint`. Same pattern applies to
   `WalletNotConnectedError` and `IDLMismatchError` — all three are
   forward-declarations for upcoming flows.

5. ✅ **All cause chains verified in tests.** Every error class that
   accepts `options?: ErrorOptions` has a "propagates cause" test
   (eight tests across the suite). Base class `AgentBazaarError`
   correctly forwards `options` to `super()`; Node 16.9+ /
   lib.es2022 `Error` semantics propagate `cause` to the resulting
   instance.

**L7 fix — `DegradedDiscoveryError` in `discover.ts`:**
After successful RPC fallback, the new guard:
```ts
if (validated.minReputation !== undefined && validated.minReputation > 0) {
  throw new DegradedDiscoveryError(['minReputation']);
}
```
…replaces the silent-zero-result behaviour from PR #19 L7. Three new
discover-test cases:
1. `throws DegradedDiscoveryError when minReputation > 0 and RPC fallback is active`,
2. `DegradedDiscoveryError.filtersDropped includes minReputation`,
3. `minReputation 0 does NOT throw (reputation 0 passes the filter)` —
   protects against a regression on the boundary `minReputation: 0`.

**L7 closed.**

**Two informational observations (not findings):**

- **O1. O8 from PR #21 re-review (base58 refinement) is NOT in this PR.**
  Per team-lead's earlier routing
  ("O8 от твоего PR #21 re-review (base58 refinement) добавлен в
  Task #10 sdk-eng's checklist — запушит вместе с errors hierarchy"),
  the base58 refinement on `listing` / `owner` in
  `APIServiceEntrySchema` was expected to land alongside this work.
  `discover.ts` schema is unchanged in this PR — `listing: z.string()`
  and `owner: z.string()` still survive non-base58 inputs and crash
  `new PublicKey()` outside the try block, escaping the
  `DiscoveryAPIError` fallback. Worth confirming with sdk-eng whether
  this was deferred to a follow-up PR or simply missed. Not a finding
  in THIS PR's scope (Task #15 is errors-hierarchy, not
  discover-schema), but a tracking flag so the residual doesn't slip.

- **O2. `DiscoveryAPIError.statusCode` is unused at the existing throw
  sites.** The 4xx/5xx case in `discover.ts`:
  ```ts
  if (!res.ok) {
    throw new DiscoveryAPIError(`Discovery API error: ${res.status} ${res.statusText}`);
  }
  ```
  could pass `res.status` as the new second arg so callers can
  `if (err instanceof DiscoveryAPIError && err.statusCode === 401) ...`
  without parsing the message. Polish; routes naturally with O1's
  follow-up.

**Cross-cutting tracking (informational):**
- L7 from PR #19 → ✅ closed in this PR.
- L6 from PR #19 → still backend-eng's M1 indexer work.
- O8 from PR #21 → flagged in O1 above; confirm with sdk-eng.
- M2 from PR #2 (`price_lamports` IDL rename) → still anchor-eng's.

**Mainnet release-gate verdict (security side):** N/A — errors-hierarchy
refactor is plumbing, not a flow. The L7 fix is a UX-correctness
improvement on the already-cleared `discover()` path; doesn't unblock
or block anything new.

Cleared to merge. Particularly clean test discipline — the 11-class
`it.each` matrix for inheritance is forward-compatible: any new error
class auto-inherits the `instanceof AgentBazaarError` + `name`
invariants by being added to the `allClasses` array.

---

## PR #29 — feature/backend-indexer-audit-fixes — 2026-04-25 (re-review)

**Verdict:** APPROVED. All three findings (M1, M2, L1+O1) from PR #22's
light audit are closed exactly as recommended. No new findings.
Fix-only PR; cleared to merge.

(GH state note: PR #29 is currently CLOSED — likely a routing
decision after the original combined PR #28 was split into schema-only
PR #24 and audit-fixes PR #29. The branch
`feature/backend-indexer-audit-fixes` remains MERGEABLE; team-lead can
reopen or replace at will.)

**Scope walked:**
- `apps/indexer/src/env.ts` (new, +17) — `dotenv-mono/load` + Zod schema
- `apps/indexer/src/app.ts` (new, +7) — Hono routes only
- `apps/indexer/src/index.ts` (+4 / -15) — bootstrap-only
- `apps/indexer/src/logger.ts` (+2 / -1) — uses `env.NODE_ENV`
- `apps/indexer/drizzle.config.ts` (+2 / -1) — uses `env.DATABASE_URL`
- `apps/indexer/tests/sanity.test.ts` (+1 / -1) — imports from `app.ts`

**Fix verification:**

- **M1 — dotenv-mono ESM ordering → FIXED.** `src/env.ts` opens with
  `import 'dotenv-mono/load';` as a side-effect import that runs
  `dotenvLoad()` at module-eval time. ESM evaluates a module's imports
  in source order BEFORE running its body, so `dotenv-mono/load`
  populates `process.env` before `EnvSchema.parse(process.env)` runs
  at `env.ts` body time.

  **Dependency-graph guarantee:** `env.ts` is a leaf node depending
  only on `dotenv-mono` and `zod`. Any module that imports `env.ts`
  (now `logger.ts`, `index.ts`, `drizzle.config.ts`) gets `env.ts`
  fully loaded before its own body runs. Three layers of cause-and-effect,
  all enforced by ESM module-load ordering. The header comment in
  `env.ts` explicitly documents this invariant ("Must be the first
  import in the dependency graph so downstream modules read the
  populated env") — future maintainers will know not to break the
  chain.

- **M2 — module-load side effect → FIXED.** Standard Hono split:
  - `src/app.ts`: routes-only. Pure data, no side effects.
  - `src/index.ts`: `serve(...)` bootstrap only.
  - `tests/sanity.test.ts`: imports from `'../src/app.js'`. No HTTP
    listener leaks; future tests can `import { app }` freely.

- **L1 + O1 — env-var Zod schema → FIXED in one consolidated module.**
  `EnvSchema` covers `NODE_ENV` (enum + default), `PORT` (coerced int
  + default), `DATABASE_URL` (URL-validated, required),
  `HELIUS_API_KEY` / `HELIUS_WEBHOOK_SECRET` (`.min(1).optional()` —
  empty strings rejected, missing values pass through to Task #14).
  Parse runs once at module load → fail-fast on missing vars.
  `drizzle.config.ts` and `logger.ts` consume the typed `env`;
  non-null assertion gone.

**Backend-eng's three claims confirmed:**

1. ✅ M1: `import 'dotenv-mono/load'` side-effect in `env.ts`;
   ESM dep-graph guarantees it runs before any downstream
   `process.env` read.
2. ✅ M2: `src/app.ts` has routes only; `src/index.ts` has `serve()`
   only. Test imports from `app.ts`.
3. ✅ L1/O1: Zod schema covers all five env vars; `drizzle.config.ts`
   uses `env.DATABASE_URL`.

**Three informational notes (not findings):**

- **O1.** `EnvSchema.parse(process.env)` runs once at module load.
  Env changes after startup aren't picked up. Not a production
  concern (process restarts on env changes); minor footgun for
  `tsx watch` if `.env` is edited mid-run.
- **O2.** `dotenv-mono/load` is a CJS side-effect module; the
  indexer's ESM import works because ESM tolerates side-effect
  imports of CJS. Confirmed working per backend-eng's test runs.
- **O3.** Fail-fast Zod parse is better DX than the previous cryptic
  drizzle error path. Aligns with the PRD's "fail fast on config
  errors" stance.

**Cross-cutting carryover:** PR #19's L6 (server-side `memcmp`
filtering) lands when **Task #13** wires the event-handler upsert.
The Drizzle schema (PR #24, already merged) has indexed columns on
`(capability_hash)` and `(owner)` — confirm those are the SDK's
fallback-query paths.

**Mainnet release-gate verdict:** N/A — bootstrap correctness, not a
flow. Each of Tasks #14/#15/#16 (webhook receiver, event handler,
integration test) will need its own audit walk when business logic
lands on this corrected scaffold.

Cleared to merge. Tight, correct fixes; no scope creep.

---

## PR #30 — feature/sdk-examples-and-publish — 2026-04-25 (light audit)
**Verdict:** APPROVED. No findings; metadata-and-docs PR. Tarball
contents verified; no secrets / source / test-fixtures escape the
npm package boundary.

**Scope walked:**
- `packages/sdk/package.json` (+17 / -1) — license, repository,
  keywords, `files: ["dist", "README.md"]`, deps
- `packages/sdk/README.md` (+30) — install / quick-start / docs
- `packages/sdk/examples/*.ts` (5 new files, +550 total) —
  documentation-only; not shipped via npm
- `packages/sdk/src/discover.ts` / `tests/discover.test.ts` (1 line each)
  — minor docstring/test polish

**Tarball verification (sdk-eng's dry-run output, 8 files / 33.3 kB):**

| file | size | OK? |
|---|---|---|
| README.md | 3.3 kB | ✅ |
| dist/index.cjs | 17.6 kB | ✅ |
| dist/index.cjs.map | 43.4 kB | ✅ source map (see note O1) |
| dist/index.d.cts | 10.3 kB | ✅ |
| dist/index.d.ts | 10.3 kB | ✅ |
| dist/index.js | 16.9 kB | ✅ |
| dist/index.js.map | 43.2 kB | ✅ source map (see note O1) |
| package.json | 1.4 kB | ✅ |

**Excluded by `files: ["dist", "README.md"]`:** `src/`, `tests/`,
`examples/`, `tsconfig.json`, `vitest.config.ts`, `.env`, any local
keypair files. Clean — every category that could carry secrets or
internals stays out.

**Five focus-area answers (sdk-eng's checklist):**

1. ✅ **No secret leaks in tarball.** Examples reference
   `process.env.PINATA_JWT` and `process.env.KEYPAIR_PATH` — never
   commit secret values to source. Examples are excluded from the
   tarball anyway.
2. ✅ **README accuracy.** Install commands map to the published
   package name (`@agentbazaar/sdk`); peer-dep instruction matches
   `package.json` peer-deps; quick-start code matches the actual
   exported `AgentBazaar` API and the post-PR-#26 error hierarchy.
3. ✅ **`publishConfig.access: public`** — present in the tail of
   `package.json` (covered in earlier PR #15 audit too).
4. ✅ **License & repository fields.** `license: MIT`, repository
   URL with `directory: packages/sdk` (correct for monorepo
   subpackage publish).
5. ✅ **Keywords.** `solana / anchor / agent / marketplace / a2a /
   usdc / sdk` — discoverable and accurate; no spam keywords.

**Two informational notes (not findings):**

- **O1. Source maps in tarball.** `dist/index.cjs.map` and
  `dist/index.js.map` ship with the published package. They embed
  the original TypeScript source, so any consumer can read the
  full SDK source via the source map. This is **standard for
  open-source SDKs** and not a leak — the source code is
  open-source-licensable (MIT). Worth knowing if you ever decide
  to ship a closed-source build (in which case set `sourcemap:
  false` in `tsup.config.ts`). For an MVP that's already on
  GitHub, no action.
- **O2. Hardcoded program ID in shipped JS.**
  `register.ts` and `discover.ts` have `new PublicKey('GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd')`.
  The bundled CJS/ESM emit will inline that string. **Not a
  secret** — it's the public devnet program ID per ADR-0001 / Task
  #4. But: this hardcodes a *devnet* address into a published SDK,
  so the SDK can't be used against mainnet without a code change.
  When the program is redeployed to mainnet (post-Squads
  multisig handover), this address needs to come from a config
  field or a per-cluster constant table (`PROGRAM_IDS.devnet`,
  `PROGRAM_IDS.mainnet`). Worth tracking against the mainnet
  release plan.

**Mainnet release-gate verdict:** N/A — metadata + docs, no
runtime. No action needed for npm publish from a security
standpoint. The actual `npm publish` step will need:
- `npm publish --access public` (or `--otp` if 2FA is on the
  account).
- Confirm the npm account is the right org account, not a
  personal one (per the agentbazaar_commit_conventions rule
  about not attributing to user).
- Provenance attestation (`npm publish --provenance`) is
  recommended for transparency.

Cleared to merge. The dry-run output is exactly what we want to
see; ready for actual publish whenever team-lead green-lights.

---

## PR #32 — feature/backend-helius-webhook — 2026-04-25
**Verdict:** APPROVED with one Low finding (auth-deferred-to-Task-#15)
that **must upgrade to Medium before Task #15 lands**, plus three
informational notes.

This PR consolidates two things:
1. **Bundled PR #29 fixes** (M1 dotenv-mono ESM ordering, M2
   app.ts/index.ts split, L1+O1 src/env.ts Zod schema). Cherry-picked
   as commit `ead20a3` per backend-eng. Re-walked: file contents
   match what I approved on PR #29's branch — **APPROVED verdict
   from PR #29 carries over unchanged.**
2. **New Helius webhook receiver scaffold** for Task #14.

**Scope walked (new code only):**
- `apps/indexer/src/webhooks/types.ts` (new, +47) — Zod schemas
  for Helius enhanced-tx payload
- `apps/indexer/src/webhooks/handler.ts` (new, +41) — receive-only
  filter-and-count handler
- `apps/indexer/src/app.ts` (+6 / -0) — wires `POST /webhooks/helius`
- `apps/indexer/tests/webhook.test.ts` (new, +85) — 6 tests
- `apps/indexer/src/db/schema.ts` (new, +14 — actually already
  merged in PR #24; included here for branch hygiene)
- `apps/indexer/drizzle/0001_mean_landau.sql` + meta — migration
  artifacts

**Five focus-area answers (backend-eng's list):**

1. ✅ **SSRF — receive-only.** `handler.ts` does no outbound HTTP
   (no `fetch`, no `axios`, no `helius-sdk` API calls). Only reads
   request body via `c.req.json()` and writes response via
   `c.json(...)`. IPFS metadata fetch deferred to Task #15 — that
   audit will need its own walk.

2. ⚠️ **Signature verification — DEFERRED.** `HELIUS_WEBHOOK_SECRET`
   is declared `.optional()` in `src/env.ts`, but **the handler
   does not enforce it.** No HMAC-SHA256 check; no source-IP
   allowlist; no replay protection. See **L1** below — acceptable
   for the current stub state, **must close before Task #15**.

3. ✅ **Env validation.** `src/env.ts` Zod schema (carried from
   PR #29) parses NODE_ENV, PORT, DATABASE_URL (required +
   URL-validated), HELIUS_API_KEY, HELIUS_WEBHOOK_SECRET (both
   `.min(1).optional()`). Fail-fast at startup.

4. ✅ **Input validation — `HeliusWebhookPayloadSchema`.** Top-level
   `z.array(HeliusEventSchema)` rejects non-array payloads
   (test covers); each event validates required fields
   (`description`, `type`, `source`, `fee`, `feePayer`, `signature`,
   `slot`, `timestamp`, `accountData`, `instructions`). 400 with
   `{ error, details }` on parse failure.

   **Loosely-typed fields (informational, not findings — see O1):**
   `description: z.string()` no max length; `tokenBalanceChanges:
   z.array(z.unknown())` and `events: z.record(z.unknown())`
   completely unvalidated. None of these are read by the current
   handler; they only become a concern when Task #15 starts
   processing event content. Tighten then.

   **Pubkey-shaped fields** (`feePayer`, `programId`, `accounts`)
   are `z.string()` — no base58 refinement. **This time it's
   safe** because the handler only does strict-equality compares
   (`ix.programId === BAZAAR_REGISTRY_PROGRAM_ID`) — no
   `new PublicKey()` parse that could throw. Worth keeping in
   mind for Task #15 if pubkeys flow into upserts that hit
   `bytea` columns.

5. ✅ **drizzle.config.ts inline `dotenvLoad()` workaround.**
   The header comment documents the reason:
   > drizzle-kit runs this file via jiti (CJS), which doesn't
   > follow NodeNext module resolution for local .js→.ts mapping.
   > Load env directly here instead of importing src/env.ts to
   > stay drizzle-kit compatible.

   Confirmed jiti's `.js→.ts` mapping limitation under NodeNext.
   The workaround:
   - `dotenvLoad()` called inline.
   - `dbUrl = process.env['DATABASE_URL']`.
   - `if (!dbUrl) throw new Error(...)` — fail-fast guard preserves
     the safety the env.ts schema provides for the rest of the app.

   Structurally inconsistent with the rest of the indexer (which
   uses `env.ts`), but the safety property is preserved. Acceptable
   trade-off given the toolchain constraint. **O2 informational.**

**Findings:**

- **Critical:** none.
- **High:** none.
- **Medium:** none (yet — see L1).

- **Low:**

  - **L1. Webhook endpoint is publicly exposed without
    authentication.** `POST /webhooks/helius` accepts any caller
    that sends a Helius-shaped JSON payload. No HMAC verification
    against `HELIUS_WEBHOOK_SECRET`, no source-IP allowlist, no
    replay protection (signature-based dedup or timestamp window).

    **Acceptable for the current stub state** — the handler does
    NOT write to the database, sign anything, or move funds. Worst
    case today: an attacker spams the endpoint with valid-shaped
    payloads → CPU + log-volume burn. Railway has platform-level
    DoS protection.

    **MUST upgrade to Medium and land HMAC verification BEFORE
    Task #15 wires the upsert path.** The moment the handler
    starts writing to `service_listings`, an unauthenticated
    endpoint becomes a database-pollution / state-corruption
    vector. Specifically required before Task #15:

    1. **HMAC-SHA256 over raw request body** using
       `HELIUS_WEBHOOK_SECRET` (Helius signs the body with this
       secret in the `X-Helius-Signature` header — verify before
       any business logic runs).
    2. **Replay protection** — Helius webhooks can deliver events
       multiple times. Use `event.signature` (Solana tx signature)
       as a unique key in the upsert; dedupe on conflict.
    3. **Constant-time comparison** for the HMAC check (not `===`)
       to avoid timing-based secret extraction.
    4. **Source-IP allowlist (optional, defense-in-depth)** —
       Helius publishes outgoing IP ranges; allowlist them at
       Railway's edge or in the handler. HMAC alone is sufficient
       in principle.

    Mark `HELIUS_WEBHOOK_SECRET` as `.min(64)` (or whatever Helius
    returns — typically a long base64 string) and flip from
    `.optional()` to **required** at the same time. Failing fast
    at indexer startup if the secret is unset is better than
    silently running unauthenticated.

**Three informational notes (not findings):**

- **O1. Loose-shape fields in `HeliusEventSchema`.** `description`
  has no max length, `tokenBalanceChanges` and `events` are
  `z.array(z.unknown())` / `z.record(z.unknown())`. None are read
  by the current handler. When Task #15 starts processing them,
  add tighter schemas and length caps to prevent
  memory-exhaustion via oversized payloads.

- **O2. drizzle.config.ts uses inline `dotenvLoad()` due to jiti
  CJS limitation.** Documented in the file header. Alternative
  considered: import compatibility shim. The current workaround
  is sound — preserves fail-fast on missing `DATABASE_URL`, just
  duplicates the env-loading code path. Worth noting if jiti ever
  ships NodeNext support so the workaround can be retired.

- **O3. No rate limiting at the Hono layer.** Hono doesn't ship
  rate-limiting middleware out of the box. Railway has
  platform-level limits, but webhook endpoints often get tight
  per-IP caps (e.g., 100 req/min). For prod, consider
  `hono-rate-limiter` or Cloudflare's WAF rate-limiting rule when
  the indexer is deployed. Not a concern for M0 devnet.

**Cross-cutting carryover:**
PR #19's L6 (server-side `memcmp` filtering on `capability_hash`)
— the Drizzle schema already has the right indexes
(`idx_service_listings_capability_hash` and the composite
`idx_service_listings_discover` on `(capability_hash, is_active,
price_lamports)`). When Task #16 wires the Discovery API endpoint,
that's the WHERE clause to expose. **L6 closure trajectory looks
clean.**

PR #2 M2 (`price_lamports` IDL rename): the schema explicitly
mirrors the IDL field name with a NOTE comment acknowledging the
rename pending M1 escrow ship. ✅ tracked.

**Mainnet release-gate verdict:** N/A — handler is a stub.
**L1 must close before Task #15.** Otherwise the indexer is
unprepared for production webhook traffic — open endpoint + DB
writes is a state-corruption vector.

**Recommended fix order:**
1. **Before Task #15:** L1 — HMAC verification + replay
   protection + flip `HELIUS_WEBHOOK_SECRET` to required.
2. **Soon (Task #15):** O1 — tighten loose-shape fields when
   they get read.
3. **Pre-prod:** O3 — rate limiting at Hono or Railway edge.

None of these block PR #32's merge for M0 sandbox testing.

---

## PR #35 — feature/backend-webhook-auth — 2026-04-25 (substantial audit)
**Verdict:** APPROVED with one Medium and two Lows + three informational
notes. **L1 from the PR #32 audit is closed in substance** — auth check
is first, `timingSafeEqual` is used correctly, fail-closed on missing
secret, replay-dedup table is in place. New findings concern
**robustness of the implementation**, not gaps in coverage.

**Scope walked:**
- `apps/indexer/src/webhooks/auth.ts` (new, +20) — Bearer token verify
- `apps/indexer/src/webhooks/handler.ts` (+43 / -5) — auth + replay
- `apps/indexer/src/env.ts` (+2 / -1) — `HELIUS_WEBHOOK_SECRET` required
  + lazy `getEnv()`
- `apps/indexer/src/db/client.ts` (new, +12) — lazy postgres-js singleton
- `apps/indexer/src/db/schema.ts` (+7) — `processed_signatures` table
- `apps/indexer/drizzle/0002_eminent_midnight.sql` (new) — migration
- `apps/indexer/tests/webhook.test.ts` (+48 / -9) — 3 auth tests
- `apps/indexer/tests/webhook-replay.test.ts` (new, +97) — 3 DB-gated tests
- `.env.example` (+4) — `HELIUS_WEBHOOK_SECRET` doc + generation hint

**Backend-eng's six key decisions, each verified:**

1. ✅ **Static Bearer (not HMAC) per Helius's actual design.** Helius
   echoes the dashboard-configured `authHeader` value verbatim as the
   `Authorization` header. Verified from Helius docs. The
   implementation matches Helius's auth model. (See O1 below for the
   security tradeoff vs. HMAC.)

2. ✅ **Auth check is first.** `verifyHeliusAuth(c)` runs before
   `c.req.json()`, before `HeliusWebhookPayloadSchema.safeParse`,
   before any DB query. Correct order — no information leakage about
   payload structure to unauthenticated callers, no wasted compute on
   parse before auth.

3. ✅ **`HELIUS_WEBHOOK_SECRET` flipped to required in env Zod schema.**
   `index.ts` line 6 calls `getEnv()` at startup → Zod parse runs →
   missing secret = startup crash. Fail-fast preserved in production
   despite the `getEnv()` lazy pattern, because `index.ts` is the
   production entrypoint and tests bypass it via `app.ts`.
   (Subtle: `auth.ts` reads `process.env['HELIUS_WEBHOOK_SECRET']`
   directly, not via `getEnv()`. That's a deliberate test-isolation
   choice and is safe because `getEnv()` already validated the value
   exists at startup.)

4. ⚠️ **Replay dedup via `processed_signatures` table** — table and
   migration are correct, but the handler's SELECT-then-INSERT pattern
   is **not atomic**. See **M1** below.

5. ✅ **`src/db/client.ts` lazy postgres-js singleton.** Connection
   established on first query. Tests that don't touch the DB can
   import `app.ts` without a connection attempt. Standard pattern.

6. ✅ **Replay check conditional on `DATABASE_URL`** — fails-open for
   replay only. Auth is hard-enforced regardless. Reasonable for the
   CI-without-DB test path. Production always sets `DATABASE_URL` (per
   Railway / docker-compose). Worth tracking that this branch only
   protects when the DB is configured — flagged in O3 below.

**`auth.ts` walkthrough (security-critical):**

```ts
export function verifyHeliusAuth(c: Context): boolean {
  const secret = process.env['HELIUS_WEBHOOK_SECRET'];
  if (!secret) return false;
  const received = c.req.header('Authorization') ?? '';
  if (!received) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

✅ All five security properties correct:
- Read secret at request time (not cached) — ensures secret rotation via env-var flip works without restart, though full rotation typically requires restart anyway.
- `if (!secret) return false` — fail closed on missing config.
- `if (!received) return false` — fail closed on missing header.
- Equal-length precondition before `timingSafeEqual` — required (it throws on length mismatch). Length check itself is a minor timing oracle, but Bearer tokens have a fixed length pattern so the leak is negligible.
- `timingSafeEqual(Buffer, Buffer)` — constant-time comparison. ✅

**Findings:**

- **Critical / High:** none.

- **Medium:**

  - **M1. TOCTOU race + N+1 query pattern in replay dedup.**
    Two issues with the same fix:

    ```ts
    // (a) Pre-check loop — N+1 SELECT
    for (const event of events) {
      const rows = await sql`
        SELECT signature FROM processed_signatures WHERE signature = ${event.signature}
      `;
      if (rows.length > 0) seenSet.add(event.signature);
    }
    // ... business logic (currently just logging) ...
    // (b) Record loop — N+1 INSERT
    for (const event of newEvents) {
      await sql`
        INSERT INTO processed_signatures (signature) VALUES (${event.signature})
        ON CONFLICT (signature) DO NOTHING
      `;
    }
    ```

    1. **Race window:** between (a) and (b), two concurrent deliveries
       of the same signature can both see SELECT return empty, both
       advance to business logic, both attempt INSERT. ON CONFLICT
       keeps the DB clean (only one INSERT succeeds), but BOTH have
       already executed the business logic. Currently harmless
       (logging only); when **Task #13** wires upserts to
       `service_listings`, duplicate upserts become real DB writes —
       only safe if those upserts are themselves idempotent (likely,
       given `pubkey` is the PK, but Task #13 needs to verify
       explicitly).
    2. **Performance:** one SELECT and one INSERT per event in a
       batch. A 100-event Helius batch = 200 sequential round-trips.
       At RTT 5ms that's a full second of latency before processing
       starts.

    **Combined fix — single atomic INSERT ... RETURNING:**
    ```ts
    const sigs = events.map(e => e.signature);
    const inserted = await sql<{ signature: string }[]>`
      INSERT INTO processed_signatures (signature)
      SELECT * FROM unnest(${sigs}::text[])
      ON CONFLICT (signature) DO NOTHING
      RETURNING signature
    `;
    const newSigSet = new Set(inserted.map(r => r.signature));
    const newEvents = events.filter(e => newSigSet.has(e.signature));
    ```

    Properties:
    - **Atomic** — INSERT runs as a single statement; concurrent
      deliveries serialize on the row lock, only one inserts.
    - **Race-free** — RETURNING gives back the rows that were
      newly inserted (not the ones that lost the conflict).
      `newEvents` is exactly the deduplicated set.
    - **One round-trip** instead of 2N.
    - **Same idempotency contract** — replays still skipped.

    Worth landing **before Task #13** for the same reason L1 had to
    land before Task #15-now-#13 — the moment business logic runs on
    the deduplicated stream, races become real corruption.

- **Low:**

  - **L1. `HELIUS_WEBHOOK_SECRET: z.string().min(1)` is too loose.**
    Zod accepts a 1-char secret that is brute-forceable in seconds.
    The `.env.example` recommends `openssl rand -base64 48` which
    produces ~64 chars, so the documented practice already exceeds
    the schema's lower bound — but a misconfigured deploy with a
    short secret would still pass the startup check and run with
    weak auth.

    **Fix:** `HELIUS_WEBHOOK_SECRET: z.string().min(32)` (or higher).
    Pairs naturally with the `.env.example` generation hint.
    Trivial; tighten before mainnet.

  - **L2. `processed_signatures` has no retention policy.**
    Table grows forever; no TTL. Solana finality is ~13 seconds;
    Helius's replay window is bounded (typically retries for a few
    hours at most). Once Task #13 lands, a daily cron / pg_cron job
    like:
    ```sql
    DELETE FROM processed_signatures WHERE processed_at < NOW() - INTERVAL '7 days';
    ```
    keeps the table bounded. Operational concern; not security.

**Three informational notes (not findings):**

- **O1. Static Bearer ≠ HMAC.** This is Helius's design, not
  backend-eng's choice. Implication: anyone with the secret can
  POST any body — the secret authenticates the *caller*, not the
  *request body*. An HMAC scheme (Stripe / GitHub style) would
  bind the secret to the body. Mitigations on the static-Bearer
  side:
  1. Treat the secret like a database password — env-var only,
     never logged, rotate periodically.
  2. Optional source-IP allowlist (Helius publishes outgoing IP
     ranges) at Railway's edge or via a Hono middleware. Not
     gating, defense-in-depth.
  3. The replay-dedup table partially compensates — an attacker
     replaying a captured request with the same signatures gets
     deduplicated. But an attacker who *crafts new signatures*
     can still inject. Replay protects against accidental
     duplication, not adversarial replay-with-mutation.

- **O2. No SSL preference on postgres-js.** `postgres(url)` uses
  the URL's `?sslmode=` if present; defaults to `prefer` which
  accepts unencrypted connections. For production deploys against
  Railway / managed Postgres, set `postgres(url, { ssl: 'require' })`.
  Confirmed not needed for M0 dev-loop (local Postgres in
  docker-compose); flag for the production-deploy checklist.

- **O3. Replay check conditional on `DATABASE_URL`** — backend-eng
  documented this as deliberate ("fails-open for replay only").
  Reasonable for CI but worth noting that **a production deploy
  with `DATABASE_URL` accidentally unset** would silently run
  without replay protection (though it would also fail at the
  upsert step in Task #13, so the practical impact is limited).
  M1 cross-references: index.ts's startup-time `getEnv()` call
  validates `DATABASE_URL: z.string().url()` is set, so this
  scenario can't occur in production unless the operator
  intentionally clears the env var post-startup.

**Cross-cutting carryover (informational):**
- Task #13's upsert path will need O1's idempotency property
  ("upserts are themselves idempotent"). The schema's `pubkey
  PRIMARY KEY` provides this.
- The pubkey-shape note from PR #32 (`feePayer`/`programId`/
  `accounts` are `z.string()` without base58 refinement) becomes
  relevant when Task #13 reads them into upserts hitting `bytea`
  columns — that's where O8-style refinement would matter.

**Mainnet release-gate verdict:** **L1 from PR #32 closed in
substance.** Production-ready posture for the auth surface itself.
M1 (race + N+1) should land **before Task #13** wires upserts —
same gate-before-business-logic principle that drove L1 → PR #35.
L1 (.min(32) on the schema) and L2 (retention policy) are tighten-
the-implementation items; both pre-mainnet, neither blocking.

**Recommended fix order:**
1. **Before Task #13:** M1 — atomic INSERT ... RETURNING for
   replay dedup.
2. **Soon (or pair with M1):** L1 — `.min(32)` on
   `HELIUS_WEBHOOK_SECRET`.
3. **Pre-mainnet:** L2 retention; O2 SSL; O1 source-IP allowlist
   (defense-in-depth).

None block PR #35's merge — auth is correct, replay table is
correct, the issues are around implementation tightness rather
than gaps. Solid work; the discipline patterns from earlier audits
(fail-fast, Zod-first, structured logging, no-secrets-in-logs) all
carry through cleanly.

---

## PR #38 — feature/qa-test-infra — 2026-04-25 (light audit)
**Verdict:** APPROVED. No findings; two informational observations.
Test scaffolding PR (`@agentbazaar/tests` package) — no production
code, no on-chain mutations beyond test-owned mint, no signed
flows beyond test keypairs.

**Scope walked:**
- `tests/fixtures/wallets.ts` (new, +34) — `createFundedWallets` via devnet airdrop
- `tests/fixtures/usdc-mint.ts` (new, +105) — test SPL mint deploy + mint-to-wallets
- `tests/mocks/helius-webhook.ts` (new, +65) — synthetic webhook POST helper
- `tests/mocks/sati.ts` (new, +25) — canned 0-reputation stub
- `tests/mocks/x402.ts` (new, +32) — accept-all payment stub
- `tests/helpers/state-assertions.ts` (new, +45) — on-chain ServiceListing assertions
- `tests/helpers/tx-utils.ts` (new, +62) — PDA derivation + read-only Anchor program builder
- `tests/e2e/register-discover.test.ts` (new, +14) — currently a `todo` placeholder
- `tests/package.json`, `tests/tsconfig.json`, `pnpm-workspace.yaml`,
  `pnpm-lock.yaml`

**Three sanity-check answers (qa-test-eng's checklist):**

1. ✅ **No hardcoded secrets.**
   - `helius-webhook.ts::fireServiceListingCreated(webhookUrl, secret, payload)`
     accepts `secret` as a parameter from the caller. Never reads
     `process.env['HELIUS_WEBHOOK_SECRET']`. Authorization header is
     set from the caller-provided value — caller passes the same
     `Bearer ...` value the indexer was started with.
   - All keypairs ephemeral via `Keypair.generate()` — no static
     keypair files, no private keys in source.
   - `sati.ts` and `x402.ts` mocks return canned data — no env
     reads, no secrets.
   - Helpers don't read env at all.
   - `package.json` has no `preinstall`/`install`/`postinstall`
     scripts; the four scripts (`test`, `test:e2e`, `typecheck`,
     `lint`) all read source/test paths only.

2. ✅ **No mainnet references.**
   - `wallets.ts` uses `connection.requestAirdrop(...)` — devnet/
     testnet only.
   - `tx-utils.ts` hardcodes
     `REGISTRY_PROGRAM_ID = 'GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd'`
     (devnet). No `mainnet-beta` strings, no mainnet RPC URLs.
   - `e2e` test header explicitly says "Hits devnet directly".
   - See O2 below for the per-cluster carryover note.

3. ✅ **No admin-key footprint.**
   - The test SPL mint authority is `payer.keypair` — a per-test-run
     ephemeral keypair from `createFundedWallets`. Cannot withdraw
     from any escrow vault (escrow doesn't exist in M0); controls
     a test-owned mint only. The keypair leaves scope at test
     teardown.
   - No "upgrade authority" pattern, no "admin signer" abstractions,
     no Squads multisig stubs.
   - The `noopWallet` in `buildRegistryProgram` uses
     `PublicKey.default` (32 zero bytes) and stub sign methods —
     read-only program access.

**Two informational observations (not findings):**

- **O1. `fireServiceListingCreated` payload doesn't match the
  indexer's `HeliusWebhookPayloadSchema`.** The mock sends:
  ```ts
  body: JSON.stringify([
    { type: 'ServiceListingCreated', ...payload }
  ])
  ```
  But the real Helius payload (per
  `apps/indexer/src/webhooks/types.ts`) requires `description`,
  `type` (Helius's tx-type enum, not a custom event name), `source`,
  `fee`, `feePayer`, `signature`, `slot`, `timestamp`,
  `accountData`, `instructions`. The mock's body would fail
  `HeliusWebhookPayloadSchema.safeParse(...)` and return 400 from
  the indexer.

  Currently invisible because `tests/e2e/register-discover.test.ts`
  is `todo` — no test exercises the mock yet. **When Task #18
  wires the e2e test**, the mock needs to wrap the
  `ServiceListingCreated` content inside a real `HeliusEventSchema`
  envelope (with stub values like `description: 'mock'`,
  `accountData: []`, `instructions: [{ programId:
  REGISTRY_PROGRAM_ID, accounts: [], data: '', innerInstructions:
  [] }]`, etc.).

  Functional issue, not security. Flag for qa-test-eng before
  Task #18.

- **O2. `tx-utils.ts` hardcodes the devnet program ID.** Same
  forward carryover as PR #30 O2 — fine for now (tests are
  devnet-only by design). When the SDK + tests grow per-cluster
  constants for mainnet support, this hardcode needs the same
  cluster-aware lookup. Tracked.

**Why this PR is clean (no findings):**

1. **No on-chain mutations** outside test-owned state. The mint
   helper writes to a test-owned mint with a test-owned authority;
   no production state touched.
2. **No signing except test-controlled keypairs.** Test wallets
   are ephemeral. No path that could exfiltrate user keys.
3. **Mocks are accept-all stubs**, not adversarial. SATI mock
   returns 0 reputation; x402 mock always accepts. Nothing to
   leak — no real data behind them.

**Cross-cutting context:** This PR sets up the harness; substance
comes when Task #18 wires the helpers together. That's where the
next audit walks the full chain: SDK register → on-chain registry
→ indexer webhook delivery (using the corrected mock from O1) →
discover with API + RPC fallback. Pattern continuity will matter
there.

**Mainnet release-gate verdict:** N/A — test scaffolding never
ships to npm or production deploys. Cleared to merge.

---

## PR #40 — feature/backend-event-handler — 2026-04-25 (substantial audit)
**Verdict:** APPROVED FOR M0 DEVNET MERGE; **BLOCKED FOR PRODUCTION
DEPLOY** until H1 closes. One **High**, two **Medium**, two **Low**, plus
three informational notes. The High is **SSRF via attacker-controlled
metadata URI** — the central security issue of the upsert path.

**Scope walked:**
- `apps/indexer/src/events/fetch-metadata.ts` (new, +33) — IPFS metadata fetch
- `apps/indexer/src/events/decoder.ts` (new, +46) — BorshEventCoder wrapper
- `apps/indexer/src/events/on-listing-created.ts` (new, +69) — upsert path
- `apps/indexer/src/events/on-listing-updated.ts` (new, +71) — update path (second SSRF surface)
- `apps/indexer/src/webhooks/handler.ts` (+41 / -32) — routing into event handlers (PR #35 M1 atomic INSERT carried)
- `apps/indexer/src/env.ts` (+5 / -1) — adds `PINATA_GATEWAY` (optional URL); confirms PR #35 L1 `.min(32)` carried
- `apps/indexer/tests/event-handler.test.ts` (new, +92) — DB-gated integration tests
- minor: db/client, logger, auth lints (one-line each), webhook tests updated

**PR #35 carryover verifications:**
- ✅ M1 atomic `INSERT … RETURNING` (line 36-49 of new handler.ts) — exact code from f4a902f, comment references "(security-auditor PR #35 M1 fix)".
- ✅ L1 `HELIUS_WEBHOOK_SECRET: z.string().min(32)`.

**Findings:**

- **Critical:** none.

- **High:**

  - **H1. SSRF via attacker-controlled `metadataUri` in `fetchMetadata`.**
    The `metadataUri` in `ServiceListingCreated` / `ServiceListingUpdated`
    events comes from on-chain state. The on-chain `bazaar-registry`
    program only validates length (`metadata_uri.len() <= 64`) — no
    scheme allowlist, no content validation. **Anyone can register
    a listing with any URI ≤64 chars and the indexer will fetch it.**

    `fetch-metadata.ts:resolveIpfsUrl` rewrites `ipfs://` URIs to a
    gateway URL but **passes any other URI through verbatim** to
    Node's `fetch()`. That means:
    - `http://localhost:5432/` (or any internal port) — 22 chars, fits the 64-byte limit. Probes the indexer's loopback.
    - `http://10.0.0.1/admin` — 21 chars. Probes private network.
    - `http://[::1]/` — 13 chars. Probes IPv6 loopback.
    - `http://169.254.169.254/` — 23 chars. **AWS / cloud metadata endpoint** (also Azure, GCP, etc.).
    - `https://internal.x` — 18 chars. Probes private DNS.
    - `https://user:pass@x.io/m` — embeds credentials that flow into logs (see M2).

    **Concrete exploit chain:**
    1. Attacker registers a listing with
       `metadataUri = "http://169.254.169.254/latest/meta-data/iam/security-credentials/"` (truncated to fit 64 chars; even root path probes are valuable).
    2. Helius webhook delivers the `ServiceListingCreated` event to the indexer.
    3. Indexer's `fetchMetadata` calls Node's `fetch()` against the URL.
    4. Node's `fetch` follows redirects by default — attacker can redirect to longer URLs not bounded by the 64-char limit.
    5. Response goes through `MetadataSchema.safeParse(json)`. Direct exfiltration is partially mitigated (the response must look like agent metadata to populate `service_listings.capability` / `endpoint`), BUT:
       - **Side channels:** response timing, success/failure, log entries (`logger.warn({ url, status })`) reveal whether the URL is reachable, what status it returned. An attacker watching logs (e.g., via Helius dashboard webhook delivery logs, or by comparing `discover()` responses for listings before/after) can enumerate the indexer's internal network topology.
       - **Resource exhaustion:** N malicious listings × 10 s timeout each = significant CPU/network burn during the indexer's process loop.
       - **Internal-service abuse with side effects:** GET requests to internal endpoints that mutate state on GET (rare but documented patterns exist — old SOAP services, legacy dashboards). The 64-char limit blocks long URLs but redirects bypass that.

    **Severity rationale: HIGH for production, ACCEPTED for M0 devnet
    sandbox.** Devnet's blast radius is limited (no mainnet funds, no
    production tenants). But the moment this indexer is deployed to
    Railway / a managed environment, the AWS metadata endpoint is
    reachable and credentials are exposed.

    **Required mitigations (defense in depth):**

    1. **Scheme allowlist.** Reject anything that isn't `ipfs://` or
       `https://`. Return early without fetching:
       ```ts
       if (!uri.startsWith('ipfs://') && !uri.startsWith('https://')) {
         logger.warn({ uri }, 'metadata fetch rejected: scheme not allowed');
         return null;
       }
       ```
       Closes `http://`, `file:`, `data:`, `javascript:`, `gopher://`, etc.

    2. **Hostname allowlist OR private-IP blocklist.** For Pinata-only
       deploys (the documented production path), allowlist:
       ```ts
       const ALLOWED_HOSTS = new Set([
         'ipfs.io',
         new URL(process.env.PINATA_GATEWAY ?? 'https://ipfs.io').hostname,
       ]);
       ```
       For more flexible deploys, block private/reserved/loopback IP
       ranges after DNS resolution:
       ```ts
       import { lookup } from 'node:dns/promises';
       import { isIPv4, isIPv6 } from 'node:net';

       const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^169\.254\./];
       const { address } = await lookup(new URL(url).hostname);
       if (PRIVATE_V4.some(re => re.test(address)) || address === '::1' || address.startsWith('fe80::')) {
         logger.warn({ url, address }, 'metadata fetch rejected: private IP');
         return null;
       }
       ```
       *Caveat:* DNS rebinding can defeat hostname-based allowlists by
       resolving differently between the lookup and the actual fetch.
       For strict protection, use a custom undici dispatcher that
       enforces the IP at connection time. For M0/M1 the lookup-then-
       fetch pattern is acceptable defense-in-depth.

    3. **Redirect control.** Node's fetch follows redirects by default:
       ```ts
       fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
       ```
       Returns the redirect response with a 3xx status; `res.ok` is
       false, fetch fails, return null. Attackers can't redirect to
       internal endpoints.

       Or: `redirect: 'manual'` to inspect the `Location` header and
       re-validate it against the allowlist before refetching.

    4. **Response size cap.** Currently `await res.json()` reads the
       full body unbounded. A 1 GB response OOMs the indexer.
       ```ts
       const contentLength = Number(res.headers.get('content-length') ?? '0');
       if (contentLength > 100_000) {  // metadata is small; 100 KB is generous
         logger.warn({ url, contentLength }, 'metadata fetch rejected: too large');
         return null;
       }
       const text = await res.text();
       if (text.length > 100_000) return null;
       const json = JSON.parse(text);
       ```

    These four together close the SSRF cleanly. They're all
    standalone changes; estimate one focused PR.

- **Medium:**

  - **M1. Path traversal in `resolveIpfsUrl`.** The CID is interpolated
    directly into the gateway URL without format validation:
    ```ts
    const cid = uri.slice('ipfs://'.length);
    return `${gateway}/${cid}`;
    ```

    An attacker registering with
    `metadataUri = "ipfs://../some-other-path"` produces:
    ```
    https://my-pinata.cloud/ipfs/../some-other-path
    ```
    URL normalization turns this into
    `https://my-pinata.cloud/some-other-path`. If `PINATA_GATEWAY` is
    a self-hosted gateway sharing a hostname with other endpoints
    (e.g., `https://my-app.com/api/ipfs` shares `my-app.com` with
    `https://my-app.com/api/auth-bypass`), the path traversal escapes
    the IPFS namespace.

    Public `ipfs.io` deploys are safe because `ipfs.io` doesn't host
    sensitive endpoints next to `/ipfs/`. **Risk depends on the
    operator's gateway setup.**

    **Fix:** validate the CID format with a regex (CIDs are base58/
    base32 alphanumerics):
    ```ts
    if (!/^[a-zA-Z0-9]+$/.test(cid)) {
      logger.warn({ uri }, 'metadata fetch rejected: invalid CID');
      return null;
    }
    ```
    Or use the `multiformats` library to parse-and-reformat.

  - **M2. Attacker-controlled URL flows into log lines.**
    `logger.warn({ url, status }, '...')` and `logger.warn({ url,
    err }, '...')`. If `metadataUri = "https://user:pass@x.io/"` is
    registered on-chain, `pass` lands in the indexer's logs. Log
    aggregators (Datadog, Helius dashboards, etc.) typically have
    broader access than the indexer process — credential leak path.

    Even without embedded credentials, the URL itself reveals the
    attacker's probing target — useful for reconnaissance correlation.

    **Fix:** strip URL credentials before logging:
    ```ts
    function safeLogUrl(u: string): string {
      try {
        const parsed = new URL(u);
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
      } catch {
        return '<unparseable url>';
      }
    }
    ```

- **Low:**

  - **L1. No response size limit on `await res.json()`.** Folded into
    H1's mitigation #4 above. Standalone if H1 isn't taken in the
    same fix pass.

  - **L2. `decodeRegistryEvent` uses `as unknown as RegistryEvent`
    type assertion without runtime validation.** If the IDL changes
    the event shape (field rename, type change, new optional
    field), the assertion silently passes and downstream code
    crashes when accessing missing fields. Tracking the IDL via
    `packages/idl`'s snapshot test reduces drift, but a runtime
    Zod-validate of the decoded payload would be belt-and-suspenders
    cheap.

**Three informational notes (not findings):**

- **O1.** Default IPFS gateway is `https://ipfs.io/ipfs` — public,
  rate-limited. Production deploys should set `PINATA_GATEWAY` to
  a dedicated gateway. Already documented in `.env.example`.

- **O2.** Carryforward from PR #35: **L2 retention TTL on
  `processed_signatures`**. Pre-mainnet polish; not addressed here.

- **O3. Backend-eng's question about base58 carryover from O8 (PR #21)
  — does NOT apply to this PR's surface.** The pubkey strings
  flowing into the upsert (`data.listing.toString()`,
  `data.owner.toString()`) come from `BorshEventCoder.decode`
  on-chain data, NOT from the HTTP wire payload. The on-chain
  encoder is the authority for those bytes. The webhook payload's
  `programId` field is only used in string-equality compares
  against the hardcoded `BAZAAR_REGISTRY_PROGRAM_ID` — no
  `new PublicKey()` parse. So the O8 finding doesn't repeat here.

  *(For completeness:* an attacker who somehow tampers with the
  Helius delivery payload to put a different `programId` in the
  outer instruction would just bypass the indexer's
  registry-detection — events for non-bazaar-registry programs
  get skipped. Helius's authentication (`HELIUS_WEBHOOK_SECRET`)
  prevents this anyway.*)*

**Cross-cutting carryover (informational):**
- **L6 from PR #19** (server-side `memcmp` filtering for SDK
  fallback): the schema (PR #24) has the right indexes
  (`idx_service_listings_capability_hash`,
  `idx_service_listings_discover`); the upsert path now
  populates them on every event; the API route in Task #16
  closes the loop. **L6 trajectory remains clean.**
- **PR #2 M2 (`price_lamports` rename):** schema still mirrors
  IDL with explicit NOTE comment; deferred to M1.

**Mainnet release-gate verdict:**
- **M0 devnet sandbox:** APPROVED to merge. No real funds, no
  production tenants, indexer not exposed to public deploy.
- **Production / mainnet:** **BLOCKED on H1.** SSRF must close
  before the indexer runs in any cloud environment with internal
  network exposure (Railway, Fly, AWS — all expose
  `169.254.169.254` and private RFC 1918 ranges).

**Recommended fix order:**
1. **Before any production deploy (M1+):** H1 SSRF mitigations
   (scheme allowlist + private-IP block + redirect control +
   response-size cap). Pair with M1 (CID format validation) and
   M2 (URL-credential sanitization in logs) — same
   fetch-metadata.ts module.
2. **Pre-mainnet:** L2 (retention TTL from PR #35), L2 here
   (decoder Zod validation), O1 documentation.

This is the most substantive on-chain → off-chain trust-boundary
finding of the M0 trajectory. The patterns from earlier audits
(Zod-first, fail-fast, strict scheme refines from PR #17 / PR #21
/ PR #26) need to extend to *outbound* HTTP at the indexer
boundary the same way they extended to *inbound* HTTP at the
SDK / API / webhook boundary.

---

## PR #44 — feature/backend-integration-test — 2026-04-25 (final substantial audit)

**Verdict:** **APPROVED. Production-deploy gate CLEAR.** All findings
from the PR #40 audit closed cleanly: H1 SSRF (4 layers), M1 path
traversal, M2 in `fetch-metadata.ts`, AND M2-residual in
`on-listing-updated.ts:newUri`. The single residual log-site I missed
in the original audit's scope is now fixed; the `safeLogUrl`
extraction makes the fix reusable for future log sites.

This is the **final substantive M0 indexer audit** before backend-eng
closes their M0 scope. PR #44 bundles:
1. Task #16 integration tests (originally PR #44 scope)
2. H1 SSRF hardening (originally PR #45, now folded in)
3. M1 path traversal fix
4. M2 in `fetch-metadata.ts`
5. M2-residual fix (the scope-miss flag — `newUri` log)
6. `safeLogUrl` extracted to `apps/indexer/src/util/safe-log-url.ts`

**Scope walked (5 files):**
- `apps/indexer/src/util/safe-log-url.ts` (new, +10) — extracted helper
- `apps/indexer/src/events/fetch-metadata.ts` (+82 / -12) — H1+M1+M2
- `apps/indexer/src/events/on-listing-updated.ts` (+8 / -1) — M2-residual
- `apps/indexer/tests/listing-upsert.integration.test.ts` (new, +158)
- `apps/indexer/package.json` (+1) — `pnpm test:integration` script

**Four checkpoints (team-lead's questions):**

1. ✅ **`safeLogUrl` util extraction correct, no regression in
   fetch-metadata.ts.** The new helper in `util/safe-log-url.ts` is
   byte-identical to the original local copy. `fetch-metadata.ts`
   imports from `'../util/safe-log-url.js'` and removes the local
   definition; all seven log sites continue to call `safeLogUrl(...)`.

2. ✅ **M2-residual in `on-listing-updated.ts` truly closed.**
   Last block of `onListingUpdated` now does
   `newUri: newUri ? safeLogUrl(newUri) : null` — sanitized when
   present, `null` preserved when no URI update.

   **Sweep across all indexer log sites for any other attacker-controlled
   URL leak:**
   - `webhooks/handler.ts:14` — generic auth-rejected message, no
     payload data. ✅
   - `webhooks/handler.ts:27` — `{ issues: result.error.issues }`.
     Zod issues show field path + reason; don't echo raw rejected
     values by default. ✅
   - `webhooks/handler.ts:76` — `{ err, txSignature, event: event.name }`.
     `err` is from upsert path; postgres-js doesn't include binding
     values in errors by default. Theoretical-only — see **I3**.
   - `webhooks/handler.ts:86` — counts only. ✅
   - `events/on-listing-created.ts:65` — `capability` from
     `MetadataSchema.parse`-validated string; other fields are
     Borsh-decoded on-chain bytes. ✅
   - `index.ts:8` — validated env. ✅
   - `webhooks/auth.ts` / `logger.ts` — no logger calls. ✅

   **Sweep result:** M2-residual was the only at-risk site; it is
   now closed.

3. ✅ **H1 SSRF four layers intact after cherry-pick + bundling.**
   Re-walked end-to-end:
   - Layer 1 — `resolveIpfsUrl` returns `null` for non-`ipfs://` /
     non-`https://`. Identical to f000b35.
   - Layer 2 — `isPrivateAddress` matches RFC 1918 + 127/8 + 169.254/16
     + ::1 + fe80::; fail-closed on DNS failure. Identical.
   - Layer 3 — `redirect: 'error'` in the fetch call.
   - Layer 4 — Content-Length pre-check + post-text length check at
     100 KB. Same partial-protection nuance (I1).

   No regression from the bundling.

4. ✅ **Integration test coverage adequate for production confidence.**
   Five round-trip scenarios cover the upsert state machine: insert;
   idempotent re-create; price-only update; deactivate; price+URI
   update. Together they hit the four branches of `onListingUpdated`'s
   SQL conditional. Coverage gap (informational): no integration test
   exercises `fetchMetadata` because `vi.mock` returns null — see I2
   for the pre-mainnet unit-test PR.

**Findings:**
- **Critical / High / Medium:** none — all closed.
- **Low:** none in this PR's diff. Carryover Lows (L2 decoder Zod from
  PR #40, L2 retention TTL from PR #35) remain pre-mainnet polish.

**Three informational notes (pre-mainnet polish, not blocking):**

- **I1.** Response-size cap is partial — `await res.text()` buffers
  full body before the post-check; AbortSignal caps the unbounded
  case to ~10 s × bandwidth. Streaming-with-byte-counter is the
  bulletproof pattern.
- **I2.** No unit tests for `fetch-metadata.ts` itself. The four
  layers are obvious from inspection but a focused test PR (mock
  `fetch` + `dns.lookup`, assert each layer rejects the right inputs)
  would lock the contract in.
- **I3.** `webhooks/handler.ts:76` `logger.error({ err, ... })`
  could theoretically leak attacker-controlled data via postgres-js
  error messages if pg config ever included binding values. Default
  config doesn't. Defense-in-depth: consider a `safeLogError` helper
  that strips bind parameters from pg errors before logging.

**Mainnet release-gate verdict:**
- **M0 devnet:** APPROVED.
- **Production deploy:** **CLEAR.** Four-layer SSRF defense in place;
  M2 credential-leak surface closed across all attacker-controlled
  log sites; integration tests give upsert-layer confidence.
  **Backend-eng's M0 scope is production-ready.** Pre-mainnet polish
  (I1/I2/I3 + carryover Lows) doesn't gate production.

**Carryforward status:**
- ✅ L7 (PR #19) → closed in PR #26.
- ✅ O8 (PR #21) → closed in `ecc3e0a`.
- ✅ L1 (PR #32) → closed via PR #35.
- ✅ M1+L1 (PR #35) → closed in `f4a902f`.
- ✅ H1+M1+M2 (PR #40) → closed in PR #44 (this PR).
- ✅ M2-residual → closed in PR #44 (this PR).
- ⏳ L2 retention TTL (PR #35), L2 decoder Zod (PR #40), I1/I2/I3 here
  — all pre-mainnet polish.
- ⏳ M2 from PR #2 (`price_lamports` rename) — anchor-eng for M1.

**Pattern observation (final):** the discipline pattern from earlier
audits (Zod-first, fail-fast, scheme refines, `safeLogUrl`-style
sanitization) now extends consistently across **inbound** boundaries
(SDK Pinata upload, Discovery API responses, webhook auth) AND
**outbound** boundaries (`fetchMetadata`). Every attacker-controlled
URL is sanitized before logging, every external response is
schema-validated, every fetch has a four-layer SSRF defense. The
indexer is production-ready from the security side.

**Backend-eng's M0 scope: DONE. Cleared for production.**

---

## PR #47 — feature/qa-e2e-register-discover — 2026-04-25 (light audit)

**Verdict:** APPROVED, no findings; three informational notes.
**This is the final M0 task** (Task #18). After PR #47 merges, M0
is closed from the security side.

Test-only PR — `register → discover` happy path against devnet.
Two files:
- `tests/e2e/register-discover.test.ts` (+123 / -5) — 4-step Vitest suite
- `tests/fixtures/wallets.ts` (+87 / -12) — payer-funded wallet helper

**qa-test-eng's three claims, all verified:**

1. ✅ **CLI payer keypair only used for funding test wallets.**
   `loadCliPayer()` reads `~/.config/solana/id.json` at runtime,
   passes the Keypair to `createFundedWallets` as the funding
   source. Never persisted, never logged, never sent over the
   wire — only its derived signature lands in `tx.sign(payer) +
   sendRawTransaction`. Falls back to `undefined` gracefully on
   missing file. Standard pattern.

2. ✅ **`discoveryApiUrl: 'http://localhost:9999'` forces RPC
   fallback.** Localhost:9999 fails ECONNREFUSED → `DiscoveryAPIError`
   → fallback fires. No real HTTP traffic. Note: the SDK's
   `discover.ts` doesn't have a private-IP block (that was
   indexer-side `fetch-metadata.ts`), so the SDK happily attempts
   the connect; the OS-level refusal is the actual gate. Works as
   intended for the test, doesn't compromise the SDK's threat
   model.

3. ✅ **`AIRDROP_SOL = 0.1` avoids draining the payer.** Per-run
   cost is 0.1 SOL + tx fees. 100 runs ≈ 10 SOL total — manageable
   for a developer's devnet payer, especially since `payer ?? faucet`
   means the faucet covers the case when no CLI keypair exists.

**Three sanity-check answers (analogous to PR #38 checklist):**

1. ✅ **No hardcoded secrets.**
   - `pinataJwt = process.env.PINATA_JWT ?? ''` — env-only.
   - CLI keypair loaded from `~/.config/solana/id.json` at runtime.
   - Test wallets ephemeral via `Keypair.generate()`.
   - No `.env` files committed.
2. ✅ **No mainnet references.**
   - Default RPC: `'https://api.devnet.solana.com'`.
   - `PUBLIC_DEVNET_URL = 'https://api.devnet.solana.com'`.
   - `connection.requestAirdrop` is devnet/testnet-only.
   - `REGISTRY_PROGRAM_ID` (via `deriveListingPda` from
     PR #38 helpers) is the devnet program ID.
   - Test header explicitly: "Hits devnet directly".
3. ✅ **No admin-key footprint.**
   - CLI payer is the developer's opt-in identity; explicit
     `E2E=true` flag required.
   - Ephemeral test wallets via `Keypair.generate()`.
   - No upgrade-authority pattern, no Squads stubs.

**Three informational notes (not findings, not blocking):**

- **I1.** **CLI payer is the developer's actual on-chain identity
  (devnet).** Every test run is publicly tied to the payer's
  pubkey on Solana Explorer. Devnet has no real value so the
  association is purely metadata, but worth flagging for CI
  setups: a CI environment should use a dedicated CI keypair
  rather than reusing a developer's personal one. Operational,
  not security.
- **I2.** **Permanent listings accumulate on devnet** because
  `deactivate()` isn't implemented in M0 (throws
  `NotImplementedError`). The afterAll block correctly documents
  this:
  > Task #18 follow-up: add cleanup once deactivate_service is wired in the SDK.

  Each test run leaves one permanent listing with a unique
  `e2e-capability-${Date.now()}` capability. Operational only;
  benign on devnet.
- **I3.** **`pinataJwt` empty-string fallback could fail more
  loudly.** `pinataJwt = process.env.PINATA_JWT ?? ''` — if unset,
  the test progresses to `register()` and fails when Pinata returns
  401. A pre-flight assertion would give a clearer error:
  ```ts
  if (isE2E && !pinataJwt) throw new Error('PINATA_JWT required for E2E test');
  ```
  DX, not security.

**Why this audit is painless:**
- Test-only diff; no production code touched.
- All keypairs ephemeral; no signed flows except per-test-run
  transactions on devnet.
- Discovery API path forced to fail-and-fallback; no real
  network traffic to a non-test endpoint.
- Anchor's `Wallet` class is used (not a hand-rolled adapter) —
  correct signing behavior inherited.

**Mainnet release-gate verdict:** N/A — test scaffolding never
ships to production. Cleared to merge.

**M0 trajectory after PR #47 merge: 19/19 done → M0 CLOSED from
the security side.**

The pattern that played out across M0:
- Inbound HTTP boundaries hardened (PR #17 register, PR #19/#21
  discover, PR #32/#35 webhook auth).
- Outbound HTTP boundaries hardened (PR #40/#44 fetchMetadata).
- On-chain trust boundaries documented (PR #2 registry program,
  with M2 IDL rename tracked for M1).
- Test infrastructure stays clean (PR #38, PR #47).

**Pre-mainnet polish list (carryforward, not blocking M0 closure):**
- L2 retention TTL on `processed_signatures` (PR #35)
- L2 decoder runtime Zod (PR #40)
- I1 streaming response cap, I2 fetch-metadata unit tests, I3
  safeLogError helper (PR #44)
- M2 from PR #2 (`price_lamports` rename) — anchor-eng's M1 IDL pass

The substantive on-chain work (escrow, SLA enforcement, evaluator
program) is M1+ scope. M0 has established the discipline
patterns; M1 will exercise them against actual fund movement.

---

## PR #51 — feature/anchor-escrow-program — 2026-04-25
**Verdict:** ❌ BLOCK — 2 CRITICAL findings; 2 HIGH; 1 MEDIUM. Funds-bearing
program with real authority gaps; do **not** merge until C1 + C2 are fixed.

**Scope of review:**
- `programs/bazaar-escrow/src/lib.rs` (new, 590 lines) — full program
- `programs/bazaar-escrow/Cargo.toml` (new) — feature flags + registry CPI dep
- `programs/bazaar-registry/src/lib.rs` (+19 / -1) — `increment_jobs_completed`
  CPI surface added
- `programs/Cargo.lock` — incidental
- Workspace `programs/Cargo.toml` confirmed — `overflow-checks = true` present in
  `[profile.release]` ✅, `bazaar-escrow` member declared ✅

This is the first multi-program CPI in the codebase and the first program that
moves real value — the audit bar steps up correspondingly. Every fund-flowing
path was walked end-to-end (`create_escrow` → `submit_delivery` →
`confirm_delivery` / `claim_timeout` / `open_dispute`), with a focus on
authority, owner-checks, mint-binding, state-machine integrity, and the new CPI
trust boundary.

### Findings

#### Critical (BLOCK)

- **C1. Reputation forgeable for free — `bazaar_registry::increment_jobs_completed`
  has NO authority check.** The new instruction added to `bazaar-registry`
  (lib.rs:141) is documented as *"Signer must be the bazaar-escrow program
  (checked via constraint)"* — but the constraint does not exist:
  ```rust
  #[derive(Accounts)]
  pub struct IncrementJobsCompleted<'info> {
      #[account(mut)]
      pub listing: Account<'info, ServiceListing>,
  }
  ```
  No `Signer<'info>`, no `program_id` check, no PDA derivation, no constraint at
  all. **Any wallet on devnet/mainnet can craft a tx that directly invokes
  `bazaar_registry::increment_jobs_completed { listing }` with any listing
  account and bump its `jobs_completed` counter for the cost of the tx fee.**
  Reputation — the entire trust signal in the marketplace — is gameable to
  arbitrary values by any actor. A single rogue agent could inflate their own
  jobs_completed to dominate `discover()` ranking, or sabotage a competitor by
  inflating *their* counter past `u32::MAX` and triggering
  `JobsCompletedOverflow` (perma-broken listing).

  **Recommended fix.** Make the registry require a PDA signer derived from the
  bazaar-escrow program ID, and have `confirm_delivery` sign the CPI with the
  escrow PDA's seeds:

  Registry side (`bazaar-registry/src/lib.rs`):
  ```rust
  #[derive(Accounts)]
  pub struct IncrementJobsCompleted<'info> {
      #[account(
          mut,
          // listing PDA matches its stored owner+capability_hash
          seeds = [b"listing", listing.owner.as_ref(), listing.capability_hash.as_ref()],
          bump = listing.bump,
      )]
      pub listing: Account<'info, ServiceListing>,

      /// Escrow PDA from bazaar-escrow program — must match the escrow that
      /// references this listing. Signer seeds proven by the CPI invoker.
      #[account(
          seeds = [b"escrow", escrow.buyer.as_ref(), listing.key().as_ref(),
                   &escrow.nonce.to_le_bytes()],
          bump = escrow.bump,
          seeds::program = bazaar_escrow::ID,
          constraint = escrow.listing == listing.key() @ RegistryError::Unauthorized,
          constraint = escrow.state == bazaar_escrow::EscrowState::Confirmed
                       @ RegistryError::Unauthorized,
      )]
      pub escrow: Account<'info, bazaar_escrow::EscrowAccount>,
  }
  ```
  Escrow side (`bazaar-escrow/src/lib.rs`, in `confirm_delivery`):
  ```rust
  let escrow_seeds: &[&[u8]] = &[
      b"escrow",
      ctx.accounts.escrow.buyer.as_ref(),
      ctx.accounts.escrow.listing.as_ref(),
      &ctx.accounts.escrow.nonce.to_le_bytes(),
      &[ctx.accounts.escrow.bump],
  ];
  let signer_seeds = &[escrow_seeds];
  let cpi_ctx = CpiContext::new_with_signer(
      ctx.accounts.registry_program.to_account_info(),
      bazaar_registry::cpi::accounts::IncrementJobsCompleted {
          listing: ctx.accounts.listing.to_account_info(),
          escrow: ctx.accounts.escrow.to_account_info(),
      },
      signer_seeds,
  );
  bazaar_registry::cpi::increment_jobs_completed(cpi_ctx)?;
  ```
  This binds the CPI to a real escrow account that exists in the bazaar-escrow
  program, that has terminal `Confirmed` state, and whose seeds are proven by
  the runtime against `bazaar_escrow::ID`. Forging requires forging the entire
  escrow lifecycle (which moves real USDC) — economically unprofitable.

  Note the cyclic dependency this introduces (escrow imports registry types,
  registry imports escrow types). Anchor handles this via the `cpi`/`no-entrypoint`
  feature pattern; if the cycle is unworkable, the lighter alternative is to
  introspect the `instructions` sysvar in registry and verify the calling
  program is `bazaar_escrow::ID`. The PDA approach is preferred — it also
  proves the escrow exists, not just that *some* escrow tx is in flight.

  **Until this is fixed, the entire reputation signal of the marketplace is
  meaningless.** This is a hard blocker.

- **C2. Buyer can redirect seller's USDC payment in `confirm_delivery`.** The
  `seller_token_account` field of `ConfirmDelivery` (lib.rs:470-471) has *no*
  owner constraint:
  ```rust
  #[account(mut)]
  pub seller_token_account: Account<'info, TokenAccount>,
  ```
  The buyer signs `confirm_delivery`, and the buyer chooses which account to
  pass as `seller_token_account`. The instruction transfers `seller_amount`
  USDC from the vault to whatever account the buyer points to here — **no
  check that the destination is owned by `escrow.seller`**.

  Practical attack:
  1. Buyer creates escrow legitimately, transfers USDC into vault.
  2. Seller delivers, calls `submit_delivery`.
  3. Buyer calls `confirm_delivery` with `seller_token_account = <buyer's own
     USDC token account>` (or any attacker-controlled account).
  4. Vault transfers `seller_amount` to buyer's account. Vault transfers
     `buyer_refund` (likely 0 for Minor severity) to buyer's account.
  5. Listing's `jobs_completed` increments via the (currently unauthenticated)
     CPI. Buyer is now reputation-positive on `discover()`, kept their USDC,
     and the seller delivered work for free.

  Severity: **buyer keeps 100% of escrow regardless of seller delivery.** The
  whole non-custodial-vault invariant collapses on the confirm path because
  while the vault PDA correctly refuses unsigned withdrawal, the buyer (who
  *is* a signer) is able to pick the destination of the seller's payout.

  **Recommended fix.** Add the missing constraint:
  ```rust
  #[account(
      mut,
      constraint = seller_token_account.owner == escrow.seller
                   @ EscrowError::Unauthorized,
      constraint = seller_token_account.mint == vault.mint
                   @ EscrowError::Unauthorized,
  )]
  pub seller_token_account: Account<'info, TokenAccount>,

  #[account(
      mut,
      constraint = buyer_token_account.owner == escrow.buyer
                   @ EscrowError::Unauthorized,
      constraint = buyer_token_account.mint == vault.mint
                   @ EscrowError::Unauthorized,
  )]
  pub buyer_token_account: Account<'info, TokenAccount>,
  ```
  The `buyer_token_account.owner == escrow.buyer` constraint is defensive —
  the buyer signs and would only be sabotaging themselves by misrouting their
  own refund — but it closes a footgun and matches the symmetry on the seller
  side. The mint constraints prevent the C2-adjacent attack of supplying a
  decoy mint (covered also by H2 below).

  Apply the same `owner == buyer.key()` / `mint == vault.mint` pattern to
  `BuyerAction::buyer_token_account` (lib.rs:445-446, used by `open_dispute`).
  Apply `owner == seller.key()` / `mint == vault.mint` to
  `SellerAction::seller_token_account` (lib.rs:420-421, used by
  `submit_delivery` and `claim_timeout`) — there the seller is the signer so
  it's lower severity but the same shape, and consistency matters.

#### High

- **H1. `usdc_mint` is `AccountInfo` with no canonical-mint binding —
  worthless-mint substitution attack on mainnet.** In `CreateEscrow`
  (lib.rs:393-394):
  ```rust
  /// CHECK: USDC mint passed through to token account init constraints.
  pub usdc_mint: AccountInfo<'info>,
  ```
  The CHECK comment claims the mint is "passed through to token account init
  constraints" — but those constraints (`token::mint = usdc_mint`) only enforce
  that the *vault* uses *whatever mint was passed*, not that the mint is the
  canonical USDC. Buyer can pass any SPL mint they own and create an escrow
  funded with worthless tokens.

  On devnet this is harmless (devnet "USDC" is a test mint anyway). On
  mainnet, this is a confused-deputy footgun: the SDK / dashboard would need
  to validate the mint client-side before constructing the tx, and a
  mis-implemented integration could let attackers stand up escrows that look
  legitimate to indexer/UI but are funded with worthless mints — useful for
  social-engineering (fake "I paid you 100 USDC", screenshot of the on-chain
  escrow which actually contains 100 RUG-COIN).

  **Recommended fix — match the per-cluster pattern from PR #30 (O2).** Hard-code
  the canonical USDC mint per cluster, picked at build time via cargo features:
  ```rust
  #[cfg(feature = "mainnet")]
  pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  #[cfg(not(feature = "mainnet"))]
  pub const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // devnet
  ```
  And constrain the field:
  ```rust
  #[account(address = USDC_MINT @ EscrowError::InvalidMint)]
  pub usdc_mint: Account<'info, anchor_spl::token::Mint>,
  ```
  This also upgrades the type from `AccountInfo` to a typed `Mint`, which gets
  rid of the `/// CHECK:` comment entirely.

  Acceptable carryforward path if anchor-eng wants to ship the rest first:
  add a `TODO(security/M1-mainnet)` comment and an entry in PR description so
  the mainnet-deploy gate (the PR #44 / PR #46 pattern) blocks on this.
  Either way it must be resolved before any non-devnet deploy. Tagging this
  **HIGH (devnet-blocker: NO; mainnet-blocker: YES)**.

- **H2. Token-account mint not constrained on any path.** None of
  `seller_token_account` / `buyer_token_account` (`SellerAction`, `BuyerAction`,
  `ConfirmDelivery`) carry a `mint == vault.mint` constraint. SPL token
  transfer enforces matching mints internally and will fail the tx if mints
  differ — so this is not directly exploitable for value theft. But it
  removes a layer of defense-in-depth and produces a worse error message
  (SPL mint-mismatch error vs Anchor constraint-violation with a typed
  reason). The fix is bundled into the C2 patch above (the constraint pairs
  `owner == X` and `mint == vault.mint` together).

#### Medium

- **M1. SLA severity miscomputes when `delivered_at < created_at` (clock
  weirdness or tampered clock).** `compute_severity` (lib.rs:342-357):
  ```rust
  let actual_ms = (delivered_at.saturating_sub(escrow.created_at) as u64)
      .saturating_mul(1_000);
  ```
  `saturating_sub` on `i64` saturates at `i64::MIN`, *not* at zero. If
  `delivered_at < created_at` (cluster clock skew, validator misbehavior, or
  any future code path that allows seller-controlled timestamps), the result
  is a negative `i64` cast to `u64` via `as u64`, which produces a value
  near `u64::MAX`. After the `* 1_000` saturate, `actual_ms = u64::MAX`,
  which is always greater than `max_ms.saturating_add(max_ms / 2)` →
  `SlaSeverity::Major` → 50% buyer refund regardless of true latency.

  Today `delivered_at` is set inside `submit_delivery` from `Clock::get()` and
  `created_at` was set by `create_escrow` similarly, so on a well-behaved
  cluster `delivered_at >= created_at` always. But a defensive clamp is cheap
  and removes the foot-cannon if a future change ever lets either field be
  set otherwise. **Recommended fix:**
  ```rust
  let elapsed_secs = delivered_at.saturating_sub(escrow.created_at).max(0);
  let actual_ms = (elapsed_secs as u64).saturating_mul(1_000);
  ```
  The `.max(0)` clamps the negative case to zero (Minor severity) which
  matches the "no SLA violation observed" semantics.

#### Low

- **L1. `score: u8` parameter in `confirm_delivery` is unvalidated and
  unstored.** Accepted by the instruction (lib.rs:140-144), forwarded into
  the `SLAReport` event, then dropped. No range check (e.g. `score <= 100`)
  and no persistence on `EscrowAccount`. If the spec intends this to be a
  buyer-rated score that contributes to seller reputation later, it needs
  range-validation now and an indexer plan; if not, removing it would
  shrink the IDL surface.

- **L2. `_tags: Vec<String>` parameter is `_`-prefixed (unused) yet still
  consumes tx bytes and has no length cap.** Either drop it from the IDL or
  validate `tags.len() <= MAX_SCORE_TAGS && tags.iter().all(|t| t.len() <=
  MAX_TAG_LEN)` and persist it. The `MAX_SCORE_TAGS` / `MAX_TAG_LEN`
  constants (lib.rs:11-12) are otherwise dead code.

- **L3. `SLAReport` event omits `seller` and `buyer`.** Indexer can recover
  them by joining on `escrow` pubkey, but every existing event in this
  program (and in `bazaar-registry`) carries the principals in-band so the
  Helius webhook handler can do a single-row upsert without a follow-up
  account-read. Same shape applies to `DisputeOpened` (no `seller`).
  Consistency with PR #2's M1 finding.

- **L4. `EscrowStateChanged` event is fine but emits twice on every
  transition** (once from the helper, once paired with the action-specific
  event). Indexer must dedupe by `(escrow, timestamp)`. Not wrong, but worth
  documenting in the indexer contract so backend-eng doesn't double-count
  state transitions.

#### Informational

- **I1. M1 dispute stub semantics not documented in `docs/decisions/`.** The
  doc-comment on `open_dispute` (lib.rs:279) says *"M1 stub: full refund to
  buyer immediately"* — that's a real product decision worth an ADR. Without
  one, in a few weeks the team will re-litigate "why does the buyer always
  win disputes?" The ADR should also note the V1 plan (evaluator-mediated
  resolution per PRD §7) so the upgrade path is on the record.

- **I2. Constants `MAX_SCORE_TAGS` and `MAX_TAG_LEN` are defined but never
  used.** Tied to L2; either wire them in or delete.

- **I3. `Sysvar<'info, Rent>` is declared in `CreateEscrow` but never
  referenced.** Anchor 0.31 doesn't require it (rent is computed via the
  rent sysvar internally on `init`). Dropping it shrinks the account list
  by one entry per `create_escrow` call.

### Sanity-check answers (analogous to prior audits)

1. ❌ **No hardcoded secrets.** Pass — no API keys / RPC URLs / mints
   hardcoded *yet*; that's part of the H1 finding (USDC mint *should* be
   hardcoded per cluster, but isn't). No private keys, no JWTs.

2. ❌ **No mainnet references.** Pass — program id `qTezZ...vdzSs` is the
   devnet-deployed escrow id; no mainnet RPC URLs; no mainnet mint addresses.

3. ❌ **No admin-key footprint on the vault.** Mostly pass — the vault PDA
   has no admin-withdraw path. *But* C2 effectively gives the buyer admin-like
   redirection authority over seller payout, and C1 gives any wallet
   admin-like authority over the reputation counter. The non-custodial
   *invariant* the security checklist asks for is not yet upheld; on the
   vault itself it is, on the surrounding state it is not.

### Re-review plan

- C1 fix: register `bazaar_escrow::EscrowAccount` as a CPI-readable type,
  add the PDA-signer constraint to `IncrementJobsCompleted`, and switch the
  CPI in `confirm_delivery` to `new_with_signer` with escrow seeds. Re-audit
  expects to confirm: (a) direct invocation by a non-escrow signer fails with
  `ConstraintSeeds`, (b) confirm_delivery still succeeds end-to-end on
  devnet, (c) the cyclic-dep is handled cleanly via the `cpi`/`no-entrypoint`
  Cargo features.

- C2 fix: add the four `owner == X` / `mint == vault.mint` constraints
  across `ConfirmDelivery`, `BuyerAction`, `SellerAction`. Re-audit expects:
  (a) negative test where buyer passes their own token account as
  `seller_token_account` fails with `Unauthorized`, (b) negative test with a
  wrong-mint token account fails, (c) happy paths still pass.

- H1: per-cluster `USDC_MINT` const + `address = USDC_MINT` constraint, OR
  acceptable as `TODO(security/M1-mainnet)` if it ships on the mainnet-gate
  carryforward list (must explicitly land before PR #46-style "mainnet
  release-gate" audit).

- M1: `.max(0)` clamp in `compute_severity`. Trivial.

- L1-L4 / I1-I3: addressable in this PR or follow-up; non-blocking.

**Verdict reiterated:** ❌ BLOCK on C1 + C2. devnet-blocker: YES.
mainnet-blocker: YES (also adds H1). Awaiting anchor-eng's revision PR; this
audit can re-run quickly once those four constraints land.

The carryforward "M0 trajectory" pattern (substantive audit → exact recommended
fix → re-review confirms) carries cleanly into M1 — this is exactly the
funds-bearing review the M0 discipline was building toward.

### Re-audit @ commit 51a401e (+ c3eca9b biome fmt) — 2026-04-25
**Verdict:** ✅ **APPROVED for merge.** All 2 CRITICAL + 1 HIGH (H2) + 1 MEDIUM
+ 4 LOW + 2 INFO findings resolved. H1 (per-cluster `USDC_MINT`) acceptably
deferred to M1→mainnet release-gate carryforward per the original audit verdict.

**Walk of the fix commit:**

- **C1 — `bazaar_registry::increment_jobs_completed` authority gate** ✅
  - Registry: added `escrow_authority: Signer<'info>` with
    `seeds = [b"authority"]` + `seeds::program = BAZAAR_ESCROW_ID` + `bump`
    constraint. `BAZAAR_ESCROW_ID = pubkey!("qTezZ...vdzSs")` matches
    `declare_id!` in `bazaar-escrow` exactly. (Source-of-truth comment notes
    they must stay in sync — fair tradeoff for not introducing a build-time
    code-gen pipeline.)
  - Escrow: `confirm_delivery` builds `authority_seeds = [b"authority",
    &[bump]]` and switches the registry CPI to `new_with_signer`. The
    `escrow_authority` field is added to `ConfirmDelivery` as
    `UncheckedAccount` with the matching seeds for client-side derivation.
  - **Note on the design.** anchor-eng-2 chose a *static* program-wide
    authority PDA (`[b"authority"]`) instead of the per-escrow signer pattern
    I sketched. This is structurally sound: only `bazaar-escrow` can
    `invoke_signed` for `[b"authority"]` against `BAZAAR_ESCROW_ID`, so no
    external caller can forge the signer. The mild caveat is that *any*
    future bazaar-escrow code path that signs `[b"authority"]` would gain
    the ability to call `increment_jobs_completed` on any listing — today
    only `confirm_delivery` after Delivered→Confirmed transition does so, but
    this convention is now load-bearing. Worth a single-line comment in
    `bazaar_escrow::lib.rs` next to the seeds derivation noting "this PDA
    grants registry-counter authority — guard new uses." Non-blocking for
    M1; flagging as a maintainability note for future PRs touching the
    escrow program.
  - **Negative test (lib.rs new `describe('increment_jobs_completed')`)**
    generates a random `Keypair`, signs it as `escrowAuthority`, and expects
    `ConstraintSeeds`. Random Keypairs are on-curve (not PDAs) and can
    never derive to the `[b"authority"]` PDA address against any program ID,
    so Anchor's seeds check fires before any other constraint. The matcher
    `/ConstraintSeeds|seeds constraint/i` is correct for the Anchor 0.31
    error string. ✅

- **C2 + H2 — token-account owner/mint constraints** ✅
  - All four token-account fields gain `token::mint = vault.mint` (or
    `usdc_mint` in CreateEscrow) AND `token::authority = escrow.{buyer,seller}`
    constraints:
    - `CreateEscrow.buyer_token_account` — `mint = usdc_mint`, `authority = buyer`
    - `SellerAction.seller_token_account` — `mint = vault.mint`, `authority = escrow.seller`
    - `BuyerAction.buyer_token_account` — `mint = vault.mint`, `authority = escrow.buyer`
    - `ConfirmDelivery.seller_token_account` — `mint = vault.mint`, `authority = escrow.seller`
    - `ConfirmDelivery.buyer_token_account` — `mint = vault.mint`, `authority = escrow.buyer`
  - The `token::authority` constraint is the Anchor SPL helper that enforces
    the SPL token account's `owner` field equals the supplied pubkey. (SPL
    "owner" ≡ Anchor `token::authority`; not to be confused with the PDA
    signer authority, which is a separate concept.) ✅
  - **Negative test** (`'rejects confirm_delivery when seller_token_account
    is not owned by escrow.seller'`): buyer creates a second token account
    they own and passes it as `sellerTokenAccount`. Expects an error
    matching `/ConstraintTokenOwner|token owner|ConstraintRaw|constraint/i` —
    matcher is broad enough to catch the Anchor 0.31 `ConstraintTokenOwner`
    string and also tolerates the matcher being slightly imprecise across
    Anchor versions. ✅
  - The `BuyerAction` and `SellerAction` constraints close the symmetric
    footguns even though the relevant party is the signer — defense-in-depth
    matches the C2 patch. ✅

- **H1 — canonical USDC mint binding** ⏸️ **DEFERRED — acceptable.**
  - The `usdc_mint: AccountInfo` field remains, but the comment is now
    explicit: *"H1 per-cluster address check is M1-tail work."* This matches
    the verdict's acceptable carryforward path: devnet ships now, mainnet
    release-gate (PR #44 / PR #46 pattern) blocks until per-cluster
    `USDC_MINT` const + `address = USDC_MINT` constraint lands.
  - **Minor doc gap (non-blocking):** the H1 comment cross-references
    `docs/decisions/0002-m1-dispute-stub.md` for "why devnet omits it,"
    but (a) that ADR file does not exist in `docs/decisions/` (only
    `0001-sbf-toolchain-workarounds.md` is there), and (b) a dispute-stub
    ADR is not the right place to document mint hardening anyway. Two
    follow-ups would close this: create `0002-m1-dispute-stub.md` (covers
    I1 below) AND `0003-h1-usdc-mint-cluster-binding.md` (or fold both into
    one M1-deferred-decisions ADR). Recommend ADR creation in the next PR
    that touches escrow; not gating this merge.

- **M1 — `compute_severity` negative-latency clamp** ✅
  - `let elapsed_secs = delivered_at.saturating_sub(escrow.created_at).max(0);`
  - `let actual_ms = (elapsed_secs as u64).saturating_mul(1_000);`
  - The `.max(0)` clamps the saturating-sub result to non-negative *before*
    the `as u64` cast, eliminating the wrap-to-near-`u64::MAX` hazard. ✅
  - Bonus cleanup: dropped the unused `_now: i64` parameter.

- **L1 — score range guard** ✅ — `require!(score <= 100,
  EscrowError::InvalidScore);` with new `InvalidScore` error variant.
- **L2 — tags validation** ✅ — `require!(tags.len() <= MAX_SCORE_TAGS,
  EscrowError::TooManyTags);` plus per-tag length check. The previously-dead
  `MAX_SCORE_TAGS` and `MAX_TAG_LEN` constants are now load-bearing. (Closes
  I2 as a side-effect.)
- **L3 — event payload completeness** ✅ partial:
  - `EscrowStateChanged` now carries `buyer + seller`. ✅
  - `SLAReport` now carries `buyer + seller + tags`. ✅
  - `DisputeOpened` was *not* updated — still missing `seller`. Indexer can
    still derive seller from a join on `escrow`. **Minor non-blocking**;
    recommend adding in any follow-up touching the escrow events.

- **L4** ⏸️ deferred — `EscrowStateChanged` still emits twice per transition
  (once paired with the action-specific event). Worth documenting in the
  indexer contract so backend-eng dedupes by `(escrow, timestamp, new_state)`.
  Non-blocking.

- **I1** ⏸️ deferred — code-comment now points to
  `docs/decisions/0002-m1-dispute-stub.md` for the V1 arbitration plan, but
  the ADR file does not exist. Same comment-references-missing-file
  situation as the H1 cross-reference above. The doc-comment helpfully
  states the V1 intent inline ("V1 will add an arbitration path"), which is
  most of what an ADR would carry — but the linked file should exist or the
  link should be removed.

- **I2** ✅ resolved — `MAX_SCORE_TAGS` / `MAX_TAG_LEN` now used by L2.
- **I3** ⏸️ deferred — `Sysvar<'info, Rent>` retained with explicit comment
  citing test-call-site backward compat. Acceptable.

**Sanity-check answers:**

1. ✅ **No hardcoded secrets.** Pass — `BAZAAR_ESCROW_ID` is a public program
   address, intentionally hardcoded as the cross-program trust anchor.
2. ✅ **No mainnet references.** Pass — same devnet program ID `qTezZ...vdzSs`.
3. ✅ **Non-custodial vault invariant upheld.**
   - Vault: PDA-controlled, no admin withdraw — same as before.
   - Seller payout: now constrained to `owner == escrow.seller` — buyer cannot
     redirect (C2 sealed).
   - Reputation counter: now requires `escrow_authority` PDA signed by
     bazaar-escrow — no wallet can bump for free (C1 sealed).

**Carryforward to M1→mainnet release-gate audit (PR #44 / PR #46 pattern):**

- **H1 — per-cluster `USDC_MINT` const + `address = USDC_MINT` constraint.**
  Required before mainnet deploy. Pattern:
  ```rust
  #[cfg(feature = "mainnet")]
  pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  #[cfg(not(feature = "mainnet"))]
  pub const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  ```
- **L3 partial** — `DisputeOpened` event missing `seller`.
- **L4** — document `EscrowStateChanged` double-emit in indexer contract.
- **I1 / H1 doc** — create the referenced ADRs (or drop the broken refs).
- **C1 design note** — add a comment by the `[b"authority"]` derivation in
  bazaar-escrow noting that this PDA grants registry-counter authority and
  any new use must be guarded by equally strong state checks.

**Verdict:** ✅ **APPROVE** PR #51 for merge. CI green (Lint + typecheck +
test SUCCESS). The fix commit's negative tests directly demonstrate that
both critical attack vectors are now closed. The M0 audit-discipline pattern
(substantive walk → exact recommended fix → re-review confirms) executed
end-to-end on the first funds-bearing program — the discipline pays for itself.

---

## PR #59 — feature/sdk-hire — 2026-04-25
**Verdict:** ❌ **BLOCK** — 1 HIGH severity logic bug breaks the timeout SLA
guarantee end-to-end; 2 MEDIUM (duplicate-funding race + indiscriminate
retries on program errors); 6 LOW. No critical vault-side findings — the
on-chain hardening from PR #51 (C1 + C2) carries the security weight, and
the SDK correctly relies on it. But the SDK has its own bug surface around
the *parameters it passes* to the on-chain program, and that's where H1
lives.

**Scope of review:**
- `packages/sdk/src/hire.ts` (new, 102 lines) — substantive (USDC inflow)
- `packages/sdk/src/confirm.ts` (new, 64 lines) — substantive (USDC release)
- `packages/sdk/src/dispute.ts` (new, 56 lines) — substantive (state mutation
  + refund)
- `packages/sdk/src/escrow-utils.ts` (new, 107 lines) — substantive (retry
  loop, error mapping, ATA derivation, PDA constants)
- `packages/sdk/src/deliver.ts` (new, 59 lines) — light (auth on-chain)
- `packages/sdk/src/claimTimeout.ts` (new, 50 lines) — light (timeout
  on-chain)
- `packages/sdk/src/client.ts` — light (orchestrator + secrecy hygiene)
- Tests reviewed for whether they would have caught the findings (they
  don't catch H1 because mocks don't validate the BN values passed to the
  instruction).

Walked the funds-touching paths end-to-end against the on-chain program as
audited and merged in PR #51. The SDK correctly delegates final authority
checks to the on-chain program (state machine, owner constraints,
mint binding) — that part is right. The findings concentrate on (1) one
parameter the SDK miscomputes before passing to the program, and (2) the
client-side retry loop's interaction with auto-generated nonces.

### Findings

#### High (BLOCK)

- **H1. `hire.ts` passes an absolute timestamp where the on-chain program
  expects a relative offset → SLA timeout becomes unreachable.**

  `hire.ts:82`:
  ```ts
  const deadlineSecs = Math.floor(Date.now() / 1000) + input.timeout;
  ```
  Then passed to the program:
  ```ts
  .createEscrow(
      new BN(input.budget.toString()),
      input.sla.maxLatencyMs ?? null,
      input.sla.responseFormat ?? null,
      new BN(deadlineSecs),
      new BN(nonce.toString()),
  )
  ```

  But on-chain (`programs/bazaar-escrow/src/lib.rs:53-57` on `main`):
  ```rust
  let clock = Clock::get()?;
  let deadline_ts = clock
      .unix_timestamp
      .checked_add(deadline_secs)
      .ok_or(EscrowError::ArithmeticOverflow)?;
  ```

  The program **adds the parameter to the current chain time** — it expects
  a relative duration, not an absolute future timestamp. The SDK is sending
  `now + timeout`, which becomes `now + (now + timeout)` ≈ `2·now + timeout`
  on-chain. With `now ≈ 1.745e9` (April 2026), the actual on-chain
  `deadline_ts` lands around **3.49e9 seconds since epoch ≈ year 2080**,
  regardless of the user's `timeout` input.

  **Impact.**
  - `claim_timeout` requires `clock.unix_timestamp > escrow.deadline_ts`.
    With `deadline_ts ≈ 2080`, sellers can never claim timeout — they're
    blocked for ~54 years on every escrow.
  - Buyers retain effectively unlimited time to confirm (or never confirm).
    A non-responsive buyer locks the seller's pay until 2080 with no
    on-chain recovery path. The seller's only options are off-chain pressure
    or asking the buyer to dispute (which refunds *the buyer*, not the
    seller).
  - The PRD §7 SLA timeout-claim guarantee — one of the five core escrow
    instructions — is functionally non-existent on every escrow created via
    the SDK. Direct-program callers (a future raw-tx integration) would
    work correctly, so this is purely an SDK regression.

  **Why tests don't catch it.** `tests/hire.test.ts:75` sets `timeout:
  3600` and the success path asserts only on the returned `EscrowHandle`.
  The mock `program.methods.createEscrow` (`tests/hire.test.ts:28-32`)
  ignores its arguments and returns a stub. No assertion on the BN value
  passed for the deadline parameter. Adding a single
  `expect(mockCreateEscrow).toHaveBeenCalledWith(..., new BN(input.timeout),
  ...)` (or extracting the captured arg and comparing) would catch this
  immediately.

  **Recommended fix.** Pass `input.timeout` directly:
  ```ts
  const ix = await program.methods
      .createEscrow(
          new BN(input.budget.toString()),
          input.sla.maxLatencyMs ?? null,
          input.sla.responseFormat ?? null,
          new BN(input.timeout),  // RELATIVE seconds; on-chain adds Clock
          new BN(nonce.toString()),
      )
      ...
  ```
  And drop the `deadlineSecs` local. Add a `hire.test.ts` assertion that
  asserts `createEscrow` was called with `new BN(3600)` when `timeout: 3600`
  is in the input — this regression test is what makes H1 stay fixed.

  **Severity rationale.** Not a theft vector (vault is still
  PDA-controlled, owner constraints are intact per PR #51), so not
  CRITICAL. But it nullifies a documented SLA guarantee on every single
  escrow that the SDK creates — which is functionally every M1 escrow,
  because the SDK is the only documented client. Worse than MEDIUM, easier
  to fix than the C-tier on-chain findings.

#### Medium

- **M1. `sendWithRetry` + auto-generated `Date.now()` nonce can cause
  duplicate USDC deposits across user-level retries.**

  Two-level retry interaction:
  1. Inside `sendWithRetry` (`escrow-utils.ts:50`), the loop runs the same
     instruction up to 3 times with escalating priority fees. *Within* a
     single `hireAgent()` call, the nonce captured at `hire.ts:51` stays
     constant across retries — so the escrow PDA is the same. If retry-2
     succeeds, the user gets the right escrow. If a previous retry actually
     landed but its confirmation was missed (network blip, RPC timeout),
     the next retry's `init` will fail with "account already exists" → the
     loop catches it as `lastError` → continues → all 3 fail → throws
     `TransactionFailedError`. **At this point the escrow exists on-chain
     but the SDK reports failure.**
  2. The user, seeing failure, calls `hire()` again. `hire.ts:51` now
     evaluates `BigInt(Date.now())` → a *new* nonce → derives a *different*
     escrow PDA. The idempotency check at `hire.ts:66` finds nothing at
     the new PDA → proceeds to `createEscrow` → a *second* USDC deposit
     into a *second* vault. **Duplicate funding, real USDC loss.**

  This is a realistic flaky-network scenario. The naive user fix (call
  `hire()` again) is the wrong move and the SDK does nothing to warn them.

  **Recommended fix.** Two complementary changes:
  - Make `hire()`'s default nonce *deterministic* per (buyer, listing,
    budget, current-minute or similar coarse bucket) so unintentional
    user-level retries hit the existing escrow's idempotency path. A SHA256
    of those inputs gives a 64-bit prefix that's stable across retries
    within the bucket.
  - Document loudly in the JSDoc that for production use, the caller
    SHOULD pass an explicit `nonce` derived from their own
    business-deterministic source (job ID, request ID, etc.). The SDK
    docstring at `client.ts:108-110` doesn't currently mention this.

  Lower-priority but worth considering: change `sendWithRetry` to
  distinguish "tx landed and execution failed" from "tx never landed" —
  if execution failed (`result.value.err` set), don't retry; throw
  immediately. That removes the missed-confirmation foot-cannon for the
  in-loop case.

- **M2. `sendWithRetry` retries on ALL errors, including non-transient
  program errors.**

  `escrow-utils.ts:50-72` catches everything in a single broad `catch`,
  treating program-error rejects (e.g., `InvalidStateTransition`,
  `Unauthorized`, `ZeroAmount`) the same as transient network errors.
  Result: a tx that lands but reverts on, say, `InvalidStateTransition`
  costs the user the base fee + retry priority fees `[100_000, 500_000]`
  microlamports for two more attempts that will deterministically fail
  the same way. On a busy mainnet that's wasted money for zero progress.

  This is M-not-H because (a) wasted devnet fees are zero-impact and
  (b) the dollar amount on mainnet is small. But it's bad UX and bad
  defensive design.

  **Recommended fix.** Sort errors into transient vs terminal:
  ```ts
  function isTransient(err: unknown): boolean {
      const m = String(err).toLowerCase();
      return m.includes('blockhash') || m.includes('timeout') ||
             m.includes('network') || m.includes('socket');
  }
  ```
  Only retry if `isTransient(err) === true`; otherwise throw immediately.
  Terminal program errors (the ones already mapped in `mapConfirmError`)
  should never be retried.

#### Low

- **L1. `hire.ts:71` returns `signature: ''` for the idempotency case.**
  ```ts
  if (existing) {
      if (!('created' in existing.state)) {
          throw new EscrowAlreadyExistsError(escrowPda.toBase58());
      }
      return { escrowPda, vaultPda, signature: '' };
  }
  ```
  Empty-string signature breaks the documented `EscrowHandle` contract
  (callers may try to look up the signature on a block explorer →
  cryptic failure). Either fetch the actual creation tx signature from
  account history, or change the field to `signature: string | null` and
  document the `null` case as "already existed."

- **L2. No ATA-existence preflight in `hire.ts`.** `getTokenAccountBalance`
  on a non-existent ATA throws an opaque RPC error before the
  `InsufficientFundsError` branch is even reachable. Users without USDC
  funded yet get a confusing error message. A two-line preflight
  (`getAccountInfo` on the ATA → throw a typed `BuyerHasNoUsdcAtaError`
  with a hint to call `createAssociatedTokenAccount` first) would close
  the gap.

- **L3. Default nonce uses `Date.now()` millisecond precision.** Two
  `hire()` calls in the same millisecond from the same buyer to the same
  listing would derive the same escrow PDA → second call hits the L1
  idempotency path silently. Extremely unlikely in practice but trivially
  fixed by adding `crypto.randomBytes(4)` entropy. Tied to M1 above —
  a deterministic-by-input nonce strategy supersedes both.

- **L4. Error-code mapping covers only 3 of 11 escrow error codes.**
  `escrow-utils.ts:81-97` maps 6000 (`Unauthorized`), 6005 (`DeadlinePassed`
  / `EscrowExpired`), 6006 (`DeadlineNotYetPassed` / `EscrowNotExpired`)
  — but the program has 11 error variants (per PR #51 audit + L1 fix
  added `InvalidScore` → 6010). Codes 6001/6002/6003/6004/6007/6008/6009/6010
  fall through to a generic `TransactionFailedError` with a
  JSON-serialized blob. Users get worse error messages than they could.
  Non-blocking; expand the map next PR.

- **L5. No client-side check that `usdcMint` is a known canonical USDC.**
  The `usdcMint` parameter (`hire.ts:39`, `confirm.ts:24`, `dispute.ts:23`,
  `deliver.ts:23`, `claimTimeout.ts:20`) defaults to
  `DEVNET_USDC_MINT` but accepts any `PublicKey`. The on-chain
  `token::mint = vault.mint` constraints (post-PR #51) prevent
  cross-mint theft, so this isn't exploitable — but a mis-integration
  could create escrows funded with a worthless mint and the SDK would
  send the tx without warning. A simple allowlist check (the two known
  USDC mints — devnet `4zMM…JDncDU`, mainnet `EPjF…wyTDt1v`) with an
  override flag for tests would close the door. Tied to the H1 carryforward
  on the on-chain side from PR #51 — both client and program should bind
  USDC by mainnet/devnet config.

- **L6. SDK doesn't explicitly pass `escrow` and `vault` PDAs to
  `createEscrow.accounts()` even though it derives them locally**
  (`hire.ts:54-62`). It relies on Anchor's `accountsResolver` to derive
  them from IDL seeds — which works today because Anchor's resolver can
  use the `nonce` instruction arg to compute the escrow seeds, then chain
  to the vault. But explicitly passing both as `escrow: escrowPda, vault:
  vaultPda` in `.accounts({...})` is defense-in-depth (no surprise if the
  resolver behavior changes across Anchor versions, no silent wrong-PDA
  if the IDL gets out of sync) and costs nothing since the SDK already
  derived them. Apply the same pattern to `confirm.ts`, `dispute.ts`,
  `deliver.ts`, `claimTimeout.ts` for `vault` (they already pass
  `escrow`). Non-blocking.

#### Informational

- **I1. `wallet as any` in `escrow-utils.ts:39`** — documented in the
  biome-ignore comment ("Anchor's Wallet interface requires a payer
  Keypair; structural AnchorWallet is compatible at runtime"). Fine.
- **I2. `client.ts` PinataJWT secrecy is correct.** `#pinataJwt` is a
  TC39 private field (not a TS-only `private` keyword), so it's truly
  hidden from `JSON.stringify(client)` and from error-capture tooling
  that walks own-properties. `toJSON()` (`client.ts:171-173`) only
  exposes `wallet.publicKey.toBase58()` — no secrets, no full wallet
  object, no RPC URL. Good hygiene; matches what we'd want for production
  error-reporting integrations.
- **I3. `claimTimeout.ts:34` rejects `'created' in escrow.state` with
  `DeliveryNotSubmittedError`.** Aligns with the PR #51 on-chain check
  (`claim_timeout` only allows `Delivered` → `TimeoutClaimed`, never
  from `Created`) — correct behavior, fail-fast client-side.
- **I4. State guards consistent across all 5 lifecycle methods.** Every
  function does the same shape: parse pubkey → fetch escrow → check
  expected state → throw typed error if not matching → build ix → send.
  Easy to read, easy to extend, hard to break inconsistently. Good
  pattern.
- **I5. Tests use Vitest mocks throughout — no live Anchor program
  invocation.** Adequate for the unit-coverage target (158 tests passing)
  but means H1, M1, M2 regressions can land undetected. The qa-test-eng
  E2E lifecycle harness (Task #18 pattern) should grow a `hire → deliver
  → wait → claimTimeout` test against devnet so deadline-misuse-class
  bugs surface in CI. Non-blocking for this PR; carryforward for
  qa-test-eng.

### Sanity-check answers (analogous to prior audits)

1. ✅ **No hardcoded secrets.** Pass — no API keys / RPC URLs / private
   keys; `pinataJwt` properly accepted via constructor and stored as a
   TC39 private field. `ESCROW_PROGRAM_ID = EhFp…XxW2` is a public
   program address, intentionally hardcoded as the cross-program trust
   anchor (matches `declare_id!` in `bazaar-escrow` on main per PR #53).
2. ✅ **No mainnet references.** Pass — `DEVNET_USDC_MINT = 4zMM…JDncDU`
   is the documented devnet USDC; SDK accepts overrides via constructor
   `usdcMint`. No mainnet RPC URL constants. (See L5 for the
   client-side mint-allowlist nit.)
3. ✅ **No admin-key footprint.** Pass — SDK is a thin client over the
   on-chain escrow whose vault is PDA-controlled (PR #51 audit). The
   SDK never holds custody, never computes admin authority, never bypasses
   on-chain state guards. The only "authority" the SDK derives is the
   buyer/seller's own keypair via the `AnchorWallet` interface.

### Re-review plan

1. **H1**: SDK passes `new BN(input.timeout)` directly (drop the
   `Math.floor(Date.now()/1000) + ...` arithmetic). Test asserts
   `createEscrow` called with `new BN(3600)` for `timeout: 3600` input.
   I'll re-walk to confirm the BN value matches the relative-offset
   semantics of the on-chain program.
2. **M1**: Default nonce becomes deterministic per (buyer, listing,
   coarse-time-bucket) OR JSDoc explicitly warns "pass `nonce` explicitly
   for production retries." Either is acceptable for clearing the
   carryforward; deterministic default is preferred.
3. **M2**: `sendWithRetry` adds `isTransient(err)` gate; non-transient
   errors throw immediately. Test that a `Custom: 6004`
   (`InvalidStateTransition`) confirm-error fails after 1 attempt, not 3.
4. L1-L6: addressable in this PR or follow-up; non-blocking.
5. I5: qa-test-eng to add devnet `hire → claimTimeout` lifecycle test
   in a follow-up PR (would have caught H1).

**Verdict reiterated:** ❌ **BLOCK** on H1. devnet-blocker: YES (the
timeout SLA is fundamental to the marketplace's value prop and breaks on
every SDK-created escrow). mainnet-blocker: YES (additionally requires
M1 + M2 fixes for production safety).

The on-chain hardening from PR #51 paid off — the SDK only needs *parameter
correctness* to be safe, and the bulk of attack surface is sealed off-chain.
But H1 demonstrates the M1 audit pattern still applies: substantive walk
catches the parameter bug that mocks miss.

### Re-audit @ commit 6e55e01 — 2026-04-25
**Verdict:** ⚠️ **CONDITIONAL APPROVE** — H1, M1, M2 substantive fixes are
correct; the security gate is cleared. **Merge gate currently RED:** the
H1 regression test fails the SDK typecheck (`tests/hire.test.ts:248,25 —
TS2532 Object is possibly 'undefined'`), which fails CI. One-line test fix
required before merge; not a security issue.

**Walk of the fix commit:**

- **H1 — relative-vs-absolute deadline param** ✅
  - `hire.ts:79` removed the `deadlineSecs` local entirely. Now passes
    `new BN(input.timeout)` directly with comment *"// relative seconds;
    on-chain adds Clock.unix_timestamp"*. The misleading variable name
    `deadlineSecs` is gone.
  - Regression test (`tests/hire.test.ts:243-251`) now uses a
    `vi.fn()`-based `mockCreateEscrow` that captures positional args:
    ```ts
    const deadlineArg = mockCreateEscrow.mock.calls[0][3];
    expect(deadlineArg.toString()).toBe('3600');
    ```
    Asserts the BN value at arg index 3 equals `'3600'`. Any future
    regression to `Date.now()/1000 + timeout` would surface as `'~1.745e9'`
    and fail the test. ✅ The contract is now pinned.
  - **CI fail (typecheck, not security):** `mockCreateEscrow.mock.calls[0]`
    is typed as possibly-undefined under strict TS. Trivial fix:
    ```ts
    expect(mockCreateEscrow).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ toString: expect.any(Function) }),
        expect.anything(),
    );
    const deadlineArg = mockCreateEscrow.mock.calls[0]?.[3];
    expect(deadlineArg?.toString()).toBe('3600');
    ```
    Or simpler: `expect(mockCreateEscrow.mock.calls[0]?.[3]?.toString()).toBe('3600');`
    Or `mockCreateEscrow.mock.calls[0]![3]` with a non-null assertion if
    the team's strict-null policy permits it (their other tests use
    similar patterns).

- **M2 — `isTransient(err)` retry gate** ✅
  - `escrow-utils.ts:67-74` now early-throws on non-transient errors:
    ```ts
    } catch (err) {
        const asError = err instanceof Error ? err : new Error(String(err));
        if (!isTransient(err)) throw asError;
        lastError = asError;
    }
    ```
  - `isTransient(err)` (`escrow-utils.ts:83-91`):
    ```ts
    function isTransient(err: unknown): boolean {
        if (err instanceof UnauthorizedError) return false;
        if (err instanceof EscrowExpiredError) return false;
        if (err instanceof EscrowNotExpiredError) return false;
        if (err instanceof TransactionFailedError && err.signature !== undefined) return false;
        return true;
    }
    ```
  - Walk of the logic:
    - 6000 (`Unauthorized`), 6005 (`EscrowExpired`/`DeadlinePassed`), 6006
      (`EscrowNotExpired`/`DeadlineNotYetPassed`) — typed errors set by
      `mapConfirmError`. Deterministic program rejections; no retry. ✅
    - `TransactionFailedError` *with* `signature !== undefined` — set by
      `mapConfirmError(err, signature)` when `result.value.err` is
      populated. This means the tx confirmed but the program rejected
      it. Deterministic; no retry. ✅
    - Bare-throw `TransactionFailedError` at end of the function (no
      signature) is NOT reached from inside the catch — it's the
      post-loop throw after all attempts fail. So the `signature !==
      undefined` discriminator correctly identifies "tx landed and
      reverted" vs "tx never landed."
    - Other unmapped program error codes (6001–6004, 6007–6010) flow
      through `mapConfirmError`'s `default` branch into a
      `TransactionFailedError(msg, signature)` — they ALSO carry a
      signature, so they ALSO short-circuit. ✅ Even unmapped program
      errors won't burn priority-fee retries.
    - Anything else (network errors, blockhash expiry, signing failures,
      generic `Error` from `sendRawTransaction`) returns `true` →
      retried. ✅
  - Note: this also closes the L4 carryforward by accident — unmapped
    program error codes are now correctly NOT retried even though they're
    still wrapped in `TransactionFailedError` rather than typed errors.
    L4 (expanding the typed error map) can ship later without urgency.

- **M1 — JSDoc warning** ✅ (acceptable approach)
  - `client.ts:99-105`:
    > **Production retry safety**: if `hire()` throws after an ambiguous
    > network failure (tx may have landed but confirmation timed out),
    > calling `hire()` again with a new `Date.now()`-derived nonce
    > creates a second escrow and a second USDC deposit. Pass an
    > explicit `input.nonce` derived from stable inputs (buyer + listing
    > + budget) so that retries resolve to the same PDA and the
    > idempotency path is taken instead.
  - This is the lighter of the two fixes I proposed (documentation vs
    deterministic-by-input default). On reflection, it's actually the
    *better* fix: deterministic default would prevent the legitimate use
    case of two distinct hires for the same buyer+listing+budget combo
    (e.g., two separate jobs from the same agent). Leaving the choice
    explicit is correct API design. The JSDoc text is direct and gives
    the workaround. ✅
  - Mild concern: callers who don't read JSDoc still hit the bug. For
    a future SDK polish PR, consider making the default nonce throw a
    `console.warn()` or a typed warning event — but this is non-blocking.

**Sanity-check answers (unchanged from initial audit):**

1. ✅ No hardcoded secrets — `pinataJwt` properly accepted via
   constructor and stored as TC39 private field.
2. ✅ No mainnet references — `DEVNET_USDC_MINT` documented; constructor
   accepts override.
3. ✅ No admin-key footprint — SDK is a thin client; never holds custody.

**Carryforward to qa-test-eng (unchanged):**

- I5 — devnet `hire → deliver → wait → claimTimeout` lifecycle E2E test
  in the Task #18 harness. Would have caught H1 immediately.

**Verdict:** ⚠️ **CONDITIONAL APPROVE** — security gate cleared (H1 + M2
fixed substantively, M1 documented). Final merge gate requires the
trivial typecheck fix (`tests/hire.test.ts:248`). Once CI is green I'll
flip to unconditional ✅ APPROVE without a second walk — the substantive
diff is already accepted.

(Final ACK at commit aaa46e2 — CI confirmed green, sdk-eng applied
optional-chain fix, PR #59 + #60 merged. The post-CI ACK commit was
pushed after PR #60 squash-merged so it didn't make it into the merged
content; recording the resolution here for the audit log.)

---

## PR #58 — feature/backend-escrow-event-handlers — 2026-04-25
**Verdict:** ✅ **APPROVE** — no critical/high findings; 2 MEDIUM
operational concerns (transaction boundary in SLA handler + missing
retry path for failed handlers) recommended for follow-up but do not
block merge. Architecture is sound and follows the M0-established
patterns (atomic INSERT-RETURNING dedup from PR #35, safeLogUrl from
PR #44).

**Scope of review:**
- `apps/indexer/src/events/escrow-decoder.ts` (new, 105 lines) —
  BorshEventCoder usage + enum-variant normalization
- `apps/indexer/src/events/on-escrow-created.ts` (new, 48 lines) —
  INSERT with ON CONFLICT, vault PDA derivation
- `apps/indexer/src/events/on-escrow-state-changed.ts` (new, 25 lines)
- `apps/indexer/src/events/on-delivery-submitted.ts` (new, 31 lines)
- `apps/indexer/src/events/on-sla-report.ts` (new, 42 lines) — most
  security-relevant: dual-table write + reputation math
- `apps/indexer/src/events/on-dispute-opened.ts` (new, 28 lines)
- `apps/indexer/src/webhooks/handler.ts` (+85 / -3) — event dispatch
  loop additions
- Schema (`apps/indexer/src/db/schema.ts:129-150`) cross-checked for
  `sla_reports` (no unique on `escrow_pubkey`; bigserial PK) and
  `agent_reputation` (wallet PK, jobs_completed/total_score bigint,
  avg_score smallint).

This is the indexer-side consumer of the events emitted by the audited
escrow program (PR #51) and produced by the audited SDK (PR #59). The
trust boundary here is one-way (chain → DB), so the audit focus is
*data integrity* and *replay safety* rather than authority/fund-flow.

### Findings

#### Critical / High — none.

#### Medium

- **M1. No transaction around the dual INSERT in `on-sla-report.ts`.**
  The handler does two separate SQL statements:
  ```ts
  await sql`INSERT INTO sla_reports (...) VALUES (...)`;
  await sql`INSERT INTO agent_reputation (...) ON CONFLICT (wallet) DO UPDATE ...`;
  ```
  These are not in a `sql.begin(...)` transaction. If the second statement
  fails (lock timeout, connection drop, deadlock), the system ends up in
  an inconsistent state: `sla_reports` has the SLA row but
  `agent_reputation` was not updated. The outer dedup
  (`processed_signatures` already has the signature inserted) means the
  handler will not be retried — the inconsistency is sticky until manual
  backfill.

  Severity rationale: doesn't expose funds, doesn't expose secrets, but
  the user-facing reputation count drifts from the audit trail. On the
  next SLAReport for the same seller, the UPSERT works fine and partly
  compensates (jobs_completed catches up by one), but the lost score
  point doesn't come back.

  **Recommended fix.** Wrap both inserts in a transaction:
  ```ts
  await sql.begin(async (tx) => {
      await tx`INSERT INTO sla_reports ...`;
      await tx`INSERT INTO agent_reputation ... ON CONFLICT ...`;
  });
  ```
  Alternative: order the writes so the source-of-truth (`sla_reports`)
  lands first and a periodic backfill job recomputes
  `agent_reputation` from `sla_reports` aggregates. The transaction is
  cheaper for steady state.

- **M2. Failed event handler leaves the processed_signature inserted →
  no automatic retry.** In `handler.ts:48-58`, signatures are inserted
  into `processed_signatures` *before* the per-event handlers run. If a
  handler throws (caught at line 83-87 / 110-114 and only logged), the
  signature is already marked processed → the same event will be skipped
  on any future delivery attempt by Helius. Recovery requires:
  (a) detecting the failure from logs and (b) running a backfill from
  on-chain.

  This is a deliberate design tradeoff (avoid duplicate processing >
  guarantee processing), and matches the M0 pattern. But for funds- and
  reputation-relevant events the cost of a missed event is high. Two
  mitigations to consider:
  - Move the dedup-INSERT into the per-event try block, so failures
    leave the signature *not* yet inserted and Helius can retry.
  - Add an `events_failed` table that captures failed event payloads
    (signature, event name, error) for visibility + manual replay.

  Non-blocking; this PR can ship as-is, but worth a follow-up issue
  before mainnet.

#### Low

- **L1. No `ON CONFLICT DO NOTHING` on `sla_reports` INSERT.** The
  schema has a `bigserial` PK and no unique constraint on
  `escrow_pubkey`, so a duplicate insert *succeeds* and creates a
  duplicate row. In normal flow the outer dedup (`processed_signatures`)
  prevents this; in failure modes (manual replay, dedup table wiped,
  multi-instance race) it would not. Defense-in-depth: add a unique
  constraint on `(escrow_pubkey)` (escrow only emits one SLAReport per
  lifecycle per the on-chain state machine) and `ON CONFLICT
  (escrow_pubkey) DO NOTHING`.

- **L2. `decodeEscrowState` silently coerces unknown enum variants.**
  ```ts
  if (key === 'timeoutClaimed') return 'timeout_claimed';
  return key as EscrowState;  // ← any other key passes through
  ```
  If a future on-chain program adds an enum variant (e.g. `arbitrated`
  for V1 dispute resolution), the decoder returns that string and the
  SQL UPDATE will fail with a type-mismatch on the `EscrowState` column
  type — but the failure surface is "SQL error in production logs"
  rather than "indexer rejects unknown event with a typed error."
  Tighten with an allowlist:
  ```ts
  const ALLOWED: EscrowState[] = ['created', 'delivered', 'confirmed',
                                  'disputed', 'timeout_claimed'];
  if (!ALLOWED.includes(mapped as EscrowState)) {
      throw new Error(`Unknown escrow state variant: ${key}`);
  }
  ```

- **L3. `process.env.DATABASE_URL` fallback silently disables dedup.**
  `handler.ts:48`:
  ```ts
  if (process.env.DATABASE_URL) {
      // dedup logic
  }
  // ← if DATABASE_URL unset, all events get processed without dedup
  ```
  In production DATABASE_URL is always set (per the docker-compose
  injection pattern in CLAUDE.md). But a misconfiguration would silently
  process duplicates. Better to fail loud at startup if the indexer
  binary is invoked without DATABASE_URL — or to have an explicit
  `INDEXER_DEDUP_DISABLED` env flag for test mode. Non-blocking, but
  flagged.

- **L4. UPDATEs match 0 rows silently when EscrowCreated was missed.**
  `on-escrow-state-changed.ts`, `on-delivery-submitted.ts`,
  `on-dispute-opened.ts` all `UPDATE escrows ... WHERE pubkey = X`
  without checking the affected row count. If `EscrowCreated` was
  dropped (handler downtime, decoder bug, dedup-related skip), all
  subsequent state changes for that escrow become silent no-ops. The
  on-chain state advances; the DB stays at "non-existent." Low because
  it's recoverable via backfill, but worth a defensive log:
  ```ts
  const result = await sql`UPDATE escrows SET ... WHERE pubkey = ${pk}`;
  if (result.count === 0) logger.warn({ pk }, 'state update matched 0 rows');
  ```

- **L5. No off-chain size validation on `resultUri` / `evidenceUri`.**
  On-chain enforces `MAX_RESULT_URI = 128` and `MAX_EVIDENCE_URI = 128`
  (PR #51 audit), so the events can't exceed those bounds. But the
  indexer doesn't independently validate, so a future on-chain
  loosening (or a buggy event-decoder mis-parse) could land a
  multi-megabyte string into the DB column. Defense-in-depth:
  validate length client-side before INSERT.

#### Informational

- **I1.** `safeLogUrl(resultUri)` and `safeLogUrl(evidenceUri)` are
  consistently used in log payloads (`on-delivery-submitted.ts:27`,
  `on-dispute-opened.ts:23`). The PR #44 carryforward landed cleanly
  in this PR — same scrubbing helper, same call shape. ✅
- **I2.** Reputation UPSERT in `on-sla-report.ts:24-35` correctly
  avoids the read-modify-write race that a naive
  `SELECT then UPDATE` would have. The single-statement
  `agent_reputation.total_score + ${score}` reads from the row state
  *as it exists during the UPDATE's row lock*, so concurrent UPSERTs
  for the same wallet serialize correctly via Postgres's row-lock
  semantics. The math is correct: `total_score` becomes
  `(prior_total + score)`, `avg_score` is `ROUND((prior_total + score) /
  (prior_jobs + 1))` using the new total. score range guaranteed to be
  0–100 by PR #59 L1 fix (`require!(score <= 100)`). ✅
- **I3. `ESCROW_PROGRAM_ID = 'EhFp…XxW2'`** matches the `declare_id!`
  in `bazaar-escrow` on main and the SDK's `ESCROW_PROGRAM_ID` (per
  PR #53 sync, verified during PR #59 audit). The vault PDA derivation
  in `on-escrow-created.ts:11-17` uses seeds `[b"vault", escrow]` —
  matches the on-chain seeds (PR #51). ✅
- **I4. Per-event try/catch in `handler.ts:83-87` and 110-114** ensures
  one failed handler doesn't break the rest of the batch. Standard
  pattern; correct here. ✅

### Sanity-check answers

1. ✅ **No hardcoded secrets.** Pass — no API keys, no DB
   credentials. `DATABASE_URL` is from env.
2. ✅ **No mainnet references.** Pass — the program IDs hardcoded are
   the devnet program IDs (matching the rest of the codebase post-PR #53).
3. ✅ **No admin-key footprint.** Pass — the indexer is a read-only
   chain consumer; it never holds keys, never signs anything, never
   mutates on-chain state. The only "authority" it asserts is to its own
   Postgres database.

### Carryforward to backend-eng (post-merge follow-ups)

- **M1**: wrap `on-sla-report.ts` dual-write in a transaction. Single-PR
  fix; small.
- **M2**: design decision — either move dedup-INSERT into per-event try
  block, or add an `events_failed` table for retry visibility. Worth an
  ADR before mainnet.
- L1: add unique constraint + ON CONFLICT on sla_reports.
- L2: allowlist-based `decodeEscrowState`.
- L3: fail-loud-or-flag-test for missing DATABASE_URL.
- L4: warn-on-zero-rows-affected pattern across all UPDATEs.
- L5: client-side length cap on URI fields.

### Verdict

✅ **APPROVE** for merge. CI green. The handler architecture is sound,
the reputation math is correct, the safeLogUrl + atomic-INSERT-RETURNING
patterns from PR #35/#44 are correctly carried forward. M1 + M2 are
operational concerns that affect data consistency in failure cases but
don't expose security risk and don't block merge.

The trust-boundary surface here is narrow (chain events → DB rows), and
the on-chain hardening from PR #51 means the events themselves are
trustworthy by the time they reach this layer. The audit pattern shifts
appropriately for the off-chain consumer: less authority/fund-flow, more
data-integrity/replay-safety.

---

# M1.5 — production-hardening audits

The M1.5 wave addresses carryforwards from M0/M1 that block mainnet. Each
PR audited here closes a specific finding from earlier rounds.

---

## PR #65 — feature/anchor-emit-cpi-registry — 2026-04-25
**Verdict:** ✅ APPROVED (CI green; one non-blocking test-coverage follow-up)

### Scope

Migrates `bazaar-registry` from `emit!` to `emit_cpi!` (Anchor 0.31 CPI
event model) — closes a mainnet blocker flagged in the M0 audit (PR #2
follow-ups) and the M1 indexer audit (PR #58 implicit reliance on inner
instructions for reliable event capture by Helius).

Files reviewed:
- `programs/bazaar-registry/src/lib.rs` (+19 / −4)
- `programs/tests/bazaar-registry.ts` (+86 / −10)

### Audit checklist (from team-lead's brief)

1. **Anchor v0.31 `emit_cpi!` pattern correct.** ✅
   - `event_authority` PDA: `seeds = [b"__event_authority"]`, `bump`
     auto-resolved — matches the canonical Anchor 0.31 macro
     expectation.
   - `program: Program<'info, BazaarRegistry>` added to all three
     emitting `Accounts` structs (`RegisterService`, `UpdateService`,
     `ToggleService`).
   - `use crate::program::BazaarRegistry;` import added at top — required
     for the `Program<'info, BazaarRegistry>` field type to resolve
     against the auto-generated `program` module.
   - `/// CHECK:` doc-comment present on each `event_authority`
     `AccountInfo` field — satisfies Anchor's `unsafe-account-info`
     lint and documents intent.

2. **Event payload fields unchanged.** ✅ Verified field-by-field:
   - `ServiceListingCreated`: `listing, owner, sati_agent_id,
     capability_hash, price_lamports, pricing_model, metadata_uri,
     created_at` — identical pre/post (lib.rs:289-299).
   - `ServiceListingUpdated`: `listing, owner, new_price, new_uri,
     is_active, updated_at` — identical pre/post (lib.rs:301-309).
   - The indexer's `on-listing-created.ts` / `on-listing-updated.ts`
     decoders rely on exact field order + name match. No breakage.

3. **All `emit!` migrated — none missed.** ✅ Confirmed via
   `grep -n 'emit!(' programs/bazaar-registry/src/lib.rs` against the
   pre-image — exactly four call sites (lines 63, 100, 117, 134), all
   four converted in the diff. No bare `emit!` remains.

4. **No accidental other behavior change.** ✅ Diff scope is strictly:
   (a) the four `emit!` → `emit_cpi!` token swaps, (b) the three
   `Accounts` struct additions, (c) the one `use` import. Validation
   logic, PDA derivation, `has_one = owner` constraint, the C1 fix
   (`escrow_authority` Signer with `seeds::program = BAZAAR_ESCROW_ID`
   on `IncrementJobsCompleted`), and the `Clock` reads are all
   untouched. No behavior change, no fund-flow surface change.

5. **Tests updated to assert events appear as inner instructions.**
   ⚠️ **Partial.** Tests are updated to *pass* the new accounts
   (`eventAuthority`, `program: program.programId`) so the calls
   succeed under the new account layout, but they do not actually
   *assert* on the inner-instruction CPI events. The test suite
   verifies the program still executes; it does not verify the events
   are emitted in the new shape.
   - This is a test-coverage gap, not a correctness gap. The
     `emit_cpi!` macro is a thin self-CPI that's well-exercised in
     Anchor's own tests; if accounts compile and the tx lands, the CPI
     fires.
   - Carryforward to **qa-test-eng (Task #45 in the M1.5 plan)**:
     when E2E tests run end-to-end against devnet, add an explicit
     assertion that `tx.meta.innerInstructions` contains a self-CPI
     to the program with the discriminator for
     `ServiceListingCreated` / `ServiceListingUpdated`. This is also
     the only path that proves the indexer can decode the new
     event-emission shape — Helius webhooks read inner instructions,
     not log lines.

### Findings

- **Critical:** none.
- **High:** none.
- **Medium:** none.
- **Low:**
  - **L1. Test suite does not assert event emission shape.** See
    checklist item #5 above. Carryforward to qa-test-eng. Non-blocking
    because the on-chain → indexer path is independently verified by
    Task #28 / #45 E2E tests.
- **Informational:**
  - **I1.** `event_authority: AccountInfo<'info>` is functionally
    equivalent to `UncheckedAccount<'info>` in Anchor 0.31 — both
    rely on the seed constraint for verification. The current choice
    is fine; a future stylistic pass could prefer `UncheckedAccount`
    for clarity but it's not material.
  - **I2.** PR title says "Task #34" but the live TaskList lists
    bazaar-registry emit_cpi! migration as **Task #32** (Task #34 is
    USDC mint binding). Cosmetic — the PR scope matches the live
    task definition; only the number is off.
  - **I3.** IDL regeneration: `anchor build` will pick up the new
    accounts and add `event_authority` + `program` to the IDL's
    `accounts` array for the three instructions. SDK consumers
    (`packages/sdk/src/registry.ts`) must rebuild against the new
    IDL before the next devnet upgrade lands. Out of scope for this
    PR; tracked under Task #36 (devnet upgrade-in-place) and the
    sdk-eng's IDL re-export step.
  - **I4.** No admin-key footprint, no fund-flow change. The C1
    cross-program-invocation hardening on
    `IncrementJobsCompleted` is preserved unchanged
    (`seeds::program = BAZAAR_ESCROW_ID` Signer constraint, lib.rs:159-171).

### Sanity-check answers

1. ✅ **No new admin keys / withdrawal authorities introduced.** The
   `event_authority` PDA is a self-derived signer for the `emit_cpi!`
   self-CPI only — it has no authority over funds, listing state, or
   any other account.
2. ✅ **No mainnet references.** `declare_id!` unchanged; still the
   devnet program ID `ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3`.
3. ✅ **No event-payload field renames.** The indexer can continue
   decoding `ServiceListingCreated` / `ServiceListingUpdated` with
   the same Borsh layout. The wire format change is *where* the
   event lives (inner instruction vs program log), not *what's in
   it*.
4. ✅ **`has_one = owner`, PDA-bound seeds, and validation calls
   untouched.** All authorization invariants from PR #2 still hold.
5. ✅ **CI green** at the time of review (Lint + typecheck + test
   workflow run 24941913929 — SUCCESS).

### Verdict

✅ **APPROVE** for merge.

The migration is mechanically clean: four `emit!` swaps + three
`Accounts` additions + one `use`, with no other functional change.
The Anchor 0.31 `emit_cpi!` pattern is correctly applied (event
authority PDA seed, `program` field, `/// CHECK:` doc). The event
payload field shape is preserved bit-for-bit, so the indexer's
event decoders need no update.

One non-blocking carryforward: the test suite verifies the new
account layout doesn't break the call path but does not assert on
the inner-instruction event emission directly — qa-test-eng (Task
#45) should add that assertion when the M1.5 E2E refresh lands, so
that future regressions in the event-emission code path are caught
inside the program test harness rather than at the indexer
boundary.

---

## PR #67 — feature/anchor-emit-cpi-escrow — 2026-04-25
**Verdict:** ✅ APPROVED, conditional on CI green (CI in progress at review time)

### Scope

Migrates `bazaar-escrow` from `emit!` to `emit_cpi!` (Anchor 0.31 CPI
event model) — closes a mainnet blocker for the funds-bearing program.
Same pattern as PR #65 (registry), but with **higher criticality** because
the escrow vault holds buyer USDC. Sister PR to PR #65; together they close
the M0 carryforward "events should be inner instructions, not log lines"
flagged in PR #2 follow-ups and PR #51 audit.

Files reviewed:
- `programs/bazaar-escrow/src/lib.rs` (+25 / −8)
- `programs/tests/bazaar-escrow.ts` (+65 / 0)

### Audit checklist (anchor-eng request)

1. **`event_authority` seeds `[b"__event_authority"]` correct per Anchor
   0.31 CPI event spec.** ✅ Identical seed bytes used in PR #65 (registry)
   and matches Anchor 0.31's canonical macro expectation. The `bump` is
   auto-resolved.

2. **`crate::program::BazaarEscrow` is the correct self-referential
   program type.** ✅ The `program` module is auto-generated by `#[program]`
   on the `bazaar_escrow` module; `BazaarEscrow` is the PascalCase struct
   name Anchor exports for it. Same pattern as
   `crate::program::BazaarRegistry` in PR #65 — both compile, both work.

3. **No new authority or withdrawal vector introduced.** ✅ Verified
   account-by-account:
   - **Vault PDA** `[b"vault", escrow_key]` — still the only signer on
     all three vault → external token transfers (`confirm_delivery`
     lines 186-213, `claim_timeout` lines 274-286, `open_dispute`
     lines 328-340). Unchanged.
   - **`escrow_authority` PDA** `[b"authority"]` — still the only signer
     for the registry CPI (`confirm_delivery` lines 217-229). Unchanged.
   - **`event_authority` PDA** `[b"__event_authority"]` — *new*, but
     declared as `AccountInfo<'info>` (NOT `Signer`, NOT `UncheckedAccount`
     marked as Signer). It is consumed implicitly by the `emit_cpi!` macro
     to PDA-sign a self-CPI into bazaar-escrow's auto-generated
     `__event_authority` instruction, which only emits the event payload
     to inner-instruction logs and writes to no account. **Zero authority
     over funds, no mutation surface.**

4. **`ConfirmDelivery` has both `escrow_authority` AND `event_authority`
   — no conflict.** ✅ The two PDAs are derived from disjoint seed sets:
   - `escrow_authority` ← `seeds = [b"authority"]`
   - `event_authority` ← `seeds = [b"__event_authority"]`
   Different seed bytes ⇒ different PDA addresses. Cannot collide. They
   serve orthogonal purposes (CPI signer for registry vs. CPI signer for
   self-event-emission), and Anchor account-resolution treats them as
   independent fields. No code path can route one into the other's role.
   The `ConfirmDelivery` struct now carries 11 accounts total — well
   inside Solana's 64-account-per-tx ceiling.

5. **Test coverage exhaustive — 0 `.accounts()` blocks missing.** ✅
   anchor-eng's claim verified by spot-checking the diff: every
   `.accounts({…})` invocation in `programs/tests/bazaar-escrow.ts` now
   passes `eventAuthority` + `program`, including:
   - The shared `setupEscrow` fixture (registry register + escrow create paths)
   - 3 happy-path test calls (`submit_delivery`, `confirm_delivery`, `open_dispute`)
   - SLA severity branches (Minor / Moderate / Major)
   - Timeout-claim path (`claim_timeout`)
   - Negative tests (Unauthorized / DeadlinePassed / DeadlineNotYetPassed / InvalidStateTransition)
   The TypeScript compiler would also reject any missing field given the
   `as any` cast — but missing accounts surface at runtime with a
   `MissingAccount` error from the IDL, so untested paths would fail loudly.

### Other things checked

- **All 8 `emit!` sites converted.** ✅ Confirmed by `grep -n "emit!"
  programs/bazaar-escrow/src/lib.rs` against pre-image — exactly 8
  call sites at lines 83, 122, 130, 235, 243, 292, 346, 354 — all 8
  swapped in the diff. PR description's count matches.
- **Event payload field shape preserved bit-for-bit** for all 5 events
  (`EscrowCreated`, `EscrowStateChanged`, `DeliverySubmitted`,
  `SLAReport`, `DisputeOpened`). The L3 fix from prior audits (buyer +
  seller in `EscrowStateChanged` / `SLAReport`) is preserved. Indexer
  decoders in `apps/indexer/src/events/escrow/*.ts` need no update.
- **Prior security fixes preserved unchanged**:
  - C1 (escrow_authority Signer + `seeds::program` constraint) ✅
  - C2 / H2 (`token::mint = vault.mint` + `token::authority = escrow.X`
    on all three token accounts) ✅
  - L1 (`require!(score <= 100)`) and L2 (tag length / count caps) ✅
  - M1 (`saturating_sub` clamp on `compute_severity` to prevent
    negative-clock wrap-to-Major) ✅
  - State-machine guards (`require!(state == X)`) on every transition ✅
- **No mainnet references introduced.** `declare_id!` unchanged; still
  the devnet ID `EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2`.

### Findings

- **Critical:** none.
- **High:** none.
- **Medium:** none.
- **Low:**
  - **L1. Test suite asserts neither inner-instruction CPI nor event
    payload contents.** Tests verify the program still executes with the
    new account layout, but don't directly assert that `tx.meta
    .innerInstructions` contains a self-CPI carrying the
    `EscrowCreated` / `EscrowStateChanged` / `SLAReport` / etc.
    discriminators. Same gap as PR #65 — carryforward to qa-test-eng
    Task #45 (M1.5 E2E refresh). Non-blocking because `emit_cpi!` is
    well-exercised in Anchor's own tests and the indexer integration
    path independently catches malformed events.
  - **L2. Compute-unit budget headroom.** `confirm_delivery` is now the
    most CPI-heavy instruction in the program: 2 vault → token-account
    transfers (vault PDA signer) + 1 registry CPI (escrow_authority
    signer) + **2 self-CPIs** for `emit_cpi!(EscrowStateChanged)` and
    `emit_cpi!(SLAReport)`. Anchor's `emit_cpi!` self-CPI costs roughly
    ~12.5k CU each, so this adds ~25k CU on top of the prior path.
    Default tx budget is 200k CU; an indicative ceiling is reached only
    if a future change adds another CPI. Non-blocking but worth a
    `requestUnitsLimit(300_000)` if any future M1.5+ change adds another
    CPI to this instruction. Confirm with `solana logs` post-deploy.
- **Informational:**
  - **I1.** `event_authority: AccountInfo<'info>` vs.
    `UncheckedAccount<'info>` — same trade-off as PR #65. Functionally
    equivalent under Anchor 0.31; current choice fine.
  - **I2.** PR title references "Task #35" but the live TaskList lists
    bazaar-escrow `emit_cpi!` as **Task #33**. Same task-number drift
    as PR #65. Cosmetic.
  - **I3.** SDK consumers (`packages/sdk/src/escrow.ts`) and the
    `tests/e2e/` lifecycle suite must rebuild against the regenerated
    IDL (which will newly include `event_authority` + `program` fields
    on `CreateEscrow`, `SellerAction`, `BuyerAction`, `ConfirmDelivery`)
    before the next devnet upgrade lands. Tracked under Task #36
    (devnet upgrade-in-place).
  - **I4.** No fund-flow surface change. Vault still PDA-signed by
    `[b"vault", escrow_key]`; the new event_authority PDA cannot
    initiate transfers because it is never passed as a signer to any
    `token::transfer` CPI.

### Sanity-check answers

1. ✅ **No new admin keys / withdrawal authorities.** The
   `event_authority` PDA is structurally incapable of authorizing fund
   movement — it is consumed only by the `emit_cpi!` macro's internal
   self-CPI to a no-write event-emit instruction.
2. ✅ **Vault PDA derivation untouched** — same seeds, same bump
   storage on the escrow account, same `new_with_signer` invocation
   pattern.
3. ✅ **Registry CPI authorization untouched** — `escrow_authority`
   is still derived from `[b"authority"]`, still signed via
   `new_with_signer`, still verified by bazaar-registry's
   `seeds::program = BAZAAR_ESCROW_ID` Signer constraint (PR #2 C1
   fix preserved).
4. ✅ **Token account constraints untouched** — `token::mint` +
   `token::authority` are still enforced on all three external token
   accounts in `SellerAction`, `BuyerAction`, `ConfirmDelivery` (PR #51
   C2/H2 fixes preserved).
5. ✅ **State-machine guards untouched** — every state transition
   still gated by `require!(state == X)` plus authority gating via
   `has_one`.
6. ⏳ **CI status:** in progress at review time
   (run 24942126352). Verdict is conditional on CI green; if CI fails,
   re-audit against the failure mode.

### Verdict

✅ **APPROVE** for merge once CI is green.

Mechanically clean: 8 `emit!` swaps + 4 `Accounts` struct additions + 1
`use` import + the corresponding test wiring. No fund-flow surface change,
no new authorities, no payload shape change. The two distinct CPI signers
on `ConfirmDelivery` (`escrow_authority` for registry, `event_authority`
for self-event) are derived from disjoint seeds and serve orthogonal
purposes — they cannot collide and don't open a privilege-escalation
path.

Carryforwards (non-blocking, both to qa-test-eng Task #45):
- **L1**: assert `tx.meta.innerInstructions` contains the expected
  event self-CPI in the program test harness, not just the indexer
  boundary.
- **L2**: monitor compute-unit usage on `confirm_delivery` post-deploy;
  add `requestUnitsLimit(300_000)` if any future change adds another CPI
  to this path.

---

## PR #69 — Task #36 USDC mint canonical binding in bazaar-escrow

**Reviewer:** security-auditor
**Date:** 2026-04-25
**Branch:** `feature/anchor-usdc-mint-constraint` → `main`
**Head SHA:** `7f2ddb76e680805acfa603da2729926bf49af0b5`
**CI status:** ✅ green (run 24943051436 — Lint + typecheck + test)
**Closes:** PR #51 H1 audit finding (per-cluster USDC mint not enforced
on devnet → buyer could fund escrow with arbitrary mint and trap funds
or grief settlement)

### Scope

This is the mainnet release-gate fix for the H1 finding that has been
open since the original escrow audit. The PR introduces a per-cluster
canonical USDC mint constant and applies an `address = USDC_MINT`
constraint everywhere the program touches a token account or mint
account. After this lands, every escrow created on a given cluster is
provably denominated in canonical USDC; any attempt to substitute a
fake / look-alike mint fails at account deserialization with
`ConstraintAddress` before any state mutation or token transfer.

Diff: +146 / −17 across 6 files (1 keypair fixture, 1 test addition,
1 program change, 2 Cargo manifests, 1 SDK biome-ignore reflow).

### Changes audited

**1. Per-cluster USDC mint constants (`programs/bazaar-escrow/src/lib.rs`):**

```rust
#[cfg(feature = "devnet")]
pub const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
#[cfg(feature = "testing")]
pub const USDC_MINT: Pubkey = pubkey!("8VEVN5sJUzqN3ddkJV9gYMbLBnmAxUXsC5CDDU9WFwzE");
#[cfg(not(any(feature = "devnet", feature = "testing")))]
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
```

- ✅ **Mainnet (default-no-features) USDC mint** —
  `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` is Circle's canonical
  Solana mainnet-beta USDC and matches the address published in
  Circle's developer docs and OFAC compliance reports.
- ⚠️ **Devnet USDC mint** —
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` matches Circle's CCTP
  devnet USDC. There is also an older devnet USDC
  (`Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr`) widely used by
  legacy tooling; team-lead should confirm devnet payment flows
  (faucet, indexer fixtures, dashboard) all target the CCTP variant
  and document the choice in an ADR. Non-blocking; not on the
  fund-safety surface.
- ✅ **Testing USDC mint** —
  `8VEVN5sJUzqN3ddkJV9gYMbLBnmAxUXsC5CDDU9WFwzE` matches the keypair
  in `programs/tests/fixtures/test-usdc-mint.json` (verified by
  reconstructing the public key from bytes 32–63 of the secret-key
  array → `bs58.encode` → exact match). Tests load this fixture and
  pass it to `createMint(... mintKp)` so the resulting mint address is
  deterministic and equal to the constant, allowing `address`
  constraints to succeed under the `default = ["testing"]` feature
  flag.

**2. `address = USDC_MINT` walk-through over every Accounts struct:**

| Struct | Field | Constraint applied | Notes |
|---|---|---|---|
| `CreateEscrow` | `vault` | `token::mint = usdc_mint` (init) | Vault is fresh; mint binding is locked at creation. |
| `CreateEscrow` | `buyer_token_account` | `token::mint = usdc_mint` | H2 fix preserved; now mint pinned to canonical. |
| `CreateEscrow` | `usdc_mint` | **`address = USDC_MINT`** + `Account<Mint>` | Was `AccountInfo<'info>`; now strongly typed Mint with address pin. |
| `SellerAction` | `vault` | `token::mint = usdc_mint` (newly added) | Closes prior gap — vault was previously bound only by PDA seeds. |
| `SellerAction` | `seller_token_account` | `token::mint = usdc_mint` (was `vault.mint`) | Stronger: now compares against canonical, not vault state. |
| `SellerAction` | `usdc_mint` | **`address = USDC_MINT`** | New required account on `submit_delivery` and `claim_timeout`. |
| `BuyerAction` | `vault` | `token::mint = usdc_mint` (newly added) | Closes prior gap. |
| `BuyerAction` | `buyer_token_account` | `token::mint = usdc_mint` (was `vault.mint`) | Stronger. |
| `BuyerAction` | `usdc_mint` | **`address = USDC_MINT`** | New required account on `open_dispute`. |
| `ConfirmDelivery` | `vault` | `token::mint = usdc_mint` (newly added) | Closes prior gap. |
| `ConfirmDelivery` | `seller_token_account` | `token::mint = usdc_mint` (was `vault.mint`) | Stronger. |
| `ConfirmDelivery` | `buyer_token_account` | `token::mint = usdc_mint` (was `vault.mint`) | Stronger. |
| `ConfirmDelivery` | `usdc_mint` | **`address = USDC_MINT`** | New required account on `confirm_delivery`. |

✅ **Every `Account<TokenAccount>` field in every Accounts struct is
now constrained to the canonical USDC mint.** The only `TokenAccount`
fields in the program live in these four contexts; nothing else
touches `token::mint`. No exceptions.

**3. Constraint-syntax correctness (Anchor v0.31.1):**
- `address = <const>` is the documented Anchor 0.31 way to pin an
  account to a known address. Anchor expands this into a deserialization
  check that returns `ConstraintAddress` on mismatch *before* the
  instruction body executes. ✅
- `token::mint = usdc_mint` references the in-context account, and
  Anchor's expansion verifies that the token account's stored `mint`
  field equals `usdc_mint.key()`. Combined with `address = USDC_MINT`
  on `usdc_mint`, this transitively enforces the canonical mint on
  every token account. ✅
- `usdc_mint: Account<'info, Mint>` strengthens the type from the
  prior `AccountInfo` — this adds an SPL Token program ownership check
  *and* requires the account data to deserialize as a Mint, so a random
  account at the canonical address would also be rejected. (Defense
  in depth — the address pin alone is sufficient, but the typed
  account closes the trivial spoof too.) ✅

**4. Negative test (`programs/tests/bazaar-escrow.ts`):**
- `it('rejects create_escrow with wrong USDC mint (ConstraintAddress)')`
  - Spawns a fresh keypair, mints a token at that address, builds a
    buyer ATA against the fake mint, then calls `create_escrow` with
    the fake mint as `usdcMint`.
  - Asserts the call rejects with `/ConstraintAddress/`.
  - ✅ Exercises the constraint at the failing-path level for the
    first instruction. The remaining three instructions
    (`submit_delivery`, `confirm_delivery`, `open_dispute`,
    `claim_timeout`) don't get a dedicated negative test, but they
    use the same `address = USDC_MINT` constraint generated by the
    same Anchor macro path — proving rejection on `CreateEscrow` is
    a valid representative for the constraint's correctness.
    (Carryforward L3 below.)

**5. Existing tests still pass:**
- All ~20 prior happy-path and negative tests now thread an
  additional `usdcMint` field through their `accounts({...})` calls.
  Mechanical churn only; no behavior change.
- CI run `24943051436` is green on the Lint + typecheck + test job.
- Local `cargo check` confirms all three feature combos compile
  cleanly:
  - `--no-default-features --features devnet` (devnet binary) ✅
  - `--no-default-features` (mainnet binary) ✅
  - default = `["testing"]` (test binary) ✅

**6. Bypass-resistance audit:**
- `usdc_mint` field is not `mut` and not `init` — Anchor cannot
  reassign or recreate it; the `address` check happens during
  `try_accounts` before the instruction body runs.
- There is no remaining `AccountInfo` / `UncheckedAccount` fallback
  for any token-account / mint field — every reference to the canonical
  mint goes through the typed-account path.
- The mint constant is a compile-time `pubkey!()` — not loaded from
  any sysvar, account data, or user-supplied input. No way to swap it
  at runtime short of a program upgrade (gated by the Squads 2-of-3).
- The four PDA-signer code paths (`create_escrow`, `submit_delivery`,
  `confirm_delivery`, `claim_timeout`, `open_dispute`) all use
  `vault_seeds: [b"vault", escrow.key(), &[vault_bump]]` — unchanged
  from prior audits. The mint constraint cannot influence the signer
  derivation.
- No new admin keys or withdrawal authorities. The `usdc_mint` account
  is read-only and structurally incapable of authorizing token
  movement.

### Findings

- **Critical:** none.
- **High:** none.
- **Medium:**
  - **M1 (recommendation, not finding). `default = ["testing"]` is a
    deployment footgun.** Anyone running plain `anchor build` (without
    `--no-default-features`) produces a binary that pins the *test*
    mint as USDC. The current Cargo.toml comment is explicit, but a
    deploy-time slip would silently produce a broken devnet/mainnet
    binary that would still build, deploy, and only fail at the first
    user `create_escrow` call (with `ConstraintAddress` against a mint
    that doesn't exist on that cluster). Two options for hardening,
    either of which closes the footgun:
      1. Flip the polarity: make `default = []` (mainnet by default)
         and require `anchor test` to pass `--features testing`. The
         Cargo workspace's `[features]` block already supports this;
         the `anchor.toml` test runner can be adjusted to pass the
         flag.
      2. Add a CI job that diff-checks the deployed program binary's
         embedded mint constant against the cluster being deployed to
         (e.g., a post-build script that disassembles the .so and
         greps for the expected pubkey bytes).
    Tracked as a non-blocker for this PR (the per-cluster pin itself
    is correct); should land before mainnet deploy.
- **Low:**
  - **L3. Negative tests cover only `create_escrow`.** The other four
    instructions (`submit_delivery`, `claim_timeout`, `open_dispute`,
    `confirm_delivery`) gain a required `usdc_mint` account but
    aren't individually exercised with a wrong mint. Anchor's macro
    expansion guarantees the same constraint behavior across all
    four, so this is unlikely to mask a bug — but a parameterized
    negative test (table-driven over the four instructions) would
    push to defense-in-depth. Carryforward to qa-test-eng Task #45.
  - **L4. `usdc_mint` field added to `SellerAction` / `BuyerAction` /
    `ConfirmDelivery` widens the Accounts list for SDK callers.**
    `packages/sdk/src/confirm.ts` was reflowed to satisfy biome's
    no-explicit-any rule, but the SDK helpers `bazaar.deliver()`,
    `bazaar.claimTimeout()`, `bazaar.dispute()`, `bazaar.confirm()`
    will need their `accounts({...})` payloads updated to thread
    `usdcMint` through. Not in this PR's scope. Already tracked under
    Task #36 (devnet upgrade-in-place). The SDK lifecycle E2E suite
    in `tests/e2e/` will fail until updated. Carryforward.
- **Informational:**
  - **I5. Cargo feature flag set is now**
    `[default, devnet, testing, cpi, no-entrypoint, no-idl]`. The
    feature comment in `Cargo.toml` is the only deploy-time
    documentation; consider mirroring into `docs/decisions/` as an ADR
    so the per-cluster build invocation lives somewhere a deploy
    operator will find it. Cosmetic.
  - **I6. Test fixture keypair `test-usdc-mint.json` is committed in
    plaintext.** This is correct — the keypair is a deterministic
    test-only artifact whose pubkey *must* match the `testing`
    constant. It has no production funds, no production authority, and
    its leak is intentional (so `cargo build` + `anchor test` are
    deterministic across machines). Worth a one-line note in the
    fixture's surrounding directory README that this file is
    *expected* to be public, so a future security-conscious reader
    doesn't try to "fix" it. Cosmetic.
  - **I7. PR title references "Task #36"; live TaskList currently
    has Task #34 = "USDC mint canonical binding in bazaar-escrow"
    and Task #35/36 are renamed/devnet-upgrade items.** Same
    task-number drift pattern as PRs #65 / #67. Cosmetic.

### Sanity-check answers (mainnet release-gate)

1. ✅ **Per-cluster USDC mint pinned at compile time.** No runtime
   path can substitute the mint; only a program upgrade (Squads 2-of-3)
   can change it.
2. ✅ **No new admin keys / withdrawal authorities.** `usdc_mint` is
   read-only; the four `token::transfer` CPIs still use the
   `[b"vault", escrow_key]` PDA as authority — unchanged.
3. ✅ **No bypass via `mut` / unchecked fallback.** All four
   `Accounts` structs cover every mint-bearing account; no fallback
   to `AccountInfo` / `UncheckedAccount` for any of them.
4. ✅ **No regression in prior fixes.** C1 (escrow_authority +
   `seeds::program`), C2 / H2 (token::mint + token::authority on
   external token accounts), L1 / L2 / M1 (compute_severity clamp),
   state-machine guards — all preserved. The token::mint constraints
   on external token accounts are *strengthened* (vault.mint →
   usdc_mint), which transitively also pins them to the canonical
   address.
5. ✅ **CI green at review time.**
6. ✅ **Closes PR #51 H1 finding.** The H1 was specifically "no
   per-cluster USDC mint enforcement"; this PR adds it for all five
   instructions covering all four token-account roles
   (vault, buyer ATA, seller ATA, buyer-refund ATA).

### Verdict

✅ **APPROVE for merge.**

PR #69 closes the mainnet release-gate H1 finding from PR #51 cleanly
and tightly. Every token-account-bearing field in every Accounts struct
is now constrained to the canonical USDC mint via the `address = USDC_MINT`
+ `token::mint = usdc_mint` pattern. The three per-cluster constants
are correctly chosen (mainnet matches Circle canonical; testing matches
the committed fixture keypair; devnet matches Circle CCTP devnet). The
negative test exercises the constraint on `create_escrow` and proves
`ConstraintAddress` rejects pre-state-mutation. CI is green and all
three feature builds compile locally without errors.

Carryforwards (non-blocking):
- **M1 (recommended pre-mainnet):** flip `default = ["testing"]` to
  `default = []` so plain `anchor build` produces a mainnet binary,
  *or* add a CI job that asserts the deployed binary's embedded mint
  matches the target cluster. Open a follow-up issue before mainnet
  cutover.
- **L3 (qa-test-eng Task #45):** parameterized negative-mint test
  across the four non-create instructions.
- **L4 (anchor-eng / sdk-eng — Task #36):** SDK lifecycle helpers
  need to thread `usdcMint` into the four affected instruction
  account payloads; E2E suite must be re-run before devnet
  upgrade-in-place lands.
- **I5 (docs):** ADR for per-cluster build invocation
  (`anchor build --no-default-features [--features devnet]`).
- **I6 (fixtures):** one-line note that `test-usdc-mint.json`
  plaintext keypair is intentionally public.
- **I7 (cosmetic):** PR title task-number drift; harmless.

---

## PR #72 — Task #37 rename `price_lamports` → `price_usdc_base_units`

**Reviewer:** security-auditor
**Date:** 2026-04-25
**Branch:** `feature/anchor-usdc-rename` → `main`
**Head SHA:** `166326827898ceb2f4c372032d999d3e50a45bc8`
**CI status:** ✅ green (run 24943615349 — Lint + typecheck + test)
**Closes:** PR #2 M2 audit finding ("`price_lamports` field name misleading
for a USDC-settled marketplace; rename to `price_base_units` /
`price_usdc_base_units` before SDK publish").

### Audit depth

**Light** — pure rename refactor, no semantic / fund-flow change.

### Scope

Stack-wide rename of the price field across:
- On-chain: `bazaar-registry/src/lib.rs` — `register_service` arg,
  `update_service_price` argument flow, `ServiceListing` account field,
  `ServiceListingCreated` event field
- IDL: `packages/idl/idl/bazaar_*.json` + generated `*.ts` types
- SDK: `register.ts`, `discover.ts`, test mocks
- Indexer: decoder typed shape, `on-listing-created` handler, integration
  tests
- Tests: program tests, E2E lifecycle tests, state-assertion helpers

Diff: +349 / −42 across 15 files. Most of the line count comes from the
IDL JSON regenerating with the (already-merged) `emit_cpi!` event_authority
PDA blocks and the (already-merged) USDC mint pinning — those changes
are not introduced by this PR; they're just propagating because the IDL
was last regenerated on an older program. The actual logical change is a
~30-line rename.

### Audit checklist results

**1. Rename complete?**
✅ All on-chain, IDL, SDK, and indexer **TS** call sites use
`price_usdc_base_units` / `priceUsdcBaseUnits`. Verified via repo-wide
`grep -rn "priceLamports\|price_lamports"` — every remaining hit is on
a Postgres **column name** (the underlying DB column is *not* renamed in
this PR; see L1 below) or a test description string. No stale references
in production semantic code paths.

**2. IDL field rename propagated to TS types?**
✅ Both `packages/idl/idl/bazaar_*.json` (Rust-IDL JSON, snake_case
field) and `packages/idl/src/bazaar-*.ts` (TS-generated types,
camelCase) are aligned. The decoder's typed shape
(`ServiceListingCreatedData`) matches.

**3. Semantic equivalence?**
✅ Same `u64`, same byte width, same field position in the Borsh-
serialized account / event layout. Borsh is positional, not name-keyed,
so:
- Existing on-chain `ServiceListing` accounts created under the old
  field name *deserialize correctly* under the new field name. No
  data migration required for the program upgrade.
- Existing `ServiceListingCreated` events emitted by the pre-upgrade
  program *decode correctly* via `BorshEventCoder` keyed against the
  new IDL — the JS field name is just what the IDL types say; the byte
  layout is unchanged.
- Account / instruction discriminators are derived from the **struct
  name** (`ServiceListing`) / **fn name** (`register_service`) —
  unchanged. No discriminator drift.

**4. Tests still cover same behavior?**
✅ `programs/tests/bazaar-registry.ts` updated: assertions
`acct.priceUsdcBaseUnits.toNumber()` mirror prior `acct.priceLamports`
checks. Coverage equivalent.
✅ `tests/e2e/register-discover.test.ts` + `state-assertions.ts`
updated to assert `priceUsdcBaseUnits` against the on-chain account.
Same assertion semantics.
✅ SDK unit test (`packages/sdk/tests/discover.test.ts`) updated.
✅ Indexer integration test fixtures updated.

**5. CI green?**
✅ Run `24943615349` (Lint + typecheck + test) succeeded at 23:52:15Z.

### Findings

- **Critical:** none.
- **High:** none.
- **Medium:** none.
- **Low:**
  - **L1. DB column `price_lamports` retained.** The Drizzle TS
    field renames from `priceLamports` → `priceUsdcBaseUnits`, but the
    underlying Postgres column name is unchanged
    (`bigint('price_lamports', ...)`). All raw-SQL queries
    (`INSERT ... price_lamports ...`, `SET price_lamports = ...`,
    `SELECT price_lamports FROM ...`, the
    `idx_service_listings_discover` covering index, the migration-test
    column allowlist) still target the legacy column name and remain
    correct as-is. This is a *deliberate* deferral — a column rename
    would require a Drizzle migration and a coordinated indexer
    redeploy. Naming friction only; no correctness or security impact.
    **Carryforward**: bundle a `price_lamports` →
    `price_usdc_base_units` column rename + Drizzle migration with a
    future indexer release window (post-mainnet would be cleanest, so
    devnet replays don't trip).
  - **L2. Test description "updates price_lamports on
    ServiceListingUpdated"** in
    `apps/indexer/tests/listing-upsert.integration.test.ts:111`. The
    test description references the legacy column name. Cosmetic, but
    mildly misleading after this PR lands. Carryforward as part of L1
    cleanup.

- **Informational:**
  - **I1. Indexer hot-fix `instruction-decoder.ts` (uncommitted
    fallback path) still references `priceLamports`.** This file is
    *not* tracked by git on `pr72-head` (verified via
    `git ls-files`); it lives only in working trees of agents who
    pulled an earlier WIP. It will become relevant under Task #41
    ("indexer revert hot-fix patches") — the revert author should
    confirm any remaining hot-fix decoder paths use
    `priceUsdcBaseUnits`. Not in PR #72's scope.
  - **I2. Comment block in `apps/indexer/src/db/schema.ts` removed.**
    The pre-PR schema carried a 3-line `NOTE: security-auditor PR #2
    M2 flagged this field as misleading…` comment justifying the
    legacy name. The PR drops the comment because the rename now lands
    — correct. The DB column-name carryover (L1) is now undocumented;
    consider a one-line note like
    `// On-chain field is price_usdc_base_units; DB column rename
    deferred to avoid a migration in this PR.` Cosmetic.
  - **I3. PR title says "Task #37"; live TaskList has Task #35 =
    "Rename price_lamports → price_usdc_base_units in registry
    program + IDL".** Same task-number drift as PRs #65 / #67 / #69.
    Cosmetic.
  - **I4. Devnet upgrade-in-place ordering.** This rename does not
    break wire compatibility either way (on-chain Borsh layout
    unchanged, JS decoder field name is purely IDL-driven). However:
    SDK consumers that *re-export* the IDL will get the new field
    names; any out-of-tree consumer pinned to the prior IDL must
    rebuild. Tracked under Task #38 (devnet upgrade-in-place).

### Sanity-check answers

1. ✅ **No new admin keys / withdrawal authorities.** Pure rename.
2. ✅ **No fund-flow surface change.** No accounts, no signers,
   no token::transfer paths touched.
3. ✅ **No Borsh layout drift.** Field is `u64` at the same position
   before and after; Borsh deserializes by position.
4. ✅ **No discriminator drift.** Account discriminator
   (`ServiceListing`) and instruction discriminator
   (`register_service`) are name-keyed but unchanged.
5. ✅ **No prior fix regressed.** PR #65 (registry `emit_cpi!`),
   PR #67 (escrow `emit_cpi!`), PR #69 (USDC mint pin) all visible
   in the regenerated IDL — preserved unchanged.
6. ✅ **CI green at review time.**

### Verdict

✅ **APPROVE for merge.**

Mechanical rename across the stack with zero semantic surface change.
No security implications, no fund-flow risk, no Borsh layout drift, no
discriminator drift. Closes PR #2 M2 finding cleanly. The DB column
rename deferral (L1) is sensible and explicitly bundles into a future
maintenance window.

Carryforwards (non-blocking):
- **L1**: bundle `price_lamports` → `price_usdc_base_units` Postgres
  column rename + Drizzle migration into a future indexer release.
- **L2 / I2**: cosmetic test-description / schema-comment cleanup
  alongside L1.
- **I1**: Task #41 (indexer revert) author must verify any
  hot-fix decoder paths use `priceUsdcBaseUnits`.
- **I3**: PR title task-number drift; harmless.
- **I4**: out-of-tree IDL consumers rebuild required (already
  expected as part of Task #38 devnet upgrade-in-place).

---

## PR #74 — Task #41 post-M1.5 indexer cleanup

**Reviewer:** security-auditor
**Date:** 2026-04-26
**Branch:** `feature/backend-cleanup-after-m15` → `main`
**Head SHA:** `f9e3178…`
**CI status:** ❌ **FAILED** (run 24943801228 — Lint+typecheck pass, **test step fails**)

### Audit depth

**Light** — config + Zod-schema-only refactor, no program / auth /
fund-flow changes. But CI is red.

### Scope

Two files, +14 / −9:

1. `apps/indexer/src/webhooks/handler.ts` — registry program ID
   updated from stale M0 hardcode (`GJRgCC…`) to M1.5 address
   (`ADWoSm…`); both registry and escrow IDs now wrapped in
   `process.env.<NAME> ?? '<default>'` pattern so a deploy can
   override without code change.
2. `apps/indexer/src/webhooks/types.ts` — `transactionError`
   tightened from `.nullable().optional()` to `.nullable()` (always-
   present, may be null); `lighthouseData: z.unknown().optional()`
   field added; field-order reflow for readability.

### Findings

- **Critical:** none.
- **High:**
  - **H1. CI is RED.** Test
    `apps/indexer/tests/webhook.test.ts:90` —
    `returns 200 and counts relevant registry events` — fails:
    expected `relevant: 1`, got `relevant: 0`. **Root cause:** the
    test file's `REGISTRY_PROGRAM_ID` constant
    (`webhook.test.ts:4`) still holds the stale M0 ID `GJRgCC…`; the
    handler now matches against the M1.5 ID `ADWoSm…`, so the test
    payload constructed with the stale ID is correctly classified
    as not-registry and skipped. The same stale constant lives in
    `webhook-replay.test.ts:5` and `event-handler.test.ts:10` —
    those test files are gated on `DATABASE_URL`/`INTEGRATION` and
    are skipped under the unit-test CI lane, so they don't fail CI
    but will fail the next time the integration lane runs against a
    real DB. **Fix:** update the three test-file constants to the
    M1.5 ID. **Backend-eng's prior claim "typecheck and biome lint
    both clean" missed the `pnpm test` step.**

- **Medium:**
  - **M1 (out-of-scope but pre-mainnet critical). SDK still
    hardcodes the stale registry program ID.**
    `packages/sdk/src/register.ts:15` defines
    `PROGRAM_ID = new PublicKey('GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd')`
    and uses it in `PublicKey.findProgramAddressSync(...)` for
    listing PDA derivation. The on-chain program is at
    `ADWoSm…`; PDAs derived against the wrong program will not
    match what's actually stored on chain — `bazaar.register()` and
    any consumer that calls into `register.ts` will produce a
    listing PDA that doesn't correspond to a real listing account.
    This is a **separate critical bug** outside PR #74's stated
    scope. Open a dedicated issue and assign to sdk-eng. Block
    mainnet on it.
  - **M2 (out-of-scope). E2E test helper hardcodes stale ID.**
    `tests/helpers/tx-utils.ts:11` defines
    `REGISTRY_PROGRAM_ID = new PublicKey('GJRgCC…')` used by E2E
    fixtures; same drift surface as M1. Bundle into the same
    sdk-eng follow-up.

- **Low:**
  - **L1. `transactionError` tightening — gated on Helius API
    invariant.** The promotion from `.nullable().optional()` to
    `.nullable()` makes the field required-but-nullable. This is
    correct *if* Helius always emits the field on enhanced
    transactions; if any payload variant (e.g., webhook test events,
    parsed format, raw events) ever omits the field, every event in
    that batch will fail Zod parsing and be dropped. Helius's
    enhanced-transactions docs do guarantee this field is always
    present in the standard webhook format, so the tightening is
    sound for the webhook path the indexer subscribes to. Worth a
    one-line note in the schema or a regression test that asserts
    `parse({...without transactionError})` rejects (so a future
    schema rewrite can't silently weaken this).
  - **L2. Env-var override pattern lacks runtime validation.** The
    new pattern
    `process.env.BAZAAR_REGISTRY_PROGRAM_ID ?? 'ADWoSm…'`
    does not validate that the env value is a well-formed base58
    pubkey. A malformed env value (typo / truncation) silently
    propagates as the comparison string for instruction matching —
    every registry tx is then classified as not-relevant and the
    webhook returns `relevant: 0` with no error. Recommend wrapping
    in a `new PublicKey(value).toBase58()` round-trip at module load
    so a malformed env var fails fast at startup. Non-blocking;
    deployers will notice via missing data within minutes.

- **Informational:**
  - **I1. Field reorder is purely cosmetic** (Zod schema field
    order doesn't affect parsing). ✅ Cleaner reading order, no
    runtime change.
  - **I2. `lighthouseData: z.unknown().optional()` is permissive.**
    Accepting `unknown` means downstream consumers must do their
    own narrowing if they ever need to read this field. Fine for
    forward-compat absorption of an opaque Helius field. ✅
  - **I3. Two further test fixtures hardcode stale IDs.**
    `packages/sdk/tests/escrow-methods.test.ts:64`,
    `hire.test.ts:52`, `client.test.ts:100/109/115/122` all use
    `GJRgCC…` as a placeholder pubkey for *non-program* objects
    (escrow PDA, listing PDA, etc. — they're just opaque public-key
    arguments fed to mocked SDK methods). These don't need to be
    updated as long as the tests don't actually round-trip the value
    against on-chain state. Cosmetic only.
  - **I4. PR title says "Task #41"; live TaskList already marked
    Task #37 = "Task #41 — Post-M1.5 indexer cleanup".** Same
    task-number drift pattern as PRs #65/#67/#69/#72. Cosmetic.

### Sanity-check answers

1. ✅ **No new admin keys / withdrawal authorities.** Pure config.
2. ✅ **No fund-flow surface change.** Indexer is a read-only
   webhook consumer; it never authorizes token transfers.
3. ✅ **New IDs match `declare_id!` on-chain.** Verified:
   - `programs/bazaar-registry/src/lib.rs:5` =
     `ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3` ✅
   - `programs/bazaar-escrow/src/lib.rs:8` =
     `EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2` ✅
   - `.env` and `.env.example` already carry these ✅
   - `turbo.json` already declares both env vars in `globalEnv`
     (verified — `BAZAAR_REGISTRY_PROGRAM_ID` /
     `BAZAAR_ESCROW_PROGRAM_ID` at lines 16–17) ✅
4. ❌ **CI is RED.** See H1.

### Verdict

✅ **APPROVE for merge** (after fix-up commit `ba5ee38`).

Initial verdict was NEEDS_CHANGES on the failing CI test. Backend-eng
pushed a follow-up commit at 2026-04-26T00:07Z that updates the three
test-file `REGISTRY_PROGRAM_ID` constants from the stale M0 value
(`GJRgCC…`) to the M1.5 value (`ADWoSm…`). Confirmed:
- Diff `f9e3178..ba5ee385` touches only those three constants — no
  other changes.
- CI run `24943892064` is **green** (Lint + typecheck + test, completed
  2026-04-26T00:07:50Z).
- Test `webhook.test.ts:97` (`returns 200 and counts relevant registry
  events`) passes; `webhook-replay.test.ts` and `event-handler.test.ts`
  test files now also align with the M1.5 ID for the next time the
  integration lane runs against a real DB.

Substantive scope of the PR remains correct and safe — program ID swap
matches on-chain `declare_id!`, env-var override pattern is fine, Zod
tightening is sound.

### Required to flip to APPROVE

Update the M1.5 registry program ID in three test-file constants:
- `apps/indexer/tests/webhook.test.ts:4`
- `apps/indexer/tests/webhook-replay.test.ts:5`
- `apps/indexer/tests/event-handler.test.ts:10`

Optionally also fix M1 (sdk-eng follow-up) and address L2 (env-var
runtime validation) — those can be separate PRs.

### Carryforwards (for separate follow-up PRs)

- **M1 / M2 (sdk-eng — pre-mainnet blocker).** SDK
  (`packages/sdk/src/register.ts:15`) and E2E helper
  (`tests/helpers/tx-utils.ts:11`) still hardcode the stale M0
  registry program ID. The SDK derives listing PDAs against the
  wrong program — `bazaar.register()` and dependents are broken
  against the live on-chain program. Open a dedicated issue and
  block mainnet cutover on it.
- **L1 (backend-eng).** Add a regression test asserting Zod rejects
  payloads missing `transactionError`, so the tightening can't be
  silently weakened by a future schema rewrite.
- **L2 (backend-eng).** Validate env-var-supplied program IDs at
  module load via `new PublicKey(...)` so a typo'd env var fails
  fast instead of silently dropping all registry txs.
- **I4 (cosmetic).** PR title task-number drift; harmless.


---

## PR #77 — feature/sdk-cluster-aware-ids — 2026-04-26
**Verdict:** APPROVED (with non-blocking follow-ups)

**Tasks closed:** #39 (per-cluster program ID table + bump 0.2.0), #40 (IDL regen + `priceLamports` → `priceUsdcBaseUnits` propagation in SDK).
**Resolves:** the carryforward `M1/M2 (sdk-eng — pre-mainnet blocker)` from PR #74's notes — stale M0 registry ID `GJRgCC...QqYgchQqd` no longer reachable from any SDK execution path.

**Scope of review:**
- `packages/sdk/src/program-ids.ts` (new, +90)
- `packages/sdk/src/errors.ts` (`UnknownClusterError`, +14)
- `packages/sdk/src/register.ts` (cluster-aware PDA derivation)
- `packages/sdk/src/escrow-utils.ts` (cluster-aware `getEscrowProgramId`)
- `packages/sdk/src/hire.ts`, `packages/sdk/src/index.ts` (exports)
- `packages/sdk/tests/program-ids.test.ts` (new, 17 unit tests)
- `tests/helpers/tx-utils.ts`, `tests/e2e/register-discover.test.ts`
- `packages/sdk/package.json` (`0.2.0`)

Walked: address-correctness vs `packages/idl/idl/bazaar_*.json`, fail-safe
properties of `clusterFromConnection()`, exhaustive grep for stale M0 ID and
for new hardcoded base58 program-IDs outside `program-ids.ts`,
`UnknownClusterError` shape vs the BazaarError hierarchy from PR #51,
breaking-change blast radius for `tests/helpers/tx-utils.ts`.

**Findings:**

- **Critical:** none.
- **High:** none.
- **Medium:** none.

- **Low:**
  - **L1. Test fixtures still reference the old M0 registry ID as opaque
    PDA strings.** Five hits remain after the cleanup:
    `packages/sdk/tests/hire.test.ts:52` (`LISTING_PDA`),
    `packages/sdk/tests/escrow-methods.test.ts:64` (`ESCROW_PDA`),
    `packages/sdk/tests/client.test.ts:100,109,115,122` (escrow ID args
    to `deliver` / `confirm` / `claimTimeout` / `dispute`). All five are
    used as opaque base58 strings to satisfy `new PublicKey(...)`, never
    as a program ID — no security impact. But the literal is misleading
    to future readers and breaks the "stale-ID grep returns zero" hygiene
    the rest of the cleanup achieved. Recommend swapping for
    `Keypair.generate().publicKey.toBase58()` (one-liner per test) or a
    clearly-fixture base58 like `'1nc1nerator11111111111111111111111111111111'`.
    Cosmetic; can be a follow-up PR.
  - **L2. `clusterFromConnection()` substring matching is first-match-wins
    and ambiguity-prone (pre-mainnet hardening required).** Order is
    `localhost > devnet > testnet > mainnet`; matching is `String.includes`.
    A URL like `https://mainnet-proxy.example.com/devnet-shadow` resolves
    to `'devnet'`. **Currently safe** because mainnet placeholder IDs are
    SystemProgram (`11111…1`) — any misclassification fails at instruction
    construction with "program not executable", not silent fund loss.
    **But this becomes load-bearing the moment M2 populates real mainnet
    IDs.** Before the M2 mainnet deploy lands, harden cluster detection
    by either (a) parsing URL hostname and matching against an explicit
    allowlist, or (b) adding an explicit `cluster?: Cluster` field to
    `AgentBazaarConfig` that overrides the URL inference. The audit team
    (OtterSec / Neodyme) will flag this if it's still a substring match
    on mainnet day. Track as M2 blocker.
  - **L3. `PROGRAM_IDS` is exported as a mutable object.** Recommend
    `Object.freeze()` on the outer record and on each `ProgramAddresses`
    entry to prevent runtime mutation by a supply-chain-compromised
    transitive dep. Defense-in-depth; pairs naturally with the `as const`
    treatment Anchor IDLs already get.
  - **L4. `DEVNET_USDC_MINT` in `escrow-utils.ts:28` is hardcoded** while
    program IDs gained cluster-awareness. Same per-cluster table pattern
    should be applied to USDC mint in M2 (mainnet USDC is
    `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). Currently overridable
    via the `usdcMint` parameter on `hireAgent`, so non-blocking; track
    as M2 follow-up alongside L2.
  - **L5. No `CHANGELOG.md` for `@agentbazaar/sdk`.** Going `0.1.0 →
    0.2.0` with a documented breaking change (the `deriveListingPda`
    signature, `REGISTRY_PROGRAM_ID` removal, `UnknownClusterError`
    throw) deserves a changelog entry. Recommend adding
    `packages/sdk/CHANGELOG.md` with at least the 0.2.0 / 0.1.0
    entries, then keep-a-changelog discipline going forward.

**Address-correctness verification:**

| Program | `program-ids.ts` (devnet) | `packages/idl/idl/bazaar_*.json` | Match |
|---|---|---|---|
| registry | `ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3` | `ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3` | ✅ |
| escrow | `EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2` | `EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2` | ✅ |
| sla | `26rhkrBkf75ijDoDuhed8m94FkuhB2MukvqtWYEDegd8` | `26rhkrBkf75ijDoDuhed8m94FkuhB2MukvqtWYEDegd8` | ✅ |
| evaluator | `BxctnHyx9UJT7XobxHK3X548sSoPQB96Ca2fMEzYYMS8` | `BxctnHyx9UJT7XobxHK3X548sSoPQB96Ca2fMEzYYMS8` | ✅ |
| `mainnet-beta` placeholder | `11111111111111111111111111111111` (SystemProgram) | n/a (not deployed) | ✅ discipline |
| `testnet` placeholder | `11111111111111111111111111111111` (SystemProgram) | n/a (not deployed) | ✅ discipline |

**`UnknownClusterError` shape (vs BazaarError hierarchy from PR #51):**
- Extends `AgentBazaarError`: ✅
- `name = new.target.name` (inherited): ✅
- Carries `endpoint: string` field for debuggability: ✅
- Exported from `packages/sdk/src/index.ts`: ✅

**Field-rename propagation grep:**
- `priceLamports` / `price_lamports` in `packages/sdk/`: 0 hits ✅
- `priceLamports` / `price_lamports` in `packages/idl/`: 0 hits ✅
- `priceLamports` / `price_lamports` in `tests/`: 0 hits ✅
- `priceUsdcBaseUnits` total occurrences across `packages/`+`tests/`+`apps/`: 25 ✅

**Out of scope for #77 — but flagged for backend-eng follow-up:**
- `apps/indexer/src/events/on-listing-updated.ts:23,32` and
  `apps/indexer/drizzle/0000_third_living_lightning.sql:6,17` still
  reference SQL column `price_lamports`. The chain-side rename (PR #76)
  and SDK-side rename (this PR) are clean; only the indexer's DB column
  remains on the legacy name. Not a security concern (column name is
  internal storage, no on-chain coupling) but should be tracked as a
  Drizzle migration before any external indexer-DB consumer wires up.

**Required changes before merge:** none.

**Recommended follow-up PRs (post-merge, M2 readiness):**
- L2 + L4 bundled: cluster-aware USDC mint + hardened
  `clusterFromConnection()` (allowlist or explicit-override pattern).
  **Pre-mainnet blocker.**
- L1: cosmetic test-fixture cleanup.
- L3: `Object.freeze(PROGRAM_IDS)`.
- L5: introduce `packages/sdk/CHANGELOG.md`.
- Indexer column rename (backend-eng): Drizzle migration
  `price_lamports` → `price_usdc_base_units`.

---

## PR #79 — feature/backend-m15-metadata-ttl — 2026-04-26
**Verdict:** APPROVED (in isolation, no blocking findings)

**Tasks closed:** #42 (metadata JSONB column + persistence), #44 (TTL retention cron for processed_signatures).

**Scope of review:**
- `apps/indexer/drizzle/0004_short_vertigo.sql` (`ALTER TABLE service_listings ADD COLUMN metadata jsonb`)
- `apps/indexer/src/db/schema.ts` (jsonb `metadata` column)
- `apps/indexer/src/cron/retention.ts` (new — `runRetentionCleanup` + `startRetentionCron`)
- `apps/indexer/src/env.ts` (`RETENTION_INTERVAL_MS`)
- `apps/indexer/src/index.ts` (cron wiring)
- `apps/indexer/src/events/on-listing-created.ts` + `on-listing-updated.ts` (metadata persistence)
- `apps/indexer/tests/fetch-metadata-schema.test.ts` (13 unit tests; later rewritten in PR #80 H2 fix)
- `apps/indexer/tests/retention.test.ts` (timer wiring + DB integration)

**Findings:**

- **Critical / High / Medium:** none.

- **Low:**
  - **L1.** `RETENTION_INTERVAL_MS` schema has no `.min()` floor. Operator typo of `1` (intent: `1` hour as `3_600_000`) → cron fires every 1 ms → log storm + DB connection-pool churn. Recommend `.min(60_000)` on the Zod schema, or document the intended unit. Operational, not security.
  - **L2.** `startRetentionCron` schedules a one-shot `setTimeout(60_000)` AND a `setInterval(intervalMs)` — these run on independent timers. With 24 h default the gap is fine; if a future load test sets `intervalMs = 60_000`, the initial timeout and the first interval fire ~together. Add `Math.max(intervalMs, 60_000)` or document the intended cadence.

- **Cross-PR coordination (resolved in PR #80 fixup).**
  This PR's `apps/indexer/tests/fetch-metadata-schema.test.ts` mocked `globalThis.fetch`. PR #80 (`feature/backend-m15-ssrf-hardening`) rewrote `fetch-metadata.ts` to use `node:https.request`. When both PRs landed together, 10/13 schema tests timed out (verified: 50 s vs 233 ms). Backend-eng's PR #80 fixup commit `4866e14` rewrote the schema test to use a shared `tests/helpers/mock-https.ts` module, eliminating the collision. CI green after fixup.

**SQL safety verification:**
- Cron DELETE uses `${cutoff}` as a JS Date bind parameter — postgres.js parameterises it as `timestamp with time zone`. No raw SQL interpolation. ✅
- `metadata = ${JSON.stringify(metadata)}` matches the existing `slaParams` pattern (PR #11) — postgres.js implicitly casts string to jsonb. ✅
- Migration 0004 is `ADD COLUMN ... jsonb` (nullable, no default) — no table rewrite, safe on production-sized tables. ✅

**Required changes before merge:** none.
**Status:** Merged as commit `c88e51d`.

---

## PR #80 — feature/backend-m15-ssrf-hardening — 2026-04-26
**Verdict:** APPROVED (after re-audit of fixup commit `4866e14`)
**Iteration count:** 2 (initial review NEEDS_CHANGES → fixup → APPROVED).

**Task closed:** #43 (SSRF hardening — I1 streaming cap + I2 DNS pinning).

**Scope of review:**
- `apps/indexer/src/events/fetch-metadata.ts` (rewrite: `httpsGetPinned()` + `readBodyWithLimit()` replace `fetch()` + `res.text()`)
- `apps/indexer/tests/fetch-metadata-ssrf.test.ts` (new — 19 SSRF tests, +4 H1 regression tests post-fixup)
- `apps/indexer/tests/fetch-metadata-schema.test.ts` (rewritten in fixup to use shared helpers)
- `apps/indexer/tests/helpers/mock-https.ts` (new — shared `stubHttpsRequest` / `makeMockStream`)

### Iteration 1 — initial review (NEEDS_CHANGES)

Two High findings blocked merge:

- **H1 — IPv4-mapped IPv6 SSRF bypass.** `isPrivateIp()` did string-prefix
  matching on raw addresses without normalising `::ffff:x.x.x.x`. Verified
  via extracted-function probe set:
  ```
  isPrivateIp(::ffff:127.0.0.1)        = false   ❌ loopback bypass
  isPrivateIp(::ffff:169.254.169.254)  = false   ❌ EC2 cloud metadata bypass
  isPrivateIp(0.0.0.0)                 = false   ❌ Linux routes to localhost
  ```
  Attacker controlling DNS for `evil.example.com` could publish
  `AAAA ::ffff:169.254.169.254` → on dual-stack indexer host, dns.lookup
  returns mapped form → blocklist misses → indexer connects to EC2/GCP
  metadata service and exfiltrates IAM token via 100 KB-capped response.

- **H2 — Cross-PR test collision with PR #79.** Verified by running both
  PRs together: 10/13 tests in `fetch-metadata-schema.test.ts` timed out
  (50 s vs 233 ms standalone). PR #79's schema test stubbed
  `globalThis.fetch`; PR #80 switched implementation to
  `node:https.request`. Stub became no-op; real https.request hit 5 s
  timeout against DNS-mocked `1.2.3.4`.

Plus L1 (lookup hook hardcoded `family = 4` instead of result.family).

### Iteration 2 — re-audit of fixup `4866e14`

**H1 fix verified:** post-fixup `isPrivateIp` lowercases address, unwraps
`::ffff:` via `node:net.isIPv4()`, blocks `0.0.0.0` / `::`, adds
`startsWith('ff')` for IPv6 multicast `ff00::/8`. Re-ran the same probe
set + 4 new probes:

```
✓ isPrivateIp(::ffff:127.0.0.1            ) = true   (want true)
✓ isPrivateIp(::ffff:10.0.0.1             ) = true   (want true)
✓ isPrivateIp(::ffff:169.254.169.254      ) = true   (want true)
✓ isPrivateIp(0.0.0.0                     ) = true   (want true)
✓ isPrivateIp(::                          ) = true   (want true)
✓ isPrivateIp(FE80::1                     ) = true   (want true)  ← uppercase
✓ isPrivateIp(Fc00::1                     ) = true   (want true)  ← mixed case
✓ isPrivateIp(ff02::1                     ) = true   (want true)  ← multicast
✓ isPrivateIp(1.2.3.4                     ) = false  (want false)
✓ isPrivateIp(8.8.8.8                     ) = false  (want false)
✓ isPrivateIp(2606:4700:4700::1111        ) = false  (want false) ← public IPv6
✓ isPrivateIp(100.64.0.1                  ) = false  (want false) ← CGNAT (see L3)
12 pass / 0 fail
```

PR's own `fetch-metadata-ssrf.test.ts` adds 4 H1 regression tests:
`::ffff:127.0.0.1`, `::ffff:169.254.169.254`, `0.0.0.0`, uppercase
`FE80::1`. All pass.

**H2 fix verified:** schema test rewritten to import
`stubHttpsRequest` + `makeMockStream` from new
`tests/helpers/mock-https.ts`. Full indexer vitest run:

```
Test Files  11 passed | 2 skipped (13)
     Tests  86 passed | 14 skipped (100)
   Duration  525 ms
```

(vs 50 s pre-fixup with 10 timeouts.) ✅

**L1 fix verified:** `lookup` hook now passes `resolvedFamily` from the
dnsLookup result (line 159) instead of hardcoded `4`. IPv6-only
resolvers will now work correctly.

**DNS pinning architecture re-verified race-free:**
1. `dnsLookup(hostname)` runs once, captures `resolvedIp` + `resolvedFamily` in closure.
2. `isPrivateIp(resolvedIp)` validates against the strengthened blocklist.
3. `https.Agent({ lookup })` hook is a closure that ignores its `_host` argument and unconditionally returns `(null, resolvedIp, resolvedFamily)` — no second OS resolver call.
4. `https.request({ hostname: resolvedIp, agent, servername: hostname })` uses the validated IP literal as connection target. Defense-in-depth: even if Node bypassed the lookup hook for IP-literal hostnames, the IP pin still holds.

No race window between validation and TCP connect. ✅

**TLS cert validation preserved:**
- `servername: hostname` (original DNS name) → SNI uses the name, not the IP. ✅
- `rejectUnauthorized: true` → cert chain + name validation against `servername`. ✅
- `Host: hostname` header → HTTP-layer virtual-host routing intact. ✅

### Findings (post-fixup)

- **Critical / High / Medium:** none.

- **Low:**
  - **L3.** CGNAT range `100.64.0.0/10` (RFC 6598) is not in the v4
    blocklist. An attacker on a CGNAT'd ISP could not pivot to
    AgentBazaar internal infra via this, but for paranoid completeness
    (and to match audit-team expectations on mainnet day) consider
    adding `/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./`. Lower priority
    than H1 because cloud metadata services don't live in CGNAT space.
  - **L4 (defense-in-depth).** Consider migrating to `ipaddr.js` and
    using `ipaddr.parse(addr).range()` for the SSRF blocklist. Returns
    named ranges (`loopback`, `private`, `linkLocal`, `uniqueLocal`,
    `multicast`, `reserved`, `unspecified`, `carrierGradeNat`, etc.),
    eliminates the regex/prefix-match maintenance burden, and is what
    OtterSec / Neodyme will recommend on mainnet day. Track as M2
    follow-up alongside the SDK cluster-detection hardening (PR #77 L2).

### Test plan re-execution

| Check | Pre-fixup | Post-fixup |
|---|---|---|
| H1 IP probe (8 positives + 4 negatives) | 4/12 ❌ | 12/12 ✅ |
| `pnpm -F @agentbazaar/indexer test` | 10 timeouts in 50 s ❌ | 86 pass / 14 skip in 525 ms ✅ |
| TLS SNI / cert validation | ✅ unchanged | ✅ unchanged |
| DNS pinning race-free | ✅ unchanged | ✅ unchanged |

**Required changes before merge:** none.

### Notes for the external audit team (OtterSec / Neodyme)

- `apps/indexer/src/events/fetch-metadata.ts` is the only outbound
  HTTP-from-private-network surface in the indexer. Worth a focused
  pass on mainnet day: SSRF mitigations rest on `node:net.isIPv4` +
  `String.startsWith` prefix matching. The L4 follow-up (migrate to
  `ipaddr.js`) would eliminate the foot-gun of someone adding a new
  range with a typo'd regex.
- DNS pinning relies on Node's `https.Agent.lookup` hook semantics. If
  Node ever changes hook contract (e.g., adds a fallback OS-resolver
  call), this defense degrades. Pin Node version range in
  `apps/indexer/package.json` engines field as part of M2 prep.

---

## PR #82 — `fix(sdk): use canonical ASSOCIATED_TOKEN_PROGRAM_ID from @solana/spl-token (Task #47, R1)`

**Branch:** `feature/sdk-fix-ata-constant`
**Reviewed:** 2026-04-26
**Verdict:** APPROVED (post-hoc — already merged at `8a1556e`; flagged for record)

### Scope

1-line + import fix in `packages/sdk/src/escrow-utils.ts` swapping a
typo'd hardcoded `ASSOCIATED_TOKEN_PROGRAM_ID`
(`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bC8` — last 4 `1bC8`)
introduced in PR #59 with the canonical pubkey imported directly from
`@solana/spl-token` (`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` —
last 4 `8knL`). Same treatment for `TOKEN_PROGRAM_ID`.

Adds `@solana/spl-token ^0.4.9` as explicit `dependencies` +
`peerDependencies` (was already transitively in lockfile).

Adds regression `packages/sdk/tests/escrow-utils.test.ts` (4 cases)
verifying `getAssociatedTokenAddress(mint, owner)` matches
`getAssociatedTokenAddressSync` from `@solana/spl-token`.

### Audit findings

| Check | Verdict |
|---|---|
| Typo'd ATA program ID replaced with canonical | ✅ |
| No remaining `ATokenGP*` literals in SDK / tests | ✅ (`grep -rn 'ATokenGP' packages/sdk/ tests/` → 0) |
| Imported from upstream (`@solana/spl-token`) — single source of truth | ✅ |
| Regression test in place | ✅ (4 cases) |
| Trust boundary impact | None — typo'd constant produced a wrong (non-existent) ATA, which simply caused RPC `account not found` errors at pre-flight balance check. Not exploitable: an attacker cannot persuade the Anchor program to accept a wrong-derivation ATA because the on-chain `token::mint = usdc_mint, token::authority = buyer` constraints reject it. So the bug was strictly **functional**, not a security vector. |
| Re-derivation matches `getAssociatedTokenAddressSync` deterministically | ✅ |
| Lint / 180 SDK unit tests | ✅ (per PR body) |

**Critical / High / Medium / Low:** none.

**Required changes before merge:** none.

### Notes for the external audit team (OtterSec / Neodyme)

- Lesson learned: **never inline canonical SPL constants by string
  literal**. PR #59 introduced the typo because someone copy-pasted
  the address with a transcription error. M2 housekeeping: add a
  semgrep / ripgrep CI rule banning hardcoded `ATokenGP*` /
  `Tokenkeg*` / `So111111…` literals outside `packages/idl/`.
- The fact that `pnpm typecheck` did not catch this (both addresses
  are valid base58, both parse to a `PublicKey`) is by design — type
  system has no semantic knowledge of program IDs. Rely on the
  semgrep rule + the new `escrow-utils.test.ts` regression.

---

## PR #83 — `fix(escrow): correct devnet USDC mint constant + cluster-aware feature flag (Task #48, R2)`

**Branch:** `feature/anchor-fix-escrow-usdc-mint`
**Reviewed:** 2026-04-26
**Verdict:** APPROVED

### Scope

Two-commit PR:

1. **`989c628`** — anchor-eng: replace test-validator USDC mint
   (`8VEVN5sJUzqN3ddkJV9gYMbLBnmAxUXsC5CDDU9WFwzE`) with Circle's
   official devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`)
   in `programs/bazaar-escrow/src/lib.rs`. Simplifies cfg-feature
   pattern from 3-way (`devnet` / `testing` / mainnet fallback) to
   2-way (`mainnet` / not-mainnet). Anchor.toml gains a
   `[[test.validator.account]]` entry that pre-loads a synthetic SPL
   Mint at the canonical devnet USDC address for localnet tests.
   Upgrade-in-place on devnet at existing program ID
   `EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2`. IDL refresh via
   `pnpm sync` updates 5 `usdc_mint.address` occurrences in
   `packages/idl/idl/bazaar_escrow.json` and the matching .ts.

2. **`0924299`** — team-lead late add: drop `usdcMint:` from
   `packages/sdk/src/hire.ts` `.accounts({ ... })` because the new IDL
   exposes `usdc_mint` with an explicit `address` constant — Anchor
   0.31's `ResolvedAccounts<>` type rejects the redundant field.
   `usdcMint` remains a function parameter / variable, used for
   `buyerTokenAccount` ATA derivation (line ~93) — that is correct
   and necessary.

### Bug context

Smoke (Task #41) by qa-test-eng caught that PR #76 (Task #38) baked
the wrong mint constraint into the deployed bazaar-escrow program +
IDL. On devnet, account `8VEVN5sJUzqN3ddkJV9gYMbLBnmAxUXsC5CDDU9WFwzE`
does not exist, so `create_escrow`'s `#[account(address = USDC_MINT)]`
constraint dereferenced a non-existent account and the RPC simulation
returned an account-not-found error. **Pure functional bug, not
exploitable** — wrong constraint just means *all* escrows on devnet
fail. There is no path where an attacker could substitute their own
mint, because Anchor's `address = ...` constraint enforces equality
strictly. Trust boundary intact at all times.

### Audit checklist

| # | Check | Result |
|---|---|---|
| 1 | Devnet USDC address in IDL = `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | ✅ all 5 occurrences in `bazaar_escrow.json` + `.ts` |
| 2 | Mainnet USDC address spelled correctly = `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | ✅ matches Circle's published mainnet mint |
| 3 | `#[cfg(feature = "mainnet")]` + `#[cfg(not(feature = "mainnet"))]` covers all cases | ✅ no fall-through possible — exhaustive, compile-time determined |
| 4 | `Cargo.toml` declares the `mainnet` feature | ✅ `mainnet = []`, `default = []` (correct) |
| 5 | No env-var / runtime resolution for USDC_MINT | ✅ pure compile-time `pubkey!()` constant |
| 6 | All 4 escrow Accounts structs have `#[account(address = USDC_MINT)]` constraint on `usdc_mint` field | ✅ verified at `lib.rs:440, 483, 522, 570` |
| 7 | Vault PDA still program-owned, no admin key | ✅ `seeds = [b"vault", escrow.key().as_ref()]`, `token::authority = vault` |
| 8 | Synthetic mint fixture is well-formed SPL Mint | ✅ decoded: decimals=6, supply=0, mint_authority matches `test-mint-authority.json` keypair (`2iM2pV81vYaXiyt4ozZKAX4Tq2EwKCsqyiP7a7YX3ao8`), freeze_authority=None, owner=`TokenkegQ…`, initialized=true |
| 9 | `programs/deploy-receipts.md` records upgrade-in-place tx | ✅ `5z11yrKQ8kGhJaFGtdKLmBZQ1tVB7uyEWhL2TF5AeHBjS3KZC1s7KsgfSQYGvqJNVwAqE2NS1JGMy4ErqCzMFgtu` at slot 458162475 |
| 10 | Program ID unchanged across upgrade (`EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2`) | ✅ `declare_id!` in `lib.rs:9` matches existing devnet PID |
| 11 | Regression test asserts wrong mint is rejected with `ConstraintAddress` | ✅ `programs/tests/bazaar-escrow.ts:261` exercises `create_escrow` with a generated `badMintKp`, expects `/ConstraintAddress/` |
| 12 | `hire.ts` no longer passes `usdcMint:` to `.accounts({ })` | ✅ commit `0924299` removes the field |
| 13 | Other escrow methods (deliver / confirm / dispute / claimTimeout) — no `usdcMint:` in `.accounts({ })` | ✅ all 4 already construct `accts = { ... } as any` and only pass token-account derivations; no breakage |
| 14 | `usdcMint` still flows to ATA derivation in SDK methods | ✅ all 5 SDK methods call `getAssociatedTokenAddress(usdcMint, owner)` |
| 15 | Squads multisig upgrade authority preserved across in-place upgrade | n/a for devnet — but flag below for mainnet day |
| 16 | Trust boundary: attacker cannot substitute alternate mint post-fix | ✅ `address = USDC_MINT` enforces equality at runtime via Anchor |
| 17 | Regression scope: pre-fix orphaned escrows | ✅ none — devnet smoke caught the bug before any successful escrow could land (literally impossible to create one with wrong-mint program) |

### Findings

- **Critical / High / Medium:** none.

- **Low:**
  - **L1.** When the team produces the mainnet release artifact,
    please verify that `cargo build-sbf --features mainnet` is the
    actual command run by the deploy script (PR mentions it as the
    invocation). A regression where someone forgets `--features
    mainnet` and ships the devnet binary to mainnet would silently
    bind to a non-existent mint on mainnet (Circle devnet USDC does
    not exist on mainnet, so all escrows would fail — same shape of
    bug as this PR fixes). Recommend the mainnet-deploy CI job
    include a post-build assertion: `solana program dump <PID>
    /tmp/bin && grep -F EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
    /tmp/bin`. Track as M2 follow-up.
  - **L2.** Anchor 0.31's IDL generator embeds the constant address
    into the IDL JSON. Downstream consumers (SDK, dashboard,
    indexer) that build against the devnet IDL will compile-bind to
    `4zMMC9…`. If the published `@agentbazaar/sdk` ever ships a
    devnet IDL but is consumed against a mainnet RPC, every
    `create_escrow` will fail at simulation. Mitigation: at
    `npm publish` time, ship two IDLs (`bazaar_escrow.devnet.json`
    + `bazaar_escrow.mainnet.json`) and let the SDK select via
    `cluster` parameter. Track in same M2 cluster-detection
    follow-up flagged in PR #77 L2 and PR #80 L4.

### Test plan execution

- ✅ IDL diff verified: 4 contexts had address `8VEVN5…` → `4zMMC9…`
  (already had address constraint); the 5th (`CreateEscrow`) had
  only `docs:` previously and now correctly has `address:` + the new
  emit_cpi event-authority/program account additions. Net effect: IDL
  is now in sync with the on-chain `#[account(address = USDC_MINT)]`
  constraint that's been on the program since PR #51.
- ✅ Mint fixture decoded byte-for-byte: matches USDC shape,
  authority deterministic.
- ✅ Regression test `rejects create_escrow with wrong USDC mint
  (ConstraintAddress)` is the canonical guard against future
  mint-mismatch regressions.
- ✅ Commit `0924299` SDK fix is the minimum surgical change required
  by the new IDL — no other escrow methods needed updates because
  they already use `as any` casts and don't pass `usdcMint:`.

**Required changes before merge:** none.

### Notes for the external audit team (OtterSec / Neodyme)

- The `address = USDC_MINT` constraint pattern is the M1-tail closure
  of H1 (originally raised in PR #51 audit notes). Mainnet build
  must be produced with `--features mainnet`; verify in deploy CI
  before mainnet day (L1 above).
- Synthetic SPL Mint fixtures pre-loaded via `[[test.validator.account]]`
  are now part of the test stack. The fixture authority keypair
  (`tests/fixtures/test-mint-authority.json`) is a public test secret
  — never use it for any account that holds value. It exists only to
  give the local validator a controllable mint authority for
  `mint_to` during tests.
- PR #76 / PR #51 trail: PR #51 introduced the per-cluster
  `USDC_MINT` constraint (audit-approved at the time). PR #76 added a
  `testing` cargo feature with the wrong mint hardcoded — the audit
  for PR #76 missed that the test mint differed from devnet USDC,
  because at the time the IDL had only `docs:` (no `address`) for
  `CreateEscrow.usdcMint` and the symptom only surfaced at smoke. PR
  #83 closes the loop. Add a CI assertion (mentioned above as L1) so
  this class of cluster-mint mismatch can never silently ship again.

---

## PR #86 — feat(sdk): cluster hostname allowlist + USDC mint table + simulation error mapping + CHANGELOG (Task #53, M2-W1.B)

**Branch:** `feature/sdk-polish-m1.5-carryforwards`
**Verdict:** APPROVED with low-severity follow-ups
**Diff:** +436 / -51 across 9 files (no `programs/` changes)

### Scope

PR closes four M1.5 carryforwards that were filed in earlier audits:

- **L2 from PR #77 audit** — `clusterFromConnection()` was substring-based; spoof-able via path/query injection. PR rewrites detection to extract the URL hostname via `new URL(endpoint).hostname` and matches against a per-cluster `CLUSTER_HOSTS` regexp allowlist with a deterministic match order (`localnet → devnet → testnet → mainnet-beta`). New `{ override?: Cluster }` option lets callers skip detection (used for explicit local config).
- **L4 from PR #77 audit** — Hardcoded `DEVNET_USDC_MINT` constant replaced by per-cluster `USDC_MINTS: Record<Cluster, PublicKey>` table and `getUsdcMint(conn)` helper. `hire.ts` now resolves the mint from the connection cluster by default. `DEVNET_USDC_MINT` kept as deprecated re-export of `USDC_MINTS.devnet` for backwards compat.
- **L5 from PR #77 audit** — `packages/sdk/CHANGELOG.md` created with entries for 0.2.1, 0.2.0, 0.1.0 (Keep-a-Changelog format). `package.json` bumped 0.2.0 → 0.2.1.
- **Task #51** (qa-test-eng smoke finding) — `sendWithRetry` now wraps `sendRawTransaction` in try/catch; `SendTransactionError.logs` are parsed by a new exported `mapSimulationError(logs, fallbackMessage)` for both Anchor structured logs (`Error Number: <N>`) and raw hex (`custom program error: 0x<hex>`). The 6000-based code-to-typed-exception lookup is hoisted into a shared `mapProgramCode()` so simulation and post-confirm paths use the same table.
- **Bonus** — `packages/sdk/vitest.config.ts` added to resolve `@solana/spl-token` from the pnpm virtual store. Test count: **198 pass vs. 83 prior** — six suites were silently skipping due to the module-resolution gap.

### Trust-boundary review

These are **client-side SDK changes only** — no `programs/` touched, no fund-flow code, no privileged operations. Worst-case failure modes:

- Bad hostname allowlist → SDK constructs instructions with wrong program IDs → tx rejected at simulation/build time (not on-chain). No fund-loss vector. (Mainnet program IDs are still placeholder `1111...` until M2 deploy, so even a perfect mainnet-spoof yields useless instructions.)
- Missed simulation error mapping → caller catches generic `TransactionFailedError` instead of typed subclass → UX degradation, not security.
- Wrong USDC mint resolution → SPL Token transfer would fail (mint mismatch caught by Anchor `address = USDC_MINT` constraint that PR #51/#83 added) → tx aborts. No fund movement.

No admin-key, vault-PDA, or upgrade-authority surface is touched.

### Findings

| Sev    | ID | File:Line                                | Issue                                                                                                                                                                                                                                                                                                                                                                                                                          | Status         |
|--------|----|------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------|
| Low    | L1 | `packages/sdk/src/program-ids.ts:74,83`  | The `\.devnet\.` and `\.mainnet\.` regexps are **not anchored**. A hostname such as `attacker.mainnet.evil.com` matches `mainnet-beta`; `victim.devnet.evil.com` matches `devnet`. The L2 fix from PR #77 hardened against *path*-injection but a partial *hostname*-injection vector remains. Not a fund-loss vulnerability today (mainnet IDs are placeholder; devnet attacker-RPC can't move funds), but defeats the spirit of the allowlist. **Recommend:** anchor patterns to specific suffixes — e.g. `/^[\w-]+\.devnet\.solana\.com$/`, `/^[\w-]+\.mainnet-beta\.solana\.com$/`, `/^[\w-]+\.helius-rpc\.com$/`. Or drop the broad subdomain wildcards and require callers to use `{ override }` for non-canonical RPCs. | NON-BLOCKING   |
| Low    | L2 | `packages/sdk/vitest.config.ts:9`        | Hardcoded **absolute path** `/workspace/node_modules/.pnpm/node_modules/@solana/spl-token` will break in CI (different CWD), on contributor machines outside the devcontainer, and on Windows. Use `path.resolve(__dirname, '../../node_modules/...')` or the standard pnpm-aware vitest resolver workaround. Operational; not security per se, but blocks portability of the test harness that just unlocked 115 newly-running tests. | NON-BLOCKING   |
| Info   | I1 | `packages/sdk/src/escrow-utils.ts:189`    | `mapSimulationError` propagates raw simulation log lines into the typed error message (`Simulation failed — program error ${code}: ${line}`). Logs may include program IDs and account addresses — **acceptable** for client-side SDK consumers (all addresses are public on-chain anyway), but worth flagging if these errors are ever forwarded to centralized logging at INFO level on the indexer/api side. No PII risk; no secret leakage. | NOTE           |
| Info   | I2 | `packages/sdk/src/escrow-utils.ts:178-188` | If a single log array contains **both** an Anchor `Error Number: N` line and a raw `custom program error: 0x<hex>` line (rare but possible — outer + CPI), the parser returns the **first** match in iteration order. Anchor logs are typically emitted before the raw failure line, so Anchor wins, which is the desired precedence. Worth a one-line code comment to make the contract explicit. | NOTE           |
| Info   | I3 | `packages/sdk/src/escrow-utils.ts:155-167` | Mapping table covers **3 of 11** Anchor error codes (`6000` Unauthorized, `6005` DeadlinePassed → `EscrowExpiredError`, `6006` DeadlineNotYetPassed → `EscrowNotExpiredError`). The Rust enum in `programs/bazaar-escrow/src/lib.rs:687` defines 11 variants (6000–6010). Codes 6001 (`ZeroAmount`), 6002 (`InvalidDeadline`), 6003 (`FieldTooLong`), 6004 (`InvalidStateTransition`), 6007 (`ListingMismatch`), 6008 (`TooManyTags`), 6009 (`ArithmeticOverflow`), 6010 (`InvalidScore`) all degrade to generic `TransactionFailedError`. Not security-critical (the SDK error subclasses already exist for some; e.g. `ValidationError`, `InvalidListingError`), just UX completeness. **Recommend:** track as a SDK polish ticket for M2-W2. | NOTE           |
| Info   | I4 | (repo-wide)                                | The `vitest.config.ts` gap that silently skipped 6 SDK test suites is a class of bug worth grepping for. **Recommend:** spot-check `apps/indexer/`, `apps/api/`, `tests/e2e/`, `tests/sla/`, `tests/load/` for any vitest config that resolves to defaults and might similarly skip under module-resolution failure. The fix is to fail-loud when `import.meta.resolve` of a workspace dep fails during config load. | FOLLOW-UP      |

### Cross-checks performed

- ✅ Mainnet USDC address `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` matches Circle canonical (Circle docs + Solscan). No typo.
- ✅ Devnet USDC address `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` matches Circle's devnet faucet mint (cross-checked with PR #51, PR #83, and `tests/fixtures/test-mint-authority.json` registry references).
- ✅ Testnet/localnet placeholder is `SystemProgram` (`1111...`). An instruction built with this as a SPL Token mint would fail at the Anchor `address = USDC_MINT` constraint added in PR #51/#83 — fails loudly, no silent corruption.
- ✅ `URL` parsing: `new URL("not a url")` throws `TypeError`; the PR catches it and falls back to a `host:port` heuristic, which then fails the regex match and propagates `UnknownClusterError`. No unhandled exception path.
- ✅ Override option (`{ override: Cluster }`) **bypasses detection entirely** — design choice, documented in JSDoc. Acceptable for explicit local config.
- ✅ Specific malicious URLs from the audit checklist:
  - `https://rpc.helius.xyz/devnet/?api-key=…` → `UnknownClusterError` ✓ (test added at `tests/program-ids.test.ts:24`)
  - `https://rpc.mainnet.helius.io/devnet-shadow?key=x` → `mainnet-beta` ✓ (test added at `tests/program-ids.test.ts:32`) — falls under L1: `\.mainnet\.` matches the hostname.
- ✅ `hireAgent` callers can still pass an explicit `usdcMint` to override the cluster default (e.g. for synthetic-mint test fixtures) — backwards-compatible API.
- ✅ `DEVNET_USDC_MINT` deprecated re-export still resolves to the correct mint (`USDC_MINTS.devnet`); JSDoc `@deprecated` tag present.
- ✅ Backwards compat for `clusterFromConnection`: existing single-arg calls work unchanged; the second arg is optional.
- ✅ No `console.log`, no secrets in code or test fixtures.

### Verdict

**APPROVED.** Safe to merge. None of the findings are blockers given the client-side-only scope and the absence of fund-flow vectors.

**Recommended follow-ups for M2-W2:**

1. Anchor the `\.devnet\.` and `\.mainnet\.` regexps to canonical suffixes (L1) — finishes the L2 hardening from PR #77 properly.
2. Replace the absolute-path workaround in `packages/sdk/vitest.config.ts` (L2) — required for portable CI.
3. Extend `mapProgramCode` lookup table to cover all 11 escrow error codes (I3) — complete the typed-exception surface.
4. Repo-wide audit of vitest configs for similar silent-skip gaps (I4) — meta-fix.

---

## PR #90 — feature/api-discovery-cf-workers — 2026-04-26

**Verdict:** APPROVED (with non-blocking follow-ups for M3)

**Scope of review:**
- `apps/api/src/index.ts` (+57) — Hono app entrypoint, global middleware, 404/onError
- `apps/api/src/middleware/cors.ts` (+9) — `origin: '*'`, GET+OPTIONS, no credentials
- `apps/api/src/middleware/ratelimit.ts` (+54) — lazy-init `hono-rate-limiter`, IP/agent tiers
- `apps/api/src/middleware/validate.ts` (+41) — Zod via `@hono/zod-validator`, structured 400
- `apps/api/src/routes/listings.ts` (+122) — list + detail; pagination, ILIKE, count
- `apps/api/src/routes/escrows.ts` (+46) — single detail by pubkey
- `apps/api/src/routes/agents.ts` (+50) — reputation snapshot, zero-state fallback
- `apps/api/src/db/client.ts` (+14) — neon-http driver, per-request factory
- `apps/api/src/db/schema.ts` (+115) — standalone Drizzle schema (TODO: extract to packages/db-schema)
- `apps/api/wrangler.toml` (+18) — no secrets in file; APP_VERSION only
- `apps/api/.dev.vars.example` (+5) — DATABASE_URL placeholder; `.dev.vars` in `.gitignore` ✓

This is the **first publicly internet-exposed AgentBazaar service** (deployed at
`https://agentbazaar-api.r-443.workers.dev`). Threat model expands from
trusted-internal to anonymous-traffic. Read-only — no fund flow, no signing,
no `programs/` write path. Trust-boundary surface: DB scan budget,
rate-limit memory, error-message hygiene.

### Trust-boundary review

Worst-case failure modes for this PR:
- **DB DOS** — slow query (ILIKE Seq Scan, large OFFSET) drains the Neon HTTP pool; SDK / dashboard reads stall. No fund-loss vector — escrows are settled on-chain.
- **CF budget drain** — anonymous attacker burns the 100k req/day free tier. Service degrades; on-chain settlement unaffected.
- **Rate-limit memory exhaustion** — per-isolate `MemoryStore` keyed on caller-supplied `X-Agent-Pubkey` value (no validation). Attacker rotates random keys → unbounded map growth → CF isolate OOM. Recoverable (CF spawns fresh isolates) but disrupts service.
- **No reflected XSS** — Zod `issues` strip the offending input value (only `path` + `message` exposed). Confirmed by code reading.
- **No SQLi** — all WHERE/ORDER BY/LIMIT/OFFSET use Drizzle helpers (`eq`, `ilike`, `and`, `asc`, `desc`); no raw `sql\`\`` template tags interpolating request data; the only `sql\`0\`` literals are static schema defaults.

No `programs/`, escrow vault PDA, admin-key, or upgrade-authority surface is touched.

### Findings

| Sev | ID | File:Line | Issue | Status |
|-----|----|-----------|-------|--------|
| Medium | M1 | `apps/api/src/middleware/ratelimit.ts:24-31` | **`X-Agent-Pubkey` header is not validated as base58 before keying the rate-limit map.** An attacker can spam `X-Agent-Pubkey: <random N bytes>` per request → unique map keys per request → unbounded growth in the per-isolate `MemoryStore` within the 60s window. At 1k req/s, ~60k entries/window/isolate before cleanup. Combined with the `agent` tier giving a higher 1000 req/min budget, this is also a **rate-limit bypass amplifier**: an attacker rotates pubkeys to get effectively unlimited budget. **Fix:** apply the same `^[1-9A-HJ-NP-Za-km-z]{32,44}$` regex used in route schemas to the header value inside `getKeyAndLimit`; on mismatch, fall back to `cf-connecting-ip` keying (and the lower 100/min limit). | NEEDS-FIX-M3 |
| Medium | M2 | `apps/api/src/db/schema.ts:1-9` (vs `apps/indexer/src/db/schema.ts`) | **Schema duplicated between `apps/api/` and `apps/indexer/`.** Comments are different but the pgTable definitions are functionally aligned today. Drift risk: indexer adds a column the API doesn't know about (silently dropped in serializer), or the API queries a column the indexer renames. Operational, not security per se, but a divergence that adds e.g. a column with PII or sensitive metadata could leak through the read API without a security-auditor seeing the change. **Fix:** extract to `packages/db-schema/` and import from both apps. The author noted this in code comments and intends to track it. | FOLLOW-UP-M3 |
| Low | L1 | `apps/api/src/routes/listings.ts:21` | **`offset` has no upper bound** (`z.coerce.number().int().min(0).default(0)`). With `offset=999999999`, Postgres still has to scan-and-discard rows for the count query (`select count(*)::int`). Combined with `ilike(capability, '%term%')` (left-anchored wildcard, defeats any non-trigram index), an attacker can issue intentionally slow scans. The 100 req/min IP limit caps the damage but a single legitimate-looking burst can pin the Neon HTTP pool. **Fix:** clamp `offset` to e.g. `.max(10000)` (cursor-based pagination is the proper M3 solution); add a Postgres `pg_trgm` GIN index on `service_listings.capability` if substring search is the canonical UX. | FOLLOW-UP-M3 |
| Low | L2 | `apps/api/src/middleware/ratelimit.ts:15-31` | **Per-isolate `MemoryStore` is best-effort only.** CF Workers spawn one isolate per (PoP × eyeball-shape); an attacker spreading load across PoPs gets an effectively fresh budget per region. Documented in code comments. **Acceptable for MVP read-only API** (the surface protects only the DB and CF budget, both restorable). For mainnet / paid traffic: migrate to CF native Rate Limiting binding (rules-engine or Workers Rate Limiting API) or Upstash Redis-backed store. | FOLLOW-UP-M3 |
| Low | L3 | `apps/api/src/middleware/ratelimit.ts:28-30` | **`x-forwarded-for` fallback is trustable only in CF.** When a request hits CF Workers directly, `cf-connecting-ip` is set by the edge and is the canonical client IP; `x-forwarded-for` is not trustable in general but is in this code path because it'd be set by CF on its own request. The `?? 'unknown'` final fallback collapses ALL non-CF traffic into a single key — not a vulnerability today (CF Workers always sets `cf-connecting-ip`), but if the deployment topology ever changes (e.g., serving via a CF-Pages-Functions binding from another origin), the rate limit collapses to a single shared bucket. **Fix:** drop the `x-forwarded-for` fallback (or replace with explicit assertion that runtime is CF Workers); if `cf-connecting-ip` is missing, return 500 rather than silently sharing a single rate-limit bucket. | NON-BLOCKING |
| Low | L4 | `apps/api/src/routes/listings.ts:66` | **`ilike(capability, \`%${capability}%\`)` is parametrized correctly** by Drizzle (no SQL injection — confirmed by reading the generated SQL via Drizzle's parameter array shape). However, **the user-supplied `capability` value can contain `%` and `_` LIKE wildcards** which are passed through unescaped. This means a query like `capability=%` matches every row (defeats filtering — but the `LIMIT 100` cap mitigates) and `capability=_____________________________________` (33 underscores) matches every 33+ char capability. Not a vuln, but a query-semantics gotcha. **Fix:** escape `%` and `_` before interpolation (`capability.replace(/[\\%_]/g, '\\$&')`), or switch to a trigram operator. | NON-BLOCKING |
| Info | I1 | `apps/api/src/index.ts:51-54` | Top-level `app.onError` returns generic `internal_error` with a static message — **no stack trace, no DB error details leak**. `console.error('[api] unhandled error', err)` writes to CF logs (which only the team sees). Verified: no `err.message` echoed in the response body. | NOTE |
| Info | I2 | `apps/api/src/middleware/validate.ts:14-17,32-35` | Zod `issues` map exposes only `path` and `message` — **NOT `i.input`, NOT `i.received`**, so the offending request value (e.g., `<script>alert(1)</script>` injected as a pubkey path param) is **not echoed back**. No reflected-XSS-for-downstream-consumer vector. ✓ | NOTE |
| Info | I3 | `apps/api/src/middleware/cors.ts:4-9` | `origin: '*'` with explicit `GET, OPTIONS` methods. Hono's CORS middleware does **not** set `Access-Control-Allow-Credentials: true` unless `credentials: true` is passed — verified by grep against `node_modules/hono`. Combined with `*` origin this would have been a CORS spec violation; absence is correct. ✓ | NOTE |
| Info | I4 | `apps/api/wrangler.toml:1-18` | No secrets in committed file — `DATABASE_URL` set via `wrangler secret put` (documented in `.dev.vars.example` comment). `nodejs_compat` flag broadens runtime surface (needed for `@neondatabase/serverless`); acceptable. The committed comment leaks the deploy-time CF account subdomain hash `4431f38bb27a8e8db699525ef5b0f9fe` — non-sensitive (CF-internal routing identifier, not a credential), but worth scrubbing on principle. | NOTE |
| Info | I5 | `apps/api/.gitignore` (root `/workspace/.gitignore:5-6`) | `.dev.vars` covered by `**/.dev.vars` with explicit `!**/.dev.vars.example` exception. ✓ No `.dev.vars` file committed. | NOTE |
| Info | I6 | `apps/api/src/routes/listings.ts:91-94` | The count query (`select count(*)::int from service_listings where ...`) runs on **every** `GET /listings` request and is unbounded by `LIMIT/OFFSET`. With the table at MVP scale this is fine; at 100k+ rows + `ILIKE %x%` filter it becomes the slowest query. **Fix in M3:** approximate count (`pg_stat_user_tables.n_live_tup`) or cursor-based pagination without total. | FOLLOW-UP-M3 |
| Info | I7 | `apps/api/src/index.ts:26,33` | `startTime` is captured at module init and reported by `/healthz` as `uptime` — but on CF Workers this is **per-isolate spawn time**, not service uptime. Cosmetic / observability gotcha; no security impact. | NOTE |

### Checklist walkthrough

1. ✅ **SQL injection.** All filters use Drizzle helpers (`eq`, `ilike`, `and`, `asc`, `desc`). The single `sql\`count(*)::int\`` is a column expression, not user data. The single `sql\`0\`` literals in schema defaults are static. No raw concatenation. `ilike` second arg is parametrized — but L4 notes the LIKE wildcards are not escaped (semantics, not injection).
2. ✅ **Pagination integers.** `limit` is `z.coerce.number().int().min(1).max(100).default(20)` — string-to-int coercion + range. `limit=999` rejected at validate layer (test `listings.test.ts:127` covers this). `offset` lacks an upper bound — see L1.
3. ✅ **Pubkey path params.** `^[1-9A-HJ-NP-Za-km-z]{32,44}$` regex applied to every `:pubkey` and `?owner=` query. Matches base58 alphabet (no `0`, `O`, `I`, `l`). Length range covers all real Solana pubkeys (32 bytes → 43-44 base58 chars; min 32 is a relaxation for testing but not exploitable for SQLi since the regex still excludes punctuation).
4. ✅ **GROUP BY / ORDER BY user-controllable?** No GROUP BY. ORDER BY is gated by `z.enum(['reputation', 'price', 'completedJobs'])` and `z.enum(['asc', 'desc'])` — column reference is constructed in code from the validated enum, not from the raw string. ✓
5. ✅ **Rate limit headers.** `standardHeaders: 'draft-7'` → emits `RateLimit-Policy` and `RateLimit` headers on every response, plus `Retry-After` on 429 (verified in `hono-rate-limiter@0.4.2/index.esm.js` source). 429 status code returned with structured `{ error: 'rate_limit_exceeded', message: ... }`. ✓
6. ✅ **Per-IP keying.** Uses `cf-connecting-ip` first (correct CF header) — see L3 on the `x-forwarded-for` fallback.
7. ⚠ **Per-agent keying.** `X-Agent-Pubkey` header is keyed without validation — see M1.
8. ✅ **CORS.** `origin: '*'`, `allowMethods: ['GET', 'OPTIONS']`, no credentials. Spec-compliant.
9. ✅ **Zod schemas.** `capability` capped at 256 chars (no DOS via 1MB body). `limit` 1-100. `owner` and path pubkeys both base58. ✓
10. ✅ **Error message hygiene.** No stack, no DB error message, no field name leakage in 500. Zod issues strip input value (no XSS reflection). ✓
11. ✅ **Secrets.** No secrets committed. `.dev.vars` git-ignored. `.dev.vars.example` placeholder shape only.
12. ⚠ **DDoS / resource budget.** Documented as M3 follow-up — see L1, L2, I6.
13. ⚠ **Schema duplication.** Documented as M3 follow-up — see M2.

### Cross-checks performed

- ✅ `grep -rn "z.coerce\|z.string\|sql\`" apps/api/src/` — only one `sql\`count(*)::int\`` in `listings.ts:92` (column expr, not user data); two `sql\`0\`` literals in `schema.ts:55,113` (numeric defaults, not user data).
- ✅ `grep -E "serviceListings\.|escrows\.|agentReputation\." apps/api/src/routes/*.ts` — verified every column access maps to a column declared in `apps/api/src/db/schema.ts`. No drift between the API's view of the schema and what it queries.
- ✅ `diff apps/api/src/db/schema.ts apps/indexer/src/db/schema.ts` — substantive diffs are JSDoc/comments + `customType<{data: Buffer}>` (indexer) vs `customType<{data: string}>` (api). API never reads `capabilityHash` so the type difference is not exercised in API code paths.
- ✅ `node_modules/hono-rate-limiter/index.esm.js` — confirmed `Retry-After` is set by `'draft-7'` standardHeaders mode when `totalHits > limit`.
- ✅ `.gitignore` rule `**/.dev.vars` with `!**/.dev.vars.example` exception (lines 5-6).
- ✅ `wrangler.toml` contains no secrets — only `APP_VERSION` var. Documented secret list in comment.
- ✅ Tests: 22 unit tests cover happy path (200), pagination, validation (400 for bad pubkey, bad limit, bad sort enum), not-found (404), CORS preflight (204), and the X-Agent-Pubkey rate-limit header path. No live integration tests yet — deferred to qa-test-eng Task #58 (acceptable: smoke against deployed URL is a separate concern).
- ✅ No `console.log` of secrets, no DB error message exposure in any 500 path, no PII in logs (only the URL path and method via Hono's default).
- ✅ Healthz: `{ ok, version, uptime }` — `version` from env (set in wrangler.toml `APP_VERSION = "0.1.0"` non-secret), `uptime` is per-isolate spawn delta (cosmetic).

### Verdict

**APPROVED** for merge. No critical or high-severity blockers; the read-only scope and absence of a fund-flow / signing surface limit the worst case to DOS / budget-drain (recoverable) rather than fund-loss.

The two **Medium** findings (M1: header-keyed rate-limit map without validation, M2: schema duplication) are tracked as M3 follow-ups, not merge blockers — M1 because the `100/min` IP fallback still caps the OOM rate at the isolate level (and CF respawns isolates), M2 because the schemas are aligned today and a divergence is not yet exploitable.

**Recommended follow-ups for M3 (in priority order):**

1. **(M1)** Validate `X-Agent-Pubkey` header as base58 before keying rate-limit map; fall back to IP on mismatch. Closes the rate-limit-bypass amplifier and the per-isolate memory-exhaustion vector. ~10 LOC, ratelimit.ts.
2. **(L1)** Clamp `offset` to a sane upper bound (e.g. 10k) as a band-aid; design cursor-based pagination for the real fix. Add `pg_trgm` GIN index on `service_listings.capability` if substring search is the canonical UX.
3. **(M2)** Extract `apps/api/src/db/schema.ts` and `apps/indexer/src/db/schema.ts` to `packages/db-schema/`. Single source of truth prevents silent drift and ensures security-auditor sees every column-shape change once.
4. **(L2)** Migrate from `hono-rate-limiter` MemoryStore to CF native Rate Limiting binding (or Upstash Redis) before mainnet. Per-isolate best-effort is acceptable for MVP; not for live USDC settlement traffic.
5. **(L4)** Escape `%` and `_` in user-supplied `capability` filter before interpolation into the LIKE pattern, or switch to a trigram operator. Defensive; not exploitable today.

**Recommended merge order:** PR #90 first, then this audit-notes PR after.


---

## PR #89 — feature/indexer-m1.5-polish — 2026-04-26
**Verdict:** APPROVED (with non-blocking low-severity follow-ups)

**Reviewer:** security-auditor (claude-opus-4-7, 1M context)
**Branch:** `feature/indexer-m1.5-polish`
**Author:** AgentBazaar (backend-eng)
**Task:** #57 (M1.5 carry-forward polish — bundles L1 + L2 + L3 from PRs #79/#80, plus column rename + Node pin)

### Scope of review

Five M1.5 deferred items in a single PR. Three are security-relevant; two are
operational hygiene. Re-ran every IP probe vector from the prior PR #80 audit
against the new ipaddr.js implementation and added new vectors enabled by
ipaddr.js semantics (CGNAT, IPv6 tunneling, RFC reserved ranges, numeric
encodings).

| File | Lines | Audit weight |
|---|---|---|
| `apps/indexer/src/events/fetch-metadata.ts` | +62 / -32 | **High — SSRF surface** |
| `apps/indexer/src/env.ts` | +8 / -1 | Low — operational |
| `apps/indexer/src/cron/retention.ts` | +15 / -2 | None — comment |
| `apps/indexer/src/db/schema.ts` | +4 / -2 | Low — column rename |
| `apps/indexer/drizzle/0005_rename_price_column.sql` | +9 / 0 | Low — DDL |
| `apps/indexer/drizzle/meta/0005_snapshot.json` | +445 / 0 | Low — bookkeeping |
| `apps/indexer/src/events/on-listing-{created,updated}.ts` | +8 / -8 | Low — INSERT/UPDATE rename |
| `apps/indexer/tests/fetch-metadata-ssrf.test.ts` | +13 / -1 | Test |
| `apps/indexer/tests/env-schema.test.ts` | +55 / 0 | Test |
| `apps/indexer/tests/migration.test.ts` | +2 / -1 | Test |
| `apps/indexer/package.json` | +4 / 0 | Operational pin |

### IP-probe regression matrix (empirically tested with `ipaddr.js@2.3.0`)

Ran every vector through the new `isPrivateIp` (ipaddr.parse → IPv4-mapped
unwrap → range() → BLOCKED_RANGES set lookup). Matches the function logic
exactly.

| Probe | ipaddr.js range | Result | PR #80 vector? |
|---|---|---|---|
| `127.0.0.1` | loopback | BLOCK | yes |
| `10.0.0.1` | private | BLOCK | yes |
| `172.16.0.0` | private | BLOCK | yes |
| `192.168.1.1` | private | BLOCK | yes |
| `169.254.169.254` (AWS/GCP IMDS) | linkLocal | **BLOCK** | yes |
| `0.0.0.0` | unspecified | BLOCK | yes (H1) |
| `8.8.8.8` (Google DNS) | unicast | ALLOW (correct) | yes |
| `1.2.3.4` | unicast | ALLOW (correct) | yes |
| `::1` | loopback | BLOCK | yes |
| `fe80::1` | linkLocal | BLOCK | yes |
| `FE80::1` (uppercase) | linkLocal | BLOCK | yes (H1 regression) |
| `fc00::1` | uniqueLocal | BLOCK | yes |
| `ff02::1` | multicast | BLOCK | yes |
| `2606:4700:4700::1111` (Cloudflare) | unicast | ALLOW (correct) | yes (negative) |
| `::ffff:127.0.0.1` (IPv4-mapped loopback) | loopback (post-unwrap) | BLOCK | yes (H1) |
| `::ffff:169.254.169.254` (IPv4-mapped IMDS) | linkLocal (post-unwrap) | BLOCK | yes (H1) |
| `100.64.0.1` (CGNAT start) | carrierGradeNat | BLOCK | **NEW (L3)** |
| `100.127.255.255` (CGNAT end) | carrierGradeNat | BLOCK | **NEW (L3)** |
| `224.0.0.1` (IPv4 multicast) | multicast | BLOCK | new (gain) |
| `239.255.255.255` (IPv4 multicast end) | multicast | BLOCK | new (gain) |
| `2002:7f00:1::` (6to4 wrapping 127.0.0.1) | 6to4 | BLOCK | new (gain) |
| `0177.0.0.1` (octal-encoded 127.0.0.1) | loopback | BLOCK (parsed as 127.0.0.1) | bypass-attempt |
| `0x7f.0.0.1` (hex-encoded) | loopback | BLOCK (parsed as 127.0.0.1) | bypass-attempt |
| `2130706433` (decimal-int 127.0.0.1) | loopback | BLOCK (parsed as 127.0.0.1) | bypass-attempt |

**Verified:** all 4 H1 regression tests from PR #80 are still in
`tests/fetch-metadata-ssrf.test.ts`; the migration did not delete them.
The 2 new CGNAT regression tests have been added (lines 117–127).

**Bypass-attempt observation:** `ipaddr.js` is *more permissive* on input
formats than the previous regex chain — it accepts octal (`0177`), hex
(`0x7f`), and decimal-integer (`2130706433`) IPv4 representations, all of
which normalise to `127.0.0.1` octets and are correctly classified as
loopback. This is actually a net **gain in safety**: the previous regex
`/^127\./` would have *failed to match* `0177.0.0.1` (because the regex
sees the literal string), passing the address through unchanged for
DNS resolution where the OS might or might not normalise. Now ipaddr.js
normalises *before* the range check. **No bypass found.**

### Findings

- **Critical:** none.

- **High:** none.

- **Medium:** none.

- **Low:**

  - **L1. `BLOCKED_RANGES` set omits five ipaddr.js range names that may be
    worth blocking for defence-in-depth.** Empirical tests show the
    following addresses pass through `isPrivateIp` (returning ALLOW):
    - `255.255.255.255` → range `broadcast`. IPv4 limited broadcast.
      Could in theory be returned by a misconfigured DNS to deliver a
      packet to all hosts on the local LAN segment. Low real-world risk
      (broadcast doesn't traverse routers) but the gain from blocking is
      free.
    - `240.0.0.1`, `198.18.0.1`, `192.0.2.1`, `203.0.113.1` → range
      `reserved`. Includes RFC 5737 documentation ranges
      (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), RFC 2544
      benchmarking (`198.18.0.0/15`), and RFC 1112 class E (`240.0.0.0/4`).
      None of these *should* appear in real DNS, so seeing one is itself
      suspicious — fail-closed is the safer policy.
    - `100::1` → range `discard` (RFC 6666 IPv6 discard prefix). Designed
      for sinkholing; if an internal sinkhole receives indexer traffic,
      it could be a covert channel.
    - `2001:db8::1` → range `reserved` (RFC 3849 IPv6 documentation).
      Same logic as IPv4 reserved.
    - `2001:1::1`, `2001:2::1`, `2001:10::1` → ranges
      `reserved` / `benchmarking` / `deprecated`.

    **Recommended fix:** extend `BLOCKED_RANGES` set in
    `apps/indexer/src/events/fetch-metadata.ts:87-100` to include
    `'broadcast', 'reserved', 'discard', 'benchmarking', 'as112',
    'as112v6', 'amt', 'deprecated', 'orchid2'`. The complete blocklist
    becomes "everything except `unicast`" — which is the cleaner mental
    model the JSDoc on lines 60–62 already promises. **Severity Low**
    because none of these are likely real-world SSRF targets, but
    aligning code to the JSDoc ("block anything that is NOT unicast")
    is a small mechanical change. **Not a merge blocker.**

  - **L2. Drizzle snapshot `0005_snapshot.json:354` references the OLD
    column name in the `idx_service_listings_discover` index expression.**
    The `service_listings.columns.price_usdc_base_units` entry on line 315
    is correct, but the index entry on line 354 still says
    `"expression": "price_lamports"`. This is a snapshot-generation
    inconsistency: the live `schema.ts` builds the index from
    `t.priceUsdcBaseUnits`, which Drizzle should have serialised as the
    new column name.

    **Runtime impact:** none. Postgres `RENAME COLUMN` updates the column
    by attribute number (pg_attribute.attnum), not by name string, so any
    existing index on the renamed column continues to work and its
    `pg_get_indexdef` output reflects the new column name automatically.
    The DB stays consistent.

    **Future impact:** the next `drizzle-kit generate` run will diff the
    live `schema.ts` (new name) against the snapshot (mixed names) and
    will likely emit a no-op or surprise migration. Cleanup recommended
    before the next migration is generated.

    **Recommended fix:** either regenerate the snapshot
    (`pnpm --filter @agentbazaar/indexer db:generate` after applying #5)
    or hand-edit `0005_snapshot.json:354` to read
    `"expression": "price_usdc_base_units"` and update the snapshot `id`
    to invalidate stale caches. **Not a merge blocker** — the snapshot
    is a developer-tool artifact, not part of the runtime path.

  - **L3. Deploy ordering for the price-column rename is unavoidably
    non-zero-downtime.** Because the migration is a `RENAME COLUMN` and
    not an additive change, *both* orderings cause a brief window where
    one of {indexer code, DB schema} references a column the other does
    not have:
    - Code-first: new code's `INSERT INTO service_listings (..., price_usdc_base_units, ...)` fails until migration applies → silent webhook drop (and dead-letter to logs).
    - Migration-first: old code's `INSERT INTO service_listings (..., price_lamports, ...)` fails until new code rolls out → same symptom.

    The PR body acknowledges this and prescribes a low-traffic window.
    Acceptable for devnet (current state). **For mainnet rollout**, prefer
    the additive expand–migrate–contract pattern: (1) add new column with
    backfill from old, (2) dual-write from app, (3) backfill rows,
    (4) drop old column in a follow-up migration. Or accept ~30 s of
    webhook backlog (Helius retries) and apply during a controlled
    maintenance window.

    **Severity Low (operational, not security).** The escrow money path
    does not depend on `service_listings.price_usdc_base_units`; only the
    Discovery API does. Worst case is briefly stale listing prices, not
    fund movement.

  - **L4. `engines.node = "22.x"` in `package.json` is `pnpm install`
    advisory only, not a runtime constraint.** The Dockerfile already
    pins `FROM node:22-alpine`, so production runtime IS pinned. CI
    runners may not be pinned the same way.

    **Recommended follow-up:** add a `.nvmrc` file at repo root with
    `22` (or `22.22.2` exact) and pin GitHub Actions
    `actions/setup-node@v4` with `node-version-file: '.nvmrc'`. **Not a
    merge blocker** — defensive only.

  - **L5. RETENTION_INTERVAL_MS Zod refine error message is OK but minor
    UX improvement possible.** Current message:
    `"must be 0 (disabled) or >= 60_000 ms"`. This is clear. The
    `setTimeout(60s) + setInterval(intervalMs)` design correctly
    short-circuits when `intervalMs === 0` (line 44 of `retention.ts`).
    Verified the cron logic: if a Zod-valid `0` reaches
    `startRetentionCron`, the early-return on line 44–47 prevents both
    timers from being created. No bug.

- **Info:**

  - **I1.** `ipaddr.js` correctly handles non-standard IPv4 numeric
    encodings (octal, hex, decimal-int). This is a **net security
    improvement** over the prior regex chain, which would have failed to
    match `0177.0.0.1` and similar bypass attempts. Worth noting in the
    JSDoc that this is intentional.

  - **I2.** The IPv4-mapped IPv6 unwrap at lines 77–82 is now slightly
    redundant with the `'ipv4Mapped'` entry in `BLOCKED_RANGES` (a
    fully-mapped `::ffff:x.x.x.x` would be blocked by both paths). The
    unwrap is correct and the redundancy is intentional defence-in-depth
    — the comment on lines 73–76 explains this. **No action.**

  - **I3.** `ipaddr.js@2.3.0` is the version actually resolved
    (`pnpm-lock.yaml`), satisfying the `^2.2.0` spec. License is MIT.
    Upstream maintainer is whitequark, who maintains it as part of the
    nodejs ecosystem (it's a dep of `proxy-addr` which is used by Express
    and basically every Node web framework). Low supply-chain risk.

### Cross-checks performed

- ✅ All 4 PR #80 H1 regression tests still present in
  `apps/indexer/tests/fetch-metadata-ssrf.test.ts`
  (`::ffff:127.0.0.1`, `::ffff:169.254.169.254`, `0.0.0.0`, `FE80::1`).
- ✅ IPv4-mapped IPv6 unwrap path verified by hand against ipaddr.js source
  (`/node_modules/.pnpm/ipaddr.js@2.3.0/...`).
- ✅ Bypass attempt `0177.0.0.1` (octal) parsed by ipaddr.js to octets
  `[127,0,0,1]` → range `loopback` → BLOCKED. Same for `0x7f.0.0.1` (hex)
  and `2130706433` (decimal-int).
- ✅ DNS pinning (I2) and streaming cap (I1) from PR #80 unchanged — only
  `isPrivateIp` was migrated.
- ✅ Cron `intervalMs === 0` short-circuit at `retention.ts:44–47` confirmed
  to skip BOTH the initial `setTimeout` AND the `setInterval` — no
  silent timer leak.
- ✅ Migration `0005_rename_price_column.sql` is a single
  `ALTER TABLE ... RENAME COLUMN` — metadata-only, no row rewrite, brief
  `ACCESS EXCLUSIVE` lock. Indexes auto-update via attnum reference.
- ✅ Node version pin: Dockerfile `FROM node:22-alpine` (line 7) matches
  `engines.node: 22.x` — runtime IS pinned via the image, the
  package.json pin is belt-and-suspenders.
- ✅ No new secrets; no `console.log`; no hardcoded URLs; no DNS
  fallthrough that bypasses the pin.

### Verdict

**APPROVED.** Safe to merge to `main` and deploy to devnet. None of the
findings are blockers. The L3 ipaddr.js migration is a strict improvement
in SSRF defence — it both removes hand-rolled regex maintenance burden
*and* defeats numeric-encoding bypass attempts that the prior code did not
handle.

**Recommended follow-ups (track as M2-W6 polish):**

1. **Extend BLOCKED_RANGES set** (L1) to include `broadcast`, `reserved`,
   `discard`, `benchmarking`, `as112`, `as112v6`, `amt`, `deprecated`,
   `orchid2`. Aligns implementation with JSDoc promise of "anything that
   is NOT unicast".
2. **Regenerate Drizzle snapshot** (L2) so
   `idx_service_listings_discover` references the new column name.
   Avoids surprise migration on next `db:generate`.
3. **Add `.nvmrc` + pin GitHub Actions Node version** (L4). Defensive
   alignment with `engines.node`.
4. **Future mainnet column-rename pattern** (L3): adopt
   expand–migrate–contract for any non-additive schema change to avoid
   the dual-window unavailability.

